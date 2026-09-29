import { DrizzleQueryError } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { DingtalkError } from "./dingtalk/client";
import { atLeast, LOGGER_OPTIONS } from "./log";

const SECRET = "d4f0c1a2-private-jwk-or-access-token";

// 生产那套选项写进内存
function capture(write: (log: pino.Logger) => void) {
	const lines: string[] = [];
	write(
		pino(
			{ ...LOGGER_OPTIONS, level: "info" },
			{ write: (s: string) => lines.push(s) },
		),
	);
	const line = lines.join("");
	return { line, obj: JSON.parse(line) };
}

function queryError() {
	return new DrizzleQueryError(
		'insert into "dingorg_app_secrets" ("key", "value") values ($1, $2)',
		["oidc:jwks", SECRET],
		new Error("Connection terminated unexpectedly"),
	);
}

describe("atLeast", () => {
	it("只往上抬：info → warn，error / silent 保持", () => {
		expect(atLeast("warn", "info")).toBe("warn");
		expect(atLeast("warn", "error")).toBe("error");
		expect(atLeast("warn", "silent")).toBe("silent");
	});
});

describe("根 logger 的输出", () => {
	it("级别是字符串、时间是 ISO", () => {
		const { obj } = capture((log) => log.info("hi"));
		expect(obj.level).toBe("info");
		expect(obj.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("DrizzleQueryError 的 SQL 参数不进日志，SQL 与底层原因保留", () => {
		const { line, obj } = capture((log) =>
			log.error({ err: queryError() }, "x"),
		);
		expect(line).not.toContain(SECRET);
		expect(obj.err.type).toBe("DrizzleQueryError");
		expect(obj.err.params).toBeUndefined();
		expect(obj.err.query).toContain("dingorg_app_secrets");
		expect(obj.err.message).toContain("Connection terminated unexpectedly");
		expect(obj.err.stack).toContain("    at ");
	});

	it("被别的错误包一层也挡得住，且不改动原错误", () => {
		const inner = queryError();
		const outer = new Error("刷新失败", { cause: inner });
		const { line, obj } = capture((log) => log.error({ err: outer }, "x"));
		expect(line).not.toContain(SECRET);
		expect(obj.err.message).toContain("刷新失败");
		expect(obj.err.message).toContain("Failed query");
		expect(outer.cause).toBe(inner);
		expect(inner.params).toContain(SECRET);
	});

	it("包了一层时，外层自己的 stack 还在", () => {
		const outer = new Error("刷新失败", { cause: queryError() });
		const { obj } = capture((log) => log.error({ err: outer }, "x"));
		const [own] = obj.err.stack.split("\ncaused by: ");
		expect(own).toMatch(/^Error: 刷新失败\n\s+at /);
	});

	it("AggregateError 与值为错误数组的字段里也挡得住", () => {
		const agg = new AggregateError([queryError()], "批量失败");
		const withField = Object.assign(new Error("x"), {
			failures: [queryError()],
		});
		for (const err of [agg, withField]) {
			const { line } = capture((log) => log.error({ err }, "x"));
			expect(line).not.toContain(SECRET);
		}
	});

	it("循环的 cause 链不会让记日志本身抛错", () => {
		const self = new Error("self");
		self.cause = self;
		const a = new Error("a", { cause: queryError() });
		(a.cause as Error).cause = a;
		for (const err of [self, a]) {
			const { line } = capture((log) => log.error({ err }, "x"));
			expect(line).not.toContain(SECRET);
		}
	});

	it("DingtalkError 的 endpoint 不带 query（旧版 oapi 的 access_token 在那里）", () => {
		const err = new DingtalkError("ip 不在白名单", {
			errcode: 60020,
			endpoint: `https://oapi.dingtalk.com/topapi/v2/user/list?access_token=${SECRET}`,
		});
		const { line, obj } = capture((log) => log.warn({ err }, "x"));
		expect(line).not.toContain(SECRET);
		expect(obj.err.endpoint).toBe(
			"https://oapi.dingtalk.com/topapi/v2/user/list",
		);
		expect(obj.err.errcode).toBe(60020);
	});
});
