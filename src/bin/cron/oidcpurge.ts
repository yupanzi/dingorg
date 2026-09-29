import { and, isNotNull, lt } from "drizzle-orm";

import { createDb } from "~/db";
import { oidcPayloads } from "~/db/schema";
import { loadTaskEnv } from "~/env";
import { logger } from "~/log";

// ⚠️ adapter 只在读取时判过期、不删行，删了这个 cron `oidc_payloads` 会无限涨

async function main(): Promise<void> {
	const env = loadTaskEnv();
	const db = createDb(env.DATABASE_URL, { maxConnections: 2 });

	// 读 rowCount，别 `.returning()`：一次可能删上万行
	const res = await db
		.delete(oidcPayloads)
		.where(
			and(
				isNotNull(oidcPayloads.expiresAt),
				lt(oidcPayloads.expiresAt, new Date()),
			),
		);
	logger.info({ removed: res.rowCount ?? 0 }, "OIDC 过期工件清理完成");
	await db.$client.end();
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		logger.error({ err }, "OIDC 过期工件清理失败");
		process.exit(1);
	});
