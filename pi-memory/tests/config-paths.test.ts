import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFiles, loadConfig, modelConfigErrors, requiredModels, PI_HOST_DEFAULTS } from "../src/config";

/**
 * pi 侧配置层的全部职责：**读哪些文件、怎么把它们合并成 `MemoryConfig`**。
 *
 * 默认值、深合并语义、`~` 展开仍由 core 提供（`DEFAULT_CONFIG` / `mergeConfig` / `expandTilde`），
 * 但「文件在哪、读不读」是宿主知识（core 对 `.pi` 一无所知，spec D4），所以文件 IO 与下面这批
 * 合并用例都归这里 —— 它们原本钉在 `memory-core/tests/config.test.ts` 的 `describe("loadConfigFrom")`。
 */
describe("configFiles", () => {
	it("lists the global file first and the project file second when trusted", () => {
		// 期望值一律用 join() 派生：写死 "/g/memory.json" 在 Windows 上会变成 `\g\memory.json`
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => true, _globalDir: "/g", _configDirName: ".pi" })).toEqual([
			join("/g", "memory.json"),
			join("/proj", ".pi", "memory.json"),
		]);
	});

	it("omits the project file when the project is not trusted", () => {
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => false, _globalDir: "/g", _configDirName: ".pi" })).toEqual([
			join("/g", "memory.json"),
		]);
	});

	it("honours the injected config dir name", () => {
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => true, _globalDir: "/g", _configDirName: ".other" })).toEqual([
			join("/g", "memory.json"),
			join("/proj", ".other", "memory.json"),
		]);
	});

	it("defaults to pi's agent dir and config dir name when no seam is given", () => {
		expect(configFiles({ cwd: "/proj", isProjectTrusted: () => true })).toEqual([
			join(getAgentDir(), "memory.json"),
			join("/proj", CONFIG_DIR_NAME, "memory.json"),
		]);
	});
});

