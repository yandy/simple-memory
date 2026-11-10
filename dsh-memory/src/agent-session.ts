import { randomUUID } from "node:crypto";
import type { HeadlessOutcome, HeadlessRunRequest, MemoryAction } from "@yandy0725/memory-core";
import { errorMessage } from "./errors.js";
import { parseModelRef } from "./model.js";

/**
 * 「要工具的 headless 会话」在 dsh 上的落地：一个**嵌套 agent 会话**。
 *
 * 零工具的一问一答（autoSurfacing 侧查询）能用 `ctx.llm.stream()` 直接表达，所以那条路留在
 * `headless.ts`。extract / dream 不同：core 要求子会话里有一个真实的 `memory` 工具（dream 甚至
 * 必须靠它重建索引），而 dsh 里「模型 + 工具循环」只有 agent 会跑 —— 于是带 `memoryTool` 的请求
 * 走 `ctx.agents.create()`（设计稿 §4.1 的调研结论）。
 *
 * 本模块只做四件事，全是宿主胶水：
 *
 * 1. **组子会话的作用域**：`setup` 里注册 `memory` 工具、限制可见工具、挂 step 上界；
 * 2. **驱动**：`followup(一条用户消息)` → `whenIdle()`；
 * 3. **取结果**：从子会话的事件日志里取「最后一条非空 assistant 文本」（规则同宿主的
 *    `dsh-subagent/assistant-output`，见 `summarize`）；
 * 4. **收口成 core 的词汇**：`HeadlessOutcome`（判别规则见 `runNestedSession` 的表格）。
 *
 * 刻意不做的事：
 *
 * - **不 import 宿主的任何值**（宿主包只在 `host-types.ts` 以 `import type` 出现，tsc 擦除），
 *   所以产物 `.js` 里连提都不提宿主包名（CI 用 grep 守这条，注释里写包名同样会破）。
 *   所以子会话的用户消息由本模块自己拼字面量 —— 与 `surfacing.ts` 的 `createRecallMessage`
 *   同款做法；
 * - **不假装 `sessionPersistence` 生效**：dsh 的会话落盘只看服务是否挂载，没有 per-session
 *   开关（设计稿 §4.3）。`req.sessionPersistence` 在这里被**刻意忽略**，事实写进 README；
 * - **不硬编码模型可用性**：模型不可用是宿主在这一轮里报的错（`turn/end` 的 `error` 原因），
 *   本模块只把宿主的事实翻成 core 的词汇。
 */

/**
 * 宿主 file-io 类工具名（dsh 侧真名）：只读的 `read` / `read_image` / `glob` / `grep` 与
 * 写入类的 `write` / `edit` / `apply_patch` / `str_replace_editor`。
 *
 * 刻意不含 `bash` / `pwsh` / `subagent` / `web` —— `builtinTools: "file-io"` 的语义就是
 * 「文件读写」，与 pi 侧 `FILE_IO_TOOLS`（`read`/`write`/`edit`/`ls`）同口径。名字集合是
 * **候选**：每个部署装配的插件不同，真正传给宿主 `tools.restrict()` 的是它与「本会话可见工具」
 * 的交集（宿主的 `restrict()` 对未知名字直接抛错）。
 *
 * 注意：三个 core 任务的 `builtinTools` 恒为 `"none"`，所以今天这条分支不会被走到；
 * 它存在是为了让端口对 `HeadlessRunRequest` 的**全部**字段都有确定的语义。
 */
export const FILE_IO_TOOL_NAMES: readonly string[] = Object.freeze([
	"read",
	"read_image",
	"glob",
	"grep",
	"write",
	"edit",
	"apply_patch",
	"str_replace_editor",
]);

/** 子会话事件的最小形状：本模块只按 `type` / `data` 读（宿主 `SessionEvent` 的结构化子集）。 */
export interface SessionEventLike {
	type: string;
	data?: unknown;
}

