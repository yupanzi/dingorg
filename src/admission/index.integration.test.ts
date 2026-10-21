import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "~/db";
import { DingtalkError } from "~/dingtalk/client";
import { checkEmployment, type Employment } from "~/dingtalk/employment";
import { fetchOrg } from "~/dingtalk/fetch-org";
import type { MemberFields } from "~/domain/org-sync";
import { logger } from "~/log";
import { findMember, readSyncState } from "~/sync/store";
import {
	fetchedOrg,
	member,
	passCooldown,
	resetOrgSync,
	seedOrgSync,
} from "~/sync/testing";

import { type AdmissionDeps, admit } from ".";

/**
 * 钉住 `admit` 的组合规则：钉钉实时说不是员工一律拒（离职立即生效）；实时出错只看同步结果；
 * 只有钉钉确认是员工才补同步（外部人员扫码触发不了全量拉取）；补同步不接管别的应用的数据。
 * 实时校验与拉取 mock，补同步走真的 `syncOrg`，PG 用真的。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

let employment: Employment | Error = "employee";
vi.mock("~/dingtalk/employment", () => ({
	checkEmployment: vi.fn(async () => {
		if (employment instanceof Error) throw employment;
		return employment;
	}),
}));
vi.mock("~/dingtalk/access-token", () => ({
	withAccessToken: vi.fn(
		async (_db: unknown, _cred: unknown, fn: (t: string) => unknown) =>
			fn("itest-token"),
	),
}));
// 只包一层、照调真的：要能让某一次查库失败
vi.mock("~/sync/store", async (importOriginal) => {
	const real = await importOriginal<typeof import("~/sync/store")>();
	return { ...real, findMember: vi.fn(real.findMember) };
});
let nextMembers: MemberFields[] = [];
let fetchError: Error | null = null;
vi.mock("~/dingtalk/fetch-org", () => ({
	fetchOrg: vi.fn(async () => {
		if (fetchError) throw fetchError;
		return fetchedOrg(nextMembers);
	}),
}));

const APP = "itest-admission-app";
const OTHER_APP = "itest-admission-other-app";

const ALICE = member("itest.admission.alice");
/** 钉钉里有、同步结果里还没有的新人 */
const BOB = member("itest.admission.bob");
const unionOf = (m: MemberFields) => m.unionid ?? "";

