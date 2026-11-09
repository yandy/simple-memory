import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, defaultMemoryRoot, expandTilde, loadConfigFrom } from "@yandy0725/memory-core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRowConfig, ROW_CONFIG_KEYS } from "../src/row-config.js";

describe("resolveRowConfig", () => {
	let tmpDir: string | undefined;
	afterEach(async () => {
		if (tmpDir !== undefined) {
			await rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it("returns the defaults verbatim for undefined (no warnings, no error)", () => {
		const { config, warnings, error } = resolveRowConfig(undefined);
		expect(config).toEqual({ ...DEFAULT_CONFIG, memoryDir: expandTilde(defaultMemoryRoot()) });
		expect(warnings).toEqual([]);
		expect(error).toBeNull();
	});

	it("treats null the same as undefined (empty row config)", () => {
		const { config, warnings, error } = resolveRowConfig(null);
		expect(config).toEqual({ ...DEFAULT_CONFIG, memoryDir: expandTilde(defaultMemoryRoot()) });
		expect(warnings).toEqual([]);
		expect(error).toBeNull();
	});

	it("applies a known scalar key and keeps its siblings at their defaults", () => {
		const { config, warnings } = resolveRowConfig({ memIndexMaxLines: 99 });
		expect(config.memIndexMaxLines).toBe(99);
		expect(config.memIndexMaxBytes).toBe(DEFAULT_CONFIG.memIndexMaxBytes);
		expect(warnings).toEqual([]);
	});

	it("matches core loadConfigFrom byte-for-byte for the same overlay", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "rowcfg-"));
		const file = join(tmpDir, "memory.json");
		const overlay = {
			memIndexMaxLines: 99,
			defaults: { model: "deepseek-official/deepseek-flash" },
			autoSurfacing: { enabled: false, maxFiles: 2 },
		};
		await writeFile(file, JSON.stringify(overlay));
		const viaFile = await loadConfigFrom([file]);
		const viaRow = resolveRowConfig(overlay).config;
		expect(viaRow).toEqual(viaFile);
	});

	it("warns about an unknown top-level key and leaves the real key untouched", () => {
		const { config, warnings } = resolveRowConfig({ memorydir: "x" });
		expect(warnings).toContain('unknown config key "memorydir" — ignored');
		expect(config.memoryDir).toBe(expandTilde(defaultMemoryRoot()));
	});

	it("warns about a wrongly-typed key and ignores its value", () => {
		const { config, warnings } = resolveRowConfig({ memIndexMaxLines: "99" });
		expect(warnings).toContain('config key "memIndexMaxLines" must be number, got string — ignored');
		expect(config.memIndexMaxLines).toBe(DEFAULT_CONFIG.memIndexMaxLines);
	});

	it("expands a ~-prefixed memoryDir", () => {
		const { config } = resolveRowConfig({ memoryDir: "~/m" });
		expect(config.memoryDir).toBe(join(homedir(), "m"));
	});

	it("reports an error for a non-object row and still returns defaults", () => {
		const { config, warnings, error } = resolveRowConfig("nope");
		expect(error).not.toBeNull();
		expect(error).toContain("must be an object");
		expect(warnings).toEqual([]);
		expect(config).toEqual({ ...DEFAULT_CONFIG, memoryDir: expandTilde(defaultMemoryRoot()) });
	});

	it("warns about a wrongly-cased nested key instead of dropping it silently", () => {
		const { config, warnings } = resolveRowConfig({ autoSurfacing: { maxfiles: 3 } });
		expect(warnings).toContain('unknown config key "autoSurfacing.maxfiles" — ignored');
		expect(config.autoSurfacing.maxFiles).toBe(DEFAULT_CONFIG.autoSurfacing.maxFiles);
		expect(config.autoSurfacing).not.toHaveProperty("maxfiles");
	});

	it("accepts the optional model subkey without a warning", () => {
		const { config, warnings } = resolveRowConfig({ autoSurfacing: { model: "deepseek-official/deepseek-flash" } });
		expect(warnings).toEqual([]);
		expect(config.autoSurfacing.model).toBe("deepseek-official/deepseek-flash");
	});

	it("warns about a wrongly-typed nested key and keeps the default", () => {
		const { config, warnings } = resolveRowConfig({ autoSurfacing: { maxFiles: "3" } });
		expect(warnings).toContain('config key "autoSurfacing.maxFiles" must be number, got string — ignored');
		expect(config.autoSurfacing.maxFiles).toBe(DEFAULT_CONFIG.autoSurfacing.maxFiles);
	});

	it("accepts defaults.model as the shared model", () => {
		const { config, warnings } = resolveRowConfig({ defaults: { model: "deepseek-official/deepseek-flash" } });
		expect(warnings).toEqual([]);
		expect(config.defaults?.model).toBe("deepseek-official/deepseek-flash");
	});

	it("passes a null subtree through unchanged without warning", () => {
		const { config, warnings } = resolveRowConfig({ autoSurfacing: null });
		expect(warnings).toEqual([]);
		expect(config.autoSurfacing).toBeNull();
	});

	it("threads the platform through to expandTilde", () => {
		expect(resolveRowConfig({ memoryDir: "~\\.agent\\memory" }, "win32").config.memoryDir).toBe(
			join(homedir(), ".agent\\memory"),
		);
		expect(resolveRowConfig({ memoryDir: "~\\.agent\\memory" }, "linux").config.memoryDir).toBe("~\\.agent\\memory");
	});

	it("never mutates DEFAULT_CONFIG, even when merging a real overlay", () => {
		const before = structuredClone(DEFAULT_CONFIG);
		resolveRowConfig(undefined);
		resolveRowConfig({
			memIndexMaxLines: 99,
			defaults: { model: "deepseek-official/deepseek-flash" },
			autoSurfacing: { enabled: false, maxFiles: 7, model: "deepseek-official/deepseek-flash" },
		});
		expect(DEFAULT_CONFIG).toEqual(before);
	});
});

describe("ROW_CONFIG_KEYS", () => {
	it("is derived from DEFAULT_CONFIG, so core can add keys without drift", () => {
		expect(ROW_CONFIG_KEYS).toEqual(Object.keys(DEFAULT_CONFIG));
		expect(ROW_CONFIG_KEYS).toContain("memoryDir");
		expect(ROW_CONFIG_KEYS).toContain("autoSurfacing");
	});
});
