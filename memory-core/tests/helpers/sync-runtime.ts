import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type MemoryConfig, type SyncConfig } from "../../src/config.js";
import {
	MemoryStore,
	type ProjectIdentity,
	type StoreConfig,
	createSyncRuntime,
	devicePath,
	manifestPath,
	readManifest,
	remoteProjectKey,
	serializeEntryFile,
	syncRootPath,
	type SyncBackend,
	type SyncEngine,
	type SyncEngineOptions,
	type SyncInitResult,
	type SyncManifest,
	type SyncRoundResult,
	type SyncRunOptions,
	type SyncRuntime,
	type SyncRuntimeOptions,
	type SyncStatusReport,
	writeManifest,
} from "../../src/index.js";

/**
 * SyncRuntime 的测试夹具。
 *
 * **真实的部分**：临时记忆根、真实的 `MemoryStore`、真实的 `device.json` 与 manifest 文件 ——
 * 「不晚建 device」「写的是 v2 空基线」「绑定的是实际 origin」这些断言必须在真盘上看得见。
 * **假的部分只有协调端口**：backend 与 engine 记录调用/顺序，并可在 `init` / `push` 处挂屏障，
 * 让「init 途中 dispose」「启动预算被 prepare 吃掉」这类时序可以确定性地断言。
 *
 * runtime 本身一行都没有被替换：所有门禁、懒 engine、single-flight、预算与收尾都跑真实现。
 * 引擎也只替换到端口为止（`createEngine` 交回假实现），所以不存在「用桩测桩」。
 */

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

/** 只在测试里用的可放行屏障：`await barrier.promise` 挂起，`resolve()` 之后继续。 */
export function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 固定的时钟：manifest 的 `syncedAt` 与设备 `createdAt` 因此可以断言成字面量。 */
export const HARNESS_NOW = (): Date => new Date("2026-11-15T08:00:00.000Z");

/**
 * 宿主注入的提示文案。core 不自带漂移指引，测试用一句可识别的字符串证明「用的是注入值」。
 */
export const HARNESS_MESSAGES: SyncRuntimeOptions["messages"] = {
	originDrift: "configured remote differs from the initialized origin; the origin stays authoritative",
	uninitializedRemoteChange: "set the remote in the host configuration before changing it",
};

// ---------------------------------------------------------------------------
// 假 backend：只实现「装配与 prepare 用得到的那几个方法」
// ---------------------------------------------------------------------------

export interface FakeBackend extends SyncBackend {
	/** `ready()` 的答案。 */
	initialized: boolean;
	/** `getRemote()` 的答案，即初始化之后真实的 origin（可以与配置里的 remote 不同）。 */
	origin: string | null;
	/** `init()` 交回的 revision：远端真的有的那一个。 */
	initRevision: string;
	/** `init()` 之后本地记录的 origin；测试没预设 `origin` 时由它补上（真实 backend 由 clone 得到）。 */
	initOrigin: string;
	/** `init()` 交回的非致命警告。 */
	initWarnings: string[];
	/** `init()` 抛出的错误（一次性观察点：失败路径）。 */
	initFailure: Error | null;
	/** `ready()` 之前的人为延迟，用来让 prepare 吃掉启动预算。 */
	readyDelayMs: number;
	/** 非 null 时 `ready()` 等到它放行才返回。 */
	readyBarrier: Deferred<void> | null;
	/** `ready()` 一进来就 resolve。 */
	readyStarted: Deferred<void> | null;
	/** 非 null 时 `init()` 等到它放行才返回。 */
	initBarrier: Deferred<void> | null;
	/** 非 null 时 `getRemote()` 等到它放行才返回。 */
	getRemoteBarrier: Deferred<void> | null;
	/** `getRemote()` 一进来就 resolve。 */
	getRemoteStarted: Deferred<void> | null;
	/** 非 null 时 `setRemote()` 等到它放行才返回。 */
	setRemoteBarrier: Deferred<void> | null;
	/** `setRemote()` 一进来就 resolve。 */
	setRemoteStarted: Deferred<void> | null;
	/** `init()` 一进来就 resolve：测试据此在「init 途中」做别的事。 */
	initStarted: Deferred<void> | null;
	/** 每次 `init()` 收到的 abort 信号。 */
	initSignals: Array<AbortSignal | undefined>;
	initTimeouts: number[];
	readyCalls: number;
	setRemoteCalls: string[];
}

