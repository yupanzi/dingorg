import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "~/db";
import { orgDepartments, orgSync, orgUserDepts, orgUsers } from "~/db/schema";
import { buildOrgSync } from "~/domain/org-sync";

import {
	claimSync,
	findMember,
	readOrgDepartments,
	readOrgUsers,
	readSyncState,
	recordSyncFailure,
	type SyncLease,
	writeOrgSync,
} from "./store";
import {
	ageOrgSync,
	fetchedOrg,
	leaseHolder,
	member,
	ROOT_DEPT,
	resetOrgSync,
	seedOrgSync,
} from "./testing";

/**
 * 钉住 SQL 层：租约互斥、租约过期后的条件写兜底、只释放自己的租约、软删除的各种走向、
 * 镜像表读写往返无损。直接调 store，不受冷却编排干扰。
 */
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

const APP = "itest-store-app";
const OTHER_APP = "itest-store-other-app";

maybe("组织同步的存储 (需要 DATABASE_URL)", () => {
	const db = createDb(url ?? "", { maxConnections: 4 });

	const currentIds = async () =>
		(await readOrgUsers(db, APP))?.items.map((u) => u.dingtalk.userid);
	const row = async (userid: string) =>
		(await db.select().from(orgUsers).where(eq(orgUsers.userid, userid)))[0];

	/** 让持有者的租约到期，持有者不变 */
	const expireLease = () =>
		db.update(orgSync).set({ leaseUntil: sql`now() - interval '1 second'` });

	async function claim(h: string): Promise<SyncLease> {
		const lease = await claimSync(db, APP, h);
		if (!lease) throw new Error(`${h} 没抢到租约`);
		return lease;
	}

	beforeEach(async () => {
		await resetOrgSync(db);
	});

	afterAll(async () => {
		await resetOrgSync(db);
		await db.$client.end();
	});

	describe("租约", () => {
		it("空表时两个并发抢租约，只有一个抢到", async () => {
			const got = await Promise.all([
				claimSync(db, APP, "h1"),
				claimSync(db, APP, "h2"),
			]);
			expect(got.filter(Boolean)).toHaveLength(1);
		});

		it("有状态行、冷却已过时两个并发抢租约，也只有一个抢到", async () => {
			await seedOrgSync(db, APP, fetchedOrg([member("u1")]));
			await ageOrgSync(db, 2 * 60_000);

			const got = await Promise.all([
				claimSync(db, APP, "h1"),
				claimSync(db, APP, "h2"),
			]);
			expect(got.filter(Boolean)).toHaveLength(1);
		});

		it("租约过期后接手的一轮先落库：老持有者晚到的写入被挡下", async () => {
			const first = await claim("h1");
			await expireLease();
			const second = await claim("h2");

			await writeOrgSync(db, second, fetchedOrg([member("u2")]));
			const late = await writeOrgSync(db, first, fetchedOrg([member("u1")]));

			expect(late.written).toBe(false);
			expect(await currentIds()).toEqual(["u2"]);
		});

		it("不是自己的租约不释放：老持有者记失败或写入，接手者的租约还在", async () => {
			const first = await claim("h1");
			await expireLease();
			await claim("h2");

			await recordSyncFailure(db, first, "钉钉挂了");
			expect(await leaseHolder(db)).toBe("h2");

			await writeOrgSync(db, first, fetchedOrg([member("u1")]));
			expect(await leaseHolder(db)).toBe("h2");
		});
	});

	describe("软删除", () => {
		it("这一轮不在的人：标离开、字段保留，名单与准入都查不到", async () => {
			await seedOrgSync(db, APP, fetchedOrg([member("u1"), member("u2")]));
			await seedOrgSync(db, APP, fetchedOrg([member("u1")]));

			const gone = await row("u2");
			expect(gone?.leftAt).not.toBeNull();
			expect(gone?.displayName).toBe("u2");
			expect(await currentIds()).toEqual(["u1"]);
			expect(await findMember(db, APP, "union-u2")).toBeUndefined();
			expect((await readSyncState(db, APP)).userCount).toBe(1);
		});

		it("同一个 userid 回来：清掉离开标记", async () => {
			await seedOrgSync(db, APP, fetchedOrg([member("u1"), member("u2")]));
			await seedOrgSync(db, APP, fetchedOrg([member("u1")]));
			await seedOrgSync(db, APP, fetchedOrg([member("u1"), member("u2")]));

			expect((await row("u2"))?.leftAt).toBeNull();
			expect(await findMember(db, APP, "union-u2")).toBeDefined();
		});

		it("重入职（旧 userid 走、新 userid 同一个 unionid）同一轮里不撞唯一索引", async () => {
			await seedOrgSync(db, APP, fetchedOrg([member("u1")]));
			await seedOrgSync(
				db,
				APP,
				fetchedOrg([member("u1-new", { unionid: "union-u1", name: "新名字" })]),
			);

			expect((await row("u1"))?.leftAt).not.toBeNull();
			expect((await findMember(db, APP, "union-u1"))?.displayName).toBe(
				"新名字",
			);
		});

		it("撞名被跳过的人也标离开", async () => {
			const dave = (userid: string) =>
				member(userid, { name: "dave", org_email: undefined });
			await seedOrgSync(
				db,
				APP,
				fetchedOrg([dave("u-a"), member("u-b", { org_email: undefined })]),
			);
			const { skipped } = await seedOrgSync(
				db,
				APP,
				fetchedOrg([dave("u-a"), dave("u-b")]),
			);

			expect(skipped.join()).toContain("u-b");
			expect((await row("u-b"))?.leftAt).not.toBeNull();
		});

		it("撞名的原持有者取自库里的当前成员，已离开的不算", async () => {
			const dave = (userid: string) =>
				member(userid, { name: "dave", org_email: undefined });
			await seedOrgSync(db, APP, fetchedOrg([dave("u-b")]));
			await seedOrgSync(db, APP, fetchedOrg([dave("u-a"), dave("u-b")]));
			// u-b 是原持有者，userid 更小的 u-a 挤不掉它
			expect(await currentIds()).toEqual(["u-b"]);

			await seedOrgSync(db, APP, fetchedOrg([]));
			await seedOrgSync(db, APP, fetchedOrg([dave("u-a"), dave("u-b")]));
			// 两人都离开过：没有原持有者，按 userid 取第一个
			expect(await currentIds()).toEqual(["u-a"]);
		});

		it("消失的部门硬删，成员-部门关系只含当前成员", async () => {
			await seedOrgSync(db, APP, {
				departments: [
					ROOT_DEPT,
					{ id: 2, parentId: 1, name: "甲", ancestorIds: [1] },
				],
				membersByDept: [{ deptId: 2, members: [member("u1"), member("u2")] }],
			});
			await seedOrgSync(db, APP, fetchedOrg([member("u1")]));

			expect((await db.select().from(orgDepartments)).map((d) => d.id)).toEqual(
				[1],
			);
			expect(await db.select().from(orgUserDepts)).toEqual([
				{ userid: "u1", deptId: 1, isLeader: false },
			]);
		});
	});

	// 读写两处漏一个字段不是类型错误：这里是它的哨兵
	it("镜像表读写往返无损：读出来与这一轮组装的结果逐字段相同", async () => {
		const BIG = 3_000_000_000; // 钉钉 dept_id 是 int64
		const fetched = {
			departments: [
				{ id: 1, parentId: null, name: "某公司", ancestorIds: [] },
				{ id: BIG, parentId: 1, name: "技术中心", ancestorIds: [1] },
				{ id: 2, parentId: BIG, name: "架构组", ancestorIds: [1, BIG] },
			],
			membersByDept: [
				{
					deptId: BIG,
					members: [
						member("u1", {
							name: "Alice(爱丽丝)",
							org_email: "Alice@Example.com ",
							title: "技术中心总监;架构组组长",
							extension: '{"职务":"总监","座位编号":"A1"}',
							avatar: "https://example.com/a.png",
							leader: true,
						}),
					],
				},
				{
					deptId: 2,
					members: [member("u1"), member("u2", { unionid: undefined })],
				},
			],
		};
		await seedOrgSync(db, APP, fetched);
		const { data } = buildOrgSync(fetched, undefined);

		expect((await readOrgUsers(db, APP))?.items).toEqual(data.users);
		expect((await readOrgDepartments(db, APP))?.items).toEqual(
			data.departments,
		);
	});

	it("状态行属于别的应用：自有视角是 never、计数为空，名单与准入都查不到", async () => {
		await seedOrgSync(db, OTHER_APP, fetchedOrg([member("o1")]));

		const s = await readSyncState(db, APP);
		expect(s.fetchedAt).toBeNull();
		expect(s.otherAppSynced).toBe(true);
		expect(s.userCount).toBeNull();
		expect(await readOrgUsers(db, APP)).toBeNull();
		expect(await findMember(db, APP, "union-o1")).toBeUndefined();

		expect((await readSyncState(db, OTHER_APP)).userCount).toBe(1);
	});
});
