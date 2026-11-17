/**
 * index wiring — automatic sync preparation and startup convergence
 *
 * harness 必须排在 ../index 与 ../src/sync 之前：只 stub 项目身份，git/backend/engine/device 全走真实现。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	type MemoryConfig,
	type SyncConfig,
	devicePath,
	gitAvailable,
	manifestPath,
	readManifest,
	remoteProjectKey,
	syncRootPath,
	syncTransport,
} from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakePi,
	DISK_INDEX,
	flush,
	gitIdentity,
	projectIdentityMock,
	readRecordedMemoryIndexMock,
	resetWiringMocks,
	sectionsEvent,
	setupSession,
	syncEngines,
	syncEvents,
	syncInitBarrier,
	syncInitSignals,
	syncPushBarrier,
	syncPushTimeouts,
	uiWith,
	waitFor,
} from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { createPiSyncRuntime } from "../src/sync";

const execFileP = promisify(execFile);
const GIT = await gitAvailable();
const RECORDED_INDEX = "- [Recorded](recorded.md) — byte-identical transcript value\n";

// 生产破坏点：提前创建 device/engine、ready 时重复 init、pullOnStart false 仍同步、
// 启动索引进盘前冻结、resume 改用磁盘值、origin 被配置覆盖——每一项都有下面的真实磁盘断言接住。
describe.skipIf(!GIT)("index wiring — sync startup", { timeout: 60_000 }, () => {
	let s: Awaited<ReturnType<typeof setupSession>>;
	let remote: string;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
		const emptyGitConfig = join(s.cwd, "gitconfig-empty");
		await writeFile(emptyGitConfig, "", "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		remote = join(s.cwd, "remote.git");
		await git(["init", "--bare", "--quiet", remote]);
	});

	afterEach(async () => {
		await s.cleanup();
	});

	async function git(args: string[], cwd = s.cwd): Promise<string> {
		const { stdout } = await execFileP("git", args, { cwd, timeout: 15_000, encoding: "utf8" });
		return stdout.trim();
	}

	async function enableSync(over: Record<string, unknown> = {}): Promise<void> {
		await s.writeConfig({
			sync: {
				enabled: true,
				remote,
				branch: "main",
				pullOnStart: false,
				pushOnWrite: false,
				autoTimeoutMs: 10_000,
				timeoutMs: 10_000,
				...over,
			},
		});
	}

	function memoryConfig(over: Partial<SyncConfig> = {}): MemoryConfig {
		return {
			...DEFAULT_CONFIG,
			memoryDir: s.memoryDirRoot,
			sync: {
				...DEFAULT_CONFIG.sync,
				enabled: true,
				remote,
				pullOnStart: false,
				pushOnWrite: false,
				autoTimeoutMs: 10_000,
				timeoutMs: 10_000,
				...over,
			},
		};
	}

	function syncPaths() {
		const syncRoot = syncRootPath(resolve(s.memoryDirRoot));
		const projectKey = remoteProjectKey(gitIdentity(s.cwd).key);
		return { syncRoot, projectKey, manifest: manifestPath(syncRoot, projectKey) };
	}

	async function exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	async function remoteRevision(): Promise<string> {
		return git(["--git-dir", remote, "rev-parse", "refs/heads/main"]);
	}

	async function seedRemoteEntry(): Promise<void> {
		const root = join(s.cwd, "seed-memory-root");
		const projectDir = join(root, "seed-project");
		await mkdir(projectDir, { recursive: true });
		const config = { ...memoryConfig(), memoryDir: root };
		const store = new MemoryStore({
			memoryDir: projectDir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		await store.addEntry({ name: "Remote note", description: "from another device", body: "remote body" });
		const { runtime, errors } = await createPiSyncRuntime({
			config,
			store,
			projectDir,
			identity: gitIdentity(s.cwd),
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("seed runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`seed prepare failed: ${prepared.reason}`);
		expect((await prepared.engine.push(10_000)).ok).toBe(true);
		runtime.engine?.dispose();
		syncEvents.length = 0;
	}

	it("keeps the engine lazy, writes the fixed empty baseline after init, and repeats prepare without init", async () => {
		const config = memoryConfig();
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		const now = () => new Date("2026-11-15T01:02:03.000Z");
		const { runtime, errors } = await createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
			now,
		});

		expect(errors).toEqual([]);
		if (!runtime) throw new Error("runtime was not created");
		const paths = syncPaths();
		expect(runtime.engine).toBeNull();
		expect(await exists(devicePath(paths.syncRoot))).toBe(false);

		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		expect(prepared.engine).toBe(runtime.engine);
		expect(runtime.engine).not.toBeNull();
		expect(await readManifest(paths.manifest)).toEqual({
			version: 2,
			transport: syncTransport(remote, "main"),
			base: { revision: await remoteRevision(), syncedAt: "2026-11-15T01:02:03.000Z" },
			files: {},
		});

		syncEvents.length = 0;
		const again = await runtime.prepare(10_000);
		expect(again).toEqual({ ok: true, engine: runtime.engine });
		expect(syncEvents).toEqual([]);
		runtime.engine?.dispose();
	});

	it("re-preparation binds the empty baseline to the actual origin, not a drifted configured remote", async () => {
		const config = memoryConfig();
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		const first = await createPiSyncRuntime({ config, store, projectDir: s.dir, identity: gitIdentity(s.cwd) });
		if (!first.runtime) throw new Error("first runtime was not created");
		const prepared = await first.runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`first prepare failed: ${prepared.reason}`);
		first.runtime.dispose();
		const paths = syncPaths();
		await rm(paths.manifest);
		const drifted = {
			...config,
			sync: { ...config.sync, remote: join(s.cwd, "configured-but-not-origin.git") },
		};
		const second = await createPiSyncRuntime({ config: drifted, store, projectDir: s.dir, identity: gitIdentity(s.cwd) });
		if (!second.runtime) throw new Error("second runtime was not created");

		const reprepared = await second.runtime.prepare(10_000);
		if (!reprepared.ok) throw new Error(`second prepare failed: ${reprepared.reason}`);
		expect((await readManifest(paths.manifest))?.transport).toEqual(syncTransport(remote, "main"));
		second.runtime.dispose();
	});

	it("prepare resets a manifest whose transport differs from the actual origin before returning an engine", async () => {
		const config = memoryConfig();
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		const { runtime } = await createPiSyncRuntime({ config, store, projectDir: s.dir, identity: gitIdentity(s.cwd) });
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		const paths = syncPaths();
		const stale = {
			version: 2,
			transport: { remoteHash: "0".repeat(64), branch: "main" },
			base: { revision: await remoteRevision(), syncedAt: "2026-11-15T01:02:03.000Z" },
			files: {},
		};
		await writeFile(paths.manifest, JSON.stringify(stale), "utf8");

		const again = await runtime.prepare(10_000);
		if (!again.ok) throw new Error(`reprepare failed: ${again.reason}`);
		const reset = await readManifest(paths.manifest);
		expect(reset?.transport).toEqual(syncTransport(remote, "main"));
		expect(reset?.files).toEqual({});
		runtime.dispose();
	});

	it("shares one backend init between concurrent prepare calls and returns the same engine", async () => {
		const config = memoryConfig();
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		const { runtime, errors } = await createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("runtime was not created");
		let release!: () => void;
		syncInitBarrier.current = new Promise<void>((resolveBarrier) => {
			release = resolveBarrier;
		});

		const first = runtime.prepare(10_000);
		const second = runtime.prepare(10_000);
		await waitFor(() => syncEvents.includes("init:start"), "first prepare to reach init");
		// 旧实现的第二个调用也已越过 ready；屏障保证它看到的仍是未初始化状态。
		await flush();
		release();
		const [left, right] = await Promise.all([first, second]);

		expect(syncEvents.filter((entry) => entry === "init:start")).toHaveLength(1);
		if (!left.ok) throw new Error(`first prepare failed: ${left.reason}`);
		if (!right.ok) throw new Error(`second prepare failed: ${right.reason}`);
		expect(left.engine).toBe(right.engine);
		expect(left.engine).toBe(runtime.engine);
		runtime.engine?.dispose();
	});

	it("aborts a disposed runtime during init without later device creation or startup push", async () => {
		await enableSync({ pullOnStart: true });
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		let release!: () => void;
		syncInitBarrier.current = new Promise<void>((resolveBarrier) => {
			release = resolveBarrier;
		});

		const staleStarting = handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		await waitFor(() => syncEvents.includes("init:start"), "stale session to reach init");
		await enableSync({ enabled: false, pullOnStart: false });
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const initSignalAborted = syncInitSignals[0]?.aborted;
		release();
		await staleStarting;

		expect(await exists(devicePath(syncPaths().syncRoot))).toBe(false);
		expect(syncEvents).not.toContain("push:start");
		expect(initSignalAborted).toBe(true);
	});

	it("keeps a newer session healthy when a superseded init fails and resumes later", async () => {
		const staleRemote = join(s.cwd, "stale-missing", "remote.git");
		await enableSync({ remote: staleRemote, pullOnStart: true });
		const oldNotify = vi.fn();
		const oldSessionManager = { getEntries: () => [], getLeafId: () => null };
		const newSessionManager = { getEntries: () => [], getLeafId: () => null };
		const oldIndex = "- [Old](old.md) — stale session index\n";
		const newIndex = "- [New](new.md) — current session index\n";
		readRecordedMemoryIndexMock.mockImplementation((manager: unknown) =>
			manager === oldSessionManager ? oldIndex : newIndex,
		);
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		let release!: () => void;
		syncInitBarrier.current = new Promise<void>((resolveBarrier) => {
			release = resolveBarrier;
		});

		const staleStarting = handlers["session_start"][0](
			{ reason: "resume" },
			s.uiCtx({ sessionManager: oldSessionManager, ...uiWith(oldNotify) }),
		);
		await waitFor(() => syncEvents.includes("init:start"), "stale session to reach init");

		// 新会话使用另一棵记忆根与可达 remote；旧 init 仍被它自己已经捕获的屏障挡住。
		syncInitBarrier.current = null;
		const nextCwd = join(s.cwd, "next-project");
		const nextMemoryRoot = join(s.cwd, "next-memory");
		await mkdir(nextCwd, { recursive: true });
		await enableSync({ pullOnStart: true });
		await s.writeConfig({ memoryDir: nextMemoryRoot });
		const newCtx = s.uiCtx({ cwd: nextCwd, sessionManager: newSessionManager });
		await handlers["session_start"][0]({ reason: "resume" }, newCtx);
		release();
		await staleStarting;

		expect(oldNotify).not.toHaveBeenCalled();
		expect(syncEvents.filter((entry) => entry === "push:start")).toHaveLength(1);
		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, newCtx);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(newIndex);

		await tools[0].execute(
			"current-session-add",
			{ action: "add", name: "Current note", description: "current store", content: "body" },
			undefined,
			undefined,
			undefined,
		);
		expect(await exists(join(nextMemoryRoot, "next-project", "Current-note.md"))).toBe(true);
		expect(await exists(join(s.dir, "Current-note.md"))).toBe(false);

		const statusNotify = vi.fn();
		await commands["memory"].handler("", s.uiCtx({ cwd: nextCwd, ...uiWith(statusNotify) }));
		expect(statusNotify.mock.calls[0][0]).toContain(join(nextMemoryRoot, "next-project"));
		expect(statusNotify.mock.calls[0][0]).not.toContain("stale-missing");

		const pullNotify = vi.fn();
		await commands["memory"].handler("sync pull", s.uiCtx({ cwd: nextCwd, ...uiWith(pullNotify) }));
		expect(pullNotify.mock.calls.at(-1)?.[0]).toContain("Memory sync pull:");
		expect(pullNotify.mock.calls.at(-1)?.[0]).not.toContain("failed");
	});

	it("session_start automatically initializes a real bare remote without registering sync init", async () => {
		await enableSync({ pullOnStart: false });
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());

		const paths = syncPaths();
		expect(await exists(join(paths.syncRoot, "repo", ".git"))).toBe(true);
		expect(await exists(devicePath(paths.syncRoot))).toBe(true);
		expect((await readManifest(paths.manifest))?.files).toEqual({});
		expect((await readManifest(paths.manifest))?.base.revision).toBe(await remoteRevision());
		expect(commands["memory"]).toBeDefined();
		expect(commands["dream"]).toBeDefined();
		expect(commands["sync init"]).toBeUndefined();
		expect(commands["memory sync init"]).toBeUndefined();
		expect(syncEvents).not.toContain("push:start");
		expect(syncEvents).not.toContain("pull");
		expect(syncEvents).not.toContain("fetch");
	});

	it("accepts an empty configured remote after origin exists and never calls init again", async () => {
		await enableSync({ pullOnStart: false });
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));
		expect(notify).not.toHaveBeenCalled();

		await enableSync({ remote: "", pullOnStart: true });
		syncEvents.length = 0;
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));

		expect(notify).not.toHaveBeenCalled();
		expect(syncEvents).not.toContain("init:start");
		expect(syncEvents).toContain("push:start");
		expect(syncEvents).toContain("push:end");
	});

	/** 预算用例先做一次真初始化，之后只控制时钟：Windows 的 git 速度不再参与断言，也不会留下超时子进程。 */
	async function initializeForBudgetTest(): Promise<void> {
		const config = memoryConfig({ pullOnStart: true });
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		const { runtime, errors } = await createPiSyncRuntime({ config, store, projectDir: s.dir, identity: gitIdentity(s.cwd) });
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`budget fixture prepare failed: ${prepared.reason}`);
		runtime.dispose();
		syncEvents.length = 0;
		syncPushTimeouts.length = 0;
	}

	it("runtime.startup owns the automatic budget and delivers the baseline warning before pushing", async () => {
		const config = memoryConfig({ pullOnStart: true, autoTimeoutMs: 1_000 });
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		await store.addEntry({ name: "Existing local memory", description: "local before first sync", body: "keep me" });
		const { runtime, errors } = await createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("runtime was not created");
		const warnings: string[] = [];
		const start = 1_700_000_000_000;
		// 第一次 Date.now 给启动的 autoTimeoutMs deadline；此后一律 +400，剩余预算必须恰好是 600。
		const clock = vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 400);
		const outcome = await runtime
			.startup((warning) => {
				warnings.push(warning);
				syncEvents.push("startup-warning");
			})
			.finally(() => clock.mockRestore());
		runtime.dispose();

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(`startup failed: ${outcome.reason}`);
		expect(outcome.value).not.toBeNull();
		expect(syncPushTimeouts).toEqual([600]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("deterministic conflict copies");
		expect(syncEvents.indexOf("startup-warning")).toBeGreaterThanOrEqual(0);
		expect(syncEvents.indexOf("startup-warning")).toBeLessThan(syncEvents.indexOf("push:start"));
		expect(outcome.warning).toContain("deterministic conflict copies");
	});

	it("prepare and startup push share one automatic deadline", async () => {
		await enableSync({ pullOnStart: true, autoTimeoutMs: 1_000 });
		await initializeForBudgetTest();
		const start = 1_700_000_000_000;
		// 第一次用于 startupDeadline；之后 prepare 已结束，剩余预算必须是 600，而不是重新给 1000。
		const clock = vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 400);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		try {
			await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		} finally {
			clock.mockRestore();
		}

		expect(syncPushTimeouts).toEqual([600]);
	});

	it("an exhausted prepare budget skips startup push with a nonfatal next-round reason", async () => {
		await enableSync({ pullOnStart: true, autoTimeoutMs: 300 });
		await initializeForBudgetTest();
		const start = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 400);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		try {
			await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));
		} finally {
			clock.mockRestore();
		}

		expect(syncPushTimeouts).toEqual([]);
		expect(notify.mock.calls[0]?.[0]).toMatch(/startup budget.*next round/i);
		// 预算用尽只是「下一轮再推」，不是失败：必须走 info 预告通道，不得渲染成红色 Error。
		expect(notify.mock.calls[0]?.[1]).toBe("info");
		expect(notify.mock.calls[0][0]).toContain("pi-memory sync notice:");
		expect(notify.mock.calls[0][0]).not.toContain("pi-memory sync error:");
	});

	it("records only the exhausted startup budget after an earlier first-baseline preview", async () => {
		// autoTimeoutMs 同时是首次 init 的真实子进程总预算；Windows 上 git init/clone 可能远超 300ms。
		// 这里给足时间，只用注入时钟把 deadline 推过去 —— 预算断言不该依赖文件系统或 git 的速度。
		const config = memoryConfig({ pullOnStart: true, autoTimeoutMs: 30_000 });
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		await store.addEntry({ name: "Existing local memory", description: "local before first sync", body: "keep me" });
		await enableSync({ pullOnStart: true, autoTimeoutMs: 30_000 });
		const start = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 60_000);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		try {
			await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));
		} finally {
			clock.mockRestore();
		}

		expect(syncPushTimeouts).toEqual([]);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[0][0]).toContain("deterministic conflict copies");
		expect(notify.mock.calls[0][1]).toBe("info");
		// 预告已经即时通知过：预算用尽只补新增那一句，不能把同一条预告再报一遍。
		expect(notify.mock.calls[1][0]).toContain("startup budget");
		expect(notify.mock.calls[1][0]).toContain("next round");
		expect(notify.mock.calls[1][0]).not.toContain("deterministic conflict copies");
		expect(notify.mock.calls[1][1]).toBe("info");
	});

	it("does not initialize a local project and reports non-git sync as a notice, not an error", async () => {
		projectIdentityMock.mockResolvedValueOnce({ kind: "local", key: s.cwd });
		await enableSync();
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, s.uiCtx(uiWith(notify)));

		expect(tools).toHaveLength(1);
		expect(notify).toHaveBeenCalledTimes(1);
		// 非 git 项目是环境降级，不是失败：必须走 info 预告通道，不得渲染成红色 Error。
		expect(notify.mock.calls[0][1]).toBe("info");
		expect(notify.mock.calls[0][0]).toContain("pi-memory sync notice:");
		expect(notify.mock.calls[0][0]).not.toContain("pi-memory sync error:");
		expect(notify.mock.calls[0][0]).toContain("v1 only supports git projects");
		expect(await exists(syncRootPath(resolve(s.memoryDirRoot)))).toBe(false);
		notify.mockClear();
		await commands["memory"].handler("", s.uiCtx(uiWith(notify)));
		expect(notify.mock.calls[0][1]).toBe("info");
		expect(notify.mock.calls[0][0]).toContain("Sync notice:");
		expect(notify.mock.calls[0][0]).toContain("v1 only supports git projects");
		expect(notify.mock.calls[0][0]).toContain(`Dir: ${s.dir}`);
	});

	it("keeps memory usable after an unreachable remote and recovers through the same runtime on sync pull", async () => {
		const missingRemote = join(s.cwd, "not-there", "remote.git");
		await enableSync({ remote: missingRemote, pullOnStart: true, autoTimeoutMs: 1_000 });
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await expect(handlers["session_start"][0]({}, s.uiCtx(uiWith(notify)))).resolves.toBeUndefined();
		expect(tools).toHaveLength(1);
		expect(notify.mock.calls[0][0]).toContain("pi-memory sync error:");
		expect(notify.mock.calls[0][0]).not.toContain("pi-memory config error:");
		expect(await exists(devicePath(syncPaths().syncRoot))).toBe(false);

		await tools[0].execute(
			"offline-add",
			{ action: "add", name: "Offline memory", description: "still works", content: "local body" },
			undefined,
			undefined,
			undefined,
		);
		const listed = await tools[0].execute("offline-list", { action: "list" }, undefined, undefined, undefined);
		expect(listed.content[0].text).toContain("Offline memory");

		await git(["init", "--bare", "--quiet", missingRemote]);
		notify.mockClear();
		syncEvents.length = 0;
		await commands["memory"].handler("sync pull", s.uiCtx(uiWith(notify)));

		expect(syncEvents).toContain("init:start");
		expect(syncEvents).toContain("pull");
		expect(syncEvents).not.toContain("push:start");
		expect(await exists(devicePath(syncPaths().syncRoot))).toBe(true);
		expect(notify.mock.calls[0]?.[0]).toContain("Memory sync pull preparation");
		expect(notify.mock.calls[0]?.[0]).toContain("deterministic conflict copies");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Memory sync pull");
	});

	it("disposes the pending engine when reading the conflict preview fails", async () => {
		const config = memoryConfig();
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		vi.spyOn(store, "listEntries").mockRejectedValue(new Error("preview read failed"));
		const { runtime } = await createPiSyncRuntime({ config, store, projectDir: s.dir, identity: gitIdentity(s.cwd) });
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);

		expect(prepared.ok).toBe(false);
		expect(prepared.ok ? "" : prepared.reason).toContain("preview read failed");
		expect(syncEngines.length).toBeGreaterThan(0);
		expect(syncEvents.filter((event) => event === "dispose")).toHaveLength(1);
		expect(runtime.engine).toBeNull();
		runtime.dispose();
	});

	it("previews possible conflict copies before the first startup push, and only once per baseline", async () => {
		const config = memoryConfig({ pullOnStart: true });
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		await store.addEntry({ name: "Existing local memory", description: "local before first sync", body: "keep me" });
		await enableSync({ pullOnStart: true });
		const notify = vi.fn((_message: string, _type?: string) => syncEvents.push("conflict-preview"));
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("deterministic conflict copies");
		// 预告不是故障：info 级 + 独立前缀，不能借用 error 通道（否则宿主渲染成 `Error:`）。
		expect(notify.mock.calls[0][1]).toBe("info");
		expect(notify.mock.calls[0][0]).toContain("pi-memory sync notice:");
		expect(notify.mock.calls[0][0]).not.toContain("pi-memory sync error:");
		expect(syncEvents.indexOf("conflict-preview")).toBeGreaterThanOrEqual(0);
		expect(syncEvents.indexOf("conflict-preview")).toBeLessThan(syncEvents.indexOf("push:start"));

		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("after an early preview reports only the new startup failure without repeating the preview", async () => {
		const config = memoryConfig({ pullOnStart: true });
		const store = new MemoryStore({
			memoryDir: s.dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
		await store.addEntry({ name: "Existing local memory", description: "local before first sync", body: "keep me" });
		await enableSync({ pullOnStart: true });
		const register = syncEngines.push.bind(syncEngines);
		const registration = vi.spyOn(syncEngines, "push").mockImplementation((engine) => {
			const result = register(engine);
			vi.spyOn(engine, "push").mockRejectedValue(new Error("startup push failed"));
			return result;
		});
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		try {
			await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));
		} finally {
			registration.mockRestore();
		}

		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[0][0]).toContain("deterministic conflict copies");
		expect(notify.mock.calls[0][1]).toBe("info");
		expect(notify.mock.calls[0][0]).toContain("pi-memory sync notice:");
		expect(notify.mock.calls[1][0]).toContain("startup push failed");
		expect(notify.mock.calls[1][1]).toBe("error");
		expect(notify.mock.calls[1][0]).not.toContain("deterministic conflict copies");
	});

	it("warns once about configured remote drift but keeps publishing to origin", async () => {
		await enableSync({ pullOnStart: false });
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx(uiWith(notify)));
		await tools[0].execute(
			"origin-add",
			{ action: "add", name: "Origin entry", description: "origin wins", content: "body" },
			undefined,
			undefined,
			undefined,
		);
		const otherRemote = join(s.cwd, "other.git");
		await git(["init", "--bare", "--quiet", otherRemote]);

		await enableSync({ remote: otherRemote, pullOnStart: true });
		notify.mockClear();
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toContain("origin");
		const prefix = `git/${remoteProjectKey(gitIdentity(s.cwd).key)}`;
		const tree = await git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]);
		expect(tree.split("\n")).toContain(`${prefix}/Origin-entry.md`);
		expect(await git(["ls-remote", otherRemote])).toBe("");
	});

	it("pullOnStart false prepares only and leaves both disk and the frozen index untouched", async () => {
		await seedRemoteEntry();
		await enableSync({ pullOnStart: false });
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, s.uiCtx());

		expect(await exists(join(s.dir, "Remote-note.md"))).toBe(false);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
		expect(syncEvents).not.toContain("push:start");
		expect(syncEvents).not.toContain("pull");
		expect(syncEvents).not.toContain("flush");
		expect(syncEvents).not.toContain("fetch");
	});

	it.each([
		{ reason: "startup", recorded: false },
		{ reason: "new", recorded: false },
		{ reason: "resume", recorded: true },
		{ reason: "fork", recorded: true },
		{ reason: "reload", recorded: true },
	])("$reason converges before choosing the index and preserves the required source", async ({ reason, recorded }) => {
		await seedRemoteEntry();
		await enableSync({ pullOnStart: true });
		readRecordedMemoryIndexMock.mockReturnValue(RECORDED_INDEX);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({ reason }, s.uiCtx());
		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, s.uiCtx());

		expect(await readFile(join(s.dir, "Remote-note.md"), "utf8")).toContain("remote body");
		expect(await readFile(join(s.dir, "MEMORY.md"), "utf8")).toContain("Remote note");
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(
			recorded ? RECORDED_INDEX : await readFile(join(s.dir, "MEMORY.md"), "utf8"),
		);
		expect(syncEvents.filter((entry) => entry === "push:start")).toHaveLength(1);
		expect(syncEvents).not.toContain("pull");
		expect(syncEvents).not.toContain("flush");
		const indexEvent = recorded ? "recorded-index" : "index";
		expect(syncEvents.indexOf(indexEvent)).toBeGreaterThan(syncEvents.indexOf("push:end"));
		if (recorded) expect(readRecordedMemoryIndexMock).toHaveBeenCalledTimes(1);
		else expect(readRecordedMemoryIndexMock).not.toHaveBeenCalled();
	});

	it("uses sync-phase context snapshots when the session is disposed during startup push", async () => {
		await enableSync({ pullOnStart: true });
		readRecordedMemoryIndexMock.mockReturnValue(RECORDED_INDEX);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		let active = true;
		const sessionManager = { getEntries: () => [], getLeafId: () => null };
		const ui = { notify: vi.fn(), confirm: vi.fn(), setStatus: vi.fn() };
		const ctx = s.uiCtx({ sessionManager });
		const guard = <T>(value: T): T => {
			if (!active) throw new Error("Extension instance is no longer active");
			return value;
		};
		Object.defineProperties(ctx, {
			hasUI: { get: () => guard(true) },
			ui: { get: () => guard(ui) },
			sessionManager: { get: () => guard(sessionManager) },
		});
		let release!: () => void;
		syncPushBarrier.current = new Promise<void>((resolveBarrier) => {
			release = resolveBarrier;
		});

		const starting = handlers["session_start"][0]({ reason: "resume" }, ctx);
		await waitFor(() => syncEvents.includes("push:start"), "startup push to begin");
		active = false;
		release();

		await expect(starting).resolves.toBeUndefined();
		expect(readRecordedMemoryIndexMock).toHaveBeenCalledWith(sessionManager);
		syncPushBarrier.current = null;
	});

	it("rejects same-remote coexistence before device/clone writes and redacts credentials in the nonfatal notice", async () => {
		const credentialed = "https://user:s3cr3t@example.invalid/org/memory.git";
		await git(["init", "--quiet", s.memoryDirRoot]);
		await git(["remote", "add", "origin", credentialed], s.memoryDirRoot);
		await enableSync({ remote: credentialed, pullOnStart: false });
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, s.uiCtx(uiWith(notify)));

		expect(tools).toHaveLength(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("pi-memory sync error:");
		expect(notify.mock.calls[0][0]).toContain("***");
		expect(notify.mock.calls[0][0]).not.toContain("s3cr3t");
		expect(await exists(devicePath(syncPaths().syncRoot))).toBe(false);
		expect(await exists(join(syncPaths().syncRoot, "repo"))).toBe(false);
	});
});
