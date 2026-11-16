import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SyncEngine } from "@yandy0725/memory-core";
import { vi } from "vitest";
import type { MemoryConfig } from "../../src/config";
import { PI_HOST_DEFAULTS } from "../../src/config";

/**
 * 接线测试的共享 harness。
 *
 * **import 顺序是硬约定**：本模块注册了下面 7 个 `vi.mock`，所以引用它必须排在引用 `../index`
 * 之前。顺序错了 mock 不会注册，用例会去读真实 `~/.pi` 配置然后整片变红（不会静默绿）。
 * 根 `biome.json` 的 `files.includes` 排除了 tests 目录，Biome 不会重排把它改坏。
 * 完整约定（含 `PI_CODING_AGENT_DIR` 隔离与临时目录）见 docs/guides/testing.md。
 *
 * `vi.hoisted` 创建的变量**不能**直接 export（`SyntaxError: Cannot export hoisted variable`），
 * 所以这里把 hoisted 的结果留作模块内常量，只导出它们的派生句柄。
 */

const config = vi.hoisted(() => ({
	/** 工厂里不能 import node:path（hoisted 工厂先于模块体执行）：用它算「cwd 的末段」。 */
	basename: (p: string) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? "",
	/** `loadConfig` 的分派实现，工厂执行时装进来；`resetWiringMocks()` 复位后靠它装回。 */
	loadConfigDispatch: { current: null as null | ((ctx: unknown) => Promise<unknown>) },
}));

const mocks = vi.hoisted(() => ({
	loadConfigMock: vi.fn(),
	resolveMemoryDirMock: vi.fn(),
	scanEntriesMock: vi.fn(),
	runTaskMock: vi.fn(),
	shouldNudgeMock: vi.fn(),
	readRecordedMemoryIndexMock: vi.fn(),
	projectIdentityMock: vi.fn(),
	/** 真 backend/engine 的观察带：只记顺序，调用仍委托 core 的真实现。 */
	syncEvents: [] as string[],
	/** 当前装配出的真实 engine 包装；测试可在慢 I/O 边界上 spy，不替换调度与落盘实现。 */
	syncEngines: [] as SyncEngine[],
	/** dispose 竞争测试只延迟真实 push/init 的起点，不替换其结果或行为。 */
	syncPushBarrier: { current: null as Promise<void> | null },
	syncPushTimeouts: [] as number[],
	syncInitBarrier: { current: null as Promise<void> | null },
	syncInitSignals: [] as Array<AbortSignal | undefined>,
	/** 只故障注入适配层直接调用的 writeManifest；core engine 内部仍走真实实现。 */
	syncManifestWriteFailure: { current: null as Error | null },
	readDreamMetaMock: vi.fn(),
	writeDreamMetaMock: vi.fn().mockResolvedValue(undefined),
	detectLegacyMemoryDirMock: vi.fn().mockResolvedValue(null),
	createMemoryToolSpy: vi.fn(),
	searchSessionsMock: vi.fn().mockResolvedValue(""),
}));

// 只替换 loadConfig，保留真实导出：modelConfigErrors / requiredModels 是 session_start 校验的
// 被测对象，mock 掉整个模块会让它们在使用处变成 undefined。
vi.mock("../../src/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/config")>();
	return {
		...actual,
		loadConfig: mocks.loadConfigMock.mockImplementation((ctx: unknown) => {
			return config.loadConfigDispatch.current!(ctx);
		}),
		__loadConfigDispatch: (() => {
			// 真实读 PI_CODING_AGENT_DIR 下的 memory.json
			config.loadConfigDispatch.current = async (ctx: unknown) =>
				actual.loadConfig(ctx as Parameters<typeof actual.loadConfig>[0]);
		})(),
	};
});

