import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { createDb } from "./index";

const BASE = "postgresql://u:p@db.example:5432/db";

describe("createDb 的 sslmode 语义", () => {
	// Client 只解析连接串、不连库
	it.each([
		["?sslmode=require", { rejectUnauthorized: false }],
		["?sslmode=verify-full", {}],
		["", false],
		["?uselibpqcompat=false&sslmode=require", {}],
	])("%s → ssl %o", (query, ssl) => {
		const { options } = createDb(BASE + query).$client;
		expect(new Client(options).ssl).toEqual(ssl);
	});
});
