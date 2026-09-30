import { z } from "zod";

import type { DingtalkCredentials } from "~/dingtalk/client";
import { authJsonSchema } from "~/domain/config-json";
import { LOG_LEVELS } from "~/log";

const database = {
	DATABASE_URL: z.url(),
};

// `~/log` 在 import 时就读它，这里只负责校验：填错是启动失败，而不是静默回落 info
const logging = {
	LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
};

// 自有钉钉应用：扫码登录、拉组织快照（OIDC 准入查的就是它）
const dingtalkApp = {
	DINGTALK_APP_KEY: z.string().min(1),
	DINGTALK_APP_SECRET: z.string().min(1),
};

/**
 * 固定端口，不做成可配：容器里它是内部细节，外部地址只看 `PUBLIC_ORIGIN`。Dockerfile 与 chart
 * 写的是同一个数。不用 5000：macOS 的隔空播放占着它，且以 403 应答，看着像 OIDC 配错。
 */
export const LISTEN_PORT = 3080;

/** 本机开发时外部地址就是监听地址 */
const DEV_PUBLIC_ORIGIN = `http://localhost:${LISTEN_PORT}`;

/** migrate / oidcpurge：只要数据库，出事时迁移得能单独跑起来 */
export const taskEnvSchema = z.object({ ...logging, ...database });
export type TaskEnv = z.infer<typeof taskEnvSchema>;

/** orgsync：直接调快照刷新（与 `POST /api/v1/sync` 同一份实现），要库与钉钉凭证 */
export const orgSyncEnvSchema = z.object({
	...logging,
	...database,
	...dingtalkApp,
});
export type OrgSyncEnv = z.infer<typeof orgSyncEnvSchema>;

/** 两个字段都是 string，写反了类型查不出：从 env 取凭证只走这里 */
export function ownDingtalkApp(
	env: Pick<OrgSyncEnv, "DINGTALK_APP_KEY" | "DINGTALK_APP_SECRET">,
): DingtalkCredentials {
	return {
		clientId: env.DINGTALK_APP_KEY,
		clientSecret: env.DINGTALK_APP_SECRET,
	};
}

export const idpEnvSchema = z
	.object({
		...logging,
		...database,
		...dingtalkApp,

		/**
		 * 对外可达的 origin，issuer 与发给钉钉的回调地址都由它拼出（`~/oidc/mount` 的
		 * `oidcIssuer`）。只收 origin：路径只有 `/oidc` 一个合法值，让人填只会填错。
		 * 必须写成规范形式：下游逐字比对 `iss`，同一个地址不能有两种写法。
		 * 别改成从 `X-Forwarded-Host` 推：换个入口进来就是另一个 issuer。
		 */
		PUBLIC_ORIGIN: z.string().superRefine((raw, ctx) => {
			let url: URL | undefined;
			try {
				url = new URL(raw);
			} catch {}
			const ok =
				url !== undefined &&
				(url.protocol === "https:" || url.protocol === "http:") &&
				url.origin === raw;
			if (!ok)
				ctx.addIssue({
					code: "custom",
					message:
						"只填 origin，如 https://sso.example.com：不带路径与结尾 /、域名小写、不写默认端口",
				});
		}),

		/**
		 * 下游 OIDC client 与 REST API key 的 JSON 数组（都含明文凭证），规则见
		 * `~/domain/config-json`。没有 apikey 项 = 不开 REST 面
		 */
		AUTH_JSON: authJsonSchema,
	})
	// client secret 不得等于钉钉 AppSecret：下游持有它就能绕过本系统读全组织通讯录
	.superRefine((env, ctx) => {
		env.AUTH_JSON.forEach((e, i) => {
			if (e.type === "oidc" && e.secret === env.DINGTALK_APP_SECRET) {
				ctx.addIssue({
					code: "custom",
					path: ["AUTH_JSON", i, "secret"],
					message: "不能等于 DINGTALK_APP_SECRET：client 凭证要单独生成",
				});
			}
		});
	});

export type IdpEnv = z.infer<typeof idpEnvSchema>;

/**
 * 是否信任 `x-forwarded-*`，从 `PUBLIC_ORIGIN` 推、不单独配：本服务只说 http，对外是 https 就
 * 说明前面必有终结 TLS 的代理，oidc-provider 要靠 `x-forwarded-proto` 才认得出 https；对外是
 * http 就是直连，信任的话来件能伪造审计里的来源 IP。fastify 的 `trustProxy` 与 oidc-provider
 * 的 `proxy` 必须都读它，只喂一半两处答案相反。
 * 前提：代理覆盖（而非透传）`x-forwarded-*`，且不可绕过代理直连。
 */
export function trustsProxyHeaders(
	env: Pick<IdpEnv, "PUBLIC_ORIGIN">,
): boolean {
	return new URL(env.PUBLIC_ORIGIN).protocol === "https:";
}

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

/**
 * 非 production 时 `PUBLIC_ORIGIN` 可以不写，取本机监听地址。镜像里 `NODE_ENV=production`
 * （Dockerfile）：缺了照样启动失败，而不是带着 localhost 的 issuer 跑起来、全员登录失败。
 */
export function withDevDefaults(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (source.NODE_ENV === "production" || source.PUBLIC_ORIGIN) return source;
	return { ...source, PUBLIC_ORIGIN: DEV_PUBLIC_ORIGIN };
}

// 函数而非模块级常量：测试要 import 本模块而不在 import 时校验 process.env
export function loadEnv(): IdpEnv {
	return parseEnv(idpEnvSchema, withDevDefaults(process.env));
}

export function loadTaskEnv(): TaskEnv {
	return parseEnv(taskEnvSchema);
}

export function loadOrgSyncEnv(): OrgSyncEnv {
	return parseEnv(orgSyncEnvSchema);
}
