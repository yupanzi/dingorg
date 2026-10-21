/**
 * 钉钉开放平台客户端。组织架构接口只在旧版 oapi（`/topapi/*`，HTTP 200 + errcode）有，
 * 认证在新版 api（`/v1.0/*`，HTTP 状态码 + `{code, message}`），两套都要用。
 */

const NEW_API = "https://api.dingtalk.com";
const OLD_API = "https://oapi.dingtalk.com";

export interface DingtalkCredentials {
	clientId: string;
	clientSecret: string;
}

interface DingtalkErrorInit {
	/** 旧版 oapi 的数字 errcode */
	errcode?: number;
	/** 旧版 oapi 的 `sub_code`：errcode 88 时真正的原因在它这里 */
	subCode?: string;
	/** 新版 api 的字符串错误码 */
	code?: string;
	status?: number;
	endpoint?: string;
}

/** ⚠️ 错误码与 status 必须是结构化字段：`isTokenError` 靠它们判 token 失效，REST 面原样回给调用方 */
export class DingtalkError extends Error {
	readonly errcode?: number;
	readonly subCode?: string;
	readonly code?: string;
	readonly status?: number;
	readonly endpoint?: string;

	constructor(message: string, init: DingtalkErrorInit = {}) {
		super(message);
		this.name = "DingtalkError";
		this.errcode = init.errcode;
		this.subCode = init.subCode;
		this.code = init.code;
		this.status = init.status;
		// ⚠️ 剥掉 query：旧版 oapi 的 access_token 在 query 里，而日志会带出错误的全部字段
		this.endpoint = init.endpoint?.split("?")[0];
	}
}

/** 40014 不合法的 access_token / 42001 access_token 超时 */
const TOKEN_ERRCODES = new Set([40014, 42001]);

/**
 * ⚠️ `/topapi/*` 不把 token 的错放在顶层：回 errcode 88，原因在字符串 `sub_code`，如
 * `{"errcode":88,"sub_code":"40014","errmsg":"ding talk error[subcode=40014,…]"}`
 */
const SUB_CODE_ERRCODE = 88;

/**
 * token 本身失效（重试前必须先清缓存）。⚠️ 别按 code 含 `AccessToken` 判：
 * `AccessTokenPermissionDenied` 是缺权限点（403），重试永远不会好。
 */
export function isTokenError(err: unknown): boolean {
	if (!(err instanceof DingtalkError)) return false;
	const code =
		err.errcode === SUB_CODE_ERRCODE ? Number(err.subCode) : err.errcode;
	if (code !== undefined && TOKEN_ERRCODES.has(code)) return true;
	return err.status === 401;
}

/** `AbortSignal.timeout` 抛的是 name 为 `TimeoutError` 的 DOMException */
export function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

/** 能说给调用方听的失败原因：钉钉的错与超时如实讲，其余只说「内部错误」（原文可能带 SQL） */
export function describeFailure(err: unknown): string {
	if (err instanceof DingtalkError) {
		const code = err.errcode ?? err.code ?? err.status;
		return code === undefined ? err.message : `${err.message}（${code}）`;
	}
	if (isTimeoutError(err)) return "请求钉钉超时";
	return "内部错误";
}

/**
 * 所有出口显式超时：undici 默认 300 秒会卡住整轮拉取。不再短：接口没有幂等保证，
 * 超时越早「其实成功了却当失败」的窗口越大。
 */
const TIMEOUT_MS = 30_000;

