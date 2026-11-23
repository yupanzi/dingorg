import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	buildDirectory,
	escapeDnValue,
	renderOpenLdapSchema,
} from "./ldap-directory";
import type {
	OrgApiDirectoryEntry as DirectoryEntry,
	OrgApiDept,
	OrgApiUser,
} from "./org-api";

const BASE = "dc=example,dc=com";
const personDn = (unionid: string) =>
	`dingtalkUnionId=${unionid},ou=people,${BASE}`;
const groupDn = (id: number) => `dingtalkDeptId=${id},ou=groups,${BASE}`;

// 组织形态：根(1) → 甲中心(8) → 乙组(12)；根 → 丙部(20) → 丁组(21)
const DEPTS: OrgApiDept[] = [
	{ id: 1, parentId: null, name: "某某科技", ancestorIds: [] },
	{ id: 8, parentId: 1, name: "甲中心", ancestorIds: [1] },
	{ id: 12, parentId: 8, name: "乙组", ancestorIds: [1, 8] },
	{ id: 20, parentId: 1, name: "丙部", ancestorIds: [1] },
	{ id: 21, parentId: 20, name: "丁组", ancestorIds: [1, 20] },
];
const nameOf = (id: number) => DEPTS.find((d) => d.id === id)?.name ?? "";

function user(
	userName: string,
	depts: Array<[id: number, isLeader: boolean]>,
	opts: {
		unionid?: string | null;
		titles?: string[];
		ranks?: string[];
		displayName?: string;
		email?: string | null;
		avatar?: string | null;
	} = {},
): OrgApiUser {
	return {
		userName,
		displayName: opts.displayName ?? `${userName}(某人)`,
		email: opts.email === undefined ? `${userName}@example.com` : opts.email,
		depts: depts.map(([id, isLeader]) => ({ id, name: nameOf(id), isLeader })),
		titles: opts.titles ?? [],
		ranks: opts.ranks ?? [],
		jobLevel: null,
		dingtalk: {
			userid: `uid-${userName}`,
			unionid: opts.unionid === undefined ? `u-${userName}` : opts.unionid,
			title: null,
			extension: null,
			avatar: opts.avatar ?? null,
			orgEmail: null,
		},
	};
}

