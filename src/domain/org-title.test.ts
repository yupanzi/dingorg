import { describe, expect, it } from "vitest";

import {
	extractRank,
	parseExtension,
	parseJobLevel,
	parseTitles,
	rankOrder,
	titleView,
} from "./org-title";

const ranksOf = (title: string) => titleView({ title }).ranks;

// 覆盖真实数据里的结构形态（分隔符混用、路径深度、`-`/`&`），名字一律虚构
describe("parseTitles", () => {
	it("全角分号分隔", () => {
		expect(parseTitles("董事长；首席执行官（CEO）")).toEqual([
			"董事长",
			"首席执行官（CEO）",
		]);
	});

	it("半角分号分隔", () => {
		expect(parseTitles("甲部副总经理;甲部-甲中心总监")).toEqual([
			"甲部副总经理",
			"甲部-甲中心总监",
		]);
	});

	it("同一条里混用全角与半角", () => {
		expect(
			parseTitles("甲部-乙中心总监；甲部-乙中心-丙组组长;甲部-乙中心-丁组组长"),
		).toEqual([
			"甲部-乙中心总监",
			"甲部-乙中心-丙组组长",
			"甲部-乙中心-丁组组长",
		]);
	});

	it("剥掉每条两端的空白", () => {
		expect(parseTitles(" 总监 ; 组长 ")).toEqual(["总监", "组长"]);
	});

	// 下游按条目批量写库时，同批重复键会让整批失败
	it("重复职务只保留一条，且保持首次出现的顺序", () => {
		expect(parseTitles("组长；总监;组长")).toEqual(["组长", "总监"]);
	});

	it("空串 / null / undefined 一律得到空数组", () => {
		expect(parseTitles("")).toEqual([]);
		expect(parseTitles(null)).toEqual([]);
		expect(parseTitles(undefined)).toEqual([]);
	});

	it("只有分隔符时不产出空字符串条目", () => {
		expect(parseTitles("；;、")).toEqual([]);
	});

	it("不拿 `-` 当分隔符", () => {
		expect(parseTitles("甲部-甲中心-甲组组长")).toEqual([
			"甲部-甲中心-甲组组长",
		]);
	});

	it("不拿 `&` 当分隔符（部门名里就有）", () => {
		expect(parseTitles("甲部-甲中心-甲&乙组组长")).toEqual([
			"甲部-甲中心-甲&乙组组长",
		]);
	});
});

describe("extractRank", () => {
	it("副职不被误判成正职", () => {
		expect(extractRank("甲部-甲中心副总监")).toBe("副总监");
		expect(extractRank("甲部-甲中心总监")).toBe("总监");
		expect(extractRank("甲部副总经理")).toBe("副总经理");
		expect(extractRank("甲部总经理")).toBe("总经理");
		expect(extractRank("甲部-丙中心-戊组副组长")).toBe("副组长");
		expect(extractRank("甲部-丙中心-戊组组长")).toBe("组长");
	});

	it("没有部门前缀也能取到", () => {
		expect(extractRank("技术总监")).toBe("总监");
		expect(extractRank("董事长")).toBe("董事长");
	});

	it("纯专业岗位没有职级词", () => {
		expect(extractRank("客户端开发工程师")).toBeNull();
		expect(extractRank("数据分析师")).toBeNull();
		expect(extractRank("UI 设计")).toBeNull();
	});

	it("职级词必须在末尾，出现在中间不算", () => {
		expect(extractRank("总监助理")).toBeNull();
	});
});

