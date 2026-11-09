import { randomUUID } from "node:crypto";
import { renderSurfacedBlock, requiredModel, runSideQuery, scanEntries } from "@yandy0725/memory-core";
import type { HeadlessAgentPort } from "@yandy0725/memory-core";
import type { SessionMemoryRuntime } from "./store-registry.js";

/**
 * 每轮召回：挂在宿主 `agent/pre-step` waterfall 上，在模型被调用前，用一轮零工具侧查询挑出与用户
 * 这轮输入相关的 entry，再把它们渲染成 `<relevant_memories>` 块 splice 进进入该 step 的消息里。
 *
 * 记忆逻辑全在 core（`runSideQuery` 选文件、`renderSurfacedBlock` 渲染并净化）；本模块是宿主胶水：
 * 找到真人 prompt、调 core、把结果放进宿主真正会投递的位置。两处宿主敏感语义：
 *
 * 1. 它跑在 agent loop 会 await 的 waterfall 里 —— 慢会拖慢用户这一轮，抛错/挂起会弄坏它。
 *    所以召回失败一律吞掉 + 记一行 `deps.warn`，绝不外抛。
 * 2. 它重写进入该 step 的消息 —— 别的监听器（compaction / plan mode / instructions / time-context）
 *    也听同一个 waterfall。所以永远先 `await next()`，并且返回时 `{ ...decision, messages }` 展开，
 *    让 `startsRequestSeries` 与任何未来字段都存活（宿主 practices 明写，test 6 钉住）。
 */

/** 侧查询的 `userPrompt` 预算，与 pi 的 `event.prompt.slice(0, 4000)` 逐字一致。 */
const USER_PROMPT_MAX_CHARS = 4000;

export interface SurfacingDeps {
	registry: { get(sessionId: string): SessionMemoryRuntime | undefined };
	indexCache: { refresh(rt: SessionMemoryRuntime): Promise<void> };
	headless: HeadlessAgentPort;
	warn(message: string, ...args: unknown[]): void;
	injected: Map<string, Set<string>>; // sessionId → 已注入的 entry 文件名
	now?(): Date;
}

export interface UserMessageLike {
	role: "user";
	id: string;
	content: Array<{ type: "text"; text: string }>;
	source: { kind: "simple-memory"; form: "notice"; summary: string };
}

export type PreStepPayload = {
	agent: { session: { id: string } };
	messages: unknown[];
	turn: number;
	step: number;
	signal: AbortSignal;
};

export type PreStepDecision = { kind: "reject" } | { kind: "enter"; messages: unknown[]; startsRequestSeries?: true };

/** content 抽文本：`type === "text"` 的 block 取 `text`，空格连接（与 session-search 的抽取一致）。 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join(" ");
}

/**
 * 从本轮 claim 的 messages 里抽出真人 prompt。
 *
 * **只认 `source.kind === "user"`（白名单）**：宿主的 `MessageSourceMap` 是可合并扩展的，多数
 * `user/message` 其实是宿主或其它插件注入的合成消息（file-change 通知、AGENTS.md / skill 内容、
 * cron 通知、goal 续接……）。把它们当「用户刚说的话」喂给侧查询，召回就会响应注入噪声而不是真人。
 * 未知/未来 kind 一概不是真人，不放行 —— 白名单的失败模式（宿主改 kind 名 → 召回为空）远比
 * 黑名单的（静默召回噪声）显眼。
 */
export function humanPromptText(messages: Array<{ source?: { kind?: string }; content?: unknown }>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message?.source?.kind !== "user") continue;
		const text = contentText(message.content);
		if (text !== "") parts.push(text);
	}
	return parts.join("\n");
}

/**
 * 把 core 渲染好的块（已含 `<relevant_memories>` 包裹、已净化）包成 dsh 的 `UserMessage`。
 *
 * `form: "notice"` 对齐 pi 的 `display: false` + 一行 "Recalled: N entries"：正文对用户不可见、
 * 只显示 `summary` 一行（宿主 `CONTEXT_SUMMARY_MAX_CHARS = 120` 约束）。
 *
 * **前提（未验证，待真宿主端到端任务确认）**：`form` 只影响渲染与归属，`content` 里完整的
 * `<relevant_memories>` 仍会进模型消息。单测只能钉住「消息的 content 含完整正文、summary 是短摘要」，
 * 无法证明真宿主把 notice 的 content 喂给模型。若实测发现 `notice` 会藏起正文，退回
 * `form: "snapshot"` 并接受「正文在 UI 里展开」的差异（记入 spec §9 痛点）。
 */
