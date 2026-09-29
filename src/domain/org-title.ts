/**
 * 钉钉 `title` / `extension` → 结构化职级。
 *
 * ⚠️ 职级的真相源是 `title`，不是钉钉「角色」：`role_list` 在真实数据上被当成审批权限桶，
 * 照文档改过去会产出错误职级。
 *
 * 解析结果别并进 `normalizeIdentity`：那会让「身份归一化失败 → 整个人跳过」多出一种
 * 与身份无关的原因。
 */

/** domain 不依赖 IO 层。收的是解析好的 `jobLevel`，不再碰 extension 原文 */
export interface MemberTitleFields {
	title?: string | null;
	jobLevel?: string | null;
}

/** 全角「；」与半角「;」会在同一人身上混用。⚠️ `-`（部门路径）与 `&`（部门名）不是分隔符 */
const TITLE_SEPARATOR = /[；;、]/;

/** 从高到低，同时是展示排序的权重。加新词只管按层级插，匹配顺序由 `MATCH_ORDER` 派生 */
const RANKS = [
	"董事长",
	"首席执行官（CEO）",
	"首席执行官(CEO)",
	"总经理",
	"副总经理",
	"总监",
	"副总监",
	"组长",
	"副组长",
] as const;

/** 长度降序：「副总监」必须先于「总监」尝试 */
const MATCH_ORDER: readonly string[] = [...RANKS].sort(
	(a, b) => b.length - a.length,
);

const RANK_ORDER = new Map<string, number>(RANKS.map((r, i) => [r, i]));

/** 越小越高；未知职级排在所有已知职级之后 */
export function rankOrder(rank: string): number {
	return RANK_ORDER.get(rank) ?? RANKS.length;
}

/**
 * 保序去重：手填的 title 里有「总监；总监」，下游按条目批量写入时，同批重复键会让整批
 * 失败。
 */
export function parseTitles(raw: string | null | undefined): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(TITLE_SEPARATOR)) {
		const atom = part.trim();
		if (!atom || seen.has(atom)) continue;
		seen.add(atom);
		out.push(atom);
	}
	return out;
}

/** 后缀匹配：写法是「部门路径 + 职级」。纯专业岗位没有职级词，null 是正确结果 */
export function extractRank(atom: string): string | null {
	const s = atom.trim();
	return MATCH_ORDER.find((r) => s.endsWith(r)) ?? null;
}

/**
 * ⚠️ 这是本组织在钉钉后台自定义的字段名，与 `RANKS` 一样按本组织定。换企业部署时两处
 * 都要过目：对不上的症状是全员 `jobLevel` 为 null、`ranks` 为 `[]`，没有任何检查会红。
 */
const JOB_LEVEL_KEY = "职务";

/**
 * ⚠️ 必须兜住异常：钉钉给的字符串不保证是合法 JSON，抛出去就是一个人的脏数据让整轮
 * 拉取失败。数组也判 null（取不出字段）。
 */
export function parseExtension(
	raw: string | null | undefined,
): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** 单值、会丢职（兼总监与组长的人这里只有「总监」），只在 title 提不出职级时回退 */
export function parseJobLevel(raw: string | null | undefined): string | null {
	const value = parseExtension(raw)?.[JOB_LEVEL_KEY];
	return typeof value === "string" ? value.trim() || null : null;
}

interface TitleView {
	titles: string[];
	/** 去重、从高到低；title 里提不出时回退 `jobLevel` */
	ranks: string[];
}

export function titleView(user: MemberTitleFields): TitleView {
	const titles = parseTitles(user.title);

	const seen = new Set<string>();
	for (const atom of titles) {
		const rank = extractRank(atom);
		if (rank) seen.add(rank);
	}
	if (seen.size) {
		return {
			titles,
			ranks: [...seen].sort((a, b) => rankOrder(a) - rankOrder(b)),
		};
	}

	const jobLevel = user.jobLevel?.trim();
	return { titles, ranks: jobLevel ? [jobLevel] : [] };
}
