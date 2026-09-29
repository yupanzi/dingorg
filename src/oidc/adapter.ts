import { and, eq } from "drizzle-orm";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Database } from "~/db";
import { oidcPayloads } from "~/db/schema";

/**
 * oidc-provider 的 PG 存储：所有 model 共用 `oidc_payloads` 单表。读取时判过期，行由
 * oidcpurge cron 删。Client 恒返回 undefined（client 是静态配置）。
 */

type PayloadRow = typeof oidcPayloads.$inferSelect;

function toAdapterPayload(
	row: PayloadRow | undefined,
): AdapterPayload | undefined {
	if (!row) return undefined;
	if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
	return {
		...(row.payload as AdapterPayload),
		...(row.consumedAt
			? { consumed: Math.floor(row.consumedAt.getTime() / 1000) }
			: {}),
	};
}

class DrizzleAdapter implements Adapter {
	constructor(
		private readonly db: Database,
		private readonly name: string,
	) {}

	async upsert(
		id: string,
		payload: AdapterPayload,
		expiresIn: number,
	): Promise<void> {
		const expiresAt = expiresIn
			? new Date(Date.now() + expiresIn * 1000)
			: null;
		const values = {
			model: this.name,
			id,
			payload: payload as Record<string, unknown>,
			grantId: (payload as { grantId?: string }).grantId ?? null,
			uid: (payload as { uid?: string }).uid ?? null,
			expiresAt,
			consumedAt: null,
		};
		// set 复用同一个对象：另抄一份字段，加列时漏掉冲突更新那半是静默的
		await this.db
			.insert(oidcPayloads)
			.values(values)
			.onConflictDoUpdate({
				target: [oidcPayloads.model, oidcPayloads.id],
				set: values,
			});
	}

	/** 每条查询都要带：少了它 `destroy` 会跨 model 删除 */
	private get scoped() {
		return eq(oidcPayloads.model, this.name);
	}

	async find(id: string): Promise<AdapterPayload | undefined> {
		// ⚠️ 别改成放行任意 id：那等于打开动态注册
		if (this.name === "Client") return undefined;
		const [row] = await this.db
			.select()
			.from(oidcPayloads)
			.where(and(this.scoped, eq(oidcPayloads.id, id)))
			.limit(1);
		return toAdapterPayload(row);
	}

	async findByUid(uid: string): Promise<AdapterPayload | undefined> {
		const [row] = await this.db
			.select()
			.from(oidcPayloads)
			.where(and(this.scoped, eq(oidcPayloads.uid, uid)))
			.limit(1);
		return toAdapterPayload(row);
	}

	// 设备码流程未启用
	async findByUserCode(_userCode: string): Promise<AdapterPayload | undefined> {
		return undefined;
	}

	async consume(id: string): Promise<void> {
		await this.db
			.update(oidcPayloads)
			.set({ consumedAt: new Date() })
			.where(and(this.scoped, eq(oidcPayloads.id, id)));
	}

	async destroy(id: string): Promise<void> {
		await this.db
			.delete(oidcPayloads)
			.where(and(this.scoped, eq(oidcPayloads.id, id)));
	}

	async revokeByGrantId(grantId: string): Promise<void> {
		await this.db
			.delete(oidcPayloads)
			.where(and(this.scoped, eq(oidcPayloads.grantId, grantId)));
	}
}

export function createAdapterFactory(db: Database): (name: string) => Adapter {
	return (name: string) => new DrizzleAdapter(db, name);
}
