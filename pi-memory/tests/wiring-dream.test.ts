/**
 * index wiring — dream
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureUnhandledRejections, createFakePi, createMemoryToolSpy, DISK_INDEX, dirOverrideRef, dirRef, disposableCtx, flush, mockConfigValue, resetWiringMocks, runTaskMock, scanEntriesMock, shouldNudgeMock, uiCtx, waitFor, writeDreamMetaMock } from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { loadConfig } from "../src/config";
import { DREAM_ACTIONS, TASKS } from "@yandy0725/memory-core";

describe("index wiring — dream", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-wiring-"));
		dirRef.current = dir;
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "MEMORY.md"), DISK_INDEX, "utf8");

		scanEntriesMock.mockReset();
		resetWiringMocks();

		// 模型 fixture：默认走 defaults.model；各用例按需覆盖 mockConfigValue 的 model 段
		mockConfigValue.defaults = { model: "test/model", sessionPersistence: { enabled: false } };
		mockConfigValue.dream.model = undefined;
		mockConfigValue.extractMemories.model = undefined;
		mockConfigValue.autoSurfacing.model = undefined;
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		delete (mockConfigValue.autoSurfacing as any).sessionPersistence;
		mockConfigValue.autoSurfacing.maxFiles = 5;
		mockConfigValue.autoSurfacing.thinkLevel = "off";
		mockConfigValue.extractMemories.enabled = false;
		mockConfigValue.lock = { timeoutMs: 5000, snapshotKeep: 5 };
		dirOverrideRef.current = null;
	});

	// ── Review 修复轮（R47/R48/R49）：dream 两条链的 ctx 快照 / 定时器 / section 时机 ──
	it("settles the nudge dream without touching a disposed ctx", async () => {
		shouldNudgeMock.mockResolvedValue({ nudge: true, message: "💡 dream", sessions: 7, newEntries: 7 });
		let resolveDream: ((summary: string) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					resolveDream = resolve;
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		session.ctx.ui.confirm.mockResolvedValue(true);
		const caught = await captureUnhandledRejections(async () => {
			await handlers["session_start"][0]({}, session.ctx);
			// dream 是长时后台任务（600s timeout），用户先 /new 了：链 settle 时 ctx 已失效
			session.dispose();
			resolveDream?.("consolidated");
			await flush();
		});

		expect(caught).toEqual([]);
		// UI 来自同步段快照：dispose 之后链仍然能通知（通过快照对象，而不是 ctx 代理）
		expect(session.notify).toHaveBeenCalledWith("consolidated", "info");
	});

	// Plan E/next #11：nudge 链的失败分支也要盖到 —— rejected 的值不一定是 Error
	//（pi 的模型层可能抛字符串），`dreamFailureMessage` 必须用 `String(e)` 渲染。
	it("renders a non-Error nudge dream failure with String(e)", async () => {
		shouldNudgeMock.mockResolvedValue({ nudge: true, message: "💡 dream", sessions: 7, newEntries: 7 });
		let rejectDream: ((reason?: unknown) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectDream = reject;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0](
			{},
			uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn().mockResolvedValue(true), setStatus: vi.fn() } }),
		);
		rejectDream?.("model exploded");
		await flush();

		expect(notify).toHaveBeenCalledWith("Dream failed: model exploded", "error");
	});

	it("settles /dream without touching a disposed ctx", async () => {
		let resolveDream: ((summary: string) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					resolveDream = resolve;
				}),
		);
		const { pi, handlers, commands } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		session.ctx.ui.confirm.mockResolvedValue(true);
		// 完成回调里的 `SessionManager.list(cwd)` 会去 getAgentDir() 下建会话目录：
		// 按 docs/guides/testing.md 隔离到本用例的 temp dir（并行/沙箱下不得碰真实 ~/.pi）。
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		try {
			const caught = await captureUnhandledRejections(async () => {
				await commands["dream"].handler("", session.ctx);
				session.dispose();
				resolveDream?.("consolidated");
				await waitFor(() => session.notify.mock.calls.length > 0, "dream completion notify");
			});

			expect(caught).toEqual([]);
			expect(session.notify).toHaveBeenCalledWith("consolidated", "info");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not reject unhandled when /dream fails after the session died", async () => {
		let rejectDream: ((reason?: unknown) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectDream = reject;
				}),
		);
		const { pi, handlers, commands } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		session.ctx.ui.confirm.mockResolvedValue(true);
		const caught = await captureUnhandledRejections(async () => {
			await commands["dream"].handler("", session.ctx);
			session.dispose();
			// rejected 的值不一定是 Error
			rejectDream?.("model exploded");
			await flush();
		});

		expect(caught).toEqual([]);
		expect(session.notify).toHaveBeenCalledWith("Dream failed: model exploded", "error");
	});

	// Plan E/next #11：success 分支里的 `writeDreamMeta` 自己抛错时，不能只走成功通知，
	// 也不能变成无人接管的 rejection（它已被 `track` 登记，但 `.finally` 不会接住）。
	it("/dream reports a failing writeDreamMeta instead of a success notification", async () => {
		writeDreamMetaMock.mockRejectedValueOnce(new Error("meta write failed"));
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		// 完成回调里的 `SessionManager.list(cwd)` 会碰 getAgentDir()：隔离到本用例的 temp dir。
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		try {
			const caught = await captureUnhandledRejections(async () => {
				await commands["dream"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));
				// 成功分支先 `SessionManager.list`（真实 I/O）再写 meta；meta 写失败也只在 I/O 之后才发通知。
				await waitFor(() => notify.mock.calls.length > 0, "dream meta-failure notify");
			});

			expect(caught).toEqual([]);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]).toEqual(["Dream failed: meta write failed", "error"]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("/dream hands the store, the line limit and the headless port to runTask", async () => {
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		// 成功回调里的 `SessionManager.list(cwd)` 会去 getAgentDir() 下建会话目录：
		// 按 docs/guides/testing.md 隔离到本用例的 temp dir（并行/沙箱下不得碰真实 ~/.pi）。
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		try {
			// 完成回调在 notify 之前 `await SessionManager.list(cwd)`，那是真实磁盘 I/O：把它固定拖慢到
			// 一个 setTimeout(0) tick 之上，这条断言就必须等条件成立，不能靠"猜一个 tick"。
			const listSpy = vi.spyOn(SessionManager, "list").mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return [];
			});
			try {
				await commands["dream"].handler("", uiCtx({ hasUI: true, ui: { confirm, notify, setStatus: vi.fn() } }));

				expect(runTaskMock).toHaveBeenCalledTimes(1);
				expect(runTaskMock.mock.calls[0][0]).toBe(TASKS.dream);
				const taskCtx = runTaskMock.mock.calls[0][2];
				expect(taskCtx.cwd).toBe(dir);
				expect(taskCtx.cfg.memIndexMaxLines).toBe(200);
				expect(typeof taskCtx.store.withLogicalLock).toBe("function");
				// 「7 个 action + memory 工具」由 core 的 TASKS.dream 决定；pi 只提供 headless 端口。
				expect(typeof taskCtx.ports.headless.run).toBe("function");

				// 成功回调（SessionManager.list → writeDreamMeta → notifyDream）必须在 unstub 前排空，
				// 否则会漏到真实 ~/.pi；notify 断言证明回调确实在本用例内跑完。
				await waitFor(() => notify.mock.calls.length > 0, "dream completion notify");
				expect(notify).toHaveBeenCalledWith("consolidated", "info");
			} finally {
				listSpy.mockRestore();
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("/dream refuses when memory was never initialized", async () => {
		const notify = vi.fn();
		const { pi, commands } = createFakePi();
		memoryFactory(pi as any);

		await commands["dream"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledWith("Memory not initialized.", "info");
		expect(runTaskMock).not.toHaveBeenCalled();
	});

	// `runTask` 是 async：缺模型不会在调用点同步抛，而是作为 rejection 走 `/dream` 的两参
	// `.then` 失败分支（报「Dream failed」），状态行由 `.finally` 兜底清除 —— 处理器本身照常 resolve。
	it("/dream does not leave the dream status behind when the model disappeared mid-session", async () => {
		const setStatus = vi.fn();
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		// 启动校验通过之后配置被改坏（loadConfig 的返回值是浅拷贝，改嵌套对象才能被会话内的
		// config 看到）：真实场景就是用户在会话中途删了 `defaults.model`。
		mockConfigValue.defaults.model = undefined;

		await expect(
			commands["dream"].handler("", uiCtx({ hasUI: true, ui: { notify, confirm, setStatus } })),
		).resolves.toBeUndefined();
		await flush();

		expect(setStatus).toHaveBeenCalledWith("dream", "Consolidating memory...");
		expect(setStatus).toHaveBeenCalledWith("dream", undefined);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			'Dream failed: no model for dream — set "dream.model" or "defaults.model" in memory.json',
			"error",
		);
	});

	it("the session_start nudge path passes the same dream arguments", async () => {
		shouldNudgeMock.mockResolvedValue({ nudge: true, message: "💡 dream", sessions: 7, newEntries: 7 });
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx({ hasUI: true, ui: { notify: vi.fn(), confirm, setStatus: vi.fn() } }));

		expect(confirm).toHaveBeenCalled();
		expect(runTaskMock).toHaveBeenCalledTimes(1);
		expect(runTaskMock.mock.calls[0][0]).toBe(TASKS.dream);
		expect(typeof runTaskMock.mock.calls[0][2].ports.headless.run).toBe("function");
	});

	// ── Plan C（spec §14 `/memory` 状态与 `/memory unlock`）─────────────────
	// D12 的注册范围是硬约束：dream 必须拿到 7 个 action（含 rename / rebuild_index），extract
	// 必须只拿到 5 个。core 钉「它请求了哪些 action」，pi 钉「toHeadlessToolOptions 会调
	// buildMemoryTool(spec)」—— 中间这条 `buildMemoryTool: (spec) => createMemoryTool(toolDeps, spec)`
	// 的闭包以前没人钉：把 spec 参数丢掉，全部套件照样绿，而 dream 会静默失去重构索引的能力。
	it("the dream port forwards the seven-action spec into createMemoryTool", async () => {
		// `/dream` 先要一次 confirm；再让 runTask 永不 resolve —— 本用例只观察端口闭包，
		// 不放成功回调出去（它会 `await SessionManager.list(cwd)`，那会碰真实 ~/.pi）。
		runTaskMock.mockImplementationOnce(() => new Promise(() => {}));
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		createMemoryToolSpy.mockClear();

		await commands["dream"].handler(
			"",
			uiCtx({ hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true), setStatus: vi.fn() } }),
		);

		expect(runTaskMock).toHaveBeenCalledTimes(1);
		const ports = runTaskMock.mock.calls[0][2].ports;
		// runTask 被 mock 掉了，端口从没被调用过：这里亲手调一次来观察那个闭包。
		// 模型不可解析，runHeadlessAgent 会在**建完工具之后**抛错 —— 那正是观察点。
		await expect(
			ports.headless.run({
				task: "t",
				cwd: dir,
				model: "nope/not-resolvable",
				builtinTools: "none",
				memoryTool: { actions: DREAM_ACTIONS, skipLogicalLock: true, skipSnapshot: true },
			}),
		).rejects.toThrow(/not resolvable/);

		const dreamCall = createMemoryToolSpy.mock.calls.find((c: any[]) => c[1]?.skipSnapshot === true);
		expect(dreamCall?.[1]).toEqual({
			actions: DREAM_ACTIONS,
			skipLogicalLock: true,
			skipSnapshot: true,
		});
		// 与主 agent 注册用的是同一份 deps（否则 /memory 的状态与工具看到的 store 会分家）
		expect(dreamCall?.[0]).toBe(createMemoryToolSpy.mock.calls[0][0]);
	});
});