// auto-surfacing 的 scanEntries 与三个任务共用的 runTask 都来自 core，在这里一并替换；
// applyIndexSection 走 pi 的真实实现，这样「sections 注入 + 冻结」这件事本身也被钉住。
// `resolveMemoryDir` / `scanEntries` / `runTask` 同样来自 core，但同一个包还提供 `MemoryStore` /
// `indexCapacity` / `parseEntryIndex` / `readLockStatus` / `withFsRetry` / `LOCK_FILE` /
// `buildIndexSection` / `indexInjectionCapacity` —— 那些是端到端写入用例的被测对象，
// 必须保持真实，所以只能整体展开后替换这几个符号。
// 同一个模块只能有一个 `vi.mock` 工厂（后注册的会覆盖前者），所以三者必须写在一起。
vi.mock("@yandy0725/memory-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@yandy0725/memory-core")>();
	return {
		...actual,
		resolveMemoryDir: mocks.resolveMemoryDirMock.mockImplementation(async (cfg: unknown, cwd: string) => {
			// 真实 config 的 memoryDir + cwd 末段：不 spawn git，也不依赖任何可变引用
			return join((cfg as { memoryDir: string }).memoryDir, config.basename(cwd));
		}),
		// 与 resolveMemoryDir 的 stub 一样按 cwd 末段派生稳定身份；backend/engine/device 保持真实。
		projectIdentity: mocks.projectIdentityMock.mockImplementation(async (cwd: string) => ({
			kind: "git",
			key: `example.com/org/${config.basename(cwd)}`,
		})),
		createGitSyncBackend: (options: Parameters<typeof actual.createGitSyncBackend>[0]) => {
			const backend = actual.createGitSyncBackend(options);
			return {
				...backend,
				init: async (opts: Parameters<typeof backend.init>[0]) => {
					mocks.syncEvents.push("init:start");
					mocks.syncInitSignals.push(opts.signal);
					try {
						if (mocks.syncInitBarrier.current) await mocks.syncInitBarrier.current;
						return await backend.init(opts);
					} finally {
						mocks.syncEvents.push("init:end");
					}
				},
				fetch: async (scope: Parameters<typeof backend.fetch>[0], opts: Parameters<typeof backend.fetch>[1]) => {
					mocks.syncEvents.push("fetch");
					return backend.fetch(scope, opts);
				},
			};
		},
		writeManifest: async (...args: Parameters<typeof actual.writeManifest>) => {
			const failure = mocks.syncManifestWriteFailure.current;
			if (failure) {
				mocks.syncManifestWriteFailure.current = null;
				throw failure;
			}
			return actual.writeManifest(...args);
		},
		createSyncEngine: (options: Parameters<typeof actual.createSyncEngine>[0]) => {
			const engine = actual.createSyncEngine(options);
			const observed: SyncEngine = {
				...engine,
				noteWrite: () => {
					mocks.syncEvents.push("noteWrite");
					engine.noteWrite();
				},
				pull: async (timeoutMs?: number) => {
					mocks.syncEvents.push("pull");
					return engine.pull(timeoutMs);
				},
				push: async (timeoutMs?: number) => {
					mocks.syncEvents.push("push:start");
					mocks.syncPushTimeouts.push(timeoutMs as number);
					if (mocks.syncPushBarrier.current) await mocks.syncPushBarrier.current;
					try {
						return await engine.push(timeoutMs);
					} finally {
						mocks.syncEvents.push("push:end");
					}
				},
				flush: async (timeoutMs?: number) => {
					mocks.syncEvents.push("flush");
					return engine.flush(timeoutMs);
				},
				dispose: () => {
					mocks.syncEvents.push("dispose");
					engine.dispose();
				},
				get inFlight() {
					return engine.inFlight;
				},
			};
			mocks.syncEngines.push(observed);
			return observed;
		},
		buildIndexSection: async (...args: Parameters<typeof actual.buildIndexSection>) => {
			mocks.syncEvents.push("index");
			return actual.buildIndexSection(...args);
		},
		scanEntries: mocks.scanEntriesMock,
		runTask: mocks.runTaskMock,
	};
});

