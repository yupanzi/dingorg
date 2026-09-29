import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "~/db";
import { appSecrets } from "~/db/schema";
import { accessTokenKey } from "~/resources";

import { type DingtalkCredentials, fetchAccessToken } from "./client";

/**
 * 钉钉企业 access token，按 appKey：进程内 → PG（跨副本共享）→ 申请并写回。钉钉没有
 * refresh token，「刷新」就是再申请一次，所以没有定时任务，正确性也不依赖缓存。
 *
 * 它同时是 REST 面的凭证校验：每一级缓存都连同 `secret_sha256` 存，命中要求哈希相符
 * （appKey 不是秘密）。代价是 secret 在钉钉后台重置后，旧的最长还能用到 token 过期。
 *
 * 有效期内重复申请返回同一个 token、旧的仍可用，所以替别人申请不会打断对方；但钉钉
 * 按应用限频，外呼仍要压到最少。不可省的五件事：
 * 1. 进程内单飞，键含 secret 哈希：只按 appKey 的话，错误的 secret 会搭上正确那次的结果。
 * 2. PG 条件 upsert，只有更晚过期的才覆盖（慢的旧请求不能盖住新的）。
 * 3. `invalidateAccessToken` 的 compare-and-delete。
 * 4. `REFRESH_LEAD_S` 作用在每一级判定上（统一走 `isFresh`）。
 * 5. 每一级都按 appKey 分开。
 */

// 用 type 而非 interface：写 jsonb 列需要隐式索引签名，interface 没有（TS2322）
type TokenValue = {
	access_token: string;
	expires_at: number;
	secret_sha256: string;
};

interface CachedToken {
	token: string;
	expiresAt: number;
	secretHash: string;
}

// 只有钉钉认可过的凭证才进来，大小以真实应用数为界
const cached = new Map<string, CachedToken>();

// 键是 appKey + secret 哈希
const inflight = new Map<string, Promise<string>>();

// 每进程随机的提前量：不把将死的 token 交出去，也让多副本错开续期
const REFRESH_LEAD_S = Math.floor(Math.random() * 120);

function isFresh(expiresAt: number): boolean {
	return expiresAt - REFRESH_LEAD_S > nowSec();
}

// secret 是高熵随机串，一次 sha256 足够；`===` 的时序最多泄露哈希前缀
function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/**
 * 外呼闸门（REST 鉴权的限流）。⚠️ 在单飞之内、缓存全 miss 后才问：挪到外面，并发搭车
 * 的请求会被挨个计数。`renewal`：缓存里留着同一个 secret 的哈希，只是 token 到期了。
 */
export interface FetchGate {
	admit(renewal: boolean): boolean;
	/** 放行后钉钉失败。每次真实外呼至多调一次 */
	failed(renewal: boolean, err: unknown): void;
}

export class FetchDeniedError extends Error {
	constructor() {
		super("外呼未获放行");
		this.name = "FetchDeniedError";
	}
}

/** 钉钉拒绝抛 `DingtalkError`，没放行抛 `FetchDeniedError` */
export async function getAccessToken(
	db: Database,
	cred: DingtalkCredentials,
	gate: FetchGate,
): Promise<string> {
	const hash = hashSecret(cred.clientSecret);
	const hit = fromProcess(cred.clientId, hash);
	if (hit) return hit;

	const key = `${cred.clientId}\n${hash}`;
	const pending = inflight.get(key);
	if (pending) return pending;

	const p = resolveToken(db, cred, hash, gate).finally(() => {
		inflight.delete(key);
	});
	inflight.set(key, p);
	return p;
}

function fromProcess(appKey: string, hash: string): string | null {
	const c = cached.get(appKey);
	return c && c.secretHash === hash && isFresh(c.expiresAt) ? c.token : null;
}

async function resolveToken(
	db: Database,
	cred: DingtalkCredentials,
	hash: string,
	gate: FetchGate,
): Promise<string> {
	const pg = await readPg(db, cred.clientId, hash);
	if (pg.token) return pg.token;

	// 进程内那份过期了也还留着，PG 不可用时靠它认出续期
	const renewal = pg.known || cached.get(cred.clientId)?.secretHash === hash;
	if (!gate.admit(renewal)) throw new FetchDeniedError();
	try {
		return await fetchAndStore(db, cred, hash);
	} catch (err) {
		gate.failed(renewal, err);
		throw err;
	}
}

interface PgLookup {
	token: string | null;
	/** 库里那行是同一个 secret 换来的（不论过没过期） */
	known: boolean;
}

const PG_MISS: PgLookup = { token: null, known: false };

async function readPg(
	db: Database,
	appKey: string,
	hash: string,
): Promise<PgLookup> {
	try {
		const [row] = await db
			.select({ value: appSecrets.value })
			.from(appSecrets)
			.where(eq(appSecrets.key, accessTokenKey(appKey)))
			.limit(1);
		const d = row?.value as Partial<TokenValue> | undefined;
		if (!d?.access_token || d.secret_sha256 !== hash) return PG_MISS;
		if (!isFresh(d.expires_at ?? 0)) return { token: null, known: true };

		cached.set(appKey, {
			token: d.access_token,
			expiresAt: d.expires_at ?? nowSec(),
			secretHash: hash,
		});
		return { token: d.access_token, known: true };
	} catch {
		// PG 不可用：退化为直接申请
		return PG_MISS;
	}
}

async function fetchAndStore(
	db: Database,
	cred: DingtalkCredentials,
	hash: string,
): Promise<string> {
	const fresh = await fetchAccessToken(cred);
	cached.set(cred.clientId, {
		token: fresh.accessToken,
		expiresAt: fresh.expiresAt,
		secretHash: hash,
	});

	await writePg(db, cred.clientId, {
		access_token: fresh.accessToken,
		expires_at: fresh.expiresAt,
		secret_sha256: hash,
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
