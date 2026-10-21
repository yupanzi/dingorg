import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "~/db";

import {
	DingtalkError,
	getUserByUnionId,
	USER_NOT_FOUND_ERRCODE,
} from "./client";
import { checkEmployment } from "./employment";

/**
 * 钉住：只有 `contact_type` 0 算员工（外部联系人也查得到）；查无此人是「不是员工」而不是错误；
 * 其余错误与认不出的 `contact_type` 照抛（降级是准入的事）。token 失效的清理在
 * `withAccessToken`，由它的测试钉住；这里只钉调用确实在它里面。
 */
/** 经过 `withAccessToken` 的错：它只清得掉在它里面抛出的 token 失效 */
const seenByWrapper: unknown[] = [];
vi.mock("./access-token", () => ({
	withAccessToken: vi.fn(
		async (_db: unknown, _cred: unknown, fn: (t: string) => unknown) => {
			try {
				return await fn("itest-token");
			} catch (err) {
				seenByWrapper.push(err);
				throw err;
			}
		},
	),
}));
vi.mock("./client", async (importOriginal) => ({
	...(await importOriginal<typeof import("./client")>()),
	getUserByUnionId: vi.fn(),
}));

// token 层已 mock，库不会被碰到
const db = {} as Database;
const CRED = { clientId: "itest-employment-app", clientSecret: "x" };

describe("checkEmployment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		seenByWrapper.length = 0;
	});

	it.each([
		[0, "employee"],
		["0", "employee"],
		[1, "not_employee"],
		["1", "not_employee"],
	])("contact_type %j → %s", async (contactType, expected) => {
		vi.mocked(getUserByUnionId).mockResolvedValueOnce({
			userid: "itest-userid",
			contact_type: contactType,
		});
		await expect(checkEmployment(db, CRED, "itest-union")).resolves.toBe(
			expected,
		);
	});

	// 当成「不是员工」会把全员挡在外面；抛出去，准入退回同步结果
	it.each([null, "", undefined, 2])(
		"contact_type %j 认不出 → 抛",
		async (contactType) => {
			vi.mocked(getUserByUnionId).mockResolvedValueOnce({
				userid: "itest-userid",
				contact_type: contactType as number,
			});
			await expect(checkEmployment(db, CRED, "itest-union")).rejects.toThrow(
				"认不出的 contact_type",
			);
		},
	);

	it("钉钉没给 result → 抛", async () => {
		vi.mocked(getUserByUnionId).mockResolvedValueOnce(
			undefined as unknown as Awaited<ReturnType<typeof getUserByUnionId>>,
		);
		await expect(checkEmployment(db, CRED, "itest-union")).rejects.toThrow(
			"认不出的 contact_type",
		);
	});

	it("查无此人（60121，含已离职）→ 不是员工，不抛", async () => {
		vi.mocked(getUserByUnionId).mockRejectedValueOnce(
			new DingtalkError("找不到该用户", { errcode: USER_NOT_FOUND_ERRCODE }),
		);
		await expect(checkEmployment(db, CRED, "itest-union")).resolves.toBe(
			"not_employee",
		);
	});

	it("其他钉钉错误照抛", async () => {
		// -1 是该接口文档里的「系统繁忙」
		const err = new DingtalkError("系统繁忙", { errcode: -1 });
		vi.mocked(getUserByUnionId).mockRejectedValueOnce(err);

		await expect(checkEmployment(db, CRED, "itest-union")).rejects.toBe(err);
	});

	// 在外面调（先从 wrapper 里拿出 token）类型照过，token 失效就再也清不掉
	it("查询在 withAccessToken 里调：钉钉的错经过它", async () => {
		const err = new DingtalkError("不合法的access_token", {
			errcode: 88,
			subCode: "40014",
		});
		vi.mocked(getUserByUnionId).mockRejectedValueOnce(err);

		await expect(checkEmployment(db, CRED, "itest-union")).rejects.toBe(err);
		expect(seenByWrapper).toEqual([err]);
	});
});