/** 旧版 oapi 的唯一出口。只收 path：两套出口对错误体的读法相反，用错会丢掉钉钉给的原因 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
	const url = `${OLD_API}${path}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new DingtalkError(`HTTP ${res.status} ${res.statusText}`, {
			status: res.status,
			endpoint: url,
		});
	}
	const json = (await res.json()) as T & {
		errcode?: number;
		errmsg?: string;
		sub_code?: string | number;
	};
	if (json.errcode !== undefined && json.errcode !== 0) {
		throw new DingtalkError(json.errmsg ?? "dingtalk error", {
			errcode: json.errcode,
			subCode: json.sub_code === undefined ? undefined : String(json.sub_code),
			status: res.status,
			endpoint: url,
		});
	}
	return json;
}

/** 新版 api 的唯一出口 */
async function newApiRequest<T>(
	path: string,
	init: {
		method: "GET" | "POST";
		headers?: Record<string, string>;
		body?: unknown;
	},
): Promise<T> {
	const url = `${NEW_API}${path}`;
	const res = await fetch(url, {
		method: init.method,
		headers: { "Content-Type": "application/json", ...init.headers },
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const json = (await res.json().catch(() => ({}))) as T & {
		code?: string;
		message?: string;
	};
	if (!res.ok) {
		throw new DingtalkError(
			json.message ?? `HTTP ${res.status} ${res.statusText}`,
			{
				code: json.code,
				status: res.status,
				endpoint: url,
			},
		);
	}
	return json;
}

export interface AccessToken {
	accessToken: string;
	/** 绝对过期时间（秒）：跨进程传递相对值会失真 */
	expiresAt: number;
}

export async function fetchAccessToken(
	cred: DingtalkCredentials,
): Promise<AccessToken> {
	const json = await newApiRequest<{ accessToken: string; expireIn: number }>(
		"/v1.0/oauth2/accessToken",
		{
			method: "POST",
			body: { appKey: cred.clientId, appSecret: cred.clientSecret },
		},
	);
	return {
		accessToken: json.accessToken,
		// 提前 5 分钟视为过期，留出时钟偏差
		expiresAt: Math.floor(Date.now() / 1000) + json.expireIn - 300,
	};
}

/** 不带 `parentId`：层级由 `fetch-org.ts` 的遍历得出 */
interface DeptNode {
	deptId: number;
	name: string;
}

/** 根部门（`dept_id=1`）的 name 是企业名称，`listsub` 拿不到，只能由它取 */
export async function getDept(
	accessToken: string,
	deptId: number,
): Promise<DeptNode> {
	const json = await postJson<{
		result: { dept_id: number; name: string };
	}>(
		`/topapi/v2/department/get?access_token=${encodeURIComponent(accessToken)}`,
		{ dept_id: deptId, language: "zh_CN" },
	);
	return { deptId: json.result.dept_id, name: json.result.name };
}

export async function listSubDepts(
	accessToken: string,
	deptId: number,
): Promise<DeptNode[]> {
	const json = await postJson<{
		result: Array<{ dept_id: number; name: string }>;
	}>(
		`/topapi/v2/department/listsub?access_token=${encodeURIComponent(accessToken)}`,
		{ dept_id: deptId },
	);
	return (json.result ?? []).map((d) => ({ deptId: d.dept_id, name: d.name }));
}

/**
 * `topapi/v2/user/list` 的成员。⚠️ 别退回 listsimple：它没有 unionid / org_email。
 * unionid 与 org_email 在「个人信息」权限点之下，未开通时静默缺失。钉钉的 `email`
 * （管理员手填、未验证）刻意不声明。
 */
export interface DeptUser {
	userid: string;
	name: string;
	unionid?: string;
	org_email?: string;
	avatar?: string;
	/** 一人多职用「；」「;」分隔。缺失有两种形态：键不存在与空串 */
	title?: string;
	/** 自定义字段，是 JSON 字符串而不是对象 */
	extension?: string;
	/** ⚠️ 相对请求里的 `dept_id`，不是全局的：一人在上级部门 false、在下属小组 true */
	leader?: boolean;
}

/** 部门直属成员，cursor 分页取到 has_more 为 false */
export async function listDeptUsersV2(
	accessToken: string,
	deptId: number,
): Promise<DeptUser[]> {
	const out: DeptUser[] = [];
	let cursor = 0;
	for (;;) {
		const json = await postJson<{
			result: { list: DeptUser[]; has_more: boolean; next_cursor?: number };
		}>(`/topapi/v2/user/list?access_token=${encodeURIComponent(accessToken)}`, {
			dept_id: deptId,
			cursor,
			size: 100,
			language: "zh_CN",
		});
		out.push(...(json.result?.list ?? []));
		if (!json.result?.has_more) break;
		cursor = json.result.next_cursor ?? 0;
	}
	return out;
}

/** `topapi/user/getbyunionid` 查无此人（含已离职） */
export const USER_NOT_FOUND_ERRCODE = 60121;

/**
 * 按 unionid 实时查本企业通讯录。`contact_type`：0 企业内部员工、1 企业外部联系人（也查得到）；
 * 文档的表格写 Number、返回示例写 "0"。
 */
export async function getUserByUnionId(
	accessToken: string,
	unionid: string,
): Promise<{ userid: string; contact_type: number | string }> {
	const json = await postJson<{
		result: { userid: string; contact_type: number | string };
	}>(
		`/topapi/user/getbyunionid?access_token=${encodeURIComponent(accessToken)}`,
		{ unionid },
	);
	return json.result;
}

/**
 * 用户级 OAuth：授权码换用户 token。⚠️ 收 JSON body 而非标准的 form 编码，别套通用
 * OAuth 库。只允许 interaction 层调用。
 */
export async function getUserAccessToken(
	cred: DingtalkCredentials,
	code: string,
): Promise<{ accessToken: string }> {
	return await newApiRequest<{ accessToken: string }>(
		"/v1.0/oauth2/userAccessToken",
		{
			method: "POST",
			body: {
				clientId: cred.clientId,
				clientSecret: cred.clientSecret,
				code,
				grantType: "authorization_code",
			},
		},
	);
}

/** 取「我」的 unionId。需要 `Contact.User.Read` 权限点，否则报 `AccessTokenPermissionDenied` */
export async function getContactUser(
	userAccessToken: string,
): Promise<{ unionId: string }> {
	return await newApiRequest<{ unionId: string }>("/v1.0/contact/users/me", {
		method: "GET",
		headers: { "x-acs-dingtalk-access-token": userAccessToken },
	});
}
