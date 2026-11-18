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
import { DREAM_ACTIONS, type HeadlessAgentPort } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, createMemoryToolSpy, customTriggerEvent, DISK_INDEX, disposableCtx, flush, resetWiringMocks, runTaskMock, scanEntriesMock, sectionsEvent, setupSession, uiWith, waitFor } from "./helpers/wiring-harness";
import memoryFactory from "../index";

const RECALL = "<relevant_memories>\n## SSH\nx\n\n## DB\ny\n</relevant_memories>";

function entry(file: string, description = "d") {
	return { file, name: file.replace(/\.md$/, ""), description, type: "project", modified: "2026-01-01T00:00:00.000Z" };
}

/** 宿主 `ImageContent` 的最小形状（只关心 `type: "image"`）。 */
const IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

/**
 * 真实用户消息的投影形状：宿主 `_prepareRun` 总是给块数组（`[text, ...images]`）。
 * `memory-auto-surfacing` 这类 custom_message 投影成 `role: "custom"`，不在这里。
 * 带图时文本是 `prompt + "\n\n" + hints`，content 里同时有 image block。
 */
function userMessage(text: string, images: unknown[] = []) {
	return { role: "user", content: [{ type: "text", text }, ...images], timestamp: 0 };
}

/**
 * 边界上下文：`contextMessages` 是宿主在 handler 之前用会话投影重建的那份消息列表
 *（`_buildBoundaryContext`）。排队未 drain 的 follow-up / steering 不在里面（宿主放在
 * `pendingMessages`），所以它表示的正是「下一请求会带上的真实消息」。
 */
function boundaryContext(...messages: unknown[]) {
	return { contextMessages: messages };
}

/**
 * `turn_end` 的宿主事件（pi >= 1.5.0 的形状）：`entries` 是**当前**边界提案，handler 返回的
 * `entries` 完整替换它 —— 所以断言里必须能看到原提案还在。`context` 默认是「刚刚提交了
 * "ssh?" 的 user run」的边界上下文。
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
		context: boundaryContext(userMessage("ssh?")),
		...over,
	};
}

const recallEntry = { type: "custom_message", customType: "memory-auto-surfacing", content: RECALL, display: false };

/** 在会话目录里落一条真的 entry（工具与侧查询都读它）：frontmatter + 正文。 */
async function writeEntry(dir: string, file: string, name: string, body: string): Promise<void> {
	await writeFile(
		join(dir, file),
		[
			"---",
			`name: ${name}`,
			`description: ${name} note`,
			"type: project",
			"created: 2026-01-01",
			"modified: 2026-01-01",
			"---",
			"",
			body,
			"",
		].join("\n"),
		"utf8",
	);
}

/**
 * 宿主的**消息投影重放器**：缓存回归用例的请求序列不再手写，而是按宿主的三件事累积。
 *
 * 1. 每个请求的上下文 = 此刻的会话消息（宿主 `_buildBoundaryContext` 的 `llmMessages`）；
 * 2. `turn_end` 的 `entries` 是边界提案，handler 返回值**完整替换**它（`emitBoundary`）；
 * 3. 提案的 `custom_message` draft 提交后成为下一条会话消息（`_applyBoundaryDrafts`）。
 *
 * 所以「注入后的序列」只能是 handler 实际返回值的累积结果，而不是断言自己搭出来的。
 */
