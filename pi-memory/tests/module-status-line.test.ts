import { describe, expect, it } from "vitest";
import { moduleStatusLine } from "../index";
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/config";

// `/memory` 的模块状态行是纯函数，直接单测：走 wiring 只能盖到「正常配置」那一种。
describe("moduleStatusLine", () => {
	const cfg = (over: Partial<MemoryConfig> = {}): MemoryConfig => ({ ...DEFAULT_CONFIG, ...over });

	it("reports each module with its effective model", () => {
		const config = cfg({
			defaults: { model: "shared/model" },
			extractMemories: { ...DEFAULT_CONFIG.extractMemories, enabled: true, model: "extract/model" },
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: false },
		});

		expect(moduleStatusLine(config)).toBe(
			"dream=on(shared/model) extractMemories=on(extract/model) autoSurfacing=off",
		);
	});

	// 正常会话跑不到这里（模型缺失会在 session_start 被拦成 misconfigured），
	// 但状态行绝不能印出 `on(undefined)` —— 防御性回落要有测试钉住。
	it("prints no model instead of on(undefined) when nothing resolves", () => {
		expect(moduleStatusLine(cfg({ defaults: undefined }))).toBe(
			"dream=on(no model) extractMemories=off autoSurfacing=on(no model)",
		);
	});

	// `deepMerge` 对 `"extractMemories": null` 会真的写入 null：状态行不能因此抛错。
	it("treats a null module config as off instead of throwing", () => {
		const config = cfg({
			defaults: { model: "shared/model" },
			extractMemories: null as unknown as MemoryConfig["extractMemories"],
		});

		expect(moduleStatusLine(config)).toBe(
			"dream=on(shared/model) extractMemories=off autoSurfacing=on(shared/model)",
		);
	});

});
