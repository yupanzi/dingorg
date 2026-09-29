import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { OrgApiErrorBody, OrgApiSyncResponse } from "~/domain/org-api";
import { REFRESH_COOLDOWN_MS } from "~/domain/sync";
import { loadOrgSyncEnv, type OrgSyncEnv } from "~/env";
import { logger } from "~/log";

/**
 * 每日刷新自有应用的快照：拿自有凭证调 `POST /api/v1/sync`，与手动触发同一条路。
 * 刷新逻辑只在服务里有一份，这里不碰数据库、不碰钉钉。挂了是静默的（离职的人一直
 * 能登录），Job 失败要配告警。
 */

/**
 * 服务端同步拉完才发响应头。⚠️ 不用 fetch：undici 的 headers 超时固定 300 秒，拉取超过它时
 * 客户端先放弃而服务端照样刷完 —— Job 报失败、审计缺一条、重试再拉一整轮。
 */
const REQUEST_TIMEOUT_MS = 10 * 60_000;

// ⚠️ 必须长于服务端冷却，否则重试撞在冷却期里白跑
const RETRY_DELAY_MS = 2 * REFRESH_COOLDOWN_MS;
const MAX_ATTEMPTS = 3;

function post(
	url: URL,
	headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
	const send = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = send(
			url,
			{
				method: "POST",
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					text += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function trigger(env: OrgSyncEnv): Promise<OrgApiSyncResponse> {
	const credential = Buffer.from(
		`${env.DINGTALK_APP_KEY}:${env.DINGTALK_APP_SECRET}`,
	).toString("base64");
	const res = await post(new URL("/api/v1/sync", env.DINGORG_URL), {
		authorization: `Basic ${credential}`,
		"content-length": "0",
	});

	let body: unknown = null;
	try {
		body = JSON.parse(res.text);
	} catch {}
	if (res.status < 200 || res.status >= 300) {
		const e = (body as OrgApiErrorBody | null)?.error;
		throw new Error(
			`HTTP ${res.status} ${e?.code ?? ""} ${e?.message ?? ""}`.trim(),
		);
	}

	const status = body as OrgApiSyncResponse;
	// 200 不等于成功：冷却期内服务原样返回现有状态
	if (status.state !== "ok") {
		throw new Error(`state=${status.state}：${status.error ?? "未知"}`);
	}
	return status;
}

async function main(): Promise<void> {
	const env = loadOrgSyncEnv();

	for (let attempt = 1; ; attempt++) {
		try {
			const { refreshed, fetchedAt, userCount, deptCount } = await trigger(env);
			logger.info(
				{
					appKey: env.DINGTALK_APP_KEY,
					attempt,
					fetchedAt,
					userCount,
					deptCount,
				},
				refreshed ? "自有应用组织快照已刷新" : "冷却期内未外呼，快照刚被刷新过",
			);
			return;
		} catch (err) {
			if (attempt >= MAX_ATTEMPTS) {
				throw new Error(`共尝试 ${MAX_ATTEMPTS} 次仍失败，快照保持上一份`, {
					cause: err,
				});
			}
			logger.warn(
				{ appKey: env.DINGTALK_APP_KEY, attempt, err },
				"自有应用组织快照刷新失败，稍后重试",
			);
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		logger.error({ err }, "自有应用组织快照刷新任务失败");
		process.exit(1);
	});
