import middie from "@fastify/middie";
import type { FastifyInstance } from "fastify";
import type Provider from "oidc-provider";

import type { IdpEnv } from "../env";

/**
 * ⚠️ `provider.callback()` 是终端 handler，对不认识的路径直接 404、不调 `next()`；middie
 * 又在路由分发之前执行。所以按前缀手工分发，否则 fastify 自己的路由全被吞成 404。
 */
const MOUNT_PREFIX = "/oidc";

/** issuer = 对外 origin + 挂载前缀。前缀只有这一个合法值，所以 env 只收 origin */
export function oidcIssuer(env: Pick<IdpEnv, "PUBLIC_ORIGIN">): string {
	return `${env.PUBLIC_ORIGIN}${MOUNT_PREFIX}`;
}

/** ⚠️ 自建的 `/oidc/*` 路由必须在这里豁免，漏了就是看不出原因的 404 */
const PASSTHROUGH_PREFIXES = [`${MOUNT_PREFIX}/interaction/`];

export async function mountOidc(
	app: FastifyInstance,
	provider: Provider,
): Promise<void> {
	await app.register(middie);
	const callback = provider.callback();

	app.use((req, res, next) => {
		const url = req.url ?? "";
		if (!url.startsWith(`${MOUNT_PREFIX}/`)) return next();
		if (PASSTHROUGH_PREFIXES.some((prefix) => url.startsWith(prefix))) {
			return next();
		}
		req.url = url.slice(MOUNT_PREFIX.length);
		return callback(req, res);
	});
}