vi.mock("../../src/nudge", () => ({
	shouldNudge: mocks.shouldNudgeMock,
	writeDreamMeta: mocks.writeDreamMetaMock,
	readDreamMeta: mocks.readDreamMetaMock,
}));

// 真实现照跑（端到端写入用例要用真的工具），只加一层观察：`buildMemoryTool` 闭包有没有把
// core 给的 spec 原样交给 createMemoryTool。
vi.mock("../../src/memory-tool", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/memory-tool")>();
	mocks.createMemoryToolSpy.mockImplementation(actual.createMemoryTool);
	return { ...actual, createMemoryTool: mocks.createMemoryToolSpy };
});

vi.mock("../../src/legacy-hint", () => ({
	detectLegacyMemoryDir: mocks.detectLegacyMemoryDirMock,
}));

vi.mock("../../src/session-search", () => ({
	searchSessions: mocks.searchSessionsMock,
}));

// 录制值重放的真实现由 tests/index-source.test.ts 覆盖（这里整个 mock 掉，接线层只钉
// 「哪个 reason 走录制值、拿到/拿不到分别怎么办」）。
vi.mock("../../src/index-source", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/index-source")>();
	return {
		...actual,
		readRecordedMemoryIndex: (...args: Parameters<typeof actual.readRecordedMemoryIndex>) => {
			mocks.syncEvents.push("recorded-index");
			return mocks.readRecordedMemoryIndexMock(...args);
		},
	};
});

export const loadConfigMock = mocks.loadConfigMock;
export const resolveMemoryDirMock = mocks.resolveMemoryDirMock;
export const projectIdentityMock = mocks.projectIdentityMock;
export const syncEvents = mocks.syncEvents;
export const syncEngines = mocks.syncEngines;
export const syncPushBarrier = mocks.syncPushBarrier;
export const syncPushTimeouts = mocks.syncPushTimeouts;
export const syncInitBarrier = mocks.syncInitBarrier;
export const syncInitSignals = mocks.syncInitSignals;
export const syncManifestWriteFailure = mocks.syncManifestWriteFailure;
export const scanEntriesMock = mocks.scanEntriesMock;
export const runTaskMock = mocks.runTaskMock;
export const shouldNudgeMock = mocks.shouldNudgeMock;
export const readRecordedMemoryIndexMock = mocks.readRecordedMemoryIndexMock;
export const readDreamMetaMock = mocks.readDreamMetaMock;
export const writeDreamMetaMock = mocks.writeDreamMetaMock;
export const detectLegacyMemoryDirMock = mocks.detectLegacyMemoryDirMock;
export const createMemoryToolSpy = mocks.createMemoryToolSpy;
export const searchSessionsMock = mocks.searchSessionsMock;

export const LEGACY_TOPIC = [
	"---",
	"name: debugging",
	"description: SSH",
	"type: project",
	"updated: 2026-07-03",
	"---",
	"",
	"## SSH Gotcha",
	"",
	"staging 的 SSH 用 2222 端口",
	"",
].join("\n");

export const DISK_INDEX = "- [SSH](ssh.md) — staging ssh config\n";

/**
 * 把 `beforeEach` 里的 mock 复位搬到这里，让 8 个测试文件共用同一套默认行为。
 *
 * **只含 mock 复位**：目录与配置 fixture 由 `setupSession()` 负责，每个用例自带一份临时磁盘状态，
 * 已不需要在这里复原任何全局对象。
 * `detectLegacyMemoryDirMock` 刻意不 reset：它靠逐条 `mockResolvedValueOnce` 驱动，
 * reset 会清掉创建时设的默认 `null`，让「探测器没发现旧数据」的用例失去前提。
 */
