import type { FastifyInstance } from "fastify";

import type { Deps } from "~/deps";
import type { DingtalkCredentials } from "~/dingtalk/client";
import type { OrgApiSyncResponse, OrgApiSyncStatus } from "~/domain/org-api";
import { SYNC_TRIGGER_SUMMARY, syncTriggerSummary } from "~/domain/sync";
import { AUDIT_ACTIONS } from "~/resources";
import {
	readSnapshotMeta,
	refreshSnapshot,
	type SnapshotMeta,
} from "~/sync/snapshot";

import { requireCaller } from "./guard";

/** `POST` 是调用方手动刷新的入口；每日 orgsync 直接调同一个 `refreshSnapshot` */
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
			return toStatus(await readSnapshotMeta(deps.db, dingtalk.clientId));
		},
	);

	app.post(
		"/api/v1/sync",
		{ config: { auditAction: AUDIT_ACTIONS.syncTrigger } },
		async (req) => {
			requireCaller(req);
			req.auditPatch.targetId = dingtalk.clientId;
			// 先写失败的说法：拉取抛出后由 guard 的 error handler 应答，走不回这里
			req.auditPatch.details = { summary: SYNC_TRIGGER_SUMMARY.failed };

			// 同步拉完再返回：没有后台执行体，调用方拿到响应就是结果
			const { row, refreshed } = await refreshSnapshot({
				db: deps.db,
				dingtalk,
				log: req.log,
			});
			req.auditPatch.details = { summary: syncTriggerSummary(refreshed) };
			const body: OrgApiSyncResponse = { refreshed, ...toStatus(row) };
			return body;
		},
	);
}

/**
 * `state`：`never` 从没拉成功过 · `failed` 最近一次失败（`fetchedAt` 仍指向上一份成功的）
 * · `ok`。「拉成功过没有」看 `fetchedAt`（与 `data` 同空同非空）；计数列从没成功过时是
 * 默认的 0，不能原样报出去。
 */
function toStatus(row: SnapshotMeta | null): OrgApiSyncStatus {
	const loaded = row?.fetchedAt ? row : null;
	return {
		state: !loaded ? "never" : loaded.error ? "failed" : "ok",
		fetchedAt: row?.fetchedAt?.toISOString() ?? null,
		attemptedAt: row?.attemptedAt.toISOString() ?? null,
		error: row?.error ?? null,
		userCount: loaded?.userCount ?? null,
		deptCount: loaded?.deptCount ?? null,
	};
}
