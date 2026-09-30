import { isNotNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "~/db";
import { orgSync, orgUsers } from "~/db/schema";
import { invalidateAccessToken } from "~/dingtalk/access-token";
import { DingtalkError } from "~/dingtalk/client";
import type { MemberFields } from "~/domain/org-sync";
import { logger } from "~/log";

import { getOrSyncOrg, NotSyncedError, type SyncDeps, syncOrg } from "./org";
import { readOrgUsers, readSyncState } from "./store";
import {
	ageOrgSync,
	fetchedOrg,
	holdLease,
	leaseHolder,
	member,
	resetOrgSync,
	seedOrgSync,
} from "./testing";

/**
 * 钉住：读不外呼；同步进程内合并、跨副本靠租约、有冷却；失败不动已有数据且整轮回滚；每种失败
 * 都记下来；别的应用的数据懒加载不接管。mock `fetchOrg` 与 token 层（后者有自己的测试），
 * PG 用真的：租约与条件写只在真实存储上成立。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

let fetchCount = 0;
let nextError: Error | null = null;
let nextDelayMs = 0;
/** 覆盖这一轮的名单；默认一人，userid 随拉取次数变 */
let nextMembers: MemberFields[] | null = null;
let tokenCount = 0;
let nextTokenError: Error | null = null;
vi.mock("~/dingtalk/access-token", () => ({
	getAccessToken: vi.fn(async () => {
		tokenCount += 1;
		if (nextTokenError) throw nextTokenError;
		return "itest-token";
	}),
	invalidateAccessToken: vi.fn(async () => {}),
}));
vi.mock("~/dingtalk/fetch-org", () => ({
	fetchOrg: vi.fn(async () => {
		fetchCount += 1;
		const n = fetchCount;
		if (nextDelayMs > 0) await new Promise((r) => setTimeout(r, nextDelayMs));
		if (nextError) throw nextError;
		return fetchedOrg(
			nextMembers ?? [
				{ userid: `u${n}`, name: `user${n}`, org_email: `user${n}@x.com` },
			],
		);
	}),
}));

const APP = "itest-sync-app";
const OTHER_APP = "itest-sync-other-app";
const dingtalkDown = () => new DingtalkError("钉钉挂了", { errcode: 60020 });

maybe("组织同步 (需要 DATABASE_URL)", () => {
	const db = createDb(url ?? "", { maxConnections: 3 });
	const deps: SyncDeps = {
		db,
		dingtalk: { clientId: APP, clientSecret: "x" },
		log: logger,
	};

	const state = () => readSyncState(db, APP);
	const leftCount = async () =>
		(await db.select().from(orgUsers).where(isNotNull(orgUsers.leftAt))).length;

	beforeEach(async () => {
		fetchCount = 0;
		tokenCount = 0;
		nextTokenError = null;
		vi.mocked(invalidateAccessToken).mockClear();
		nextError = null;
		nextDelayMs = 0;
		nextMembers = null;
		await resetOrgSync(db);
	});

	afterAll(async () => {
		await resetOrgSync(db);
		await db.$client.end();
	});

	it("没有数据时当场同步一次；之后再旧也不外呼", async () => {
		const first = await getOrSyncOrg(deps, readOrgUsers);
		expect(fetchCount).toBe(1);
		expect(first.items).toHaveLength(1);

		await ageOrgSync(db, 365 * 24 * 3600_000, { fetched: true });
		await getOrSyncOrg(deps, readOrgUsers);
		expect(fetchCount).toBe(1);
	});

	it("进程内并发同步合并成一次拉取", async () => {
		nextDelayMs = 100;
		const results = await Promise.all(
			Array.from({ length: 5 }, () => syncOrg(deps)),
		);

		expect(fetchCount).toBe(1);
		expect(results.every((r) => r.outcome === "refreshed")).toBe(true);
	});

	it("冷却期内再同步不外呼，过了冷却期才拉", async () => {
		await syncOrg(deps);

		const again = await syncOrg(deps);
		expect(again.outcome).toBe("cooldown");
		expect(fetchCount).toBe(1);

		await ageOrgSync(db, 2 * 60_000);
		expect((await syncOrg(deps)).outcome).toBe("refreshed");
		expect(fetchCount).toBe(2);
	});

	it("冷却从尝试**结束**算：attemptedAt 晚于 fetchedAt（拉取开始）", async () => {
		nextDelayMs = 300;
		const { state: s } = await syncOrg(deps);

		expect(
			(s.attemptedAt?.getTime() ?? 0) - (s.fetchedAt?.getTime() ?? 0),
		).toBeGreaterThanOrEqual(300);
	});

	it("同步失败：抛出，已有数据与 fetchedAt 原样保留、没人被标离开，只记 error", async () => {
		await syncOrg(deps);
		await ageOrgSync(db, 2 * 60_000);
		const before = await readOrgUsers(db, APP);

		nextError = dingtalkDown();
		await expect(syncOrg(deps)).rejects.toThrow("钉钉挂了");

		const after = await readOrgUsers(db, APP);
		expect(after?.items).toEqual(before?.items);
		expect(after?.fetchedAt.getTime()).toBe(before?.fetchedAt.getTime());
		expect(await leftCount()).toBe(0);
		expect((await state()).error).toBe("钉钉挂了（60020）");
	});

	it("有数据、刚失败过：冷却期内返回现有数据，不外呼", async () => {
		await syncOrg(deps);
		await ageOrgSync(db, 2 * 60_000);
		nextError = dingtalkDown();
		await expect(syncOrg(deps)).rejects.toThrow();

		nextError = null;
		const again = await syncOrg(deps);
		expect(again.outcome).toBe("cooldown");
		expect(again.state.error).toBe("钉钉挂了（60020）");
		expect(fetchCount).toBe(2);
	});

	it("从没成功过也留下失败记录，供状态查询与退避", async () => {
		nextError = dingtalkDown();
		await expect(getOrSyncOrg(deps, readOrgUsers)).rejects.toThrow();

		const s = await state();
		expect(s.fetchedAt).toBeNull();
		expect(s.error).toBe("钉钉挂了（60020）");
		expect(await db.select().from(orgUsers)).toHaveLength(0);
	});

	it("从没成功过、刚失败过：冷却期内不外呼，抛带原因的 NotSyncedError", async () => {
		nextError = dingtalkDown();
		await expect(getOrSyncOrg(deps, readOrgUsers)).rejects.toThrow();

		const err = await getOrSyncOrg(deps, readOrgUsers).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(NotSyncedError);
		expect((err as NotSyncedError).reason).toBe("cooldown");
		expect((err as NotSyncedError).message).toContain("60020");
		expect((err as NotSyncedError).retryAfterSec).toBeGreaterThan(0);
		expect(fetchCount).toBe(1);

		await ageOrgSync(db, 2 * 60_000);
		nextError = null;
		await getOrSyncOrg(deps, readOrgUsers);
		expect(fetchCount).toBe(2);
	});

	it("写库失败整轮回滚：标离开也撤回（PG 的 text 存不了 NUL）", async () => {
		nextMembers = [member("u1")];
		await syncOrg(deps);
		const before = await state();
		await ageOrgSync(db, 2 * 60_000);

		// u1 不在这一轮：先被标离开，再在插入 u2 时失败
		nextMembers = [{ ...member("u2"), name: "坏\u0000名字" }];
		await expect(syncOrg(deps)).rejects.toThrow();

		const after = await state();
		expect(await leftCount()).toBe(0);
		expect(
			(await readOrgUsers(db, APP))?.items.map((u) => u.dingtalk.userid),
		).toEqual(["u1"]);
		expect(after.fetchedAt?.getTime()).toBe(before.fetchedAt?.getTime());
		expect(after.error).toBe("内部错误");
	});

	it("token 申请失败也记进 error；冷却期内连 token 都不申请", async () => {
		nextTokenError = new DingtalkError("应用凭证无效", { errcode: 40089 });
		await expect(syncOrg(deps)).rejects.toThrow("应用凭证无效");
		expect((await state()).error).toBe("应用凭证无效（40089）");
		expect(fetchCount).toBe(0);

		await expect(syncOrg(deps)).rejects.toBeInstanceOf(NotSyncedError);
		expect(tokenCount).toBe(1);
	});

	// `invalidateAccessToken` 唯一的生产调用方：少了它坏 token 一直留在缓存里
	it("拉取时钉钉说 token 失效：丢掉这个 token", async () => {
		nextError = new DingtalkError("不合法的access_token", { errcode: 40014 });
		await expect(syncOrg(deps)).rejects.toThrow();

		expect(vi.mocked(invalidateAccessToken)).toHaveBeenCalledWith(
			db,
			APP,
			"itest-token",
		);
	});

	it("error 列不存非钉钉错误的原文", async () => {
		nextError = new Error('relation "secret_table" does not exist');
		await expect(syncOrg(deps)).rejects.toThrow();

		expect((await state()).error).toBe("内部错误");
	});

	describe("跨副本租约", () => {
		it("别处持着租约、有数据：不外呼、不申请 token，报 busy", async () => {
			await syncOrg(deps);
			await ageOrgSync(db, 2 * 60_000);
			await holdLease(db, APP, 60_000);

			const r = await syncOrg(deps);
			expect(r.outcome).toBe("busy");
			expect(r.state.syncing).toBe(true);
			expect(fetchCount).toBe(1);
			expect(tokenCount).toBe(1);
		});

		it("别处持着租约、又没有数据：抛 syncing，带重试间隔", async () => {
			await holdLease(db, APP, 60_000);

			const err = await getOrSyncOrg(deps, readOrgUsers).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(NotSyncedError);
			expect((err as NotSyncedError).reason).toBe("syncing");
			expect((err as NotSyncedError).retryAfterSec).toBeGreaterThan(0);
			expect(fetchCount).toBe(0);
			expect(tokenCount).toBe(0);
		});

		it("过期的租约可以接管（持有者被杀也不用人工解锁）", async () => {
			await holdLease(db, APP, -1_000);

			expect((await syncOrg(deps)).outcome).toBe("refreshed");
		});

		it("成功与失败之后都释放自己的租约", async () => {
			await syncOrg(deps);
			expect(await leaseHolder(db)).toBeNull();

			await ageOrgSync(db, 2 * 60_000);
			nextError = dingtalkDown();
			await expect(syncOrg(deps)).rejects.toThrow();
			expect(await leaseHolder(db)).toBeNull();
			expect((await state()).syncing).toBe(false);
		});
	});

	describe("现有数据属于别的应用（换过 DINGTALK_APP_KEY）", () => {
		beforeEach(async () => {
			await seedOrgSync(
				db,
				OTHER_APP,
				fetchedOrg([member("o1"), member("o2")]),
			);
			// o2 在别的应用那边离开了：它的离开记录也不能留到自有应用名下
			await seedOrgSync(db, OTHER_APP, fetchedOrg([member("o1")]));
			await ageOrgSync(db, 2 * 60_000);
		});

		it("懒加载不接管：抛 other_app、不外呼，也不给重试间隔", async () => {
			const err = await getOrSyncOrg(deps, readOrgUsers).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(NotSyncedError);
			expect((err as NotSyncedError).reason).toBe("other_app");
			expect((err as NotSyncedError).retryAfterSec).toBeNull();
			expect((err as NotSyncedError).message).not.toContain(OTHER_APP);
			expect(fetchCount).toBe(0);
		});

		it("显式同步接管，并硬删别的应用的全部行（含已离开的）", async () => {
			nextMembers = [member("u1")];
			expect((await syncOrg(deps)).outcome).toBe("refreshed");

			const rows = await db.select().from(orgUsers);
			expect(rows.map((r) => r.userid)).toEqual(["u1"]);
			expect((await state()).fetchedAt).not.toBeNull();
		});

		it("接管失败：别的应用的数据、app_key、fetched_at 都不动", async () => {
			const [before] = await db.select().from(orgSync);
			nextError = dingtalkDown();
			await expect(syncOrg(deps)).rejects.toThrow();

			const [after] = await db.select().from(orgSync);
			expect(after?.appKey).toBe(OTHER_APP);
			expect(after?.fetchedAt?.getTime()).toBe(before?.fetchedAt?.getTime());
			expect(after?.error).toBe("钉钉挂了（60020）");
			expect((await readOrgUsers(db, OTHER_APP))?.items).toHaveLength(1);

			const s = await state();
			expect(s.fetchedAt).toBeNull();
			expect(s.otherAppSynced).toBe(true);
			expect(await readOrgUsers(db, APP)).toBeNull();
		});
	});
});
