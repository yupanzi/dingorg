import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "~/db";
import { orgSnapshots } from "~/db/schema";
import { DingtalkError } from "~/dingtalk/client";
import { logger } from "~/log";

import {
	getOrFetchSnapshot,
	readSnapshot,
	refreshSnapshot,
	type SnapshotDeps,
	SnapshotUnavailableError,
} from "./snapshot";

/**
 * 钉住：读不外呼、刷新并发合并且有冷却、失败不动旧快照、每种失败都记下来。
 * 只 mock `fetchOrg`，PG 用真的：条件写只在真实存储上成立。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

let fetchCount = 0;
let nextError: Error | null = null;
let nextDelayMs = 0;
/** 覆盖成员姓名，用来摆出「PG 存不进去」的数据 */
let nextName: string | null = null;
vi.mock("~/dingtalk/fetch-org", () => ({
	fetchOrg: vi.fn(async () => {
		fetchCount += 1;
		const n = fetchCount;
		if (nextDelayMs > 0) await new Promise((r) => setTimeout(r, nextDelayMs));
		if (nextError) throw nextError;
		return {
			departments: [{ id: 1, parentId: null, name: "根部门", ancestorIds: [] }],
			membersByDept: [
				{
					deptId: 1,
					members: [
						{
							userid: `u${n}`,
							name: nextName ?? `user${n}`,
							org_email: `user${n}@x.com`,
						},
					],
				},
			],
		};
	}),
}));

const APP = "itest-snapshot-app";
const token = "itest-token";
const dingtalkDown = () => new DingtalkError("钉钉挂了", { errcode: 60020 });

maybe("组织快照 (需要 DATABASE_URL)", () => {
	const db = createDb(url ?? "", { maxConnections: 3 });
	const deps: SnapshotDeps = { db, log: logger };

	async function cleanup() {
		await db.delete(orgSnapshots).where(inArray(orgSnapshots.appKey, [APP]));
	}

	async function ageSnapshot(ms: number) {
		const at = new Date(Date.now() - ms);
		await db
			.update(orgSnapshots)
			.set({ fetchedAt: at, attemptedAt: at })
			.where(eq(orgSnapshots.appKey, APP));
	}

	/** 只拨上一次尝试的时刻：从没成功过的行 `fetchedAt` 必须保持为空 */
	async function ageAttempt(ms: number) {
		await db
			.update(orgSnapshots)
			.set({ attemptedAt: new Date(Date.now() - ms) })
			.where(eq(orgSnapshots.appKey, APP));
	}

	beforeEach(async () => {
		fetchCount = 0;
		nextError = null;
		nextDelayMs = 0;
		nextName = null;
		await cleanup();
	});

	afterAll(async () => {
		await cleanup();
		await db.$client.end();
	});

	it("没有快照时当场拉一次；之后再旧也不外呼", async () => {
		const first = await getOrFetchSnapshot(deps, APP, token);
		expect(fetchCount).toBe(1);
		expect(first.data.users).toHaveLength(1);

		await ageSnapshot(365 * 24 * 3600_000);
		await getOrFetchSnapshot(deps, APP, token);
		expect(fetchCount).toBe(1);
	});

	it("并发刷新合并成一次拉取", async () => {
		nextDelayMs = 100;
		const results = await Promise.all(
			Array.from({ length: 5 }, () => refreshSnapshot(deps, APP, token)),
		);

		expect(fetchCount).toBe(1);
		expect(results.every((r) => r.refreshed)).toBe(true);
	});

	it("冷却期内再刷新不外呼，过了冷却期才拉", async () => {
		await refreshSnapshot(deps, APP, token);

		const again = await refreshSnapshot(deps, APP, token);
		expect(again.refreshed).toBe(false);
		expect(fetchCount).toBe(1);

		await ageSnapshot(2 * 60_000);
		expect((await refreshSnapshot(deps, APP, token)).refreshed).toBe(true);
		expect(fetchCount).toBe(2);
	});

	it("冷却从尝试**结束**算：attemptedAt 晚于 fetchedAt（拉取开始）", async () => {
		nextDelayMs = 300;
		const { row } = await refreshSnapshot(deps, APP, token);

		expect(
			row.attemptedAt.getTime() - row.fetchedAt.getTime(),
		).toBeGreaterThanOrEqual(300);
	});

	it("刷新失败：抛出，旧快照与 fetchedAt 原样保留，只记 error", async () => {
		await refreshSnapshot(deps, APP, token);
		await ageSnapshot(2 * 60_000);
		const before = await readSnapshot(db, APP);

		nextError = dingtalkDown();
		await expect(refreshSnapshot(deps, APP, token)).rejects.toThrow("钉钉挂了");

		const after = await readSnapshot(db, APP);
		expect(after?.data).toEqual(before?.data);
		expect(after?.fetchedAt?.getTime()).toBe(before?.fetchedAt?.getTime());
		expect(after?.error).toBe("钉钉挂了（60020）");
	});

	it("有旧快照、刚失败过：冷却期内返回旧快照，不外呼", async () => {
		await refreshSnapshot(deps, APP, token);
		await ageSnapshot(2 * 60_000);
		nextError = dingtalkDown();
		await expect(refreshSnapshot(deps, APP, token)).rejects.toThrow();

		nextError = null;
		const again = await refreshSnapshot(deps, APP, token);
		expect(again.refreshed).toBe(false);
		expect(again.row.error).toBe("钉钉挂了（60020）");
		expect(fetchCount).toBe(2);
	});

	it("从没成功过也留下失败记录，供状态查询与退避", async () => {
		nextError = dingtalkDown();
		await expect(getOrFetchSnapshot(deps, APP, token)).rejects.toThrow();

		const row = await readSnapshot(db, APP);
		expect(row?.data).toBeNull();
		expect(row?.error).toBe("钉钉挂了（60020）");
	});

	it("从没成功过、刚失败过：冷却期内不外呼，抛带原因的 SnapshotUnavailableError", async () => {
		nextError = dingtalkDown();
		await expect(getOrFetchSnapshot(deps, APP, token)).rejects.toThrow();

		const err = await getOrFetchSnapshot(deps, APP, token).catch((e) => e);
		expect(err).toBeInstanceOf(SnapshotUnavailableError);
		expect((err as SnapshotUnavailableError).message).toContain("60020");
		expect((err as SnapshotUnavailableError).retryAfterMs).toBeGreaterThan(0);
		expect(fetchCount).toBe(1);

		await ageAttempt(2 * 60_000);
		nextError = null;
		await getOrFetchSnapshot(deps, APP, token);
		expect(fetchCount).toBe(2);
	});

	it("写库失败也记失败（PG 的 jsonb 存不了 NUL）", async () => {
		nextName = "坏\u0000名字";
		await expect(refreshSnapshot(deps, APP, token)).rejects.toThrow();

		const row = await readSnapshot(db, APP);
		expect(row?.data).toBeNull();
		expect(row?.error).toBe("内部错误");
	});

	it("error 列不存非钉钉错误的原文", async () => {
		nextError = new Error('relation "secret_table" does not exist');
		await expect(refreshSnapshot(deps, APP, token)).rejects.toThrow();

		expect((await readSnapshot(db, APP))?.error).toBe("内部错误");
	});
});
