import type { OrgApiDept } from "~/domain/org-api";
import type { FetchedOrg } from "~/domain/org-snapshot";

import { getDept, listDeptUsersV2, listSubDepts } from "./client";

/**
 * 组织全量拉取，只读钉钉、不碰库。串行调用：钉钉按应用限 QPS，一次全量约「部门数 × 2」次。
 * 层级用 parentId / ancestorIds 表达，别拼成 `公司-部门` 字符串再 split（部门名里有 `-`）。
 */

const ROOT_DEPT_ID = 1;
const ROOT_DEPT_FALLBACK_NAME = "根部门";

export async function fetchOrg(accessToken: string): Promise<FetchedOrg> {
	const departments: OrgApiDept[] = [
		{
			id: ROOT_DEPT_ID,
			parentId: null,
			name: await resolveRootDeptName(accessToken),
			ancestorIds: [],
		},
	];
	await walkDepts(accessToken, ROOT_DEPT_ID, [ROOT_DEPT_ID], departments);

	// ⚠️ 任一部门失败就放弃整轮：快照整份替换，少一个部门 = 静默把那批人踢出 OIDC
	const membersByDept: FetchedOrg["membersByDept"] = [];
	for (const dept of departments) {
		membersByDept.push({
			deptId: dept.id,
			members: await listDeptUsersV2(accessToken, dept.id),
		});
	}

	return { departments, membersByDept };
}

// 根部门名 = 企业名称。纯展示字段，失败回退而不是让整轮失败
async function resolveRootDeptName(accessToken: string): Promise<string> {
	try {
		const { name } = await getDept(accessToken, ROOT_DEPT_ID);
		return name.trim() || ROOT_DEPT_FALLBACK_NAME;
	} catch {
		return ROOT_DEPT_FALLBACK_NAME;
	}
}

/** 深度优先，`ancestors` 含各级上级、不含自身 */
async function walkDepts(
	accessToken: string,
	parentId: number,
	ancestors: number[],
	out: OrgApiDept[],
): Promise<void> {
	const subs = await listSubDepts(accessToken, parentId);
	for (const sub of subs) {
		out.push({
			id: sub.deptId,
			parentId,
			name: sub.name,
			ancestorIds: ancestors,
		});
		await walkDepts(accessToken, sub.deptId, [...ancestors, sub.deptId], out);
	}
}
