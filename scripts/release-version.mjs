// semantic-release 的 prepareCmd 调用：把算出的版本写进 package.json 与 Chart.yaml。
// chart 的 appVersion 是 image.tag 的默认值，漏写 = 按 chart 部署拉到旧镜像。
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version)
	throw new Error("用法：node scripts/release-version.mjs <version>");

const pkgFile = "package.json";
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
pkg.version = version;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, "\t")}\n`);

const chartFile = "charts/dingorg/Chart.yaml";
let chart = readFileSync(chartFile, "utf8");
for (const [key, value] of [
	["version", version],
	["appVersion", `'${version}'`],
]) {
	const line = new RegExp(`^${key}: .*$`, "m");
	// 别换成不校验的 sed：没匹配上就静默空转
	if (!line.test(chart)) throw new Error(`${chartFile} 里找不到 ${key}:`);
	chart = chart.replace(line, `${key}: ${value}`);
}
writeFileSync(chartFile, chart);
