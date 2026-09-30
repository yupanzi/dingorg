/**
 * 对外组织 API 的响应契约，由 `~/sync/store` 从镜像表组装。
 * 字段名借 SCIM 的词汇（OIDC 标准 claim 里没有雇佣关系属性）。
 */

/** `ancestorIds` 是从根到父的完整链 */
export interface OrgApiDept {
	id: number;
	parentId: number | null;
	name: string;
	ancestorIds: number[];
}

/** 部门归属一律看这里，别从职位文本里的部门路径切（那是手填的，改名不跟着变） */
export interface OrgApiUserDept {
	id: number;
	name: string;
	isLeader: boolean;
}

/**
 * 系统字段平铺在顶层，钉钉原文收在 `dingtalk` 里（保持钉钉的字段名）。只列当前可见的人：
 * 离开的人在库里留着（`left_at`），但不出现在这里。
 */
export interface OrgApiUser {
	/**
	 * 企业邮箱的 local part，没有则取显示名括号前的部分；当前成员内唯一。会随企业邮箱或
	 * 显示名变化，永不变的锚点是 `dingtalk.unionid`
	 */
	userName: string;
	/** 形如 `Zhangsan(张三)` */
	displayName: string;
	/** 企业邮箱（小写），没有就是 null，不推导 */
	email: string | null;
	depts: OrgApiUserDept[];
	/** 职务全称，一人多职时多条 */
	titles: string[];
	/** 从 `titles` 提出的职级词，按层级从高到低 */
	ranks: string[];
	/** 取自自定义字段「职务」，单值、会丢职；判断职级用 `ranks` */
	jobLevel: string | null;
	dingtalk: {
		userid: string;
		/** 跨应用永久标识，也是 OIDC 的 `sub` */
		unionid: string | null;
		/** 职位原文，多职未拆分 */
		title: string | null;
		/** 自定义字段原样透传；解析失败时为 null */
		extension: Record<string, unknown> | null;
		avatar: string | null;
		/** 企业邮箱原文（只 trim）。⚠️ 覆盖率约五成，别拿它做关联键 */
		orgEmail: string | null;
	};
}

interface SyncStamp {
	/** 产出这份数据的那次拉取的开始时刻（ISO 8601）。数据不按时间过期，多旧要让调用方看见 */
	fetchedAt: string;
}

export interface OrgApiUsersResponse extends SyncStamp {
	users: OrgApiUser[];
	total: number;
}

export interface OrgApiDeptsResponse extends SyncStamp {
	departments: OrgApiDept[];
	total: number;
}

/** `state` 是派生值，见 `~/api/sync` 的 `toStatus` */
export interface OrgApiSyncStatus {
	state: "never" | "failed" | "ok";
	fetchedAt: string | null;
	attemptedAt: string | null;
	error: string | null;
	/** 有副本正持着同步租约在拉钉钉 */
	syncing: boolean;
	userCount: number | null;
	deptCount: number | null;
}

/** `refreshed: false` = 冷却期内或别处正在同步，没有外呼，返回的是现有数据 */
export interface OrgApiSyncResponse extends OrgApiSyncStatus {
	refreshed: boolean;
}

/** 所有错误的统一形状（REST 面与根实例共用） */
export interface OrgApiErrorBody {
	error: {
		code: string;
		message: string;
		dingtalk?: { errcode?: number; code?: string; status?: number };
	};
}
