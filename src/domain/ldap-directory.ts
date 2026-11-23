/**
 * 组织数据 → LDAP 目录条目，即 `GET /api/v2/directory` 的响应本体。读的是与 v1 同一份镜像。
 *
 * ⚠️ 严格按标准 schema（人 `inetOrgPerson`、部门 `groupOfNames`，钉钉特有的走 `ldap/dingorg.ldif`
 * 里的两个辅助类）：每个条目都要能原样转成 LDIF、导入标准 LDAP 服务器。由此有四条不变量，
 * 别为了「多给一点数据」破掉：
 * - MUST 属性一个不缺：`sn` 与 `cn` 同值（钉钉没有单独的姓）；没人、也没有子部门的部门递归不出
 *   （`groupOfNames` 至少一个 `member`）。
 * - 多值属性没有重复值（按属性的等值规则比，见 `encode`）。
 * - 每个 DN 引用（`member` / `owner` / `memberOf`）都指向这次输出了的条目。
 * - 按 entries 的顺序逐条导入不会引用到还没建的条目：容器 → 人 → 部门（子部门在父部门之前）。
 *
 * 层级只用 `member` 嵌套表达，DN 平铺且只含永不变的 id：改邮箱、部门改名、调整架构都不改 DN。
 */

import { serializeLdif } from "./ldif";
import type {
	OrgApiDirectoryEntry as DirectoryEntry,
	OrgApiDept,
	OrgApiUser,
} from "./org-api";
import { compareCodeUnits } from "./org-sync";

/**
 * 自定义 schema 的私有 OID 分支：ITU-T X.667 规定 `2.25.<UUID 的十进制>` 无需注册。⚠️ 别换：
 * 导入过的目录按 OID 认属性，换了就是另一套属性
 */
const OID_ARC = "2.25.85610322623710650288480421299384792651";

const DIRECTORY_STRING_SYNTAX = "1.3.6.1.4.1.1466.115.121.1.15";
const INTEGER_SYNTAX = "1.3.6.1.4.1.1466.115.121.1.27";

interface CustomAttributeType {
	oid: string;
	desc: string;
	equality: "caseExactMatch" | "caseIgnoreMatch" | "integerMatch";
	syntax: string;
	single: boolean;
}

/**
 * 钉钉特有、标准 schema 里没有的属性。
 * ⚠️ `dingtalkUnionId` 必须 caseExactMatch：它区分大小写又是 RDN，忽略大小写会让两个人撞成同一个 DN
 */
const CUSTOM_ATTRIBUTE_TYPES = {
	dingtalkUnionId: {
		oid: `${OID_ARC}.1.1`,
		desc: "DingTalk unionId: permanent across apps, also the OIDC sub",
		equality: "caseExactMatch",
		syntax: DIRECTORY_STRING_SYNTAX,
		single: true,
	},
	dingtalkUserId: {
		oid: `${OID_ARC}.1.2`,
		desc: "DingTalk userid within the corp, changes on re-hire",
		equality: "caseExactMatch",
		syntax: DIRECTORY_STRING_SYNTAX,
		single: true,
	},
	dingtalkRank: {
		oid: `${OID_ARC}.1.3`,
		desc: "Rank words extracted from title",
		equality: "caseIgnoreMatch",
		syntax: DIRECTORY_STRING_SYNTAX,
		single: false,
	},
	dingtalkDeptId: {
		oid: `${OID_ARC}.1.4`,
		desc: "DingTalk department id",
		equality: "integerMatch",
		syntax: INTEGER_SYNTAX,
		single: true,
	},
} as const satisfies Record<string, CustomAttributeType>;

type CustomAttributeName = keyof typeof CUSTOM_ATTRIBUTE_TYPES;

interface CustomObjectClass {
	oid: string;
	desc: string;
	must: readonly CustomAttributeName[];
	may: readonly CustomAttributeName[];
}

