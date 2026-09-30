/**
 * 距上一次拉取尝试（成功或失败）结束不到这么久，不再外呼。每次全量是上百次钉钉调用，
 * 打的是自有应用的 QPS。
 */
export const REFRESH_COOLDOWN_MS = 60_000;

/** `sync.trigger` 审计的说法：REST 面与 orgsync 调的是同一份刷新，记账也用同一套话 */
export const SYNC_TRIGGER_SUMMARY = {
	refreshed: "刷新了组织快照",
	cooldown: "请求刷新，冷却期内未外呼",
	failed: "刷新组织快照失败",
} as const;

/** 刷新返回了（没抛）时的说法 */
export function syncTriggerSummary(refreshed: boolean): string {
	return refreshed
		? SYNC_TRIGGER_SUMMARY.refreshed
		: SYNC_TRIGGER_SUMMARY.cooldown;
}
