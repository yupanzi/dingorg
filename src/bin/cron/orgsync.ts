import { recordAudit } from "~/audit/record";
import { createDb } from "~/db";
import { closeDeps } from "~/deps";
import {
	REFRESH_COOLDOWN_MS,
	SYNC_TRIGGER_SUMMARY,
	syncTriggerSummary,
} from "~/domain/sync";
import { loadOrgSyncEnv, ownDingtalkApp } from "~/env";
import { logger } from "~/log";
import { AUDIT_ACTIONS } from "~/resources";
import {
	type RefreshResult,
	refreshSnapshot,
	type SnapshotDeps,
} from "~/sync/snapshot";

/**
 * 每日刷新自有应用的快照：直接调 `refreshSnapshot`，与 `POST /api/v1/sync` 同一份实现（冷却、
 * 失败记录都在里面；与常驻进程并发时靠冷却与 `fetched_at` 条件写，最坏白拉一次）。不经 HTTP，
 * 所以不要凭证：能拿着这个 Secret 起 Pod 就是它的授权。挂了是静默的（离职的人一直能登录），
 * Job 失败要配告警。
 */

// ⚠️ 必须长于冷却，否则重试撞在冷却期里白跑
const RETRY_DELAY_MS = 2 * REFRESH_COOLDOWN_MS;
const MAX_ATTEMPTS = 3;

/** 审计与 REST 面同一套说法：刷新抛错才算 failure */
async function refreshAndAudit(deps: SnapshotDeps): Promise<RefreshResult> {
	const audit = (status: "success" | "failure", summary: string) =>
		recordAudit(deps.db, {
			action: AUDIT_ACTIONS.syncTrigger,
			status,
			actorType: "system",
			targetId: deps.dingtalk.clientId,
			details: { summary },
		});

	try {
		const result = await refreshSnapshot(deps);
		await audit("success", syncTriggerSummary(result.refreshed));
		return result;
	} catch (err) {
		await audit("failure", SYNC_TRIGGER_SUMMARY.failed);
		throw err;
	}
}

async function main(): Promise<void> {
	const env = loadOrgSyncEnv();
	const deps: SnapshotDeps = {
		db: createDb(env.DATABASE_URL, { maxConnections: 2 }),
		dingtalk: ownDingtalkApp(env),
		log: logger,
	};
	const appKey = env.DINGTALK_APP_KEY;

	try {
		for (let attempt = 1; ; attempt++) {
			try {
				const { row, refreshed } = await refreshAndAudit(deps);
				// 冷却期内返回的是现有快照：它挂着的失败就是这一轮的失败
				if (row.error) throw new Error(`上一次刷新刚失败：${row.error}`);
				logger.info(
					{
						appKey,
						attempt,
						fetchedAt: row.fetchedAt,
						userCount: row.userCount,
						deptCount: row.deptCount,
					},
					refreshed
						? "自有应用组织快照已刷新"
						: "冷却期内未外呼，快照刚被刷新过",
				);
				return;
			} catch (err) {
				if (attempt >= MAX_ATTEMPTS) {
					throw new Error(`共尝试 ${MAX_ATTEMPTS} 次仍失败，快照保持上一份`, {
						cause: err,
					});
				}
				logger.warn(
					{ appKey, attempt, err },
					"自有应用组织快照刷新失败，稍后重试",
				);
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
			}
		}
	} finally {
		await closeDeps(deps);
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		logger.error({ err }, "自有应用组织快照刷新任务失败");
		process.exit(1);
	});
