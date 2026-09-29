/**
 * 距上一次拉取尝试（成功或失败）结束不到这么久，不再外呼。每次全量是上百次钉钉调用，
 * 打的是对方应用的 QPS。
 */
export const REFRESH_COOLDOWN_MS = 60_000;
