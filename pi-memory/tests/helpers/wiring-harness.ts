import { vi } from "vitest";
import type { MemoryConfig } from "../../src/config";
import { PI_HOST_DEFAULTS } from "../../src/config";

/**
 * 接线测试的共享 harness。
 *
 * **import 顺序是硬约定**：本模块注册了下面 7 个 `vi.mock`，所以引用它必须排在引用 `../index`
 * 之前。顺序错了 mock 不会注册，用例会去读真实 `~/.pi` 配置然后整片变红（不会静默绿）。
 * 根 `biome.json` 的 `files.includes` 排除了 tests 目录，Biome 不会重排把它改坏。
 *
 * `vi.hoisted` 创建的变量**不能**直接 export（`SyntaxError: Cannot export hoisted variable`），
 * 所以这里把 hoisted 的结果留作模块内常量，只导出它们的派生句柄。
 */

const config = vi.hoisted(() => ({
	mockConfigValue: {
		memoryDir: "",
		memIndexMaxLines: 200,
		memIndexMaxBytes: 25600,
		// 显式注入的 fixture 不该对 DEFAULT_CONFIG 撒谎：注入口径默认是「最新的 50 行 / 16 KiB」。
		memIndexInjectMaxLines: 50,
		memIndexInjectMaxBytes: 16384,
		lock: { timeoutMs: 5000, snapshotKeep: 5 },
		defaults: { model: "test/model", sessionPersistence: { enabled: false } },
		dream: { thinkLevel: "high" as const },
		sessionSearch: { maxSessions: 10, maxMatches: 5 },
		autoSurfacing: {
			enabled: true,
			maxFiles: 5,
			maxEntryBytes: 4096,
			maxInjectionBytes: 20480,
			thinkLevel: "off" as const,
		},
		extractMemories: {
			enabled: false,
			maxContextTokens: 2000,
			maxToolResultChars: 500,
			maxAssistantChars: 2000,
			thinkLevel: "high" as const,
		},
	} as Record<string, any>,
	// vi.mock 的工厂是 hoisted 的，拿不到 beforeEach 里创建的目录 —— 用一个可变引用桥接
	// （docs/guides/testing.md 的「getAgentDir 隔离」一节）。
	dirRef: { current: "" },
	// Plan D（D1）：跨 session 复位的用例需要「不同 cwd → 不同 memoryDir」。为 null 时沿用
	// dirRef.current，既有用例的行为一字不变。
	dirOverrideRef: { current: null as null | ((cwd: string) => string) },
}));

const mocks = vi.hoisted(() => ({
	loadConfigMock: vi.fn(),
	resolveMemoryDirMock: vi.fn(),
	scanEntriesMock: vi.fn(),
	runTaskMock: vi.fn(),
	shouldNudgeMock: vi.fn(),
	readRecordedMemoryIndexMock: vi.fn(),
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
		loadConfig: mocks.loadConfigMock.mockImplementation(async () => ({
			config: { ...config.mockConfigValue, memoryDir: config.dirRef.current },
			host: PI_HOST_DEFAULTS,
		})),
	};
});

// auto-surfacing 的 scanEntries 与三个任务共用的 runTask 都来自 core，在这里一并替换；
// applyIndexSection / buildInjection 走 pi 的真实实现，这样「sections 注入 + 冻结」这件事本身也被钉住。
// `resolveMemoryDir` / `scanEntries` / `runTask` 同样来自 core，但同一个包还提供 `MemoryStore` /
// `indexCapacity` / `parseEntryIndex` / `readLockStatus` / `withFsRetry` / `LOCK_FILE` /
// `buildIndexSection` / `indexInjectionCapacity` —— 那些是端到端写入用例的被测对象，
// 必须保持真实，所以只能整体展开后替换这几个符号。
// 同一个模块只能有一个 `vi.mock` 工厂（后注册的会覆盖前者），所以三者必须写在一起。
vi.mock("@yandy0725/memory-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@yandy0725/memory-core")>();
	return {
		...actual,
		resolveMemoryDir: mocks.resolveMemoryDirMock.mockImplementation(
			async (_config: unknown, cwd: string) =>
				config.dirOverrideRef.current ? config.dirOverrideRef.current(cwd) : config.dirRef.current,
		),
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

// 录制值重放的真实现由 tests/index-source.test.ts 覆盖（本地 SDK 是 0.80.2，没有
// sessionEntryToContextMessages 导出，真实路径在这里永远拿不到录制值）—— 接线层只钉
// 「哪个 reason 走录制值、拿到/拿不到分别怎么办」。
vi.mock("../../src/index-source", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/index-source")>();
	return { ...actual, readRecordedMemoryIndex: mocks.readRecordedMemoryIndexMock };
});

export const mockConfigValue = config.mockConfigValue;
export const dirRef = config.dirRef;
export const dirOverrideRef = config.dirOverrideRef;

export const loadConfigMock = mocks.loadConfigMock;
export const resolveMemoryDirMock = mocks.resolveMemoryDirMock;
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
 * **只含 mock 复位**：每个用例自己的目录（`dirRef.current`）与配置 fixture 的复原仍在各自的
 * `beforeEach` / `afterEach` 里 —— 它们与那个文件的具体场景绑在一起，混进来只会让复位顺序更难读。
 * `detectLegacyMemoryDirMock` 刻意不 reset：它靠逐条 `mockResolvedValueOnce` 驱动，
 * reset 会清掉创建时设的默认 `null`，让「探测器没发现旧数据」的用例失去前提。
 */
export function resetWiringMocks(): void {
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

export function uiCtx(over: Record<string, unknown> = {}) {
	return {
		cwd: dirRef.current,
		hasUI: false,
		isProjectTrusted: () => true,
		modelRegistry: fakeRegistry(["test/model"]),
		model: undefined,
		sessionManager: { getEntries: () => [], getLeafId: () => null },
		...over,
	} as any;
}

/** 0.99.2 宿主的 fake 事件：`systemPromptOptions.sections` 是可变对象，注入就地写进去。 */
export function sectionsEvent(prompt = "q") {
	return {
		prompt,
		systemPrompt: "BASE_PROMPT",
		systemPromptOptions: { sections: {} as Record<string, string | null> },
	};
}

/** 旧 SDK（本地类型 0.80.2）的 fake 事件：根本没有 `sections`。 */
export function legacyEvent(prompt = "q") {
	return { prompt, systemPrompt: "BASE_PROMPT", systemPromptOptions: {} };
}

/**
 * 用「模型缺失」把下一次 session_start 变成配置错误态（`failConfig` → `resetSessionState()`）。
 * 这是包级 `enabled` 移除后**唯一**能得到「无 store 会话」的路径，也正是这些用例原本真正想要
 * 的前置状态：一个不该沿用上一 session 目录/store 的启动。
 */
export function breakModelConfig(): void {
	mockConfigValue.defaults = { sessionPersistence: { enabled: false } };
}

/** 恢复 beforeEach 里的健康模型 fixture。 */
export function restoreModelConfig(): void {
	mockConfigValue.defaults = { model: "test/model", sessionPersistence: { enabled: false } };
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
export function disposableCtx() {
	let active = true;
	const notify = vi.fn();
	const ui = { notify, confirm: vi.fn(), setStatus: vi.fn() };
	const ctx: any = uiCtx();
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