maybe("准入 admit (需要 DATABASE_URL)", () => {
	const db = createDb(url ?? "", { maxConnections: 3 });
	const deps: AdmissionDeps = {
		db,
		dingtalk: { clientId: APP, clientSecret: "x" },
		log: logger,
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		employment = "employee";
		nextMembers = [ALICE, BOB];
		fetchError = null;
		await resetOrgSync(db);
		await seedOrgSync(db, APP, fetchedOrg([ALICE]));
	});

	afterAll(async () => {
		await resetOrgSync(db);
		await db.$client.end();
	});

	it("同步结果里有、钉钉确认是员工 → 放行", async () => {
		const r = await admit(deps, unionOf(ALICE), "realtime_sync");

		expect(r).toMatchObject({
			admitted: true,
			member: { userName: "itest.admission.alice" },
		});
		expect(r.synced).toBeUndefined();
		expect(checkEmployment).toHaveBeenCalledTimes(1);
	});

	// ⚠️ 离职立即生效靠的就是这一条
	it("钉钉说不是员工 → 拒，哪怕同步结果里还有", async () => {
		employment = "not_employee";
		await passCooldown(db);

		const r = await admit(deps, unionOf(ALICE), "realtime_sync");

		expect(r).toMatchObject({ admitted: false, reason: "not_employee" });
		expect(fetchOrg).not.toHaveBeenCalled();
	});

	it("钉钉说不是员工、同步结果里也没有 → 拒，且不补同步", async () => {
		employment = "not_employee";
		await passCooldown(db);

		const r = await admit(deps, "itest-admission-outsider", "realtime_sync");

		expect(r).toMatchObject({ admitted: false, reason: "not_employee" });
		expect(r.synced).toBeUndefined();
		expect(fetchOrg).not.toHaveBeenCalled();
	});

	it("实时校验出错 → 只看同步结果：有就放行，没有就拒且不补同步", async () => {
		employment = new DingtalkError("系统繁忙", { errcode: -1 });
		await passCooldown(db);

		await expect(
			admit(deps, unionOf(ALICE), "realtime_sync"),
		).resolves.toMatchObject({
			admitted: true,
		});
		await expect(
			admit(deps, unionOf(BOB), "realtime_sync"),
		).resolves.toMatchObject({
			admitted: false,
			reason: "not_member",
		});
		expect(fetchOrg).not.toHaveBeenCalled();
	});

	it("钉钉确认是员工、同步结果里没有（新人）→ 补同步后放行", async () => {
		await passCooldown(db);

		const r = await admit(deps, unionOf(BOB), "realtime_sync");

		expect(r).toMatchObject({
			admitted: true,
			member: { userName: "itest.admission.bob" },
			synced: "refreshed",
		});
		expect(fetchOrg).toHaveBeenCalledTimes(1);
	});

	it("补同步撞上冷却期 → 不外呼，拒 not_synced", async () => {
		const r = await admit(deps, unionOf(BOB), "realtime_sync");

		expect(r).toMatchObject({
			admitted: false,
			reason: "not_synced",
			synced: "cooldown",
		});
		expect(fetchOrg).not.toHaveBeenCalled();
	});

	it("补同步失败 → 拒 not_synced，synced 记 failed", async () => {
		fetchError = new DingtalkError("ip 不在白名单", { errcode: 60020 });
		await passCooldown(db);

		const r = await admit(deps, unionOf(BOB), "realtime_sync");

		expect(r).toMatchObject({
			admitted: false,
			reason: "not_synced",
			synced: "failed",
		});
	});

	// 拉取已经发生：抛出去的话回调拿不到 `synced`，这次拉取进不了审计
	it("补同步之后查库出错 → 拒 lookup_failed，synced 照带回", async () => {
		await passCooldown(db);
		const { findMember: real } =
			await vi.importActual<typeof import("~/sync/store")>("~/sync/store");
		vi.mocked(findMember)
			.mockImplementationOnce(real)
			.mockRejectedValueOnce(new Error("连接池耗尽"));

		const r = await admit(deps, unionOf(BOB), "realtime_sync");

		expect(r).toMatchObject({
			admitted: false,
			reason: "lookup_failed",
			synced: "refreshed",
		});
	});

	// ⚠️ 隐式同步不接管（`syncOwnOrg`）：登录不能把别的应用的名单换成自有的
	it("现有数据属于别的应用 → 不补同步、不接管", async () => {
		await resetOrgSync(db);
		await seedOrgSync(db, OTHER_APP, fetchedOrg([BOB]));
		await passCooldown(db);

		const r = await admit(deps, unionOf(BOB), "realtime_sync");

		expect(r).toMatchObject({ admitted: false, reason: "not_synced" });
		expect(r.synced).toBeUndefined();
		expect(fetchOrg).not.toHaveBeenCalled();
		expect((await readSyncState(db, APP)).otherAppSynced).toBe(true);
	});

	it("realtime（不带补同步）→ 新人也不补同步", async () => {
		await passCooldown(db);

		const r = await admit(deps, unionOf(BOB), "realtime");

		expect(r).toMatchObject({ admitted: false, reason: "not_synced" });
		expect(fetchOrg).not.toHaveBeenCalled();
	});

	it("mirror → 不问钉钉，只看同步结果", async () => {
		employment = "not_employee";

		await expect(admit(deps, unionOf(ALICE), "mirror")).resolves.toMatchObject({
			admitted: true,
		});
		await expect(admit(deps, unionOf(BOB), "mirror")).resolves.toMatchObject({
			admitted: false,
			reason: "not_member",
		});
		expect(checkEmployment).not.toHaveBeenCalled();
	});
});
