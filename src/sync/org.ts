import { randomUUID } from "node:crypto";

import type { Database } from "~/db";
import { getAccessToken, invalidateAccessToken } from "~/dingtalk/access-token";
import {
	type DingtalkCredentials,
	describeFailure,
	isTokenError,
} from "~/dingtalk/client";
import { fetchOrg } from "~/dingtalk/fetch-org";
import { SYNC_BUSY_RETRY_MS, type SyncOutcome } from "~/domain/sync";
import type { Log } from "~/log";

import {
	claimSync,
	type OrgRead,
	type OrgReader,
	readSyncState,
	recordSyncFailure,
	type SyncState,
	type WriteResult,
	writeOrgSync,
} from "./store";

/**
 * 组织同步的编排：只拉自有应用。多副本之间靠租约（`claimSync`）保证同一时刻只有一个在拉，
 * 进程内再合并成一次；租约过期后万一有两个在拉，`fetched_at` 条件写保证旧的盖不掉新的。
 */

export interface SyncDeps {
	db: Database;
	/** 自有应用的凭证，唯一拿来拉通讯录的那对 */
	dingtalk: DingtalkCredentials;
	/** 传请求的 logger：带 reqId，才对得上审计的 `request_id` */
	log: Log;
}

export interface SyncResult {
	outcome: SyncOutcome;
	/** 返回时刻的同步状态（自有视角） */
	state: SyncState;
}

/**
 * 自有应用没有可用的数据，这次也给不出来。`message` 可以回给调用方（原因经过
 * `describeFailure`），⚠️ 不能带 app key。
 */
export class NotSyncedError extends Error {
	/** 向上取整、至少 1 秒，正文与 `Retry-After` 共用。null = 等不来，要有人显式同步 */
	readonly retryAfterSec: number | null;

	constructor(
		/** `syncing` 别处正在拉 · `cooldown` 刚尝试过（多半刚失败） · `other_app` 现有数据属于别的应用 */
		readonly reason: "syncing" | "cooldown" | "other_app",
		retryAfterMs: number | null,
		lastError?: string | null,
	) {
		const retryAfterSec =
			retryAfterMs === null
				? null
				: Math.max(1, Math.ceil(retryAfterMs / 1000));
		super(notSyncedMessage(reason, retryAfterSec, lastError));
		this.name = "NotSyncedError";
		this.retryAfterSec = retryAfterSec;
	}
}

function notSyncedMessage(
	reason: NotSyncedError["reason"],
	retryAfterSec: number | null,
	lastError: string | null | undefined,
): string {
	switch (reason) {
		case "syncing":
			return `组织数据正在同步，${retryAfterSec} 秒后可重试`;
		case "cooldown":
			return `组织数据还没同步成功过${lastError ? `，上次失败：${lastError}` : ""}；${retryAfterSec} 秒后可重试`;
		case "other_app":
			return "现有组织数据属于另一个钉钉应用，要先显式同步一次（orgsync 或 POST /api/v1/sync）";
	}
}

/** 抢不到租约、自有数据又不可用时，说清是哪一种 */
function notSynced(state: SyncState): NotSyncedError {
	return state.syncing
		? new NotSyncedError("syncing", SYNC_BUSY_RETRY_MS)
		: new NotSyncedError("cooldown", state.cooldownLeftMs, state.error);
}

// 一个进程只有一个自有应用，所以只有一个在途
let inflight: Promise<SyncResult> | null = null;

/**
 * 同步一次：进程内并发合并；抢不到租约（别处在拉，或距上一次尝试结束不到冷却期）不外呼，
 * 有自有数据就原样报回，没有就抛 `NotSyncedError`。失败时抛出，已有数据原样保留。
 */
export function syncOrg(deps: SyncDeps): Promise<SyncResult> {
	if (inflight) {
		deps.log.info("合并到进行中的组织同步");
		return inflight;
	}
	const p = doSync(deps).finally(() => {
		inflight = null;
	});
	inflight = p;
	return p;
}

/**
 * 有自有数据就原样返回（不管多旧），从没同步成功过才当场同步一次。
 * ⚠️ 现有数据属于别的应用时不接管：滚动更新换 `DINGTALK_APP_KEY` 时新旧 Pod 会来回覆盖
 * 对方的名单，而准入不会触发同步去修。接管只走显式同步（orgsync、部署 hook、POST）。
 */
export async function getOrSyncOrg<T>(
	deps: SyncDeps,
	read: OrgReader<T>,
): Promise<OrgRead<T>> {
	const appKey = deps.dingtalk.clientId;
	const hit = await read(deps.db, appKey);
	if (hit) return hit;

	if ((await readSyncState(deps.db, appKey)).otherAppSynced) {
		throw new NotSyncedError("other_app", null);
	}
	await syncOrg(deps);
	const after = await read(deps.db, appKey);
	if (after) return after;
	// syncOrg 返回即当时有自有数据，读不到只能是之后又有别的应用的一轮落了库
	throw new NotSyncedError("other_app", null);
}

async function doSync(deps: SyncDeps): Promise<SyncResult> {
	const appKey = deps.dingtalk.clientId;
	const lease = await claimSync(deps.db, appKey, randomUUID());
	if (!lease) {
		const state = await readSyncState(deps.db, appKey);
		if (!state.fetchedAt) throw notSynced(state);
		return { outcome: state.syncing ? "busy" : "cooldown", state };
	}

	let accessToken: string | undefined;
	let result: WriteResult;
	try {
		// 抢到租约之后才申请：冷却期内与别处在拉时都不申请。在 try 里：token 申请失败
		// （secret 错、钉钉故障）也要进 `error`，状态端点才报得出来
		accessToken = await getAccessToken(deps.db, deps.dingtalk);
		result = await writeOrgSync(deps.db, lease, await fetchOrg(accessToken));
	} catch (err) {
		// ⚠️ `invalidateAccessToken` 唯一的生产调用方。不清的话坏 token 留在进程与 PG
		// 两级缓存里，可自愈的故障变成必须重启
		if (accessToken && isTokenError(err)) {
			await invalidateAccessToken(deps.db, appKey, accessToken);
		}
		await recordSyncFailure(deps.db, lease, describeFailure(err));
		throw err;
	}

	if (result.skipped.length > 0) {
		deps.log.warn(
			{ appKey, skipped: result.skipped },
			"部分成员没进这一轮同步",
		);
	}
	const state = await readSyncState(deps.db, appKey);
	deps.log.info(
		{
			appKey,
			userCount: state.userCount,
			deptCount: state.deptCount,
			skippedCount: result.skipped.length,
			kept: result.written ? "mine" : "newer",
		},
		"组织数据已同步",
	);
	if (!state.fetchedAt) throw notSynced(state);
	return { outcome: "refreshed", state };
}
