/**
 * index wiring — auto-surfacing
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, DISK_INDEX, disposableCtx, flush, resetWiringMocks, runTaskMock, scanEntriesMock, sectionsEvent, setupSession, uiCtx, uiWith } from "./helpers/wiring-harness";
import memoryFactory from "../index";


describe("index wiring — auto-surfacing", () => {
	let s: Awaited<ReturnType<typeof setupSession>>;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
	});

	afterEach(async () => {
		await s.cleanup();
	});

	it("notifies Recalled with the number of injected blocks", async () => {
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
			{ file: "db.md", name: "DB", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md", "db.md"], content: "<relevant_memories>\n## SSH\nx\n\n## DB\ny\n</relevant_memories>" });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), s.uiCtx(uiWith(notify)));

		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
	});

	it("stays quiet about Recalled when headless or when nothing was injected", async () => {
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: "" });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), s.uiCtx(uiWith(notify)));
		expect(notify).not.toHaveBeenCalled();

		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: "<relevant_memories>\n## SSH\nx\n</relevant_memories>" });
		await handlers["before_agent_start"][0](
			sectionsEvent("ssh?"),
			s.uiCtx({ hasUI: false, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }),
		);
		expect(notify).not.toHaveBeenCalled();
	});

	it("writes the memory_index section before auto-surfacing can abort the turn", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		let resolveRun: ((value: { files: string[]; content: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<{ files: string[]; content: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);

		const session = disposableCtx();
		const event = sectionsEvent("ssh?");
		// auto-surfacing 的 finally 在 await 之后读 ctx.hasUI：session 在途中 dispose 会让 handler
		// 从那里抛出。section 必须在**任何 await 之前**就已写好，否则宿主收到 { memory_index: null }
		// 就把索引段删掉了（spec §9.1 的 null 陷阱）。
		const handlerDone = handlers["before_agent_start"][0](event, session.ctx).catch(() => undefined);
		await flush();
		expect(resolveRun).toBeDefined();
		session.dispose();
		resolveRun?.({ files: ["ssh.md"], content: "<relevant_memories>\n## SSH\nx\n</relevant_memories>" });
		await handlerDone;

		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);

		// 下一轮（新 ctx）仍喂回冻结值，逐字节不变
		scanEntriesMock.mockResolvedValue([]);
		const next = sectionsEvent("again?");
		await handlers["before_agent_start"][0](next, s.uiCtx());
		expect(next.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("runs auto-surfacing through the store for main agents", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "ssh config", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: "<relevant_memories>\n## SSH\nssh config\n</relevant_memories>" });

		const result = await handlers["before_agent_start"][0](
			{ prompt: "how do I debug SSH?", systemPrompt: "Normal system prompt" },
			s.uiCtx(),
		);

		expect(scanEntriesMock).toHaveBeenCalledTimes(1);
		// 清单来自 store（不是逐文件 readFile）
		expect(typeof scanEntriesMock.mock.calls[0][0].readEntry).toBe("function");
		expect(runTaskMock).toHaveBeenCalledTimes(1);
		const input = runTaskMock.mock.calls[0][1];
		const taskCtx = runTaskMock.mock.calls[0][2];
		expect(input.manifest).toEqual([
			{ file: "ssh.md", name: "SSH", description: "ssh config", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		expect(input.userPrompt).toBe("how do I debug SSH?");
		expect(input.injectedFiles).toBeInstanceOf(Set);
		expect(taskCtx.cwd).toBe(s.dir);
		expect(taskCtx.store).toBe(scanEntriesMock.mock.calls[0][0]);
		expect(typeof taskCtx.ports.headless.run).toBe("function");
		expect(result?.message).toEqual({
			customType: "memory-auto-surfacing",
			content: "<relevant_memories>\n## SSH\nssh config\n</relevant_memories>",
			display: false,
		});
		expect(result?.systemPrompt).toContain("- [SSH](ssh.md) — staging ssh config");
	});

	it("does not surface the same entry file twice in one session", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		// Finding Minor 5：injectedFiles 是活 Set，同一引用会在后续轮次被改写 —— 断言必须在
		// 调用瞬间深拷贝，否则「第二轮已含 ssh.md」是拿断言时的集合比它自己，永远成立。
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: "<relevant_memories>x</relevant_memories>" };
		});

		const event = { prompt: "ssh?", systemPrompt: "sp" };
		await handlers["before_agent_start"][0](event, s.uiCtx());
		// 第二轮：runTask 收到的 injectedFiles 里已经有 ssh.md
		await handlers["before_agent_start"][0](event, s.uiCtx());

		expect(injectedAtCall).toHaveLength(2);
		expect(injectedAtCall[0]).toEqual(new Set());
		expect(injectedAtCall[1]).toEqual(new Set(["ssh.md"]));
	});

	it("skips auto-surfacing for subagents", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);

		const result = await handlers["before_agent_start"][0](
			{
				prompt: "how do I debug SSH?",
				systemPrompt: 'sp\n\n<active_agent name="general-purpose"/>\n',
			},
			s.uiCtx(),
		);

		expect(scanEntriesMock).not.toHaveBeenCalled();
		expect(runTaskMock).not.toHaveBeenCalled();
		expect(result?.systemPrompt).toContain("- [SSH](ssh.md) — staging ssh config");
	});

	it("passes the config object into runTask instead of pre-extracted budget values", async () => {
		await s.writeConfig({ autoSurfacing: { enabled: true, maxFiles: 7, thinkLevel: "low" } });
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: "<relevant_memories>x</relevant_memories>" });

		await handlers["before_agent_start"][0]({ prompt: "q", systemPrompt: "sp" }, s.uiCtx());

		const taskCtx = runTaskMock.mock.calls[0][2];
		expect(Object.keys(taskCtx).sort()).toEqual(["cfg", "cwd", "ports", "store"]);
		expect(taskCtx.cfg.autoSurfacing.maxFiles).toBe(7);
		expect(taskCtx.cfg.autoSurfacing.thinkLevel).toBe("low");
		// 输入只给宿主数据：预算值由 core 自己从 cfg 读。
		const input = runTaskMock.mock.calls[0][1];
		expect(Object.keys(input).sort()).toEqual(["injectedFiles", "manifest", "userPrompt"]);
	});
});