describe("titleView", () => {
	it("一人三职：职务条目全留，职级去重", () => {
		const v = titleView({
			title: "甲部-甲中心副总监;甲部-甲中心-甲组组长;甲部-甲中心-乙组组长",
		});
		expect(v.titles).toHaveLength(3);
		expect(v.ranks).toEqual(["副总监", "组长"]);
	});

	it("职级按层级从高到低排，与录入顺序无关", () => {
		expect(ranksOf("甲部-丙中心-己组组长；甲部-丙中心总监")).toEqual([
			"总监",
			"组长",
		]);
	});

	it("专业岗位没有职级，但职务条目仍在", () => {
		const v = titleView({ title: "客户端开发工程师" });
		expect(v.ranks).toEqual([]);
		expect(v.titles).toEqual(["客户端开发工程师"]);
	});

	it("一次调用同时给出两个派生值", () => {
		const v = titleView({
			title: "董事长；首席执行官（CEO）",
			jobLevel: "董事长",
		});
		expect(v).toEqual({
			titles: ["董事长", "首席执行官（CEO）"],
			ranks: ["董事长", "首席执行官（CEO）"],
		});
	});
});

describe("rankOrder", () => {
	it("正职排在同名副职之前", () => {
		expect(rankOrder("总监")).toBeLessThan(rankOrder("副总监"));
	});

	it("未知职级排在全部已知职级之后", () => {
		expect(rankOrder("首席铲屎官")).toBeGreaterThan(rankOrder("副组长"));
	});
});

describe("parseExtension", () => {
	it("解析出键值对", () => {
		expect(parseExtension('{"职务":"总监","座位编号":"A1-0101"}')).toEqual({
			职务: "总监",
			座位编号: "A1-0101",
		});
	});

	it("非法 JSON / 非对象一律 null，绝不抛出", () => {
		expect(parseExtension("{不是 JSON")).toBeNull();
		expect(parseExtension("null")).toBeNull();
		expect(parseExtension('"一个字符串"')).toBeNull();
		expect(parseExtension("123")).toBeNull();
		expect(parseExtension("[1,2]")).toBeNull();
	});

	it("空值一律 null", () => {
		expect(parseExtension("")).toBeNull();
		expect(parseExtension(null)).toBeNull();
		expect(parseExtension(undefined)).toBeNull();
	});
});

describe("parseJobLevel", () => {
	it("从 extension 取出「职务」", () => {
		expect(
			parseJobLevel('{"职务":"总监","座位编号":"A1-0102","英文名":"Ming"}'),
		).toBe("总监");
	});

	it("没有「职务」键时返回 null", () => {
		expect(parseJobLevel('{"座位编号":"A1-0102"}')).toBeNull();
	});

	it("「职务」为空串时返回 null 而不是空串", () => {
		expect(parseJobLevel('{"职务":"  "}')).toBeNull();
	});

	// 跑在快照组装的成员循环里：抛出去就是一个人的脏数据让整轮拉取失败
	it("非法 JSON 返回 null 而不是抛出", () => {
		expect(parseJobLevel("{不是 JSON")).toBeNull();
		expect(parseJobLevel("null")).toBeNull();
		expect(parseJobLevel('"一个字符串"')).toBeNull();
		expect(parseJobLevel("123")).toBeNull();
	});

	it("空值一律 null", () => {
		expect(parseJobLevel("")).toBeNull();
		expect(parseJobLevel(null)).toBeNull();
		expect(parseJobLevel(undefined)).toBeNull();
	});
});

describe("titleView 的职级三级回退", () => {
	it("优先用 title 解析出的职级", () => {
		expect(
			titleView({
				title: "甲部-丙中心总监；甲部-丙中心-己组组长",
				jobLevel: "总监",
			}).ranks,
		).toEqual(["总监", "组长"]);
	});

	// 这几档只出现在 extension 里
	it("title 无职级词时回退 jobLevel", () => {
		expect(titleView({ title: "顾问专家", jobLevel: "总监" }).ranks).toEqual([
			"总监",
		]);
		expect(titleView({ title: "数据分析师", jobLevel: "员工" }).ranks).toEqual([
			"员工",
		]);
	});

	it("两者都没有时返回空数组", () => {
		expect(titleView({ title: null, jobLevel: null }).ranks).toEqual([]);
		expect(titleView({}).ranks).toEqual([]);
		expect(titleView({ title: "数据分析师", jobLevel: "  " }).ranks).toEqual(
			[],
		);
	});
});
