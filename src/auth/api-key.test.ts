import { describe, expect, it } from "vitest";

import { apiKeyEntryId } from "~/domain/api-key";
import { authJsonSchema } from "~/domain/config-json";
import { newOidcClient } from "~/oidc/new-client";

import { createApiKeyVerifier, parseBearer } from "./api-key";
import { newApiKey } from "./new-api-key";

function generate(name: string) {
	const r = newApiKey(name);
	if (!r.success) throw new Error("生成失败");
	return { key: r.data.key, id: apiKeyEntryId(r.data), entry: r.data };
}

describe("parseBearer", () => {
	const { key, id } = generate("hr-system");

	it("取出 key 与它声称的 id", () => {
		expect(parseBearer(`Bearer ${key}`)).toEqual({ id, key });
		expect(parseBearer(`bearer ${key} `)).toEqual({ id, key });
	});

	it.each([
		["没带头", undefined],
		["Basic", `Basic ${Buffer.from(`id:${key}`).toString("base64")}`],
		["Bearer 后面是空的", "Bearer "],
		["不是 dok_ 格式", "Bearer abcdef"],
		["多了一段", `Bearer ${key} extra`],
	])("%s → null", (_, header) => {
		expect(parseBearer(header)).toBeNull();
	});
});

describe("createApiKeyVerifier", () => {
	const a = generate("hr-system");
	const b = generate("orgsync");
	const verify = createApiKeyVerifier([a.entry, b.entry]);

	it("生成的 key 过得了自己那一项：返回 id 与 name，不带 key", () => {
		for (const { key, id, entry } of [a, b]) {
			const presented = parseBearer(`Bearer ${key}`);
			expect(presented && verify(presented)).toEqual({ id, name: entry.name });
		}
	});

	it.each([
		["id 对、secret 错", () => ({ id: a.id, key: b.key })],
		["未知 id", () => ({ id: "00000000", key: a.key })],
		// 拿 a 的 id 配 b 的 key：哈希绑着整串，换 id 也不行
		[
			"把别人的 key 改成自己的 id",
			() => ({
				id: a.id,
				key: b.key.replace(b.id, a.id),
			}),
		],
	])("%s → null", (_, presented) => {
		expect(verify(presented())).toBeNull();
	});
});

describe("newApiKey", () => {
	it("每次的 id 与 key 都不同，secret 是 32 字节的 base64url", () => {
		const x = generate("x");
		const y = generate("y");
		expect(x.id).not.toBe(y.id);
		expect(x.key).not.toBe(y.key);
		expect(x.key).toMatch(/^dok_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
	});

	it("name 不合法在生成时就报出来", () => {
		expect(newApiKey("").success).toBe(false);
	});

	// 两个生成命令的 stdout 都是 `[一项]`，部署方把它们并进同一个 AUTH_JSON
	it("与生成的 client 并进同一个数组，原样过 AUTH_JSON 的校验", () => {
		const client = newOidcClient({
			name: "authentik-prod",
			redirectUris: ["https://sso.example.com/source/oauth/callback/dingorg/"],
		}).data;
		const { entry } = generate("hr-system");
		const merged = JSON.stringify([client, entry]);
		expect(authJsonSchema.parse(merged)).toEqual([client, entry]);
	});
});
