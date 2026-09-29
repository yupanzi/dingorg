import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "~/db";
import { appSecrets } from "~/db/schema";
import { accessTokenKey } from "~/resources";
import {
	FetchDeniedError,
	type FetchGate,
	getAccessToken,
	invalidateAccessToken,
} from "./access-token";
import type { DingtalkCredentials } from "./client";

/**
 * 只 mock `fetchAccessToken`（数外呼次数、控制耗时与成败），PG 用真的：条件写与
 * compare-and-delete 只在真实存储上成立。
 */
const dbUrl = process.env.DATABASE_URL;
const maybe = dbUrl ? describe : describe.skip;

/** 测试专属前缀，绝不碰真实应用的 token 行 */
const APP_A = "itest-token-app-a";
const APP_B = "itest-token-app-b";
const GOOD = "good-secret";

/** 每次返回新 token；secret 不是 `GOOD` 时拒绝 */
let fetchCount = 0;
let nextExpiresIn = 7200;
let nextDelayMs = 0;
vi.mock("./client", async (importOriginal) => ({
	...(await importOriginal<typeof import("./client")>()),
	fetchAccessToken: vi.fn(async (cred: DingtalkCredentials) => {
		fetchCount += 1;
		const n = fetchCount;
		if (nextDelayMs > 0) await sleep(nextDelayMs);
		if (cred.clientSecret !== GOOD) throw new Error("钉钉拒绝了这对凭证");
		return { accessToken: `tok-${n}`, expiresAt: nowSec() + nextExpiresIn };
	}),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const cred = (appKey: string, secret = GOOD) => ({
	clientId: appKey,
	clientSecret: secret,
});

// 永远放行：这里测的是缓存、单飞与条件写，不是限流
const OPEN: FetchGate = { admit: () => true, failed: () => {} };

/** 记下闸门被问了什么；`allow` 决定放不放行 */
function spyGate(allow = true) {
	const admits: boolean[] = [];
	let failures = 0;
	const gate: FetchGate = {
		admit: (renewal) => {
			admits.push(renewal);
			return allow;
		},
		failed: () => {
			failures += 1;
		},
	};
	return { gate, admits, failures: () => failures };
}

maybe("access token 按 appKey (需要 DATABASE_URL)", () => {
	const db = createDb(dbUrl ?? "", { maxConnections: 3 });

	beforeEach(async () => {
		fetchCount = 0;
		// 有效期给足：太近会被 REFRESH_LEAD_S 判过期
		nextExpiresIn = 7200;
		nextDelayMs = 0;
		await clearAll();
	});

	afterAll(async () => {
		await clearAll();
		await db.$client.end();
	});

	// 不匹配的 badToken：条件删除不命中，只清进程内
	async function clearProcessCache(appKey: string): Promise<void> {
		await invalidateAccessToken(db, appKey, "force-clear-process-cache");
	}

	async function clearAll(): Promise<void> {
		await clearProcessCache(APP_A);
		await clearProcessCache(APP_B);
		await db
			.delete(appSecrets)
			.where(like(appSecrets.key, `${accessTokenKey("itest-token-")}%`));
	}

	async function readPgToken(
		appKey: string,
	): Promise<{ access_token: string; expires_at: number } | undefined> {
		const [row] = await db
			.select({ value: appSecrets.value })
			.from(appSecrets)
			.where(eq(appSecrets.key, accessTokenKey(appKey)))
			.limit(1);
		return row?.value as
			| { access_token: string; expires_at: number }
			| undefined;
	}

	// 另一个副本直接往 PG 写了一个 token
	async function writeFromOtherReplica(appKey: string, token: string) {
		const [row] = await db
			.select({ value: appSecrets.value })
			.from(appSecrets)
			.where(eq(appSecrets.key, accessTokenKey(appKey)))
			.limit(1);
		const value = {
			...(row?.value ?? {}),
			access_token: token,
			expires_at: nowSec() + 7200,
		};
		await db
			.insert(appSecrets)
			.values({ key: accessTokenKey(appKey), value })
			.onConflictDoUpdate({ target: appSecrets.key, set: { value } });
	}

	it("同进程并发只申请一次（进程内单飞）", async () => {
		const tokens = await Promise.all(
			Array.from({ length: 10 }, () => getAccessToken(db, cred(APP_A), OPEN)),
		);

		expect(fetchCount).toBe(1);
		expect(new Set(tokens).size).toBe(1);
	});

	it("申请成功后写回 PG，且不落 secret 明文", async () => {
		const token = await getAccessToken(db, cred(APP_A), OPEN);
		const row = await readPgToken(APP_A);

		expect(row?.access_token).toBe(token);
		expect(JSON.stringify(row)).not.toContain(GOOD);
	});

	it("进程内缓存失效后从 PG 读回，不重复申请", async () => {
		const first = await getAccessToken(db, cred(APP_A), OPEN);
		expect(fetchCount).toBe(1);

		await clearProcessCache(APP_A); // 模拟新进程 / 冷启动：进程内空，PG 里还有

		expect(await getAccessToken(db, cred(APP_A), OPEN)).toBe(first);
		expect(fetchCount).toBe(1);
	});

	// appKey 不是秘密：两级缓存命中都要求 secret 哈希相符
	it("错误的 secret 命中不了别人留下的缓存", async () => {
		await getAccessToken(db, cred(APP_A), OPEN);

		// 闸门被问到 = 两级缓存都没命中；不放行，所以也不会真的外呼
		const deny = spyGate(false);
		await expect(
			getAccessToken(db, cred(APP_A, "bad"), deny.gate),
		).rejects.toBeInstanceOf(FetchDeniedError);
		await clearProcessCache(APP_A); // 只剩 PG 那一级
		await expect(
			getAccessToken(db, cred(APP_A, "bad"), deny.gate),
		).rejects.toBeInstanceOf(FetchDeniedError);

		expect(deny.admits).toEqual([false, false]);
		expect(fetchCount).toBe(1);
	});

	it("闸门在单飞之内：并发的同一对凭证只问一次、失败只报一次", async () => {
		nextDelayMs = 100;
		const ok = spyGate();
		await Promise.all(
			Array.from({ length: 10 }, () =>
				getAccessToken(db, cred(APP_A), ok.gate),
			),
		);
		expect(ok.admits).toEqual([false]);

		const bad = spyGate();
		await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				getAccessToken(db, cred(APP_B, "bad"), bad.gate),
			),
		);
		expect(bad.admits).toHaveLength(1);
		expect(bad.failures()).toBe(1);
	});

	it("token 到期后，同一个 secret 算续期、换个 secret 不算", async () => {
		nextExpiresIn = 0; // 一拿到就判过期
		await getAccessToken(db, cred(APP_A), OPEN);

		const spy = spyGate(false);
		const attempt = (secret: string) =>
			getAccessToken(db, cred(APP_A, secret), spy.gate).catch(() => undefined);

		await attempt(GOOD);
		await attempt("bad");
		await clearProcessCache(APP_A); // 模拟新进程：只剩 PG 那一级
		await attempt(GOOD);
		await attempt("bad");

		expect(spy.admits).toEqual([true, false, true, false]);
	});

	it("单飞不跨 secret：并发时错误的 secret 不会搭上正确那次申请", async () => {
		nextDelayMs = 100;
		const [good, bad] = await Promise.allSettled([
			getAccessToken(db, cred(APP_A), OPEN),
			getAccessToken(db, cred(APP_A, "bad"), OPEN),
		]);

		expect(good.status).toBe("fulfilled");
		expect(bad.status).toBe("rejected");
		expect(fetchCount).toBe(2);
	});

	it("两个 appKey 的 token 互不覆盖、互不串用", async () => {
		const a = await getAccessToken(db, cred(APP_A), OPEN);
		const b = await getAccessToken(db, cred(APP_B), OPEN);

		expect(a).not.toBe(b);
		expect((await readPgToken(APP_A))?.access_token).toBe(a);
		expect((await readPgToken(APP_B))?.access_token).toBe(b);
	});

	it("invalidate 不会删掉别人刚写回的新 token（compare-and-delete）", async () => {
		// 本进程先拿到 tok-1，进程缓存与 PG 都是它
		const mine = await getAccessToken(db, cred(APP_A), OPEN);

		// 别的副本已经把共享层换成了新 token
		await writeFromOtherReplica(APP_A, "tok-newer");

		// 本进程拿着旧 token 报错并失效——不应波及共享层里的新值
		await invalidateAccessToken(db, APP_A, mine);

		expect((await readPgToken(APP_A))?.access_token).toBe("tok-newer");
	});

	// 只清进程内的话，下一次读会从 PG 命中同一个坏值
	it("invalidate 会删掉 PG 里仍等于坏值的那份", async () => {
		const mine = await getAccessToken(db, cred(APP_A), OPEN);

		await invalidateAccessToken(db, APP_A, mine);
		expect(await readPgToken(APP_A)).toBeUndefined();
	});

	/**
	 * 必须真的走 `writePg`（另抄一份 SQL 会给 `setWhere` 发假证）：让本次 fetch 慢下来，
	 * 期间另一个副本写入过期更晚的 token，慢请求落地时必须被挡住。
	 */
	it("PG 条件写不会让慢的旧请求盖住新 token", async () => {
		nextExpiresIn = 3600; // 比下面那个副本写的更早过期
		nextDelayMs = 400;
		const pending = getAccessToken(db, cred(APP_A), OPEN);

		await sleep(150);
		await writeFromOtherReplica(APP_A, "tok-newer");

		await pending;
		expect((await readPgToken(APP_A))?.access_token).toBe("tok-newer");
	});
});
