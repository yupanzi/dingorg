import { describe, expect, it } from "vitest";

import { idpEnvSchema, orgSyncEnvSchema, parseEnv } from "./env";

const DINGTALK_SECRET = "dingtalk-app-secret-0123456789abcdefghij";

function env(clientSecret: string) {
	return {
		DATABASE_URL: "postgresql://u:p@localhost:5432/db",
		DINGTALK_APP_KEY: "dingabcdefg123456",
		DINGTALK_APP_SECRET: DINGTALK_SECRET,
		OIDC_ISSUER: "http://localhost:3080/oidc",
		OIDC_CLIENTS_JSON: JSON.stringify([
			{
				name: "authentik-prod",
				id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
				secret: clientSecret,
				redirectUris: [
					"https://sso.example.com/source/oauth/callback/dingorg/",
				],
			},
		]),
	};
}

describe("idpEnvSchema", () => {
	it("合法配置解析出 client 列表", () => {
		const parsed = parseEnv(idpEnvSchema, env("c".repeat(43)));
		expect(parsed.OIDC_CLIENTS_JSON.map((c) => c.name)).toEqual([
			"authentik-prod",
		]);
	});

	// 依赖 zod「字段硬失败就不跑对象级 refine」，改了这里会变成 TypeError
	it("client JSON 非法时只报 JSON 的错，交叉校验不在未解析的值上跑", () => {
		expect(() =>
			parseEnv(idpEnvSchema, { ...env("x"), OIDC_CLIENTS_JSON: "not json" }),
		).toThrow(/OIDC_CLIENTS_JSON: 不是合法的 JSON/);
	});

	it("client secret 不能等于 DINGTALK_APP_SECRET，且报错不回显它", () => {
		let message = "";
		try {
			parseEnv(idpEnvSchema, env(DINGTALK_SECRET));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("OIDC_CLIENTS_JSON.0.secret");
		expect(message).not.toContain(DINGTALK_SECRET.slice(0, 8));
	});
});

describe("orgSyncEnvSchema", () => {
	const cred = {
		DINGTALK_APP_KEY: "dingabcdefg123456",
		DINGTALK_APP_SECRET: DINGTALK_SECRET,
	};

	it("DINGORG_URL 留空即本机默认端口，且不要 DATABASE_URL", () => {
		const parsed = parseEnv(orgSyncEnvSchema, { ...cred, DINGORG_URL: "" });
		expect(parsed.DINGORG_URL).toBe("http://localhost:3080");
	});

	it("DINGORG_URL 留空时端口跟随同一份 .env 的 IDP_PORT", () => {
		const parsed = parseEnv(orgSyncEnvSchema, { ...cred, IDP_PORT: "4000" });
		expect(parsed.DINGORG_URL).toBe("http://localhost:4000");
	});

	it("DINGORG_URL 不是 URL：报校验错误，而不是抛裸 TypeError", () => {
		expect(() =>
			parseEnv(orgSyncEnvSchema, { ...cred, DINGORG_URL: "dingorg" }),
		).toThrow(/环境变量校验失败[\s\S]*DINGORG_URL/);
	});

	it("DINGORG_URL 带路径就拒收", () => {
		expect(() =>
			parseEnv(orgSyncEnvSchema, {
				...cred,
				DINGORG_URL: "https://dingorg.example.com/oidc",
			}),
		).toThrow(/DINGORG_URL: 只写 origin，不带路径/);
	});
});
