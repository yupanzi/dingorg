import { describe, expect, it } from "vitest";

import { oidcClientsJsonSchema } from "~/domain/oidc-client";

import { newOidcClient } from "./new-client";

const REDIRECT = "https://sso.example.com/source/oauth/callback/dingorg/";

describe("newOidcClient", () => {
	it("生成的 client 原样过 OIDC_CLIENTS_JSON 的校验", () => {
		const r = newOidcClient({
			name: "authentik-prod",
			redirectUris: [REDIRECT],
		});
		expect(r.success).toBe(true);

		const parsed = oidcClientsJsonSchema.parse(JSON.stringify([r.data]));
		expect(parsed).toEqual([r.data]);
	});

	it("每次的 id 与 secret 都不同，secret 是 32 字节的 base64url", () => {
		const a = newOidcClient({ name: "a", redirectUris: [REDIRECT] }).data;
		const b = newOidcClient({ name: "b", redirectUris: [REDIRECT] }).data;
		expect(a?.id).not.toBe(b?.id);
		expect(a?.secret).not.toBe(b?.secret);
		expect(a?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("回调地址不合法在生成时就报出来", () => {
		const r = newOidcClient({
			name: "x",
			redirectUris: ["http://evil.example.com/cb"],
		});
		expect(r.success).toBe(false);
	});
});
