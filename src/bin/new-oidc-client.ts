import { parseArgs } from "node:util";

import { formatIssues } from "~/env";
import { errMessage } from "~/log";
import { newOidcClient } from "~/oidc/new-client";

/**
 * 生成一个下游 OIDC client。⚠️ 只在本机跑、不进镜像：在 Pod 里跑，secret 随 stdout 进日志。
 * stdout 只有一行 JSON（可直接作 `OIDC_CLIENTS_JSON`），给人看的提示走 stderr、不经 `~/log`。
 */

const USAGE =
	"用法：pnpm oidc:new-client --name <名字> --redirect-uri <回调地址> [--redirect-uri …]";

const EX_USAGE = 64;

function main(): number {
	let values: {
		name?: string;
		"redirect-uri"?: string[];
		help?: boolean;
	};
	try {
		({ values } = parseArgs({
			options: {
				name: { type: "string" },
				"redirect-uri": { type: "string", multiple: true },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (err) {
		console.error(`${errMessage(err)}\n${USAGE}`);
		return EX_USAGE;
	}
	if (values.help) {
		console.error(USAGE);
		return 0;
	}

	const result = newOidcClient({
		name: values.name ?? "",
		redirectUris: values["redirect-uri"] ?? [],
	});
	if (!result.success) {
		console.error(`参数不合法：\n${formatIssues(result.error)}\n${USAGE}`);
		return EX_USAGE;
	}

	const client = result.data;
	process.stdout.write(`${JSON.stringify([client])}\n`);
	console.error(
		[
			"",
			`已生成 client「${client.name}」。上面那行放进 Secret 的 OIDC_CLIENTS_JSON，下游填：`,
			`  client_id       ${client.id}`,
			"  client_secret   上面 JSON 里的 secret",
			"  token 端点认证  client_secret_basic 或 client_secret_post 均可",
		].join("\n"),
	);
	return 0;
}

process.exitCode = main();
