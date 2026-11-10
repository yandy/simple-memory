import { describe, it, expect } from "vitest";
import {
	DEFAULT_CONFIG,
	defaultMemoryRoot,
	mergeConfig,
	modelConfigErrors,
	requiredModel,
	requiredModels,
	taskModel,
	type EffortLevel,
	type MemoryConfig,
	type ThinkLevel,
} from "../src/config.js";
import type { EffortLevel as EffortLevelFromIndex } from "../src/index.js";

describe("DEFAULT_CONFIG", () => {
	it("has expected defaults", () => {
		expect(DEFAULT_CONFIG.memIndexMaxLines).toBe(200);
		expect(DEFAULT_CONFIG.memIndexMaxBytes).toBe(25600);
		// 注入口径**独立于**写入口径（v2.3.0 起）：窗口只取索引最新的 50 行。
		expect(DEFAULT_CONFIG.memIndexInjectMaxLines).toBe(50);
		expect(DEFAULT_CONFIG.memIndexInjectMaxBytes).toBe(16384);
		expect(DEFAULT_CONFIG.lock).toEqual({ timeoutMs: 5000, snapshotKeep: 5 });
		// 模型没有默认值：必须由用户显式配置，否则启动即报错
		expect(DEFAULT_CONFIG.defaults).toEqual({ sessionPersistence: { enabled: false } });
		expect(DEFAULT_CONFIG.defaults?.model).toBeUndefined();
		expect(DEFAULT_CONFIG.dream.model).toBeUndefined();
		expect(DEFAULT_CONFIG.sessionSearch.maxSessions).toBe(10);
		expect(DEFAULT_CONFIG.autoSurfacing.maxEntryBytes).toBe(3072);
		// extract 是 opt-in：每轮都要跑一次模型调用，默认关闭。
		expect(DEFAULT_CONFIG.extractMemories.enabled).toBe(false);
		expect(DEFAULT_CONFIG.extractMemories.maxToolResultChars).toBe(500);
		expect(DEFAULT_CONFIG.extractMemories.maxAssistantChars).toBe(2000);
		// 其余默认值一并钉住：任何一个被改动都必须让这条用例红。
		expect(DEFAULT_CONFIG.memoryDir).toBe(defaultMemoryRoot());
		expect(DEFAULT_CONFIG.dream.nudgeAfterSessions).toBe(5);
		expect(DEFAULT_CONFIG.dream.nudgeAfterHours).toBe(24);
		expect(DEFAULT_CONFIG.dream.thinkLevel).toBe("high");
		expect(DEFAULT_CONFIG.sessionSearch).toEqual({ maxSessions: 10, maxMatches: 5 });
		expect(DEFAULT_CONFIG.autoSurfacing.thinkLevel).toBe("off");
		expect(DEFAULT_CONFIG.autoSurfacing.maxFiles).toBe(3);
		expect(DEFAULT_CONFIG.autoSurfacing.maxInjectionBytes).toBe(10240);
		expect(DEFAULT_CONFIG.extractMemories.thinkLevel).toBe("high");
		expect(DEFAULT_CONFIG.extractMemories.maxContextTokens).toBe(2000);
	});

	// v2.3.0 起读写**不再**同口径：注入窗口只取索引最新的 50 行（写入口径保持 200 行 / 25600 B，
	// 窗口外的旧记忆仍可由 auto-surfacing / memory 工具检索）。这两条断言钉的是「窗口确实比写入
	// 容量小」这件事本身 —— 任何一边被改回同值都会红。
	it("keeps the injection window smaller than the write capacity", () => {
		expect(DEFAULT_CONFIG.memIndexInjectMaxLines).toBeLessThan(DEFAULT_CONFIG.memIndexMaxLines);
		expect(DEFAULT_CONFIG.memIndexInjectMaxBytes).toBeLessThan(DEFAULT_CONFIG.memIndexMaxBytes);
	});
});

