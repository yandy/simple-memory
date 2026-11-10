import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, defaultMemoryRoot, expandTilde, mergeConfig } from "@yandy0725/memory-core";
import { describe, expect, it } from "vitest";
import { resolveRowConfig, ROW_CONFIG_KEYS } from "../src/row-config.js";

describe("resolveRowConfig", () => {
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

	// 与 `memory.json` 的路径锚定：行 config 不引入任何额外合并语义，它逐字等于「默认值 → 逐个
	// `mergeConfig` → 末尾 `expandTilde`」这条公开文档的链（core 1.x 的 `loadConfigFrom([file])`
	// 就是同一条链加文件 IO；文件 IO 现已归适配层，所以这里直接钉这条链）。
	it("matches the documented mergeConfig + expandTilde chain for the same overlay", () => {
		const overlay = {
			memIndexMaxLines: 99,
			defaults: { model: "deepseek-official/deepseek-flash" },
			autoSurfacing: { enabled: false, maxFiles: 2 },
		};
		const viaChain = (() => {
			const c = mergeConfig({ ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() }, overlay);
			c.memoryDir = expandTilde(c.memoryDir);
			return c;
		})();
		expect(resolveRowConfig(overlay).config).toEqual(viaChain);
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

	it("warns about a model key nested one level too deep instead of merging it silently", () => {
		// `lock` 不承载模型配置：把 `model` 嵌错一层正是「配错模型名的人」的典型写法。静默并进去
		// 的后果是零告警 + `/memory` 反而说「你没配 model」，把唯一能暴露错误的那条诊断压掉了。
		const { config, warnings } = resolveRowConfig({ lock: { model: "prov/mod" } });
		expect(warnings).toEqual(['unknown config key "lock.model" — ignored']);
		expect(config.lock).not.toHaveProperty("model");
		expect(config.lock).toEqual(DEFAULT_CONFIG.lock);
		// 它也没被当成顶层或共享模型并进去：`defaults.model` 仍是未配。
		expect(config.defaults?.model).toBeUndefined();
	});

	it("warns about model and sessionPersistence outside the model-bearing subtrees", () => {
		const { config, warnings } = resolveRowConfig({
			sessionSearch: { model: "prov/mod", sessionPersistence: { enabled: true } },
		});
		expect(warnings).toEqual([
			'unknown config key "sessionSearch.model" — ignored',
			'unknown config key "sessionSearch.sessionPersistence" — ignored',
		]);
		expect(config.sessionSearch).not.toHaveProperty("model");
		expect(config.sessionSearch).not.toHaveProperty("sessionPersistence");
		expect(config.sessionSearch).toEqual(DEFAULT_CONFIG.sessionSearch);
	});

	it("still accepts model and sessionPersistence in every model-bearing subtree", () => {
		const { config, warnings } = resolveRowConfig({
			defaults: { model: "prov/shared", sessionPersistence: { enabled: true } },
			dream: { model: "prov/dream" },
			autoSurfacing: { model: "prov/surfacing" },
			extractMemories: { model: "prov/extract", sessionPersistence: { enabled: false } },
		});
		expect(warnings).toEqual([]);
		expect(config.defaults?.model).toBe("prov/shared");
		expect(config.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(config.dream.model).toBe("prov/dream");
		expect(config.autoSurfacing.model).toBe("prov/surfacing");
		expect(config.extractMemories.model).toBe("prov/extract");
		expect(config.extractMemories.sessionPersistence).toEqual({ enabled: false });
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
