import type { FastifyInstance } from "fastify";

import type { Deps } from "~/deps";
import { pickAuthEntries } from "~/domain/config-json";
import { type IdpEnv, ownDingtalkApp } from "~/env";

import { registerGuard } from "./guard";
import { registerOrgRoutes } from "./org";
import { registerSyncRoutes } from "./sync";

export async function registerApi(
	app: FastifyInstance,
	deps: Deps,
	env: IdpEnv,
): Promise<void> {
	const dingtalk = ownDingtalkApp(env);

	// ⚠️ 必须包在 register 作用域里：否则 guard 跑遍 /healthz 与 /oidc/*
	await app.register(async (scope) => {
		registerGuard(scope, deps, pickAuthEntries(env.AUTH_JSON, "apikey"));

		registerOrgRoutes(scope, deps, dingtalk);
		registerSyncRoutes(scope, deps, dingtalk);

		// 自描述端点，不鉴权（只描述形状、不吐数据）。⚠️ 加端点要来这里补一行，漏了没有检查会红
		scope.get("/api/v1", async () => ({
			service: "dingorg",
			description:
				"钉钉 → 标准 OIDC 的桥接 + 钉钉组织架构的同步。REST 面认本服务配发的 API key，认证面走 /oidc/*。",
			auth: {
				scheme: "Bearer",
				example:
					'curl -H "Authorization: Bearer $API_KEY" https://<host>/api/v1/org/users',
				note: "用部署方为你生成的 API key（dok_ 开头），与 OIDC client 凭证、钉钉凭证都无关；读到的是本服务钉钉应用可见范围内的全组织通讯录。校验失败一律 401 且不说原因。",
			},
			endpoints: [
				{
					method: "GET",
					path: "/api/v1/org/users",
					note: "只列当前成员；数据不按时间过期，首次调用会当场同步；响应的 fetchedAt 是数据时刻",
				},
				{ method: "GET", path: "/api/v1/org/departments" },
				{ method: "GET", path: "/api/v1/sync", note: "同步的状态" },
				{
					method: "POST",
					path: "/api/v1/sync",
					note: "当场同步一次再返回；距上次尝试不到 1 分钟、或别处正在同步时不外呼",
				},
			],
			oidc: {
				discovery: "/oidc/.well-known/openid-configuration",
				note: "下游用任意标准 OIDC 客户端库接入；端点清单以 discovery 为准。",
				// 只说来源、不回显值：这个端点不鉴权
				client:
					"无注册端点。client 由部署方在 AUTH_JSON 里静态配置，凭证与钉钉应用无关；回调地址精确匹配，另可登记整串匹配的正则。client 凭证不能调 REST 面。",
			},
		}));
	});
}