/**
 * 子会话日志的最小形状（宿主 `Session` 的结构化子集）。
 *
 * `snapshotEvents` 在宿主里带 `@deprecated`（新代码被要求走 `sessionQuery`），本模块仍然用它：
 * - `sessionQuery.readSession()` 以**落盘**为前提，而 `sessionPersistence.enabled: false` 在 dsh
 *   上不可兑现 —— 拿持久化做前提会让端口在没装 sessionPersistence 的 profile 里整条失效；
 * - 宿主自己的参考实现（`dsh-headless` 的 `summarize`，`lib/index.js:115-139`）同样直接读 live
 *   `Session`。跟着参考实现走，比在适配层发明第二条读取路径安全。
 */
export interface SessionLogLike {
	readonly seq: number;
	snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[];
}

/** 子会话 agent 的最小形状：驱动（`followup` / `whenIdle` / `cancel`）+ 读日志 + 状态。 */
export interface ChildAgentLike {
	readonly session: SessionLogLike;
	/** 宿主 `Agent.status`：`idle` / `running`。收敛判定要用它，见 `waitForIdle`。 */
	readonly status: string;
	followup(message: unknown): void;
	whenIdle(): Promise<void>;
	cancel(cause: unknown): void;
}

/**
 * `setup` 拿到的 agent 作用域里我们用到的部分（宿主 `Context` 的结构化子集）。
 *
 * `register` / `restrict` 是本模块唯一改变子会话**能力面**的地方；`definitions()` 只用来把
 * 候选文件名收敛成「本会话真的注册了的那些」。
 */
export interface AgentScopeLike {
	readonly tools: {
		register(definition: unknown): unknown;
		restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): unknown;
		definitions(): readonly { name: string }[];
	};
	/**
	 * `ctx.on()`：两种形状都要支持 —— `agent/pre-step` 是 waterfall（`(payload, next)`），
	 * `session/event` / `agent/error` 是 emit（`(session, event)` / `(payload)`）。handler 收
	 * `unknown[]`，收窄在各自的注册处做。
	 */
	on(event: string, handler: (...args: unknown[]) => unknown): unknown;
}

export interface AgentHandleLike {
	readonly agent: ChildAgentLike;
	dispose(): Promise<void> | void;
}

/** 宿主 `ctx.agents.create()` 的入参（结构化子集）。 */
export interface CreateAgentOptionsLike {
	sessionId: string;
	meta?: { cwd?: string; origin?: "subagent"; delegationDepth?: number };
	agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
	signal?: AbortSignal;
	/**
	 * 宿主把**未发布**的 agent 作用域交出来。参数刻意声明成 `unknown`：品牌类型
	 * （`SessionId` / `ReasoningEffortId`）只在宿主签名里，本模块在 `setup` 内部收窄一次。
	 */
	setup?(agentCtx: unknown, agent: unknown): void;
}

/** 宿主 `ctx.agents` 的最小形状。 */
export interface AgentsLike {
	create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>;
}

