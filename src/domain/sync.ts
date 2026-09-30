/**
 * 距上一次同步尝试（成功或失败）结束不到这么久，不再外呼。每次全量是上百次钉钉调用，
 * 打的是自有应用的 QPS。
 */
export const SYNC_COOLDOWN_MS = 60_000;

/**
 * 同步租约的时长：持有者在拉钉钉，到期前别的副本不拉。要长于一次真实的全量拉取（超了也不会
 * 写错，只是可能有第二个人同时在拉），又要远小于部署 hook 的 helm `--timeout`（orgsync 撞上
 * 租约会等它结束）。
 */
export const SYNC_LEASE_MS = 5 * 60_000;

/** 别处正在同步、这里又没有数据可给时，让调用方隔多久再来 */
export const SYNC_BUSY_RETRY_MS = 10_000;

/** `refreshed` 这一次拉了钉钉 · `cooldown` 冷却期内未外呼 · `busy` 别处正在拉、未外呼 */
export type SyncOutcome = "refreshed" | "cooldown" | "busy";

/** `sync.trigger` 审计的说法：REST 面与 orgsync 调的是同一份同步，记账也用同一套话 */
export const SYNC_TRIGGER_SUMMARY = {
	refreshed: "同步了组织数据",
	cooldown: "请求同步，冷却期内未外呼",
	busy: "请求同步，另一处正在同步、未外呼",
	failed: "同步组织数据失败",
} as const satisfies Record<SyncOutcome | "failed", string>;