export function createFakeBackend(events: string[]): FakeBackend {
	const backend: FakeBackend = {
		initialized: false,
		origin: null,
		initRevision: "",
		initOrigin: "https://init.example/org/proj.git",
		initWarnings: [],
		initFailure: null,
		readyDelayMs: 0,
		readyBarrier: null,
		readyStarted: null,
		initBarrier: null,
		initStarted: null,
		getRemoteBarrier: null,
		getRemoteStarted: null,
		setRemoteBarrier: null,
		setRemoteStarted: null,
		initSignals: [],
		initTimeouts: [],
		readyCalls: 0,
		setRemoteCalls: [],

		async ready(): Promise<boolean> {
			backend.readyCalls += 1;
			events.push("backend:ready");
			backend.readyStarted?.resolve(undefined);
			if (backend.readyDelayMs > 0) await sleep(backend.readyDelayMs);
			if (backend.readyBarrier !== null) await backend.readyBarrier.promise;
			return backend.initialized;
		},
		async init(opts: SyncRunOptions): Promise<SyncInitResult> {
			events.push("backend:init");
			backend.initTimeouts.push(opts.timeoutMs);
			backend.initSignals.push(opts.signal);
			backend.initStarted?.resolve(undefined);
			try {
				if (backend.initBarrier !== null) await backend.initBarrier.promise;
				if (backend.initFailure !== null) throw backend.initFailure;
				backend.initialized = true;
				// 初始化之后 origin 就是可自省的了；测试没预设时用一个明确的默认值。
				if (backend.origin === null) backend.origin = backend.initOrigin;
				return { revision: backend.initRevision, warnings: [...backend.initWarnings] };
			} finally {
				events.push("backend:init:done");
			}
		},
		async getRemote(): Promise<string | null> {
			events.push("backend:getRemote");
			backend.getRemoteStarted?.resolve(undefined);
			if (backend.getRemoteBarrier !== null) await backend.getRemoteBarrier.promise;
			return backend.initialized ? backend.origin : null;
		},
		async setRemote(remote: string, _opts: SyncRunOptions): Promise<void> {
			events.push("backend:setRemote");
			backend.setRemoteCalls.push(remote);
			backend.setRemoteStarted?.resolve(undefined);
			if (backend.setRemoteBarrier !== null) await backend.setRemoteBarrier.promise;
			// 端口口径：未初始化时什么都不改；空地址 fail-closed。
			if (!backend.initialized) return;
			if (remote.trim() === "") throw new Error("refusing to set an empty sync remote");
			backend.origin = remote;
		},
		// 这两条在本任务的基本操作里**不该被调用**：真被调用就让测试红在「越界」上，而不是静默通过。
		async fetch(): Promise<never> {
			events.push("backend:fetch");
			throw new Error("the fake backend must not be asked to fetch by the basic runtime operations");
		},
		async publish(): Promise<never> {
			events.push("backend:publish");
			throw new Error("the fake backend must not be asked to publish by the basic runtime operations");
		},
	};
	return backend;
}

// ---------------------------------------------------------------------------
// 假 engine：记录预算与调用顺序，默认 round 形状完整
// ---------------------------------------------------------------------------

/**
 * 一轮推送的默认结果：**形状完整**，`ok` / `revision` 都显式给值 —— 测试不靠桩缺省任何字段，
 * 否则「runtime 把 round 原样透传」这条断言会被一个残缺的假 round 蒙过去。
 */
