import type { Database } from "~/db";

import { withAccessToken } from "./access-token";
import {
	type DingtalkCredentials,
	DingtalkError,
	getUserByUnionId,
	USER_NOT_FOUND_ERRCODE,
} from "./client";

/**
 * 实时问钉钉：这个 unionId 现在是不是本企业的内部员工。只报事实：钉钉出错照抛，退回同步结果
 * 是准入（`~/admission`）的决定，别在这里吞。
 */
export type Employment = "employee" | "not_employee";

export async function checkEmployment(
	db: Database,
	cred: DingtalkCredentials,
	unionId: string,
): Promise<Employment> {
	try {
		const user = await withAccessToken(db, cred, (token) =>
			getUserByUnionId(token, unionId),
		);
		// 外部联系人也查得到，只认 0。按字符串比：数字与 "0" 都收，而 `Number(null)`、
		// `Number("")` 也是 0
		const type = String(user?.contact_type);
		if (type === "0") return "employee";
		if (type === "1") return "not_employee";
		// ⚠️ 认不出的别当成「不是员工」：钉钉改个字段就把全员挡在外面
		throw new Error(`钉钉返回了认不出的 contact_type：${type}`);
	} catch (err) {
		if (
			err instanceof DingtalkError &&
			err.errcode === USER_NOT_FOUND_ERRCODE
		) {
			return "not_employee";
		}
		throw err;
	}
}
