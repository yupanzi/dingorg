import { index, jsonb, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { createTable } from "./table";

/**
 * oidc-provider 所有 model 共用的单表，payload 原样存 jsonb（上游加字段不用迁移）。
 * 没有 client 表：client 是静态配置。
 */
export const oidcPayloads = createTable(
	"oidc_payloads",
	{
		model: text("model").notNull(),
		id: text("id").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		/** `revokeByGrantId` 用 */
		grantId: text("grant_id"),
		/** Session 的固定内部标识，`findByUid` 用 */
		uid: text("uid"),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.model, t.id] }),
		index("oidc_payloads_grant_id_idx").on(t.grantId),
		index("oidc_payloads_uid_idx").on(t.uid),
		// ⚠️ 过期行只由 oidcpurge cron 删，删了 cron 这张表会无限涨
		index("oidc_payloads_expires_at_idx").on(t.expiresAt),
	],
);
