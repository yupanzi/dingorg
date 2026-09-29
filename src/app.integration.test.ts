import type { EventEmitter } from "node:events";
import { inspect } from "node:util";

import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { appSecrets, auditLogs, orgSnapshots } from "~/db/schema";
import type { DingtalkCredentials } from "~/dingtalk/client";
import { fetchOrg } from "~/dingtalk/fetch-org";
import { CLIENT_SCOPE } from "~/domain/oidc-client";
import { type IdpEnv, parseEnv } from "~/env";
import { createOidcProvider } from "~/oidc/provider";
import { AUDIT_ACTIONS, accessTokenKey } from "~/resources";

import { buildApp } from "./app";
import { closeDeps, createDeps, type Deps } from "./deps";
import { idpEnvSchema } from "./env";

/**
 * 路由契约：OIDC 挂载不吞路由、静态 client、REST 面鉴权与隔离。
 *
 * mock 两个钉钉出口：`fetchAccessToken` 只认 secret `good`；`fetchOrg` 按 token 返回可区分
 * 的组织，两个专用 appKey 让它抛错。⚠️ 别往 buildApp 里加启动即外呼的逻辑：这里会拿假凭证
 * 去真打钉钉。
 */
vi.mock("~/dingtalk/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("~/dingtalk/client")>()),
	fetchAccessToken: vi.fn(async (cred: DingtalkCredentials) => {
		if (cred.clientSecret !== "good") throw new Error("钉钉拒绝了这对凭证");
		return {
			accessToken: `tok-${cred.clientId}`,
			expiresAt: Math.floor(Date.now() / 1000) + 7200,
		};
	}),
}));
vi.mock("~/dingtalk/fetch-org", async () => {
	const { DingtalkError } = await import("~/dingtalk/client");
	return {
		fetchOrg: vi.fn(async (token: string) => {
			if (token === "tok-itest-rest-ip-blocked") {
				throw new DingtalkError("ip 不在白名单", { errcode: 60020 });
			}
			if (token === "tok-itest-rest-internal") {
				throw new Error('relation "secret_table" does not exist');
			}
			return {
				departments: [
					{ id: 1, parentId: null, name: "根部门", ancestorIds: [] },
				],
				membersByDept: [
					{
						deptId: 1,
						members: [
							{
								userid: `userid-${token}`,
								name: token,
								org_email: `${token}@example.com`,
								unionid: `union-${token}`,
							},
						],
					},
				],
			};
		}),
	};
});

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("IdP 路由契约 (需要 DATABASE_URL)", () => {
	let env: IdpEnv;
	let deps: Deps;
	let app: FastifyInstance;

	// HOST 必须与 OIDC_ISSUER 同源：discovery 的端点 URL 由请求 Host 头派生
	const HOST = "localhost:13001";
	const ISSUER = `http://${HOST}/oidc`;
	const DINGTALK_APP_KEY = "itest-appkey";
	const CLIENT_A = {
		name: "itest-authentik-prod",
		id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
		secret: "itest-client-a-secret-0123456789abcdef",
		redirectUris: ["https://sso.example.com/source/oauth/callback/dingorg/"],
	} as const;
	const CLIENT_B = {
		name: "itest-authentik-staging",
		id: "0d8682fc-11a1-4324-bdd0-edc189c26d7d",
		secret: "itest-client-b-secret-0123456789abcdef",
		redirectUris: [
			"https://sso-stg.example.com/source/oauth/callback/dingorg/",
		],
	} as const;

	beforeAll(async () => {
		env = parseEnv(idpEnvSchema, {
			DATABASE_URL: url,
			DINGTALK_APP_KEY,
			DINGTALK_APP_SECRET: "x",
			OIDC_ISSUER: ISSUER,
			OIDC_CLIENTS_JSON: JSON.stringify([CLIENT_A, CLIENT_B]),
		});
		deps = createDeps(env);
		app = await buildApp(deps, env);
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		await closeDeps(deps);
	});

	it("healthz 返回 200 —— 确认 oidc 挂载没有吞掉 fastify 自有路由", async () => {
		const res = await app.inject({ method: "GET", url: "/healthz" });
		expect(res.statusCode).toBe(200);
	});

	it("OIDC discovery 可用且 issuer/端点带 /oidc 前缀", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/oidc/.well-known/openid-configuration",
			headers: { host: HOST },
		});
		expect(res.statusCode).toBe(200);
		const doc = res.json() as Record<string, string>;
		expect(doc.issuer).toBe(ISSUER);
		expect(doc.authorization_endpoint).toBe(`${ISSUER}/auth`);
		expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
		expect(doc.jwks_uri).toBe(`${ISSUER}/jwks`);
	});

	// scope 由 provider 从 `claims` 映射派生，断了不会报错。roles 是下游的事
	it("discovery 暴露适配器承诺的 scope，且不含 roles", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/oidc/.well-known/openid-configuration",
			headers: { host: HOST },
		});
		const doc = res.json() as {
			scopes_supported: string[];
			claims_supported: string[];
		};
		expect(doc.scopes_supported).toEqual(
			expect.arrayContaining(CLIENT_SCOPE.split(" ")),
		);
		expect(doc.claims_supported).toEqual(
			expect.arrayContaining(["sub", "name", "preferred_username", "email"]),
		);
		expect(doc.scopes_supported).not.toContain("roles");
		expect(doc.claims_supported).not.toContain("roles");
	});

	describe("静态 client（OIDC_CLIENTS_JSON）", () => {
		// RFC 7636 的示例 challenge（强制 PKCE）
		const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
		const [REDIRECT_A] = CLIENT_A.redirectUris;
		const [REDIRECT_B] = CLIENT_B.redirectUris;

		const authorize = (params: Record<string, string>) =>
			app.inject({
				method: "GET",
				url: "/oidc/auth",
				headers: { host: HOST },
				query: {
					response_type: "code",
					scope: "openid",
					code_challenge: CHALLENGE,
					code_challenge_method: "S256",
					state: "itest",
					...params,
				},
			});

		// 用不存在的授权码换 token：client 认证过了是 invalid_grant，没过是 invalid_client
		const exchange = (opts: {
			clientId: string;
			secret: string;
			method: "post" | "basic";
		}) => {
			const form = new URLSearchParams({
				grant_type: "authorization_code",
				code: "itest-no-such-code",
				redirect_uri: REDIRECT_A,
				code_verifier: "itest-verifier-0123456789012345678901234567890",
			});
			const headers: Record<string, string> = {
				host: HOST,
				"content-type": "application/x-www-form-urlencoded",
			};
			if (opts.method === "post") {
				form.set("client_id", opts.clientId);
				form.set("client_secret", opts.secret);
			} else {
				headers.authorization = `Basic ${Buffer.from(
					`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.secret)}`,
				).toString("base64")}`;
			}
			return app.inject({
				method: "POST",
				url: "/oidc/token",
				headers,
				payload: form.toString(),
			});
		};

		it("配置里的每个 client 都认得 —— 跳到 interaction", async () => {
			for (const [client_id, redirect_uri] of [
				[CLIENT_A.id, REDIRECT_A],
				[CLIENT_B.id, REDIRECT_B],
			] as const) {
				const res = await authorize({ client_id, redirect_uri });
				expect(res.statusCode).toBe(303);
				expect(res.headers.location).toContain("/oidc/interaction/");
			}
		});

		it("不认别的 client_id，包括钉钉 AppKey —— 动态注册是关掉的", async () => {
			for (const client_id of ["some-other-client", DINGTALK_APP_KEY]) {
				const res = await authorize({ client_id, redirect_uri: REDIRECT_A });
				expect(res.statusCode).toBe(400);
				expect(res.body).toContain("invalid_client");
			}
		});

		it("回调地址只有精确匹配 —— 未登记的地址拿不到授权码", async () => {
			const res = await authorize({
				client_id: CLIENT_A.id,
				redirect_uri: "https://evil.example.com/cb",
			});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain("redirect_uri");
		});

		it("回调只认本 client 登记的 —— B 的授权码不能交到 A 的地址", async () => {
			const res = await authorize({
				client_id: CLIENT_B.id,
				redirect_uri: REDIRECT_A,
			});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain("redirect_uri");
		});

		it("token 端点：只认本 client 的 secret", async () => {
			const res = await exchange({
				clientId: CLIENT_A.id,
				secret: CLIENT_B.secret,
				method: "post",
			});
			expect(res.json()).toMatchObject({ error: "invalid_client" });
		});

		// 绕过 zod 塞一个上游会拒的 client。断言 util.inspect：启动失败时打印的就是它
		it("启动时就过 oidc-provider 自己的 client 校验", async () => {
			const bad: IdpEnv = {
				...env,
				OIDC_CLIENTS_JSON: [
					{ ...CLIENT_A, redirectUris: ["https://sso.example.com/cb#frag"] },
				],
			};
			const err = await createOidcProvider(deps, bad).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			const printed = inspect(err);
			expect(printed).toContain("redirect_uris");
			expect(printed).not.toContain(CLIENT_A.secret.slice(0, 10));
		});

		// 上游开始区分这两种时这条先红
		it("token 端点：basic 与 post 两种出示方式都认", async () => {
			for (const client of [CLIENT_A, CLIENT_B]) {
				for (const method of ["post", "basic"] as const) {
					const res = await exchange({
						clientId: client.id,
						secret: client.secret,
						method,
					});
					expect(res.json()).toMatchObject({ error: "invalid_grant" });
				}
			}
		});
	});

	it("JWKS 端点只暴露公钥，绝不能泄露私钥参数", async () => {
		const res = await app.inject({ method: "GET", url: "/oidc/jwks" });
		expect(res.statusCode).toBe(200);
		const jwks = res.json() as { keys: Record<string, unknown>[] };
		expect(jwks.keys.length).toBeGreaterThan(0);
		for (const key of jwks.keys) {
			expect(key.d).toBeUndefined();
			expect(key.p).toBeUndefined();
			expect(key.q).toBeUndefined();
		}
	});

	it("Koa 的 error 事件由我们接管：不装默认处理器、不走 console.error", async () => {
		const p = await createOidcProvider(deps, env);
		const emitter = p as unknown as EventEmitter;
		p.callback();
		expect(emitter.listeners("error")).toHaveLength(1);
		expect(emitter.listeners("error")).not.toContain(p.onerror);

		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			emitter.emit("error", new Error("itest"), undefined);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("伪造的 interaction uid 返回 400 错误页", async () => {
		// 同时钉住 mount.ts 的豁免：失效的话是 provider 的 404
		const res = await app.inject({
			method: "GET",
			url: "/oidc/interaction/fake-uid",
		});
		expect(res.statusCode).toBe(400);
	});

	it("伪造的回调被拒并进审计：actor 为空，不带授权码", async () => {
		const UA = "itest-interaction-callback";
		const CODE = "itest-dingtalk-code";
		try {
			const res = await app.inject({
				method: "GET",
				url: `/oidc/interaction/fake-uid/callback?code=${CODE}&state=fake-uid`,
				headers: { host: HOST, "user-agent": UA },
			});
			expect(res.statusCode).toBe(400);

			const rows = await deps.db
				.select()
				.from(auditLogs)
				.where(eq(auditLogs.userAgent, UA));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				action: AUDIT_ACTIONS.authReject,
				status: "failure",
				actorType: "dingtalk",
				actorId: null,
				path: "/oidc/interaction/fake-uid/callback",
			});
			expect(JSON.stringify(rows[0])).not.toContain(CODE);
		} finally {
			await deps.db.delete(auditLogs).where(eq(auditLogs.userAgent, UA));
		}
	});

	it("未知路径返回 404 且不是被 provider 吞掉的那种", async () => {
		const res = await app.inject({ method: "GET", url: "/not-a-route" });
		expect(res.statusCode).toBe(404);
	});

	describe("REST 面（凭证透传 + 按 appKey 隔离）", () => {
		const APP_A = "itest-rest-app-a";
		const APP_B = "itest-rest-app-b";
		// 只用于「钉钉拒绝」：它的限流冷却不能波及别的用例
		const APP_REJECTED = "itest-rest-rejected";
		const REJECTED_SECRET = "itest-rest-wrong-secret";
		// 鉴权能过、拉取时钉钉报错 / 内部出错
		const APP_IP_BLOCKED = "itest-rest-ip-blocked";
		const APP_INTERNAL = "itest-rest-internal";

		const basic = (appKey: string, secret: string) =>
			`Basic ${Buffer.from(`${appKey}:${secret}`).toString("base64")}`;

		// 审计行按 UA 清理：没带凭证的请求 actor_id 为空，按 appKey 清不掉
		const UA = "itest-rest";

		async function cleanup() {
			const keys = [APP_A, APP_B, APP_REJECTED, APP_IP_BLOCKED, APP_INTERNAL];
			await deps.db
				.delete(orgSnapshots)
				.where(inArray(orgSnapshots.appKey, keys));
			await deps.db
				.delete(appSecrets)
				.where(like(appSecrets.key, `${accessTokenKey("itest-rest-")}%`));
			await deps.db.delete(auditLogs).where(eq(auditLogs.userAgent, UA));
		}

		beforeAll(cleanup);
		afterAll(cleanup);

		it.each([
			["没带凭证", undefined],
			["不是 Basic", "Bearer whatever"],
			["钉钉拒绝的凭证", basic(APP_REJECTED, REJECTED_SECRET)],
		])("%s → 同一个不说原因的 401", async (_, authorization) => {
			const res = await app.inject({
				method: "GET",
				url: "/api/v1/org/users",
				headers: {
					host: HOST,
					"user-agent": UA,
					...(authorization ? { authorization } : {}),
				},
			});

			expect(res.statusCode).toBe(401);
			expect(res.json()).toEqual({
				error: { code: "unauthorized", message: "无效的凭证" },
			});
			expect(res.headers["www-authenticate"]).toContain("Basic");
		});

		it("鉴权失败也进审计：记来件声称的 appKey，secret 一个字节都不进", async () => {
			await app.inject({
				method: "GET",
				url: "/api/v1/org/departments",
				headers: {
					host: HOST,
					"user-agent": UA,
					authorization: basic(APP_REJECTED, REJECTED_SECRET),
				},
			});

			const rows = await deps.db
				.select()
				.from(auditLogs)
				.where(inArray(auditLogs.actorId, [APP_REJECTED]));

			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.status === "failure")).toBe(true);
			expect(JSON.stringify(rows)).not.toContain(REJECTED_SECRET);
		});

		it("超长 appKey → 401，审计照样记一条（actor 为空）", async () => {
			const res = await app.inject({
				method: "GET",
				url: "/api/v1/sync",
				headers: {
					host: HOST,
					"user-agent": UA,
					authorization: basic("k".repeat(300), "whatever"),
				},
			});
			expect(res.statusCode).toBe(401);

			const rows = await deps.db
				.select()
				.from(auditLogs)
				.where(eq(auditLogs.userAgent, UA));
			expect(
				rows.filter((r) => r.action === AUDIT_ACTIONS.syncStatus),
			).toMatchObject([{ status: "failure", actorId: null }]);
		});

		it("两个应用各读到自己那份快照，响应带 fetchedAt", async () => {
			for (const appKey of [APP_A, APP_B]) {
				const res = await app.inject({
					method: "GET",
					url: "/api/v1/org/users",
					headers: {
						host: HOST,
						"user-agent": UA,
						authorization: basic(appKey, "good"),
					},
				});

				expect(res.statusCode).toBe(200);
				const body = res.json() as {
					users: Array<{ dingtalk: { unionid: string } }>;
					fetchedAt: string;
				};
				expect(body.users.map((u) => u.dingtalk.unionid)).toEqual([
					`union-tok-${appKey}`,
				]);
				expect(Number.isNaN(Date.parse(body.fetchedAt))).toBe(false);
			}
		});

		// 下面两条是 guard 错误翻译仅有的哨兵
		it("钉钉报错 → 502 且带 errcode", async () => {
			const res = await app.inject({
				method: "GET",
				url: "/api/v1/org/users",
				headers: {
					host: HOST,
					"user-agent": UA,
					authorization: basic(APP_IP_BLOCKED, "good"),
				},
			});

			expect(res.statusCode).toBe(502);
			expect(res.json()).toMatchObject({
				error: { code: "dingtalk_error", dingtalk: { errcode: 60020 } },
			});
		});

		it("刚失败过、又从没成功过 → 503 + Retry-After，带上次的原因，不再外呼", async () => {
			const calls = vi.mocked(fetchOrg).mock.calls.length;
			const res = await app.inject({
				method: "GET",
				url: "/api/v1/org/users",
				headers: {
					host: HOST,
					"user-agent": UA,
					authorization: basic(APP_IP_BLOCKED, "good"),
				},
			});

			expect(res.statusCode).toBe(503);
			expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
			expect(res.json()).toMatchObject({
				error: { code: "snapshot_unavailable" },
			});
			expect(res.body).toContain("60020");
			expect(vi.mocked(fetchOrg).mock.calls.length).toBe(calls);
		});

		it("非钉钉的错 → 500 不回显 message，失败照样进审计", async () => {
			const res = await app.inject({
				method: "POST",
				url: "/api/v1/sync",
				headers: {
					host: HOST,
					"user-agent": UA,
					authorization: basic(APP_INTERNAL, "good"),
				},
			});

			expect(res.statusCode).toBe(500);
			expect(res.json()).toEqual({
				error: { code: "internal_error", message: "Internal Server Error" },
			});
			expect(res.body).not.toContain("secret_table");

			// 审计在 onResponse 里写，响应到手时未必已落库
			await vi.waitFor(async () => {
				const rows = await deps.db
					.select()
					.from(auditLogs)
					.where(eq(auditLogs.actorId, APP_INTERNAL));
				expect(rows).toMatchObject([
					{ status: "failure", details: { summary: "刷新组织快照失败" } },
				]);
			});
		});

		// 状态端点读的是 org_snapshots.error，一个容易被忘掉的出口
		it("状态端点：钉钉的错讲原因，内部错误不回显原文", async () => {
			const status = async (appKey: string) =>
				app.inject({
					method: "GET",
					url: "/api/v1/sync",
					headers: {
						host: HOST,
						"user-agent": UA,
						authorization: basic(appKey, "good"),
					},
				});

			const internal = await status(APP_INTERNAL);
			expect(internal.json()).toMatchObject({
				state: "never",
				error: "内部错误",
			});
			expect(internal.body).not.toContain("secret_table");

			expect((await status(APP_IP_BLOCKED)).json()).toMatchObject({
				error: "ip 不在白名单（60020）",
			});
		});

		it("GET /api/v1/sync 只报调用方自己那份的状态", async () => {
			const res = await app.inject({
				method: "GET",
				url: "/api/v1/sync",
				headers: {
					host: HOST,
					"user-agent": UA,
					authorization: basic(APP_B, "good"),
				},
			});

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				appKey: APP_B,
				state: "ok",
				userCount: 1,
			});
		});
	});
});