/** 辅助类：条目的结构类不变，不认识它的客户端照常读标准属性 */
const CUSTOM_OBJECT_CLASSES = {
	dingtalkPerson: {
		oid: `${OID_ARC}.2.1`,
		desc: "DingTalk identity of an inetOrgPerson",
		must: ["dingtalkUnionId", "dingtalkUserId"],
		may: ["dingtalkRank"],
	},
	dingtalkGroup: {
		oid: `${OID_ARC}.2.2`,
		desc: "DingTalk department as a groupOfNames",
		must: ["dingtalkDeptId"],
		may: [],
	},
} as const satisfies Record<string, CustomObjectClass>;

interface AttributeSpec {
	/** schema 里的 SINGLE-VALUE：JSON 里写标量，其余写数组（哪怕只有一个值） */
	single: boolean;
	/** 等值规则区分大小写：多值去重按它比 */
	caseExact: boolean;
	/** 值的语法约束：不符的值进不了标准目录，不输出 */
	accepts?: RegExp;
	/** 运营属性：搜索时返回，导入时由服务器算、不能写，LDIF 里不出现 */
	operational?: true;
}

const MULTI_IGNORE_CASE: AttributeSpec = { single: false, caseExact: false };
const MULTI_EXACT: AttributeSpec = { single: false, caseExact: true };

/** 取值规则与单值 / 多值以 RFC 4519 / RFC 2798 为准 */
const STANDARD_ATTRIBUTES = {
	objectClass: MULTI_IGNORE_CASE,
	uid: MULTI_IGNORE_CASE,
	cn: MULTI_IGNORE_CASE,
	sn: MULTI_IGNORE_CASE,
	displayName: { single: true, caseExact: false },
	// IA5 String：非 ASCII 的地址进不了标准目录
	mail: { ...MULTI_IGNORE_CASE, accepts: /^[\x21-\x7e]+$/ },
	title: MULTI_IGNORE_CASE,
	departmentNumber: MULTI_IGNORE_CASE,
	ou: MULTI_IGNORE_CASE,
	o: MULTI_IGNORE_CASE,
	// 值是「URI [空格 标签]」，URI 里有空白就会被拆错
	labeledURI: { ...MULTI_EXACT, accepts: /^\S+$/ },
	// DN 由互不相同的 id 拼出，不会重复，不用 DN 的等值规则
	member: MULTI_EXACT,
	owner: MULTI_EXACT,
	// 服务器按各 group 的 member 算（OpenLDAP 的 memberof overlay、AD 都是），只含直属部门
	memberOf: { ...MULTI_EXACT, operational: true },
} as const satisfies Record<string, AttributeSpec>;

type AttributeName = keyof typeof STANDARD_ATTRIBUTES | CustomAttributeName;

const ATTRIBUTES: Record<AttributeName, AttributeSpec> = {
	...STANDARD_ATTRIBUTES,
	...(Object.fromEntries(
		Object.entries(CUSTOM_ATTRIBUTE_TYPES).map(([name, t]) => [
			name,
			{ single: t.single, caseExact: t.equality !== "caseIgnoreMatch" },
		]),
	) as Record<CustomAttributeName, AttributeSpec>),
};

export interface Directory {
	entries: DirectoryEntry[];
	people: number;
	groups: number;
}

const SIMPLE_RDN = "[A-Za-z][A-Za-z0-9-]*=[A-Za-z0-9][A-Za-z0-9._-]*";

/** env 只收不需要转义的简单形式，DN 拼接时就不用再管它 */
export const BASE_DN_PATTERN = new RegExp(`^${SIMPLE_RDN}(,${SIMPLE_RDN})*$`);

export const DEFAULT_BASE_DN = "dc=dingorg";

const PERSON_CLASSES = [
	"top",
	"person",
	"organizationalPerson",
	"inetOrgPerson",
	"dingtalkPerson",
];
const GROUP_CLASSES = ["top", "groupOfNames", "dingtalkGroup"];
const CONTAINER_CLASSES = ["top", "organizationalUnit"];

/** RFC 4514 §2.4：属性值放进 DN 前的转义 */
export function escapeDnValue(value: string): string {
	const chars = [...value];
	return chars
		.map((c, i) => {
			if (c === "\0") return "\\00";
			if ('"+,;<>\\'.includes(c)) return `\\${c}`;
			if (c === " " && (i === 0 || i === chars.length - 1)) return "\\ ";
			if (c === "#" && i === 0) return "\\#";
			return c;
		})
		.join("");
}

