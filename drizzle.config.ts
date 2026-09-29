import { defineConfig } from "drizzle-kit";

// 显式加载 .env，不依赖 drizzle-kit 的隐式行为（失败症状是静默连到默认库）
try {
	process.loadEnvFile(".env");
} catch {}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 未设置");

export default defineConfig({
	schema: "./src/db/schema",
	out: "./drizzle",
	dialect: "postgresql",
	// ⚠️ 必须与 `~/db/index.ts` 的 casing 一致
	casing: "snake_case",
	dbCredentials: { url },
});
