import { describe, expect, it } from "vitest";

import {
	MAX_IP_LENGTH,
	MAX_REQUEST_PATH_LENGTH,
	normalizeIp,
	normalizeRequestPath,
} from "./audit";

describe("normalizeRequestPath", () => {
	it("剥掉 query string", () => {
		expect(normalizeRequestPath("/api/v1/org/users?secret=s3cr3t")).toBe(
			"/api/v1/org/users",
		);
	});

	it("普通路径原样返回", () => {
		expect(normalizeRequestPath("/api/v1/sync")).toBe("/api/v1/sync");
	});

	it("超长路径截断并留省略号", () => {
		const out = normalizeRequestPath(`/api/v1/${"a".repeat(2000)}`);
		expect(out).toHaveLength(MAX_REQUEST_PATH_LENGTH);
		expect(out?.endsWith("…")).toBe(true);
	});

	it("空值返回 null", () => {
		expect(normalizeRequestPath(null)).toBeNull();
		expect(normalizeRequestPath("")).toBeNull();
		expect(normalizeRequestPath("   ")).toBeNull();
		expect(normalizeRequestPath("?batch=1")).toBeNull();
	});
});

describe("normalizeIp", () => {
	it("伪造的超长 X-Forwarded-For 截断到列宽，而不是让审计写失败", () => {
		const out = normalizeIp("1".repeat(300));
		expect(out).toHaveLength(MAX_IP_LENGTH);
		expect(out?.endsWith("…")).toBe(true);
	});

	it("正常地址原样返回，空值为 null", () => {
		expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
		expect(normalizeIp(null)).toBeNull();
		expect(normalizeIp("")).toBeNull();
	});
});
