import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Deps } from "~/deps";
import type { DingtalkCredentials } from "~/dingtalk/client";
import type {
	OrgApiDeptsResponse,
	OrgApiUsersResponse,
} from "~/domain/org-api";
import { AUDIT_ACTIONS } from "~/resources";
import { getOrSyncOrg } from "~/sync/org";
import { type OrgReader, readOrgDepartments, readOrgUsers } from "~/sync/store";

import { requireCaller } from "./guard";

/** 所有调用方读到的都是自有应用那一份组织数据。不分页：几百人约几十 KB */
export function registerOrgRoutes(
	app: FastifyInstance,
	deps: Deps,
	dingtalk: DingtalkCredentials,
): void {
	const load = <T>(req: FastifyRequest, read: OrgReader<T>) => {
		requireCaller(req);
		return getOrSyncOrg({ db: deps.db, dingtalk, log: req.log }, read);
	};

	app.get(
		"/api/v1/org/users",
		{ config: { auditAction: AUDIT_ACTIONS.orgListUsers } },
		async (req) => {
			const { items: users, fetchedAt } = await load(req, readOrgUsers);
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
			const { items: departments, fetchedAt } = await load(
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
}
