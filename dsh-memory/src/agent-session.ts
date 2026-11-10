import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { HeadlessOutcome, HeadlessRunRequest, MemoryAction } from "@yandy0725/memory-core";
import { errorMessage } from "./errors.js";
import { parseModelRef } from "./model.js";

/**
 * dsh 上的「要工具的 headless 会话」：一个**常驻 worker 子会话** + 每轮 `followup`。
 *
 * 为什么不「跑一次建一个」：`AgentRegistry.create()` 用 `this.ctx` 作为子 agent 的 owner，而 cordis
 * 的 traceable 机制把 `this.ctx` 解析成「访问服务时的调用方作用域」。在 `agent/turn-stopping` /
 * `agent/status` 的派发里创建子会话会抛 `cannot create effect on inactive context`（真机实测：
 * 插件作用域绑定、agent 作用域绑定、宏任务延迟三种写法全部复现）。同样的调用在 `apply` 期间与
 * `agent/created` 期间**都是成功的**。
 *
 * 所以分工是：
 *
 * - **建会话只发生在允许的阶段**（`agent/created`，见 `index.ts`），一次建好、长期复用；
 * - **每轮只 `followup` 一条消息 + 等它的 `turn/end`**，不新建任何 effect —— 这条路真机已验证。
 *
 * 一个 worker 绑定**一个任务**（extract 5 个 action / dream 7 个 action）：core 把「注册范围」定成
 * 硬约束，7 个 action 的 schema 不能出现在 extract 的子会话里。
 */

/**
 * 宿主 file-io 类工具名（dsh 侧真名）：只读的 `read` / `read_image` / `glob` / `grep` 与写入类的
 * `write` / `edit` / `apply_patch` / `str_replace_editor`。
 *
 * 刻意不含 `bash` / `pwsh` / `subagent` / `web`。名字集合是**候选**：每个部署装配的插件不同，真正
 * 传给宿主 `tools.restrict()` 的是它与「本会话可见工具」的交集（宿主的 `restrict()` 对未知名字抛错）。
 * 注意：三个 core 任务的 `builtinTools` 恒为 `"none"`，所以今天这条分支不会被走到 —— 它存在是为了
 * 让端口对 `HeadlessRunRequest` 的**全部**字段都有确定的语义。
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
 * - `sessionQuery.readSession()` 以**落盘**为前提，而 `sessionPersistence.enabled: false` 在 dsh 上
 *   不可兑现 —— 拿持久化做前提会让端口在没装 sessionPersistence 的 profile 里整条失效；
 * - 宿主自己的参考实现（`dsh-headless` 的 `summarize`）同样直接读 live `Session`。
 */
export interface SessionLogLike {
	readonly seq: number;
	snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[];
}

/** 子会话 agent 的最小形状：驱动（`followup` / `whenIdle` / `cancel`）+ 读日志 + 状态。 */
export interface ChildAgentLike {
	readonly session: SessionLogLike;
	/** 宿主 `Agent.status`：`idle` / `running`。 */
	readonly status: string;
	followup(message: unknown): void;
	whenIdle(): Promise<void>;
	cancel(cause: unknown): void;
}

/**
 * `setup` 拿到的 agent 作用域里我们用到的部分（宿主 `Context` 的结构化子集）。
 *
 * `register` / `restrict` 是本模块唯一改变子会话**能力面**的地方；`definitions()` 只用来把候选
 * 文件名收敛成「这条会话真的注册了的那些」；`on` 用来挂 step 上界与收口监听。
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

export interface WorkerSpec {
	agents: AgentsLike;
	/** 子会话 cwd：三个任务恒为 memoryDir。 */
	cwd: string;
	/** 宿主模型标识 `<provider>/<model>`（由调用方从 cfg 解析后传入）。 */
	model: string;
	effort?: string;
	actions: readonly MemoryAction[];
	skipLogicalLock?: boolean;
	skipSnapshot?: boolean;
	/** 建议的 step 上界（core 的 `maxTurns`；dsh 侧只能尽力而为）。 */
	maxTurns?: number;
	buildMemoryTool(options: NestedMemoryToolOptions): unknown;
	warn(message: string, ...params: unknown[]): void;
}

/** 一个常驻子会话：一条 `run()` = 一次 `followup` + 等它 `turn/end`。 */
export interface SessionWorker {
	readonly sessionId: string;
	run(req: HeadlessRunRequest): Promise<HeadlessOutcome>;
	dispose(): Promise<void>;
}

