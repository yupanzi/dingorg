import type { FastifyInstance } from "fastify";

import type { Deps } from "~/deps";

import { registerGuard } from "./guard";
import { registerOrgRoutes } from "./org";
import { registerSyncRoutes } from "./sync";

export async function registerApi(
	app: FastifyInstance,
	deps: Deps,
): Promise<void> {
	// ⚠️ 必须包在 register 作用域里：否则 guard 跑遍 /healthz 与 /oidc/*
	await app.register(async (scope) => {
		registerGuard(scope, deps);

		registerOrgRoutes(scope, deps);
		registerSyncRoutes(scope, deps);

		// 自描述端点，不鉴权（只描述形状、不吐数据）。⚠️ 加端点要来这里补一行，漏了没有检查会红
		scope.get("/api/v1", async () => ({
			service: "dingorg",
			description:
				"钉钉 → 标准 OIDC 的桥接 + 按钉钉应用隔离的组织架构快照。REST 面认钉钉 AppKey/AppSecret，认证面走 /oidc/*。",
			auth: {
				scheme: "HTTP Basic",
				example: 'curl -u "$APPKEY:$APPSECRET" https://<host>/api/v1/org/users',
				note: "用你自己钉钉应用的 AppKey/AppSecret，钉钉能为它发 token 即通过；读到的是这个应用在钉钉后台可见范围内的通讯录。校验失败一律 401 且不说原因。",
				dingtalkSetup:
					"你的钉钉应用需要：把本服务的出口 IP 加进白名单（否则拉取报 60020）、开通通讯录读取权限点。「个人信息」敏感权限点可选，但不开的话 email（只取企业邮箱）与 dingtalk.unionid 都为空。",
			},
			endpoints: [
				{
					method: "GET",
					path: "/api/v1/org/users",
					note: "快照不按时间过期，首次调用会当场拉取；响应的 fetchedAt 是数据时刻",
				},
				{ method: "GET", path: "/api/v1/org/departments" },
				{ method: "GET", path: "/api/v1/sync", note: "本应用快照的状态" },
				{
					method: "POST",
					path: "/api/v1/sync",
					note: "同步地刷新本应用的快照；距上次拉取尝试不到 1 分钟时不外呼",
				},
			],
			oidc: {
				discovery: "/oidc/.well-known/openid-configuration",
				note: "下游用任意标准 OIDC 客户端库接入；端点清单以 discovery 为准。",
				// 只说来源、不回显值：这个端点不鉴权
				client:
					"无注册端点。client 由部署方在 OIDC_CLIENTS_JSON 里静态配置，凭证与钉钉应用无关；回调地址只有精确匹配。",
			},
		}));
	});
}
