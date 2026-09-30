import { z } from "zod";

import { authEntryNameSchema } from "./audit";

/**
 * 下游 OIDC client 的契约，`~/env`、`~/oidc/provider`、`~/oidc/new-client` 共用。
 *
 * client 是静态配置（env `AUTH_JSON` 里 `type: "oidc"` 的项），⚠️ 别加回注册端点：本系统没有
 * 管理员身份能给它授权；静态配置把授权交给「谁能改 K8s Secret」。只管登录，REST 面认的是
 * `~/domain/api-key`。
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

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * 精确回调地址：https（loopback 例外），由 oidc-provider 精确匹配；正则的见
 * `redirectUriRegexSchema`。上游的其余校验在启动时由 `~/oidc/provider` 跑，这里只管
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

/**
 * 正则回调地址，与 `redirectUris` 分开放：普通 URL 当正则读时 `.` 匹配任意字符，混在一起就
 * 分不清哪条是宽的。整串匹配（编译成 `^(?:…)$`，漏写锚点或用了 `|` 也不会只匹配一段）；
 * 单独能编译说明括号配平，包一层撑不破。
 * ⚠️ 正则是开放重定向最常见的来源：`.` 要转义，别用 `.*` 跨过 host。
 */
export const redirectUriRegexSchema = z
	.string()
	.min(1)
	.max(500)
	.superRefine((raw, ctx) => {
		try {
			new RegExp(raw, "u");
		} catch {
			ctx.addIssue({ code: "custom", message: "不是合法的正则" });
		}
	});

export function compileRedirectUriRegexes(
	regexes: readonly string[],
): RegExp[] {
	return regexes.map((p) => new RegExp(`^(?:${p})$`, "u"));
}

/**
 * 正则回调的判定。命中的地址还要过 `redirectUriSchema`：正则写宽了也放不进明文 http 与
 * fragment；它先跑，还给正则的输入定了长度上限。
 */
export function matchesRedirectUriRegex(
	regexes: readonly RegExp[],
	value: string,
): boolean {
	return (
		regexes.length > 0 &&
		redirectUriSchema.safeParse(value).success &&
		regexes.some((re) => re.test(value))
	);
}

/** strict：拼错的键（如 `redirectUri`）直接启动失败，而不是被静默忽略 */
export const oidcClientSchema = z.strictObject({
	type: z.literal("oidc"),
	name: authEntryNameSchema,
	id: z.uuid(),
	secret: z
		.string()
		.min(MIN_CLIENT_SECRET_LENGTH)
		.regex(
			CLIENT_SECRET_CHARSET,
			"secret 只能含 A-Z a-z 0-9 - _ . ~（用 pnpm auth:oidc 生成）",
		),
	// 只有正则也得留一条精确的：上游不收空的 redirect_uris
	redirectUris: z.array(redirectUriSchema).min(1, "至少要有一个精确回调地址"),
	redirectUriRegexes: z.array(redirectUriRegexSchema).optional(),
});
export type OidcClient = z.infer<typeof oidcClientSchema>;