export const PUSH_ROUND: SyncRoundResult = {
	ok: true,
	revision: "rev-pushed",
	pulled: ["Pulled-by-round.md"],
	pushed: ["Pushed-by-round.md"],
	deletedLocal: [],
	deletedRemote: [],
	conflicts: [],
	rejected: [],
	unparsableLocal: [],
	outOfScopeRemote: [],
};

export const PULL_ROUND: SyncRoundResult = {
	ok: true,
	revision: "rev-pulled",
	pulled: ["Pulled-by-round.md"],
	pushed: [],
	deletedLocal: [],
	deletedRemote: [],
	conflicts: [],
	rejected: [],
	unparsableLocal: [],
	outOfScopeRemote: [],
};

export const FLUSH_ROUND: SyncRoundResult = {
	ok: true,
	revision: "rev-flushed",
	pulled: [],
	pushed: ["Flushed-by-runtime.md"],
	deletedLocal: [],
	deletedRemote: [],
	conflicts: [],
	rejected: [],
	unparsableLocal: [],
	outOfScopeRemote: [],
};

export const STATUS_REPORT: SyncStatusReport = {
	configured: true,
	initialized: true,
	remote: "https://origin.example/org/proj.git",
	branch: "main",
	device: { id: "fake-device", hostname: "fake-host", createdAt: "2026-11-01T00:00:00.000Z" },
	projectDir: "/tmp/fake-project",
	projectKey: "origin.example__org__proj",
	base: { revision: "rev-base", syncedAt: "2026-11-15T07:00:00.000Z" },
	ahead: ["Ahead.md"],
	behind: [],
	conflicts: [],
	rejected: [],
	unparsableLocal: [],
	outOfScopeRemote: [],
	errors: [],
};

export interface FakeEngine extends SyncEngine {
	noteWrites: number;
	disposeCalls: number;
	pullTimeouts: number[];
	/** `push` 收到的预算，按调用顺序。 */
	pushTimeouts: number[];
	statusTimeouts: number[];
	flushTimeouts: number[];
	/** 非 null 时 `push` 等到它放行才返回。 */
	pushBarrier: Deferred<void> | null;
	/** `push` 一进来就 resolve。 */
	pushStarted: Deferred<void> | null;
	/** 非 null 时 `pull` 抛出它：端口异常不该让调用方的 promise reject。 */
	pullFailure: Error | null;
	/** 非 null 时 `push` 抛出它（在屏障之后抛，时序用例仍可用）。 */
	pushFailure: Error | null;
	/** 非 null 时 `status()` 等到它放行才返回。 */
	statusBarrier: Deferred<void> | null;
	/** `status()` 一进来就 resolve。 */
	statusStarted: Deferred<void> | null;
	/** 非 null 时 `flush()` 抛出它，runtime 必须保留 rejection 形状并脱敏。 */
	flushFailure: Error | null;
	/** 非 null 时 `noteWrite()` 记录这次尝试之后抛出。 */
	noteWriteFailure: Error | null;
	/** `dispose()` 一进来就 resolve。 */
	disposeStarted: Deferred<void> | null;
	rounds: { pull: SyncRoundResult; push: SyncRoundResult };
	flushRound: SyncRoundResult | null;
	statusReport: SyncStatusReport;
	inFlight: Promise<unknown> | null;
}

