import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { formatIssues } from "~/env";

import { parseApiKeyId } from "./api-key";
import { authJsonSchema } from "./config-json";

const KEY = `dok_1a2b3c4d_${"Q".repeat(40)}_-x`;
const KEY_SHA256 = createHash("sha256").update(KEY).digest("hex");

describe("parseApiKeyId", () => {
	it("取出 id；secret 里的 `_` 与 `-` 不影响切分", () => {
		expect(parseApiKeyId(KEY)).toBe("1a2b3c4d");
	});

	it.each([
		["前缀不对", KEY.replace("dok_", "sk_")],
		["id 不是 8 位小写十六进制", KEY.replace("1a2b3c4d", "1A2B3C4D")],
		["secret 短一位", KEY.slice(0, -1)],
		["secret 长一位", `${KEY}x`],
		["secret 里有 base64 的 +", `${KEY.slice(0, -1)}+`],
		["空串", ""],
	])("%s → null", (_, key) => {
		expect(parseApiKeyId(key)).toBeNull();
	});
});

describe("AUTH_JSON 的 apikey 项", () => {
	const OTHER_KEY = `dok_00000000_${"R".repeat(43)}`;
	const entry = (over: Record<string, unknown> = {}) => ({
		type: "apikey",
		name: "hr-system",
		key: KEY,
		...over,
	});
	// 缺 oidc 项会多一条不相干的报错：补在末尾，不挪动 apikey 项的下标
	const OIDC = {
		type: "oidc",
		name: "authentik-prod",
		id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
		secret: "c".repeat(43),
		redirectUris: ["https://sso.example.com/source/oauth/callback/dingorg/"],
	};
	type Input = string | Record<string, unknown>[];
	const parse = (value: Input) =>
		authJsonSchema.safeParse(
			typeof value === "string" ? value : JSON.stringify([...value, OIDC]),
		);
	const messages = (value: Input) => {
		const r = parse(value);
		if (r.success) throw new Error("本该校验失败");
		return formatIssues(r.error)
			.split("\n")
			.map((l) => l.trim());
	};

	it("合法配置解析通过", () => {
		expect(
			parse([entry(), entry({ name: "bi", key: OTHER_KEY })]).success,
		).toBe(true);
	});

	it("没有 apikey 项合法：不开 REST 面", () => {
		expect(parse([]).success).toBe(true);
	});

	it("多出来的键直接拒绝", () => {
		expect(messages([entry({ sha256: KEY_SHA256 })])).toEqual([
			expect.stringContaining("sha256"),
		]);
	});

	it.each([
		["短一位", KEY.slice(0, -1)],
		["没有 dok_ 前缀", KEY.slice(4)],
		["填成了 sha256", KEY_SHA256],
	])("key %s：拒绝，且报错不回显它", (_, key) => {
		const m = messages([entry({ key })]);
		expect(m).toEqual([expect.stringMatching(/^0\.key: /)]);
		expect(m.join("\n")).not.toContain(key.slice(13, 25));
	});

	it("key 的 id 段与 name 各自不能重复，报错指向后出现的那个", () => {
		const sameId = KEY.replace("QQQQ", "RRRR");
		expect(messages([entry(), entry({ name: "other", key: sameId })])).toEqual([
			expect.stringMatching(/^1\.key: .*第 0 项/),
		]);
		expect(messages([entry(), entry({ key: OTHER_KEY })])).toEqual([
			expect.stringMatching(/^1\.name: .*第 0 项/),
		]);
	});

	it("不是 JSON：只说不是合法 JSON，不回显原文", () => {
		const m = messages(`[${KEY}`);
		expect(m).toEqual([expect.stringContaining("不是合法的 JSON")]);
		expect(m.join("\n")).not.toContain(KEY.slice(0, 12));
	});
});
