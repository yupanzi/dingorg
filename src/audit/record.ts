import type { Database } from "~/db";
import { auditLogs } from "~/db/schema";
import {
	type AuditActorType,
	type AuditDetails,
	normalizeIp,
	normalizeRequestPath,
} from "~/domain/audit";
import { logger } from "~/log";
import type { AuditAction } from "~/resources";

export interface AuditEntry {
	action: AuditAction;
	status: "success" | "failure";

	actorType: AuditActorType;
	/** 钉钉 AppKey / unionId / null */
	actorId?: string | null;
	actorName?: string | null;

	/** 缺省取 `action` 的首段 */
	targetType?: string;
	targetId?: string | null;
	targetName?: string | null;

	ip?: string | null;
	userAgent?: string | null;
	method?: string | null;
	path?: string | null;
	requestId?: string | null;

	details?: AuditDetails;
}

/** 无条件记。整个函数体在 try 里：审计写失败不能把已成功的操作反打成 500 */
export async function recordAudit(
	db: Database,
	entry: AuditEntry,
): Promise<void> {
	try {
		await db.insert(auditLogs).values({
			action: entry.action,
			status: entry.status,
			actorType: entry.actorType,
			actorId: entry.actorId ?? null,
			actorName: entry.actorName ?? null,
			targetType: entry.targetType ?? entry.action.split(".")[0] ?? "unknown",
			targetId: entry.targetId ?? null,
			targetName: entry.targetName ?? null,
			ip: normalizeIp(entry.ip),
			userAgent: entry.userAgent ?? null,
			method: entry.method ?? null,
			path: normalizeRequestPath(entry.path),
			requestId: entry.requestId ?? null,
			details: entry.details ?? null,
		});
	} catch (err) {
		// 审计丢了只剩这一行，生产要配告警
		logger.error(
			{ reqId: entry.requestId, action: entry.action, err },
			"写入审计失败",
		);
	}
}
