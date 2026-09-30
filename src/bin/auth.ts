import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

import { newApiKey } from "~/auth/new-api-key";
import { type AuthEntry, appendAuthEntry } from "~/domain/config-json";
import { formatIssues } from "~/env";
import { errMessage } from "~/log";
import { newOidcClient } from "~/oidc/new-client";

/**
 * 生成 `AUTH_JSON` 的一项：`auth:oidc`（下游 client）、`auth:apikey`（REST 调用方）。
 * ⚠️ 只在本机跑、不进镜像：输出含 client secret 与 API key，在 Pod 里跑会进日志。
 * stdout 只有一行 JSON：默认 `[新项]`；带 `--merge` 时从 stdin 读现有 AUTH_JSON，输出接上新项、
 * 整体校验过的完整数组。给人看的提示走 stderr、不经 `~/log`。
 * `--merge` 要显式给而不是探测 stdin：stdin 不是终端却一直不关（如不带 -t 的 ssh）时，探测会卡住。
 */

const USAGE = [
	"用法：",
	"  pnpm -s auth:oidc --name <名字> --redirect-uri <回调地址> [--redirect-uri …]",
	"                    [--redirect-uri-regex <整串匹配的正则> …] [--merge]",
	"  pnpm -s auth:apikey --name <调用方名字> [--merge]",
	"",
	"  --merge  从 stdin 读现有 AUTH_JSON，输出接上新项的完整数组：",
	'           echo "$AUTH_JSON" | pnpm -s auth:apikey --name hr-system --merge',
].join("\n");

const EX_USAGE = 64;
const EX_DATAERR = 65;

interface Generated {
	entry: AuthEntry;
	merge: boolean;
	hint: string[];
}

function usageError(message: string): number {
	console.error(`${message}\n\n${USAGE}`);
	return EX_USAGE;
}

function oidc(args: string[]): Generated | number {
	const { values } = parseArgs({
		args,
		options: {
			name: { type: "string" },
			"redirect-uri": { type: "string", multiple: true },
			"redirect-uri-regex": { type: "string", multiple: true },
			merge: { type: "boolean" },
		},
	});
	const r = newOidcClient({
		name: values.name ?? "",
		redirectUris: values["redirect-uri"] ?? [],
		redirectUriRegexes: values["redirect-uri-regex"],
	});
	if (!r.success) return usageError(`参数不合法：\n${formatIssues(r.error)}`);
	return {
		entry: r.data,
		merge: values.merge ?? false,
		hint: [
			`已生成 client「${r.data.name}」。下游填：`,
			`  client_id       ${r.data.id}`,
			"  client_secret   输出 JSON 里的 secret",
			"  token 端点认证  client_secret_basic 或 client_secret_post 均可",
		],
	};
}

function apikey(args: string[]): Generated | number {
	const { values } = parseArgs({
		args,
		options: {
			name: { type: "string" },
			merge: { type: "boolean" },
		},
	});
	const r = newApiKey(values.name ?? "");
	if (!r.success) return usageError(`参数不合法：\n${formatIssues(r.error)}`);
	return {
		entry: r.data,
		merge: values.merge ?? false,
		hint: [
			`已生成 API key「${r.data.name}」。输出 JSON 里的 key 交给调用方：`,
			'  curl -H "Authorization: Bearer <key>" https://<域名>/api/v1/org/users',
		],
	};
}

const COMMANDS: Record<string, (args: string[]) => Generated | number> = {
	oidc,
	apikey,
};

async function main(): Promise<number> {
	const [kind = "", ...args] = process.argv.slice(2);
	if ([kind, ...args].some((a) => a === "-h" || a === "--help")) {
		console.error(USAGE);
		return 0;
	}
	const command = COMMANDS[kind];
	if (!command) return usageError(`子命令只有 oidc 与 apikey`);

	let generated: Generated | number;
	try {
		generated = command(args);
	} catch (err) {
		return usageError(errMessage(err));
	}
	if (typeof generated === "number") return generated;

	let output: unknown[] = [generated.entry];
	if (generated.merge) {
		const merged = appendAuthEntry(await text(process.stdin), generated.entry);
		if (!merged.success) {
			console.error(
				`合并后的 AUTH_JSON 不合法（新项是最后一项）：\n${formatIssues(merged.error)}`,
			);
			return EX_DATAERR;
		}
		output = merged.data;
	}

	process.stdout.write(`${JSON.stringify(output)}\n`);
	console.error(
		[
			"",
			...generated.hint,
			"",
			generated.merge
				? "上面是完整的 AUTH_JSON，整行替换 Secret 里的旧值。"
				: "上面那一项并进 Secret 的 AUTH_JSON 数组（或带 --merge 让命令来拼）。",
			"改完 Secret 要 bump secretVersion。",
		].join("\n"),
	);
	return 0;
}

process.exitCode = await main();
