import { defineConfig } from "tsup";

/**
 * 三方依赖保持 external（oidc-provider 带内部资源文件，bundle 进来会炸）。
 * ⚠️ 别加 `bin/auth.ts`：它只在本机跑，进镜像的话 client secret 与 API key 会随输出进日志。
 */
export default defineConfig({
	entry: [
		"src/server.ts",
		"src/bin/migrate.ts",
		"src/bin/cron/oidcpurge.ts",
		"src/bin/cron/orgsync.ts",
	],
	format: ["esm"],
	target: "node22",
	outDir: "dist",
	clean: true,
	sourcemap: true,
});
