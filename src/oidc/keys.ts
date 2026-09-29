import { randomBytes, randomUUID } from "node:crypto";

import { inArray, sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { Database } from "~/db";
import { appSecrets } from "~/db/schema";
import {
	ADVISORY_LOCKS,
	OIDC_COOKIE_KEYS_KEY,
	OIDC_JWKS_KEY,
} from "~/resources";

/**
 * JWKS 与 cookie keys：首启生成、落 `app_secrets`。必须持久化，否则每次重启全员掉登录。
 * 轮换：新 key prepend（第一把用于签名），旧的留一个 TTL 周期再删。
 */

export interface OidcKeys {
	jwks: JWK[];
	cookieKeys: string[];
}

async function genSigningJwk(alg: "ES256" | "RS256"): Promise<JWK> {
	const { privateKey } = await generateKeyPair(alg, { extractable: true });
	const jwk = await exportJWK(privateKey);
	jwk.alg = alg;
	jwk.use = "sig";
	jwk.kid = randomUUID();
	return jwk;
}

export async function ensureOidcKeys(db: Database): Promise<OidcKeys> {
	return await db.transaction(async (tx) => {
		// 串行化多副本首启，事务结束自动释放
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCKS.oidcKeys}))`,
		);

		const rows = await tx
			.select()
			.from(appSecrets)
			.where(inArray(appSecrets.key, [OIDC_JWKS_KEY, OIDC_COOKIE_KEYS_KEY]));

		async function ensureKeyList<T>(
			key: string,
			generate: () => Promise<T[]>,
		): Promise<T[]> {
			const existing = (
				rows.find((r) => r.key === key)?.value as { keys?: T[] } | undefined
			)?.keys;
			if (existing?.length) return existing;

			const keys = await generate();
			await tx
				.insert(appSecrets)
				.values({ key, value: { keys } as Record<string, unknown> })
				.onConflictDoNothing();
			return keys;
		}

		return {
			jwks: await ensureKeyList<JWK>(OIDC_JWKS_KEY, async () => [
				// ⚠️ 实际签 id_token 的是 RS256（上游 client 默认算法），删了它全部登录中断
				await genSigningJwk("ES256"),
				await genSigningJwk("RS256"),
			]),
			cookieKeys: await ensureKeyList<string>(
				OIDC_COOKIE_KEYS_KEY,
				async () => [randomBytes(32).toString("hex")],
			),
		};
	});
}