export function createFakeEngine(events: string[]): FakeEngine {
	const engine: FakeEngine = {
		noteWrites: 0,
		disposeCalls: 0,
		pullTimeouts: [],
		pushTimeouts: [],
		statusTimeouts: [],
		flushTimeouts: [],
		pushBarrier: null,
		pushStarted: null,
		pullFailure: null,
		pushFailure: null,
		statusBarrier: null,
		statusStarted: null,
		flushFailure: null,
		noteWriteFailure: null,
		disposeStarted: null,
		rounds: { pull: PULL_ROUND, push: PUSH_ROUND },
		flushRound: FLUSH_ROUND,
		statusReport: STATUS_REPORT,
		inFlight: null,

		async pull(timeoutMs?: number): Promise<SyncRoundResult> {
			events.push("engine:pull");
			engine.pullTimeouts.push(timeoutMs as number);
			if (engine.pullFailure !== null) throw engine.pullFailure;
			return engine.rounds.pull;
		},
		async push(timeoutMs?: number): Promise<SyncRoundResult> {
			events.push("engine:push");
			engine.pushTimeouts.push(timeoutMs as number);
			engine.pushStarted?.resolve(undefined);
			if (engine.pushBarrier !== null) await engine.pushBarrier.promise;
			if (engine.pushFailure !== null) throw engine.pushFailure;
			events.push("engine:push:done");
			return engine.rounds.push;
		},
		async status(timeoutMs?: number): Promise<SyncStatusReport> {
			events.push("engine:status");
			engine.statusTimeouts.push(timeoutMs as number);
			engine.statusStarted?.resolve(undefined);
			if (engine.statusBarrier !== null) await engine.statusBarrier.promise;
			return engine.statusReport;
		},
		noteWrite(): void {
			events.push("engine:noteWrite");
			engine.noteWrites += 1;
			if (engine.noteWriteFailure !== null) throw engine.noteWriteFailure;
		},
		async flush(timeoutMs?: number): Promise<SyncRoundResult | null> {
			events.push("engine:flush");
			engine.flushTimeouts.push(timeoutMs as number);
			if (engine.flushFailure !== null) throw engine.flushFailure;
			return engine.flushRound;
		},
		dispose(): void {
			events.push("engine:dispose");
			engine.disposeCalls += 1;
			engine.disposeStarted?.resolve(undefined);
		},
	};
	return engine;
}

// ---------------------------------------------------------------------------
// harness：把真盘与两个假端口装成一份 SyncRuntimeOptions
// ---------------------------------------------------------------------------

const STORE: Omit<StoreConfig, "memoryDir"> = {
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
};

/** 一份「同步确实开着」的基线配置；用例只覆盖关心的那几个键。 */
const BASE_SYNC: SyncConfig = {
	...DEFAULT_CONFIG.sync,
	enabled: true,
	remote: "https://git.example.invalid/org/proj.git",
	branch: "main",
	pullOnStart: false,
	pushOnWrite: false,
	pushDebounceMs: 1000,
	autoTimeoutMs: 30_000,
	timeoutMs: 30_000,
};

export interface HarnessOptions {
	config?: Partial<SyncConfig>;
	identity?: ProjectIdentity;
	messages?: SyncRuntimeOptions["messages"];
	scheduling?: "concurrent" | "serial";
	now?: () => Date;
	/** 每个假 engine 造出来之后的钩子（挂屏障、换 round、记 `inFlight`）。 */
	engineSetup?: (engine: FakeEngine) => void;
	/** 包装真实原子 writer 的测试屏障；invocation 从 1 开始，默认直接写。 */
	manifestWriteHook?: (write: () => Promise<void>, invocation: number) => Promise<void>;
}

export interface HarnessResult {
	runtime: SyncRuntime | null;
	errors: string[];
	notices: string[];
}

export interface BackendContext {
	syncRoot: string;
	memoryRoot: string;
	remote: string;
	branch: string;
}

export interface SyncRuntimeHarness {
	memoryRoot: string;
	syncRoot: string;
	projectDir: string;
	projectKey: string;
	store: MemoryStore;
	/** 共享事件日志：backend 与 engine 的顺序都在这里，顺序断言只认它。 */
	events: string[];
	backend: FakeBackend;
	backendContexts: BackendContext[];
	engineOptions: SyncEngineOptions[];
	engines: FakeEngine[];
	/** 注入的 manifest writer 收到的写入（用来证明 runtime 走的是注入函数，不是包内相对 import）。 */
	manifestWrites: Array<{ path: string; manifest: SyncManifest }>;
	create(over?: HarnessOptions): Promise<HarnessResult>;
	manifest(): Promise<SyncManifest | null>;
	deviceCreated(): boolean;
	manifestExists(): boolean;
	/** 往项目记忆目录里放一条真实 entry（首次基线的冲突副本预告会读到它）。 */
	writeEntry(file: string): Promise<void>;
	cleanup(): Promise<void>;
}

