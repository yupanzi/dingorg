export const AUDIT_STATUSES = ["success", "failure"] as const;

/**
 * - `app`：调 REST 面的钉钉应用，actorId 是 AppKey（鉴权失败时记来件声称的那个）
 * - `dingtalk`：扫码登录的人，actorId 是 unionId；身份确定之前被拒的为空
 * - `system`：没有写入方，只是列默认值（删它要重建 PG 枚举）
 */
export const AUDIT_ACTOR_TYPES = ["app", "dingtalk", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export type AuditDetails = {
	summary?: string;
};

/** `path` 列宽。截断时留 `…`，看得出被截过 */
export const MAX_REQUEST_PATH_LENGTH = 512;

export const MAX_REQUEST_ID_LENGTH = 64;

/** `ip` 列宽。信任代理时它来自 X-Forwarded-For，任何人都能造 */
export const MAX_IP_LENGTH = 64;

/** `actor_id` 列宽。来件能造，超长的在凭证解析处拒收 */
export const MAX_ACTOR_ID_LENGTH = 255;

/** 超长截断并留 `…`，看得出被截过 */
function clamp(v: string, max: number): string {
	return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** ⚠️ 落库、进日志前剥掉 query string：里面可能有授权码之类的原始入参 */
export function normalizeRequestPath(
	path: string | null | undefined,
): string | null {
	if (!path) return null;
	const trimmed = path.trim();
	const q = trimmed.indexOf("?");
	const withoutQuery = q === -1 ? trimmed : trimmed.slice(0, q);
	return withoutQuery ? clamp(withoutQuery, MAX_REQUEST_PATH_LENGTH) : null;
}

/** ⚠️ 来件能控制的值不能让审计写入失败：超长的 ip 截断 */
export function normalizeIp(ip: string | null | undefined): string | null {
	return ip ? clamp(ip, MAX_IP_LENGTH) : null;
}