// 等值规则都忽略首尾与连续空白（RFC 4518 的 insignificant space）
function matchKey(value: string, caseExact: boolean): string {
	const folded = value.replace(/\s+/g, " ");
	return caseExact ? folded : folded.toLowerCase();
}

/**
 * 按属性表编码：去掉空值、按等值规则去重、单值写成标量。⚠️ 单值属性给了多个值是代码错，
 * 抛出而不是静默取第一个
 */
function encode(
	attrs: Partial<Record<AttributeName, readonly string[]>>,
): DirectoryEntry["attributes"] {
	const out: DirectoryEntry["attributes"] = {};
	for (const [name, raw] of Object.entries(attrs) as Array<
		[AttributeName, readonly string[]]
	>) {
		const spec = ATTRIBUTES[name];
		const seen = new Set<string>();
		const values: string[] = [];
		for (const v of raw) {
			const value = v.trim();
			if (!value || (spec.accepts && !spec.accepts.test(value))) continue;
			const key = matchKey(value, spec.caseExact);
			if (seen.has(key)) continue;
			seen.add(key);
			values.push(value);
		}
		if (!values.length) continue;
		if (spec.single) {
			if (values.length > 1) {
				throw new Error(`${name} 是单值属性，却有 ${values.length} 个值`);
			}
			out[name] = values[0] as string;
		} else {
			out[name] = values;
		}
	}
	return out;
}

/**
 * @param users 当前成员（离开的人不该传进来）；没有 unionid 的人不进目录，引用也不指向他
 * @param departments 全部部门；根部门（`parentId` 为 null）的名字即企业名，填进每个人的 `o`
 */
