import type { FastifyInstance } from "fastify";

import type { Deps } from "~/deps";
import type { OrgApiSyncResponse, OrgApiSyncStatus } from "~/domain/org-api";
import { AUDIT_ACTIONS } from "~/resources";
import {
	readSnapshotMeta,
	refreshSnapshot,
	type SnapshotMeta,
} from "~/sync/snapshot";

import { requireCaller } from "./guard";

/** `POST` 是所有 appKey 刷新快照的唯一途径，自有 appKey 的每日 cron 也走它 */
export function registerSyncRoutes(app: FastifyInstance, deps: Deps): void {
	app.get(
		"/api/v1/sync",
		{ config: { auditAction: AUDIT_ACTIONS.syncStatus } },
		async (req) => {
			const { appKey } = requireCaller(req);
			return toStatus(appKey, await readSnapshotMeta(deps.db, appKey));
		},
	);

	app.post(
		"/api/v1/sync",
		{ config: { auditAction: AUDIT_ACTIONS.syncTrigger } },
		async (req) => {
			const caller = requireCaller(req);
			req.auditPatch.targetId = caller.appKey;
			// 先写失败的说法：拉取抛出后由 guard 的 error handler 应答，走不回这里
			req.auditPatch.details = { summary: "刷新组织快照失败" };

			// 同步拉完再返回：没有后台执行体，调用方拿到响应就是结果
			const { row, refreshed } = await refreshSnapshot(
				{ db: deps.db, log: req.log },
				caller.appKey,
				caller.accessToken,
			);
			req.auditPatch.details = {
				summary: refreshed ? "刷新了组织快照" : "请求刷新，冷却期内未外呼",
			};
			const body: OrgApiSyncResponse = {
				refreshed,
				...toStatus(caller.appKey, row),
			};
			return body;
		},
	);
}

/**
 * `state`：`never` 从没拉成功过 · `failed` 最近一次失败（`fetchedAt` 仍指向上一份成功的）
 * · `ok`。「拉成功过没有」看 `fetchedAt`（与 `data` 同空同非空）；计数列从没成功过时是
 * 默认的 0，不能原样报出去。
 */
function toStatus(appKey: string, row: SnapshotMeta | null): OrgApiSyncStatus {
	const loaded = row?.fetchedAt ? row : null;
	return {
		appKey,
		state: !loaded ? "never" : loaded.error ? "failed" : "ok",
		fetchedAt: row?.fetchedAt?.toISOString() ?? null,
		attemptedAt: row?.attemptedAt.toISOString() ?? null,
		error: row?.error ?? null,
		userCount: loaded?.userCount ?? null,
		deptCount: loaded?.deptCount ?? null,
	};
}
