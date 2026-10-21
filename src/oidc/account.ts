import type { Account, FindAccount } from "oidc-provider";
import { type AdmissionDeps, admit } from "~/admission";
import { logFor } from "~/log";

/**
 * `sub` = 钉钉 unionId（userid 离职重入职会变）。准入与扫码回调是同一个 `admit`。
 *
 * ⚠️ 实时校验只在 `token` 为空时做：那是授权端点在复用 oidc-provider 自己的会话（14 天），
 * 不经扫码回调，离职的人只能在这里拦。token 端点与 userinfo 带着 token 来，只看同步结果。
 * 升级 oidc-provider 时的哨兵是 `app.integration.test.ts` 数实时校验次数的那条。
 * 别加 per-client 判断，谁能用哪个下游是下游自己的事。
 */
export function makeFindAccount(deps: Omit<AdmissionDeps, "log">): FindAccount {
	return async (ctx, sub, token): Promise<Account | undefined> => {
		const r = await admit(
			{ ...deps, log: logFor(ctx) },
			sub,
			token === undefined ? "realtime" : "mirror",
		);
		if (!r.admitted) return undefined;
		const u = r.member;

		return {
			accountId: sub,
			// 集合固定、不随 client 变；provider 按已授予的 scope 自己裁剪
			claims: async () => ({
				sub,
				name: u.displayName,
				preferred_username: u.userName,
				// 没有 email 的人两个都不发：发 null 可能被下游当成「有这个键」
				...(u.email ? { email: u.email, email_verified: true } : {}),
				...(u.avatar ? { picture: u.avatar } : {}),
			}),
		};
	};
}
