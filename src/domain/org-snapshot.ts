/**
 * 一次全量拉取 → `org_snapshots.data`（即对外 API 的响应本体）。每次从当次返回重建，
 * 只有 userName 撞名要看上一版（`pickOwner`）。
 */

import type { OrgApiDept, OrgApiUser, OrgApiUserDept } from "./org-api";
import {
	type DingtalkUserFields,
	type NormalizedIdentity,
	normalizeIdentity,
} from "./org-identity";
import { parseExtension, parseJobLevel, titleView } from "./org-title";

export interface OrgSnapshotData {
	departments: OrgApiDept[];
	users: OrgApiUser[];
}

/**
 * `DeptUser` 的子集，domain 不依赖 IO 层所以自己声明。⚠️ 给 `DeptUser` 加字段却忘了
 * 加进这里不是类型错误，那个字段只是永远进不了快照。
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
	data: OrgSnapshotData;
	/** 没进快照的成员及原因，供调用方告警 */
	skipped: string[];
}

/** @param prevUsers 上一版快照的成员，只用于撞名时认原持有者 */
export function buildSnapshot(
	fetched: FetchedOrg,
	prevUsers: readonly OrgApiUser[] | undefined,
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
		(prevUsers ?? []).map((u) => [u.userName, u.dingtalk] as const),
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
			users: users.sort((a, b) => compare(a.userName, b.userName)),
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
	prev: OrgApiUser["dingtalk"] | undefined,
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
		compare(a.dingtalk.userid, b.dingtalk.userid),
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

/** 按码点比较，不受 locale 影响 */
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
