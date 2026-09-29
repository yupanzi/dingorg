import { jsonb, text, timestamp } from "drizzle-orm/pg-core";

import { createTable } from "./table";

/**
 * 密钥 kv，键名见 `~/resources`。两类住户：OIDC 的 JWKS 与 cookie keys（⚠️ 不可重建，
 * 丢了全员掉登录）；各 appKey 的钉钉 token 缓存（随时可重取）。
 */
export const appSecrets = createTable("app_secrets", {
	key: text("key").primaryKey(),
	value: jsonb("value").$type<Record<string, unknown>>().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
