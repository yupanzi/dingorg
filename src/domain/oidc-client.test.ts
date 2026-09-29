import { describe, expect, it } from "vitest";

import { formatIssues } from "~/env";

import { oidcClientsJsonSchema, redirectUriSchema } from "./oidc-client";

// 回调地址校验决定授权码能交到哪儿。要加正则回调，得同时补开放重定向的护栏用例

describe("redirectUriSchema", () => {
	it("放行 https", () => {
		expect(
			redirectUriSchema.safeParse("https://app.example.com/auth/callback")
				.success,
		).toBe(true);
	});

	it("放行 loopback 上的 http（本机开发）", () => {
		for (const url of [
			"http://localhost:3000/api/auth/callback",
			"http://127.0.0.1:3000/cb",
		]) {
			expect(redirectUriSchema.safeParse(url).success).toBe(true);
		}
	});

	it("拒绝非 loopback 的 http —— 授权码不能走明文", () => {
		expect(
			redirectUriSchema.safeParse("http://app.example.com/cb").success,
		).toBe(false);
	});

	// 空 fragment 也要拒：它的 url.hash 是空串
	it("拒绝带 fragment 的回调，含空 fragment", () => {
		for (const url of [
			"https://app.example.com/cb#x",
			"https://app.example.com/cb#",
		]) {
			expect(redirectUriSchema.safeParse(url).success).toBe(false);
		}
	});

	it("拒绝不是 URL 的串", () => {
		for (const raw of [
			"",
			"app.example.com/cb",
			"/cb",
			"javascript:alert(1)",
		]) {
			expect(redirectUriSchema.safeParse(raw).success).toBe(false);
		}
	});
});

describe("oidcClientsJsonSchema", () => {
	const SECRET = "s3cr3t-value-that-must-never-be-echoed-0123";
	const client = (over: Record<string, unknown> = {}) => ({
		name: "authentik-prod",
		id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
		secret: SECRET,
		redirectUris: ["https://sso.example.com/source/oauth/callback/dingorg/"],
		...over,
	});
	const parse = (value: unknown) =>
		oidcClientsJsonSchema.safeParse(
			typeof value === "string" ? value : JSON.stringify(value),
		);
	// 用生产的 formatIssues：验的是真正进启动日志的那份
	const messages = (value: unknown) => {
		const r = parse(value);
		if (r.success) throw new Error("本该校验失败");
		return formatIssues(r.error)
			.split("\n")
			.map((l) => l.trim());
	};

	it("合法配置解析通过", () => {
		expect(parse([client()]).success).toBe(true);
	});

	it("至少一个 client", () => {
		expect(parse([]).success).toBe(false);
	});

	it("多出来的键直接拒绝", () => {
		expect(
			messages([client({ redirectUri: "https://x.example.com/cb" })]),
		).toEqual([expect.stringContaining("redirectUri")]);
	});

	it("id 必须是 UUID", () => {
		expect(parse([client({ id: "dingabcdefg123456" })]).success).toBe(false);
	});

	it("secret 太短拒绝", () => {
		expect(parse([client({ secret: "123456" })]).success).toBe(false);
	});

	// Basic 凭证会被 form 解码：原文发 `+` 的下游会被当成空格
	it("secret 只收 URL 不保留字符：标准 base64 的 + / = 拒绝", () => {
		for (const secret of [
			`${SECRET}+`,
			`${SECRET}/`,
			`${SECRET}=`,
			`${SECRET}%41`,
		]) {
			expect(messages([client({ secret })])).toEqual([
				expect.stringMatching(/^0\.secret: /),
			]);
		}
		expect(parse([client({ secret: `${SECRET}._~` })]).success).toBe(true);
	});

	it("id 与 name 各自不能重复，报错指向后出现的那个", () => {
		const other = client({
			id: "0d8682fc-11a1-4324-bdd0-edc189c26d7d",
			secret: `${SECRET}-2`,
		});
		expect(messages([client(), other])).toEqual([
			expect.stringMatching(/^1\.name: .*第 0 个/),
		]);
		expect(messages([client(), client({ name: "staging" })])).toEqual([
			expect.stringMatching(/^1\.id: .*第 0 个/),
		]);
	});

	it("每条回调地址都过 redirectUriSchema", () => {
		expect(
			messages([client({ redirectUris: ["http://evil.example.com/cb"] })]),
		).toEqual([expect.stringMatching(/^0\.redirectUris\.0: /)]);
	});

	// V8 的 JSON 报错只回显前 10 个字符，所以按前缀查
	it("任何报错都不回显原文里的 secret", () => {
		for (const bad of [
			SECRET,
			`[${JSON.stringify(client())}`,
			[client({ redirectUri: "x" })],
			[client({ id: SECRET })],
			[client({ name: SECRET.repeat(3) })],
			[client({ secret: `${SECRET}+` })],
		]) {
			for (const m of messages(bad))
				expect(m).not.toContain(SECRET.slice(0, 6));
		}
	});
});