export function createRecallMessage(content: string, count: number): UserMessageLike {
	return {
		role: "user",
		id: randomUUID(),
		content: [{ type: "text", text: content }],
		source: {
			kind: "simple-memory",
			form: "notice",
			summary: `Recalled ${count} ${count === 1 ? "memory" : "memories"}`,
		},
	};
}

/**
 * 建 `agent/pre-step` 监听器。用 `{ prepend: true }` 注册在最外层：先进入、最后看到 decision，
 * 因此 splice 时 `decision.messages` 已是所有内层监听器（compaction / instructions / time-context…）
 * 都处理过的最终形态。
 */
export function createPreStepListener(
	deps: SurfacingDeps,
): (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
	return async (payload, next) => {
		// 永远先 await next()：waterfall 语义，且内层监听器改过的 messages 才是我们要 splice 的形态。
		const decision = await next();

		if (decision.kind === "reject" || payload.signal.aborted) return decision;

		const rt = deps.registry.get(payload.agent.session.id);

		// 每轮每个 step 都刷新索引快照（廉价路径）：这是长寿命会话最终看到其它进程写入记忆的途径。
		// 与召回无关（索引 section 是另一条注入通道），所以放在 surfacing 可用性门之前。
		if (rt) {
			try {
				await deps.indexCache.refresh(rt);
			} catch (e) {
				deps.warn("simple-memory: auto-surfacing skipped: %s", e);
				return decision;
			}
		}

		// 只在 step === 1 召回：召回服务的是「这一轮的用户意图」，同一轮里模型自己发起的后续 step
		// 不该再付一次侧查询的延迟与 token（spec §5.7）。
		if (payload.step !== 1 || rt === undefined || rt.store === null || !rt.surfacing.available) {
			return decision;
		}

		const prompt = humanPromptText(payload.messages as Array<{ source?: { kind?: string }; content?: unknown }>);
		if (prompt === "") return decision;

		try {
			const manifest = await scanEntries(rt.store);
			const injectedFiles = deps.injected.get(rt.sessionId) ?? new Set<string>();
			const selected = await runSideQuery(
				{
					manifest,
					userPrompt: prompt.slice(0, USER_PROMPT_MAX_CHARS),
					injectedFiles,
					maxFiles: rt.config.autoSurfacing.maxFiles,
					effort: rt.config.autoSurfacing.thinkLevel,
					model: requiredModel(rt.config, "autoSurfacing"),
					cwd: rt.memoryDir ?? "",
					sessionPersistence: rt.config.autoSurfacing.sessionPersistence ?? rt.config.defaults?.sessionPersistence,
				},
				{ headless: deps.headless },
			);
			if (selected.length === 0) return decision;

			const content = await renderSurfacedBlock(
				rt.store,
				selected,
				rt.config.autoSurfacing.maxEntryBytes,
				rt.config.autoSurfacing.maxInjectionBytes,
			);
			if (content === "") return decision;

			// 只在成功且非空渲染之后才标记 injected（与 pi 一致）：空渲染不消耗这些文件本会话再浮现的机会。
			for (const file of selected) injectedFiles.add(file);
			deps.injected.set(rt.sessionId, injectedFiles);

			// 召回插在「最后一条仍来自本轮 claim 的消息」之后：用身份包含（而非 source.kind）判定，
			// 因为内层监听器可能已经 append 了新消息，我们只关心原始 claim 里最后一条的落点。
			const lastClaimed = decision.messages.findLastIndex((m) => payload.messages.includes(m));
			const message = createRecallMessage(content, selected.length);
			return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) };
		} catch (e) {
			// 召回是增强，绝不能拖垮这一轮：任何失败都记一行，原样返回 decision。
			deps.warn("simple-memory: auto-surfacing skipped: %s", e);
			return decision;
		}
	};
}
