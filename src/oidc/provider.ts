import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import Provider, { interactionPolicy } from "oidc-provider";

import type { Deps } from "../deps";
import { pickAuthEntries } from "../domain/config-json";
import {
	CLIENT_GRANT_TYPES,
	CLIENT_RESPONSE_TYPES,
	CLIENT_SCOPE,
	CLIENT_TOKEN_AUTH_METHOD,
	compileRedirectUriRegexes,
	matchesRedirectUriRegex,
} from "../domain/oidc-client";
import { type IdpEnv, ownOrgSource, trustsProxyHeaders } from "../env";
import { logFor } from "../log";
import { makeFindAccount } from "./account";
import { createAdapterFactory } from "./adapter";
import { ensureOidcKeys } from "./keys";
import { oidcIssuer } from "./mount";

const DAY = 24 * 60 * 60;

/**
 * 会话还在、`findAccount` 却不放行（离职、钉钉实时说不是员工）时回到扫码，由回调给 403。
 * ⚠️ 别删：上游的 `no_session` 只看 `session.accountId`，没有这条就一路走到 consent 检查去读
 * 没加载的 grant，抛 500。哨兵是 `app.integration.test.ts` 复用会话的那几条。
 *
 * ⚠️ `login_required` 别省：`checks.add` 加进来的拿不到 prompt 的默认 error，`prompt=none`
 * 时会回 `interaction_required`。
 */
function interactionPolicyWithAdmission() {
	const policy = interactionPolicy.base();
	const login = policy.get("login");
	if (!login) {
		throw new Error("oidc-provider 的默认 policy 里没有 login prompt");
	}
	login.checks.add(
		new interactionPolicy.Check(
			"not_admitted",
			"End-User is no longer admitted",
			"login_required",
			(ctx) => Boolean(ctx.oidc.session?.accountId) && !ctx.oidc.account,
		),
	);
	return policy;
}

export async function createOidcProvider(
	deps: Deps,
	env: IdpEnv,
): Promise<Provider> {
	const keys = await ensureOidcKeys(deps.db);
	const clients = pickAuthEntries(env.AUTH_JSON, "oidc");

	const provider = new Provider(oidcIssuer(env), {
		adapter: createAdapterFactory(deps.db),
		findAccount: makeFindAccount({
			db: deps.db,
			...ownOrgSource(env),
		}),
		// jose 的 JWK 与 oidc-provider 的声明结构等价
		jwks: { keys: keys.jwks as unknown as Record<string, unknown>[] },
		cookies: { keys: keys.cookieKeys },

		// 静态 client：`Client.find` 先查它，adapter 的 Client 分支恒返回 undefined
		clients: clients.map((c) => ({
			client_id: c.id,
			client_secret: c.secret,
			redirect_uris: c.redirectUris,
			grant_types: CLIENT_GRANT_TYPES,
			response_types: CLIENT_RESPONSE_TYPES,
			scope: CLIENT_SCOPE,
			token_endpoint_auth_method: CLIENT_TOKEN_AUTH_METHOD,
		})),

		// 与 `CLIENT_SCOPE` 改一边要改另一边。刻意没有 `roles`：那是下游的事
		claims: {
			openid: ["sub"],
			profile: ["name", "preferred_username", "picture"],
			email: ["email", "email_verified"],
		},

		// ⚠️ 默认 true 会让 id_token 里只有 `sub`，只读 id_token 的下游看不到任何 claim
		conformIdTokenClaims: false,

		features: {
			// ⚠️ 默认开，接受任意假账号登录
			devInteractions: { enabled: false },
			revocation: { enabled: true },
		},

		interactions: {
			policy: interactionPolicyWithAdmission(),
			// 浏览器可见路径：interaction cookie 按它做 path 作用域
			url: (_ctx, interaction) => `/oidc/interaction/${interaction.uid}`,
		},

		pkce: { required: () => true },

		// 等于上游默认，写出来只为压掉 `shouldChange` 启动告警
		ttl: {
			Session: 14 * DAY,
			Grant: 14 * DAY,
			Interaction: 3600,
			AuthorizationCode: 60,
			AccessToken: 3600,
			IdToken: 3600,
		},
	});

	// 反代之后要信任 `x-forwarded-proto`，判据见 `trustsProxyHeaders`
	provider.proxy = trustsProxyHeaders(env);

	// ⚠️ 端点的 500 上游只发这个事件、自己不记
	provider.on("server_error", (ctx, err) => {
		logFor(ctx).error({ err, path: ctx.path }, "OIDC 端点内部错误");
	});

	// ⚠️ 逃出上游错误处理的异常走 Koa 的 error 事件：没人监听时 Koa 用 console.error 打 stack，
	// 绕过脱敏。必须在 mountOidc 调 callback() 之前挂上（Provider 的类型重载遮住了这个事件）
	(provider as EventEmitter).on(
		"error",
		(
			err: Error & { status?: number; expose?: boolean },
			ctx?: { req?: IncomingMessage; path?: string },
		) => {
			if (err.status === 404 || err.expose) return;
			logFor(ctx).error({ err, path: ctx?.path }, "OIDC 未处理的错误");
		},
	);

	// 正则回调：上游只做精确匹配、没有配置项，只能覆写原型（`provider.Client` 是本实例独有的
	// 子类）。授权端点、PAR 与报错重定向都经它判定；token 端点另比「与授权时是同一个地址」
	const regexes = new Map(
		clients.map((c) => [
			c.id,
			compileRedirectUriRegexes(c.redirectUriRegexes ?? []),
		]),
	);
	const exactAllowed = provider.Client.prototype.redirectUriAllowed;
	provider.Client.prototype.redirectUriAllowed = function (value) {
		return (
			exactAllowed.call(this, value) ||
			matchesRedirectUriRegex(regexes.get(this.clientId) ?? [], value)
		);
	};

	// ⚠️ 静态 client 要到第一次 `Client.find` 才过上游的 metadata 校验：启动时逐个 find，
	// 配错就是启动失败，而不是那个下游所有人登录失败
	await Promise.all(clients.map((c) => provider.Client.find(c.id)));

	return provider;
}
