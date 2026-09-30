/**
 * 资源命名的唯一来源。
 *
 * ⚠️ 改项目名 `dingorg` 时还有：`~/db/schema/table.ts` 的表前缀、`~/db/schema/audit`
 * 的两个 pgEnum 名、`~/api` 自描述里的 `service`。刻意各写字面量：前几处进数据库，
 * 共用常量会让「改个显示名」变成一次数据迁移。
 */

// advisory lock 的键空间是 per-database 全局的，表前缀护不住
const LOCK_NAMESPACE = "dingorg";

export const ADVISORY_LOCKS = {
	oidcKeys: `${LOCK_NAMESPACE}:oidc_keys`,
} as const;

/** `app_secrets` 的键 */
export const OIDC_JWKS_KEY = "oidc_jwks";
export const OIDC_COOKIE_KEYS_KEY = "oidc_cookie_keys";

/** 钉钉企业 token 按应用发放，必须每个 appKey 一行 */
export function accessTokenKey(appKey: string): string {
	return `dingtalk_access_token:${appKey}`;
}

/** 审计动作串，`<实体>.<动词>`，首段冗余进 `target_type` 列 */
export const AUDIT_ACTIONS = {
	authLogin: "auth.login",
	/** 不是自有同步结果里的当前成员，或扫码回调本身无效（此时 actor 为空） */
	authReject: "auth.reject",

	orgListUsers: "org.listUsers",
	orgListDepartments: "org.listDepartments",

	/** 「看一眼」与「拉一次」分开记 */
	syncStatus: "sync.status",
	syncTrigger: "sync.trigger",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
