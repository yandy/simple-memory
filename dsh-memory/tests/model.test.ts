import { DEFAULT_CONFIG, mergeConfig } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";
import { describe, expect, it, vi } from "vitest";
import { parseModelRef, resolveSurfacingAvailability } from "../src/model.js";
import type { ResolveCallConfig } from "../src/model.js";

/** 从 DEFAULT_CONFIG 派生一份干净副本，再按 overlay 深合并，避免污染 DEFAULT_CONFIG。 */
function makeConfig(overlay: Record<string, unknown> = {}): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), overlay);
}

describe("parseModelRef", () => {
	it("splits a plain provider/model pair on the slash", () => {
		expect(parseModelRef("deepseek-official/deepseek-flash")).toEqual({
			provider: "deepseek-official",
			model: "deepseek-flash",
		});
	});

	it("splits on the FIRST slash so a model id may itself contain slashes", () => {
		expect(parseModelRef("megcore/qwen/qwen3.8-max")).toEqual({
			provider: "megcore",
			model: "qwen/qwen3.8-max",
		});
	});

	it("returns null for values without a slash or with an empty segment", () => {
		expect(parseModelRef("deepseek-flash")).toBeNull();
		expect(parseModelRef("/x")).toBeNull();
		expect(parseModelRef("p/")).toBeNull();
	});

	it("returns null for an empty or whitespace-only value", () => {
		expect(parseModelRef("")).toBeNull();
		expect(parseModelRef("   ")).toBeNull();
	});

	it("trims surrounding whitespace before splitting", () => {
		expect(parseModelRef("  deepseek-official/deepseek-flash  ")).toEqual({
			provider: "deepseek-official",
			model: "deepseek-flash",
		});
	});

	it("preserves internal whitespace (only surrounding whitespace is trimmed)", () => {
		expect(parseModelRef("p /m")).toEqual({ provider: "p ", model: "m" });
	});
});

describe("resolveSurfacingAvailability", () => {
	it("degrades with a no-model reason when neither autoSurfacing.model nor defaults.model is set", async () => {
		const config = makeConfig(); // enabled: true, no model anywhere
		const resolve = vi.fn<ResolveCallConfig>();
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("no model configured");
		expect(resolve).not.toHaveBeenCalled();
	});

	it("does not call resolveCallConfig when autoSurfacing.enabled is false", async () => {
		const config = makeConfig({ autoSurfacing: { enabled: false, model: "deepseek-official/deepseek-flash" } });
		const resolve = vi.fn<ResolveCallConfig>();
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("disabled");
		expect(resolve).not.toHaveBeenCalled();
	});

	it("treats a runtime-null autoSurfacing subtree the same as disabled, without calling resolveCallConfig", async () => {
		const config = makeConfig({ autoSurfacing: null });
		const resolve = vi.fn<ResolveCallConfig>();
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("disabled");
		expect(resolve).not.toHaveBeenCalled();
	});

	it("degrades with the host code when resolveCallConfig rejects with NO_ADAPTER", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockRejectedValue({ code: "NO_ADAPTER" });
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("NO_ADAPTER");
	});

	it("forwards thinkLevel as reasoningEffort and reports UNSUPPORTED_REASONING_EFFORT", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash", thinkLevel: "max" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockRejectedValue({ code: "UNSUPPORTED_REASONING_EFFORT" });
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("UNSUPPORTED_REASONING_EFFORT");
		expect(resolve).toHaveBeenCalledWith(
			{ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "max" },
			undefined,
		);
	});

	it("resolves fully and forwards provider/model from parseModelRef", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash", thinkLevel: "high" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockResolvedValue(undefined);
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result).toEqual({ available: true, reason: null });
		expect(resolve).toHaveBeenCalledWith(
			{ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
			undefined,
		);
	});

	it("falls back to defaults.model and keeps a slashed model id intact", async () => {
		const config = makeConfig({ defaults: { model: "megcore/qwen/qwen3.8-max" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockResolvedValue(undefined);
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result).toEqual({ available: true, reason: null });
		expect(resolve).toHaveBeenCalledWith(
			{ provider: "megcore", model: "qwen/qwen3.8-max", reasoningEffort: "off" },
			undefined,
		);
	});

	it("degrades with the provider/model format hint when the configured model has no slash", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-flash" } });
		const resolve = vi.fn<ResolveCallConfig>();
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain('must be "<provider>/<model>"');
		expect(resolve).not.toHaveBeenCalled();
	});

	it("reports a host message when the rejection has no code, without an undefined leak", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockRejectedValue({ message: "auth failed" });
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("auth failed");
		expect(result.reason).not.toContain("undefined");
	});

	it("handles a non-object rejection value without an undefined leak", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockRejectedValue("boom");
		const result = await resolveSurfacingAvailability(config, resolve);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("boom");
		expect(result.reason).not.toContain("undefined");
	});

	it("passes the signal through to resolveCallConfig when provided", async () => {
		const config = makeConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash" } });
		const resolve = vi.fn<ResolveCallConfig>();
		resolve.mockResolvedValue(undefined);
		const signal = new AbortController().signal;
		await resolveSurfacingAvailability(config, resolve, signal);
		expect(resolve).toHaveBeenCalledWith(
			{ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "off" },
			signal,
		);
	});
});