export function buildDirectory(
	input: {
		users: readonly OrgApiUser[];
		departments: readonly OrgApiDept[];
	},
	baseDn: string,
): Directory {
	const peopleBase = `ou=people,${baseDn}`;
	const groupsBase = `ou=groups,${baseDn}`;
	const personDn = (unionid: string) =>
		`dingtalkUnionId=${escapeDnValue(unionid)},${peopleBase}`;
	const groupDn = (id: number) => `dingtalkDeptId=${id},${groupsBase}`;

	const people = input.users
		.flatMap((u) => {
			// DN 与属性值用同一个：属性值会被 trim，DN 里留着首尾空白两处就对不上
			const unionid = u.dingtalk.unionid?.trim();
			return unionid ? [{ ...u, unionid, dn: personDn(unionid) }] : [];
		})
		.sort((a, b) => compareCodeUnits(a.userName, b.userName));

	const membersOf = new Map<number, string[]>();
	const ownersOf = new Map<number, string[]>();
	for (const p of people) {
		for (const d of p.depts) {
			push(membersOf, d.id, p.dn);
			if (d.isLeader) push(ownersOf, d.id, p.dn);
		}
	}

	const byId = new Map(input.departments.map((d) => [d.id, d]));
	const childrenOf = new Map<number, OrgApiDept[]>();
	const roots: OrgApiDept[] = [];
	for (const d of [...input.departments].sort((a, b) => a.id - b.id)) {
		if (d.parentId !== null && byId.has(d.parentId)) {
			push(childrenOf, d.parentId, d);
		} else {
			roots.push(d);
		}
	}

	// 后序遍历：子部门先于父部门产出，空不空也自底向上才判得出
	const groups: DirectoryEntry[] = [];
	const kept = new Set<number>();
	const visit = (d: OrgApiDept): void => {
		const children = childrenOf.get(d.id) ?? [];
		for (const c of children) visit(c);
		const member = [
			...(membersOf.get(d.id) ?? []),
			...children.filter((c) => kept.has(c.id)).map((c) => groupDn(c.id)),
		];
		if (!member.length) return;
		kept.add(d.id);
		groups.push({
			dn: groupDn(d.id),
			attributes: encode({
				objectClass: GROUP_CLASSES,
				cn: [d.name],
				member,
				owner: ownersOf.get(d.id) ?? [],
				dingtalkDeptId: [String(d.id)],
			}),
		});
	};
	for (const r of roots) visit(r);

	const orgName = input.departments.find((d) => d.parentId === null)?.name;
	const personEntries = people.map((p): DirectoryEntry => {
		const depts = p.depts
			.filter((d) => kept.has(d.id))
			.sort((a, b) => a.id - b.id);
		// cn / sn 是 MUST：显示名为空时退回 uid（userName 由归一化保证非空）
		const name = p.displayName.trim() || p.userName;
		return {
			dn: p.dn,
			attributes: encode({
				objectClass: PERSON_CLASSES,
				uid: [p.userName],
				cn: [name],
				sn: [name],
				displayName: [name],
				mail: p.email ? [p.email] : [],
				title: p.titles,
				departmentNumber: depts.map((d) => String(d.id)),
				ou: depts.map((d) => d.name),
				o: orgName ? [orgName] : [],
				labeledURI: p.dingtalk.avatar ? [p.dingtalk.avatar] : [],
				memberOf: depts.map((d) => groupDn(d.id)),
				dingtalkUnionId: [p.unionid],
				dingtalkUserId: [p.dingtalk.userid],
				dingtalkRank: p.ranks,
			}),
		};
	});

	const container = (ou: string): DirectoryEntry => ({
		dn: `ou=${ou},${baseDn}`,
		attributes: encode({ objectClass: CONTAINER_CLASSES, ou: [ou] }),
	});

	return {
		entries: [
			container("people"),
			container("groups"),
			...personEntries,
			...groups,
		],
		people: personEntries.length,
		groups: groups.length,
	};
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/** 目录条目 → LDIF，条目与顺序同 JSON，不写运营属性 */
export function directoryToLdif(
	entries: readonly DirectoryEntry[],
	header: { baseDn: string; fetchedAt: string },
): string {
	return serializeLdif(
		entries.map((e) => ({
			dn: e.dn,
			attributes: Object.entries(e.attributes)
				.filter(([name]) => !ATTRIBUTES[name as AttributeName].operational)
				.flatMap(([name, v]) =>
					(Array.isArray(v) ? v : [v]).map((value) => [name, value] as const),
				),
		})),
		[
			`baseDn: ${header.baseDn}`,
			`fetchedAt: ${header.fetchedAt}`,
			"Load ldap/dingorg.ldif (custom schema) first, then ldapadd this file in order.",
			"memberOf is operational and omitted: the server derives it from member.",
		],
	);
}

/**
 * `ldap/dingorg.ldif` 的内容（OpenLDAP cn=config 格式）。⚠️ 那个文件由它生成，别手改：
 * `ldap-directory.test.ts` 比对两者，改了这里的定义要重新生成。输出只含 ASCII（测试卡着）：
 * DESC 与注释都别写中文，整份交给 ldapadd
 */
export function renderOpenLdapSchema(): string {
	const list = (names: readonly string[]) =>
		names.length === 1 ? names[0] : `( ${names.join(" $ ")} )`;

	const attributeTypes = Object.entries(CUSTOM_ATTRIBUTE_TYPES).map(
		([name, t]: [string, CustomAttributeType]) =>
			`olcAttributeTypes: ( ${t.oid} NAME '${name}' DESC '${t.desc}' EQUALITY ${t.equality} SYNTAX ${t.syntax}${t.single ? " SINGLE-VALUE" : ""} )`,
	);
	const objectClasses = Object.entries(CUSTOM_OBJECT_CLASSES).map(
		([name, c]: [string, CustomObjectClass]) =>
			[
				`olcObjectClasses: ( ${c.oid} NAME '${name}' DESC '${c.desc}' SUP top AUXILIARY`,
				c.must.length ? ` MUST ${list(c.must)}` : "",
				c.may.length ? ` MAY ${list(c.may)}` : "",
				" )",
			].join(""),
	);

	return [
		"# Generated by renderOpenLdapSchema in src/domain/ldap-directory.ts. Do not edit.",
		"# Load: ldapadd -Y EXTERNAL -H ldapi:/// -f ldap/dingorg.ldif",
		"dn: cn=dingorg,cn=schema,cn=config",
		"objectClass: olcSchemaConfig",
		"cn: dingorg",
		...attributeTypes,
		...objectClasses,
		"",
	].join("\n");
}