describe("model config", () => {
	const cfg = (over: Partial<MemoryConfig> = {}): MemoryConfig => ({ ...DEFAULT_CONFIG, ...over });
	const allOn = (over: Partial<MemoryConfig> = {}): MemoryConfig =>
		cfg({
			defaults: { sessionPersistence: { enabled: false } },
			extractMemories: { ...DEFAULT_CONFIG.extractMemories, enabled: true },
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: true },
			...over,
		});

	it("only requires dream when extract and auto-surfacing are disabled", () => {
		const c = allOn({
			dream: { ...DEFAULT_CONFIG.dream, model: "test/dream" },
			extractMemories: { ...DEFAULT_CONFIG.extractMemories, enabled: false },
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: false },
		});
		expect(requiredModels(c)).toEqual([{ task: "dream", value: "test/dream" }]);
		expect(modelConfigErrors(c, () => true)).toEqual([]);
	});

	it("lets defaults.model satisfy every task", () => {
		const c = allOn({ defaults: { model: "test/shared", sessionPersistence: { enabled: false } } });
		expect(requiredModels(c)).toEqual([
			{ task: "dream", value: "test/shared" },
			{ task: "extractMemories", value: "test/shared" },
			{ task: "autoSurfacing", value: "test/shared" },
		]);
		expect(modelConfigErrors(c, () => true)).toEqual([]);
	});

	it("reports every missing model with the exact wording and order", () => {
		expect(modelConfigErrors(allOn(), () => true)).toEqual([
			'no model for dream — set "dream.model" or "defaults.model" in memory.json',
			'no model for extractMemories — set "extractMemories.model" or "defaults.model" in memory.json',
			'no model for autoSurfacing — set "autoSurfacing.model" or "defaults.model" in memory.json',
		]);
	});

	it("reports the per-task value when it overrides defaults.model", () => {
		const c = allOn({
			defaults: { model: "test/shared", sessionPersistence: { enabled: false } },
			dream: { ...DEFAULT_CONFIG.dream, model: "bad/dream" },
		});
		expect(modelConfigErrors(c, (v) => v !== "bad/dream")).toEqual([
			'model "bad/dream" for dream is not resolvable (unknown id or missing credentials)',
		]);
	});

	it("requiredModel returns the resolved value and throws when missing", () => {
		const c = allOn({ defaults: { model: "test/shared", sessionPersistence: { enabled: false } } });
		expect(requiredModel(c, "extractMemories")).toBe("test/shared");
		expect(() => requiredModel(allOn(), "dream")).toThrow(
			'no model for dream — set "dream.model" or "defaults.model" in memory.json',
		);
	});

	// `deepMerge` 会把用户写的 `"dream": null` 原样带进来：不能抛 TypeError，而是退到 defaults.model。
	it("degrades a module config set to null to defaults.model instead of throwing", () => {
		const withDefaults = allOn({
			defaults: { model: "test/shared", sessionPersistence: { enabled: false } },
			dream: null as unknown as MemoryConfig["dream"],
		});

		expect(modelConfigErrors(withDefaults, () => true)).toEqual([]);
		expect(requiredModel(withDefaults, "dream")).toBe("test/shared");

		// 没有 defaults.model 时给出一条可读错误（而不是让 TypeError 变成「初始化失败」）。
		const withoutDefaults = cfg({
			dream: null as unknown as MemoryConfig["dream"],
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: false },
		});

		expect(modelConfigErrors(withoutDefaults, () => true)).toEqual([
			'no model for dream — set "dream.model" or "defaults.model" in memory.json',
		]);
	});
});

describe("modelConfigErrors 的 tasks 参", () => {
	const cfg = { ...DEFAULT_CONFIG, autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: true } } as MemoryConfig;
	it("省略 tasks 时 dream 恒在集合内（既有行为不变）", () => {
		expect(requiredModels(cfg).map((m) => m.task)).toEqual(["dream", "autoSurfacing"]);
	});
	it("给定 tasks 时只校验这些任务，dream 不再被强制", () => {
		expect(requiredModels(cfg, ["autoSurfacing"]).map((m) => m.task)).toEqual(["autoSurfacing"]);
		expect(modelConfigErrors(cfg, () => false, ["autoSurfacing"])).toHaveLength(1);
		expect(modelConfigErrors(cfg, () => false, ["autoSurfacing"])[0]).toContain("autoSurfacing");
	});
	it("tasks 里的任务被 enabled=false 关掉时不产生错误", () => {
		const off = { ...cfg, autoSurfacing: { ...cfg.autoSurfacing, enabled: false } } as MemoryConfig;
		expect(modelConfigErrors(off, () => false, ["autoSurfacing"])).toEqual([]);
	});
	it("顺序仍固定为 dream → extractMemories → autoSurfacing", () => {
		const all = { ...cfg, extractMemories: { ...cfg.extractMemories, enabled: true } } as MemoryConfig;
		expect(requiredModels(all, ["autoSurfacing", "dream", "extractMemories"]).map((m) => m.task))
			.toEqual(["dream", "extractMemories", "autoSurfacing"]);
	});

	// 已裁定的新语义（实现期修订）：**省略 `tasks`** 时 `null` 子树按 falsy 跳过，而不是抛 TypeError。
	// 带 defaults.model 使其余任务不贡献错误，返回值只反映「null 子树被跳过」这一件事。
	const withModel = { ...cfg, defaults: { model: "test/shared", sessionPersistence: { enabled: false } } };
	it("省略 tasks 时 extractMemories 为 null 不抛错：跳过该任务，dream 仍在集合内", () => {
		const c = { ...withModel, extractMemories: null } as unknown as MemoryConfig;
		expect(modelConfigErrors(c, () => true)).toEqual([]);
		expect(requiredModels(c).map((m) => m.task)).toEqual(["dream", "autoSurfacing"]);
	});
	it("省略 tasks 时 autoSurfacing 为 null 不抛错：跳过该任务，dream 仍在集合内", () => {
		const c = { ...withModel, autoSurfacing: null } as unknown as MemoryConfig;
		expect(modelConfigErrors(c, () => true)).toEqual([]);
		expect(requiredModels(c).map((m) => m.task)).toEqual(["dream"]);
	});
});

