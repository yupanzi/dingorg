import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordAudit } from "~/audit/record";
import {
	createApiKeyVerifier,
	parseBearer,
	type RestCaller,
} from "~/auth/api-key";
import type { Deps } from "~/deps";
import { DingtalkError, isTimeoutError } from "~/dingtalk/client";
import type { ApiKeyEntry } from "~/domain/api-key";
import type { AuditDetails } from "~/domain/audit";
import type { OrgApiErrorBody } from "~/domain/org-api";
import type { AuditAction } from "~/resources";
import { SnapshotUnavailableError } from "~/sync/snapshot";

/** REST 面的鉴权 + 审计 + 错误翻译。鉴权与审计绑在一起：加端点不会忘了记账 */

declare module "fastify" {
	interface FastifyRequest {
		caller: RestCaller | null;
		/** 来件声称的 key id，鉴权失败时也有：审计要记它 */
		claimedKeyId: string | null;
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

export function requireCaller(req: FastifyRequest): RestCaller {
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

// ⚠️ 401 一律不说原因（没带 / 格式错 / 未知 id / key 错）：区分开就是给探测者一个预言机
const UNAUTHORIZED = {
	code: "unauthorized",
	message: "无效的凭证",
} as const;

export function registerGuard(
	app: FastifyInstance,
	deps: Deps,
	apiKeys: readonly ApiKeyEntry[],
): void {
	const verify = createApiKeyVerifier(apiKeys);

	// ⚠️ 不用 decorateRequest 预置：它让所有请求共享同一个对象引用，并发时审计串号
	app.addHook("onRequest", async (req) => {
		req.caller = null;
		req.claimedKeyId = null;
		req.auditPatch = {};
	});

	app.addHook("preHandler", async (req, reply) => {
		if (!req.routeOptions.config.auditAction) return;

		const presented = parseBearer(req.headers.authorization);
		req.claimedKeyId = presented?.id ?? null;

		const caller = presented ? verify(presented) : null;
		if (!caller) {
			reply.header("www-authenticate", 'Bearer realm="dingorg"');
			return fail(reply, 401, UNAUTHORIZED.code, UNAUTHORIZED.message);
		}

		req.caller = caller;
	});

	/**
	 * 鉴权之后的钉钉失败要讲原因（最常见的 60020 = 本服务出口 IP 不在自有应用的白名单，
	 * 不说没法自查）。
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

	// onResponse：审计不计入用户等待，写失败也影响不到已发出的响应。401 也在这里记
	app.addHook("onResponse", async (req, reply) => {
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

	// key 不进审计：只取 id，path 落库前剥 query，请求头不记
	await recordAudit(deps.db, {
		action,
		status,
		actorType: "api_key",
		actorId: req.caller?.id ?? req.claimedKeyId,
		actorName: req.caller?.name ?? null,
		targetId: req.auditPatch?.targetId ?? null,
		ip: req.ip,
		userAgent: req.headers["user-agent"] ?? null,
		method: req.method,
		path: req.url,
		requestId: req.id,
		details: req.auditPatch?.details,
	});
}
