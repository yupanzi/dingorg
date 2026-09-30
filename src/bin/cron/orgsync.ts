import { recordAudit } from "~/audit/record";
import { createDb } from "~/db";
import { closeDeps } from "~/deps";
import {
	SYNC_COOLDOWN_MS,
	SYNC_LEASE_MS,
	SYNC_TRIGGER_SUMMARY,
} from "~/domain/sync";
import { loadOrgSyncEnv, ownDingtalkApp } from "~/env";
import { logger } from "~/log";
import { AUDIT_ACTIONS } from "~/resources";
import {
	NotSyncedError,
	type SyncDeps,
	type SyncResult,
	syncOrg,
} from "~/sync/org";
import { readSyncState } from "~/sync/store";

/**
 * 每日同步自有应用的组织数据：直接调 `syncOrg`，与 `POST /api/v1/sync` 同一份实现（租约、冷却、
 * 失败记录都在里面）。不经 HTTP，所以不要凭证：能拿着这个 Secret 起 Pod 就是它的授权。
 * 挂了是静默的（离职的人一直能登录），Job 失败要配告警。
 */

// ⚠️ 必须长于冷却，否则重试撞在冷却期里白跑
const RETRY_DELAY_MS = 2 * SYNC_COOLDOWN_MS;
const MAX_ATTEMPTS = 3;
/** 别处持着租约时多久看一次：只读状态，不写审计 */
const BUSY_POLL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 审计与 REST 面同一套说法：同步抛错才算 failure */
async function syncAndAudit(deps: SyncDeps): Promise<SyncResult> {
	const audit = (status: "success" | "failure", summary: string) =>
		recordAudit(deps.db, {
			action: AUDIT_ACTIONS.syncTrigger,
			status,
			actorType: "system",
			targetId: deps.dingtalk.clientId,
			details: { summary },
		});

	try {
		const result = await syncOrg(deps);
		await audit("success", SYNC_TRIGGER_SUMMARY[result.outcome]);
		return result;
	} catch (err) {
		await audit("failure", SYNC_TRIGGER_SUMMARY.failed);
		throw err;
	}
}

/** 等别处那一轮结束。租约按时间过期，所以最多等一个租约时长 */
async function waitWhileSyncing(deps: SyncDeps): Promise<void> {
	logger.info("另一处正在同步组织数据，等它结束");
	const deadline = Date.now() + SYNC_LEASE_MS + BUSY_POLL_MS;
	while (Date.now() < deadline) {
		await sleep(BUSY_POLL_MS);
		const { syncing } = await readSyncState(deps.db, deps.dingtalk.clientId);
		if (!syncing) return;
	}
}

function isBusy(err: unknown): boolean {
	return err instanceof NotSyncedError && err.reason === "syncing";
}

async function main(): Promise<void> {
	const env = loadOrgSyncEnv();
	const deps: SyncDeps = {
		db: createDb(env.DATABASE_URL, { maxConnections: 2 }),
		dingtalk: ownDingtalkApp(env),
		log: logger,
	};
	const appKey = env.DINGTALK_APP_KEY;

	try {
		// 撞上别处在同步（部署 hook 与 cron 重叠、有人 POST）不算一次尝试：等它结束再来，
		// 那时多半落在冷却期里，由下面的判据看那一轮的结果
		for (let attempt = 1, waits = 0; ; ) {
			let result: SyncResult | undefined;
			let failure: unknown;
			try {
				result = await syncAndAudit(deps);
			} catch (err) {
				failure = err;
			}

			const busy = result?.outcome === "busy" || isBusy(failure);
			if (busy && waits < MAX_ATTEMPTS) {
				waits++;
				await waitWhileSyncing(deps);
				continue;
			}
			// 冷却期内返回的是现有数据：它挂着的失败就是这一轮的失败
			if (result && !busy && !result.state.error) {
				const { outcome, state } = result;
				logger.info(
					{
						appKey,
						attempt,
						outcome,
						fetchedAt: state.fetchedAt,
						userCount: state.userCount,
						deptCount: state.deptCount,
					},
					outcome === "refreshed"
						? "自有应用组织数据已同步"
						: "未外呼，组织数据刚被同步过",
				);
				return;
			}
			failure ??= new Error(
				busy
					? "别处一直在同步，等不到它结束"
					: `上一次同步刚失败：${result?.state.error}`,
			);

			if (attempt >= MAX_ATTEMPTS) {
				throw new Error(`共尝试 ${MAX_ATTEMPTS} 次仍失败，组织数据保持上一轮`, {
					cause: failure,
				});
			}
			logger.warn(
				{ appKey, attempt, err: failure },
				"自有应用组织同步失败，稍后重试",
			);
			attempt++;
			await sleep(RETRY_DELAY_MS);
		}
	} finally {
		await closeDeps(deps);
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		logger.error({ err }, "自有应用组织同步任务失败");
		process.exit(1);
	});