describe("loadConfig", () => {
	let globalDir: string;
	let projectDir: string;

	beforeEach(async () => {
		globalDir = await mkdtemp(join(tmpdir(), "mem-global-"));
		projectDir = await mkdtemp(join(tmpdir(), "mem-proj-"));
	});
	afterEach(async () => {
		await rm(globalDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	const ctx = (isProjectTrusted: boolean) => ({
		cwd: projectDir,
		isProjectTrusted: () => isProjectTrusted,
		_globalDir: globalDir,
		_configDirName: ".pi",
	});

	it("lets the project config override the global one when trusted", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		expect((await loadConfig(ctx(true))).config.memIndexMaxLines).toBe(50);
	});

	it("ignores the project config when the project is not trusted", async () => {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 50 }));
		expect((await loadConfig(ctx(false))).config.memIndexMaxLines).toBe(200); // default, project ignored
	});

	it("reads memory.json, not pi-memory.json", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ autoSurfacing: { enabled: false }, extractMemories: { maxContextTokens: 1000 } }),
		);
		// 负向断言：按包名直觉的错拼必须被忽略 —— 若它被读进来，enabled 会翻回 true、maxFiles 会变成 99。
		await writeFile(join(globalDir, "pi-memory.json"), JSON.stringify({ autoSurfacing: { enabled: true, maxFiles: 99 } }));
		const { config: cfg } = await loadConfig(ctx(true));
		expect(cfg.autoSurfacing.enabled).toBe(false);
		expect(cfg.autoSurfacing.maxFiles).toBe(3);
		expect(cfg.extractMemories.maxContextTokens).toBe(1000);
		expect(cfg.autoSurfacing.model).toBeUndefined();
	});

	it("passes the platform seam through to the tilde expansion", async () => {
		// `~\` 只在 win32 展开；POSIX 上它是合法文件名。两边各跑一次才能钉住「缝确实传下去了」。
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~\\mem" }));
		expect((await loadConfig({ ...ctx(false), _platform: "win32" })).config.memoryDir).toBe(join(homedir(), "mem"));
		expect((await loadConfig({ ...ctx(false), _platform: "linux" })).config.memoryDir).toBe("~\\mem");
	});

	// ── 以下用例迁自 memory-core/tests/config.test.ts 的 describe("loadConfigFrom") ────────────────
	// 迁移只动了三处：入参从「文件列表」换成 pi 的注入缝、`platform` 换成 `_platform`、删掉
	// `dream.nudgeAfter*` 断言（那两个键已归 pi）。**期望值一字不改** —— 这就是「行为逐字不变」的证词。
	// 已在上面被覆盖、不再重复的迁移用例：「project overrides global」由
	// 「lets the project config override the global one when trusted」覆盖；两条 `~\` 平台规则由
	// 「passes the platform seam through to the tilde expansion」与下面的 `~` 用例覆盖。

	it("returns defaults when no config files exist", async () => {
		expect((await loadConfig(ctx(true))).config.memIndexMaxLines).toBe(200);
	});

	// 包级 `enabled` 已不是 schema 的一部分。残留键会随 deepMerge 进入运行时对象（与 v1 的
	// maxTopicBytes 同例），但不得影响任何行为 —— `requiredModels` 仍然列出 dream，
	// 也就是「写 enabled: false 不再能免掉模型校验」。
	it("ignores a leftover top-level enabled key", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ enabled: false, autoSurfacing: { enabled: false }, dream: { model: "test/dream" } }),
		);
		const { config: cfg } = await loadConfig(ctx(true));

		expect(requiredModels(cfg)).toEqual([{ task: "dream", value: "test/dream" }]);
		expect(modelConfigErrors(cfg, () => true)).toEqual([]);
	});

	it("merges global config over defaults", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memIndexMaxLines: 100 }));
		const { config: cfg } = await loadConfig(ctx(true));
		expect(cfg.memIndexMaxLines).toBe(100);
		expect(cfg.memIndexMaxBytes).toBe(25600); // unchanged default
	});

	it("nested deep-merge preserves sibling fields when one nested field is overridden", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ dream: { model: "deepseek/deepseek-v4-flash" } }));
		const { config: cfg } = await loadConfig(ctx(true));
		expect(cfg.dream.model).toBe("deepseek/deepseek-v4-flash");
		// 同层兄弟键没被覆盖掉（`nudgeAfter*` 已归 pi，这里钉的是留在 core 的兄弟键）。
		expect(cfg.dream.thinkLevel).toBe("high");
	});

	it("expands ~ in memoryDir", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~/mymem" }));
		expect((await loadConfig(ctx(true))).config.memoryDir).toBe(join(homedir(), "mymem"));
	});

	it("handles malformed JSON gracefully", async () => {
		await writeFile(join(globalDir, "memory.json"), "this is not json");
		expect((await loadConfig(ctx(true))).config.memIndexMaxLines).toBe(200);
	});

	it("expands bare ~ to homedir", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~" }));
		expect((await loadConfig(ctx(true))).config.memoryDir).toBe(homedir());
	});

	it("has autoSurfacing defaults", async () => {
		const { config: cfg } = await loadConfig(ctx(false));
		expect(cfg.autoSurfacing).toEqual({
			enabled: true,
			thinkLevel: "off",
			maxFiles: 3,
			maxEntryBytes: 3072,
			maxInjectionBytes: 10240,
		});
	});

	it("has extractMemories defaults", async () => {
		const { config: cfg } = await loadConfig(ctx(false));
		expect(cfg.extractMemories).toEqual({
			enabled: false,
			thinkLevel: "high",
			maxContextTokens: 2000,
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
		});
	});

	it("lets memory.json opt back into extractMemories", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ extractMemories: { enabled: true } }));
		const { config: cfg } = await loadConfig(ctx(true));
		// 默认关闭只是默认值：显式 true 必须能覆盖它（deepMerge 的正路径）。
		expect(cfg.extractMemories.enabled).toBe(true);
		expect(cfg.extractMemories.thinkLevel).toBe("high");
		// 模型校验跟着开关走：开启后 extract 也要模型。
		expect(requiredModels(cfg).map((m) => m.task)).toContain("extractMemories");
	});

	it("propagates defaults.sessionPersistence to all tasks", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({ defaults: { sessionPersistence: { enabled: true } } }),
		);
		const { config: cfg } = await loadConfig(ctx(true));
		expect(cfg.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(cfg.dream.sessionPersistence).toBeUndefined();
		expect(cfg.autoSurfacing.sessionPersistence).toBeUndefined();
		expect(cfg.extractMemories.sessionPersistence).toBeUndefined();
	});

	it("per-task sessionPersistence overrides defaults", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({
				defaults: { sessionPersistence: { enabled: true } },
				dream: { sessionPersistence: { enabled: false } },
			}),
		);
		const { config: cfg } = await loadConfig(ctx(true));
		expect(cfg.defaults?.sessionPersistence).toEqual({ enabled: true });
		expect(cfg.dream.sessionPersistence).toEqual({ enabled: false });
	});

	it("per-task model overrides defaults.model", async () => {
		await writeFile(
			join(globalDir, "memory.json"),
			JSON.stringify({
				defaults: { model: "deepseek/flash" },
				dream: { model: "tencent/glm" },
			}),
		);
		expect((await loadConfig(ctx(true))).config.dream.model).toBe("tencent/glm");
	});

	it("ships defaults.sessionPersistence disabled so headless sessions stay in memory", async () => {
		const { config: cfg } = await loadConfig(ctx(true));
		expect(cfg.defaults).toEqual({ sessionPersistence: { enabled: false } });
		expect(cfg.dream.thinkLevel).toBe("high");
		expect(cfg.dream.sessionPersistence).toBeUndefined();
	});

	// 模型没有默认值：必须由用户显式配置，否则启动即报错
	it("ships no model default, so models must be configured explicitly", async () => {
		expect((await loadConfig(ctx(true))).config.defaults?.model).toBeUndefined();
	});

	it("lets memory.json defaults.model provide the shared model", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ defaults: { model: "other/model" } }));
		expect((await loadConfig(ctx(true))).config.defaults?.model).toBe("other/model");
	});

	it("has lock defaults", async () => {
		expect((await loadConfig(ctx(false))).config.lock).toEqual({ timeoutMs: 5000, snapshotKeep: 5 });
	});

	it("deep-merges the lock section, keeping the untouched sibling", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ lock: { timeoutMs: 1000 } }));
		expect((await loadConfig(ctx(true))).config.lock).toEqual({ timeoutMs: 1000, snapshotKeep: 5 });
	});

	// v1 的 autoSurfacing.maxTopicBytes 语义是「一个 topic 文件的注入上限」，v2 的 maxEntryBytes 是
	// 「一条 entry 的注入上限」。旧键必须彻底失效：若它还生效，用户配置里的旧值会静默改变 v2 的注入预算。
	it("ignores the legacy autoSurfacing.maxTopicBytes key", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ autoSurfacing: { maxTopicBytes: 999 } }));
		expect((await loadConfig(ctx(true))).config.autoSurfacing.maxEntryBytes).toBe(3072);
	});

	it("deep-merges the new extractMemories char limits", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ extractMemories: { maxToolResultChars: 200 } }));
		expect((await loadConfig(ctx(true))).config.extractMemories).toEqual({
			enabled: false,
			thinkLevel: "high",
			maxContextTokens: 2000,
			maxToolResultChars: 200,
			maxAssistantChars: 2000,
		});
	});

	// 坏文件**只**跳过它自己：后面的项目配置照旧生效（1.x 的 readJsonSafe 是逐文件 try/catch）。
	it("skips a malformed file and keeps the other", async () => {
		await writeFile(join(globalDir, "memory.json"), "{ not json");
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ memIndexMaxLines: 42 }));
		expect((await loadConfig(ctx(true))).config.memIndexMaxLines).toBe(42);
	});

	it("expands ~ only for win32 backslash forms", async () => {
		// 正斜杠形态两个平台都展开
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~/mem" }));
		expect((await loadConfig({ ...ctx(false), _platform: "linux" })).config.memoryDir).toBe(join(homedir(), "mem"));
		// 反斜杠形态只在 win32 展开
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ memoryDir: "~\\mem" }));
		expect((await loadConfig({ ...ctx(false), _platform: "win32" })).config.memoryDir).toBe(join(homedir(), "mem"));
		expect((await loadConfig({ ...ctx(false), _platform: "linux" })).config.memoryDir).toBe("~\\mem");
	});

	// ── 宿主扩展位（pi 的 nudge 策略） ─────────────────────────────────────────
	// 两个键已离开 `MemoryConfig`，但用户可见的键名与默认值不变：它们仍从**同一份** `memory.json`
	// 的 `dream` 子树里读，只是落在 `host` 而不是 `config` 上。

	it("falls back to PI_HOST_DEFAULTS when memory.json says nothing about nudging", async () => {
		expect((await loadConfig(ctx(true))).host).toEqual(PI_HOST_DEFAULTS);
	});

	it("reads the nudge policy from memory.json's dream subtree", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ dream: { nudgeAfterSessions: 3 } }));
		expect((await loadConfig(ctx(true))).host).toEqual({ nudgeAfterSessions: 3, nudgeAfterHours: 24 });
	});

	// 合并顺序与 `config` 一致：全局先、可信项目后，后者赢；同一文件里的兄弟键互不影响。
	it("lets the trusted project override the global nudge policy key by key", async () => {
		await writeFile(join(globalDir, "memory.json"), JSON.stringify({ dream: { nudgeAfterSessions: 3 } }));
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ dream: { nudgeAfterHours: 6 } }));
		expect((await loadConfig(ctx(true))).host).toEqual({ nudgeAfterSessions: 3, nudgeAfterHours: 6 });
	});

	it("ignores the project's nudge policy when the project is not trusted", async () => {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "memory.json"), JSON.stringify({ dream: { nudgeAfterSessions: 1 } }));
		expect((await loadConfig(ctx(false))).host.nudgeAfterSessions).toBe(5);
	});

	// 一份坏文件不能带走整个宿主配置：跳过后面的文件照旧生效。
	it("falls back to defaults for a malformed file instead of throwing", async () => {
		await writeFile(join(globalDir, "memory.json"), "{ not json");
		expect((await loadConfig(ctx(true))).host).toEqual(PI_HOST_DEFAULTS);
	});
});
