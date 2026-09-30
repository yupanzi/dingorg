import {
	and,
	asc,
	eq,
	getTableColumns,
	isNotNull,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Database } from "~/db";
import {
	ORG_SYNC_ID,
	orgDepartments,
	orgSync,
	orgUserDepts,
	orgUsers,
} from "~/db/schema";
import type { OrgApiDept, OrgApiUser, OrgApiUserDept } from "~/domain/org-api";
import {
	buildOrgSync,
	compareCodeUnits,
	type FetchedOrg,
	type PrevOwner,
} from "~/domain/org-sync";
import { SYNC_COOLDOWN_MS, SYNC_LEASE_MS } from "~/domain/sync";

/**
 * 组织同步的全部 SQL：租约、整轮写入、读。编排（单飞、token、失败处理）在 `./org`。
 *
 * 时刻一律取 DB 时钟：租约与「谁更晚开始」要跨副本比先后，各 Pod 的时钟不可信。
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** 一次抢到的租约 */
export interface SyncLease {
	appKey: string;
	/** 每次尝试一个随机值：只认它释放租约 */
	holder: string;
	/** 抢到时的 DB 时刻，成功时写成 `fetched_at` */
	startedAt: Date;
}

/** 准入、REST、状态端点、整轮写入共用的判据，别各写各的：「自有应用、同步成功过」 */
function ownSynced(appKey: string): SQL {
	return and(
		eq(orgSync.id, ORG_SYNC_ID),
		eq(orgSync.appKey, appKey),
		isNotNull(orgSync.fetchedAt),
	) as SQL;
}

/** 当前成员；`left_at` 非空的行只留作记录 */
const isCurrent = isNull(orgUsers.leftAt);

export function interval(ms: number): SQL {
	return sql`make_interval(secs => ${ms / 1000})`;
}

// 抢租约与状态端点共用：orgsync 轮询 `syncing` 等的就是 `claimSync` 能抢到的那一刻
const leaseHeld = sql<boolean>`coalesce(${orgSync.leaseUntil} > now(), false)`;
/** null = 还没有哪次尝试结束 */
const cooldownEnd = sql`${orgSync.attemptedAt} + ${interval(SYNC_COOLDOWN_MS)}`;

/** 成功写入与记失败共用：更晚开始的一轮已落库时，旧的一轮既不能盖掉它，也不能把失败挂到它头上 */
function startedBefore(t: Date): SQL {
	return sql`(${orgSync.fetchedAt} is null or ${orgSync.fetchedAt} < ${t})`;
}

/** 只有租约是自己的才释放：租约过期后别人可能已经接手 */
function releaseLease(holder: string) {
	const mine = sql`${orgSync.leaseHolder} = ${holder}`;
	return {
		leaseHolder: sql`case when ${mine} then null else ${orgSync.leaseHolder} end`,
		leaseUntil: sql`case when ${mine} then null else ${orgSync.leaseUntil} end`,
	};
}

/**
 * 一条语句同时判「租约空闲或已过期」与「冷却已过」并占住租约，抢不到返回 null。
 * 别换成 advisory lock：会话锁要一直占着连接，而单池依赖拉取期间不占连接。
 * ⚠️ 这里永不写 `app_key`（见 `~/db/schema/org` 文件头）；空表时的 INSERT 例外，那时镜像表是空的。
 */
export async function claimSync(
	db: Database,
	appKey: string,
	holder: string,
): Promise<SyncLease | null> {
	const leaseUntil = sql`now() + ${interval(SYNC_LEASE_MS)}`;
	const [row] = await db
		.insert(orgSync)
		.values({ id: ORG_SYNC_ID, appKey, leaseHolder: holder, leaseUntil })
		.onConflictDoUpdate({
			target: orgSync.id,
			set: { leaseHolder: holder, leaseUntil },
			setWhere: sql`not ${leaseHeld} and coalesce(${cooldownEnd} <= now(), true)`,
		})
		// raw sql 的 timestamptz 回来是字符串，借列的映射转成 Date
		.returning({ startedAt: sql`now()`.mapWith(orgSync.fetchedAt) });
	return row ? { appKey, holder, startedAt: row.startedAt } : null;
}

