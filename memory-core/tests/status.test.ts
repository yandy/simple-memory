import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { moduleStatusRows } from "../src/orchestration/status.js";

describe("moduleStatusRows", () => {
	it("reports all three tasks in canonical order with the effective model", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			defaults: { model: "p/base" },
			autoSurfacing: { enabled: false },
		});
		expect(moduleStatusRows(cfg, ["dream", "extractMemories", "autoSurfacing"])).toEqual([
			{ id: "dream", implemented: true, enabled: true, model: "p/base" },
			{ id: "extractMemories", implemented: true, enabled: false },
			{ id: "autoSurfacing", implemented: true, enabled: false },
		]);
	});

	it("marks tasks the adapter does not implement", () => {
		expect(moduleStatusRows(DEFAULT_CONFIG, ["autoSurfacing"]).map((r) => [r.id, r.implemented])).toEqual([
			["dream", false],
			["extractMemories", false],
			["autoSurfacing", true],
		]);
	});
});
