/**
 * 身份归一化的唯一实现。`userName` 同时是 OIDC 的 `preferred_username`：规则一改，
 * 下游按它关联的账号整体错位。
 */

/** domain 不依赖 IO 层，自己声明用得上的字段 */
export interface DingtalkUserFields {
	/** 类型上必有，但运行时不校验：缺了只能跳过这个人，不能让整轮同步失败 */
	name: string;
	org_email?: string | null;
}

export interface NormalizedIdentity {
	email: string | null;
	userName: string;
}

/**
 * ⚠️ email 只认 `org_email`：它以 `email_verified: true` 发出去。别加回钉钉的 `email`
 * （管理员手填、未验证），也别按姓名拼域名（拼出的地址不一定存在）。
 * userName：有企业邮箱取 local part，没有取显示名括号前的部分；撞名由 `pickOwner` 裁决。
 */
export function normalizeIdentity(
	user: DingtalkUserFields,
): NormalizedIdentity | null {
	const email = toEmail(user.org_email);
	const userName = email
		? toUserName(email)
		: splitDisplayName(user.name ?? "").toLowerCase();
	if (!userName) return null;
	return { email, userName };
}

// 原文有尾部带空格的脏值；统一小写，否则下游会把同一个人当成两个
function toEmail(raw: string | null | undefined): string | null {
	const email = raw?.trim().toLowerCase();
	return email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

export function toUserName(raw: string): string {
	return raw.trim().toLowerCase().split("@")[0] ?? "";
}

/** `"zhangsan(张三)"` → `"zhangsan"`，兼容全角括号 */
export function splitDisplayName(name: string): string {
	return name.split(/[(（]/)[0]?.trim() ?? name;
}