export interface WriteResult {
	/** false = 一轮更晚开始的同步已经落库（租约过期后有人接手），这一轮作废 */
	written: boolean;
	/** 没进这一轮的成员及原因 */
	skipped: string[];
}

const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += CHUNK)
		out.push(rows.slice(i, i + CHUNK));
	return out;
}

/**
 * 整轮写入，一个事务：要么整轮换新，要么什么都没变。钉钉拉取在事务外做完（不占连接），
 * 事务里只用 `tx`。失败时由调用方在回滚之后另记 `recordSyncFailure`。
 * 状态行由 `claimSync` 建，这里只锁它。
 */
export async function writeOrgSync(
	db: Database,
	lease: SyncLease,
	fetched: FetchedOrg,
): Promise<WriteResult> {
	return await db.transaction(async (tx) => {
		// 锁住状态行：并发写入者在这里排队，后面的判定与读都以它为准
		const [state] = await tx
			.select({
				own: sql<boolean>`${ownSynced(lease.appKey)}`,
				current: sql<boolean>`${startedBefore(lease.startedAt)}`,
			})
			.from(orgSync)
			.where(eq(orgSync.id, ORG_SYNC_ID))
			.for("update");
		if (!state) throw new Error("组织同步状态行不存在，写入前要先 claimSync");
		if (!state.current) return { written: false, skipped: [] };

		const { data, skipped } = buildOrgSync(
			fetched,
			state.own ? await readPrevOwners(tx) : undefined,
		);

		// 删除顺序跟着外键走（外键不级联）
		await tx.delete(orgUserDepts);
		await tx.delete(orgDepartments);
		// 别的应用的数据（或从没成功过时的残留）连成员一起硬删，含已离开的行：
		// 别的企业的人不能以「离开」的身份留下来
		if (!state.own) await tx.delete(orgUsers);
		for (const part of chunks(data.departments)) {
			await tx.insert(orgDepartments).values(part);
		}

		// ⚠️ 先标离开再 upsert：重入职的人（新 userid、同一个 unionid）否则撞 unionid 唯一索引
		const ids = data.users.map((u) => u.dingtalk.userid);
		await tx
			.update(orgUsers)
			.set({ leftAt: sql`now()` })
			.where(
				and(
					isCurrent,
					sql`${orgUsers.userid} <> all(${sql.param(ids)}::text[])`,
				),
			);
		for (const part of chunks(data.users.map(toRow))) {
			await tx
				.insert(orgUsers)
				.values(part)
				.onConflictDoUpdate({ target: orgUsers.userid, set: UPSERT_SET });
		}

		const links = data.users.flatMap((u) =>
			u.depts.map((d) => ({
				userid: u.dingtalk.userid,
				deptId: d.id,
				isLeader: d.isLeader,
			})),
		);
		for (const part of chunks(links)) {
			await tx.insert(orgUserDepts).values(part);
		}

		await tx
			.update(orgSync)
			.set({
				appKey: lease.appKey,
				fetchedAt: lease.startedAt,
				// 事务开始的时刻，在拉取结束之后：冷却从尝试的结束算
				attemptedAt: sql`now()`,
				error: null,
				...releaseLease(lease.holder),
			})
			.where(eq(orgSync.id, ORG_SYNC_ID));

		return { written: true, skipped };
	});
}

async function readPrevOwners(tx: Tx): Promise<PrevOwner[]> {
	return await tx
		.select({
			userName: orgUsers.userName,
			dingtalk: { userid: orgUsers.userid, unionid: orgUsers.unionid },
		})
		.from(orgUsers)
		.where(isCurrent);
}

/**
 * 失败只记 `attempted_at` / `error` 并释放自己的租约，⚠️ 不动镜像表、`app_key`、`fetched_at`。
 * 自身出错吞掉，不能盖住原始错误。
 */
