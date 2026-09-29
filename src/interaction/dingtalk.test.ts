import { describe, expect, it } from "vitest";

import { buildDingtalkAuthUrl } from "./dingtalk";

describe("buildDingtalkAuthUrl", () => {
	it("生成钉钉授权页 URL，redirect_uri 正确编码", () => {
		const url = buildDingtalkAuthUrl({
			clientId: "ding123",
			redirectUri: "https://example.com/oidc/interaction/abc/callback",
			state: "abc",
		});
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe(
			"https://login.dingtalk.com/oauth2/auth",
		);
		expect(u.searchParams.get("client_id")).toBe("ding123");
		expect(u.searchParams.get("redirect_uri")).toBe(
			"https://example.com/oidc/interaction/abc/callback",
		);
		expect(u.searchParams.get("response_type")).toBe("code");
		expect(u.searchParams.get("scope")).toBe("openid");
		expect(u.searchParams.get("state")).toBe("abc");
	});
});
