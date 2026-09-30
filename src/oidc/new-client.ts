import { randomBytes, randomUUID } from "node:crypto";

import { type OidcClient, oidcClientSchema } from "~/domain/oidc-client";

/** 过与启动校验同一份 schema：填错的回调地址当场报出来，而不是部署后启动失败 */
export function newOidcClient(
	input: Pick<OidcClient, "name" | "redirectUris" | "redirectUriRegexes">,
) {
	return oidcClientSchema.safeParse({
		type: "oidc",
		name: input.name,
		id: randomUUID(),
		secret: randomBytes(32).toString("base64url"),
		redirectUris: input.redirectUris,
		redirectUriRegexes: input.redirectUriRegexes,
	});
}
