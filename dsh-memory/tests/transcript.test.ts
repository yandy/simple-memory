import { describe, expect, it } from "vitest";
import { createDshTranscript, toExtractMessages } from "../src/transcript.js";

/**
 * `transcript.ts` 的测试：会话事件 → core 的中立 `ExtractMessage`。
 *
 * 这里钉的是「谁是 user」与三种丢失方式 —— 抽错了不会报错，只会让 extract 从错误的材料里提炼：
 * 把注入噪声当用户规则、把 reasoning 当答复、把工具调用/结果整段丢掉。
 */

const userMessage = (text: string, kind = "user") => ({
	type: "user/message",
	data: { content: [{ type: "text", text }], source: { kind } },
});

const assistantMessage = (blocks: unknown[]) => ({
	type: "assistant/message",
	data: { message: { content: blocks } },
});

describe("toExtractMessages", () => {
	it("keeps a human user message as `user`", () => {
		expect(toExtractMessages([userMessage("fix the lock bug")])).toEqual([
			{ role: "user", text: "fix the lock bug" },
		]);
	});

	it("renders injected user-role context as `assistant`, never as `user`", () => {
		// user 文本在 prompt 里不截断且被当作规则/纠正：文件变更通知、skill 正文这类注入噪声
		// 冒充 user 会污染抽取。
		expect(toExtractMessages([userMessage("[file changed] README.md", "file-change")])).toEqual([
			{ role: "assistant", text: "[file changed] README.md" },
		]);
	});

	it("drops this adapter's own recall injection", () => {
		// 把记忆正文再喂给 extract = 让 extract 从自己的记忆里反复提取。
		expect(toExtractMessages([userMessage("<relevant_memories>…", "simple-memory")])).toEqual([]);
	});

	it("keeps assistant text and tool calls, and drops reasoning", () => {
		expect(
			toExtractMessages([
				assistantMessage([
					{ type: "reasoning", text: "let me think about the lock file" },
					{ type: "text", text: "I'll read the store." },
					{ type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.ts"}' },
				]),
			]),
		).toEqual([
			{
				role: "assistant",
				text: "I'll read the store.",
				toolCalls: [{ name: "read", args: '{"path":"a.ts"}' }],
			},
		]);
	});

	it("renders a tool-call event that the assistant message did not carry", () => {
		expect(
			toExtractMessages([
				{ type: "tool/call", data: { callId: "call-9", name: "bash", arguments: '{"cmd":"ls"}' } },
			]),
		).toEqual([{ role: "assistant", toolCalls: [{ name: "bash", args: '{"cmd":"ls"}' }] }]);
	});

	it("does not duplicate a tool call that the assistant message already carried", () => {
		const messages = toExtractMessages([
			assistantMessage([{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }]),
			{ type: "tool/call", data: { callId: "call-1", name: "read", arguments: "{}" } },
		]);
		expect(messages).toHaveLength(1);
	});

	it("attributes a tool result to the tool name it answers, and keeps the failure flag", () => {
		expect(
			toExtractMessages([
				{ type: "tool/call", data: { callId: "call-1", name: "read", arguments: "{}" } },
				{
					type: "tool/result",
					data: {
						message: {
							toolCallId: "call-1",
							isError: true,
							content: [{ type: "text", text: "ENOENT" }],
						},
					},
				},
			]),
		).toEqual([
			{ role: "assistant", toolCalls: [{ name: "read", args: "{}" }] },
			{ role: "toolResult", text: "ENOENT", toolName: "read", isError: true },
		]);
	});

	it("keeps an image placeholder so a screenshot turn is not silently text-only", () => {
		expect(
			toExtractMessages([
				{ type: "user/message", data: { content: [{ type: "text", text: "see this" }, { type: "image" }], source: { kind: "user" } } },
			]),
		).toEqual([{ role: "user", text: "see this\n[image]" }]);
	});

	it("ignores non-conversation events and skips empty messages", () => {
		expect(
			toExtractMessages([
				{ type: "turn/start", data: { turn: 1 } },
				{ type: "system/message", data: { message: { content: [{ type: "text", text: "prompt" }] } } },
				userMessage(""),
				assistantMessage([]),
				{ type: "turn/end", data: { reason: { kind: "completed" } } },
			]),
		).toEqual([]);
	});

	it("survives malformed input instead of throwing", () => {
		// 事件来自磁盘上的历史会话（可能跨版本、可能被别的插件写过）：任何一条坏数据都不该让
		// 整轮抽取崩掉。
		expect(
			toExtractMessages([
				null,
				"not an event",
				42,
				{},
				{ type: "user/message" },
				{ type: "assistant/message", data: null },
				{ type: "tool/result", data: {} },
				{ type: "tool/call", data: null },
			]),
		).toEqual([]);
	});
});

describe("createDshTranscript", () => {
	it("passes session search through untouched and exposes toExtractMessages", async () => {
		const searchSessions = async (cwd: string, query: string) => `${cwd}|${query}`;
		const port = createDshTranscript(searchSessions);

		expect(port.toExtractMessages).toBe(toExtractMessages);
		expect(await port.searchSessions("/mem", "lock", { maxSessions: 1, maxMatches: 1 })).toBe("/mem|lock");
	});
});

describe("toExtractMessages — 空工具结果", () => {
	it("drops an empty successful tool result but keeps an empty failure", () => {
		// 成功的空输出没有信息（调用本身已经渲染过）；失败本身就是信号，哪怕模型没写任何文本。
		const messages = toExtractMessages([
			{ type: "tool/result", data: { message: { toolCallId: "c1", content: [] } } },
			{ type: "tool/result", data: { message: { toolCallId: "c2", content: [], isError: true } } },
		]);
		expect(messages).toEqual([{ role: "toolResult", text: "", isError: true }]);
	});
});
