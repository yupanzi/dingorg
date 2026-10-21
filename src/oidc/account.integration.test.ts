import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "~/db";
import { orgSync } from "~/db/schema";
import { checkEmployment, type Employment } from "~/dingtalk/employment";
import type { MemberFields } from "~/domain/org-sync";
import { fetchedOrg, resetOrgSync, seedOrgSync } from "~/sync/testing";

import { makeFindAccount } from "./account";

/**
 * 准入回归：是自有应用同步结果里的当前成员，且（复用会话时）钉钉实时确认是内部员工；claim 集合
 * 固定且不含 roles。判错是静默的，而复用 oidc-provider 会话的人只经过这里。组合规则本身由
 * `~/admission` 的测试钉住，这里钉的是 `findAccount` 怎么用它。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

let employment: Employment = "employee";
vi.mock("~/dingtalk/employment", () => ({
	checkEmployment: vi.fn(async () => employment),
}));

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
	const findAccount = makeFindAccount({
		db,
		dingtalk: { clientId: OWN_APP, clientSecret: "x" },
	});

	// biome-ignore lint/suspicious/noExplicitAny: oidc-provider 的 KoaContextWithOIDC 造不出来，本实现只从它取 logger
	const ctx = {} as any;
	// token 端点与 userinfo 调 findAccount 时带的 token，本实现只看有没有
	// biome-ignore lint/suspicious/noExplicitAny: 同上
	const token = {} as any;

	beforeEach(async () => {
		vi.clearAllMocks();
		employment = "employee";
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

	// ⚠️ 钉钉实时校验不可用时，离职生效靠的就是这一条
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

	// ⚠️ 复用会话（授权端点不带 token）不经扫码回调，离职的人只能在这里拦
	it("复用会话时钉钉实时说不是员工 → 拒，哪怕同步结果里还有", async () => {
		employment = "not_employee";

		await expect(findAccount(ctx, MEMBER_UNIONID)).resolves.toBeUndefined();
		expect(checkEmployment).toHaveBeenCalledTimes(1);
	});

	it("token 端点与 userinfo（带 token）不问钉钉，只看同步结果", async () => {
		employment = "not_employee";

		await expect(
			findAccount(ctx, MEMBER_UNIONID, token),
		).resolves.toBeDefined();
		await expect(
			findAccount(ctx, OUTSIDER_UNIONID, token),
		).resolves.toBeUndefined();
		expect(checkEmployment).not.toHaveBeenCalled();
	});
});
