import { z } from "zod";

import { authEntryNameSchema } from "./audit";

/**
 * REST 面的凭证：`dok_<id>_<secret>`，与 OIDC client 无关，泄漏了只换它自己。
 *
 * 配置（env `AUTH_JSON` 里 `type: "apikey"` 的项）存 key 明文：⚠️ 能读那个 Secret 就能读
 * 全组织通讯录，Secret 的读权限按此收紧。别改成从 client secret 派生：持有 client secret 的
 * 下游就能自己算出 key，撤销 key 也得连带换掉 client secret。
 */

export const API_KEY_PREFIX = "dok";

// secret 是 base64url，自身含 `_` 与 `-`：id 定长，按前两个 `_` 切。
// id 在鉴权失败时也原样进审计 `actor_id`，格式收死才不会让审计写失败
const API_KEY_PATTERN = new RegExp(
	`^${API_KEY_PREFIX}_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$`,
);

/** 格式不对为 null */
export function parseApiKeyId(key: string): string | null {
	return API_KEY_PATTERN.exec(key)?.[1] ?? null;
}

/** strict：拼错的键直接启动失败，而不是被静默忽略 */
export const apiKeyEntrySchema = z.strictObject({
	type: z.literal("apikey"),
	name: authEntryNameSchema,
	// 报错只用固定文案，不回显：值就是 key
	key: z
		.string()
		.regex(
			API_KEY_PATTERN,
			`key 格式是 ${API_KEY_PREFIX}_<8 位小写十六进制>_<43 位 base64url>（用 pnpm auth:apikey 生成）`,
		),
});
export type ApiKeyEntry = z.infer<typeof apiKeyEntrySchema>;

/** 配置项的 id。schema 已收死 key 的格式，走到 throw 就是绕过了校验 */
export function apiKeyEntryId(entry: Pick<ApiKeyEntry, "key">): string {
	const id = parseApiKeyId(entry.key);
	if (id === null) throw new Error("API key 配置项没过 apiKeyEntrySchema");
	return id;
}