function createHostRun() {
	type HostMessage = { role: string; content: string; customType?: string };
	const committed: HostMessage[] = [];
	const requests: HostMessage[][] = [];
	const snapshot = () => committed.map((m) => ({ ...m }));
	return {
		requests,
		/** 用户提交 prompt：run 的第一个请求就是此刻的上下文（`before_agent_start` 之后、请求之前）。 */
		submit(prompt: string): void {
			committed.push({ role: "user", content: prompt });
			requests.push(snapshot());
		},
		/** 一个带工具结果的 turn 结束：边界在 assistant + toolResult 已进会话之后触发。 */
		async finishTurn(handler: (event: any, ctx: any) => any, ctx: any, turnIndex = 1) {
			committed.push({ role: "assistant", content: `checking memory ${turnIndex}` });
			committed.push({ role: "toolResult", content: `command output ${turnIndex}` });
			const projection = snapshot();
			const boundary = await handler(
				turnEndEvent({
					turnIndex,
					entries: [],
					context: { ...boundaryContext(...projection), llmMessages: projection },
				}),
				ctx,
			);
			// 宿主提交提案（无返回值 = 什么都不提交），然后才发下一个请求。
			for (const draft of boundary?.entries ?? []) {
				committed.push({ role: "custom", customType: draft.customType, content: draft.content });
			}
			requests.push(snapshot());
			return boundary;
		},
	};
}

