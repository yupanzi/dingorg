import type { EventEmitter } from "node:events";
import { inspect } from "node:util";

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newApiKey } from "~/auth/new-api-key";
import { appSecrets, auditLogs } from "~/db/schema";
import { invalidateAccessToken } from "~/dingtalk/access-token";
import {
	type DingtalkCredentials,
	DingtalkError,
	fetchAccessToken,
} from "~/dingtalk/client";
import { fetchOrg } from "~/dingtalk/fetch-org";
import { apiKeyEntryId } from "~/domain/api-key";
import { CLIENT_SCOPE } from "~/domain/oidc-client";
import { SYNC_TRIGGER_SUMMARY } from "~/domain/sync";
import { type IdpEnv, parseEnv } from "~/env";
import { createOidcProvider } from "~/oidc/provider";
import { AUDIT_ACTIONS, accessTokenKey } from "~/resources";
import { ageOrgSync, holdLease, resetOrgSync } from "~/sync/testing";

import { buildApp } from "./app";
import { closeDeps, createDeps, type Deps } from "./deps";
import { idpEnvSchema } from "./env";

/**
 * 路由契约：OIDC 挂载不吞路由、静态 client、REST 面鉴权与错误翻译。
 *
 * mock 两个钉钉出口，成败由 `tokenError` / `orgFailure` 控制；`fetchOrg` 按 token 返回
 * 可区分的组织。⚠️ 别往 buildApp 里加启动即外呼的逻辑：这里会拿假凭证去真打钉钉。
 */
