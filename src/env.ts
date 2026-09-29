import { z } from "zod";

import { oidcClientsJsonSchema } from "~/domain/oidc-client";
import { LOG_LEVELS } from "~/log";

// 不用 5000：macOS 的隔空播放占着它，且以 403 应答，看着像 OIDC 配错
const DEFAULT_IDP_PORT = 3080;

const database = {
	DATABASE_URL: z.url(),
};

// `~/log` 在 import 时就读它，这里只负责校验：填错是启动失败，而不是静默回落 info
const logging = {
	LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
};

const idpPort = z.coerce.number().int().positive().default(DEFAULT_IDP_PORT);

// 自有钉钉应用：扫码登录、OIDC 准入查它的快照、orgsync 拿它当调用方
const dingtalkApp = {
	DINGTALK_APP_KEY: z.string().min(1),
	DINGTALK_APP_SECRET: z.string().min(1),
};

/** migrate / oidcpurge：只要数据库，出事时迁移得能单独跑起来 */
export const taskEnvSchema = z.object({ ...logging, ...database });
export type TaskEnv = z.infer<typeof taskEnvSchema>;

/** orgsync：带自有凭证调 `POST /api/v1/sync`，不碰数据库 */
export const orgSyncEnvSchema = z
	.object({
		...logging,
		...dingtalkApp,
		IDP_PORT: idpPort,
		// 只收 origin：挡住误填成带 /oidc 的 OIDC_ISSUER（拼接时那段路径会被静默丢掉）。
		// 不合法的 URL 已由 z.url() 报过，这里放行，免得 new URL 抛出裸 TypeError
		DINGORG_URL: z
			.url()
			.refine(
				(v) => !URL.canParse(v) || new URL(v).pathname === "/",
				"只写 origin，不带路径",
			)
			.optional(),
	})
	// 留空即本机，端口跟随同一份 .env 的 IDP_PORT
	.transform(({ IDP_PORT, DINGORG_URL, ...rest }) => ({
		...rest,
		DINGORG_URL: DINGORG_URL ?? `http://localhost:${IDP_PORT}`,
	}));
export type OrgSyncEnv = z.infer<typeof orgSyncEnvSchema>;

export const idpEnvSchema = z
	.object({
		...logging,
		...database,
		/**
		 * 信任 `x-forwarded-*`。fastify 的 `trustProxy`（审计的来源 IP）与 oidc-provider
		 * 的 `proxy`（https issuer 校验）必须读同一个值，只喂一半两处答案相反。
		 */
		AUTH_TRUST_PROXY_HEADERS: z
			.enum(["0", "1"])
			.optional()
			.transform((v) => v === "1"),
		...dingtalkApp,

		IDP_PORT: idpPort,

		/** 必须与对外可达地址精确一致：它是 `iss`，也是发给钉钉的回调地址前缀 */
		OIDC_ISSUER: z
			.url()
			.refine((v) => !v.endsWith("/"), "OIDC_ISSUER 不能以 / 结尾"),

		/** 下游 client 的 JSON 数组（含 secret），规则见 `~/domain/oidc-client` */
		OIDC_CLIENTS_JSON: oidcClientsJsonSchema,
	})
	// client secret 不得等于钉钉 AppSecret：下游持有它就能绕过本系统读全组织通讯录
	.superRefine((env, ctx) => {
		env.OIDC_CLIENTS_JSON.forEach((c, i) => {
			if (c.secret === env.DINGTALK_APP_SECRET) {
				ctx.addIssue({
					code: "custom",
					path: ["OIDC_CLIENTS_JSON", i, "secret"],
					message: "不能等于 DINGTALK_APP_SECRET：client 凭证要单独生成",
				});
			}
		});
	});

export type IdpEnv = z.infer<typeof idpEnvSchema>;

/** `.env` 里留空的变量当作没设，报「缺失」而不是「不合法」 */
function emptyStringAsUndefined(source: unknown): unknown {
	if (typeof source !== "object" || source === null) return source;
	return Object.fromEntries(
		Object.entries(source as Record<string, unknown>).map(([k, v]) => [
			k,
			v === "" ? undefined : v,
		]),
	);
}

/** ⚠️ 只带路径与规则，永远不带值：会进启动日志，而值里有 secret */
export function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("\n");
}

export function parseEnv<T extends z.ZodType>(
	schema: T,
	source: unknown = process.env,
): z.infer<T> {
	const result = schema.safeParse(emptyStringAsUndefined(source));
	if (!result.success) {
		throw new Error(`环境变量校验失败:\n${formatIssues(result.error)}`);
	}
	return result.data;
}

// 函数而非模块级常量：测试要 import 本模块而不在 import 时校验 process.env
export function loadEnv(): IdpEnv {
	return parseEnv(idpEnvSchema);
}

export function loadTaskEnv(): TaskEnv {
	return parseEnv(taskEnvSchema);
}

export function loadOrgSyncEnv(): OrgSyncEnv {
	return parseEnv(orgSyncEnvSchema);
}
