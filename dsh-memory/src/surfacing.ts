import { randomUUID } from "node:crypto";
import { runTask, scanEntries, TASKS } from "@yandy0725/memory-core";
import type { HeadlessAgentPort } from "@yandy0725/memory-core";
import type { SessionMemoryRuntime } from "./store-registry.js";

/**
 * 每轮召回：挂在宿主 `agent/pre-step` waterfall 上，用一轮零工具侧查询挑出与用户这轮输入相关的
 * entry，再把它们渲染成 `<relevant_memories>` 块 splice 进进入该 step 的消息里。
 *
 * **prefetch 两段式**（侧查询不阻塞任何请求）：
 *
 * - `step === 1`：先作废**上一轮**（turn 不同）的 pending（再谈能不能启动），然后记下真人 prompt，把
 *   `scanEntries` + `runTask` 丢到后台（fire-and-forget），**立即返回原 decision** —— 这一轮的第一个
 *   请求与侧查询并行，不等它。同一 turn 重复进的 step 1 不走「作废」而是「替换」（见下）。
 * - **同一 turn** 的 `step >= 2`：pending 已就绪且渲染非空才消费（splice + 标记去重 + 销账）。
 *   未就绪就留给后面的 step；turn 变了、被拒、取消、或这一步 claim 里出现别的真人输入 → 作废。
 *
 * 记忆逻辑全在 core（`runTask(TASKS.autoSurfacing)` 选文件并渲染、净化）；本模块是宿主胶水：
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

/**
 * 一条在途的召回（prefetch）状态。
 *
 * 归属有两道闸，缺一不可：
 * 1. `turn`：只有**同一轮**的后续 step 才消费（新的一轮在 step 1 就先把跨轮的旧记录销账）；
 * 2. `prompt`：消费前拿这一刻 step claim 的真人 prompt 比对 —— 宿主的 inbox 可以在 handler 未完成时
 *    收进新的真人输入（steering / 排队 follow-up），那种情况下这条召回属于**前一条** prompt，
 *    第 1 道闸是哑的（turn 没变），只有按 prompt 校验才能把结果扣在正确的输入上。
 *
 * `settled` 之前 `files` / `content` 一律不可信（消费点必须先看它）。
 *
 * 装配层持有 `Map<sessionId, PendingRecall>`（宿主的 compact / clear 与 dispose 都要作废它），
 * 会话边界的销账语义在 index.ts。
 *
 * 同一 turn 再进一次 step 1 = 重新启动一次 prefetch（`set` 覆盖旧记录），旧 prefetch 的迟到结果因身份
 * 校验不等而丢弃；若那次重复被可用性门 / 真人 prompt 门挡回，旧记录原样留着给后续 step >= 2 消费。
 */
export interface PendingRecall {
	turn: number;
	settled: boolean;
	/** 启动 prefetch 时这一轮 claim 里的真人 prompt（消费点的归属校验用它）。 */
	prompt: string;
	files: string[];
	content: string;
}

export interface SurfacingDeps {
	registry: { get(sessionId: string): SessionMemoryRuntime | undefined };
	indexCache: { refresh(rt: SessionMemoryRuntime): Promise<void> };
	headless: HeadlessAgentPort;
	warn(message: string, ...args: unknown[]): void;
	injected: Map<string, Set<string>>; // sessionId → 已注入的 entry 文件名
	/** sessionId → 在途召回。读写都在本模块，装配层只在会话边界清（compact / clear / disposed）。 */
	pendingRecalls: Map<string, PendingRecall>;
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
 * `form: "notice"` + 短 `summary` 对齐 pi 的 `display: false` + 一行 "Recalled: N entries"。
 *
 * **前提（宿主声明支持，但真宿主行为待端到端任务确认）**：`form` 是「同一份模型可见内容」之上的
 * **语义**呈现轴，不改变 `content` 进模型的事实 —— `message.d.ts:127` 把 `MessageBase.content` 定为
 * "Exact model-facing blocks"（模型看到的就是 content）；`ContextForm` 的词汇是 "SEMANTIC, never
 * visual … a consumer decides what that looks like"（`message.d.ts:39-41`），`notice` 只额外要求一行
 * `summary`（"shown without expanding the row"，`message.d.ts:86-88`），并不折叠 content。单测只能
 * 钉住「消息的 content 含完整正文、summary 是短摘要」，无法证明真宿主把 notice 的 content 喂给模型，
 * 所以真宿主确认仍排在后一个任务。
 *
 * **若实测发现 `notice` 会藏起正文**，退回 `form: "recall"`（`message.d.ts:57-58`，"Material lifted
 * out of another session's log"，语义正是「从别的会话日志里拎出来的材料」）或干脆**省略 `form`**
 * （`message.d.ts:72-73` 与 `:76` 的 `{ form?: never }`：undeclared context 是文档默认）。**不要退回
 * `form: "snapshot"`**：snapshot 意味着「同一生产者较新的快照**取代**较早的」（`message.d.ts:51-52`）
 * 且**必须**带 `sections` 字段（`message.d.ts:82-84`），与逐轮**累加**的召回消息语义不合。
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
		// `next()` 刻意留在 try 之外：内层监听器的拒绝必须原样传播（那是别的插件的崩溃，吞掉它等于
		// 捏造一个 decision 并掩盖真实故障 —— 比外抛更糟）。「绝不外抛」只承诺我们自己的失败。
		const decision = await next();

