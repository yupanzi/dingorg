import { z } from "zod";

import { apiKeyEntrySchema, parseApiKeyId } from "./api-key";
import { oidcClientSchema } from "./oidc-client";

/**
 * env `AUTH_JSON`：下游 OIDC client 与 REST API key 同放一个数组，按 `type` 区分。
 * 只是存放在一处：两种凭证互不派生、各走各的校验；两边都 strict，一项混了两种字段直接拒。
 * 用数组而非按类型分键的对象：两个生成命令的输出都是「并进去的一项」，不用记该放哪儿。
 */

/** ⚠️ 解析失败只说「不是合法 JSON」：V8 的 SyntaxError 会回显一段原文，里面可能有 secret */
function jsonConfigSchema<T extends z.ZodType>(schema: T) {
	return z
		.string()
		.transform((raw, ctx): unknown => {
			try {
				return JSON.parse(raw);
			} catch {
				ctx.addIssue({ code: "custom", message: "不是合法的 JSON" });
				return z.NEVER;
			}
		})
		.pipe(schema);
}

/**
 * 给 `.superRefine` 用：`get` 取出的值在整个数组里不重复（取不出的项跳过），报错指向后出现的
 * 那个、报在 `field` 上。只回显字段名：值可能是 key。
 */
function uniqueBy<T>(field: string, get: (item: T) => string | undefined) {
	return (items: readonly T[], ctx: z.RefinementCtx) => {
		const seen = new Map<string, number>();
		items.forEach((item, i) => {
			const value = get(item);
			if (value === undefined) return;
			const first = seen.get(value);
			if (first === undefined) seen.set(value, i);
			else
				ctx.addIssue({
					code: "custom",
					path: [i, field],
					message: `与第 ${first} 项的 ${field} 重复`,
				});
		});
	};
}

const authEntrySchema = z.discriminatedUnion(
	"type",
	[oidcClientSchema, apiKeyEntrySchema],
	{ error: "type 只能是 oidc 或 apikey（用生成命令产出）" },
);
export type AuthEntry = z.infer<typeof authEntrySchema>;
export type AuthEntryType = AuthEntry["type"];

/** 解析过 JSON 之后的整个数组。启动校验与 `auth:* --merge` 共用 */
const authEntriesSchema = z
	.array(authEntrySchema)
	.refine(
		(entries) => entries.some((e) => e.type === "oidc"),
		"至少要有一个 type 为 oidc 的项",
	)
	// name 不分 type：重复了审计里分不清是谁，「删掉 X 那一项」也有歧义
	.superRefine(uniqueBy("name", (e) => e.name))
	.superRefine(uniqueBy("id", (e) => (e.type === "oidc" ? e.id : undefined)))
	// 比的是 key 里的 id 段：同 id 的两把 key，按 id 查项时后一把永远验不过
	.superRefine(
		uniqueBy("key", (e) =>
			e.type === "apikey" ? (parseApiKeyId(e.key) ?? undefined) : undefined,
		),
	);

export const authJsonSchema = jsonConfigSchema(authEntriesSchema);

/**
 * `auth:* --merge`：新的一项接在现有 AUTH_JSON 后面，整个数组过启动时同一份校验，重名之类
 * 在生成时就报。空串当空数组（从头攒一份）。
 */
export function appendAuthEntry(existingRaw: string, entry: AuthEntry) {
	const existing = jsonConfigSchema(z.array(z.unknown())).safeParse(
		existingRaw.trim() === "" ? "[]" : existingRaw,
	);
	if (!existing.success) return existing;
	return authEntriesSchema.safeParse([...existing.data, entry]);
}

/** 消费方只取自己那一种：client 列表里混不进 API key，反之亦然 */
export function pickAuthEntries<T extends AuthEntryType>(
	entries: readonly AuthEntry[],
	type: T,
): Extract<AuthEntry, { type: T }>[] {
	return entries.filter(
		(e): e is Extract<AuthEntry, { type: T }> => e.type === type,
	);
}
