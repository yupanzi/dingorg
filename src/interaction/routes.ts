import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Provider from "oidc-provider";
import { type AuditEntry, recordAudit } from "~/audit/record";
import { pickAuthEntries } from "~/domain/config-json";
import { AUDIT_ACTIONS } from "~/resources";
import { findMember } from "~/sync/snapshot";
import type { Deps } from "../deps";
import { getContactUser, getUserAccessToken } from "../dingtalk/client";
import { type IdpEnv, ownDingtalkApp } from "../env";
import { oidcIssuer } from "../oidc/mount";
import { buildDingtalkAuthUrl } from "./dingtalk";
import {
	type ErrorPage,
	htmlPage,
	SESSION_INVALID_PAGE,
	sendErrorPage,
	sendSessionInvalid,
} from "./html";

/**
 * 钉钉扫码交互，钉钉非标准 OAuth 只在这一层出现。
 *
 * 防 CSRF：state 必须等于 uid，且 ⚠️ 回调必须在 `/oidc/interaction/:uid` 之下——
 * interaction cookie 按这个 path 作用域，`interactionDetails` 校验两者。
 */

interface CallbackQuery {
	code?: string;
	state?: string;
	error?: string;
	error_description?: string;
}

export function registerInteractionRoutes(
	app: FastifyInstance,
	deps: Deps,
	env: IdpEnv,
	provider: Provider,
): void {
	// 审计记 client 的 name：UUID 人看不出是哪个下游
	const clientNames = new Map(
		pickAuthEntries(env.AUTH_JSON, "oidc").map((c) => [c.id, c.name]),
	);

	app.get(
		"/oidc/interaction/:uid",
		async (req: FastifyRequest, reply: FastifyReply) => {
			let details: Awaited<ReturnType<Provider["interactionDetails"]>>;
			try {
				details = await provider.interactionDetails(req.raw, reply.raw);
			} catch {
				return sendSessionInvalid(reply);
			}

			const redirectUri = `${oidcIssuer(env)}/interaction/${details.uid}/callback`;
			const url = buildDingtalkAuthUrl({
				clientId: env.DINGTALK_APP_KEY,
				redirectUri,
				state: details.uid,
			});
			return await reply.redirect(url);
		},
	);

	app.get(
		"/oidc/interaction/:uid/callback",
		async (
			req: FastifyRequest<{
				Params: { uid: string };
				Querystring: CallbackQuery;
			}>,
			reply,
		) => {
			const { uid } = req.params;
			const query = req.query;

			const source = {
				ip: req.ip,
				userAgent: req.headers["user-agent"] ?? null,
				method: req.method,
				path: req.url,
				requestId: req.id,
			};
			/**
			 * 每一种拒绝都走这里：审计与错误页绑在一起，新加的分支没法只回页面不留痕。
			 * ⚠️ summary 只写固定文案、不回显 query：带个 NUL 就能让审计写入失败。
			 */
			const deny = async (
				summary: string,
				page: ErrorPage,
				who: Pick<AuditEntry, "actorId" | "targetId" | "targetName"> = {},
			) => {
				await recordAudit(deps.db, {
					action: AUDIT_ACTIONS.authReject,
					status: "failure",
					actorType: "dingtalk",
					details: { summary },
					...who,
					...source,
				});
				return sendErrorPage(reply, ...page);
			};

			let details: Awaited<ReturnType<Provider["interactionDetails"]>>;
			try {
				details = await provider.interactionDetails(req.raw, reply.raw);
			} catch {
				return deny("登录会话不存在或已过期", SESSION_INVALID_PAGE);
			}

			const params = details.params as { client_id?: string; scope?: string };
			const target = {
				targetId: params.client_id,
				targetName: params.client_id
					? (clientNames.get(params.client_id) ?? params.client_id)
					: null,
			};

			if (details.uid !== uid || query.state !== uid) {
				return deny(
					"状态校验失败：state 与登录会话不符",
					[400, "状态校验失败", "登录状态不匹配，请重新发起登录。"],
					target,
				);
			}
			if (query.error) {
				return deny(
					"钉钉授权未完成（用户取消或钉钉报错）",
					[
						400,
						"钉钉授权未完成",
						`钉钉返回错误：${query.error_description ?? query.error}。请重新发起登录。`,
					],
					target,
				);
			}
			if (!query.code) {
				return deny(
					"钉钉未返回授权码",
					[400, "缺少授权码", "钉钉未返回授权码，请重新发起登录。"],
					target,
				);
			}

			let unionId: string;
			try {
				const userToken = await getUserAccessToken(
					ownDingtalkApp(env),
					query.code,
				);
				const contact = await getContactUser(userToken.accessToken);
				unionId = contact.unionId;
			} catch (err) {
				req.log.error({ err }, "钉钉换取用户身份失败");
				return deny(
					"与钉钉交换用户身份失败",
					[
						502,
						"钉钉登录失败",
						"与钉钉交换用户身份时出错，请稍后重试；若持续失败请联系管理员。",
					],
					target,
				);
			}

			// ⚠️ 与 `~/oidc/account` 同一条判据：只查自有应用的快照
			const member = await findMember(deps.db, env.DINGTALK_APP_KEY, unionId);

			// 不自动建用户。快照里只有当前可见的人，「已离职」与「从来不在」分不开
			if (!member) {
				return deny(
					"不在组织通讯录的账号尝试登录（或已离职）",
					[
						403,
						"账号不在本组织",
						"你的钉钉账号不在本组织通讯录中（或尚未同步）。如属新入职请稍后再试，或联系管理员。",
					],
					{ actorId: unionId, ...target },
				);
			}

			let grant = details.grantId
				? await provider.Grant.find(details.grantId)
				: undefined;
			if (!grant) {
				grant = new provider.Grant({
					accountId: unionId,
					clientId: params.client_id,
				});
			}
			grant.addOIDCScope(
				typeof params.scope === "string" ? params.scope : "openid",
			);
			const grantId = await grant.save();

			// 记在 hijack() 之前：reply 还在 fastify 手里，错误处理链路完整
			await recordAudit(deps.db, {
				action: AUDIT_ACTIONS.authLogin,
				status: "success",
				actorType: "dingtalk",
				actorId: unionId,
				actorName: member.displayName,
				details: {
					summary: target.targetName
						? `通过「${target.targetName}」完成登录`
						: "完成登录",
				},
				...target,
				...source,
			});

			/**
			 * `interactionFinished` 直接写 raw response。⚠️ 必须 try/catch：它内部还要读写
			 * Interaction，抛错时 reply 已被 hijack，fastify 写不进响应、超时定时器也被清了，
			 * 用户扫码成功后白屏卡死。
			 */
			reply.hijack();
			try {
				await provider.interactionFinished(
					req.raw,
					reply.raw,
					{ login: { accountId: unionId }, consent: { grantId } },
					{ mergeWithLastSubmission: false },
				);
			} catch (err) {
				req.log.error({ err }, "完成 OIDC 交互失败");
				if (reply.raw.headersSent) {
					reply.raw.end();
				} else {
					reply.raw.writeHead(500, {
						"content-type": "text/html; charset=utf-8",
					});
					reply.raw.end(
						htmlPage(
							"登录未完成",
							"完成登录时发生错误，请回到应用重新发起登录。",
						),
					);
				}
			}
		},
	);
}
