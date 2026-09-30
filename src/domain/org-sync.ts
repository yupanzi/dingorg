/**
 * 一次全量拉取 → 这一轮的部门与当前成员（形状即对外 API 的响应本体，落库见 `~/sync/store`）。
 * 每次从当次返回重建，只有 userName 撞名要看上一轮（`pickOwner`）。
 */

import type { OrgApiDept, OrgApiUser, OrgApiUserDept } from "./org-api";
import {
	type DingtalkUserFields,
	type NormalizedIdentity,
	normalizeIdentity,
} from "./org-identity";
import { parseExtension, parseJobLevel, titleView } from "./org-title";

export interface OrgData {
	departments: OrgApiDept[];
	users: OrgApiUser[];
}

/**
 * `DeptUser` 的子集，domain 不依赖 IO 层所以自己声明。⚠️ 给 `DeptUser` 加字段却忘了
 * 加进这里不是类型错误，那个字段只是永远同步不进来。
 */
export interface MemberFields extends DingtalkUserFields {
	userid: string;
	unionid?: string;
	avatar?: string;
	title?: string;
	extension?: string;
	/** ⚠️ 相对请求里的 dept_id，不是全局的 */
	leader?: boolean;
}

export interface FetchedOrg {
	departments: OrgApiDept[];
	membersByDept: Array<{ deptId: number; members: MemberFields[] }>;
}

export interface BuildResult {
	data: OrgData;
	/** 没进这一轮的成员及原因，供调用方告警 */
	skipped: string[];
}

/** 撞名裁决只看这几项；与 `OrgApiUser` 结构兼容 */
export interface PrevOwner {
	userName: string;
	dingtalk: Pick<OrgApiUser["dingtalk"], "userid" | "unionid">;
}

/** @param prevOwners 上一轮的当前成员（不含已离开的），只用于撞名时认原持有者 */
export function buildOrgSync(
	fetched: FetchedOrg,
	prevOwners: readonly PrevOwner[] | undefined,
): BuildResult {
	const deptName = new Map(fetched.departments.map((d) => [d.id, d.name]));
	const skipped: string[] = [];

	// 一人挂 N 个部门就出现 N 次，按 userid 合并。`leader` 相对部门，只能挂在部门关系上
	const merged = new Map<
		string,
		{ member: MemberFields; depts: Map<number, boolean> }
	>();
	for (const { deptId, members } of fetched.membersByDept) {
		for (const m of members) {
			let entry = merged.get(m.userid);
			if (!entry) {
				entry = { member: m, depts: new Map() };
				merged.set(m.userid, entry);
			}
			entry.depts.set(deptId, m.leader ?? false);
		}
	}

	const byUserName = new Map<string, OrgApiUser[]>();
	for (const { member, depts } of merged.values()) {
		const identity = normalizeIdentity(member);
		if (!identity) {
			skipped.push(`${member.name}(${member.userid}): 无法归一化身份`);
			continue;
		}
		const user = toUser(member, identity, depts, deptName);
		const group = byUserName.get(user.userName);
		if (group) group.push(user);
		else byUserName.set(user.userName, [user]);
	}

	const prevOwner = new Map(
		(prevOwners ?? []).map((u) => [u.userName, u.dingtalk] as const),
	);
	const users: OrgApiUser[] = [];
	for (const [userName, group] of byUserName) {
		const owner = pickOwner(group, prevOwner.get(userName));
		users.push(owner);
		for (const u of group) {
			if (u === owner) continue;
			skipped.push(
				`${u.displayName}(${u.dingtalk.userid}): userName「${userName}」已归 ${owner.dingtalk.userid}`,
			);
		}
	}

	return {
		data: {
			departments: [...fetched.departments].sort((a, b) => a.id - b.id),
			users: users.sort((a, b) => compareCodeUnits(a.userName, b.userName)),
		},
		skipped,
	};
}

/**
 * userName 撞名时谁留下：原持有者优先（先认 unionid 再认 userid，重入职的人 userid 会变）；
 * 没有原持有者按 userid 取第一个，结果不随钉钉的返回顺序来回易主。
 */
function pickOwner(
	group: OrgApiUser[],
	prev: PrevOwner["dingtalk"] | undefined,
): OrgApiUser {
	const incumbent = prev
		? group.find(
				(u) =>
					(prev.unionid !== null && u.dingtalk.unionid === prev.unionid) ||
					u.dingtalk.userid === prev.userid,
			)
		: undefined;
	if (incumbent) return incumbent;

	const [first] = [...group].sort((a, b) =>
		compareCodeUnits(a.dingtalk.userid, b.dingtalk.userid),
	);
	return first as OrgApiUser;
}

function toUser(
	m: MemberFields,
	identity: NormalizedIdentity,
	depts: Map<number, boolean>,
	deptName: Map<number, string>,
): OrgApiUser {
	// `|| null` 同时吃掉「键不存在」与「空串」两种缺失
	const title = m.title?.trim() || null;
	const jobLevel = parseJobLevel(m.extension);
	const { titles, ranks } = titleView({ title, jobLevel });

	const userDepts: OrgApiUserDept[] = [];
	for (const [id, isLeader] of depts) {
		const name = deptName.get(id);
		if (name !== undefined) userDepts.push({ id, name, isLeader });
	}
	// 与读路径（`~/sync/store`）同一个顺序：否则同一份数据写进去、读出来顺序不同
	userDepts.sort((a, b) => a.id - b.id);

	return {
		userName: identity.userName,
		displayName: m.name,
		email: identity.email,
		depts: userDepts,
		titles,
		ranks,
		jobLevel,
		dingtalk: {
			userid: m.userid,
			unionid: m.unionid || null,
			title,
			extension: parseExtension(m.extension),
			avatar: m.avatar || null,
			orgEmail: m.org_email?.trim() || null,
		},
	};
}

/** 按 UTF-16 码元比较，不受 locale 影响。读路径排序也用它，别换成 SQL 的 collation */
export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
