import type { Account, FindAccount } from "oidc-provider";
import type { Database } from "~/db";
import { findMember } from "~/sync/snapshot";

/**
 * `sub` = 钉钉 unionId（userid 离职重入职会变）。
 *
 * ⚠️ 准入只有一条判据——在自有应用（`ownAppKey`）的快照里，且必须与 interaction 回调
 * 那道一致：这里拒、回调放行，就是「扫码成功 → 又要扫码」的死循环。别加 per-client 判断，
 * 谁能用哪个下游是下游自己的事。
 */
export function makeFindAccount(db: Database, ownAppKey: string): FindAccount {
	return async (_ctx, sub): Promise<Account | undefined> => {
		const u = await findMember(db, ownAppKey, sub);
		if (!u) return undefined;

		return {
			accountId: sub,
			// 集合固定、不随 client 变；provider 按已授予的 scope 自己裁剪
			claims: async () => ({
				sub,
				name: u.displayName,
				preferred_username: u.userName,
				// 没有企业邮箱的人两个都不发：发 null 可能被下游当成「有这个键」
				...(u.email ? { email: u.email, email_verified: true } : {}),
				...(u.dingtalk.avatar ? { picture: u.dingtalk.avatar } : {}),
			}),
		};
	};
}
