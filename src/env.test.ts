import { describe, expect, it } from "vitest";

import {
	idpEnvSchema,
	orgSyncEnvSchema,
	parseEnv,
	trustsProxyHeaders,
	withDevDefaults,
} from "./env";

const DINGTALK_SECRET = "dingtalk-app-secret-0123456789abcdefghij";
const API_KEY_ENTRY = {
	type: "apikey",
	name: "hr-system",
	key: `dok_1a2b3c4d_${"Q".repeat(43)}`,
};

function env(clientSecret: string, extra: object[] = [API_KEY_ENTRY]) {
	return {
		DATABASE_URL: "postgresql://u:p@localhost:5432/db",
		DINGTALK_APP_KEY: "dingabcdefg123456",
		DINGTALK_APP_SECRET: DINGTALK_SECRET,
		PUBLIC_ORIGIN: "http://localhost:3080",
		AUTH_JSON: JSON.stringify([
			{
				type: "oidc",
				name: "authentik-prod",
				id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
				secret: clientSecret,
				redirectUris: [
					"https://sso.example.com/source/oauth/callback/dingorg/",
				],
			},
			...extra,
		]),
	};
}

describe("idpEnvSchema", () => {
	it("合法配置解析出 client 与 API key", () => {
		const parsed = parseEnv(idpEnvSchema, env("c".repeat(43)));
		expect(parsed.AUTH_JSON.map((e) => [e.type, e.name])).toEqual([
			["oidc", "authentik-prod"],
			["apikey", "hr-system"],
		]);
	});

	it("没有 apikey 项也能启动：REST 面没有调用方", () => {
		const parsed = parseEnv(idpEnvSchema, env("c".repeat(43), []));
		expect(parsed.AUTH_JSON.map((e) => e.type)).toEqual(["oidc"]);
	});

	// 依赖 zod「字段硬失败就不跑对象级 refine」，改了这里会变成 TypeError
	it.each([
		["不是 JSON", "not json", /AUTH_JSON: 不是合法的 JSON/],
		["数组里有 null", "[null]", /AUTH_JSON\.0: type 只能是/],
	])("%s：只报字段的错，交叉校验不在未解析的值上跑", (_, raw, error) => {
		expect(() =>
			parseEnv(idpEnvSchema, { ...env("x"), AUTH_JSON: raw }),
		).toThrow(error);
	});

	it("client secret 不能等于 DINGTALK_APP_SECRET，且报错不回显它", () => {
		let message = "";
		try {
			parseEnv(idpEnvSchema, env(DINGTALK_SECRET));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("AUTH_JSON.0.secret");
		expect(message).not.toContain(DINGTALK_SECRET.slice(0, 8));
	});
});

describe("PUBLIC_ORIGIN", () => {
	const parse = (PUBLIC_ORIGIN: string) =>
		idpEnvSchema.safeParse({ ...env("c".repeat(43)), PUBLIC_ORIGIN });

	it.each(["https://sso.example.com", "http://localhost:3080"])(
		"%s：合法",
		(origin) => {
			expect(parse(origin).success).toBe(true);
		},
	);

	// iss 逐字比对：同一个地址只认一种写法；路径只有 /oidc 一个合法值，由代码补
	it.each([
		["带了 /oidc", "https://sso.example.com/oidc"],
		["结尾带 /", "https://sso.example.com/"],
		["写了默认端口", "https://sso.example.com:443"],
		["域名大写", "https://SSO.example.com"],
		["不是 http(s)", "ftp://sso.example.com"],
		["不是 URL", "sso.example.com"],
	])("%s：拒绝", (_, origin) => {
		expect(parse(origin).success).toBe(false);
	});
});

describe("withDevDefaults", () => {
	const DEV = "http://localhost:3080";

	it("非 production 没写：取本机监听地址", () => {
		expect(withDevDefaults({ NODE_ENV: "development" }).PUBLIC_ORIGIN).toBe(
			DEV,
		);
		expect(withDevDefaults({}).PUBLIC_ORIGIN).toBe(DEV);
		// .env 里留空等于没写
		expect(withDevDefaults({ PUBLIC_ORIGIN: "" }).PUBLIC_ORIGIN).toBe(DEV);
	});

	it("写了就用写的", () => {
		const PUBLIC_ORIGIN = "https://sso.example.com";
		expect(withDevDefaults({ PUBLIC_ORIGIN }).PUBLIC_ORIGIN).toBe(
			PUBLIC_ORIGIN,
		);
	});

	// 镜像里 NODE_ENV=production：缺了要启动失败，不能带着 localhost 的 issuer 跑起来
	it("production 没写：不补，启动校验报缺失", () => {
		const { PUBLIC_ORIGIN: _, ...rest } = env("c".repeat(43));
		const source = withDevDefaults({ ...rest, NODE_ENV: "production" });
		expect(source.PUBLIC_ORIGIN).toBeUndefined();
		expect(() => parseEnv(idpEnvSchema, source)).toThrow(/PUBLIC_ORIGIN/);
	});
});

describe("orgSyncEnvSchema", () => {
	it("要库与钉钉凭证，不要 OIDC 与 API key 配置", () => {
		const parsed = parseEnv(orgSyncEnvSchema, {
			DATABASE_URL: "postgresql://u:p@localhost:5432/db",
			DINGTALK_APP_KEY: "dingabcdefg123456",
			DINGTALK_APP_SECRET: DINGTALK_SECRET,
		});
		expect(parsed.DINGTALK_APP_KEY).toBe("dingabcdefg123456");
	});

	it("缺钉钉凭证就报出来", () => {
		expect(() =>
			parseEnv(orgSyncEnvSchema, {
				DATABASE_URL: "postgresql://u:p@localhost:5432/db",
			}),
		).toThrow(/DINGTALK_APP_KEY[\s\S]*DINGTALK_APP_SECRET/);
	});
});

// 两处（fastify trustProxy、oidc-provider proxy）都读它：判据只有 PUBLIC_ORIGIN 的协议
describe("trustsProxyHeaders", () => {
	it("https origin：前面必有终结 TLS 的代理 → 信任", () => {
		expect(
			trustsProxyHeaders({ PUBLIC_ORIGIN: "https://dingorg.example.com" }),
		).toBe(true);
	});

	it("http origin：直连 → 不信任，来件伪造不了审计 IP", () => {
		expect(trustsProxyHeaders({ PUBLIC_ORIGIN: "http://localhost:3080" })).toBe(
			false,
		);
	});
});
