import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "~/db/schema";

// casing 必须与 drizzle.config.ts 一致，否则运行时列名对不上
const DRIZZLE_OPTS = { schema, casing: "snake_case" } as const;

export type Database = ReturnType<typeof createDb>;

interface DbOptions {
	maxConnections?: number;
}

export function createDb(connectionString: string, opts: DbOptions = {}) {
	const pool = new Pool({
		connectionString,
		max: opts.maxConnections ?? 10,
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 30_000,
		// 默认关闭：空闲连接会被 NAT/LB 静默丢弃（偶发 "Connection terminated unexpectedly"）
		keepAlive: true,
		keepAliveInitialDelayMillis: 10_000,
	});

	return drizzle(pool, DRIZZLE_OPTS);
}

export { schema };
