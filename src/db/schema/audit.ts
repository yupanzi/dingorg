import {
	bigint,
	index,
	jsonb,
	pgEnum,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";

import {
	AUDIT_ACTOR_TYPES,
	AUDIT_STATUSES,
	type AuditDetails,
	MAX_ACTOR_ID_LENGTH,
	MAX_IP_LENGTH,
	MAX_REQUEST_ID_LENGTH,
	MAX_REQUEST_PATH_LENGTH,
} from "~/domain/audit";

import { createTable } from "./table";

// ⚠️ 类型名是 schema 级全局的，必须手写项目前缀（`createTable` 兜不住）
export const auditStatus = pgEnum("dingorg_audit_status", AUDIT_STATUSES);
export const auditActorType = pgEnum(
	"dingorg_audit_actor_type",
	AUDIT_ACTOR_TYPES,
);

export const auditLogs = createTable(
	"audit_log",
	{
		id: bigint("id", { mode: "number" })
			.primaryKey()
			.generatedByDefaultAsIdentity(),

		at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),

		// actor / target 都是快照、不建外键：人离职后也要查得到，所以写入时就得拿对
		actorType: auditActorType("actor_type").notNull().default("system"),
		/** AppKey / unionId / null */
		actorId: varchar("actor_id", { length: MAX_ACTOR_ID_LENGTH }),
		actorName: varchar("actor_name", { length: 255 }),

		/** 取值见 `~/resources` 的 `AUDIT_ACTIONS` */
		action: varchar("action", { length: 96 }).notNull(),
		status: auditStatus("status").notNull().default("success"),

		/** 动作串的首段，冗余一列供索引与统计 */
		targetType: varchar("target_type", { length: 64 }).notNull(),
		targetId: varchar("target_id", { length: 255 }),
		targetName: varchar("target_name", { length: 255 }),

		ip: varchar("ip", { length: MAX_IP_LENGTH }),
		userAgent: text("user_agent"),

		method: varchar("method", { length: 8 }),
		/** 不含 query string */
		path: varchar("path", { length: MAX_REQUEST_PATH_LENGTH }),
		/** fastify 的 reqId，与日志关联。⚠️ 进程内自增，跨副本跨重启会重复，要配合 `at` */
		requestId: varchar("request_id", { length: MAX_REQUEST_ID_LENGTH }),

		details: jsonb("details").$type<AuditDetails>(),
	},
	(t) => [
		index("audit_log_at_idx").on(t.at),
		index("audit_log_actor_idx").on(t.actorId),
		index("audit_log_action_idx").on(t.action),
		index("audit_log_target_idx").on(t.targetType, t.targetId),
		index("audit_log_request_id_idx").on(t.requestId),
	],
);
