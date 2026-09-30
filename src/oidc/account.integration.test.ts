import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "~/db";
import { orgSync } from "~/db/schema";
import type { MemberFields } from "~/domain/org-sync";
import { fetchedOrg, resetOrgSync, seedOrgSync } from "~/sync/testing";

import { makeFindAccount } from "./account";

/**
 * 准入回归：判据只有「是自有应用同步结果里的当前成员」，claim 集合固定且不含 roles。判错是
 * 静默的，而这里是离职唯一起作用的地方。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

const OWN_APP = "itest-account-own-app";
const OTHER_APP = "itest-account-other-app";

const MEMBER_UNIONID = "itest-account-member";
/** 自有同步结果里一个没有企业邮箱的人 */
const NO_EMAIL_UNIONID = "itest-account-no-email";
const OUTSIDER_UNIONID = "itest-account-outsider";

/** 有企业邮箱时 userName 取它的 local part，没有时取显示名括号前的部分 */
function user(
	unionid: string,
	userName: string,
	opts: { avatar?: string; email?: string | null; userid?: string } = {},
): MemberFields {
	const email =
		opts.email === undefined ? `${userName}@example.com` : opts.email;
	return {
		userid: opts.userid ?? `userid-${userName}`,
		unionid,
		name: `${userName}(测试)`,
		...(email ? { org_email: email } : {}),
		...(opts.avatar ? { avatar: opts.avatar } : {}),
	};
}

const OWN_MEMBERS = [
	user(MEMBER_UNIONID, "itest.account.member", {
		avatar: "https://example.com/a.png",
	}),
	user(NO_EMAIL_UNIONID, "itest.account.noemail", { email: null }),
];

maybe("findAccount 准入 (需要 DATABASE_URL)", () => {
	const db = createDb(url ?? "", { maxConnections: 2 });
	const findAccount = makeFindAccount(db, OWN_APP);

	// biome-ignore lint/suspicious/noExplicitAny: oidc-provider 的 KoaContextWithOIDC 造不出来，且本实现不读它
	const ctx = {} as any;

	beforeEach(async () => {
		await resetOrgSync(db);
		await seedOrgSync(db, OWN_APP, fetchedOrg(OWN_MEMBERS));
	});

	afterAll(async () => {
		await resetOrgSync(db);
		await db.$client.end();
	});

	it("自有同步结果里的当前成员放行，claim 取自同步结果", async () => {
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

	it("不在自有同步结果里的 unionId 拒绝 —— 既有会话也不再放行", async () => {
		await expect(
			findAccount(ctx, "itest-account-not-a-member"),
		).resolves.toBeUndefined();
	});

	// ⚠️ 按应用隔离的最后一道防线，不能删
	it("状态行属于别的应用时一律拒绝（哪怕那份名单里有这个人）", async () => {
		await resetOrgSync(db);
		// 别的钉钉应用的数据：可见范围更宽，里面有一个本组织之外的人
		await seedOrgSync(
			db,
			OTHER_APP,
			fetchedOrg([
				user(MEMBER_UNIONID, "itest.account.member"),
				user(OUTSIDER_UNIONID, "itest.account.outsider"),
			]),
		);

		await expect(findAccount(ctx, OUTSIDER_UNIONID)).resolves.toBeUndefined();
		await expect(findAccount(ctx, MEMBER_UNIONID)).resolves.toBeUndefined();
	});

	// ⚠️ 离职生效靠的就是这一条
	it("已离开的人拒绝", async () => {
		await seedOrgSync(db, OWN_APP, fetchedOrg(OWN_MEMBERS.slice(1)));

		await expect(findAccount(ctx, MEMBER_UNIONID)).resolves.toBeUndefined();
		await expect(findAccount(ctx, NO_EMAIL_UNIONID)).resolves.toBeDefined();
	});

	it("重入职换了 userid 的人照样放行（sub 是 unionId）", async () => {
		await seedOrgSync(
			db,
			OWN_APP,
			fetchedOrg([
				user(MEMBER_UNIONID, "itest.account.member", { userid: "rehired" }),
			]),
		);

		await expect(findAccount(ctx, MEMBER_UNIONID)).resolves.toBeDefined();
	});

	it("自有应用从没同步成功过（fetched_at 为空）一律拒绝，哪怕表里有行", async () => {
		await db.update(orgSync).set({ fetchedAt: sql`null` });

		await expect(findAccount(ctx, MEMBER_UNIONID)).resolves.toBeUndefined();
	});
});
