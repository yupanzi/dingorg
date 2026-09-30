import type { FastifyInstance } from "fastify";

import type { Deps } from "~/deps";
import type { DingtalkCredentials } from "~/dingtalk/client";
import type { OrgApiSyncResponse, OrgApiSyncStatus } from "~/domain/org-api";
import { SYNC_TRIGGER_SUMMARY } from "~/domain/sync";
import { AUDIT_ACTIONS } from "~/resources";
import { syncOrg } from "~/sync/org";
import { readSyncState, type SyncState } from "~/sync/store";

import { requireCaller } from "./guard";

/** `POST` 是调用方手动同步的入口；每日 orgsync 直接调同一个 `syncOrg` */
export function registerSyncRoutes(
	app: FastifyInstance,
	deps: Deps,
	dingtalk: DingtalkCredentials,
): void {
	app.get(
		"/api/v1/sync",
		{ config: { auditAction: AUDIT_ACTIONS.syncStatus } },
		async (req) => {
			requireCaller(req);
			return toStatus(await readSyncState(deps.db, dingtalk.clientId));
		},
	);

	app.post(
		"/api/v1/sync",
		{ config: { auditAction: AUDIT_ACTIONS.syncTrigger } },
		async (req) => {
			requireCaller(req);
			req.auditPatch.targetId = dingtalk.clientId;
			// 先写失败的说法：同步抛出后由 guard 的 error handler 应答，走不回这里
			req.auditPatch.details = { summary: SYNC_TRIGGER_SUMMARY.failed };

			// 同步拉完再返回：没有后台执行体，调用方拿到响应就是结果。别处正在拉时不等它
			const { outcome, state } = await syncOrg({
				db: deps.db,
				dingtalk,
				log: req.log,
			});
			req.auditPatch.details = { summary: SYNC_TRIGGER_SUMMARY[outcome] };
			const body: OrgApiSyncResponse = {
				refreshed: outcome === "refreshed",
				...toStatus(state),
			};
			return body;
		},
	);
}

/**
 * `state`：`never` 自有应用没有可用的数据 · `failed` 最近一次失败（`fetchedAt` 仍指向上一轮
 * 成功的）· `ok`。
 */
function toStatus(s: SyncState): OrgApiSyncStatus {
	return {
		state: !s.fetchedAt ? "never" : s.error ? "failed" : "ok",
		fetchedAt: s.fetchedAt?.toISOString() ?? null,
		attemptedAt: s.attemptedAt?.toISOString() ?? null,
		error: s.error,
		syncing: s.syncing,
		userCount: s.userCount,
		deptCount: s.deptCount,
	};
}
