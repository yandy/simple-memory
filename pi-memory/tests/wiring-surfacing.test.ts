/**
 * index wiring — auto-surfacing（prefetch 语义）
 *
 * 侧查询在 `before_agent_start` 里**启动**、不 await、也不在那一轮注入；召回块只在
 * 「本轮还有后续请求」的 `turn_end` 边界持久化一次（spec §5.2）。零工具调用的单请求轮
 * 刻意作废：不持久化、不标去重。
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, customTriggerEvent, DISK_INDEX, disposableCtx, flush, resetWiringMocks, runTaskMock, scanEntriesMock, sectionsEvent, setupSession, uiWith, waitFor } from "./helpers/wiring-harness";
import memoryFactory from "../index";

const RECALL = "<relevant_memories>\n## SSH\nx\n\n## DB\ny\n</relevant_memories>";

function entry(file: string, description = "d") {
	return { file, name: file.replace(/\.md$/, ""), description, type: "project", modified: "2026-01-01T00:00:00.000Z" };
}

/**
 * `turn_end` 的宿主事件（pi >= 1.5.0 的形状）：`entries` 是**当前**边界提案，handler 返回的
 * `entries` 完整替换它 —— 所以断言里必须能看到原提案还在。
 */
function turnEndEvent(over: Record<string, unknown> = {}) {
	return {
		type: "turn_end",
		turnIndex: 1,
		message: { role: "assistant", content: "checking memory" },
		toolResults: [{ role: "toolResult", toolCallId: "call-1" }],
		messageEntryId: "entry-assistant",
		toolResultEntryIds: ["entry-tool"],
		outcome: "completed",
		entries: [] as unknown[],
		continue: false,
		context: {},
		...over,
	};
}

const recallEntry = { type: "custom_message", customType: "memory-auto-surfacing", content: RECALL, display: false };

