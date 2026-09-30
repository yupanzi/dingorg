import { describe, expect, it } from "vitest";

import { formatIssues } from "~/env";

import {
	type AuthEntry,
	appendAuthEntry,
	authJsonSchema,
	pickAuthEntries,
} from "./config-json";

// 各类型自己的规则在 oidc-client.test.ts 与 api-key.test.ts；这里只管两种混放的规则

const CLIENT = {
	type: "oidc",
	name: "authentik-prod",
	id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
	secret: "c".repeat(43),
	redirectUris: ["https://sso.example.com/source/oauth/callback/dingorg/"],
};
const KEY = {
	type: "apikey",
	name: "hr-system",
	key: `dok_1a2b3c4d_${"Q".repeat(43)}`,
};

const parse = (value: unknown[]) =>
	authJsonSchema.safeParse(JSON.stringify(value));
const messages = (value: unknown[]) => {
	const r = parse(value);
	if (r.success) throw new Error("本该校验失败");
	return formatIssues(r.error)
		.split("\n")
		.map((l) => l.trim());
};

describe("authJsonSchema", () => {
	it("两种项混排、顺序任意都合法", () => {
		expect(parse([KEY, CLIENT]).success).toBe(true);
	});

	it("只有 apikey 项：没有 client 谁都登录不了，拒绝", () => {
		expect(messages([KEY])).toEqual([
			expect.stringContaining("至少要有一个 type 为 oidc"),
		]);
	});

	it("type 缺失或写错：报在 type 上", () => {
		const { type: _, ...untyped } = KEY;
		for (const bad of [untyped, { ...KEY, type: "api_key" }, null]) {
			expect(messages([CLIENT, bad])).toEqual([
				expect.stringMatching(/^1(\.type)?: type 只能是 oidc 或 apikey/),
			]);
		}
	});

	// 一项不能既能登录又能调 REST：两边都 strict，混进对方的字段直接拒
	it("一项混了两种字段：拒绝", () => {
		expect(messages([{ ...CLIENT, key: KEY.key }])).toEqual([
			expect.stringContaining("key"),
		]);
		expect(messages([CLIENT, { ...KEY, secret: CLIENT.secret }])).toEqual([
			expect.stringMatching(/^1: .*secret/),
		]);
	});

	it("name 不分 type 全局唯一", () => {
		expect(messages([CLIENT, { ...KEY, name: CLIENT.name }])).toEqual([
			expect.stringMatching(/^1\.name: .*第 0 项/),
		]);
	});
});

describe("appendAuthEntry", () => {
	const client = CLIENT as AuthEntry;
	const key = KEY as AuthEntry;

	it("接在现有数组后面", () => {
		const r = appendAuthEntry(JSON.stringify([CLIENT]), key);
		expect(r.success && r.data.map((e) => e.name)).toEqual([
			"authentik-prod",
			"hr-system",
		]);
	});

	it("空输入当空数组：可以从一个 client 开始攒", () => {
		const r = appendAuthEntry(" \n", client);
		expect(r.success && r.data).toHaveLength(1);
	});

	// 生成时就报，而不是部署后启动失败
	it("合并后整体校验：与现有项重名、只有 apikey 都报", () => {
		const dup = appendAuthEntry(JSON.stringify([CLIENT]), {
			...key,
			name: CLIENT.name,
		});
		expect(dup.success || formatIssues(dup.error)).toMatch(/^\s*1\.name: /);

		const onlyKey = appendAuthEntry("", key);
		expect(onlyKey.success || formatIssues(onlyKey.error)).toContain(
			"至少要有一个 type 为 oidc",
		);
	});

	it("现有值不是 JSON：只说不是合法 JSON，不回显原文", () => {
		const r = appendAuthEntry(`[${KEY.key}`, client);
		const m = r.success ? "" : formatIssues(r.error);
		expect(m).toContain("不是合法的 JSON");
		expect(m).not.toContain(KEY.key.slice(13, 25));
	});
});

describe("pickAuthEntries", () => {
	it("按 type 取出一种，保持原顺序", () => {
		const other = { ...CLIENT, name: "staging", id: crypto.randomUUID() };
		const entries = authJsonSchema.parse(JSON.stringify([CLIENT, KEY, other]));
		expect(pickAuthEntries(entries, "oidc").map((c) => c.name)).toEqual([
			"authentik-prod",
			"staging",
		]);
		expect(pickAuthEntries(entries, "apikey").map((k) => k.name)).toEqual([
			"hr-system",
		]);
	});
});
