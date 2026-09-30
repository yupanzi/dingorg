import { createDb, type Database } from "~/db";

import type { IdpEnv } from "./env";

export interface Deps {
	/** 单池即可：同步先把钉钉数据全拉进内存再用一个事务写入，租约也只是一条语句，拉取期间不占连接 */
	db: Database;
}

export function createDeps(env: IdpEnv): Deps {
	return { db: createDb(env.DATABASE_URL, { maxConnections: 10 }) };
}

export async function closeDeps(deps: Deps): Promise<void> {
	await deps.db.$client.end().catch(() => undefined);
}