		// 从这里到结尾统一包一层 try：payload 违约（messages 不可迭代、next() 解析成非 decision）或
		// 召回任一步失败，都记一行并原样返回 decision，而不是把 turn 弄崩 —— 召回是增强。
		try {
			const sessionId = payload.agent.session.id;

			// 被拒的 step 不会跑、取消的轮不会再有后续请求：两种情况下这一轮都**没有消费点**了，
			// 在途召回随轮作废（不标记去重 —— 正文没到模型眼前）。
			if (decision.kind === "reject" || payload.signal.aborted) {
				deps.pendingRecalls.delete(sessionId);
				return decision;
			}

			// 新的一轮在 step 1 就作废**上一轮**的 pending：**先销账，再谈能不能启动**。放在可用性门 /
			// 真人 prompt 门**之前**，也放在下面的 `indexCache.refresh` await 之前 —— 那一轮就算 runtime
			// 不可用、store 为空、surfacing 关着或没有真人 prompt，旧的 content/files 也不该继续驻留
			// （「后续 step 靠 turn 不匹配清掉」只在后续 step 恰好来了时才成立，不是作废语义）。
			// 判据必须带 `turn`：**同一 turn** 重复进 step 1（宿主重试）不在这里删，走下面启动段的
			// 「替换」语义（新 pending 在 `set` 时覆盖旧记录）——否则那次重复若被可用性门 / 真人 prompt
			// 门挡回，就没人在原来位置重建记录，后续 step >= 2 白白丢掉一份合法召回（还可能白付一次侧查询）。
			const previous = deps.pendingRecalls.get(sessionId);
			if (payload.step === 1 && previous !== undefined && previous.turn !== payload.turn) {
				deps.pendingRecalls.delete(sessionId);
			}

			const rt = deps.registry.get(sessionId);

			// 每轮每个 step 都刷新索引快照（廉价路径）：这是长寿命会话最终看到其它进程写入记忆的途径。
			// 与召回无关（索引 section 是另一条注入通道），所以放在 surfacing 可用性门之前。
			if (rt) {
				await deps.indexCache.refresh(rt);
			}

			// 取消复检：上面的 refresh 是 await 点，用户可能正好在它期间取消这一轮。abort 一律**先销账
			// 再返回**，且不分 step / 不分 pending 是否就绪：
			// - step 1：不启动一个已经取消的侧查询（runTask 只会立刻被取消，白付一次扫描）；
			// - step >= 2：不 splice；且未就绪的 pending 也不能靠「留给后续 step」活下来 —— 取消的轮没有
			//   后续请求，它会一直留在 Map 里跨轮驻留。
			if (payload.signal.aborted) {
				deps.pendingRecalls.delete(sessionId);
				return decision;
			}

			// 召回服务的是「这一轮的用户意图」，所以只有 step === 1 启动侧查询：同一轮里模型自己发起的
			// 后续 step 不该再付一次侧查询的 token。`rt.memoryDir === null` 显式声明不变量
			// （registry 只在解析出 memoryDir 时才给出非空 store；`fail()` 两者同空）—— 显式 return
			// 而不是 `?? ""`，避免静默把空 cwd 发给侧查询端口。
			if (payload.step === 1) {
				if (rt === undefined || rt.store === null || rt.memoryDir === null || !rt.surfacing.available) return decision;
				const prompt = humanPromptText(payload.messages as Array<{ source?: { kind?: string }; content?: unknown }>);
				if (prompt === "") return decision;

				// 同步段只做两件事：记下 pending、把侧查询丢到后台。此后不能再回读 `rt` 的字段（长寿命对象，
				// 会话可能在侧查询在飞期间被收回），所以先把要用的值抓成局部常量。
				const store = rt.store;
				const memoryDir = rt.memoryDir;
				const cfg = rt.config;
				// 去重集合递**快照**：查询在飞时同轮的消费点可能把别的文件标进活 Set，传引用会让
				// 「查询输入」随之后写而变。
				const injectedFiles = new Set(deps.injected.get(sessionId) ?? []);
				const pending: PendingRecall = { turn: payload.turn, settled: false, prompt, files: [], content: "" };
				// 记下这一轮的 pending：跨轮的旧记录上面已清；同 turn 重复 step 1 时这次 `set` 就是
				// 「替换」（旧 prefetch 的迟到结果会被下面的身份校验丢弃）。
				deps.pendingRecalls.set(sessionId, pending);
				const prefetch = (async () => {
					try {
						const manifest = await scanEntries(store);
						const { files, content } = await runTask(
							TASKS.autoSurfacing,
							{ userPrompt: prompt.slice(0, USER_PROMPT_MAX_CHARS), injectedFiles, manifest },
							{ cfg, cwd: memoryDir, store, signal: payload.signal, ports: { headless: deps.headless } },
						);
						// 期间有新的 step 1 启动（这份 pending 已被取代）：结果随轮作废，不写回。
						if (deps.pendingRecalls.get(sessionId) !== pending) return;
						pending.files = files;
						pending.content = content;
					} catch (e) {
						// 召回是增强，绝不能拖垮这一轮：失败只记一行，pending 以空 content 收场
						// （消费点据此丢弃它，不 splice、不标记）。
						deps.warn("simple-memory: auto-surfacing skipped: %s", e);
					} finally {
						pending.settled = true;
					}
				})();
				// 兜底：链内已全 catch，这里再挡一层意外 rejection（未处理的 rejection 在宿主里没人接）。
				void prefetch.catch(() => undefined);
				return decision;
			}

			// ---- step >= 2：消费同轮已就绪的 prefetch。 ----
			const pending = deps.pendingRecalls.get(sessionId);
			if (pending === undefined) return decision;

			// turn 不匹配：这份结果属于更早的轮（或压缩重建把 turn 计数改了），一律作废。
			if (pending.turn !== payload.turn) {
				deps.pendingRecalls.delete(sessionId);
				return decision;
			}

			// 归属校验：这一步 claim 里若出现**新的、与启动时不同**的真人输入，这份召回属于前一条 prompt
			// （宿主允许 handler 未完成时收进 steering / followed-up 输入）—— 不 splice、不标记去重，作废。
			// 没有真人输入（step >= 2 通常只 claim 工具结果）或文本相同（同文本重复 prompt = 检索 query
			// 相同，召回仍适用）都照常消费。
			const claimed = humanPromptText(payload.messages as Array<{ source?: { kind?: string }; content?: unknown }>);
			if (claimed !== "" && claimed !== pending.prompt) {
				deps.pendingRecalls.delete(sessionId);
				return decision;
			}

			// 未就绪：这个请求不带召回（「永不阻塞」的代价面），pending 留给后面的 step。
			// 取消不在这条路径上 —— 上面 refresh 之后的 abort 复检已经先销账并返回了。
			if (!pending.settled) return decision;

			// 就绪的 pending 只有一次消费机会：无论成败都销账，绝不让后续 step 再拼一次同样一块。
			deps.pendingRecalls.delete(sessionId);

			// 只在成功且非空渲染之后才标记 injected（与 pi 一致）：空渲染（含 prefetch 失败）不消耗
			// 这些文件本会话再浮现的机会。
			if (pending.content === "") return decision;
			const consumed = deps.injected.get(sessionId) ?? new Set<string>();
			for (const file of pending.files) consumed.add(file);
			deps.injected.set(sessionId, consumed);

			// 召回插在「最后一条仍来自这一步 claim 的消息」之后：用身份包含（而非 source.kind）判定，
			// 因为内层监听器可能已经 append 了新消息，我们只关心原始 claim 里最后一条的落点。
			// 找不到（-1）= 这一步 claim 与 decision 里的消息没有身份交集（宿主的 `payload.messages` 是
			// 「这一步从 inbox 收走的那些消息」，step >= 2 常见为空或全是工具结果）→ 追加到末尾，
			// 即落在本轮已有消息之后、下一次请求之前。绝不能像 first-party 的 `-1 + 1` 那样插到最前：
			// 那会把召回放到本轮 prompt **之前**，位置错乱且破坏前缀缓存。
			const lastClaimed = decision.messages.findLastIndex((m) => payload.messages.includes(m));
			const at = lastClaimed === -1 ? decision.messages.length : lastClaimed + 1;
			const message = createRecallMessage(pending.content, pending.files.length);
			return { ...decision, messages: decision.messages.toSpliced(at, 0, message) };
		} catch (e) {
			// 召回是增强，绝不能拖垮这一轮：任何失败都记一行，原样返回 decision。
			deps.warn("simple-memory: auto-surfacing skipped: %s", e);
			return decision;
		}
	};
}