describe("index wiring — auto-surfacing", () => {
	let s: Awaited<ReturnType<typeof setupSession>>;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
	});

	afterEach(async () => {
		await s.cleanup();
	});

	/**
	 * prefetch 的 async 链（scanEntries → runTask → 写 pending）全是立即 resolve 的 mock：
	 * 一次 `flush()` 就排空。带 UI 的用例再用 `setStatus` 的收尾（`"surfacing"` → undefined）
	 * 等一次 —— 将来链上多一个 await 也不会假绿。
	 */
	async function flushPrefetch(setStatus?: ReturnType<typeof vi.fn>): Promise<void> {
		await flush();
		if (!setStatus) return;
		await waitFor(
			() => setStatus.mock.calls.some((call: unknown[]) => call[0] === "surfacing" && call[1] === undefined),
			"surfacing prefetch to settle",
		);
	}

	/** 带 notify / setStatus 观察点的 UI ctx（`uiWith` 的两个 spy 要能被用例直接断言）。 */
	function spyUi() {
		const notify = vi.fn();
		const setStatus = vi.fn();
		return { notify, setStatus, ctx: s.uiCtx({ ...uiWith(notify), ui: { notify, confirm: vi.fn(), setStatus } }) };
	}

	it("returns immediately without waiting for the side query", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		let resolveRun: ((value: { files: string[]; content: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<{ files: string[]; content: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);

		let returned = false;
		const pending = Promise.resolve(handlers["before_agent_start"][0](sectionsEvent("ssh?"), s.uiCtx())).then(
			(value) => {
				returned = true;
				return value;
			},
		);
		await flush();
		// 侧查询还挂着，本轮就已经返回：宿主不会看到任何需要等的东西。
		expect(returned).toBe(true);
		const result = await pending;
		expect(result?.message).toBeUndefined();
		expect(result).toEqual({});
		// 约定：not 等到 runTask 才有了可断言的东西，这条也顺手钉住「确实启动了」。
		expect(resolveRun).toBeDefined();

		resolveRun?.({ files: ["ssh.md", "db.md"], content: RECALL });
		await flush();
		const boundary = await handlers["turn_end"][0](turnEndEvent(), s.uiCtx());
		expect(boundary.entries.at(-1)).toEqual(recallEntry);
	});

	it("persists the recall at the turn boundary and marks the injected files", async () => {
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md"), entry("db.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md", "db.md"], content: RECALL });

		// `injectedFiles` 是活 Set：断言必须在调用瞬间深拷贝。
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md", "db.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		const existing = { type: "custom", customType: "other-extension", data: {} };
		const boundary = await handlers["turn_end"][0](turnEndEvent({ entries: [existing] }), ctx);

		// entries 是**完整替换提案**：原提案必须在，召回块追加在其后。
		expect(boundary.entries).toEqual([existing, recallEntry]);
		// 持久化后持久化点的 notify 才出现（本轮第一次请求不通知）。
		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
		// 工具结果自然引发下一请求：不声明 continue，不制造额外请求。
		expect(boundary.continue).toBeUndefined();
		expect(injectedAtCall).toEqual([new Set()]);

		// 下一轮：去重标记已生效（已持久化的文件不再浮现）。
		await handlers["before_agent_start"][0](sectionsEvent("and db?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall[1]).toEqual(new Set(["ssh.md", "db.md"]));
	});

	it("keeps the recalled block at one fixed position across the following requests", async () => {
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md"), entry("db.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md", "db.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		const persisted = boundary.entries.at(-1);

		// 宿主视角：turn_end 的 entries 追加在本 turn 的 assistant / tool-result 之后。
		const history = [
			{ role: "user", content: "how do I debug SSH?" },
			{ role: "assistant", content: "checking memory" },
			{ role: "toolResult", content: "ssh.md" },
		];
		const firstRequest = [...history]; // 本轮第一次请求：侧查询还没进上下文
		const nextRequest = [...history, persisted]; // 持久化后的下一个请求
		const laterRequest = [...nextRequest, { role: "assistant", content: "use 2222" }];

		// 召回块之前的序列与「未注入」时逐元素相等（prefix cache 的公共前缀不受影响）。
		expect(firstRequest).toEqual(history);
		expect(nextRequest.slice(0, history.length)).toEqual(firstRequest);
		// 只出现一次，且位置固定。
		const recalls = laterRequest.filter((m) => (m as { customType?: string }).customType === "memory-auto-surfacing");
		expect(recalls).toHaveLength(1);
		expect(laterRequest.indexOf(persisted)).toBe(nextRequest.indexOf(persisted));
	});

	it("drops the recall on a turn with no tool results", async () => {
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		// 零工具调用的单请求轮：本轮之后没有请求，召回作废（不持久化、不标去重）。
		const boundary = await handlers["turn_end"][0](turnEndEvent({ toolResults: [] }), ctx);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 作废不标去重：下一轮同一文件仍可浮现。
		await handlers["before_agent_start"][0](sectionsEvent("ssh again?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall[1]).toEqual(new Set());
	});

	it("does not persist a recall from an aborted turn", async () => {
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		for (const outcome of ["aborted", "error"]) {
			const boundary = await handlers["turn_end"][0](turnEndEvent({ outcome }), ctx);
			expect(boundary).toBeUndefined();
		}
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not persist a recall that has not settled yet", async () => {
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		let resolveRun: ((value: { files: string[]; content: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<{ files: string[]; content: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flush();

		// 侧查询还在飞：这个边界什么都不带（永不阻塞、也永不半截注入）。
		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 同一轮的下一个边界赶上了：才持久化。
		resolveRun?.({ files: ["ssh.md"], content: RECALL });
		await flushPrefetch(setStatus);
		const later = await handlers["turn_end"][0](turnEndEvent({ turnIndex: 2 }), ctx);
		expect(later.entries.at(-1)).toEqual(recallEntry);
		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
	});

	it("discards the pending recall when a new run starts", async () => {
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		let resolveRun: ((value: { files: string[]; content: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<{ files: string[]; content: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		// custom run（pi.sendMessage(..., { triggerTurn: true })）：检索不了，也不能把上一轮的
		// 结果接过来 —— 旧 prompt 的召回属于已经作废的那一轮。
		runTaskMock.mockClear();
		await handlers["before_agent_start"][0](customTriggerEvent(), ctx);
		expect(runTaskMock).not.toHaveBeenCalled();

		resolveRun?.({ files: ["ssh.md"], content: RECALL });
		await flushPrefetch(setStatus);
		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("never appends the same recall twice", async () => {
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		const first = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(first.entries).toHaveLength(1);
		// 第二个边界（同一轮的下一次工具调用之后）：pending 已清，不重复追加。
		const second = await handlers["turn_end"][0](turnEndEvent({ turnIndex: 2 }), ctx);
		expect(second).toBeUndefined();
	});

	it("stays quiet about Recalled when headless or when nothing was rendered", async () => {
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: "" });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		// 渲染为空：不注入、不标去重、不通知。
		expect(await handlers["turn_end"][0](turnEndEvent(), ctx)).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// headless：召回照常持久化，但不通知。
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });
		const headless = s.uiCtx({ hasUI: false, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), headless);
		await flush();
		const boundary = await handlers["turn_end"][0](turnEndEvent(), headless);
		expect(boundary.entries.at(-1)).toEqual(recallEntry);
		expect(notify).not.toHaveBeenCalled();
	});

	it("writes the memory_index section before the prefetch can be disturbed", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		let resolveRun: ((value: { files: string[]; content: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise<{ files: string[]; content: string }>((resolve) => {
					resolveRun = resolve;
				}),
		);

		const session = disposableCtx(s.cwd);
		const event = sectionsEvent("ssh?");
		// section 必须在**任何 await 之前**就已写好：宿主收到 { memory_index: null } 就把索引段
		// 删掉了（spec §9.1 的 null 陷阱）。
		await handlers["before_agent_start"][0](event, session.ctx);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);

		// session 在侧查询途中 dispose：prefetch 的收尾（setStatus）不能再回读已失效的 ctx。
		session.dispose();
		resolveRun?.({ files: ["ssh.md"], content: RECALL });
		await flush();
		await flush();
		expect(session.notify).not.toHaveBeenCalled();

		// 下一轮（新 ctx）仍喂回冻结值，逐字节不变。
		scanEntriesMock.mockResolvedValue([]);
		const next = sectionsEvent("again?");
		await handlers["before_agent_start"][0](next, s.uiCtx());
		await flush();
		expect(next.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("runs the side query through the store for main agents", async () => {
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md", "ssh config")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: "<relevant_memories>\n## SSH\nssh config\n</relevant_memories>" });

		const event = { ...sectionsEvent("how do I debug SSH?"), systemPrompt: "Normal system prompt" };
		await handlers["before_agent_start"][0](event, ctx);
		await flushPrefetch(setStatus);

		expect(scanEntriesMock).toHaveBeenCalledTimes(1);
		// 清单来自 store（不是逐文件 readFile）
		expect(typeof scanEntriesMock.mock.calls[0][0].readEntry).toBe("function");
		expect(runTaskMock).toHaveBeenCalledTimes(1);
		const input = runTaskMock.mock.calls[0][1];
		const taskCtx = runTaskMock.mock.calls[0][2];
		expect(input.manifest).toEqual([entry("ssh.md", "ssh config")]);
		expect(input.userPrompt).toBe("how do I debug SSH?");
		expect(input.injectedFiles).toBeInstanceOf(Set);
		expect(taskCtx.cwd).toBe(s.dir);
		expect(taskCtx.store).toBe(scanEntriesMock.mock.calls[0][0]);
		expect(typeof taskCtx.ports.headless.run).toBe("function");
		// 索引 section 与侧查询互不影响：section 每轮无条件写。
		expect(event.systemPromptOptions.sections["memory_index"]).toContain("- [SSH](ssh.md) — staging ssh config");
	});

	it("does not surface the same entry file twice in one session", async () => {
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		// `injectedFiles` 是活 Set，同一引用会在后续轮次被改写 —— 断言必须在调用瞬间深拷贝，
		// 否则「第二轮已含 ssh.md」是拿断言时的集合比它自己，永远成立。
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		await handlers["turn_end"][0](turnEndEvent(), ctx);

		// 第二轮：runTask 收到的 injectedFiles 里已经有 ssh.md（上一轮的持久化标记了它）
		await handlers["before_agent_start"][0](sectionsEvent("ssh again?"), ctx);
		await flushPrefetch(setStatus);

		expect(injectedAtCall).toHaveLength(2);
		expect(injectedAtCall[0]).toEqual(new Set());
		expect(injectedAtCall[1]).toEqual(new Set(["ssh.md"]));
	});

	it("counts files the main session tool read as already seen", async () => {
		const { setStatus, ctx } = spyUi();
		const { pi, handlers, tools } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		// 模型在会话里用 `memory` 工具读到了 ssh.md 的正文。
		await writeFile(
			join(s.dir, "ssh.md"),
			[
				"---",
				"name: SSH",
				"description: staging ssh",
				"type: project",
				"created: 2026-01-01",
				"modified: 2026-01-01",
				"---",
				"",
				"staging 的 SSH 用 2222 端口",
				"",
			].join("\n"),
			"utf8",
		);
		const read = await tools[0].execute("read-1", { action: "search", query: "SSH" }, undefined, undefined, s.uiCtx());
		expect(read.content[0].text).toContain("staging 的 SSH 用 2222 端口");

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		// 侧查询的输入里已经包含它：core 的 candidates() 会把这个文件过滤掉。
		expect(injectedAtCall).toEqual([new Set(["ssh.md"])]);
	});

	it("skips the side query for subagents", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);

		const event = {
			...sectionsEvent("how do I debug SSH?"),
			systemPrompt: 'sp\n\n<active_agent name="general-purpose"/>\n',
		};
		await handlers["before_agent_start"][0](event, s.uiCtx());
		await flush();

		expect(scanEntriesMock).not.toHaveBeenCalled();
		expect(runTaskMock).not.toHaveBeenCalled();
		expect(event.systemPromptOptions.sections["memory_index"]).toContain("- [SSH](ssh.md) — staging ssh config");
		// 没有 pending：边界不给任何东西。
		expect(await handlers["turn_end"][0](turnEndEvent(), s.uiCtx())).toBeUndefined();
	});

	it("skips the side query for custom-message runs but still writes the index section", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);

		// 1.2.0 起 `messageType: "custom"` 的 run（pi.sendMessage(..., { triggerTurn: true })）
		// 不带 `prompt`：没有用户输入可检索，就是不浮现 —— 而不是拿 message 内容去搜。
		const event = customTriggerEvent();
		await handlers["before_agent_start"][0](event, s.uiCtx());
		await flush();

		expect(scanEntriesMock).not.toHaveBeenCalled();
		expect(runTaskMock).not.toHaveBeenCalled();
		// 两条路径独立：section 无条件写（否则 pi 生成 { memory_index: null } 把索引删掉）。
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("passes the config object into runTask instead of pre-extracted budget values", async () => {
		await s.writeConfig({ autoSurfacing: { enabled: true, maxFiles: 7, thinkLevel: "low" } });
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("q"), ctx);
		await flushPrefetch(setStatus);

		const taskCtx = runTaskMock.mock.calls[0][2];
		expect(Object.keys(taskCtx).sort()).toEqual(["cfg", "cwd", "ports", "store"]);
		expect(taskCtx.cfg.autoSurfacing.maxFiles).toBe(7);
		expect(taskCtx.cfg.autoSurfacing.thinkLevel).toBe("low");
		// 输入只给宿主数据：预算值由 core 自己从 cfg 读。
		const input = runTaskMock.mock.calls[0][1];
		expect(Object.keys(input).sort()).toEqual(["injectedFiles", "manifest", "userPrompt"]);
	});
});
