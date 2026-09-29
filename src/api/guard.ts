import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordAudit } from "~/audit/record";
import { parseBasicAuth, verifyAppCredential } from "~/auth/app-credential";
import type { Deps } from "~/deps";
import { DingtalkError, isTimeoutError } from "~/dingtalk/client";
import type { AuditDetails } from "~/domain/audit";
import type { OrgApiErrorBody } from "~/domain/org-api";
import type { AuditAction } from "~/resources";
import { SnapshotUnavailableError } from "~/sync/snapshot";

/** REST 面的鉴权 + 审计 + 错误翻译。鉴权与审计绑在一起：加端点不会忘了记账 */

export interface AppCaller {
	appKey: string;
	/** 钉钉刚为这对凭证发的企业 token */
	accessToken: string;
}

declare module "fastify" {
	interface FastifyRequest {
		caller: AppCaller | null;
		/** 来件声称的 appKey，鉴权失败时也有：审计要记它 */
		claimedAppKey: string | null;
		/** handler 往审计里补的实体信息 */
		auditPatch: {
			targetId?: string | null;
			details?: AuditDetails;
		};
	}
	interface FastifyContextConfig {
		/** 挂了它的路由既鉴权也进审计 */
		auditAction?: AuditAction;
	}
}

export function requireCaller(req: FastifyRequest): AppCaller {
	if (!req.caller) throw new Error(`guard 未挂载：${req.url} 拿不到调用方`);
	return req.caller;
}

function fail(
	reply: FastifyReply,
	status: number,
	code: string,
	message: string,
) {
	return reply
		.code(status)
		.send({ error: { code, message } } satisfies OrgApiErrorBody);
}

// ⚠️ 401 一律不说原因（没带 / 格式错 / secret 错 / 被限流）：区分开就是给爆破者一个预言机
const UNAUTHORIZED = {
	code: "unauthorized",
	message: "无效的凭证",
} as const;

export function registerGuard(app: FastifyInstance, deps: Deps): void {
	// ⚠️ 不用 decorateRequest 预置：它让所有请求共享同一个对象引用，并发时审计串号
	app.addHook("onRequest", async (req) => {
		req.caller = null;
		req.claimedAppKey = null;
		req.auditPatch = {};
	});

	app.addHook("preHandler", async (req, reply) => {
		if (!req.routeOptions.config.auditAction) return;

		const cred = parseBasicAuth(req.headers.authorization);
		req.claimedAppKey = cred?.appKey ?? null;

		const accessToken = cred
			? await verifyAppCredential(deps.db, cred, req.log)
			: null;
		if (!cred || !accessToken) {
			await writeAudit(deps, req, "failure");
			reply.header("www-authenticate", 'Basic realm="dingorg"');
			return fail(reply, 401, UNAUTHORIZED.code, UNAUTHORIZED.message);
		}

		req.caller = { appKey: cred.appKey, accessToken };
	});

	/**
	 * 鉴权之后的钉钉失败要讲原因（最常见的 60020 = 出口 IP 不在对方白名单，不说没法自查）。
	 * 挂在作用域上，路由里不 try/catch。其余错误重新抛给根实例：5xx 不回显 message。
	 */
	app.setErrorHandler((err, req, reply) => {
		if (err instanceof SnapshotUnavailableError) {
			reply.header("retry-after", String(Math.ceil(err.retryAfterMs / 1000)));
			return fail(reply, 503, "snapshot_unavailable", err.message);
		}
		if (err instanceof DingtalkError || isTimeoutError(err)) {
			req.log.warn({ err }, "钉钉调用失败");
		}
		if (err instanceof DingtalkError) {
			return reply.code(502).send({
				error: {
					code: "dingtalk_error",
					message: err.message,
					dingtalk: {
						errcode: err.errcode,
						code: err.code,
						status: err.status,
					},
				},
			} satisfies OrgApiErrorBody);
		}
		if (isTimeoutError(err)) {
			return fail(reply, 504, "dingtalk_timeout", "请求钉钉超时，请稍后重试");
		}
		throw err;
	});

	// onResponse：审计不计入用户等待，写失败也影响不到已发出的响应
	app.addHook("onResponse", async (req, reply) => {
		if (!req.routeOptions.config.auditAction) return;
		// 401 已在 preHandler 里记过
		if (reply.statusCode === 401) return;
		await writeAudit(deps, req, reply.statusCode < 400 ? "success" : "failure");
	});
}

async function writeAudit(
	deps: Deps,
	req: FastifyRequest,
	status: "success" | "failure",
): Promise<void> {
	const action = req.routeOptions.config.auditAction;
	if (!action) return;

	// secret 不进审计：只取 appKey，path 落库前剥 query，请求头不记
	await recordAudit(deps.db, {
		action,
		status,
		actorType: "app",
		actorId: req.caller?.appKey ?? req.claimedAppKey,
		targetId: req.auditPatch?.targetId ?? null,
		ip: req.ip,
		userAgent: req.headers["user-agent"] ?? null,
		method: req.method,
		path: req.url,
		requestId: req.id,
		details: req.auditPatch?.details,
	});
}
