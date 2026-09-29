import type { FastifyReply } from "fastify";

/** 每个插进模板的动态值都要过它：错误页的文案可能来自钉钉回调的 query */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const STYLE = `body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328;margin:0}main{max-width:28rem;padding:2.5rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:1.1rem;margin:0 0 .75rem}p{margin:0;line-height:1.7;color:#57606a;font-size:.9rem}`;

export function htmlPage(title: string, message: string): string {
	const t = escapeHtml(title);
	const m = escapeHtml(message);
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t}</title><style>${STYLE}</style></head><body><main><h1>${t}</h1><p>${m}</p></main></body></html>`;
}

export function sendErrorPage(
	reply: FastifyReply,
	status: number,
	title: string,
	message: string,
) {
	return reply
		.code(status)
		.type("text/html; charset=utf-8")
		.send(htmlPage(title, message));
}

export type ErrorPage = readonly [
	status: number,
	title: string,
	message: string,
];

export const SESSION_INVALID_PAGE: ErrorPage = [
	400,
	"登录会话无效",
	"登录会话不存在或已过期，请回到应用重新发起登录。",
];

export function sendSessionInvalid(reply: FastifyReply) {
	return sendErrorPage(reply, ...SESSION_INVALID_PAGE);
}