export function resetWiringMocks(): void {
	// `mockReset` 会连实现一起清掉，所以接着把分派装回去；这样上一条用例遗留的
	// `mockImplementationOnce` 队列也不会串到下一条用例。
	mocks.loadConfigMock.mockReset();
	if (config.loadConfigDispatch.current) mocks.loadConfigMock.mockImplementation(config.loadConfigDispatch.current);
	projectIdentityMock.mockReset();
	projectIdentityMock.mockImplementation(async (cwd: string) => ({
		kind: "git",
		key: `example.com/org/${config.basename(cwd)}`,
	}));
	syncEvents.length = 0;
	syncEngines.length = 0;
	syncPushBarrier.current = null;
	syncPushTimeouts.length = 0;
	syncInitBarrier.current = null;
	syncInitSignals.length = 0;
	syncManifestWriteFailure.current = null;
	scanEntriesMock.mockReset();
	runTaskMock.mockReset();
	runTaskMock.mockImplementation((task: { id?: string }, _input: unknown, ctx?: { cfg?: MemoryConfig }) => {
		if (task.id === "dream") {
			const model = ctx?.cfg?.dream?.model ?? ctx?.cfg?.defaults?.model;
			if (model === undefined) {
				return Promise.reject(
					new Error('no model for dream — set "dream.model" or "defaults.model" in memory.json'),
				);
			}
			return Promise.resolve("consolidated");
		}
		if (task.id === "extractMemories") return Promise.resolve({ skipped: false, result: "saved 1" });
		return Promise.resolve({ files: [], content: "" });
	});
	shouldNudgeMock.mockReset();
	shouldNudgeMock.mockResolvedValue({ nudge: false, message: "", sessions: 0, newEntries: 0 });
	readRecordedMemoryIndexMock.mockReset();
	readRecordedMemoryIndexMock.mockReturnValue(null);
	readDreamMetaMock.mockReset();
	readDreamMetaMock.mockResolvedValue({ lastDreamAt: null });
	writeDreamMetaMock.mockReset();
	writeDreamMetaMock.mockResolvedValue(undefined);
}

/** 「cwd → 目录末段」的唯一实现：`setupSession` 与 `resolveMemoryDir` 的 stub 必须用同一条规则。 */
export function expectedDir(memoryDirRoot: string, cwd: string): string {
	return join(memoryDirRoot, String(cwd).split(/[\\/]/).filter(Boolean).pop() ?? "");
}

/** 直接装配 runtime 的测试与 projectIdentity stub 共用同一个稳定 git 身份。 */
export function gitIdentity(cwd: string) {
	return { kind: "git" as const, key: `example.com/org/${config.basename(cwd)}` };
}

export interface SessionSetup {
	/** 本会话的记忆目录 = `expectedDir(memoryDirRoot, cwd)` */
	dir: string;
	memoryDirRoot: string;
	/** `PI_CODING_AGENT_DIR` 指向它；`getAgentDir()` 与 `SessionManager` 都被隔离在这里 */
	agentDir: string;
	cwd: string;
	/** 重写 `memory.json`（top-level 键整体替换）；传 `{}` 回到默认。 */
	writeConfig(patch?: Record<string, unknown>): Promise<void>;
	uiCtx(over?: Record<string, unknown>): any;
	cleanup(): Promise<void>;
}

const execFileP = promisify(execFile);

/**
 * 给接线用例准备一个纯本地 bare remote，并启用真实同步装配。
 * 只隔离 git 的全局/系统配置；不访问网络，也不替换 backend/engine。
 */
export async function enableTestSync(s: SessionSetup, over: Record<string, unknown> = {}): Promise<string> {
	const emptyGitConfig = join(s.cwd, "gitconfig-empty");
	await writeFile(emptyGitConfig, "", "utf8");
	vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	const remote = join(s.cwd, "sync-remote.git");
	await execFileP("git", ["init", "--bare", "--quiet", remote], { cwd: s.cwd, timeout: 15_000 });
	await s.writeConfig({
		sync: {
			enabled: true,
			remote,
			branch: "main",
			pullOnStart: false,
			pushOnWrite: true,
			// 写触发用例只观察 noteWrite；自动推送由 core 自己的套件覆盖。
			pushDebounceMs: 60_000,
			autoTimeoutMs: 10_000,
			timeoutMs: 10_000,
			...over,
		},
	});
	return remote;
}

