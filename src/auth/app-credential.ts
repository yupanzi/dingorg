import type { Database } from "~/db";
import { getAccessToken } from "~/dingtalk/access-token";
import { MAX_ACTOR_ID_LENGTH } from "~/domain/audit";
import type { Log } from "~/log";

/**
 * REST 面的凭证：调用方自己的钉钉 AppKey/AppSecret（HTTP Basic）。判据只有一条——钉钉
 * 肯为它发 token；没有白名单。校验结果随 token 缓存在 `~/dingtalk/access-token`。
 */

export interface AppCredential {
	appKey: string;
	appSecret: string;
}

/** 格式不对一律 null：不区分「没带」和「带错了」 */
export function parseBasicAuth(
	header: string | undefined,
): AppCredential | null {
	const m = header ? /^Basic\s+(\S+)\s*$/i.exec(header) : null;
	if (!m?.[1]) return null;

	const decoded = Buffer.from(m[1], "base64").toString("utf8");
	// 在第一个冒号处切：RFC 7617 的 user-id 不能含冒号，password 可以
	const i = decoded.indexOf(":");
	if (i <= 0) return null;

	const appKey = decoded.slice(0, i);
	const appSecret = decoded.slice(i + 1);
	// ⚠️ appKey 原样进审计 actor_id：超长或带控制字符会让审计写失败，鉴权失败就不留痕了
	if (appKey.length > MAX_ACTOR_ID_LENGTH || /\p{Cc}/u.test(appKey)) {
		return null;
	}
	return appSecret ? { appKey, appSecret } : null;
}

/**
 * 缓存未命中时替来件向钉钉申请 token 的限流（进程内）。没有白名单，它是唯一挡住
 * 「拿别人的 appKey 招来钉钉频率拦截」的东西——对自有应用就是同步与登录一起挂。
 *
 * - 新凭证：按 appKey 失败冷却 + 全局每分钟封顶（后者挡随机 appKey 撒网）。
 * - ⚠️ 续期（同一个 secret 换过 token、只是到期）：不占全局名额、不受新凭证冷却牵连，
 *   只在自己失败后冷却。否则撒网者能让所有应用续不上，定向者拿别人的 appKey 配错
 *   secret 就能让那个应用续不上。
 */
export class VerifyLimiter {
	/** 键带类别前缀：两类的冷却互不牵连 */
	private readonly failures = new Map<string, number>();
	private window = { start: 0, count: 0 };

	constructor(
		private readonly opts = { perAppCooldownMs: 10_000, perMinute: 30 },
		private readonly now: () => number = Date.now,
	) {}

	/** 新凭证放行即占一个全局名额 */
	tryAcquire(appKey: string, renewal: boolean): boolean {
		const t = this.now();
		const failedAt = this.failures.get(failureKey(appKey, renewal));
		if (failedAt !== undefined && t - failedAt < this.opts.perAppCooldownMs) {
			return false;
		}
		if (renewal) return true;
		if (t - this.window.start >= 60_000) this.window = { start: t, count: 0 };
		if (this.window.count >= this.opts.perMinute) return false;
		this.window.count += 1;
		return true;
	}

	recordFailure(appKey: string, renewal: boolean): void {
		const t = this.now();
		// 键来自来件、任何人都能造：顺手清掉过期条目，Map 大小才有界
		for (const [key, at] of this.failures) {
			if (t - at >= this.opts.perAppCooldownMs) this.failures.delete(key);
		}
		this.failures.set(failureKey(appKey, renewal), t);
	}
}

function failureKey(appKey: string, renewal: boolean): string {
	return `${renewal ? "renewal" : "new"}:${appKey}`;
}

const limiter = new VerifyLimiter();

/** 通过则返回该 appKey 的企业 token，否则 null。真实原因只进日志 */
export async function verifyAppCredential(
	db: Database,
	cred: AppCredential,
	log: Log,
	lim: VerifyLimiter = limiter,
): Promise<string | null> {
	try {
		return await getAccessToken(
			db,
			{ clientId: cred.appKey, clientSecret: cred.appSecret },
			{
				admit: (renewal) => lim.tryAcquire(cred.appKey, renewal),
				failed: (renewal, err) => {
					lim.recordFailure(cred.appKey, renewal);
					log.warn({ appKey: cred.appKey, renewal, err }, "应用凭证校验失败");
				},
			},
		);
	} catch {
		// 没放行，或放行后钉钉失败（已在 failed 里记过）
		return null;
	}
}