/** 子会话里 `memory` 工具的构造参数（core 的 `HeadlessRunRequest.memoryTool` 原样透传）。 */
export interface NestedMemoryToolOptions {
	actions: readonly MemoryAction[];
	skipLogicalLock?: boolean;
	skipSnapshot?: boolean;
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

export interface NestedSessionDeps {
	agents: AgentsLike;
	/** 装配层提供的 `memory` 工具工厂（`createMemoryTool` 的偏应用）。 */
	buildMemoryTool(options: NestedMemoryToolOptions): unknown;
	warn(message: string, ...params: unknown[]): void;
}

/** `assistant/message` 事件的 `data`：只要 `message.content` 里那一种块。 */
interface AssistantMessageEventData {
	message?: { content?: readonly { type?: unknown; text?: unknown }[] };
}

/** `turn/end` 事件的 `data`：只要终止原因。 */
interface TurnEndEventData {
	reason?: { kind?: unknown; error?: { code?: unknown; message?: unknown } };
}

interface SessionSummary {
	text: string;
	errorDetail: string | null;
	aborted: boolean;
	maxTokens: boolean;
}

/**
 * 子会话的最终文本：宿主规则是「**最后一条非空 assistant 消息**」，没有就退到累积的流式文本。
 *
 * 本模块只读事件日志（不订阅流式帧），所以没有流式兜底那一半：`assistant/message` 是宿主在
 * step 结算时落的权威块，正是我们要的。只取 `type: "text"` 的块 —— `reasoning` 绝不能进答案
 * （与 `headless.ts` 零工具路径同一条纪律）。
 */
function summarize(events: readonly SessionEventLike[]): SessionSummary {
	let text = "";
	let errorDetail: string | null = null;
	let aborted = false;
	let maxTokens = false;
	for (const event of events) {
		if (event.type === "assistant/message") {
			const content = (event.data as AssistantMessageEventData | undefined)?.message?.content;
			if (!Array.isArray(content)) continue;
			const joined = content
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("");
			// 空回复不覆盖上一条：宿主规则是「最后一条**非空**」。
			if (joined !== "") text = joined;
			continue;
		}
		if (event.type === "turn/end") {
			const reason = (event.data as TurnEndEventData | undefined)?.reason;
			const kind = typeof reason?.kind === "string" ? reason.kind : "";
			if (kind === "error") {
				// 失败原因只取一句话：`code` 有则带上，方便用户对照行 config 里的模型键。
				const code = typeof reason?.error?.code === "string" ? reason.error.code : null;
				const message = typeof reason?.error?.message === "string" ? reason.error.message : null;
				const parts = [code, message].filter((part): part is string => part !== null && part !== "");
				errorDetail = parts.length > 0 ? parts.join(": ") : "the host ended the turn with an error";
			} else if (kind === "aborted") {
				aborted = true;
			} else if (kind === "max-tokens") {
				maxTokens = true;
			}
		}
	}
	return { text, errorDetail, aborted, maxTokens };
}

/** 子会话的用户消息字面量：宿主 `createUserMessage` 的等价物（品牌化的 `id` 运行期就是字符串）。 */
function userMessage(text: string): unknown {
	return { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/**
 * 子会话可见的全局工具白名单。
 *
 * 宿主的 `tools.restrict()` 对**未知名字**直接抛错（`dsh-tools/lib/index.js:464-467`），所以候选
 * 文件名必须先与本会话真的注册了的工具求交集：
 * - `builtinTools: "none"`（三个任务的真实取值）→ `[]` = 关掉**所有**全局工具，子会话只剩我们
 *   在 agent 作用域注册的 `memory` 工具（作用域注册不受限制影响）；
 * - `builtinTools: "file-io"` → 交集。交集为空意味着「这个部署没有文件工具」，而不是「放行全部」：
 *   失败模式必须是**少给**能力。
 */
function allowedGlobalTools(scope: AgentScopeLike, builtinTools: "none" | "file-io"): readonly string[] {
	if (builtinTools === "none") return [];
	let visible: readonly { name: string }[];
	try {
		visible = scope.tools.definitions();
	} catch (e) {
		// 拿不到清单就无法安全限制：抛出去让 `agents.create` 整体失败（= 没跑），
		// 而不是在「可能放行全部工具」的状态下把模型放进去。
		throw new Error(`could not read the host's tool list: ${errorMessage(e)}`);
	}
	const names = new Set(visible.map((definition) => definition.name));
	return FILE_IO_TOOL_NAMES.filter((name) => names.has(name));
}

/**
 * 跑一轮要工具的 headless 会话。
 *
 * 结果映射（core 的判别规则：请求**发出前**结束 = `not-run`，**发出后**没拿到完整文本 =
 * `incomplete`）：
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 模型引用不是 `<provider>/<model>` | `not-run` / `unavailable` |
 * | 调用方在创建前已取消 | `not-run` / `aborted` |
 * | `agents.create` 抛错（作用域装配失败、会话创建失败） | `not-run` / `host-refused`（带原因） |
 * | 超时，且还没 `followup` | `not-run` / `timeout` |
 * | 超时，且已经发出 | `incomplete` / `aborted`（写入可能已发生） |
 * | step 数超过 `maxTurns` | `incomplete` / `turn-limit` |
 * | 宿主报 `turn/end` 的 `error` | `not-run` / `host-refused`（带原因） |
 * | 宿主报 `turn/end` 的 `aborted` | `incomplete` / `aborted` |
 * | 宿主报 `turn/end` 的 `max-tokens` | `incomplete` / `max-tokens` |
 * | 跑完但没有 assistant 文本 | `no-output` |
 * | 其他 | `completed` |
 */
export async function runNestedSession(req: HeadlessRunRequest, deps: NestedSessionDeps): Promise<HeadlessOutcome> {
	const ref = parseModelRef(req.model);
	if (ref === null) {
		return { status: "not-run", cause: "unavailable" };
	}
	// 请求还没发出就取消了：`not-run`，而且一个会话都不该建。
	if (req.signal?.aborted) return { status: "not-run", cause: "aborted" };

	// 超时用显式 setTimeout + unref（与 `headless.ts` 同一条理由：`AbortSignal.timeout()` 的定时器
	// 无法提前清除，长寿命宿主进程里会留一整批到期的定时器）。
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timeoutController: AbortController | undefined;
	if (typeof req.timeoutMs === "number" && req.timeoutMs > 0) {
		timeoutController = new AbortController();
		timer = setTimeout(
			() => timeoutController?.abort(new Error(`nested agent session timed out after ${req.timeoutMs}ms`)),
			req.timeoutMs,
		);
		timer.unref?.();
	}
	const timedOut = (): boolean => timeoutController?.signal.aborted === true;

	// 创建期的取消信号：会话还没建完时不该继续。组合而不是替换调用方自己的 signal。
	const creationSignals: AbortSignal[] = [];
	if (req.signal !== undefined) creationSignals.push(req.signal);
	if (timeoutController !== undefined) creationSignals.push(timeoutController.signal);
	const creationSignal =
		creationSignals.length === 0
			? undefined
			: creationSignals.length === 1
				? creationSignals[0]
				: AbortSignal.any(creationSignals);

	const maxTurns = req.maxTurns;
	let maxTurnsExceeded = false;
	/** 子会话这一轮收口（或明确失败）时 resolve；监听器在 `setup` 里注册。 */
	const settled = deferred();
	/** `agent/error` 带出的失败原因（没有则 `null`）。 */
	let hostError: string | null = null;
	let steps = 0;
	/** `followup` 之后 = 请求真的发出去了（决定超时算 `not-run` 还是 `incomplete`）。 */
	let dispatched = false;

	const options: CreateAgentOptionsLike = {
		// 宿主自己的 headless 运行时用同一个格式（`dsh-headless/lib/index.js:333`）。
		sessionId: `session-${randomUUID()}`,
		// `origin: "subagent"` 是本插件自己的子 agent 门禁判据（`isRootAgent`）：子会话绝不再挂
		// 一层记忆层（索引 section / 工具 / 召回都不该在子会话里出现）。
		meta: { cwd: req.cwd, origin: "subagent", delegationDepth: 1 },
		agentOptions: {
			provider: ref.provider,
			model: ref.model,
			...(req.effort !== undefined ? { reasoningEffort: req.effort } : {}),
		},
		...(creationSignal !== undefined ? { signal: creationSignal } : {}),
		setup: (agentCtx) => {
			// 宿主交给 `setup` 的是**未发布**的 agent 作用域（真身是 `Context`）。本模块只认它的
			// 一小片，品牌类型在宿主签名里，所以只在这里收窄一次，其余全按本地接缝走。
			const scope = agentCtx as AgentScopeLike;

			// 1. 注入 `memory` 工具。作用域注册不受 `restrict` 影响（宿主文档：
			//    「Restrictions intersect… scoped registrations remain visible」）。
			if (req.memoryTool !== null) {
				scope.tools.register(
					deps.buildMemoryTool({
						actions: req.memoryTool.actions,
						skipLogicalLock: req.memoryTool.skipLogicalLock,
						skipSnapshot: req.memoryTool.skipSnapshot,
						onWrite: req.memoryTool.onWrite,
					}),
				);
			}

			// 2. 关掉其它全局工具。三个任务的 `builtinTools` 恒为 `"none"`，所以子会话的**唯一**
			//    工具就是上面的 `memory` —— 与 pi 的 `noTools: "builtin"` 同口径。抛错就让它抛：
			//    装配失败 = 会话没建起来 = `not-run`，绝不在能力面不确定时放模型进去。
			scope.tools.restrict({ allow: allowedGlobalTools(scope, req.builtinTools) });

			// 3. step 上界（尽力而为）。dsh 没有 `maxTurns`（设计稿 §4.2），能做的是数 step 并在超限
			//    时把后续 step **拒掉**：宿主文档里被拒的 step 直接收口这一轮（turn 关闭，没有 step
			//    开始）。counting 放在 `next()` 之后：被内层拒掉的 step 不计入。
			if (maxTurns !== undefined) {
				scope.on("agent/pre-step", async (...args: unknown[]) => {
					const next = args[1] as (() => Promise<unknown>) | undefined;
					const decision = next === undefined ? { kind: "reject" } : await next();
					steps += 1;
					if (steps > maxTurns) {
						maxTurnsExceeded = true;
						return { kind: "reject" };
					}
					return decision;
				});
			}

			// 收敛判据是**事件**，不是 `whenIdle()`：宿主的 `whenIdle()` 在「这一轮还没被驱动登记为
			// 活动」时会立刻 resolve（实测 status 也可能是 `idle`），所以任何基于 quiescence 的循环都
			// 会提前退出 → 我们 dispose 掉刚排队的这一轮。真机日志就是证据：`turn/start` → inbox splice
			// 撤掉消息 → `turn/end (aborted, disposed)`，0 个 `request/header`。子会话只有一轮（一次
			// followup），等它的 `turn/end` 是精确的；`agent/error` 也要收，否则模型层直接失败时我们会
			// 一直等下去（那是最糟的形态：看起来像挂死）。
			scope.on("session/event", (...args: unknown[]) => {
				const event = args[1] as SessionEventLike | undefined;
				if (event?.type === "turn/end") settled.resolve();
			});
			scope.on("agent/error", (...args: unknown[]) => {
				// 失败原因要带出来：`agent/error` 是「这一轮失败了」的唯一信号（没有对应的事件日志形态）。
				const payload = args[0] as { error?: unknown } | undefined;
				hostError = errorMessage(payload?.error);
				settled.resolve();
			});
		},
	};

	let owned: AgentHandleLike;
	try {
		// 与取消面赛跑：`create` 在建会话时挂住（持久化后端卡死、provider 探测不返回）也是现实场景，
		// 而它自己不一定听得见我们传的 signal。不赛跑就会出现「设置了 timeoutMs 却永远不超时」。
		owned = await raceWithAbort(deps.agents.create(options), creationSignal);
	} catch (e) {
		if (timer !== undefined) clearTimeout(timer);
		// 建会话就失败了：请求从未发出。
		if (timedOut()) return { status: "not-run", cause: "timeout" };
		if (req.signal?.aborted === true) return { status: "not-run", cause: "aborted" };
		return { status: "not-run", cause: "host-refused", detail: errorMessage(e) };
	}
	const child = owned.agent;

	// 这一轮的取消面：调用方 signal + 超时。两者任一触发都要**真的打断**子会话（宿主的方式是
	// `agent.cancel()`），否则 `whenIdle()` 会一直挂着 —— 而 `timeoutMs` 就形同虚设。
	const runSignals: AbortSignal[] = [];
	if (req.signal !== undefined) runSignals.push(req.signal);
	if (timeoutController !== undefined) runSignals.push(timeoutController.signal);
	const runSignal =
		runSignals.length === 0 ? undefined : runSignals.length === 1 ? runSignals[0] : AbortSignal.any(runSignals);

	let runError: unknown = null;
	try {
		child.followup(userMessage(req.task));
		dispatched = true;
		await raceWithAbort(settled.promise, runSignal);
		// 这一轮已经收口，再等一次 quiescence 让宿主的 post-turn 工作落定；它提前 resolve 也无所谓
		// （不会再有下一轮了），所以这里不需要循环。
		await raceWithAbort(child.whenIdle(), runSignal);
	} catch (e) {
		runError = e;
		if (runSignal?.aborted === true) {
			// 取消/超时：让宿主停掉这一轮再收口。`cancel` 自己抛错不影响结果（dispose 会兜底）。
			try {
				child.cancel({ kind: "hook", reason: "the memory task was cancelled" });
			} catch {
				/* 已结束的会话取消失败：不是问题 */
			}
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}

	// 结果只在跑完之后读一次日志：`whenIdle` 返回时这一轮的写入已经落盘，读快照是稳定的。
	let summary: SessionSummary | null = null;
	try {
		summary = summarize(child.session.snapshotEvents());
	} catch (e) {
		// 读不到日志 = 拿不到结果，但不能因此跳过 dispose。
		runError ??= e;
	}

	// `dispose()` 停驱动、注销 agent、移除会话、拆作用域。**无论成败都要进**：留着它就是一个在
	// 长寿命宿主进程里跑不完的子会话。dispose 自己的失败只记一行，不掩盖真正的结果。
	try {
		await owned.dispose();
	} catch (e) {
		deps.warn("simple-memory: could not dispose the memory sub-session: %s", errorMessage(e));
	}

	// 超时优先判：组合 signal 两边都为真时，`aborted` 与 `timeout` 分不开，先看定时器。
	if (timedOut()) {
		return dispatched ? { status: "incomplete", cause: "aborted" } : { status: "not-run", cause: "timeout" };
	}
	// step 超限比 turn 自身的终止原因更可操作（模型陷进了工具循环），先报它。
	if (maxTurnsExceeded) return { status: "incomplete", cause: "turn-limit" };
	if (runError !== null) {
		// 驱动层的失败（`whenIdle` 拒绝 / 读日志失败）：按「这一轮有没有真的发出去」分档。
		if (req.signal?.aborted === true) {
			return dispatched ? { status: "incomplete", cause: "aborted" } : { status: "not-run", cause: "aborted" };
		}
		return { status: "not-run", cause: "host-refused", detail: errorMessage(runError) };
	}
	if (summary === null) return { status: "no-output" };
	if (hostError !== null) return { status: "not-run", cause: "host-refused", detail: hostError };
	if (summary.errorDetail !== null) {
		return { status: "not-run", cause: "host-refused", detail: summary.errorDetail };
	}
	if (summary.maxTokens) return { status: "incomplete", cause: "max-tokens" };
	if (summary.aborted) return { status: "incomplete", cause: "aborted" };
	if (summary.text.trim() === "") return { status: "no-output" };
	return { status: "completed", text: summary.text };
}

/** 一个可外部 resolve 的 promise（本模块只需要 `resolve`，不需要值）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = () => res();
	});
	return { promise, resolve };
}

/**
 * `promise` 与「signal 被 abort」赛跑；abort 赢时以 `signal.reason` 拒绝（没有 reason 就用一句兜底）。
 *
 * 没有它，`whenIdle()` / `agents.create()` 就是**无法打断**的 await：宿主不会因为我们超时就自己停，
 * 于是 `timeoutMs` 只能等这一轮自然结束才生效 —— 那正是「超时无效」的写法。
 */
async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) throw signal.reason ?? new Error("aborted");
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}
