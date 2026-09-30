import { randomBytes } from "node:crypto";

import { API_KEY_PREFIX, apiKeyEntrySchema } from "~/domain/api-key";

/** 过与启动校验同一份 schema：配置项里的 `key` 就是交给调用方的那一串 */
export function newApiKey(name: string) {
	const id = randomBytes(4).toString("hex");
	return apiKeyEntrySchema.safeParse({
		type: "apikey",
		name,
		key: `${API_KEY_PREFIX}_${id}_${randomBytes(32).toString("base64url")}`,
	});
}
