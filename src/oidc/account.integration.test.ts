import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "~/db";
import { orgSnapshots } from "~/db/schema";
import type { OrgApiUser } from "~/domain/org-api";

import { makeFindAccount } from "./account";

/**
 * 准入回归：判据只有「在自有应用的快照里」，claim 集合固定且不含 roles。判错是静默的，
 * 而这里是离职唯一起作用的地方。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

const OWN_APP = "itest-account-own-app";
const OTHER_APP = "itest-account-other-app";

const MEMBER_UNIONID = "itest-account-member";
/** 自有快照里一个没有企业邮箱的人 */
const NO_EMAIL_UNIONID = "itest-account-no-email";
const OUTSIDER_UNIONID = "itest-account-outsider";

function user(
	unionid: string,
	userName: string,
	opts: { avatar?: string; email?: string | null } = {},
): OrgApiUser {
	return {
		userName,
		displayName: `${userName}(测试)`,
		email: opts.email === undefined ? `${userName}@example.com` : opts.email,
		depts: [],
		titles: [],
		ranks: [],
		jobLevel: null,
		dingtalk: {
			userid: `userid-${userName}`,
			unionid,
			title: null,
			extension: null,
			avatar: opts.avatar ?? null,
			orgEmail: null,
		},
	};
}

maybe("findAccount 准入 (需要 DATABASE_URL)", () => {
	const db = createDb(url ?? "", { maxConnections: 2 });
	const findAccount = makeFindAccount(db, OWN_APP);

	// biome-ignore lint/suspicious/noExplicitAny: oidc-provider 的 KoaContextWithOIDC 造不出来，且本实现不读它
	const ctx = {} as any;

	async function cleanup() {
		await db
			.delete(orgSnapshots)
			.where(inArray(orgSnapshots.appKey, [OWN_APP, OTHER_APP]));
	}

	beforeEach(async () => {
		await cleanup();
		const now = new Date();
		await db.insert(orgSnapshots).values([
			{
				appKey: OWN_APP,
				data: {
					departments: [],
					users: [
						user(MEMBER_UNIONID, "itest.account.member", {
							avatar: "https://example.com/a.png",
						}),
						user(NO_EMAIL_UNIONID, "itest.account.noemail", { email: null }),
					],
				},
				fetchedAt: now,
				attemptedAt: now,
			},
			{
				// 别的钉钉应用的快照：可见范围更宽，里面有一个本组织之外的人
				appKey: OTHER_APP,
				data: {
					departments: [],
					users: [
						user(MEMBER_UNIONID, "itest.account.member"),
						user(OUTSIDER_UNIONID, "itest.account.outsider"),
					],
				},
				fetchedAt: now,
				attemptedAt: now,
			},
		]);
	});

	afterAll(async () => {
		await cleanup();
		await db.$client.end();
	});

	it("自有快照里的人放行，claim 取自快照", async () => {
		const account = await findAccount(ctx, MEMBER_UNIONID);
		expect(account).toBeDefined();

		const claims = await account?.claims(
			"id_token",
			"openid profile email",
			{},
			[],
		);
		expect(claims).toMatchObject({
			sub: MEMBER_UNIONID,
			name: "itest.account.member(测试)",
			preferred_username: "itest.account.member",
			email: "itest.account.member@example.com",
			email_verified: true,
			picture: "https://example.com/a.png",
		});
	});

	it("没有企业邮箱的人不发 email 与 email_verified，其余 claim 照发", async () => {
		const account = await findAccount(ctx, NO_EMAIL_UNIONID);
		const claims = await account?.claims(
			"id_token",
			"openid profile email",
			{},
			[],
		);
		expect(claims).toMatchObject({
			sub: NO_EMAIL_UNIONID,
			preferred_username: "itest.account.noemail",
		});
		expect(claims).not.toHaveProperty("email");
		expect(claims).not.toHaveProperty("email_verified");
	});

	it("绝不发 roles claim", async () => {
		const account = await findAccount(ctx, MEMBER_UNIONID);
		const claims = await account?.claims(
			"id_token",
			"openid profile email roles",
			{},
			[],
		);
		expect(claims).not.toHaveProperty("roles");
	});

	it("不在自有快照里的 unionId 拒绝 —— 既有会话也不再放行", async () => {
		await expect(
			findAccount(ctx, "itest-account-not-a-member"),
		).resolves.toBeUndefined();
	});

	// ⚠️ 按 appKey 隔离的最后一道防线，不能删
	it("只出现在别的应用快照里的人拒绝", async () => {
		await expect(findAccount(ctx, OUTSIDER_UNIONID)).resolves.toBeUndefined();
	});
});
