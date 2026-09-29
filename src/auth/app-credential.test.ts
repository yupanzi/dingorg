import { describe, expect, it } from "vitest";
import { MAX_ACTOR_ID_LENGTH } from "~/domain/audit";

import { parseBasicAuth, VerifyLimiter } from "./app-credential";

const basic = (raw: string) => `Basic ${Buffer.from(raw).toString("base64")}`;

describe("parseBasicAuth", () => {
	it("解析出 appKey 与 appSecret", () => {
		expect(parseBasicAuth(basic("key:secret"))).toEqual({
			appKey: "key",
			appSecret: "secret",
		});
	});

	it("在第一个冒号处切：secret 里可以有冒号", () => {
		expect(parseBasicAuth(basic("key:a:b"))).toEqual({
			appKey: "key",
			appSecret: "a:b",
		});
	});

	it("appKey 恰好顶到审计列宽：放行", () => {
		const appKey = "k".repeat(MAX_ACTOR_ID_LENGTH);
		expect(parseBasicAuth(basic(`${appKey}:s`))?.appKey).toBe(appKey);
	});

	it.each([
		["没带头", undefined],
		["不是 Basic", "Bearer abc"],
		["没有冒号", basic("keyonly")],
		["appKey 为空", basic(":secret")],
		["secret 为空", basic("key:")],
		["appKey 超过审计列宽", basic(`${"k".repeat(MAX_ACTOR_ID_LENGTH + 1)}:s`)],
		["appKey 带 NUL", basic("ke\u0000y:s")],
		["appKey 带换行", basic("ke\ny:s")],
	])("%s → null", (_, header) => {
		expect(parseBasicAuth(header)).toBeNull();
	});
});

describe("VerifyLimiter", () => {
	function setup(opts = { perAppCooldownMs: 10_000, perMinute: 30 }) {
		let t = 1_000_000;
		const lim = new VerifyLimiter(opts, () => t);
		return {
			lim,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	it("某个 appKey 校验失败后冷却，冷却期内不再外呼", () => {
		const { lim, advance } = setup();
		expect(lim.tryAcquire("a", false)).toBe(true);
		lim.recordFailure("a", false);

		expect(lim.tryAcquire("a", false)).toBe(false);
		advance(10_000);
		expect(lim.tryAcquire("a", false)).toBe(true);
	});

	it("一个 appKey 的冷却不波及别的 appKey", () => {
		const { lim } = setup();
		lim.recordFailure("a", false);
		expect(lim.tryAcquire("b", false)).toBe(true);
	});

	it("全局每分钟封顶，过了窗口恢复", () => {
		const { lim, advance } = setup({ perAppCooldownMs: 10_000, perMinute: 2 });
		expect(lim.tryAcquire("x1", false)).toBe(true);
		expect(lim.tryAcquire("x2", false)).toBe(true);
		expect(lim.tryAcquire("x3", false)).toBe(false);

		advance(60_000);
		expect(lim.tryAcquire("x3", false)).toBe(true);
	});

	it("续期不占全局名额：名额被撒网用光，到期的应用照样续得上", () => {
		const { lim } = setup({ perAppCooldownMs: 10_000, perMinute: 2 });
		lim.tryAcquire("x1", false);
		lim.tryAcquire("x2", false);
		expect(lim.tryAcquire("x3", false)).toBe(false);

		expect(lim.tryAcquire("real", true)).toBe(true);
	});

	it("新凭证的失败冷却不牵连同一 appKey 的续期", () => {
		const { lim } = setup();
		lim.recordFailure("real", false);

		expect(lim.tryAcquire("real", false)).toBe(false);
		expect(lim.tryAcquire("real", true)).toBe(true);
	});

	it("续期自己失败后也冷却：secret 重置后，旧 secret 不能反复续期", () => {
		const { lim, advance } = setup();
		lim.recordFailure("real", true);

		expect(lim.tryAcquire("real", true)).toBe(false);
		advance(10_000);
		expect(lim.tryAcquire("real", true)).toBe(true);
	});
});
