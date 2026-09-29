/**
 * 组织快照：每个 appKey 一行、整份替换。隔离由主键结构性保证（不会漏写 `where app_key`），
 * 不存在半份数据，所以不需要锁或水位线。钉钉是权威源，丢了随时重拉。
 *
 * `data` 与 `fetched_at` 只在刷新成功时一起写，同空同非空：null = 从未成功拉取过。
 */

import { integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";

import type { OrgSnapshotData } from "~/domain/org-snapshot";

import { createTable } from "./table";

export const orgSnapshots = createTable("org_snapshots", {
	appKey: text("app_key").primaryKey(),
	data: jsonb("data").$type<OrgSnapshotData>(),
	/** 那次拉取的开始时刻（年龄只会偏大）；并发写时只有更晚开始的能覆盖 */
	fetchedAt: timestamp("fetched_at", { withTimezone: true }),
	/** 最近一次尝试的结束时刻，成功失败都记，冷却从它算 */
	attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
	/** 最近一次失败的原因，会回给调用方，只存 `describeFailure` 过的说法 */
	error: text("error"),
	userCount: integer("user_count").notNull().default(0),
	deptCount: integer("dept_count").notNull().default(0),
});