export async function recordSyncFailure(
	db: Database,
	lease: SyncLease,
	error: string,
): Promise<void> {
	await db
		.update(orgSync)
		.set({ attemptedAt: sql`now()`, error, ...releaseLease(lease.holder) })
		.where(and(eq(orgSync.id, ORG_SYNC_ID), startedBefore(lease.startedAt)))
		.catch(() => undefined);
}

// 列与 `OrgApiUser` 一一对应。⚠️ 加字段 = 加列 + 这里与 `fromRow` 两处
type UserRow = typeof orgUsers.$inferSelect;

function toRow(u: OrgApiUser): Required<typeof orgUsers.$inferInsert> {
	return {
		userid: u.dingtalk.userid,
		unionid: u.dingtalk.unionid,
		userName: u.userName,
		displayName: u.displayName,
		email: u.email,
		titles: u.titles,
		ranks: u.ranks,
		jobLevel: u.jobLevel,
		title: u.dingtalk.title,
		extension: u.dingtalk.extension,
		avatar: u.dingtalk.avatar,
		orgEmail: u.dingtalk.orgEmail,
		leftAt: null,
	};
}

// 整行换成这一轮的值（含把 `left_at` 清回 null）：回来的人不再算离开
const { userid: _pk, ...upsertColumns } = getTableColumns(orgUsers);
const UPSERT_SET = Object.fromEntries(
	Object.entries(upsertColumns).map(([key, col]) => [
		key,
		sql`excluded.${sql.identifier(col.name)}`,
	]),
);

function fromRow(r: UserRow, depts: OrgApiUserDept[]): OrgApiUser {
	return {
		userName: r.userName,
		displayName: r.displayName,
		email: r.email,
		depts,
		titles: r.titles,
		ranks: r.ranks,
		jobLevel: r.jobLevel,
		dingtalk: {
			userid: r.userid,
			unionid: r.unionid,
			title: r.title,
			extension: r.extension,
			avatar: r.avatar,
			orgEmail: r.orgEmail,
		},
	};
}

/** 读到的自有数据与它的数据时刻 */
export interface OrgRead<T> {
	fetchedAt: Date;
	items: T[];
}

/** 读路径的签名，`getOrSyncOrg` 收它 */
export type OrgReader<T> = (
	db: Database,
	appKey: string,
) => Promise<OrgRead<T> | null>;

/**
 * 读路径的共同外壳：自有应用同步成功过才跑 `query`，否则 null。状态行与镜像表分几条语句读，
 * 要落在同一个快照里：中途有一轮提交也不会读出半新半旧
 */
function readOwn<T>(query: (tx: Tx) => Promise<T[]>): OrgReader<T> {
	return (db, appKey) =>
		db.transaction(
			async (tx) => {
				const [row] = await tx
					.select({ fetchedAt: orgSync.fetchedAt })
					.from(orgSync)
					.where(ownSynced(appKey));
				if (!row?.fetchedAt) return null;
				return { fetchedAt: row.fetchedAt, items: await query(tx) };
			},
			{ isolationLevel: "repeatable read", accessMode: "read only" },
		);
}

/** 当前成员，按 userName 排序；自有应用没同步成功过时 null */
export const readOrgUsers = readOwn<OrgApiUser>(async (tx) => {
	const rows = await tx.select().from(orgUsers).where(isCurrent);
	const links = await tx
		.select({
			userid: orgUserDepts.userid,
			id: orgDepartments.id,
			name: orgDepartments.name,
			isLeader: orgUserDepts.isLeader,
		})
		.from(orgUserDepts)
		.innerJoin(orgDepartments, eq(orgUserDepts.deptId, orgDepartments.id))
		.orderBy(asc(orgDepartments.id));

	const deptsOf = new Map<string, OrgApiUserDept[]>();
	for (const { userid, ...dept } of links) {
		const list = deptsOf.get(userid);
		if (list) list.push(dept);
		else deptsOf.set(userid, [dept]);
	}
	return rows
		.map((r) => fromRow(r, deptsOf.get(r.userid) ?? []))
		.sort((a, b) => compareCodeUnits(a.userName, b.userName));
});

