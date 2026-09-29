import Fastify, {
	type FastifyBaseLogger,
	type FastifyError,
	type FastifyInstance,
	type FastifyRequest,
} from "fastify";

import { registerApi } from "./api";
import type { Deps } from "./deps";
import { normalizeRequestPath } from "./domain/audit";
import type { OrgApiErrorBody } from "./domain/org-api";
import type { IdpEnv } from "./env";
import { registerInteractionRoutes } from "./interaction/routes";
import { logger } from "./log";
import { mountOidc } from "./oidc/mount";
import { createOidcProvider } from "./oidc/provider";
import { registerHealthz } from "./routes/healthz";

/** 请求日志的 url 剥掉 query：扫码回调带着钉钉授权码 */
function serializeRequest(req: FastifyRequest) {
	return {
		method: req.method,
		url: normalizeRequestPath(req.url),
		host: req.host,
		remoteAddress: req.ip,
		remotePort: req.socket?.remotePort,
	};
}

export async function buildApp(
	deps: Deps,
	env: IdpEnv,
): Promise<FastifyInstance> {
	// 注解成 FastifyBaseLogger：传 pino 的 Logger 会把实例泛型推窄，与默认 FastifyInstance 对不上
	const loggerInstance: FastifyBaseLogger = logger.child(
		{},
		{ serializers: { req: serializeRequest } },
	);
	const app = Fastify({
		loggerInstance,
		trustProxy: env.AUTH_TRUST_PROXY_HEADERS,
	});

	app.setErrorHandler((err: FastifyError, req, reply) => {
		req.log.error({ err }, "unhandled error");
		return reply
			.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500)
			.send({
				error: {
					code: err.code ?? "internal_error",
					// ⚠️ 5xx 不回显 message：可能带连接串、SQL 片段
					message:
						err.statusCode && err.statusCode < 500
							? err.message
							: "Internal Server Error",
				},
			} satisfies OrgApiErrorBody);
	});

	const provider = await createOidcProvider(deps, env);
	await mountOidc(app, provider);
	registerInteractionRoutes(app, deps, env, provider);

	await registerApi(app, deps);
	registerHealthz(app, deps);

	return app;
}
