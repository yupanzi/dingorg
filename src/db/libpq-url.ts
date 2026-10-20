// sslmode 按 libpq 语义：pg 8 默认把 require 当 verify-full，RDS 的私有 CA 不在 Node 的根证书里，
// 写 require 就连不上。用 pg 自己认的 URL 开关，drizzle-kit 也能用；URL 里已写了就照写的来。
// 不 import 任何东西：drizzle.config.ts 也引它
export function libpqUrl(url: string): string {
	if (/[?&]uselibpqcompat=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}uselibpqcompat=true`;
}
