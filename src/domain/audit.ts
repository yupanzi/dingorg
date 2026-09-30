import { z } from "zod";

export const AUDIT_STATUSES = ["success", "failure"] as const;

/**
 * - `api_key`：调 REST 面的 API key，actorId 是 key 的 id（鉴权失败时记来件声称的那个，
 *   格式不对为空），actorName 是 key 的 name（只在鉴权通过时有）
 * - `dingtalk`：扫码登录的人，actorId 是 unionId；身份确定之前被拒的为空
 * - `system`：orgsync 的定时刷新，actorId 为空；也是列默认值
 *
 * ⚠️ 只加不删：删值要重建 PG 枚举，不再写入的值也留着。
 */
export const AUDIT_ACTOR_TYPES = ["api_key", "dingtalk", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export type AuditDetails = {
	summary?: string;
};

/** `path` 列宽。截断时留 `…`，看得出被截过 */
export const MAX_REQUEST_PATH_LENGTH = 512;

export const MAX_REQUEST_ID_LENGTH = 64;

/** `ip` 列宽。信任代理时它来自 X-Forwarded-For，任何人都能造 */
export const MAX_IP_LENGTH = 64;

/** `actor_id` 列宽。来件能造：REST 面只收定长的 key id（`parseApiKeyId`） */
export const MAX_ACTOR_ID_LENGTH = 255;

/**
 * `AUTH_JSON` 各项的 name，两种 type 共用一条规则：它进审计（client 的进 `target_name`，
 * API key 的进 `actor_name`）。不分 type 全局唯一，见 `~/domain/config-json`
 */
export const authEntryNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.refine((v) => !/\p{Cc}/u.test(v), "name 不能含控制字符");

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
