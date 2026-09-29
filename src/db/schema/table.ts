import { pgTableCreator } from "drizzle-orm/pg-core";

/** 多项目共用一个 PG 实例时靠前缀归属。改前缀 = 改表名，要走迁移 */
export const createTable = pgTableCreator((name) => `dingorg_${name}`);
