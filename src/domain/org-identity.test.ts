import { describe, expect, it } from "vitest";

import {
	normalizeIdentity,
	splitDisplayName,
	toUserName,
} from "./org-identity";

describe("splitDisplayName", () => {
	it("去掉半角括号备注", () => {
		expect(splitDisplayName("zhangsan(张三)")).toBe("zhangsan");
	});
	it("去掉全角括号备注", () => {
		expect(splitDisplayName("lisi（李四）")).toBe("lisi");
	});
	it("无括号时原样返回", () => {
		expect(splitDisplayName("alice")).toBe("alice");
	});
});

describe("normalizeIdentity", () => {
	it("有企业邮箱：email 与 userName 都取自它", () => {
		expect(
			normalizeIdentity({ name: "x", org_email: "Bruce@Corp.example.com" }),
		).toEqual({ email: "bruce@corp.example.com", userName: "bruce" });
	});

	it("没有企业邮箱：email 为 null，**不按姓名推导**，userName 取显示名", () => {
		expect(normalizeIdentity({ name: "WangWu(王五)" })).toEqual({
			email: null,
			userName: "wangwu",
		});
	});

	it("不读钉钉的 email 字段", () => {
		const member = { name: "zhaoliu(赵六)", email: "someone@gmail.com" };
		expect(normalizeIdentity(member)).toEqual({
			email: null,
			userName: "zhaoliu",
		});
	});

	it("企业邮箱的脏值：尾部空格剥掉，不像邮箱的当没有", () => {
		expect(
			normalizeIdentity({ name: "x", org_email: "  a@b.com  " })?.email,
		).toBe("a@b.com");
		for (const bad of [
			"",
			"   ",
			"not-an-email",
			"@b.com",
			"a@",
			"a b@c.com",
		]) {
			expect(normalizeIdentity({ name: "q(甲)", org_email: bad })).toEqual({
				email: null,
				userName: "q",
			});
		}
	});

	it("完全无法归一化时返回 null，而不是造一个假身份", () => {
		expect(normalizeIdentity({ name: "" })).toBeNull();
		expect(normalizeIdentity({ name: "(只有备注)" })).toBeNull();
		// 钉钉返回缺 name 的条目：跳过这个人，不能抛错拖垮整轮同步
		expect(
			normalizeIdentity({ name: undefined as unknown as string }),
		).toBeNull();
	});

	it("email 统一小写 —— 大小写差异会导致同一人被当成两个 subject", () => {
		const a = normalizeIdentity({ name: "x", org_email: "A@B.com" });
		const b = normalizeIdentity({ name: "x", org_email: "a@b.com" });
		expect(a).toEqual(b);
	});
});

describe("toUserName", () => {
	it("剥掉域名并小写", () => {
		expect(toUserName("Alice@Example.com")).toBe("alice");
	});

	it("与 normalizeIdentity 对同一 email 得出同一个 userName", () => {
		const org_email = "Bob.Smith@Corp.com";
		expect(toUserName(org_email)).toBe(
			normalizeIdentity({ name: "x", org_email })?.userName,
		);
	});
});
