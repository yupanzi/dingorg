import { afterEach, describe, expect, it, vi } from "vitest";

import { DingtalkError, getUserByUnionId, isTokenError } from "./client";

/**
 * 钉住 token 失效的判定：判不出来，`withAccessToken` 就清不掉坏 token。topapi 的那条走真的
 * `postJson`（只 stub fetch），响应体照钉钉实际回的抄。
 */
describe("isTokenError", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("topapi：errcode 88 + sub_code 40014（钉钉对坏 token 的实际回法）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							errcode: 88,
							sub_code: "40014",
							sub_msg: "不合法的access_token",
							errmsg:
								"ding talk error[subcode=40014,submsg=不合法的access_token]",
						}),
					),
			),
		);
		const err = await getUserByUnionId("bad-token", "u").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(DingtalkError);
		expect(isTokenError(err)).toBe(true);
	});

	it.each([
		["顶层 40014", { errcode: 40014 }, true],
		["顶层 42001", { errcode: 42001 }, true],
		["88 + sub_code 42001", { errcode: 88, subCode: "42001" }, true],
		// token 为空、缺权限点之类：换一把 token 也不会好
		["88 + sub_code 40000", { errcode: 88, subCode: "40000" }, false],
		["88 没有 sub_code", { errcode: 88 }, false],
		["新版 api 的 401", { status: 401 }, true],
		[
			"缺权限点（403）",
			{
				code: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
				status: 403,
			},
			false,
		],
	])("%s → %s", (_name, init, expected) => {
		expect(isTokenError(new DingtalkError("x", init))).toBe(expected);
	});
});
