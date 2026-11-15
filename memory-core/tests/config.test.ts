import { describe, it, expect } from "vitest";
import {
	DEFAULT_CONFIG,
	defaultMemoryRoot,
	mergeConfig,
	modelConfigErrors,
	requiredModel,
	requiredModels,
	syncConfigErrors,
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
		expect(DEFAULT_CONFIG.dream.thinkLevel).toBe("high");
		expect(DEFAULT_CONFIG.sessionSearch).toEqual({ maxSessions: 10, maxMatches: 5 });
		expect(DEFAULT_CONFIG.autoSurfacing.thinkLevel).toBe("off");
		expect(DEFAULT_CONFIG.autoSurfacing.maxFiles).toBe(3);
		expect(DEFAULT_CONFIG.autoSurfacing.maxInjectionBytes).toBe(10240);
		expect(DEFAULT_CONFIG.extractMemories.thinkLevel).toBe("high");
		expect(DEFAULT_CONFIG.extractMemories.maxContextTokens).toBe(2000);
	});

	// pi 的 nudge 策略（多少个会话 / 多少小时后提醒）是**宿主知识**，已搬去 `pi-memory` 的
	// `PI_HOST_DEFAULTS`。core 侧钉反断言：键一旦回到 `MemoryConfig.dream`，这里就必须红。
	it("no longer owns pi's nudge policy", () => {
		expect("nudgeAfterSessions" in DEFAULT_CONFIG.dream).toBe(false);
		expect("nudgeAfterHours" in DEFAULT_CONFIG.dream).toBe(false);
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

describe("sync 配置", () => {
	it("默认值：关闭，且每个键的类型都对（dsh 的行 config 白名单从 DEFAULT_CONFIG 派生，类型即校验）", () => {
		expect(DEFAULT_CONFIG.sync).toEqual({
			enabled: false,
			remote: "",
			branch: "main",
			pullOnStart: true,
			pushOnWrite: true,
			pushDebounceMs: 5000,
			autoTimeoutMs: 5000,
			timeoutMs: 20000,
		});
		// 类型也逐个钉住：dsh 的嵌套键校验是从这棵子树的形状**推导**出来的，一个键写成错的 JS 类型
		// 就会让用户完全正确的写法被判成「类型不符」告警并丢弃。
		expect(typeof DEFAULT_CONFIG.sync.enabled).toBe("boolean");
		expect(typeof DEFAULT_CONFIG.sync.remote).toBe("string");
		expect(typeof DEFAULT_CONFIG.sync.branch).toBe("string");
		expect(typeof DEFAULT_CONFIG.sync.pullOnStart).toBe("boolean");
		expect(typeof DEFAULT_CONFIG.sync.pushOnWrite).toBe("boolean");
		expect(typeof DEFAULT_CONFIG.sync.pushDebounceMs).toBe("number");
		expect(typeof DEFAULT_CONFIG.sync.autoTimeoutMs).toBe("number");
		expect(typeof DEFAULT_CONFIG.sync.timeoutMs).toBe("number");
		// 两档超时是刻意分开的：自动路径被 await 在会话启动路径上，自动档必须短于手动档，
		// 否则离线时每开一次会话都要等满一个手动预算。
		expect(DEFAULT_CONFIG.sync.autoTimeoutMs).toBeLessThan(DEFAULT_CONFIG.sync.timeoutMs);
	});

	it("mergeConfig 深合并 sync 子树，且不污染 DEFAULT_CONFIG", () => {
		const merged = mergeConfig(DEFAULT_CONFIG, { sync: { enabled: true, remote: "git@github.com:o/r.git" } });
		expect(merged.sync).toMatchObject({
			enabled: true,
			remote: "git@github.com:o/r.git",
			branch: "main",
			pushDebounceMs: 5000,
		});
		expect(DEFAULT_CONFIG.sync.enabled).toBe(false);
		expect(DEFAULT_CONFIG.sync.remote).toBe("");
	});

	it("syncConfigErrors：enabled 而 remote 为空 → 一条可读错误", () => {
		expect(syncConfigErrors(mergeConfig(DEFAULT_CONFIG, { sync: { enabled: true } }))).toEqual([
			'sync is enabled but "sync.remote" is empty — run the sync init command or unset "sync.enabled"',
		]);
	});

	it("未启用 → 空数组（remote 为空也不报）", () => {
		expect(syncConfigErrors(DEFAULT_CONFIG)).toEqual([]);
		// 显式写了坏值但保持关闭：同样一条都不报 —— 关掉的开关不该逼用户先去修别的键。
		expect(syncConfigErrors(mergeConfig(DEFAULT_CONFIG, { sync: { branch: "", pushDebounceMs: 0 } }))).toEqual([]);
	});

	it("branch 为空 / 三个数字键非正数 → 各一条错误", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			sync: {
				enabled: true,
				remote: "git@example.com:o/r.git",
				branch: "",
				pushDebounceMs: 0,
				autoTimeoutMs: -1,
				timeoutMs: 0,
			},
		});
		// 恰好四条（branch + 三个数字键），一个不多一个不少，且顺序固定。
		const errors = syncConfigErrors(cfg);
		expect(errors).toHaveLength(4);
		expect(errors[0]).toContain('"sync.branch"');
		expect(errors[1]).toContain('"sync.pushDebounceMs"');
		expect(errors[2]).toContain('"sync.autoTimeoutMs"');
		expect(errors[3]).toContain('"sync.timeoutMs"');
		// 消息要能让用户动手：名字里带键，值也带出来。
		expect(errors[2]).toContain("-1");
	});

	// `mergeConfig` 不校验类型：手写配置里的 `"5000"` 会一路传到定时器 / 子进程 budget 上。
	it("数字键不是数字 → 同样报一条，并原样带出值", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			sync: { enabled: true, remote: "git@example.com:o/r.git", pushDebounceMs: "5000" },
		});
		expect(syncConfigErrors(cfg)).toEqual([
			'sync is enabled but "sync.pushDebounceMs" must be a positive number of milliseconds (got "5000")',
		]);
	});

	// 非字符串的远端同样按「空」报，而不是在 `.trim()` 上抛错。
	it("remote 不是字符串时按空报错，不抛 TypeError", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			sync: { enabled: true, remote: 42, branch: "main" },
		});
		expect(syncConfigErrors(cfg)).toEqual([
			'sync is enabled but "sync.remote" is empty — run the sync init command or unset "sync.enabled"',
		]);
	});

	it("★不进 modelConfigErrors：sync 的错误不会让模型校验失败（它是非致命的）", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { sync: { enabled: true } });
		expect(modelConfigErrors(cfg, () => true, [])).toEqual([]);
		expect(syncConfigErrors(cfg)).toHaveLength(1);
	});

	// 用户的 `"sync": null` 经 `mergeConfig` 原样带进来（与 `dream` / `extractMemories` 同一条路径）：
	// 读不懂的子树按「未启用」处理，不能变成一句看不懂的 TypeError。
	it("sync 子树为 null / 不是对象时按未启用处理，不抛错", () => {
		expect(syncConfigErrors(mergeConfig(DEFAULT_CONFIG, { sync: null }))).toEqual([]);
		expect(syncConfigErrors(mergeConfig(DEFAULT_CONFIG, { sync: "yes" }))).toEqual([]);
	});

	// 布尔键是**同意边界**，不是类型洁癖：pi 侧把 JSON.parse 的结果直接喂给 mergeConfig，
	// 而 `"false"` 在 JS 里是真值 —— 按真值判定就会把用户明写的「关」读成「开」，记忆继续往
	// git 远端推，同时这个函数还返回空数组（= 「配置没问题」）。
	it("★布尔键不是布尔 → 各报一条，且同步按未启用处理（不再校验它管辖的键）", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			sync: { enabled: "false", pullOnStart: "no", pushOnWrite: 1, remote: "", branch: "" },
		});
		expect(syncConfigErrors(cfg)).toEqual([
			'sync is disabled because "sync.enabled" must be true or false (got "false")',
			'sync is disabled because "sync.pullOnStart" must be true or false (got "no")',
			'sync is disabled because "sync.pushOnWrite" must be true or false (got 1)',
		]);
		// 文案要点名「同步因此是关的」：用户写 "false" 的意图就是关，报出来的必须是这件事
	});

	it("enabled 明确为 false → 一条都不报，即使它管辖的键全是坏值", () => {
		expect(syncConfigErrors(mergeConfig(DEFAULT_CONFIG, { sync: { enabled: false, remote: "", branch: 3 } }))).toEqual(
			[],
		);
	});

	it("顺序：三个布尔键 → remote → branch → 三个数字键", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			sync: { enabled: true, pullOnStart: "yes", remote: "git@example.com:o/r.git", pushDebounceMs: -1 },
		});
		expect(syncConfigErrors(cfg)).toEqual([
			'sync is disabled because "sync.pullOnStart" must be true or false (got "yes")',
			'sync is enabled but "sync.pushDebounceMs" must be a positive number of milliseconds (got -1)',
		]);
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

	it("no longer exposes the three run* entry points", async () => {
		const api = await import("../src/index.js");
		for (const name of ["runSideQuery", "runExtract", "runDream"]) expect(name in api).toBe(false);
	});

	it("exposes the 2.0.0 task model", async () => {
		const api = await import("../src/index.js");
		expect(typeof api.runTask).toBe("function");
		expect(Object.keys(api.TASKS).sort()).toEqual(["autoSurfacing", "dream", "extractMemories"]);
		expect(typeof api.moduleStatusRows).toBe("function");
	});
});