const values = (e: DirectoryEntry | undefined, attr: string): string[] => {
	const v = e?.attributes[attr];
	return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
const find = (entries: DirectoryEntry[], dn: string) =>
	entries.find((e) => e.dn === dn);

/**
 * 「严格」的可检验部分：DN 不重复、MUST 齐全、按顺序导入时 member / owner 指向的条目已经建好、
 * memberOf 指向的条目存在
 */
function expectImportable(entries: DirectoryEntry[]): void {
	const all = new Set(entries.map((e) => e.dn));
	expect(all.size).toBe(entries.length);

	const created = new Set<string>();
	for (const e of entries) {
		const classes = values(e, "objectClass");
		const must = classes.includes("inetOrgPerson")
			? ["cn", "sn", "uid", "dingtalkUnionId", "dingtalkUserId"]
			: classes.includes("groupOfNames")
				? ["cn", "member", "dingtalkDeptId"]
				: ["ou"];
		for (const attr of must)
			expect(values(e, attr), `${e.dn} ${attr}`).not.toEqual([]);

		for (const ref of [...values(e, "member"), ...values(e, "owner")]) {
			expect(created.has(ref), `${e.dn} 引用了还没建的 ${ref}`).toBe(true);
		}
		for (const ref of values(e, "memberOf")) expect(all.has(ref)).toBe(true);
		created.add(e.dn);
	}
}

describe("buildDirectory", () => {
	it("身兼多职：职务、部门、memberOf 都是多值，主管只挂在他当主管的那个部门上", () => {
		const alice = user(
			"alice",
			[
				[8, true],
				[12, false],
			],
			{
				titles: ["甲中心总监", "甲中心-乙组组长"],
				ranks: ["总监", "组长"],
			},
		);
		const { entries } = buildDirectory(
			{ users: [alice], departments: DEPTS },
			BASE,
		);

		const person = find(entries, personDn("u-alice"));
		expect(values(person, "title")).toEqual(["甲中心总监", "甲中心-乙组组长"]);
		expect(values(person, "departmentNumber")).toEqual(["8", "12"]);
		expect(values(person, "ou")).toEqual(["甲中心", "乙组"]);
		expect(values(person, "memberOf")).toEqual([groupDn(8), groupDn(12)]);
		expect(values(person, "dingtalkRank")).toEqual(["总监", "组长"]);

		expect(values(find(entries, groupDn(8)), "owner")).toEqual([
			personDn("u-alice"),
		]);
		expect(find(entries, groupDn(12))?.attributes).not.toHaveProperty("owner");
		expectImportable(entries);
	});

	it("按 schema 编码：单值属性是标量，多值属性哪怕只有一个值也是数组", () => {
		const { entries } = buildDirectory(
			{ users: [user("alice", [[1, false]])], departments: DEPTS },
			BASE,
		);
		const person = find(entries, personDn("u-alice"));

		expect(person?.attributes).toMatchObject({
			objectClass: [
				"top",
				"person",
				"organizationalPerson",
				"inetOrgPerson",
				"dingtalkPerson",
			],
			uid: ["alice"],
			cn: ["alice(某人)"],
			sn: ["alice(某人)"],
			displayName: "alice(某人)",
			mail: ["alice@example.com"],
			o: ["某某科技"],
			dingtalkUnionId: "u-alice",
			dingtalkUserId: "uid-alice",
		});
		expect(find(entries, groupDn(1))?.attributes).toMatchObject({
			objectClass: ["top", "groupOfNames", "dingtalkGroup"],
			cn: ["某某科技"],
			dingtalkDeptId: "1",
		});
		// 没有值的属性不出现，不写空数组
		expect(person?.attributes).not.toHaveProperty("title");
		expect(person?.attributes).not.toHaveProperty("labeledURI");
	});

	it("没有 unionid 的人不进目录，引用也不指向他；只有他的部门因此为空、一起不出", () => {
		const { entries, people } = buildDirectory(
			{
				users: [
					user("alice", [[8, true]]),
					user("bob", [[21, true]], { unionid: null }),
				],
				departments: DEPTS,
			},
			BASE,
		);

		expect(people).toBe(1);
		expect(JSON.stringify(entries)).not.toContain("bob");
		expect(find(entries, groupDn(21))).toBeUndefined();
		expect(find(entries, groupDn(20))).toBeUndefined();
		expectImportable(entries);
	});

	it("空部门递归不出：父部门的 member 里也没有指向它们的 DN", () => {
		// 乙组、丁组都没人；丙部只有丁组 → 也是空的
		const { entries, groups } = buildDirectory(
			{ users: [user("alice", [[8, false]])], departments: DEPTS },
			BASE,
		);

		expect(groups).toBe(2);
		expect(find(entries, groupDn(12))).toBeUndefined();
		expect(find(entries, groupDn(20))).toBeUndefined();
		expect(find(entries, groupDn(21))).toBeUndefined();
		expect(values(find(entries, groupDn(8)), "member")).toEqual([
			personDn("u-alice"),
		]);
		expect(values(find(entries, groupDn(1)), "member")).toEqual([groupDn(8)]);
		expectImportable(entries);
	});

	it("一个人都没有时只剩两个容器条目", () => {
		const { entries } = buildDirectory({ users: [], departments: DEPTS }, BASE);
		expect(entries.map((e) => e.dn)).toEqual([
			`ou=people,${BASE}`,
			`ou=groups,${BASE}`,
		]);
		expectImportable(entries);
	});

	it("顺序：容器 → 人（按 uid）→ 部门（子部门在父部门之前）", () => {
		const { entries } = buildDirectory(
			{
				users: [
					user("carol", [[21, false]]),
					user("alice", [[12, false]]),
					user("bob", [[1, true]]),
				],
				departments: DEPTS,
			},
			BASE,
		);

		expect(entries.map((e) => e.dn)).toEqual([
			`ou=people,${BASE}`,
			`ou=groups,${BASE}`,
			personDn("u-alice"),
			personDn("u-bob"),
			personDn("u-carol"),
			groupDn(12),
			groupDn(8),
			groupDn(21),
			groupDn(20),
			groupDn(1),
		]);
		// 根部门：直属成员在前、子部门在后
		expect(values(find(entries, groupDn(1)), "member")).toEqual([
			personDn("u-bob"),
			groupDn(8),
			groupDn(20),
		]);
		expectImportable(entries);
	});

	it("多值按等值规则去重：同名部门的 ou 只留一条，职务大小写不同也算重复", () => {
		const departments: OrgApiDept[] = [
			...DEPTS,
			{ id: 30, parentId: 20, name: "乙组", ancestorIds: [1, 20] },
		];
		const alice = user("alice", [[12, false]], { titles: ["CEO", "ceo"] });
		alice.depts.push({ id: 30, name: "乙组", isLeader: false });
		const { entries } = buildDirectory({ users: [alice], departments }, BASE);
		const person = find(entries, personDn("u-alice"));

		expect(values(person, "ou")).toEqual(["乙组"]);
		expect(values(person, "departmentNumber")).toEqual(["12", "30"]);
		expect(values(person, "title")).toEqual(["CEO"]);
	});

	it("MUST 不缺：显示名为空时 cn / sn 退回 uid", () => {
		const { entries } = buildDirectory(
			{
				users: [user("alice", [[1, false]], { displayName: " " })],
				departments: DEPTS,
			},
			BASE,
		);
		expect(find(entries, personDn("u-alice"))?.attributes).toMatchObject({
			cn: ["alice"],
			sn: ["alice"],
			displayName: "alice",
		});
	});

	it("进不了标准属性的值不输出：非 ASCII 邮箱（mail 是 IA5）、带空白的头像地址", () => {
		const { entries } = buildDirectory(
			{
				users: [
					user("alice", [[1, false]], {
						email: "爱丽丝@example.com",
						avatar: "https://a.example.com/x y.png",
					}),
				],
				departments: DEPTS,
			},
			BASE,
		);
		const attrs = find(entries, personDn("u-alice"))?.attributes;
		expect(attrs).not.toHaveProperty("mail");
		expect(attrs).not.toHaveProperty("labeledURI");
	});

	it("unionid 里的特殊字符在 DN 里转义，属性值保持原文", () => {
		const { entries } = buildDirectory(
			{
				users: [user("alice", [[1, true]], { unionid: "a+b,c" })],
				departments: DEPTS,
			},
			BASE,
		);
		const dn = `dingtalkUnionId=a\\+b\\,c,ou=people,${BASE}`;
		expect(find(entries, dn)?.attributes.dingtalkUnionId).toBe("a+b,c");
		expect(values(find(entries, groupDn(1)), "owner")).toEqual([dn]);
	});

	it("DN 与属性值用同一个 trim 过的值；只有空白的当作没有 unionid", () => {
		const { entries, people } = buildDirectory(
			{
				users: [
					user("alice", [[1, false]], { unionid: " u-a " }),
					user("bob", [[1, false]], { unionid: "  " }),
				],
				departments: DEPTS,
			},
			BASE,
		);
		expect(people).toBe(1);
		expect(find(entries, personDn("u-a"))?.attributes.dingtalkUnionId).toBe(
			"u-a",
		);
	});
});

describe("escapeDnValue（RFC 4514）", () => {
	it.each([
		["plain", "plain"],
		['a"b+c,d;e<f>g\\h', 'a\\"b\\+c\\,d\\;e\\<f\\>g\\\\h'],
		["#lead", "\\#lead"],
		["mid#dle", "mid#dle"],
		[" lead", "\\ lead"],
		["trail ", "trail\\ "],
		["in side", "in side"],
		// 转义过的反斜杠之后的结尾空格仍要转义
		["x\\ ", "x\\\\\\ "],
		["a\0b", "a\\00b"],
	])("%j → %j", (raw, escaped) => {
		expect(escapeDnValue(raw)).toBe(escaped);
	});
});

describe("ldap/dingorg.ldif", () => {
	it("与 renderOpenLdapSchema 一致（改了属性定义要重新生成这个文件）", () => {
		const file = readFileSync(
			fileURLToPath(new URL("../../ldap/dingorg.ldif", import.meta.url)),
			"utf8",
		);
		expect(file).toBe(renderOpenLdapSchema());
	});

	it("只有 ASCII：整份文件交给 ldapadd", () => {
		expect(renderOpenLdapSchema()).toMatch(/^[\x20-\x7e\n]*$/);
	});
});
