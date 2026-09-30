import { createHash, timingSafeEqual } from "node:crypto";

import {
	type ApiKeyEntry,
	apiKeyEntryId,
	parseApiKeyId,
} from "~/domain/api-key";

/**
 * REST 面的鉴权：`Authorization: Bearer dok_…`，比对 `AUTH_JSON` 里同 id 的 apikey 项。
 * 钉钉凭证只在服务端，调用方碰不到。不限流：key 含 256 位随机，爆破不可行；校验不外呼。
 */

export interface PresentedKey {
	/** 来件声称的 id，格式已校验，可以原样进审计 */
	id: string;
	key: string;
}

/** 格式不对一律 null：不区分「没带」和「带错了」 */
export function parseBearer(header: string | undefined): PresentedKey | null {
	const key = header ? /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
	const id = key ? parseApiKeyId(key) : null;
	return key && id ? { id, key } : null;
}

/** 通过鉴权的调用方。不带 key：它挂在请求上，别让它有机会进日志 */
export interface RestCaller {
	id: string;
	name: ApiKeyEntry["name"];
}

/** 比对前两边都哈希：`timingSafeEqual` 要等长。哈希的是整串（含 id），id 与 secret 绑在一起 */
function sha256(key: string): Buffer {
	return createHash("sha256").update(key).digest();
}

/** 未知 id、key 错一律 null，不区分 */
export function createApiKeyVerifier(
	entries: readonly ApiKeyEntry[],
): (presented: PresentedKey) => RestCaller | null {
	// 配置里的 key 启动时哈希一次，之后只留哈希
	const byId = new Map(
		entries.map((e) => {
			const id = apiKeyEntryId(e);
			return [id, { id, name: e.name, sha256: sha256(e.key) }];
		}),
	);
	return ({ id, key }) => {
		const entry = byId.get(id);
		const ok =
			entry !== undefined && timingSafeEqual(sha256(key), entry.sha256);
		return ok ? { id: entry.id, name: entry.name } : null;
	};
}
