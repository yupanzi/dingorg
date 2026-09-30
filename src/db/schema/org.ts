/**
 * 组织同步：钉钉通讯录的镜像。一行同步状态 + 部门 / 成员 / 成员-部门三张镜像表，每一轮在一个
 * 事务里整体换新（读的一方要么看到上一轮、要么看到这一轮）。钉钉是权威源，丢了随时重拉。
 * 读写都在 `~/sync/store`。
 *
 * ⚠️ `app_key` 与 `fetched_at` 只在成功写入的事务里改（外加空表时抢租约那次 INSERT）；抢租约与
 * 记失败只动 `lease_*` / `attempted_at` / `error`。否则一次失败的同步就能把别的应用的名单标成
 * 自有的，准入跟着放行别的企业的人。
 */

import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	jsonb,
	primaryKey,
	smallint,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

import { createTable } from "./table";

export const ORG_SYNC_ID = 1;

export const orgSync = createTable(
	"org_sync",
	{
		/** 恒为 1：全库只有一份组织同步 */
		id: smallint("id").primaryKey().default(ORG_SYNC_ID),
		/** 镜像表里的数据属于哪个钉钉应用；与当前 `DINGTALK_APP_KEY` 不符就当没同步过 */
		appKey: text("app_key").notNull(),
		/** 最近一次成功那轮拉取的开始时刻（年龄只会偏大），null = 从没成功过；并发写时只有更晚开始的能落库 */
		fetchedAt: timestamp("fetched_at", { withTimezone: true }),
		/** 最近一次尝试的结束时刻，成功失败都记，冷却从它算；null = 还没有哪次尝试结束 */
		attemptedAt: timestamp("attempted_at", { withTimezone: true }),
		/** 最近一次失败的原因，会回给调用方，只存 `describeFailure` 过的说法 */
		error: text("error"),
		/** 同步租约：持有者在拉钉钉，到期前别人不拉。按时间过期，进程被杀不用人工解锁 */
		leaseHolder: text("lease_holder"),
		leaseUntil: timestamp("lease_until", { withTimezone: true }),
	},
	(t) => [
		check("org_sync_singleton", sql`${t.id} = 1`),
		check(
			"org_sync_lease_pair",
			sql`(${t.leaseHolder} is null) = (${t.leaseUntil} is null)`,
		),
	],
);

/** 钉钉 `dept_id` 是 int64。不建自引用外键：整份替换时顺序无所谓 */
export const orgDepartments = createTable("org_departments", {
	id: bigint("id", { mode: "number" }).primaryKey(),
	parentId: bigint("parent_id", { mode: "number" }),
	name: text("name").notNull(),
	/** 从根到父的完整链 */
	ancestorIds: bigint("ancestor_ids", { mode: "number" }).array().notNull(),
});

/**
 * 成员，列与 `OrgApiUser` 一一对应。主键是 userid：unionid 在「个人信息」权限没开时缺失。
 *
 * `left_at` 非空 = 最近一轮同步里不在了（离职、移出可见范围、撞名被跳过都算），整行保留为
 * 最后所见。⚠️ 准入与 REST 只认 `left_at is null` 的行。
 *
 * ⚠️ `user_name` 别加唯一约束：同一轮里两人互换 userName 会撞上不可延迟的唯一索引，
 * 唯一性由 `pickOwner` 在写库前保证。
 */
export const orgUsers = createTable(
	"org_users",
	{
		userid: text("userid").primaryKey(),
		unionid: text("unionid"),
		userName: text("user_name").notNull(),
		displayName: text("display_name").notNull(),
		email: text("email"),
		titles: text("titles").array().notNull(),
		ranks: text("ranks").array().notNull(),
		jobLevel: text("job_level"),
		title: text("title"),
		extension: jsonb("extension").$type<Record<string, unknown>>(),
		avatar: text("avatar"),
		orgEmail: text("org_email"),
		leftAt: timestamp("left_at", { withTimezone: true }),
	},
	(t) => [
		// 准入按它查。重入职的人旧 userid 的行已离开，所以只约束当前成员
		uniqueIndex("org_users_unionid_current_idx")
			.on(t.unionid)
			.where(sql`${t.leftAt} is null`),
	],
);

/** 只含当前成员，每轮整份重建。外键不级联：删除顺序写错要当场报错，而不是悄悄连带删掉 */
export const orgUserDepts = createTable(
	"org_user_depts",
	{
		userid: text("userid")
			.notNull()
			.references(() => orgUsers.userid),
		deptId: bigint("dept_id", { mode: "number" })
			.notNull()
			.references(() => orgDepartments.id),
		/** ⚠️ 相对这个部门，不是全局的 */
		isLeader: boolean("is_leader").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userid, t.deptId] })],
);
