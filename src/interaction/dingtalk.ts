/** 钉钉统一登录授权页。state 传 interaction uid，回调时校验 */
export function buildDingtalkAuthUrl(args: {
	clientId: string;
	redirectUri: string;
	state: string;
}): string {
	const u = new URL("https://login.dingtalk.com/oauth2/auth");
	u.searchParams.set("redirect_uri", args.redirectUri);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", args.clientId);
	u.searchParams.set("scope", "openid");
	u.searchParams.set("state", args.state);
	u.searchParams.set("prompt", "consent");
	return u.toString();
}