const isRecall = (m: { customType?: string }) => m.customType === "memory-auto-surfacing";

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
		// 侧查询实际收到的那个 Set **引用**：持久化之后它不得跟着变（收到的是快照，spec §5.2.1）。
		const injectedRefs: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			injectedRefs.push(args[1].injectedFiles);
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
		// 持久化把本轮文件标进了活 `injectedFiles`，但侧查询手里的那一份是快照，不会回写。
		expect(injectedRefs[0]).toEqual(new Set());

		// 下一轮：去重标记已生效（已持久化的文件不再浮现）。
		await handlers["before_agent_start"][0](sectionsEvent("and db?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall[1]).toEqual(new Set(["ssh.md", "db.md"]));
	});

	it("keeps the recalled block at one fixed position across the following requests", async () => {
		// 两次**完全独立**的跑：「不注入基线」与「注入跑」各建一个工厂（独立状态）+ 各自一次
		// `session_start`，走同一套宿主投影重放。请求序列全部由 handler 的实际返回值累积，
		// 基线是另一次跑出来的，而不是用同一份数据手搭的等比式。
		const drive = async (surfacing: boolean) => {
			await s.writeConfig({ autoSurfacing: { enabled: surfacing } });
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, s.uiCtx());

			const host = createHostRun();
			const { setStatus, ctx } = spyUi();
			await handlers["before_agent_start"][0](sectionsEvent("how do I debug SSH?"), ctx);
			host.submit("how do I debug SSH?");
			// 基线没有侧查询（`enabled: false` 在 `before_agent_start` 就早退），没有东西可等。
			if (surfacing) await flushPrefetch(setStatus);
			const first = await host.finishTurn(handlers["turn_end"][0], ctx, 1);
			await host.finishTurn(handlers["turn_end"][0], ctx, 2);
			return { host, first };
		};

		scanEntriesMock.mockResolvedValue([entry("ssh.md"), entry("db.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md", "db.md"], content: RECALL });

		const baseline = await drive(false);
		// 基线里根本没发生侧查询：没有注入点，召回块无处出现。
		expect(scanEntriesMock).not.toHaveBeenCalled();
		const surfaced = await drive(true);
		expect(surfaced.first.entries).toEqual([recallEntry]);

		const base = baseline.host.requests;
		const real = surfaced.host.requests;
		expect(base).toHaveLength(3);
		expect(real).toHaveLength(3);

		// 1. 本轮第一个请求：与未注入基线逐元素相等（召回不影响已有前缀）。
		expect(real[0]).toEqual(base[0]);
		expect(real[0].some(isRecall)).toBe(false);
		// 2. 注入点之后：去掉召回块就**逐元素等于**基线（只多了这一块，没改写任何东西）。
		for (const i of [1, 2]) {
			expect(real[i].filter((m) => !isRecall(m))).toEqual(base[i]);
		}
		// 3. 只出现一次，且位置固定：紧跟在本 turn 的工具结果之后，后续请求不再移动它。
		const recallIndex = real[1].findIndex(isRecall);
		expect(recallIndex).toBe(base[1].length);
		expect(real[1].filter(isRecall)).toHaveLength(1);
		expect(real[2].findIndex(isRecall)).toBe(recallIndex);
		expect(real[2].filter(isRecall)).toHaveLength(1);
	});

	it("consumes the recall at a tool boundary while a follow-up is only queued", async () => {
		// 宿主：follow-up 只在没有更多工具调用、也没有 steering 时才拉进来
		//（`agent-loop.js:197` 的 `getFollowUpMessages` 在 inner loop 退出之后），所以它**排队**时
		// 还在宿主的 `pendingMessages`，没进消息流。这个带工具的 turn_end 仍属于原 prompt，必须消费。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		// 上下文里最后一条真实用户消息仍是 "ssh?"（follow-up 只在队列里，看不见）。
		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(boundary.entries.at(-1)).toEqual(recallEntry);
		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
	});

	it("discards the recall when the boundary belongs to a follow-up already on the message flow", async () => {
		// 同一个低层 run 在 `agent_end` 之前 drain follow-up，全程不再发 `before_agent_start`；
		// 一旦它进了消息流，边界上的「最后一条真实用户消息」就是它，而不是启动检索的那个 prompt。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		// follow-up 已落 session：投影里最后一条真实用户消息换了文本。
		const boundary = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?"), userMessage("then what?")) }),
			ctx,
		);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 作废不标去重：同一个文件在下一个 prompt 里仍可浮现。
		await handlers["before_agent_start"][0](sectionsEvent("ssh again?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall[1]).toEqual(new Set());
	});

	it("discards the recall when steering entered the message flow mid-turn", async () => {
		// 宿主：steering 在 `turn_end` 之后、下一次请求之前才被拉进消息流
		//（`agent-loop.js:191` 的 `getSteeringMessages` 在 `emit(turn_end)` 之后）。所以它一旦
		// 进去，再到的边界就已经属于 steering 的 prompt —— 侧查询晚到时不得落盘。
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
		// 第一个带工具边界：侧查询还没 settle（同一个低层 run 下一个请求等它不，谁也不等）。
		expect(await handlers["turn_end"][0](turnEndEvent(), ctx)).toBeUndefined();

		// steering 已进入消息流，之后侧查询才落地。
		resolveRun?.({ files: ["ssh.md"], content: RECALL });
		await flushPrefetch(setStatus);
		const boundary = await handlers["turn_end"][0](
			turnEndEvent({ turnIndex: 2, context: boundaryContext(userMessage("ssh?"), userMessage("no, use the staging host")) }),
			ctx,
		);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("discards a late-settled recall when the input arrived before the run's prep finished", async () => {
		// 宿主的准备期竞争：`_startRun` 先把 `_isAgentRunActive` 置为 true，再 `await _prepareRun()`
		//（`before_agent_start` 在里面异步分发），所以 follow-up 可以在这之前就排进这个 run。
		// 于是：B 的输入 → A 的 before_agent_start 建 pending，两道闸中的第一道是哑的。
		// 侧查询晚到（A 的带工具 turn_end 时还没 settle），A 的召回只能由消费点按上下文判归属，
		// 绝不能在 follow-up 已经进消息流之后落盘。
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
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		// B 的 follow-up 已在宿主的队列里（本扩展看不到它），A 的 before_agent_start 随后建 pending。
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flush();
		// A 的带工具边界：侧查询还没 settle，什么都不带（pending 保留）。
		expect(await handlers["turn_end"][0](turnEndEvent(), ctx)).toBeUndefined();

		// 侧查询在 A 的边界之后才落地；同时间 follow-up 已被 drain 进消息流。
		resolveRun?.({ files: ["ssh.md"], content: RECALL });
		await flushPrefetch(setStatus);
		const boundary = await handlers["turn_end"][0](
			turnEndEvent({ turnIndex: 2, context: boundaryContext(userMessage("ssh?"), userMessage("then what?")) }),
			ctx,
		);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 没被标记去重；下一轮 side query 的输入仍是空集。
		await handlers["before_agent_start"][0](sectionsEvent("ssh again?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall.at(-1)).toEqual(new Set());
	});

	it("consumes a recall for a repeated prompt with the same text", async () => {
		// 同文本重复 prompt：检索 query 相同，召回内容对新 prompt 同样适用，所以按归属消费
		//（误判无害）。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		const repeated = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?"), userMessage("ssh?")) }),
			ctx,
		);
		expect(repeated.entries.at(-1)).toEqual(recallEntry);
		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
	});

	it("consumes a recall for the image-hint suffix of the same prompt", async () => {
		// 带图那一轮：宿主把图片归一化提示以 `prompt + "\n\n" + hints` 追加到用户文本后，
		// content 里同时有 image block（`_prepareRun`）。两个条件都成立时才是同一轮。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?", [IMAGE]), ctx);
		await flushPrefetch(setStatus);
		const withImages = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?\n\n[Image #1: screenshot]", [IMAGE])) }),
			ctx,
		);
		expect(withImages.entries.at(-1)).toEqual(recallEntry);
		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");
	});

	it("discards the recall when a different prompt merely starts with the same text", async () => {
		// 反例：B 的 prompt 是 `ssh?\n\nuse staging instead` —— 文本确实以 `prompt + "\n\n"` 开头，
		// 但既不是同一段 prompt、也没带图，所以不是同一轮（前缀匹配不能单凭文本成立）。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		const boundary = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?\n\nuse staging instead")) }),
			ctx,
		);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 作废不标去重：同一个文件在下一轮 side query 里仍是可选项。
		await handlers["before_agent_start"][0](sectionsEvent("staging?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall.at(-1)).toEqual(new Set());
	});

	it("discards the image-hint shape when the boundary message carries no image", async () => {
		// 无图轮的用户消息文本就是 prompt 原文；带后缀又没有 image block，说明那不是带图轮的
		// `prompt + "\n\n" + hints`，而是另一个 prompt。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		runTaskMock.mockResolvedValue({ files: ["ssh.md"], content: RECALL });

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		const boundary = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?\n\n[Image #1: screenshot]")) }),
			ctx,
		);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// pending 带图但边界消息无图：同样作废。
		await handlers["before_agent_start"][0](sectionsEvent("ssh?", [IMAGE]), ctx);
		await flushPrefetch(setStatus);
		const mismatch = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?\n\nuse staging instead")) }),
			ctx,
		);
		expect(mismatch).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// pending 无图但边界消息带图：不是带图轮的提示后缀（那个轮次在启动时就带图）。
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		const lateImage = await handlers["turn_end"][0](
			turnEndEvent({ context: boundaryContext(userMessage("ssh?\n\nuse staging instead\n\n[Image #1: screenshot]", [IMAGE])) }),
			ctx,
		);
		expect(lateImage).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("keeps the new status line when a superseded prefetch finishes late", async () => {
		// `surfacingStatusFor` 的竞争：旧侧查询晚到，不得擦掉新一轮已亮出的状态行。
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		let resolveOld: ((value: { files: string[]; content: string }) => void) | undefined;
		let resolveNew: ((value: { files: string[]; content: string }) => void) | undefined;
		runTaskMock
			.mockImplementationOnce(
				() =>
					new Promise<{ files: string[]; content: string }>((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<{ files: string[]; content: string }>((resolve) => {
						resolveNew = resolve;
					}),
			);

		await handlers["before_agent_start"][0](sectionsEvent("first?"), ctx);
		await flush();
		expect(setStatus).toHaveBeenCalledWith("surfacing", "Searching relevant memories…");

		// 第一份还在飞时第二个 prompt 启动：它接管了状态行。
		await handlers["before_agent_start"][0](sectionsEvent("second?"), ctx);
		await flush();
		setStatus.mockClear();

		// 旧的先收尾：它不是持有者，一行都不能写（否则用户的“正在检索”会凭空消失）。
		resolveOld?.({ files: [], content: "" });
		await flush();
		await flush();
		expect(setStatus).not.toHaveBeenCalled();

		// 新的收尾才轮到清。
		resolveNew?.({ files: ["ssh.md"], content: RECALL });
		await waitFor(
			() => setStatus.mock.calls.some((call: unknown[]) => call[0] === "surfacing" && call[1] === undefined),
			"新一份 prefetch 收尾清状态行",
		);
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

	it("discards the recall when the same turn's memory tool mutated the store", async () => {
		// 竞态：prefetch 选中 ssh.md 之后，主 agent 在**同轮**用 `memory remove` 删掉了它。
		// 删除不触发 `onContentSeen`（模型没看到正文），所以只有 store 的写入代数能发现这件事 ——
		// 没有这道门就会把已删条目的正文持久化进会话。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers, tools } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		await writeEntry(s.dir, "ssh.md", "SSH", "staging 的 SSH 用 2222 端口");

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		// 同轮：模型删掉了这份记忆（不读正文，所以没有任何去重标记）。
		const removed = await tools[0].execute("call-remove", { action: "remove", name: "SSH" }, undefined, undefined, ctx);
		expect(removed.content[0].text).toContain("Removed");

		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 作废 = 整份丢掉：不持久化、不标去重（下一轮侧查询仍拿到空集合）。
		await handlers["before_agent_start"][0](sectionsEvent("ssh elsewhere?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall.at(-1)).toEqual(new Set());
	});

	it("discards the whole recall when the same turn's memory search already showed one of its files", async () => {
		// 竞态：prefetch 选中 ssh.md + db.md 之后，主 agent 在**同轮**用 `memory search` 看到了 ssh.md
		// 的正文（`search` 把完整 body 拼进结果，所以它进了去重集合）。此时再持久化召回，同一份正文
		// 会在工具结果和召回块里各出现一次。整份作废（不重组、不部分标记）：下一轮重新检索。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers, tools } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		await writeEntry(s.dir, "ssh.md", "SSH", "staging 的 SSH 用 2222 端口");
		await writeEntry(s.dir, "db.md", "DB", "连接池上限是 20");

		scanEntriesMock.mockResolvedValue([entry("ssh.md"), entry("db.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md", "db.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		// 同轮：模型搜到了 ssh.md 的完整正文（不是删除、store 也没变 —— 只有去重交集能发现）。
		const searched = await tools[0].execute("call-search", { action: "search", query: "2222" }, undefined, undefined, ctx);
		expect(searched.content[0].text).toContain("staging 的 SSH 用 2222 端口");

		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(boundary).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// 整份作废的可见证据：db.md 没有被这次作废顺手标记（快照里只有搜索命中的 ssh.md）。
		await handlers["before_agent_start"][0](sectionsEvent("db?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall.at(-1)).toEqual(new Set(["ssh.md"]));
	});

	it("keeps the persisted recall when the run ends right after the boundary (deliberate exception)", async () => {
		// 语义固定：宿主的两条反例（工具结果全要求 terminate 时工具循环就停
		// `pi-agent-core/dist/agent-loop.js:172`；`finishTurn` 可返回 end，`agent-session.js:538-543`）
		// 让「completed + 有工具结果」不严格等于「必有下一请求」。宿主没有信号能区分，所以这里**刻意**
		// 不追严格判定：召回照旧持久化、文件照旧标记 —— 后续轮次与 resume 的历史里仍能看到这块正文，
		// 代价是多一条注入。dsh 侧没有下一个 pre-step 会作废，这是两边**已知的**语义分叉。
		const { notify, setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: RECALL };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);

		const boundary = await handlers["turn_end"][0](turnEndEvent(), ctx);
		expect(boundary.entries.at(-1)).toEqual(recallEntry);
		expect(notify).toHaveBeenCalledWith("Recalled: 2 entries", "info");

		// run 直接结束（没有后续 turn）：`agent_settled` 只销 pending，不回滚已提交的 entries。
		await handlers["agent_settled"][0]({ type: "agent_settled", aborted: false }, ctx);
		expect(boundary.entries.at(-1)).toEqual(recallEntry);

		// 文件已标记去重：下一次检索的输入里已经有它（正文就在历史里，不必再浮现）。
		await handlers["before_agent_start"][0](sectionsEvent("ssh again?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall.at(-1)).toEqual(new Set(["ssh.md"]));
	});

	it("drops an in-flight pending at agent_settled instead of waiting for a later boundary", async () => {
		// pending 的懒清理：零工具轮/取消/未就绪都不清它，只有新 run 与这个收尾点清。
		// 没有 `agent_settled` 这道门，run 结束后迟到的那份结果会挂在下一个边界上被持久化 ——
		// 属于一条已经结束的 run。
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
		// 零工具边界：本轮之后没有请求，召回作废但 pending 留着（懒清理）。
		expect(await handlers["turn_end"][0](turnEndEvent({ toolResults: [] }), ctx)).toBeUndefined();

		await handlers["agent_settled"][0]({ type: "agent_settled", aborted: false }, ctx);
		resolveRun?.({ files: ["ssh.md"], content: RECALL });
		await flushPrefetch(setStatus);

		// 已销账：下一个带工具边界不再替那条结束了的 run 持久化。
		expect(await handlers["turn_end"][0](turnEndEvent({ turnIndex: 2 }), ctx)).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
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

	it("does not mark files the headless dream/extract tool read", async () => {
		const { setStatus, ctx } = spyUi();
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

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

		scanEntriesMock.mockResolvedValue([entry("ssh.md")]);
		const injectedAtCall: Array<Set<string>> = [];
		let headless: HeadlessAgentPort | undefined;
		runTaskMock.mockImplementation(async (...args: any[]) => {
			// 端口由 index 在每次 pre-step / run 时现造；侧查询这次调用带的就是 headless 子会话的那个。
			headless = args[2].ports.headless as HeadlessAgentPort;
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: [], content: "" };
		});

		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), ctx);
		await flushPrefetch(setStatus);
		expect(headless).toBeDefined();
		const port = headless as HeadlessAgentPort;

		// 经**真实** headless 端口建一次 dream 的工具：模型故意不可解析（不联网），但工具在
		// `runHeadlessAgent` 的模型校验**之前**就已经由 `buildMemoryTool` 包好了。
		createMemoryToolSpy.mockClear();
		await expect(
			port.run({
				task: "dream",
				cwd: s.dir,
				model: "missing/model",
				builtinTools: "file-io",
				memoryTool: { actions: DREAM_ACTIONS },
			}),
		).rejects.toThrow(/not resolvable/);

		// 创建点拿不到 `onContentSeen`：headless 工具没有那个回调。
		const headlessSpec = createMemoryToolSpy.mock.calls.at(-1)?.[1] as { actions: readonly string[] };
		expect(headlessSpec.actions).toBe(DREAM_ACTIONS);
		expect("onContentSeen" in headlessSpec).toBe(false);

		// 真的执行一次（= dream 子会话读了 ssh.md 的正文）：内容进了子会话，主模型没见过。
		const headlessTool = createMemoryToolSpy.mock.results.at(-1)?.value as {
			execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
		};
		const read = await headlessTool.execute(
			"dream-1",
			{ action: "search", query: "SSH" },
			undefined,
			undefined,
			s.uiCtx(),
		);
		expect(read.content[0].text).toContain("staging 的 SSH 用 2222 端口");

		// 主 session 的去重集合因此仍为空：下一轮的侧查询照样把 ssh.md 当候选（与上一个用例相反）。
		await handlers["before_agent_start"][0](sectionsEvent("ssh again?"), ctx);
		await flushPrefetch(setStatus);
		expect(injectedAtCall).toHaveLength(2);
		expect(injectedAtCall[1]).toEqual(new Set());
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
