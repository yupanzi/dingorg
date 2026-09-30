import { logger } from "~/log";

import { buildApp } from "./app";
import { closeDeps, createDeps } from "./deps";
import { LISTEN_PORT, loadEnv } from "./env";

// 崩溃也打成一行 JSON。env 不合法、client 配错（启动时的 Client.find）都从这里出去
process.on("uncaughtException", (err, origin) => {
	logger.fatal({ err, origin }, "idp 进程崩溃");
	process.exit(1);
});

const env = loadEnv();

// 直连时对外端口必须就是监听端口；有反代或端口映射时两者本就不同，所以只告警
const publicPort = new URL(env.PUBLIC_ORIGIN).port;
if (publicPort && Number(publicPort) !== LISTEN_PORT) {
	logger.warn(
		{ port: LISTEN_PORT, PUBLIC_ORIGIN: env.PUBLIC_ORIGIN },
		"PUBLIC_ORIGIN 的端口不是本服务监听的端口：直连部署时授权跳转会打到空端口；有反代或端口映射可忽略",
	);
}

const deps = createDeps(env);
const app = await buildApp(deps, env);

try {
	await app.listen({ port: LISTEN_PORT, host: "0.0.0.0" });
} catch (err) {
	app.log.error({ err, port: LISTEN_PORT }, "idp 启动失败：端口监听不成功");
	if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
		app.log.error(
			`端口 ${LISTEN_PORT} 已被占用：本服务固定监听它，先释放占用者。`,
		);
	}
	process.exit(1);
}

app.log.info({ port: LISTEN_PORT }, "idp 启动");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
	process.on(sig, () => {
		app.log.info(`收到 ${sig}，开始优雅关闭`);
		void app
			.close()
			.then(() => closeDeps(deps))
			.finally(() => process.exit(0));
	});
}
