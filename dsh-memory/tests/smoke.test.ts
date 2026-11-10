import { describe, expect, it } from "vitest";
import * as plugin from "../src/index.js";

describe("插件元数据", () => {
	it("导出 cordis 需要的三件套", () => {
		expect(plugin.name).toBe("simple-memory");
		expect(plugin.inject).toContain("tools");
		expect(typeof plugin.apply).toBe("function");
	});
	it("不导出 schemastery Config（零宿主运行时 import 的推论）", () => {
		expect((plugin as Record<string, unknown>).Config).toBeUndefined();
	});
});
