import type { ExtractMessage, HostTranscriptPort } from "@yandy0725/memory-core";
import type { SessionEventLike } from "./agent-session.js";

/**
 * dsh 的 `HostTranscriptPort`：把**会话事件日志**翻成 core 的中立 `ExtractMessage`。
 *
 * 为什么入参是事件而不是「消息」：dsh 的对话不是一份可枚举的消息数组，而是 `Session` 的
 * append-only 事件日志（`user/message` / `assistant/message` / `tool/call` / `tool/result`…）。
 * 模型可见的「消息」是日志的一个投影，投影本身要 `sessionQuery` 的服务与落盘 —— 而
 * `sessionPersistence.enabled: false` 在 dsh 上不可兑现（设计稿 §4.3）。所以本端口直接读日志，
 * 与宿主的 `dsh-headless` 参考实现同一条路。
 *
 * core 只把 `messages` 当 `unknown[]` 转手给本端口，所以「事件 vs 消息」的差别被这个接缝完全吃掉；
 * 冒充「我只认识消息」反而会让映射丢字段。
 *
 * 语义对齐 `pi-memory/src/host-transcript.ts`（同一份记忆、同一套 prompt，两个宿主的抽取不该
 * 因为「谁是 user」的差别而分叉）：
 *
 * - **真人发言才算 `user`**（`source.kind === "user"`，白名单与 `session-search.ts` 的真人判据
 *   同一口径）。注入类 `user/message`（文件变更通知、skill 正文、目标续跑…）按 `assistant` 渲染：
 *   user 文本在 prompt 里**不截断**且被当作规则/纠正，把注入噪声放进去会污染抽取；
 * - **本插件自己注入的召回块**（`source.kind === "simple-memory"`）整条跳过 —— 把记忆正文再喂给
 *   extract 等于让 extract 从自己的记忆里反复提取（pi 侧跳 `memory-auto-surfacing` 是同一件事）；
 * - `reasoning` 块绝不进文本；`tool/call` 的名称与原始参数保留，`tool/result` 保留成功/失败标记。
 */

/** `user/message` 事件的 `data`。 */
interface UserMessageData {
	content?: unknown;
	source?: { kind?: unknown };
}

/** `assistant/message` 与 `tool/result` 事件的 `data`（都带一条完整消息）。 */
interface MessageEventData {
	message?: {
		content?: unknown;
		isError?: unknown;
		toolCallId?: unknown;
	};
}

/** 本插件注入消息的 source.kind（`surfacing.ts` 的 `createRecallMessage`）。 */
const OWN_INJECTION_KIND = "simple-memory";

/** 从内容块数组里抠出文本；`[image]` / 其它块按 pi 的规则保留占位或忽略。 */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** 内容块里的 `tool-call` 块（模型发起的工具调用）。`arguments` 是原始 JSON 字符串。 */
function toolCallsOfContent(content: unknown): Array<{ name: string; args: string; id: string | null }> {
	if (!Array.isArray(content)) return [];
	const out: Array<{ name: string; args: string; id: string | null }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as Record<string, unknown>;
		if (part.type !== "tool-call" || typeof part.name !== "string") continue;
		out.push({
			name: part.name,
			args: typeof part.arguments === "string" ? part.arguments : "",
			id: typeof part.id === "string" ? part.id : null,
		});
	}
	return out;
}

/**
 * 会话事件 → `ExtractMessage[]`。
 *
 * 未知事件类型一律跳过（`turn/start` / `step/end` / `request/header` / `assistant/attempt` 都不是
 * 对话内容）。形状不认识的事件也按「尽量保留文本」处理，绝不把未知来源当 `user`。
 */
export function toExtractMessages(raw: unknown[]): ExtractMessage[] {
	const out: ExtractMessage[] = [];
	/** `callId → 工具名`：`tool/result` 自己不带名字，靠前面那次 `tool/call` 补齐。 */
	const toolNames = new Map<string, string>();
	/** 已经在 assistant 消息的 `tool-call` 块里出现过的 callId，避免 `tool/call` 事件重复一条。 */
	const seenCalls = new Set<string>();

	for (const rawEvent of raw) {
		if (!rawEvent || typeof rawEvent !== "object") continue;
		const event = rawEvent as SessionEventLike;
		const data = event.data;

		if (event.type === "user/message") {
			const message = data as UserMessageData | undefined;
			const kind = typeof message?.source?.kind === "string" ? message.source.kind : "";
			if (kind === OWN_INJECTION_KIND) continue;
			const text = textOfContent(message?.content);
			if (text === "") continue;
			// 真人 → user（不截断、被当规则）；注入类 → assistant（受 maxAssistantChars 约束）。
			out.push(kind === "user" ? { role: "user", text } : { role: "assistant", text });
			continue;
		}

		if (event.type === "assistant/message") {
			const message = (data as MessageEventData | undefined)?.message;
			const text = textOfContent(message?.content);
			const toolCalls = toolCallsOfContent(message?.content);
			for (const call of toolCalls) if (call.id !== null) seenCalls.add(call.id);
			if (text === "" && toolCalls.length === 0) continue;
			out.push({
				role: "assistant",
				...(text !== "" ? { text } : {}),
				...(toolCalls.length > 0 ? { toolCalls: toolCalls.map(({ name, args }) => ({ name, args })) } : {}),
			});
			continue;
		}

		if (event.type === "tool/call") {
			// 宿主把工具调用同时记成独立事件；`assistant/message` 的 `tool-call` 块若已覆盖它就跳过。
			const call = data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined;
			const callId = typeof call?.callId === "string" ? call.callId : null;
			if (typeof call?.name === "string" && callId !== null) toolNames.set(callId, call.name);
			if (callId !== null && seenCalls.has(callId)) continue;
			if (typeof call?.name !== "string") continue;
			if (callId !== null) seenCalls.add(callId);
			out.push({
				role: "assistant",
				toolCalls: [{ name: call.name, args: typeof call.arguments === "string" ? call.arguments : "" }],
			});
			continue;
		}

		if (event.type === "tool/result") {
			const message = (data as MessageEventData | undefined)?.message;
			const callId = typeof message?.toolCallId === "string" ? message.toolCallId : null;
			const text = textOfContent(message?.content);
			const isError = message?.isError === true;
			// 空结果且不是失败 = 没有信息（模型那边只看到一次成功但无输出的调用，调用本身已由上一条
			// `tool/call` 渲染过）。而「空文本 + isError」要留：失败本身就是信号。
			if (text === "" && !isError) continue;
			out.push({
				role: "toolResult",
				text,
				...(callId !== null && toolNames.has(callId) ? { toolName: toolNames.get(callId) } : {}),
				isError,
			});
		}
	}
	return out;
}

/**
 * 把 dsh 的两个宿主能力组装成 core 的 `HostTranscriptPort`：`toExtractMessages` 供
 * `runTask(TASKS.extractMemories, …)` 渲染对话，`searchSessions` 与 `memory` 工具的
 * `search scope=sessions` 走同一份 `session-search.ts` 实现。
 */
export function createDshTranscript(
	searchSessions: (cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }) => Promise<string>,
): HostTranscriptPort {
	return { searchSessions, toExtractMessages };
}
