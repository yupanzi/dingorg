import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 测试默认 silent（pino 直写 fd，会和报告搅在一起）。必须在 loadEnvFile 之前：它不覆盖已有变量
process.env.LOG_LEVEL ??= "silent";

// ⚠️ 不能删：vitest 不读 .env，而集成测试无 DATABASE_URL 时静默跳过。CI 没有该文件，吞掉 ENOENT
try {
	process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
} catch {}

export default defineConfig({
	resolve: {
		// Vite 不读 tsconfig 的 paths
		alias: [
			{
				find: /^~\//,
				replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/`,
			},
		],
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
