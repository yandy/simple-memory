/**
 * index wiring — agent_end / extract
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakModelConfig, captureUnhandledRejections, createFakePi, createMemoryToolSpy, DISK_INDEX, dirOverrideRef, dirRef, disposableCtx, flush, mockConfigValue, resetWiringMocks, restoreModelConfig, runTaskMock, scanEntriesMock, uiCtx, uiWith } from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { MAIN_AGENT_ACTIONS, TASKS } from "@yandy0725/memory-core";

describe("index wiring — agent_end / extract", () => {
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

	it.each([
		{ writes: 1, message: "Extracted 1 memory." },
		{ writes: 2, message: "Extracted 2 memories." },
	])("agent_end reports $writes write(s) as '$message'", async ({ writes, message }) => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));

		// customTools[0] 就是传给 extract 的真工具：直接跑它，onWrite 就是唯一的计数通道
		const onWrite = runTaskMock.mock.calls[0][1].onWrite;
		for (let i = 0; i < writes; i++) onWrite({ action: "add", name: `A${i}` });
		// index.ts 的 onWrite 是纯计数器（任何回调都 +1）；「list/stdout 这类读 action 不计数」是 core 的
		// 规则，由 memory-core/tests/memory-handler.test.ts 钉住，这里不重复钉。
		await flush();
		expect(notify).not.toHaveBeenCalled();

		resolveExtract?.({ skipped: false, result: "ok" });
		await flush();

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(message, "info");
	});

	it("agent_end stays quiet when extract wrote nothing or was skipped", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		runTaskMock.mockResolvedValueOnce({ skipped: false, result: "nothing to save" });
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
		await flush();

		runTaskMock.mockResolvedValueOnce({ skipped: true });
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
		await flush();

		expect(notify).not.toHaveBeenCalled();
	});

	it("agent_end never notifies a headless session", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const headless = () =>
			uiCtx({ hasUI: false, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });

		// 阶段一：成功也不通知
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, headless());
		const onWrite = runTaskMock.mock.calls[0][1].onWrite;
		onWrite({ action: "add", name: "A" });
		resolveExtract?.({ skipped: false, result: "ok" });
		await flush();
		expect(notify).not.toHaveBeenCalled();

		// 阶段二：失败也不通知
		runTaskMock.mockImplementationOnce(() => Promise.reject(new Error("model exploded")));
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, headless());
		await flush();
		expect(notify).not.toHaveBeenCalled();
	});

	it("reports an extract failure once per session and resets the quota on session_start", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runTaskMock.mockImplementation(() => Promise.reject(new Error("model exploded")));
		const notify = vi.fn();
		const ui = uiWith(notify);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const failed = () => notify.mock.calls.filter((call) => String(call[0]).startsWith("Extract failed:"));

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, uiCtx(ui));
		await flush();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "b" }] }, uiCtx(ui));
		await flush();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "c" }] }, uiCtx(ui));
		await flush();

		expect(failed()).toEqual([["Extract failed: model exploded", "error"]]);

		// 新 session 重新给一次配额
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "d" }] }, uiCtx(ui));
		await flush();

		expect(failed()).toHaveLength(2);
	});

	it("delivers 'Extracted' from the sync UI snapshot when the session dies mid-extract", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		const caught = await captureUnhandledRejections(async () => {
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, session.ctx);
			const onWrite = runTaskMock.mock.calls[0][1].onWrite;
			onWrite({ action: "add", name: "A" });

			// extract 还没回来，session 先被 /new（或退出宽限超时）销毁了
			session.dispose();
			resolveExtract?.({ skipped: false, result: "ok" });
			await flush();
		});

		expect(caught).toEqual([]);
		// UI 是同步段快照的：回调不再访问 ctx（否则这里会抛「no longer active」）
		expect(session.notify).toHaveBeenCalledWith("Extracted 1 memory.", "info");
	});

	it("does not reject unhandled when a failing extract settles after the session died", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let rejectExtract: ((reason?: unknown) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectExtract = reject;
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const session = disposableCtx();
		const caught = await captureUnhandledRejections(async () => {
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, session.ctx);
			session.dispose();
			rejectExtract?.(new Error("model exploded"));
			await flush();
		});

		expect(caught).toEqual([]);
	});

	it("does not misreport a throwing 'Extracted' notice as an extract failure", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let resolveExtract: ((value: { skipped: boolean; result?: string }) => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		const notify = vi.fn((_message: string, _type?: string): void => {
			throw new Error("UI is gone");
		});
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const caught = await captureUnhandledRejections(async () => {
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(notify)));
			const onWrite = runTaskMock.mock.calls[0][1].onWrite;
			onWrite({ action: "add", name: "A" });
			resolveExtract?.({ skipped: false, result: "ok" });
			await flush();
		});

		expect(caught).toEqual([]);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(String(notify.mock.calls[0][0])).not.toMatch(/^Extract failed:/);

		// 成功通知抛错不能烧掉失败通知配额：下一轮真失败仍然要报
		runTaskMock.mockImplementationOnce(() => Promise.reject(new Error("model exploded")));
		const okNotify = vi.fn();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx(uiWith(okNotify)));
		await flush();
		expect(okNotify).toHaveBeenCalledWith("Extract failed: model exploded", "error");
	});

	it("renders a non-Error rejection reason without 'undefined'", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runTaskMock.mockImplementationOnce(() => Promise.reject("model exploded"));
		const notify = vi.fn();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, uiCtx(uiWith(notify)));
		await flush();

		expect(notify).toHaveBeenCalledWith("Extract failed: model exploded", "error");
	});

	it("resets the extract failure quota across a misconfigured restart", async () => {
		mockConfigValue.extractMemories.enabled = true;
		runTaskMock.mockImplementation(() => Promise.reject(new Error("model exploded")));
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const firstNotify = vi.fn();
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "a" }] }, uiCtx(uiWith(firstNotify)));
		await flush();
		expect(firstNotify).toHaveBeenCalledWith("Extract failed: model exploded", "error");

		// 新 session 以配置错误启动（session_start 走到 failConfig 就返回）。这里钉住的是「失败配额
		// 按 session 重置」：去掉那次复位，第二个 session 就再也报不出失败通知。
		// （复位相对早退的**先后**在两态模型下不可观测：错误态没有 store，agent_end 到不了 extract。）
		breakModelConfig();
		try {
			await handlers["session_start"][0]({ reason: "reload" }, uiCtx());
			// 中途重新启用只有「改配置 + 重启」一条路，即再一次 session_start。
			// 错误态启动已清空 memoryDir/store，这里是真的重新初始化（resolveMemoryDir 的 mock
			// 仍返回同一个 dir）。
			restoreModelConfig();
			await handlers["session_start"][0]({ reason: "reload" }, uiCtx());

			const secondNotify = vi.fn();
			await handlers["agent_end"][0]({ messages: [{ role: "user", content: "b" }] }, uiCtx(uiWith(secondNotify)));
			await flush();
			expect(secondNotify).toHaveBeenCalledWith("Extract failed: model exploded", "error");
		} finally {
			restoreModelConfig();
		}
	});

	it("agent_end hands the raw messages, an onWrite counter and both ports to runTask", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		];
		await handlers["agent_end"][0]({ messages }, uiCtx());

		expect(runTaskMock).toHaveBeenCalledTimes(1);
		expect(runTaskMock.mock.calls[0][0]).toBe(TASKS.extractMemories);
		const input = runTaskMock.mock.calls[0][1];
		const taskCtx = runTaskMock.mock.calls[0][2];
		// spec §11.1：消息**原样**透传，不再被压成 {role, content} 字符串
		expect(input.messages).toBe(messages);
		expect(input.agentsMdBlocks).toEqual([]);
		// 计数通道：core 把它透进子会话的 memory 工具，pi 只负责累加与通知
		expect(typeof input.onWrite).toBe("function");
		// 配置值不再拆成参数：都收在 cfg 里，由 core 自己读。
		expect(taskCtx.cfg.extractMemories.maxContextTokens).toBe(2000);
		expect(taskCtx.cfg.extractMemories.maxToolResultChars).toBe(500);
		expect(taskCtx.cfg.extractMemories.maxAssistantChars).toBe(2000);
		expect(taskCtx.cwd).toBe(dir);
		expect(typeof taskCtx.store.tryWithLogicalLock).toBe("function");
		// 「5 个 action + memory 工具」由 core 的 TASKS.extractMemories 决定；pi 只提供两个端口。
		const ports = taskCtx.ports;
		expect(typeof ports.headless.run).toBe("function");
		expect(typeof ports.transcript?.toExtractMessages).toBe("function");
		expect(typeof ports.transcript?.searchSessions).toBe("function");
	});

	it("agent_end extracts AGENTS.md blocks from the last system prompt", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const sysPrompt = [
			"pi base...",
			'<project_instructions path="/home/user/.pi/agent/AGENTS.md">',
			"global: use Chinese",
			"</project_instructions>",
			'<project_instructions path="/project/AGENTS.md">',
			"project: never skip tests",
			"</project_instructions>",
		].join("\n");
		await handlers["before_agent_start"][0]({ systemPrompt: sysPrompt }, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hello" }] }, uiCtx());

		const blocks = runTaskMock.mock.calls[0][1].agentsMdBlocks;
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("global: use Chinese");
		expect(blocks[1]).toContain("project: never skip tests");
	});

	it("agent_end passes an empty AGENTS.md list when there are none", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["before_agent_start"][0]({ systemPrompt: "no AGENTS.md here" }, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hello" }] }, uiCtx());

		expect(runTaskMock.mock.calls[0][1].agentsMdBlocks).toEqual([]);
	});

	it("agent_end does nothing when extract is disabled", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hello" }] }, uiCtx());

		expect(runTaskMock).not.toHaveBeenCalled();
	});

	it("the extract port forwards the five-action spec plus the onWrite counter", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		createMemoryToolSpy.mockClear();

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		const ports = runTaskMock.mock.calls[0][2].ports;
		await expect(
			ports.headless.run({
				task: "t",
				cwd: dir,
				model: "nope/not-resolvable",
				builtinTools: "none",
				memoryTool: { actions: MAIN_AGENT_ACTIONS, skipLogicalLock: true, onWrite: () => {} },
			}),
		).rejects.toThrow(/not resolvable/);

		const extractCall = createMemoryToolSpy.mock.calls.find((c: any[]) => c[1]?.skipLogicalLock === true);
		expect(extractCall?.[1]?.actions).toEqual([...MAIN_AGENT_ACTIONS]);
		expect(extractCall?.[1]?.actions).toHaveLength(5);
		expect(typeof extractCall?.[1]?.onWrite).toBe("function");
		// extract 没有整轮快照，所以**不得**带 skipSnapshot：每次写入都要留下自己的回滚点
		expect(extractCall?.[1]?.skipSnapshot).toBeFalsy();
	});
});
