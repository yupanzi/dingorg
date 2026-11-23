import { describe, expect, it } from "vitest";

import { directoryToLdif } from "./ldap-directory";
import { serializeLdif } from "./ldif";
import type { OrgApiDirectoryEntry } from "./org-api";

const one = (name: string, value: string) =>
	serializeLdif([{ dn: "cn=x", attributes: [[name, value]] }]).split("\n")[3];

/** RFC 2849 的反折行：续行去掉开头那一个空格接回上一行 */
const unfold = (ldif: string) => ldif.replace(/\n /g, "");
const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");

describe("serializeLdif（RFC 2849）", () => {
	it("SAFE-STRING 原样写", () => {
		expect(one("uid", "alice")).toBe("uid: alice");
		expect(one("cn", "in side:ok<")).toBe("cn: in side:ok<");
	});

	it.each([
		["非 ASCII", "爱丽丝"],
		["首字符是空格", " lead"],
		["首字符是冒号", ":x"],
		["首字符是 <", "<x"],
		["结尾是空格", "trail "],
		["含换行", "a\nb"],
		["空串之外的 NUL", "a\0b"],
	])("%s → base64", (_, value) => {
		expect(one("cn", value)).toBe(`cn:: ${b64(value)}`);
	});

	it("超过 76 列折行：续行以一个空格开头，反折行后还原", () => {
		const value = "x".repeat(200);
		const ldif = serializeLdif([{ dn: "cn=x", attributes: [["cn", value]] }]);

		for (const line of ldif.split("\n"))
			expect(line.length).toBeLessThanOrEqual(76);
		expect(unfold(ldif)).toContain(`cn: ${value}`);
	});

	it("version 行在最前，注释跟在后面，记录之间空一行，以换行结尾", () => {
		expect(
			serializeLdif(
				[
					{ dn: "cn=a", attributes: [["cn", "a"]] },
					{ dn: "cn=b", attributes: [] },
				],
				["hello"],
			),
		).toBe("version: 1\n# hello\n\ndn: cn=a\ncn: a\n\ndn: cn=b\n");
	});

	it("注释只收 ASCII 单行：换行会把注释后面的内容变成记录", () => {
		expect(() => serializeLdif([], ["a\ndn: cn=evil"])).toThrow();
		expect(() => serializeLdif([], ["中文"])).toThrow();
	});
});

describe("directoryToLdif", () => {
	const entries: OrgApiDirectoryEntry[] = [
		{
			dn: "cn=a,dc=x",
			attributes: {
				cn: ["a"],
				displayName: "爱丽丝",
				title: ["董事长", "首席执行官（CEO）"],
				memberOf: ["cn=g,dc=x"],
			},
		},
		{ dn: "cn=g,dc=x", attributes: { cn: ["g"], member: ["cn=a,dc=x"] } },
	];
	const ldif = unfold(
		directoryToLdif(entries, {
			baseDn: "dc=x",
			fetchedAt: "2026-11-23T00:00:00.000Z",
		}),
	);

	it("条目与顺序同输入，开头的注释带 baseDn 与 fetchedAt", () => {
		expect([...ldif.matchAll(/^dn: (.*)$/gm)].map((m) => m[1])).toEqual([
			"cn=a,dc=x",
			"cn=g,dc=x",
		]);
		expect(
			ldif.startsWith(
				"version: 1\n# baseDn: dc=x\n# fetchedAt: 2026-11-23T00:00:00.000Z\n",
			),
		).toBe(true);
	});

	it("多值属性展开成多行，单值属性一行", () => {
		expect(ldif).toContain(
			`title:: ${b64("董事长")}\ntitle:: ${b64("首席执行官（CEO）")}\n`,
		);
		expect(ldif).toContain(`displayName:: ${b64("爱丽丝")}\n`);
		expect(ldif).toContain("member: cn=a,dc=x\n");
	});

	it("运营属性 memberOf 不写：导入时由服务器算", () => {
		expect(ldif).not.toMatch(/^memberOf/m);
	});
});