let tokenError: Error | null = null;
let orgFailure: "ip-blocked" | "internal" | null = null;
vi.mock("~/dingtalk/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("~/dingtalk/client")>()),
	fetchAccessToken: vi.fn(async (cred: DingtalkCredentials) => {
		if (tokenError) throw tokenError;
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
			if (orgFailure === "ip-blocked") {
				throw new DingtalkError("ip 不在白名单", { errcode: 60020 });
			}
			if (orgFailure === "internal") {
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

function generateKey(name: string) {
	const r = newApiKey(name);
	if (!r.success) throw new Error("生成 API key 失败");
	return { key: r.data.key, id: apiKeyEntryId(r.data), entry: r.data };
}

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("IdP 路由契约 (需要 DATABASE_URL)", () => {
	let env: IdpEnv;
	let deps: Deps;
	let app: FastifyInstance;

	// HOST 必须与 PUBLIC_ORIGIN 一致：discovery 的端点 URL 由请求 Host 头派生
	const HOST = "localhost:13001";
	const ISSUER = `http://${HOST}/oidc`;
	const DINGTALK_APP_KEY = "itest-appkey";
	const CLIENT_A = {
		type: "oidc",
		name: "itest-authentik-prod",
		id: "6f1c2a0e-9b7d-4c1e-8f3a-2d5e7b9c0a14",
		secret: "itest-client-a-secret-0123456789abcdef",
		redirectUris: ["https://sso.example.com/source/oauth/callback/dingorg/"],
	} as const;
	const CLIENT_B = {
		type: "oidc",
		name: "itest-authentik-staging",
		id: "0d8682fc-11a1-4324-bdd0-edc189c26d7d",
		secret: "itest-client-b-secret-0123456789abcdef",
		redirectUris: [
			"https://sso-stg.example.com/source/oauth/callback/dingorg/",
		],
		redirectUriRegexes: ["https://pr-\\d+\\.preview\\.example\\.com/callback"],
	} as const;
	// REST 面的调用方：与 client 无关的两把 API key
	const KEY_HR = generateKey("itest-hr-system");
	const KEY_BI = generateKey("itest-bi");

	beforeAll(async () => {
		env = parseEnv(idpEnvSchema, {
			DATABASE_URL: url,
			DINGTALK_APP_KEY,
			DINGTALK_APP_SECRET: "x",
			PUBLIC_ORIGIN: `http://${HOST}`,
			AUTH_JSON: JSON.stringify([
				CLIENT_A,
				CLIENT_B,
				KEY_HR.entry,
				KEY_BI.entry,
			]),
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

	describe("静态 client（AUTH_JSON 的 oidc 项）", () => {
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

		it("未登记、也没命中正则的地址拿不到授权码", async () => {
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

		// 覆写的是 `Client.prototype.redirectUriAllowed`：上游改了判定入口这条先红
		it("正则回调：整串命中才放行，且只对登记它的 client 有效", async () => {
			const PREVIEW = "https://pr-42.preview.example.com/callback";
			const ok = await authorize({
				client_id: CLIENT_B.id,
				redirect_uri: PREVIEW,
			});
			expect(ok.statusCode).toBe(303);
			expect(ok.headers.location).toContain("/oidc/interaction/");

			for (const [client_id, redirect_uri] of [
				[CLIENT_B.id, "https://pr-42.preview.example.com.evil.io/callback"],
				[CLIENT_B.id, `${PREVIEW}/../../evil`],
				[CLIENT_B.id, PREVIEW.replace("https:", "http:")],
				[CLIENT_A.id, PREVIEW],
			] as const) {
				const res = await authorize({ client_id, redirect_uri });
				expect(res.statusCode).toBe(400);
				expect(res.body).toContain("redirect_uri");
			}
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
				AUTH_JSON: [
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

	describe("REST 面（API key + 自有应用的组织同步）", () => {
		const basic = (id: string, secret: string) =>
			`Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
		const bearer = (key: string) => `Bearer ${key}`;
		const AS_REST = bearer(KEY_HR.key);
		// id 对、secret 错：末位换一个字符
		const WRONG_KEY = `${KEY_HR.key.slice(0, -1)}${KEY_HR.key.endsWith("A") ? "B" : "A"}`;

		// 审计行按 UA 清理：没带凭证的请求 actor_id 为空，按 key 清不掉
		const UA = "itest-rest";

		const call = (
			method: "GET" | "POST",
			url: string,
			authorization?: string,
		) =>
			app.inject({
				method,
				url,
				headers: {
					host: HOST,
					"user-agent": UA,
					...(authorization ? { authorization } : {}),
				},
			});

		// 回到「从没同步过」：清空组织同步（冷却、租约跟着清掉）与 token 的两级缓存
		async function resetOwnSync() {
			tokenError = null;
			orgFailure = null;
			await resetOrgSync(deps.db);
			await deps.db
				.delete(appSecrets)
				.where(eq(appSecrets.key, accessTokenKey(DINGTALK_APP_KEY)));
			// 不匹配的 badToken：条件删除不命中，只清进程内
			await invalidateAccessToken(deps.db, DINGTALK_APP_KEY, "itest-clear");
		}

		async function cleanup() {
			await resetOwnSync();
			await deps.db.delete(auditLogs).where(eq(auditLogs.userAgent, UA));
		}

		beforeAll(cleanup);
		afterAll(cleanup);

		it.each([
			["没带凭证", undefined],
			["key 错（id 对）", bearer(WRONG_KEY)],
			["未知 id", bearer(KEY_HR.key.replace(KEY_HR.id, "00000000"))],
			["key 放在 Basic 里", basic(KEY_HR.id, KEY_HR.key)],
			["OIDC client 凭证", basic(CLIENT_A.id, CLIENT_A.secret)],
			["钉钉 AppKey/Secret", basic(DINGTALK_APP_KEY, "x")],
		])("%s → 同一个不说原因的 401，且不外呼", async (_, authorization) => {
			const calls = vi.mocked(fetchAccessToken).mock.calls.length;
			const res = await call("GET", "/api/v1/org/users", authorization);

			expect(res.statusCode).toBe(401);
			expect(res.json()).toEqual({
				error: { code: "unauthorized", message: "无效的凭证" },
			});
			expect(res.headers["www-authenticate"]).toContain("Bearer");
			expect(vi.mocked(fetchAccessToken).mock.calls.length).toBe(calls);
		});

		it("鉴权失败也进审计：记来件声称的 key id，key 一个字节都不进", async () => {
			await call("GET", "/api/v1/org/departments", bearer(WRONG_KEY));

			const rows = await vi.waitFor(async () => {
				const rows = await deps.db
					.select()
					.from(auditLogs)
					.where(
						and(eq(auditLogs.actorId, KEY_HR.id), eq(auditLogs.userAgent, UA)),
					);
				expect(rows.length).toBeGreaterThan(0);
				return rows;
			});
			expect(
				rows.every((r) => r.status === "failure" && r.actorType === "api_key"),
			).toBe(true);
			expect(JSON.stringify(rows)).not.toContain(WRONG_KEY.slice(13));
		});

		it("格式不对的 Bearer → 401，审计照样记一条（actor 为空）", async () => {
			const res = await call("GET", "/api/v1/sync", bearer("k".repeat(300)));
			expect(res.statusCode).toBe(401);

			await vi.waitFor(async () => {
				const rows = await deps.db
					.select()
					.from(auditLogs)
					.where(eq(auditLogs.userAgent, UA));
				expect(
					rows.filter((r) => r.action === AUDIT_ACTIONS.syncStatus),
				).toMatchObject([{ status: "failure", actorId: null }]);
			});
		});

		it("每把 key 都读到自有应用的组织数据，响应带 fetchedAt，审计记 key 的 id 与 name", async () => {
			await resetOwnSync();
			for (const { key } of [KEY_HR, KEY_BI]) {
				const res = await call("GET", "/api/v1/org/users", bearer(key));

				expect(res.statusCode).toBe(200);
				const body = res.json() as {
					users: Array<{ dingtalk: { unionid: string } }>;
					fetchedAt: string;
				};
				expect(body.users.map((u) => u.dingtalk.unionid)).toEqual([
					`union-tok-${DINGTALK_APP_KEY}`,
				]);
				expect(Number.isNaN(Date.parse(body.fetchedAt))).toBe(false);
			}
			expect(vi.mocked(fetchOrg)).toHaveBeenLastCalledWith(
				`tok-${DINGTALK_APP_KEY}`,
			);

			// 审计在 onResponse 里写，响应到手时未必已落库
			await vi.waitFor(async () => {
				const rows = await deps.db
					.select()
					.from(auditLogs)
					.where(eq(auditLogs.actorId, KEY_HR.id));
				expect(rows).toContainEqual(
					expect.objectContaining({
						action: AUDIT_ACTIONS.orgListUsers,
						status: "success",
						actorType: "api_key",
						actorName: KEY_HR.entry.name,
					}),
				);
			});
		});

		it("GET /api/v1/sync 报自有应用的同步状态，不暴露钉钉 AppKey", async () => {
			const res = await call("GET", "/api/v1/sync", AS_REST);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				state: "ok",
				syncing: false,
				userCount: 1,
			});
			expect(res.json()).not.toHaveProperty("appKey");
			expect(res.body).not.toContain(DINGTALK_APP_KEY);
		});

		// 下面两条是 guard 错误翻译仅有的哨兵
		it("钉钉报错 → 502 且带 errcode；状态端点讲原因", async () => {
			await resetOwnSync();
			orgFailure = "ip-blocked";
			const res = await call("GET", "/api/v1/org/users", AS_REST);

			expect(res.statusCode).toBe(502);
			expect(res.json()).toMatchObject({
				error: { code: "dingtalk_error", dingtalk: { errcode: 60020 } },
			});
			expect((await call("GET", "/api/v1/sync", AS_REST)).json()).toMatchObject(
				{ state: "never", error: "ip 不在白名单（60020）" },
			);
		});

		it("刚失败过、又从没成功过 → 503 + Retry-After，带上次的原因，不再外呼", async () => {
			const calls = vi.mocked(fetchOrg).mock.calls.length;
			const res = await call("GET", "/api/v1/org/users", AS_REST);

			expect(res.statusCode).toBe(503);
			expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
			expect(res.json()).toMatchObject({
				error: { code: "not_synced" },
			});
			expect(res.body).toContain("60020");
			expect(vi.mocked(fetchOrg).mock.calls.length).toBe(calls);
		});

		// 自有凭证在服务端：它的 token 失败是服务端的故障，不是调用方的 401
		it("钉钉 token 申请失败 → 502 而不是 401，原因进状态端点", async () => {
			await resetOwnSync();
			tokenError = new DingtalkError("应用凭证无效", { errcode: 40089 });
			const res = await call("POST", "/api/v1/sync", AS_REST);

			expect(res.statusCode).toBe(502);
			expect(res.json()).toMatchObject({
				error: { code: "dingtalk_error", dingtalk: { errcode: 40089 } },
			});
			expect((await call("GET", "/api/v1/sync", AS_REST)).json()).toMatchObject(
				{ state: "never", error: "应用凭证无效（40089）" },
			);
		});

		it("非钉钉的错 → 500 不回显 message，失败照样进审计；状态端点也不回显", async () => {
			await resetOwnSync();
			orgFailure = "internal";
			const res = await call("POST", "/api/v1/sync", AS_REST);

			expect(res.statusCode).toBe(500);
			expect(res.json()).toEqual({
				error: { code: "internal_error", message: "Internal Server Error" },
			});
			expect(res.body).not.toContain("secret_table");

			await vi.waitFor(async () => {
				const rows = await deps.db
					.select()
					.from(auditLogs)
					.where(
						and(
							eq(auditLogs.actorId, KEY_HR.id),
							eq(auditLogs.action, AUDIT_ACTIONS.syncTrigger),
						),
					);
				expect(rows).toContainEqual(
					expect.objectContaining({
						status: "failure",
						targetId: DINGTALK_APP_KEY,
						details: { summary: SYNC_TRIGGER_SUMMARY.failed },
					}),
				);
			});

			const status = await call("GET", "/api/v1/sync", AS_REST);
			expect(status.json()).toMatchObject({
				state: "never",
				error: "内部错误",
			});
			expect(status.body).not.toContain("secret_table");
		});

		// 跨副本的租约：别处在拉时这里不外呼
		it("别处正在同步、又从没同步过 → 503 + Retry-After，不外呼", async () => {
			await resetOwnSync();
			await holdLease(deps.db, DINGTALK_APP_KEY, 60_000);
			const calls = vi.mocked(fetchOrg).mock.calls.length;

			const res = await call("GET", "/api/v1/org/users", AS_REST);

			expect(res.statusCode).toBe(503);
			expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
			expect(res.json()).toMatchObject({ error: { code: "not_synced" } });
			expect(vi.mocked(fetchOrg).mock.calls.length).toBe(calls);
			expect((await call("GET", "/api/v1/sync", AS_REST)).json()).toMatchObject(
				{ state: "never", syncing: true },
			);
		});

		it("有数据时撞上别处正在同步：POST 立即返回 refreshed:false、syncing:true", async () => {
			await resetOwnSync();
			expect((await call("POST", "/api/v1/sync", AS_REST)).statusCode).toBe(
				200,
			);
			// 冷却过了、租约在别人手里
			await ageOrgSync(deps.db, 2 * 60_000);
			await holdLease(deps.db, DINGTALK_APP_KEY, 60_000);
			const calls = vi.mocked(fetchOrg).mock.calls.length;

			const res = await call("POST", "/api/v1/sync", AS_REST);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				refreshed: false,
				syncing: true,
				state: "ok",
			});
			expect(vi.mocked(fetchOrg).mock.calls.length).toBe(calls);
			await resetOwnSync();
		});
	});
});
