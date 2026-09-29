import { eq, getTableColumns, sql } from "drizzle-orm";
import type { Database } from "~/db";
import { orgSnapshots } from "~/db/schema";
import { invalidateAccessToken } from "~/dingtalk/access-token";
import { describeFailure, isTokenError } from "~/dingtalk/client";
import { fetchOrg } from "~/dingtalk/fetch-org";
import type { OrgApiUser } from "~/domain/org-api";
import { buildSnapshot, type OrgSnapshotData } from "~/domain/org-snapshot";
import { REFRESH_COOLDOWN_MS } from "~/domain/sync";
import type { Log } from "~/log";

/**
 * 组织快照的读与刷新：每个 appKey 一行、整份替换。
 *
 * 多副本并发刷新不需要锁：只有更晚开始的那份能覆盖（`fetched_at` 条件写），最坏白拉一次。
 */

type SnapshotRow = typeof orgSnapshots.$inferSelect;

export interface SnapshotDeps {
	db: Database;
	/** 传请求的 logger：带 reqId，才对得上审计的 `request_id` */
	log: Log;
}

export async function readSnapshot(
	db: Database,
	appKey: string,
): Promise<SnapshotRow | null> {
	const [row] = await db
		.select()
		.from(orgSnapshots)
		.where(eq(orgSnapshots.appKey, appKey))
		.limit(1);
	return row ?? null;
}

/** 不带 `data`：状态端点只报数，不必把整份 jsonb 搬回来 */
export type SnapshotMeta = Omit<SnapshotRow, "data">;
const { data: _data, ...metaColumns } = getTableColumns(orgSnapshots);

export async function readSnapshotMeta(
	db: Database,
	appKey: string,
): Promise<SnapshotMeta | null> {
	const [row] = await db
		.select(metaColumns)
		.from(orgSnapshots)
		.where(eq(orgSnapshots.appKey, appKey))
		.limit(1);
	return row ?? null;
}

/**
 * ⚠️ OIDC 准入只能拿自有 appKey 来查：别的应用的可见范围可能更宽，甚至属于别的企业。
 * 在 PG 里挑出那一个人：一次登录会调好几次 `findAccount`。
 */
export async function findMember(
	db: Database,
	appKey: string,
	unionId: string,
): Promise<OrgApiUser | undefined> {
	const { rows } = await db.execute<{ member: OrgApiUser }>(sql`
		select u as member
		from ${orgSnapshots}, jsonb_array_elements(${orgSnapshots.data} -> 'users') as u
		where ${orgSnapshots.appKey} = ${appKey}
			and u -> 'dingtalk' ->> 'unionid' = ${unionId}
		limit 1
	`);
	return rows[0]?.member;
}

type LoadedSnapshot = SnapshotRow & {
	data: OrgSnapshotData;
	fetchedAt: Date;
};

function isLoaded(row: SnapshotRow | null): row is LoadedSnapshot {
	return !!row?.data && !!row.fetchedAt;
}

export interface RefreshResult {
	row: LoadedSnapshot;
	/** false = 冷却期内，返回的是现有快照，没有外呼 */
	refreshed: boolean;
}

/** 从没拉成功过、又在冷却期内。`message` 可以回给调用方（原因经过 `describeFailure`） */
export class SnapshotUnavailableError extends Error {
	constructor(
		lastError: string | null,
		readonly retryAfterMs: number,
	) {
		super(
			`组织快照还没拉成功过，上次失败：${lastError ?? "未知"}；${Math.ceil(retryAfterMs / 1000)} 秒后可重试`,
		);
		this.name = "SnapshotUnavailableError";
	}
}

// 单飞键只用 appKey：走到这里的调用方都已通过鉴权，共享结果不越权
const inflight = new Map<string, Promise<RefreshResult>>();

/**
 * 并发合并成一次拉取；距上一次尝试（成功或失败）结束不到 `REFRESH_COOLDOWN_MS` 不外呼。
 * 失败时抛出，旧快照原样保留。
 */
export function refreshSnapshot(
	deps: SnapshotDeps,
	appKey: string,
	accessToken: string,
): Promise<RefreshResult> {
	const pending = inflight.get(appKey);
	if (pending) {
		deps.log.info({ appKey }, "合并到进行中的组织快照刷新");
		return pending;
	}

	const p = doRefresh(deps, appKey, accessToken).finally(() => {
		inflight.delete(appKey);
	});
	inflight.set(appKey, p);
	return p;
}

