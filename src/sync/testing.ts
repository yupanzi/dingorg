import { eq, sql } from "drizzle-orm";
import type { Database } from "~/db";
import {
	ORG_SYNC_ID,
	orgDepartments,
	orgSync,
	orgUserDepts,
	orgUsers,
} from "~/db/schema";
import type { OrgApiDept } from "~/domain/org-api";
import type { FetchedOrg, MemberFields } from "~/domain/org-sync";

import { interval, type WriteResult, writeOrgSync } from "./store";

/**
 * 集成测试共用：组织同步的表是全库一份，各测试文件都从空表起步（所以文件不能并行，见
 * `vitest.config.ts`）。只给测试 import。
 */

/** 回到「从没同步过」：清空镜像表与状态行（冷却、租约跟着清掉） */
export async function resetOrgSync(db: Database): Promise<void> {
	await db.delete(orgUserDepts);
	await db.delete(orgDepartments);
	await db.delete(orgUsers);
	await db.delete(orgSync);
}

export const ROOT_DEPT: OrgApiDept = {
	id: 1,
	parentId: null,
	name: "根部门",
	ancestorIds: [],
};

/** 身份齐全（有 unionid、企业邮箱）的成员 */
export function member(
	userid: string,
	opts: Partial<MemberFields> = {},
): MemberFields {
	return {
		userid,
		name: userid,
		org_email: `${userid}@x.com`,
		unionid: `union-${userid}`,
		...opts,
	};
}

/** 全员挂在根部门下的一轮拉取结果 */
export function fetchedOrg(members: MemberFields[]): FetchedOrg {
	return {
		departments: [ROOT_DEPT],
		membersByDept: [{ deptId: ROOT_DEPT.id, members }],
	};
}

/**
 * 不经租约直接写一轮，等同那个应用成功同步了一次。`fetched_at` 只有毫秒精度，连着灌两轮时
 * 先歇 2ms、再取 DB 时刻，后一轮才分得出更晚。
 */
export async function seedOrgSync(
	db: Database,
	appKey: string,
	fetched: FetchedOrg,
): Promise<WriteResult> {
	// 生产上状态行由 `claimSync` 建，这里绕过了它
	await db
		.insert(orgSync)
		.values({ id: ORG_SYNC_ID, appKey })
		.onConflictDoNothing();
	await new Promise((r) => setTimeout(r, 2));
	const { rows } = await db.execute<{ now: string }>(sql`select now() as now`);
	const startedAt = new Date(rows[0]?.now ?? Date.now());
	return await writeOrgSync(db, { appKey, holder: "seed", startedAt }, fetched);
}

/** 把上一次尝试（与成功那轮，若有）拨到 `ms` 之前：冷却按 DB 时钟算，拨也用 DB 时钟 */
export async function ageOrgSync(
	db: Database,
	ms: number,
	opts: { fetched?: boolean } = {},
): Promise<void> {
	const ago = sql`now() - ${interval(ms)}`;
	await db.update(orgSync).set({
		attemptedAt: ago,
		// 从没成功过的行 `fetched_at` 必须保持为空
		...(opts.fetched
			? {
					fetchedAt: sql`case when ${orgSync.fetchedAt} is null then null else ${ago} end`,
				}
			: {}),
	});
}

/** 假装别处持着租约；`ms` 为负即已过期的租约 */
export async function holdLease(
	db: Database,
	appKey: string,
	ms: number,
): Promise<void> {
	const until = sql`now() + ${interval(ms)}`;
	await db
		.insert(orgSync)
		.values({ appKey, leaseHolder: "elsewhere", leaseUntil: until })
		.onConflictDoUpdate({
			target: orgSync.id,
			set: { leaseHolder: "elsewhere", leaseUntil: until },
		});
}

/** 当前的租约持有者；没有状态行或没人持有时 null */
export async function leaseHolder(db: Database): Promise<string | null> {
	const [row] = await db
		.select({ holder: orgSync.leaseHolder })
		.from(orgSync)
		.where(eq(orgSync.id, ORG_SYNC_ID));
	return row?.holder ?? null;
}
