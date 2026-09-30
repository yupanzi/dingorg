import { and, eq, sql } from "drizzle-orm";
import type { Database } from "~/db";
import { appSecrets } from "~/db/schema";
import { accessTokenKey } from "~/resources";

import { type DingtalkCredentials, fetchAccessToken } from "./client";

/**
 * 钉钉企业 access token（自有应用）：进程内 → PG（跨副本共享）→ 申请并写回。钉钉没有
 * refresh token，「刷新」就是再申请一次，所以没有定时任务，正确性也不依赖缓存。
 *
 * 钉钉按应用限频，外呼要压到最少。不可省的四件事：
 * 1. 进程内单飞。
 * 2. PG 条件 upsert，只有更晚过期的才覆盖（慢的旧请求不能盖住新的）。
 * 3. `invalidateAccessToken` 的 compare-and-delete。
 * 4. `REFRESH_LEAD_S` 作用在每一级判定上（统一走 `isFresh`）。
 *
 * 缓存按 appKey 分行：换了 `DINGTALK_APP_KEY` 不会拿到旧应用的 token。
 */

// 用 type 而非 interface：写 jsonb 列需要隐式索引签名，interface 没有（TS2322）
type TokenValue = {
	access_token: string;
	expires_at: number;
};

interface CachedToken {
	token: string;
	expiresAt: number;
}

const cached = new Map<string, CachedToken>();

const inflight = new Map<string, Promise<string>>();

// 每进程随机的提前量：不把将死的 token 交出去，也让多副本错开续期
const REFRESH_LEAD_S = Math.floor(Math.random() * 120);

function isFresh(expiresAt: number): boolean {
	return expiresAt - REFRESH_LEAD_S > nowSec();
}

/** 钉钉拒绝抛 `DingtalkError` */
export async function getAccessToken(
	db: Database,
	cred: DingtalkCredentials,
): Promise<string> {
	const hit = cached.get(cred.clientId);
	if (hit && isFresh(hit.expiresAt)) return hit.token;

	const pending = inflight.get(cred.clientId);
	if (pending) return pending;

	const p = resolveToken(db, cred).finally(() => {
		inflight.delete(cred.clientId);
	});
	inflight.set(cred.clientId, p);
	return p;
}

async function resolveToken(
	db: Database,
	cred: DingtalkCredentials,
): Promise<string> {
	return (await readPg(db, cred.clientId)) ?? (await fetchAndStore(db, cred));
}

async function readPg(db: Database, appKey: string): Promise<string | null> {
	try {
		const [row] = await db
			.select({ value: appSecrets.value })
			.from(appSecrets)
			.where(eq(appSecrets.key, accessTokenKey(appKey)))
			.limit(1);
		const d = row?.value as Partial<TokenValue> | undefined;
		if (!d?.access_token || !isFresh(d.expires_at ?? 0)) return null;

		cached.set(appKey, {
			token: d.access_token,
			expiresAt: d.expires_at ?? nowSec(),
		});
		return d.access_token;
	} catch {
		// PG 不可用：退化为直接申请
		return null;
	}
}

async function fetchAndStore(
	db: Database,
	cred: DingtalkCredentials,
): Promise<string> {
	const fresh = await fetchAccessToken(cred);
	cached.set(cred.clientId, {
		token: fresh.accessToken,
		expiresAt: fresh.expiresAt,
	});

	await writePg(db, cred.clientId, {
		access_token: fresh.accessToken,
		expires_at: fresh.expiresAt,
	});
	return fresh.accessToken;
}

// 只有过期更晚的才覆盖；缺字段的行 COALESCE 成 0。写失败最坏是下次多申请一次
async function writePg(
	db: Database,
	appKey: string,
	value: TokenValue,
): Promise<void> {
	try {
		await db
			.insert(appSecrets)
			.values({ key: accessTokenKey(appKey), value })
			.onConflictDoUpdate({
				target: appSecrets.key,
				set: { value, updatedAt: new Date() },
				setWhere: sql`COALESCE((${appSecrets.value} ->> 'expires_at')::bigint, 0) < ${value.expires_at}`,
			});
	} catch {}
}

/**
 * 钉钉说 token 无效时丢弃它。两级都要清（只清进程内，下一次读又从 PG 拿回来）；PG 那份
 * 用 compare-and-delete，别拆成 select 再 delete。
 */
export async function invalidateAccessToken(
	db: Database,
	appKey: string,
	badToken: string,
): Promise<void> {
	cached.delete(appKey);
	try {
		await db
			.delete(appSecrets)
			.where(
				and(
					eq(appSecrets.key, accessTokenKey(appKey)),
					sql`${appSecrets.value} ->> 'access_token' = ${badToken}`,
				),
			);
	} catch {}
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}