/** 部门，按 id 排序；自有应用没同步成功过时 null */
export const readOrgDepartments = readOwn<OrgApiDept>(
	async (tx) =>
		await tx
			.select({
				id: orgDepartments.id,
				parentId: orgDepartments.parentId,
				name: orgDepartments.name,
				ancestorIds: orgDepartments.ancestorIds,
			})
			.from(orgDepartments)
			.orderBy(asc(orgDepartments.id)),
);

/** OIDC 准入与 claim 用得上的那几项 */
export interface Member {
	userName: string;
	displayName: string;
	email: string | null;
	avatar: string | null;
}

/**
 * ⚠️ OIDC 准入的唯一判据：自有应用同步成功过、这个人是当前成员。已离开的、只出现在别的
 * 应用数据里的，都查不到。一次登录会调好几次 `findAccount`，走 unionid 的部分唯一索引。
 */
export async function findMember(
	db: Database,
	appKey: string,
	unionId: string,
): Promise<Member | undefined> {
	const [row] = await db
		.select({
			userName: orgUsers.userName,
			displayName: orgUsers.displayName,
			email: orgUsers.email,
			avatar: orgUsers.avatar,
		})
		.from(orgUsers)
		.innerJoin(orgSync, ownSynced(appKey))
		.where(and(eq(orgUsers.unionid, unionId), isCurrent))
		.limit(1);
	return row;
}

/** 从自有应用的角度看的同步状态 */
export interface SyncState {
	/** 自有应用最近成功那轮的开始时刻；null = 自有应用没有可用的数据 */
	fetchedAt: Date | null;
	attemptedAt: Date | null;
	error: string | null;
	/** 有人持着未过期的租约 */
	syncing: boolean;
	/** 距冷却结束还有多久，0 = 已过 */
	cooldownLeftMs: number;
	/** 状态行属于别的应用，且那边同步成功过（换过 `DINGTALK_APP_KEY`） */
	otherAppSynced: boolean;
	/** 只在自有数据可用时有值 */
	userCount: number | null;
	deptCount: number | null;
}

const NEVER: SyncState = {
	fetchedAt: null,
	attemptedAt: null,
	error: null,
	syncing: false,
	cooldownLeftMs: 0,
	otherAppSynced: false,
	userCount: null,
	deptCount: null,
};

/** 一条语句，不带镜像表的数据；计数与 REST 面同一个口径（当前成员） */
export async function readSyncState(
	db: Database,
	appKey: string,
): Promise<SyncState> {
	const [row] = await db
		.select({
			own: sql<boolean>`${ownSynced(appKey)}`,
			fetchedAt: orgSync.fetchedAt,
			attemptedAt: orgSync.attemptedAt,
			error: orgSync.error,
			syncing: leaseHeld,
			cooldownLeftMs:
				sql`coalesce(greatest(0, extract(epoch from ${cooldownEnd} - now()) * 1000), 0)`.mapWith(
					Number,
				),
			userCount:
				sql`(select count(*) from ${orgUsers} where ${isCurrent})`.mapWith(
					Number,
				),
			deptCount: sql`(select count(*) from ${orgDepartments})`.mapWith(Number),
		})
		.from(orgSync)
		.where(eq(orgSync.id, ORG_SYNC_ID));
	if (!row) return NEVER;

	const { own } = row;
	return {
		fetchedAt: own ? row.fetchedAt : null,
		attemptedAt: row.attemptedAt,
		error: row.error,
		syncing: row.syncing,
		cooldownLeftMs: Math.ceil(row.cooldownLeftMs),
		otherAppSynced: !own && row.fetchedAt !== null,
		userCount: own ? row.userCount : null,
		deptCount: own ? row.deptCount : null,
	};
}
