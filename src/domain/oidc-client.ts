import { z } from "zod";

/**
 * 下游 OIDC client 的契约，`~/env`、`~/oidc/provider`、`~/oidc/new-client` 共用。
 *
 * client 是静态配置（env `OIDC_CLIENTS_JSON`），⚠️ 别加回注册端点：REST 面认任意钉钉
 * 应用的凭证，拿它授权等于谁都能注册下游；静态配置把授权交给「谁能改 K8s Secret」。
 * secret 只能明文：oidc-provider 做明文常量时间比较，还可能拿它当 HS256 密钥。
 *
 * ⚠️ client 凭证与钉钉凭证无关：下游持有钉钉 AppSecret 就能绕过本系统读全组织通讯录。
 */

/**
 * 不做成可配：oidc-provider 把 `client_secret_basic` 与 `client_secret_post` 当同一种，
 * 登记哪个都两种都认（`app.integration.test.ts` 钉着）。
 */
export const CLIENT_TOKEN_AUTH_METHOD = "client_secret_basic";

/**
 * scope 不按 client 配：client 配了 scope 白名单，下游请求其外的 scope 会被硬拒，启动时
 * 发现不了。与 `provider.ts` 的 `claims` 映射改一边要改另一边。
 */
export const CLIENT_SCOPE = "openid profile email";
export const CLIENT_GRANT_TYPES = ["authorization_code"];
// `as const` 不能省：oidc-provider 要 `readonly ResponseType[]`
export const CLIENT_RESPONSE_TYPES = ["code"] as const;

/** 生成的是 43 字符；手填的也不能弱太多 */
const MIN_CLIENT_SECRET_LENGTH = 32;

/**
 * ⚠️ 只收 URL 不保留字符（base64url 是其子集）：oidc-provider 对 Basic 凭证做 form 解码，
 * 而不少下游（如 authentik）发的是原文，`+` 会变成空格、`%` 会被转义，那个下游全员登录失败。
 */
const CLIENT_SECRET_CHARSET = /^[A-Za-z0-9._~-]+$/;

/** name 进审计的 `target_name` */
const MAX_CLIENT_NAME_LENGTH = 64;

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * 回调地址：https（loopback 例外），由 oidc-provider 精确匹配。⚠️ 别加回正则模式：这是
 * 全系统唯一挡开放重定向的地方。上游的其余校验在启动时由 `~/oidc/provider` 跑，这里只管
 * 比上游更严的。
 */
export const redirectUriSchema = z
	.string()
	.trim()
	// 不写 .min(1)：new URL("") 已报非法
	.max(500)
	.superRefine((raw, ctx) => {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			ctx.addIssue({ code: "custom", message: "回调地址必须是合法的 URL" });
			return;
		}
		// 与上游重复，为的是让生成命令当场报错。判 href 而非 hash：`…/cb#` 的 hash 是空串
		if (url.href.includes("#")) {
			ctx.addIssue({ code: "custom", message: "回调地址不能带 #fragment" });
			return;
		}
		if (url.protocol === "https:") return;
		if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
		ctx.addIssue({
			code: "custom",
			message: "回调地址必须是 https（本机开发可用 http://localhost）",
		});
	});

/** strict：拼错的键（如 `redirectUri`）直接启动失败，而不是被静默忽略 */
export const oidcClientSchema = z.strictObject({
	name: z
		.string()
		.trim()
		.min(1)
		.max(MAX_CLIENT_NAME_LENGTH)
		.refine((v) => !/\p{Cc}/u.test(v), "name 不能含控制字符"),
	id: z.uuid(),
	secret: z
		.string()
		.min(MIN_CLIENT_SECRET_LENGTH)
		.regex(
			CLIENT_SECRET_CHARSET,
			"secret 只能含 A-Z a-z 0-9 - _ . ~（用 pnpm oidc:new-client 生成）",
		),
	redirectUris: z.array(redirectUriSchema).min(1, "至少要有一个回调地址"),
});
export type OidcClient = z.infer<typeof oidcClientSchema>;

/** id 与 name 各自不重复（name 重复审计里就分不清是哪个下游） */
const oidcClientsSchema = z
	.array(oidcClientSchema)
	.min(1, "至少要有一个 client")
	.superRefine((clients, ctx) => {
		for (const key of ["id", "name"] as const) {
			const seen = new Map<string, number>();
			clients.forEach((c, i) => {
				const first = seen.get(c[key]);
				if (first === undefined) seen.set(c[key], i);
				else
					ctx.addIssue({
						code: "custom",
						path: [i, key],
						message: `与第 ${first} 个 client 的 ${key} 重复`,
					});
			});
		}
	});

/** ⚠️ 解析失败只说「不是合法 JSON」：V8 的 SyntaxError 会回显一段原文，里面有 secret */
export const oidcClientsJsonSchema = z
	.string()
	.transform((raw, ctx): unknown => {
		try {
			return JSON.parse(raw);
		} catch {
			ctx.addIssue({ code: "custom", message: "不是合法的 JSON" });
			return z.NEVER;
		}
	})
	.pipe(oidcClientsSchema);
