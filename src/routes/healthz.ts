import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { Deps } from "../deps";
import { atLeast } from "../log";

/**
 * 只探 DB、不探钉钉：钉钉故障重启救不回来，只会放大成重启风暴。
 * 请求日志压到 warn（探针会淹掉真正的请求），所以探测失败自己记一行。
 */
export function registerHealthz(app: FastifyInstance, deps: Deps): void {
	const logLevel = atLeast("warn", app.log.level);
	app.get("/healthz", { logLevel }, async (req, reply) => {
		try {
			await deps.db.execute(sql`SELECT 1`);
			return reply.send({ ok: true });
		} catch (err) {
			req.log.warn({ err }, "healthz 探测数据库失败");
			return reply.code(503).send({ ok: false });
		}
	});
}
