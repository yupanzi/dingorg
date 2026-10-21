import { describe, expect, it } from "vitest";

import {
	type DingtalkUserFields,
	normalizeIdentity,
	splitDisplayName,
	toUserName,
} from "./org-identity";

// 只有「邮箱」兜底那组配兜底域名
const normalize = (u: DingtalkUserFields) => normalizeIdentity(u, []);

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
			normalize({ name: "x", org_email: "Bruce@Corp.example.com" }),
		).toEqual({ email: "bruce@corp.example.com", userName: "bruce" });
	});

	it("没有企业邮箱：email 为 null，**不按姓名推导**，userName 取显示名", () => {
		expect(normalize({ name: "WangWu(王五)" })).toEqual({
			email: null,
			userName: "wangwu",
		});
	});

	it("没配兜底域名：不读钉钉的 email 字段", () => {
		const member = { name: "zhaoliu(赵六)", email: "someone@gmail.com" };
		expect(normalize(member)).toEqual({
			email: null,
			userName: "zhaoliu",
		});
	});

	it("企业邮箱的脏值：尾部空格剥掉，不像邮箱的当没有", () => {
		expect(normalize({ name: "x", org_email: "  a@b.com  " })?.email).toBe(
			"a@b.com",
		);
		for (const bad of [
			"",
			"   ",
			"not-an-email",
			"@b.com",
			"a@",
			"a b@c.com",
		]) {
			expect(normalize({ name: "q(甲)", org_email: bad })).toEqual({
				email: null,
				userName: "q",
			});
		}
	});

	it("完全无法归一化时返回 null，而不是造一个假身份", () => {
		expect(normalize({ name: "" })).toBeNull();
		expect(normalize({ name: "(只有备注)" })).toBeNull();
		// 钉钉返回缺 name 的条目：跳过这个人，不能抛错拖垮整轮同步
		expect(normalize({ name: undefined as unknown as string })).toBeNull();
	});

	it("email 统一小写 —— 大小写差异会导致同一人被当成两个 subject", () => {
		const a = normalize({ name: "x", org_email: "A@B.com" });
		const b = normalize({ name: "x", org_email: "a@b.com" });
		expect(a).toEqual(b);
	});
});

describe("normalizeIdentity 的「邮箱」兜底", () => {
	const DOMAINS = ["corp.com"];

	it("企业邮箱缺失：取白名单域名下的「邮箱」，小写，userName 跟着它", () => {
		expect(
			normalizeIdentity(
				{ name: "Alice(甲)", email: "Alice.W@Corp.com" },
				DOMAINS,
			),
		).toEqual({ email: "alice.w@corp.com", userName: "alice.w" });
	});

	it("白名单的大小写不影响匹配（env 只校验格式，不改写）", () => {
		expect(
			normalizeIdentity({ name: "x", email: "a@corp.com" }, ["Corp.COM"])
				?.email,
		).toBe("a@corp.com");
	});

	it("企业邮箱不合法也兜底（如中间混了空格）", () => {
		expect(
			normalizeIdentity(
				{ name: "x", org_email: "bob @corp.com", email: "Bob@corp.com" },
				DOMAINS,
			)?.email,
		).toBe("bob@corp.com");
	});

	it("企业邮箱有效时它优先，「邮箱」不看", () => {
		expect(
			normalizeIdentity(
				{ name: "x", org_email: "a@corp.com", email: "b@corp.com" },
				DOMAINS,
			)?.email,
		).toBe("a@corp.com");
	});

	it("域名不在白名单（含子域名）、为空串或不像邮箱：不兜底", () => {
		for (const email of [
			"someone@gmail.com",
			"a@mail.corp.com",
			"",
			"not-an-email",
		]) {
			expect(normalizeIdentity({ name: "q(甲)", email }, DOMAINS)).toEqual({
				email: null,
				userName: "q",
			});
		}
	});
});

describe("toUserName", () => {
	it("剥掉域名并小写", () => {
		expect(toUserName("Alice@Example.com")).toBe("alice");
	});

	it("与 normalizeIdentity 对同一 email 得出同一个 userName", () => {
		const org_email = "Bob.Smith@Corp.com";
		expect(toUserName(org_email)).toBe(
			normalize({ name: "x", org_email })?.userName,
		);
	});
});
