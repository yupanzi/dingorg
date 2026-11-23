import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Deps } from "~/deps";
import { buildDirectory, directoryToLdif } from "~/domain/ldap-directory";
import type {
	OrgApiDeptsResponse,
	OrgApiDirectoryResponse,
	OrgApiUsersResponse,
} from "~/domain/org-api";
import { AUDIT_ACTIONS } from "~/resources";
import { getOrSyncOrg, type OrgSource } from "~/sync/org";
import {
	type OrgReader,
	readOrgDepartments,
	readOrgDirectory,
	readOrgUsers,
} from "~/sync/store";

import { requireCaller } from "./guard";

/** 所有调用方读到的都是自有应用那一份组织数据。不分页：几百人约几十 KB */
export function registerOrgRoutes(
	app: FastifyInstance,
	deps: Deps,
	orgSource: OrgSource,
	ldapBaseDn: string,
): void {
	const load = <T>(req: FastifyRequest, read: OrgReader<T>) => {
		requireCaller(req);
		return getOrSyncOrg({ db: deps.db, ...orgSource, log: req.log }, read);
	};

	app.get(
		"/api/v1/org/users",
		{ config: { auditAction: AUDIT_ACTIONS.orgListUsers } },
		async (req) => {
			const { data: users, fetchedAt } = await load(req, readOrgUsers);
			req.auditPatch.details = {
				summary: `读取成员名录（${users.length} 人）`,
			};
			const body: OrgApiUsersResponse = {
				users,
				total: users.length,
				fetchedAt: fetchedAt.toISOString(),
			};
			return body;
		},
	);

	app.get(
		"/api/v1/org/departments",
		{ config: { auditAction: AUDIT_ACTIONS.orgListDepartments } },
		async (req) => {
			const { data: departments, fetchedAt } = await load(
				req,
				readOrgDepartments,
			);
			req.auditPatch.details = {
				summary: `读取部门列表（${departments.length} 个）`,
			};
			const body: OrgApiDeptsResponse = {
				departments,
				total: departments.length,
				fetchedAt: fetchedAt.toISOString(),
			};
			return body;
		},
	);

	// JSON 与 LDIF 的审计说法共用，动作串分开记
	const loadDirectory = async (req: FastifyRequest) => {
		const { data, fetchedAt } = await load(req, readOrgDirectory);
		const directory = buildDirectory(data, ldapBaseDn);
		req.auditPatch.details = {
			summary: `读取目录（${directory.people} 人、${directory.groups} 个部门）`,
		};
		return { entries: directory.entries, fetchedAt };
	};

	app.get(
		"/api/v2/directory",
		{ config: { auditAction: AUDIT_ACTIONS.orgReadDirectory } },
		async (req) => {
			const { entries, fetchedAt } = await loadDirectory(req);
			const body: OrgApiDirectoryResponse = {
				baseDn: ldapBaseDn,
				entries,
				total: entries.length,
				fetchedAt: fetchedAt.toISOString(),
			};
			return body;
		},
	);

	// LDIF 没有注册过的 media type，按纯文本给；数据时刻写在注释里
	app.get(
		"/api/v2/directory.ldif",
		{ config: { auditAction: AUDIT_ACTIONS.orgReadDirectoryLdif } },
		async (req, reply) => {
			const { entries, fetchedAt } = await loadDirectory(req);
			return reply.type("text/plain; charset=utf-8").send(
				directoryToLdif(entries, {
					baseDn: ldapBaseDn,
					fetchedAt: fetchedAt.toISOString(),
				}),
			);
		},
	);
}
