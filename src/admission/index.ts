import { checkEmployment } from "~/dingtalk/employment";
import type { SyncTriggerResult } from "~/domain/sync";
import { type SyncDeps, syncOwnOrg } from "~/sync/org";
import { findMember, type Member } from "~/sync/store";

/**
 * OIDC 准入。扫码回调与 `findAccount` 都只调 `admit`：两处判据一松一严就是扫码死循环，
 * 所以怎么组合只写在这里。
 *
 * 判据：自有应用同步结果里的当前成员（`findMember`），且钉钉实时确认是企业内部员工
 * （`checkEmployment`）。⚠️ 实时校验出错（钉钉故障、缺权限点）时只看同步结果：同步结果里
 * 也只有内部员工，退回去只是离职生效变慢，登录不押在钉钉企业接口上。
 */

/** 同步与实时校验用的是自有应用的同一对凭证 */
export type AdmissionDeps = SyncDeps;

/**
 * `mirror` 只看同步结果 · `realtime` 再实时问钉钉 · `realtime_sync` 钉钉确认是员工、同步结果里
 * 却没有（新人）时还补一轮同步再查
 */
export type AdmitMode = "mirror" | "realtime" | "realtime_sync";

/** 拒绝原因只进审计（`auth.reject` 的 summary），页面文案不区分 */
export const REJECT_SUMMARY = {
	not_employee: "钉钉实时校验：不是本企业内部员工（含已离职、外部联系人）",
	not_synced:
		"钉钉确认是员工，但不在组织同步结果里（可见范围外、撞名被跳过或补同步未成）",
	not_member: "不在组织同步结果里（或已离职），钉钉实时校验没做或不可用",
	lookup_failed: "补同步已完成，之后查同步结果出错（见日志）",
} as const;
export type RejectReason = keyof typeof REJECT_SUMMARY;

export type Admission = (
	| { admitted: true; member: Member }
	| { admitted: false; reason: RejectReason }
) & {
	/** 只在这次真的补了同步时有值 */
	synced?: SyncTriggerResult;
};

export async function admit(
	deps: AdmissionDeps,
	unionId: string,
	mode: AdmitMode,
): Promise<Admission> {
	const appKey = deps.dingtalk.clientId;
	const [member, employment] = await Promise.all([
		findMember(deps.db, appKey, unionId),
		mode === "mirror"
			? undefined
			: checkEmployment(deps.db, deps.dingtalk, unionId).catch(
					(err: unknown) => {
						deps.log.warn({ err }, "钉钉实时校验失败，只看同步结果");
						return undefined;
					},
				),
	]);

	if (employment === "not_employee") {
		return { admitted: false, reason: "not_employee" };
	}
	if (member) return { admitted: true, member };
	// 只有钉钉确认是员工才补同步：外部人员扫码触发不了全量拉取
	if (employment !== "employee") {
		return { admitted: false, reason: "not_member" };
	}
	if (mode !== "realtime_sync") {
		return { admitted: false, reason: "not_synced" };
	}

	const synced = await syncOwnOrg(deps).catch((err: unknown) => {
		deps.log.warn({ err }, "登录时补同步失败");
		return "failed" as const;
	});
	if (synced === null) {
		deps.log.warn("现有组织数据属于另一个钉钉应用，登录时不补同步");
		return { admitted: false, reason: "not_synced" };
	}
	// 同步已经发生：这里抛出去 `synced` 就丢了，这次拉取不会进审计
	let after: Member | undefined;
	try {
		after = await findMember(deps.db, appKey, unionId);
	} catch (err) {
		deps.log.error({ err }, "补同步之后查同步结果失败");
		return { admitted: false, reason: "lookup_failed", synced };
	}
	return after
		? { admitted: true, member: after, synced }
		: { admitted: false, reason: "not_synced", synced };
}
