import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "~/db";
import { appSecrets } from "~/db/schema";
import { accessTokenKey } from "~/resources";
import { getAccessToken, invalidateAccessToken } from "./access-token";
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
const cred = (appKey: string) => ({ clientId: appKey, clientSecret: GOOD });

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
			Array.from({ length: 10 }, () => getAccessToken(db, cred(APP_A))),
		);

		expect(fetchCount).toBe(1);
		expect(new Set(tokens).size).toBe(1);
	});

	it("申请成功后写回 PG，且不落 secret 明文", async () => {
		const token = await getAccessToken(db, cred(APP_A));
		const row = await readPgToken(APP_A);

		expect(row?.access_token).toBe(token);
		expect(JSON.stringify(row)).not.toContain(GOOD);
	});

	it("进程内缓存失效后从 PG 读回，不重复申请", async () => {
		const first = await getAccessToken(db, cred(APP_A));
		expect(fetchCount).toBe(1);

		await clearProcessCache(APP_A); // 模拟新进程 / 冷启动：进程内空，PG 里还有

		expect(await getAccessToken(db, cred(APP_A))).toBe(first);
		expect(fetchCount).toBe(1);
	});

	it("钉钉拒绝时抛出，PG 里不留东西", async () => {
		await expect(
			getAccessToken(db, { clientId: APP_A, clientSecret: "bad" }),
		).rejects.toThrow("钉钉拒绝");
		expect(await readPgToken(APP_A)).toBeUndefined();
	});

	it("两个 appKey 的 token 互不覆盖、互不串用", async () => {
		const a = await getAccessToken(db, cred(APP_A));
		const b = await getAccessToken(db, cred(APP_B));

		expect(a).not.toBe(b);
		expect((await readPgToken(APP_A))?.access_token).toBe(a);
		expect((await readPgToken(APP_B))?.access_token).toBe(b);
	});

	it("invalidate 不会删掉别人刚写回的新 token（compare-and-delete）", async () => {
		// 本进程先拿到 tok-1，进程缓存与 PG 都是它
		const mine = await getAccessToken(db, cred(APP_A));

		// 别的副本已经把共享层换成了新 token
		await writeFromOtherReplica(APP_A, "tok-newer");

		// 本进程拿着旧 token 报错并失效——不应波及共享层里的新值
		await invalidateAccessToken(db, APP_A, mine);

		expect((await readPgToken(APP_A))?.access_token).toBe("tok-newer");
	});

	// 只清进程内的话，下一次读会从 PG 命中同一个坏值
	it("invalidate 会删掉 PG 里仍等于坏值的那份", async () => {
		const mine = await getAccessToken(db, cred(APP_A));

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
		const pending = getAccessToken(db, cred(APP_A));

		await sleep(150);
		await writeFromOtherReplica(APP_A, "tok-newer");

		await pending;
		expect((await readPgToken(APP_A))?.access_token).toBe("tok-newer");
	});
});