export interface SetupSessionOptions {
	/** `null` = 不写 `defaults.model`（模拟「用户把模型配置删了」的配置错误态）。 */
	model?: string | null;
	extract?: boolean;
	surfacing?: boolean;
	/** 默认 true：把 `DISK_INDEX` 写进 `MEMORY.md`。 */
	withDiskIndex?: boolean;
}

/**
 * 建一个「真实配置」的会话运行环境：临时 cwd + 临时 agentDir + 一份真的 `memory.json`。
 *
 * 从此 `loadConfig` 走真实实现、`resolveMemoryDir` 从真实 config 的 `memoryDir` 推导目录，
 * 不再需要任何手写对象或可变引用桥接。
 */
export async function setupSession(opts: SetupSessionOptions = {}): Promise<SessionSetup> {
	const cwd = await mkdtemp(join(tmpdir(), "mem-wiring-"));
	const agentDir = join(cwd, "agent");
	const memoryDirRoot = join(cwd, "memory");
	const dir = expectedDir(memoryDirRoot, cwd);
	await mkdir(agentDir, { recursive: true });
	await mkdir(dir, { recursive: true });
	if (opts.withDiskIndex !== false) await writeFile(join(dir, "MEMORY.md"), DISK_INDEX, "utf8");

	let current: Record<string, unknown> = {};
	const writeConfig = async (patch: Record<string, unknown> = {}): Promise<void> => {
		current = { ...current, ...patch };
		const defaults = (current.defaults as Record<string, unknown> | undefined) ?? {};
		const body: Record<string, unknown> = {
			memoryDir: memoryDirRoot,
			...current,
			defaults: { sessionPersistence: { enabled: false }, ...defaults },
		};
		await writeFile(join(agentDir, "memory.json"), JSON.stringify(body, null, "\t"), "utf8");
	};

	const initial: Record<string, unknown> = {};
	if (opts.model !== null) initial.defaults = { model: opts.model ?? "test/model" };
	if (opts.extract) initial.extractMemories = { enabled: true };
	if (opts.surfacing === false) initial.autoSurfacing = { enabled: false };
	await writeConfig(initial);

	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

	return {
		dir,
		memoryDirRoot,
		agentDir,
		cwd,
		writeConfig,
		uiCtx: (over: Record<string, unknown> = {}) => uiCtx({ cwd, ...over }),
		cleanup: async () => {
			vi.unstubAllEnvs();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

export function createFakePi() {
	const handlers: Record<string, Array<(event: any, ctx: any) => any | Promise<any>>> = {};
	const tools: any[] = [];
	const commands: Record<string, any> = {};

	return {
		handlers,
		tools,
		commands,
		pi: {
			on(event: string, handler: (event: any, ctx: any) => any | Promise<any>) {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(handler);
			},
			registerTool(def: any) {
				tools.push(def);
			},
			registerCommand(name: string, opts: any) {
				commands[name] = opts;
			},
		},
	};
}

/**
 * resolveModel 只用到这三个方法；ids 形如 "provider/id"。
 * `availableIds` 缺省与 `ids` 同值（= 全部可用）；显式传它就能造出「getAll 认得这个模型、
 * getAvailable 里没有」的 registry —— 也就是模型存在但**没有凭据**（spec 风险表里的
 * "missing credentials"），与「registry 完全不知道这个 id」是两回事。
 */
export function fakeRegistry(ids: string[], availableIds: string[] = ids) {
	const toModels = (list: string[]) =>
		list.map((full) => {
			const [provider, id] = full.split("/");
			return { provider, id, name: id };
		});
	const models = toModels(ids);
	const available = toModels(availableIds);
	return {
		getAll: () => models,
		getAvailable: () => available,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	} as any;
}

/**
 * 一个最小可用的 `ExtensionContext` 形状。
 *
 * `cwd` 默认空串只是为了能构造一个「形状对」的 ctx；**会走到 handler 的用例必须给真实 cwd**
 * （`s.cwd`）—— `session_start` 会把它当 `currentCwd`，`/dream` 会拿它去 `SessionManager.list(cwd)`。
 */
export function uiCtx(over: Record<string, unknown> = {}) {
	return {
		cwd: "",
		hasUI: false,
		isProjectTrusted: () => true,
		modelRegistry: fakeRegistry(["test/model"]),
		model: undefined,
		sessionManager: { getEntries: () => [], getLeafId: () => null },
		...over,
	} as any;
}

/** 现状宿主的 fake 事件：`systemPromptOptions.sections` 是可变对象，注入就地写进去。 */
export function sectionsEvent(prompt = "q") {
	return {
		messageType: "user" as const,
		prompt,
		systemPrompt: "BASE_PROMPT",
		systemPromptOptions: { sections: {} as Record<string, string | null> },
	};
}

/**
 * `messageType: "custom"` 的 run（`pi.sendMessage(..., { triggerTurn: true })` 空闲触发）：
 * 宿主 1.2.0 起这类事件带 `message` 而不是 `prompt`。
 */
export function customTriggerEvent() {
	return {
		messageType: "custom" as const,
		message: { customType: "other-extension", content: "hi", display: false },
		systemPrompt: "BASE_PROMPT",
		systemPromptOptions: { sections: {} as Record<string, string | null> },
	};
}

/**
 * 排空待处理的微任务（extract / dream 的 `.then` 链是异步的）。
 * **只覆盖一层宏任务**：链上每个 `await` 都要再 flush 一次，别指望一次 flush 跑完整条链。
 */
export async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 等条件成立（默认 2s，每 10ms 轮询一次）。完成回调在 notify 之前会做真实磁盘 I/O
 * （`SessionManager.list`），单个 `setTimeout(0)` tick 覆盖不到它——实测空闲机器上仍有
 * 约 2% 的概率输给这段 I/O，并行跑整仓时更容易翻车。所以这里等条件，不猜时间。
 */
export async function waitFor(condition: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timeout waiting for ${description} after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function uiWith(notify = vi.fn()) {
	return { hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } };
}

/**
 * pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
 * session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。
 * 这里造一个同形状的 fake：`dispose()` 之后读取这两个字段直接抛错。
 */
/**
 * pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
 * session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。
 * 这里造一个同形状的 fake：`dispose()` 之后读取这两个字段直接抛错。
 */
// ── Review 修复轮（R44）：session dispose 之后 ctx 不可再访问 ─────────────
/**
 * pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
 * session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。
 * 这里造一个同形状的 fake：`dispose()` 之后读取这两个字段直接抛错。
 */
export function disposableCtx(cwd = "") {
	let active = true;
	const notify = vi.fn();
	const ui = { notify, confirm: vi.fn(), setStatus: vi.fn() };
	const ctx: any = uiCtx({ cwd });
	Object.defineProperty(ctx, "hasUI", {
		get: () => {
			if (!active) throw new Error("Extension instance is no longer active");
			return true;
		},
	});
	Object.defineProperty(ctx, "ui", {
		get: () => {
			if (!active) throw new Error("Extension instance is no longer active");
			return ui;
		},
	});
	return {
		ctx,
		notify,
		dispose: () => {
			active = false;
		},
	};
}

/**
 * 收集进程级未处理 rejection。extract 的通知挂在 `void` 链上，没人接住的 rejection 在 pi
 * 里没有全局 handler（Node 默认打印并退出）—— 这里显式抓住它们。
 */
export async function captureUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
	const caught: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		caught.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		await body();
		// 未处理 rejection 要等微任务队列排空后的下一轮事件循环才派发。
		await flush();
		await flush();
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	return caught;
}