export async function createSyncRuntimeHarness(): Promise<SyncRuntimeHarness> {
	const memoryRoot = await mkdtemp(join(tmpdir(), "am-sync-runtime-"));
	const projectDir = join(memoryRoot, "git", "proj");
	await mkdir(projectDir, { recursive: true });

	const syncRoot = syncRootPath(memoryRoot);
	const projectKey = remoteProjectKey("example.com/org/proj");
	const statePath = manifestPath(syncRoot, projectKey);
	const events: string[] = [];
	const backend = createFakeBackend(events);
	const backendContexts: BackendContext[] = [];
	const engineOptions: SyncEngineOptions[] = [];
	const engines: FakeEngine[] = [];
	const manifestWrites: Array<{ path: string; manifest: SyncManifest }> = [];
	const store = new MemoryStore({ memoryDir: projectDir, ...STORE });

	return {
		memoryRoot,
		syncRoot,
		projectDir,
		projectKey,
		store,
		events,
		backend,
		backendContexts,
		engineOptions,
		engines,
		manifestWrites,

		async create(over: HarnessOptions = {}): Promise<HarnessResult> {
			const config: MemoryConfig = {
				...DEFAULT_CONFIG,
				memoryDir: memoryRoot,
				sync: { ...BASE_SYNC, ...over.config },
			};
			return createSyncRuntime({
				config,
				store,
				projectDir,
				identity: over.identity ?? { kind: "git", key: "example.com/org/proj" },
				scheduling: over.scheduling ?? "concurrent",
				messages: over.messages ?? HARNESS_MESSAGES,
				createBackend(context) {
					backendContexts.push({ ...context });
					return backend;
				},
				createEngine(options) {
					engineOptions.push(options);
					const engine = createFakeEngine(events);
					engines.push(engine);
					over.engineSetup?.(engine);
					return engine;
				},
				// 注入的 writer：先记账，再走真实原子写 —— 于是「runtime 绕开注入直接调包内同名函数」
				// 会让 `manifestWrites` 空着，而盘上却有文件，两处断言同时能抓到。屏障只包住这一次在途调用。
				writeManifest: async (path, manifest) => {
					events.push("manifest:write:start");
					manifestWrites.push({ path, manifest });
					const write = async (): Promise<void> => {
						await writeManifest(path, manifest);
						events.push("manifest:write:done");
					};
					if (over.manifestWriteHook !== undefined) await over.manifestWriteHook(write, manifestWrites.length);
					else await write();
				},
				now: over.now ?? HARNESS_NOW,
			});
		},

		async manifest(): Promise<SyncManifest | null> {
			return readManifest(statePath);
		},
		deviceCreated(): boolean {
			return existsSync(devicePath(syncRoot));
		},
		manifestExists(): boolean {
			return existsSync(statePath);
		},
		async writeEntry(file: string): Promise<void> {
			const name = file.replace(/\.md$/, "");
			const body = serializeEntryFile(
				{
					name,
					description: "d",
					type: "feedback",
					created: "2026-11-09",
					modified: "2026-11-09T10:00:00.000Z",
				},
				"正文",
			);
			await writeFile(join(projectDir, file), body, "utf8");
		},
		async cleanup(): Promise<void> {
			await rm(memoryRoot, { recursive: true, force: true });
		},
	};
}

/** `create()` 的 null runtime 只该出现在门禁用例里；其余用例用它把类型收窄成非空。 */
export function mustRuntime(result: HarnessResult): SyncRuntime {
	if (result.runtime === null) throw new Error(`expected a runtime, got errors: ${result.errors.join("; ")}`);
	return result.runtime;
}
