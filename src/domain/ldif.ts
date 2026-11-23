/**
 * RFC 2849 的 LDIF 内容记录（content records，不是 change records）。只管编码，哪些属性写进来
 * 由调用方定（见 `~/domain/ldap-directory` 的 `directoryToLdif`）。
 */

/** `ldapsearch` 默认的折行宽度。值里的非 ASCII 都走了 base64，每行都是 ASCII，按字符切不会切坏 */
const LINE_WIDTH = 76;

/**
 * SAFE-STRING（RFC 2849 §2）：不含 NUL / LF / CR / 非 ASCII，且首字符不是空格、`:`、`<`。
 * 结尾是空格的也不算：§2 note 8 要求 base64，否则会被当成可忽略的空白
 */
function isSafeString(value: string): boolean {
	if (value.endsWith(" ")) return false;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c === 0x00 || c === 0x0a || c === 0x0d || c > 0x7f) return false;
		if (i === 0 && (c === 0x20 || c === 0x3a || c === 0x3c)) return false;
	}
	return true;
}

/** 续行以一个空格开头，空格本身占宽度 */
function fold(line: string): string {
	if (line.length <= LINE_WIDTH) return line;
	const parts = [line.slice(0, LINE_WIDTH)];
	for (let i = LINE_WIDTH; i < line.length; i += LINE_WIDTH - 1) {
		parts.push(` ${line.slice(i, i + LINE_WIDTH - 1)}`);
	}
	return parts.join("\n");
}

function ldifLine(name: string, value: string): string {
	return fold(
		isSafeString(value)
			? `${name}: ${value}`
			: `${name}:: ${Buffer.from(value, "utf8").toString("base64")}`,
	);
}

export interface LdifRecord {
	dn: string;
	/** 多值属性展开成多行，按给定顺序写 */
	attributes: ReadonlyArray<readonly [name: string, value: string]>;
}

/** @param comments 写在 `version: 1` 之后的 `#` 注释，只收 ASCII 单行 */
export function serializeLdif(
	records: readonly LdifRecord[],
	comments: readonly string[] = [],
): string {
	const lines = ["version: 1"];
	for (const c of comments) {
		if (!/^[\x20-\x7e]*$/.test(c))
			throw new Error(`LDIF 注释只收 ASCII 单行：${c}`);
		lines.push(`# ${c}`);
	}
	for (const r of records) {
		lines.push(
			"",
			ldifLine("dn", r.dn),
			...r.attributes.map(([name, value]) => ldifLine(name, value)),
		);
	}
	return `${lines.join("\n")}\n`;
}
