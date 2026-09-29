import { DrizzleQueryError } from "drizzle-orm";
import pino, { type BaseLogger } from "pino";

/**
 * 全进程唯一的根 logger，fastify 经 `loggerInstance` 接的也是它。请求里用 `req.log`
 * （带 reqId，对得上审计的 `request_id`）。
 *
 * ⚠️ Error 只放 `err` 键：只有它走下面的序列化器，放别的键得到 `{}`。
 */

export const LOG_LEVELS = [
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
	"silent",
] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

// import 时就读：根 logger 要先于 env 解析存在。填错先回落 info，随后 env 校验让进程启动失败
function initialLevel(): LogLevel {
	const v = process.env.LOG_LEVEL;
	return LOG_LEVELS.find((l) => l === v) ?? "info";
}

// message 可能跨行，所以按行筛调用帧而不是按位置切
function stackFrames(stack: string | undefined): string {
	return (stack ?? "")
		.split("\n")
		.filter((line) => /^\s+at /.test(line))
		.map((line) => `\n${line}`)
		.join("");
}

/**
 * ⚠️ drizzle 把 SQL 参数拼进 `DrizzleQueryError` 的 message、stack 与 `params`，而写
 * `app_secrets`、`oidc_payloads` 时参数就是密钥。pino 会沿 cause 链、`errors`
 * （AggregateError）与值为错误的字段往下序列化，这三条路都要换成只带 SQL 的副本。
 * 图里没有它就原样返回；有的话整张图复制，循环引用靠 `seen` 收住。
 */
function redactQueryParams(err: unknown): unknown {
	return hasQueryError(err, new Set()) ? redact(err, new Map()) : err;
}

function children(err: Error): unknown[] {
	return [
		err.cause,
		(err as { errors?: unknown }).errors,
		...Object.values(err),
	];
}

function hasQueryError(v: unknown, visited: Set<unknown>): boolean {
	if (typeof v !== "object" || v === null || visited.has(v)) return false;
	visited.add(v);
	if (v instanceof DrizzleQueryError) return true;
	if (Array.isArray(v)) return v.some((x) => hasQueryError(x, visited));
	return (
		v instanceof Error && children(v).some((x) => hasQueryError(x, visited))
	);
}

function redact(v: unknown, seen: Map<Error, Error>): unknown {
	if (Array.isArray(v)) return v.map((x) => redact(x, seen));
	if (!(v instanceof Error)) return v;
	const hit = seen.get(v);
	if (hit) return hit;

	// 原型用 Error.prototype：继承 DOMException 之类的访问器，在副本上一读就抛
	const copy = Object.create(Error.prototype) as Error;
	seen.set(v, copy);
	const isQuery = v instanceof DrizzleQueryError;
	const message = isQuery ? `Failed query: ${v.query}` : v.message;
	const hidden: Record<string, unknown> = {
		// pino 取 constructor.name 作 type
		constructor: v.constructor,
		name: v.name,
		message,
		// 读原对象的值：stack 是它自己的访问器，复制到副本上读出来是 undefined
		stack: isQuery
			? `DrizzleQueryError: ${message}${stackFrames(v.stack)}`
			: v.stack,
		cause: redact(v.cause, seen),
	};
	const errors = (v as { errors?: unknown }).errors;
	if (Array.isArray(errors)) hidden.errors = redact(errors, seen);
	for (const [k, value] of Object.entries(hidden)) {
		Object.defineProperty(copy, k, {
			value,
			writable: true,
			configurable: true,
		});
	}
	for (const [k, value] of Object.entries(v)) {
		if (Object.hasOwn(hidden, k) || (isQuery && k === "params")) continue;
		Object.defineProperty(copy, k, {
			value: redact(value, seen),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return copy;
}

/** 路由级 logLevel 会覆盖根级别；只想「至少 min」时用它，否则 silent / error 下也会出日志 */
export function atLeast(min: LogLevel, current: string): LogLevel {
	const cur = LOG_LEVELS.find((l) => l === current) ?? "info";
	const rank = (l: LogLevel) =>
		pino.levels.values[l] ?? Number.POSITIVE_INFINITY;
	return rank(cur) >= rank(min) ? cur : min;
}

/** 函数要 logger 参数时收它：`req.log` 与根 logger 都满足，不必依赖 fastify 的类型 */
export type Log = Pick<BaseLogger, "error" | "warn" | "info" | "debug">;

function serializeError(err: unknown): unknown {
	return pino.stdSerializers.err(redactQueryParams(err) as Error);
}

/** 导出给测试：验证的是生产这套序列化 */
export const LOGGER_OPTIONS = {
	level: initialLevel(),
	formatters: { level: (label: string) => ({ level: label }) },
	timestamp: pino.stdTimeFunctions.isoTime,
	serializers: { err: serializeError },
} satisfies pino.LoggerOptions;

export const logger = pino(LOGGER_OPTIONS);

export function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
