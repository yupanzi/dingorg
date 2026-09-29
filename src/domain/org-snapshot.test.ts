import { describe, expect, it } from "vitest";

import type { OrgApiUser } from "./org-api";
import {
	buildSnapshot,
	type FetchedOrg,
	type MemberFields,
} from "./org-snapshot";

const DEPTS = [
	{ id: 3, parentId: 1, name: "乙中心", ancestorIds: [1] },
	{ id: 1, parentId: null, name: "某公司", ancestorIds: [] },
	{ id: 2, parentId: 1, name: "甲中心", ancestorIds: [1] },
];

function fetched(
	membersByDept: Array<{ deptId: number; members: MemberFields[] }>,
): FetchedOrg {
	return { departments: DEPTS, membersByDept };
}

function byUserName(users: OrgApiUser[], userName: string): OrgApiUser {
	const u = users.find((x) => x.userName === userName);
	if (!u) throw new Error(`快照里没有 ${userName}`);
	return u;
}

describe("buildSnapshot", () => {
	it("一人挂多个部门合成一条，主管标记按部门各自保留", () => {
		const { data } = buildSnapshot(
			fetched([
				{
					deptId: 2,
					members: [
						{
							userid: "u1",
							name: "alice(甲)",
							org_email: "alice@x.com",
							leader: false,
						},
					],
				},
				{
					deptId: 3,
					members: [
						{
							userid: "u1",
							name: "alice(甲)",
							org_email: "alice@x.com",
							leader: true,
						},
					],
				},
			]),
			undefined,
		);

		expect(data.users).toHaveLength(1);
		expect(byUserName(data.users, "alice").depts).toEqual([
			{ id: 2, name: "甲中心", isLeader: false },
			{ id: 3, name: "乙中心", isLeader: true },
		]);
	});

	it("部门按 id、成员按 userName 排序", () => {
		const { data } = buildSnapshot(
			fetched([
				{
					deptId: 1,
					members: [
						{ userid: "u2", name: "zoe", org_email: "zoe@x.com" },
						{ userid: "u1", name: "bob", org_email: "bob@x.com" },
					],
				},
			]),
			undefined,
		);

		expect(data.departments.map((d) => d.id)).toEqual([1, 2, 3]);
		expect(data.users.map((u) => u.userName)).toEqual(["bob", "zoe"]);
	});

	it("没有企业邮箱：email 为 null（不推导），userName 取显示名", () => {
		const { data } = buildSnapshot(
			fetched([{ deptId: 1, members: [{ userid: "u1", name: "carol(丙)" }] }]),
			undefined,
		);

		const carol = byUserName(data.users, "carol");
		expect(carol.email).toBeNull();
		expect(carol.dingtalk.orgEmail).toBeNull();
	});

	it("有企业邮箱：email 是它小写后的值，dingtalk.orgEmail 保留原文", () => {
		const { data } = buildSnapshot(
			fetched([
				{
					deptId: 1,
					members: [{ userid: "u1", name: "x", org_email: "Erin@Corp.com " }],
				},
			]),
			undefined,
		);

		const erin = byUserName(data.users, "erin");
		expect(erin.email).toBe("erin@corp.com");
		expect(erin.dingtalk.orgEmail).toBe("Erin@Corp.com");
	});

	it("无法归一化身份的成员跳过，并计入 skipped", () => {
		const { data, skipped } = buildSnapshot(
			fetched([{ deptId: 1, members: [{ userid: "u9", name: "" }] }]),
			undefined,
		);

		expect(data.users).toHaveLength(0);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]).toContain("u9");
	});

	it("title 缺失与空串都归一成 null，extension 解析出职级", () => {
		const { data } = buildSnapshot(
			fetched([
				{
					deptId: 1,
					members: [
						{ userid: "u1", name: "a", org_email: "a@x.com", title: "" },
						{
							userid: "u2",
							name: "b",
							org_email: "b@x.com",
							extension: '{"职务":"主管"}',
						},
					],
				},
			]),
			undefined,
		);

		const a = byUserName(data.users, "a");
		expect(a.dingtalk.title).toBeNull();
		expect(a.titles).toEqual([]);

		const b = byUserName(data.users, "b");
		expect(b.dingtalk.title).toBeNull();
		expect(b.jobLevel).toBe("主管");
		expect(b.dingtalk.extension).toEqual({ 职务: "主管" });
	});

	describe("userName 撞名", () => {
		// 两个同名的人都没有企业邮箱 → 按显示名得出同一个 userName
		const twins: MemberFields[] = [
			{ userid: "u-b", name: "dave", unionid: "union-b" },
			{ userid: "u-a", name: "dave", unionid: "union-a" },
		];

		it("没有上一版时按 userid 取第一个，结果不随返回顺序翻转", () => {
			const one = buildSnapshot(
				fetched([{ deptId: 1, members: twins }]),
				undefined,
			);
			const other = buildSnapshot(
				fetched([{ deptId: 1, members: [...twins].reverse() }]),
				undefined,
			);

			for (const { data, skipped } of [one, other]) {
				expect(data.users).toHaveLength(1);
				expect(byUserName(data.users, "dave").dingtalk.userid).toBe("u-a");
				expect(skipped).toHaveLength(1);
				expect(skipped[0]).toContain("u-b");
			}
		});

		it("上一版的持有者优先，新来的同名者不能把他挤掉", () => {
			const prev = buildSnapshot(
				fetched([{ deptId: 1, members: [twins[0] as MemberFields] }]),
				undefined,
			).data.users;

			const { data } = buildSnapshot(
				fetched([{ deptId: 1, members: twins }]),
				prev,
			);

			// u-b 的 userid 更大，但它是原持有者
			expect(byUserName(data.users, "dave").dingtalk.userid).toBe("u-b");
		});

		it("原持有者离职重入职（userid 变了、unionid 不变）仍被认出", () => {
			const prev = buildSnapshot(
				fetched([{ deptId: 1, members: [twins[0] as MemberFields] }]),
				undefined,
			).data.users;

			const rehired: MemberFields = {
				userid: "u-z",
				name: "dave",
				unionid: "union-b",
			};
			const { data } = buildSnapshot(
				fetched([{ deptId: 1, members: [rehired, twins[1] as MemberFields] }]),
				prev,
			);

			expect(byUserName(data.users, "dave").dingtalk.unionid).toBe("union-b");
		});
	});
});
