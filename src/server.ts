import { logger } from "~/log";

import { buildApp } from "./app";
import { closeDeps, createDeps } from "./deps";
import { loadEnv } from "./env";

// 崩溃也打成一行 JSON。env 不合法、client 配错（启动时的 Client.find）都从这里出去
process.on("uncaughtException", (err, origin) => {
	logger.fatal({ err, origin }, "idp 进程崩溃");
	process.exit(1);
});

const env = loadEnv();

// 直连部署改端口必须连 OIDC_ISSUER 一起改；有反代或端口映射时两者本就不同，所以只告警
const issuerPort = new URL(env.OIDC_ISSUER).port;
if (issuerPort && Number(issuerPort) !== env.IDP_PORT) {
	logger.warn(
		{ IDP_PORT: env.IDP_PORT, OIDC_ISSUER: env.OIDC_ISSUER },
		"OIDC_ISSUER 的端口与 IDP_PORT 不一致：直连部署时授权跳转会打到空端口；有反代或端口映射可忽略",
	);
}

const deps = createDeps(env);
const app = await buildApp(deps, env);

try {
	await app.listen({ port: env.IDP_PORT, host: "0.0.0.0" });
} catch (err) {
	app.log.error({ err, port: env.IDP_PORT }, "idp 启动失败：端口监听不成功");
	if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
		app.log.error(
			`IDP_PORT=${env.IDP_PORT} 已被占用。换端口要连同 OIDC_ISSUER 与钉钉后台的回调域名一起改。`,
		);
	}
	process.exit(1);
}

app.log.info({ port: env.IDP_PORT }, "idp 启动");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
	process.on(sig, () => {
		app.log.info(`收到 ${sig}，开始优雅关闭`);
		void app
			.close()
			.then(() => closeDeps(deps))
			.finally(() => process.exit(0));
	});
}