describe("taskModel", () => {
	it("prefers the per-task model and falls back to defaults.model", () => {
		const shared = { ...DEFAULT_CONFIG, defaults: { model: "shared/model" } };

		expect(taskModel(shared, "dream")).toBe("shared/model");
		expect(taskModel({ ...shared, dream: { ...shared.dream, model: "own/model" } }, "dream")).toBe("own/model");
		expect(taskModel({ ...shared, defaults: undefined }, "autoSurfacing")).toBeUndefined();
	});
});

describe("mergeConfig", () => {
	it("深合并、跳过 undefined 值、保留同层其它键、不改写 base", () => {
		const base = DEFAULT_CONFIG;
		const out = mergeConfig(base, {
			memIndexMaxLines: 99,
			autoSurfacing: { maxFiles: 7 },
			lock: { timeoutMs: undefined },
		});
		expect(out.memIndexMaxLines).toBe(99);
		expect(out.autoSurfacing.maxFiles).toBe(7);
		expect(out.autoSurfacing.maxEntryBytes).toBe(DEFAULT_CONFIG.autoSurfacing.maxEntryBytes); // 同层其它键保留
		expect(out.lock.timeoutMs).toBe(DEFAULT_CONFIG.lock.timeoutMs); // undefined 被跳过
		expect(base.memIndexMaxLines).toBe(DEFAULT_CONFIG.memIndexMaxLines); // base 未被改写
	});
	it("null 子树原样带入", () => {
		expect(mergeConfig(DEFAULT_CONFIG, { extractMemories: null }) as any).toMatchObject({ extractMemories: null });
	});
});

describe("EffortLevel", () => {
	it("EffortLevel 接受宿主的任意档位，ThinkLevel 是它的别名", () => {
		const dshEffort: EffortLevel = "max"; // dsh 的 DeepSeek 路线档位，旧 ThinkLevel 表达不出
		const piEffort: ThinkLevel = dshEffort; // 双向可赋值 = 同一类型
		const back: EffortLevel = piEffort; // ← 另一个方向，上面那句注释才是真的
		expect([dshEffort, piEffort, back]).toEqual(["max", "max", "max"]);
	});
});

describe("公开出口", () => {
	it("带上 1.1.0 的三个加法", async () => {
		const api = await import("../src/index.js");
		expect(typeof api.mergeConfig).toBe("function");
		// 精确钉住形参个数（而不是 `toBeGreaterThanOrEqual`：它对多一个或少一个形参都报绿）。
		// 注：`Function.length` 数的是「第一个带默认值/剩余参之前」的形参，TS 的可选参 `tasks?`
		// 编译后就是普通形参，**计入** length：requiredModels(cfg, tasks?) = 2，
		// modelConfigErrors(cfg, resolve, tasks?) = 3。「tasks 仍是可选」由类型系统钉：
		// 本文件与 dsh-memory 都有省略它的调用，它一旦变必传那些调用就编译不过。
		expect(api.requiredModels.length).toBe(2);
		expect(api.modelConfigErrors.length).toBe(3);
		// EffortLevel 是类型导出，运行时没有对应值：从入口做类型导入能编译通过，即证明
		// index.ts 的 `export type { EffortLevel }` 真的把它放上了公开面。
		const fromIndex: EffortLevelFromIndex = "max";
		expect(fromIndex).toBe("max");
	});

	// 删除必须能被 CI 看见：`loadConfigFrom` 已下放给适配层，公开面里不得再有任何痕迹
	// （哪怕是 deprecated 薄壳）。
	it("no longer exposes loadConfigFrom", async () => {
		const api = await import("../src/index.js");
		expect("loadConfigFrom" in api).toBe(false);
	});
});