/** 建会话失败时的可读原因；调用方据此在需要时给 `not-run` 而不是静默跳过。 */
export interface WorkerFailure {
	error: string;
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
 * 一段事件里的最终文本：宿主规则是「**最后一条非空 assistant 消息**」。
 *
 * 只取 `type: "text"` 的块 —— `reasoning` 绝不能进答案（与零工具路径同一条纪律）。
 * 调用方必须传**本次 run 的事件窗口**：常驻 worker 的日志跨多轮，整段读会把上一轮的回答当成这一轮。
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
 * 宿主的 `tools.restrict()` 对**未知名字**直接抛错，所以候选名必须先与本会话真的注册了的工具求交集：
 * - `builtinTools: "none"`（三个任务的真实取值）→ `[]` = 关掉**所有**全局工具，子会话只剩我们在
 *   agent 作用域注册的 `memory` 工具（作用域注册不受限制影响）；
 * - `builtinTools: "file-io"` → 交集。交集为空意味着「这个部署没有文件工具」，而不是「放行全部」：
 *   失败模式必须是**少给**能力。
 */
export function allowedGlobalTools(scope: AgentScopeLike, builtinTools: "none" | "file-io"): readonly string[] {
	if (builtinTools === "none") return [];
	let visible: readonly { name: string }[];
	try {
		visible = scope.tools.definitions();
	} catch (e) {
		// 拿不到清单就无法安全限制：抛出去让创建整体失败（= 没跑），而不是在「可能放行全部工具」的
		// 状态下把模型放进去。
		throw new Error(`could not read the host's tool list: ${errorMessage(e)}`);
	}
	const names = new Set(visible.map((definition) => definition.name));
	return FILE_IO_TOOL_NAMES.filter((name) => names.has(name));
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
 * 没有它，`whenIdle()` 就是**无法打断**的 await：宿主不会因为我们超时就自己停，于是 `timeoutMs`
 * 只能等这一轮自然结束才生效 —— 那正是「超时无效」的写法。
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

/**
 * 建一个常驻 worker 子会话（**只能在允许的阶段调用**：dsh 上就是 `agent/created`）。
 *
 * `setup` 里做三件事，全是能力面：注入 `memory` 工具（action 集按任务固定）、`restrict` 关掉所有
 * 全局工具、挂 step 上界。`onWrite` 是**每轮可变**的：工具在创建时注册一次，core 的写入回调按 run
 * 传入，所以用一个可变槽位转发。
 */
export async function createSessionWorker(spec: WorkerSpec): Promise<SessionWorker | WorkerFailure> {
	const ref = parseModelRef(spec.model);
	if (ref === null) return { error: `model "${spec.model}" must be "<provider>/<model>"` };

	/** 每轮由 `run()` 改写；`memory` 工具的 onWrite 通过它转发给 core。 */
	let currentOnWrite: ((info: { action: MemoryAction; name?: string }) => void) | undefined;
	const settled = deferred();
	/** `agent/error` 带出的失败原因（没有则 `null`）。 */
	let hostError: string | null = null;
	let maxTurnsExceeded = false;
	let steps = 0;
	const maxTurns = spec.maxTurns;

	// 子会话的 cwd 是记忆目录，而宿主会校验它存在（`working-directory: directory does not exist`）——
	// 全新项目里第一次抽取时目录可能还没被创建（`MemoryStore` 只在写入时建目录）。所以先建出来：
	// 一次 mkdir -p 比让每一轮抽取都以 `turn/end error` 失败划算得多。
	try {
		await mkdir(spec.cwd, { recursive: true });
	} catch (e) {
		return { error: `could not create the memory directory ${spec.cwd}: ${errorMessage(e)}` };
	}

	let owned: AgentHandleLike;
	try {
		owned = await spec.agents.create({
			sessionId: `session-${randomUUID()}`,
			// `origin: "subagent"` 是本插件自己的子 agent 门禁判据（`isRootAgent`）：worker 绝不再挂
			// 一层记忆层（索引 section / 工具 / 召回都不该在它里面出现）。
			meta: { cwd: spec.cwd, origin: "subagent", delegationDepth: 1 },
			agentOptions: {
				provider: ref.provider,
				model: ref.model,
				...(spec.effort !== undefined ? { reasoningEffort: spec.effort } : {}),
			},
			setup: (agentCtx) => {
				// 宿主交给 `setup` 的是**未发布**的 agent 作用域（真身是 `Context`）。品牌类型在宿主
				// 签名里，所以只在这里收窄一次，其余全按本地接缝走。
				const scope = agentCtx as AgentScopeLike;

				// 1. 注入 `memory` 工具：action 集按任务固定（extract 5 / dream 7），schema 跟着 action 走。
				scope.tools.register(
					spec.buildMemoryTool({
						actions: spec.actions,
						skipLogicalLock: spec.skipLogicalLock,
						skipSnapshot: spec.skipSnapshot,
						onWrite: (info) => currentOnWrite?.(info),
					}),
				);

				// 2. 关掉其它全局工具（worker 的唯一工具就是上面的 `memory`）。抛错就让它抛：装配失败 =
				//    会话没建起来，绝不在能力面不确定时把模型放进去。
				scope.tools.restrict({ allow: allowedGlobalTools(scope, "none") });

				// 3. step 上界（尽力而为）。宿主文档里被拒的 step 直接收口这一轮。
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

				// 4. 收口判据是**事件**，不是 `whenIdle()`：宿主的 `whenIdle()` 在「这一轮还没被驱动
				//    登记为活动」时会立刻 resolve（实测 status 也可能是 `idle`），所以任何基于
				//    quiescence 的等待都会提前返回。每轮发一条 followup，等它的 `turn/end` 是精确的；
				//    `agent/error` 也要收，否则模型层直接失败时会一直等到 timeoutMs。
				scope.on("session/event", (...args: unknown[]) => {
					const event = args[1] as SessionEventLike | undefined;
					if (event?.type === "turn/end") settled.resolve();
				});
				scope.on("agent/error", (...args: unknown[]) => {
					const payload = args[0] as { error?: unknown } | undefined;
					hostError = errorMessage(payload?.error);
					settled.resolve();
				});
			},
		});
	} catch (e) {
		return { error: errorMessage(e) };
	}

	const child = owned.agent;

	return {
		sessionId: String((child.session as unknown as { id?: unknown }).id ?? ""),

		async run(req: HeadlessRunRequest): Promise<HeadlessOutcome> {
			// 请求还没发出就取消了：`not-run`，什么都不动。
			if (req.signal?.aborted) return { status: "not-run", cause: "aborted" };

			// 超时用显式 setTimeout + unref（`AbortSignal.timeout()` 的定时器无法提前清除）。
			let timer: ReturnType<typeof setTimeout> | undefined;
			let timeoutController: AbortController | undefined;
			if (typeof req.timeoutMs === "number" && req.timeoutMs > 0) {
				timeoutController = new AbortController();
				timer = setTimeout(
					() => timeoutController?.abort(new Error(`memory worker turn timed out after ${req.timeoutMs}ms`)),
					req.timeoutMs,
				);
				timer.unref?.();
			}
			const timedOut = (): boolean => timeoutController?.signal.aborted === true;
			const signals: AbortSignal[] = [];
			if (req.signal !== undefined) signals.push(req.signal);
			if (timeoutController !== undefined) signals.push(timeoutController.signal);
			const runSignal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

			// 本次 run 的事件窗口起点：worker 的日志跨多轮，整段读会把上一轮的回答当成这一轮。
			const firstSeq = child.session.seq;
			currentOnWrite = req.memoryTool?.onWrite;
			hostError = null;
			maxTurnsExceeded = false;

			let runError: unknown = null;
			let dispatched = false;
			try {
				child.followup(userMessage(req.task));
				dispatched = true;
				await raceWithAbort(settled.promise, runSignal);
				// 这一轮已经收口，再等一次 quiescence 让宿主的 post-turn 工作落定；提前 resolve 也无所谓
				//（不会再有下一轮），所以不需要循环。
				await raceWithAbort(child.whenIdle(), runSignal);
			} catch (e) {
				runError = e;
				if (runSignal?.aborted === true) {
					try {
						child.cancel({ kind: "hook", reason: "the memory task was cancelled" });
					} catch {
						/* 已结束的会话取消失败：不是问题 */
					}
				}
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				currentOnWrite = undefined;
			}

			let summary: SessionSummary | null = null;
			try {
				summary = summarize(child.session.snapshotEvents(firstSeq));
			} catch (e) {
				runError ??= e;
			}

			// 超时优先判：组合 signal 两边都为真时，`aborted` 与 `timeout` 分不开，先看定时器。
			if (timedOut()) {
				return dispatched ? { status: "incomplete", cause: "aborted" } : { status: "not-run", cause: "timeout" };
			}
			// step 超限比 turn 自身的终止原因更可操作（模型陷进了工具循环），先报它。
			if (maxTurnsExceeded) return { status: "incomplete", cause: "turn-limit" };
			if (runError !== null) {
				if (req.signal?.aborted === true) {
					return dispatched ? { status: "incomplete", cause: "aborted" } : { status: "not-run", cause: "aborted" };
				}
				return { status: "not-run", cause: "host-refused", detail: errorMessage(runError) };
			}
			if (hostError !== null) return { status: "not-run", cause: "host-refused", detail: hostError };
			if (summary === null) return { status: "no-output" };
			if (summary.errorDetail !== null) {
				return { status: "not-run", cause: "host-refused", detail: summary.errorDetail };
			}
			if (summary.maxTokens) return { status: "incomplete", cause: "max-tokens" };
			if (summary.aborted) return { status: "incomplete", cause: "aborted" };
			if (summary.text.trim() === "") return { status: "no-output" };
			return { status: "completed", text: summary.text };
		},

		async dispose(): Promise<void> {
			try {
				await owned.dispose();
			} catch (e) {
				spec.warn("simple-memory: could not dispose the memory worker: %s", errorMessage(e));
			}
		},
	};
}