/** 有快照就原样返回（不管多旧），从没拉成功过才当场拉一次 */
export async function getOrFetchSnapshot(
	deps: SnapshotDeps,
	appKey: string,
	accessToken: string,
): Promise<LoadedSnapshot> {
	const row = await readSnapshot(deps.db, appKey);
	if (isLoaded(row)) return row;
	return (await refreshSnapshot(deps, appKey, accessToken)).row;
}

// 成功写与失败记录共用：失败记录不能挂到别的副本刚写成的新快照上
function startedBefore(t: Date) {
	return sql`${orgSnapshots.fetchedAt} is null or ${orgSnapshots.fetchedAt} < ${t}`;
}

async function doRefresh(
	deps: SnapshotDeps,
	appKey: string,
	accessToken: string,
): Promise<RefreshResult> {
	const current = await readSnapshot(deps.db, appKey);
	// 冷却看上一次尝试而非成功：否则拉不成功的 appKey 每读一次就重拉一次
	const wait = current
		? REFRESH_COOLDOWN_MS - (Date.now() - current.attemptedAt.getTime())
		: 0;
	if (wait > 0) {
		if (isLoaded(current)) return { row: current, refreshed: false };
		throw new SnapshotUnavailableError(current?.error ?? null, wait);
	}

	// 开始时刻：按它算数据年龄只会偏大；也是并发写的判据
	const startedAt = new Date();
	try {
		const built = buildSnapshot(
			await fetchOrg(accessToken),
			current?.data?.users,
		);
		if (built.skipped.length > 0) {
			deps.log.warn({ appKey, skipped: built.skipped }, "部分成员没进快照");
		}
		return {
			row: await writeSnapshot(deps, appKey, built, startedAt),
			refreshed: true,
		};
	} catch (err) {
		// ⚠️ `invalidateAccessToken` 唯一的生产调用方。不清的话坏 token 留在进程与 PG
		// 两级缓存里，可自愈的故障变成必须重启
		if (isTokenError(err)) {
			await invalidateAccessToken(deps.db, appKey, accessToken);
		}
		await recordFailure(deps.db, appKey, startedAt, describeFailure(err));
		throw err;
	}
}

/** `attemptedAt` 取结束时刻：冷却从它算，按开始算的话跑得久的拉取写完就出了冷却 */
async function writeSnapshot(
	deps: SnapshotDeps,
	appKey: string,
	built: ReturnType<typeof buildSnapshot>,
	startedAt: Date,
): Promise<LoadedSnapshot> {
	const values = {
		data: built.data,
		fetchedAt: startedAt,
		attemptedAt: new Date(),
		error: null,
		userCount: built.data.users.length,
		deptCount: built.data.departments.length,
	};
	const [written] = await deps.db
		.insert(orgSnapshots)
		.values({ appKey, ...values })
		.onConflictDoUpdate({
			target: orgSnapshots.appKey,
			set: values,
			setWhere: startedBefore(startedAt),
		})
		.returning();

	deps.log.info(
		{
			appKey,
			userCount: values.userCount,
			deptCount: values.deptCount,
			skippedCount: built.skipped.length,
			kept: written ? "mine" : "newer",
		},
		"组织快照已刷新",
	);

	// 被条件写挡下时 returning 为空：读回那份更新的
	const row = written ?? (await readSnapshot(deps.db, appKey));
	if (!isLoaded(row)) throw new Error(`组织快照写入后读不回来：${appKey}`);
	return row;
}

/**
 * 失败只记 `attempted_at` / `error`，⚠️ 不动 `data`（清掉自有快照 = 全员登录失败）。
 * `error` 会经状态端点回给调用方，只收 `describeFailure` 过的说法。自身出错吞掉，
 * 不能盖住原始错误。
 */
async function recordFailure(
	db: Database,
	appKey: string,
	startedAt: Date,
	error: string,
): Promise<void> {
	const attemptedAt = new Date();
	await db
		.insert(orgSnapshots)
		.values({ appKey, attemptedAt, error })
		.onConflictDoUpdate({
			target: orgSnapshots.appKey,
			set: { attemptedAt, error },
			setWhere: startedBefore(startedAt),
		})
		.catch(() => undefined);
}
