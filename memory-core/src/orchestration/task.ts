import {
	requiredModel,
	type MemoryConfig,
	type ModelTask,
	type SessionPersistenceConfig,
} from "../config.js";
import type { MemoryStore } from "../store/memory-store.js";
import type { MemoryAction } from "../tool/actions.js";
import type {
	HeadlessRunRequest,
	HostTranscriptPort,
	IncompleteOutcome,
	OrchestrationPorts,
} from "./ports.js";
import { autoSurfacing } from "./surfacing.js";

/** 任务描述符里的编排骨架：全是 core 常量；两个 skip 由 `lock` 派生，不再单独编码。 */
export interface TaskPlan {
	maxTurns?: number;
	timeoutMs: number;
	/** 注入子会话的 memory 工具 action 集；`null` = 不注入。三个任务的 builtinTools 恒为 "none"。 */
	memoryTool: readonly MemoryAction[] | null;
	/** 互斥与快照：none / 整轮逻辑锁 / 逻辑锁 + 进入时全目录快照。 */
	lock: "none" | "logical" | "logical+snapshot";
	/** 端口抛错（传输级失败）时怎么办：surfacing 吞、extract 与 dream 上抛。 */
	errorPolicy: "swallow" | "rethrow";
}

/** 任务需要的 core 侧原料：store 恒有；transcript 只有 extract 用。 */
export interface TaskDeps {
	store: MemoryStore;
	transcript?: HostTranscriptPort;
}

/** 一次 `runTask` 调用的上下文：config 由 core 自己消费，适配层不再把它摊平成参数。 */
export interface TaskContext {
	cfg: MemoryConfig;
	cwd: string;
	store: MemoryStore;
	ports: OrchestrationPorts;
	signal?: AbortSignal;
}

/** `buildRequest` 的宿主侧参数：`cfg` 的值与 plan 一起在这里合流成端口请求。 */
export interface RequestHost {
	/** 子会话 cwd；三个任务恒为 memoryDir。 */
	cwd: string;
	/** 宿主自己的模型标识，已由调用方解析（`requiredModel`，或旧 `RunSideQueryOpts.model`）。 */
	model: string;
	/** 宿主自己的思考/推理档位，core 原样透传。 */
	effort?: string;
	/** 宿主的会话持久化开关，core 原样透传。 */
	sessionPersistence?: SessionPersistenceConfig;
	signal?: AbortSignal;
}

/** `memory` 工具的写入回调；只有实现了 `memoryToolHooks` 的描述符会产出它。 */
export type MemoryToolOnWrite = (info: { action: MemoryAction; name?: string }) => void;

/** `notCompleted` 收的 `why`：core 自己的判定，或端口给的非 completed 结果。 */
export type Incomplete =
	| { status: "no-input" }
	| { status: "lock-busy" }
	| IncompleteOutcome;

export interface MemoryTask<I, R> {
	readonly id: ModelTask;
	readonly plan: TaskPlan;
	/** `null` = core 自己判定这一轮不跑（候选为空、消息为空）。预算值自己从 `cfg` 读。 */
	buildPrompt(cfg: MemoryConfig, deps: TaskDeps, input: I): string | null;
	/** 回复 → 结果。必须防御式：dsh 的 stream 通道拿不到强制结构化输出。 */
	parse(cfg: MemoryConfig, deps: TaskDeps, input: I, text: string): R | Promise<R>;
	/** core 没跑、或端口没跑成时怎么呈现（三个任务词汇不同的唯一合法处）。 */
	notCompleted(cfg: MemoryConfig, deps: TaskDeps, input: I, why: Incomplete): R;
	/** 只有 extractMemories 实现：把 `input.onWrite` 透给子会话的工具（Task 5 用）。 */
	memoryToolHooks?(input: I): { onWrite?: MemoryToolOnWrite } | undefined;
}

/**
 * 任务注册表。
 *
 * 本轮只有 autoSurfacing 一个描述符（Task 4）；Task 6 在 dream 落地后把它扩成
 * `Record<ModelTask, MemoryTask<any, any>>`，中间任务不得为缺失条目造假对象。
 */
export const TASKS = { autoSurfacing } as const;

/**
 * 构造端口请求：plan 的取值与调用方的宿主参数在这里合流，`runTask` 与过渡期的 `runSideQuery` 共用。
 *
 * 只收构造请求真正需要的入参，`cfg` 与 `TaskContext` 都不进来：过渡期的 `runSideQuery` 没有 `cfg`，
 * 它的 model / effort / sessionPersistence 是调用方给的显式参数（见 `RunSideQueryOpts`）。解析留在
 * 调用方（`runTask` 从 `cfg` 读、`runSideQuery` 用入参），请求形状因此只在这里写一遍。
 */
export function buildRequest(
	task: MemoryTask<unknown, unknown>,
	prompt: string,
	host: RequestHost,
	onWrite?: MemoryToolOnWrite,
): HeadlessRunRequest {
	const plan = task.plan;
	return {
		task: prompt,
		cwd: host.cwd,
		model: host.model,
		effort: host.effort,
		maxTurns: plan.maxTurns,
		timeoutMs: plan.timeoutMs,
		signal: host.signal,
		// 三个任务的 builtinTools 恒为 "none"：侧查询只要一个 JSON，dream / extract 只走 memory 工具。
		builtinTools: "none",
		memoryTool:
			plan.memoryTool === null
				? null
				: {
						actions: plan.memoryTool,
						skipLogicalLock: plan.lock !== "none",
						skipSnapshot: plan.lock === "logical+snapshot",
						onWrite,
					},
		// 继承规则（per-task ?? defaults）由调用方在传参前解析完，这里只做透传。
		sessionPersistence: host.sessionPersistence,
	};
}

/** 会话持久化的继承规则：per-task ?? `defaults`。config 消费点收在 core，适配层不再各写一份。 */
function resolveSessionPersistence(cfg: MemoryConfig, task: ModelTask) {
	return cfg[task].sessionPersistence ?? cfg.defaults?.sessionPersistence;
}

/** 「宿主/库抛出来的任意值」→ 一句可读文本。core 不能 import 适配层的 errors.ts（中立性约束），
 *  这里只保留 `not-run.detail` 需要的最小口径：文本、Error、普通对象 `.message`，再退到 JSON / 兜底。 */
function errorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	try {
		const json = JSON.stringify(error);
		return typeof json === "string" ? json : "unknown error";
	} catch {
		return "unknown error";
	}
}

/**
 * 三个 LLM 任务的通用编排。顺序是契约：
 *
 * 1. 读模型（缺模型在这里抛可读错误，而不是发出 `model: ""` 的请求）；
 * 2. 读 effort / sessionPersistence；
 * 3. `buildPrompt`，`null` → `notCompleted({ status: "no-input" })`（在**任何锁之前**）；
 * 4. 施加 `plan.lock`（`logical` 拿不到锁 → `notCompleted({ status: "lock-busy" })`）；
 * 5. 端口调用（传输级异常按 `plan.errorPolicy` 收口）；
 * 6. `completed` → `parse`；其余 → `notCompleted(outcome)`。
 */
export async function runTask<I, R>(task: MemoryTask<I, R>, input: I, ctx: TaskContext): Promise<R> {
	const cfg = ctx.cfg;
	const deps: TaskDeps = { store: ctx.store, transcript: ctx.ports.transcript };

	const model = requiredModel(cfg, task.id);
	const effort = cfg[task.id].thinkLevel;
	const sessionPersistence = resolveSessionPersistence(cfg, task.id);

	const prompt = task.buildPrompt(cfg, deps, input);
	if (prompt === null) return task.notCompleted(cfg, deps, input, { status: "no-input" });

	const run = async (): Promise<R> => {
		const request = buildRequest(
			task,
			prompt,
			{ cwd: ctx.cwd, model, effort, sessionPersistence, signal: ctx.signal },
			task.memoryToolHooks?.(input)?.onWrite,
		);

		try {
			const outcome = await ctx.ports.headless.run(request);
			if (outcome.status === "completed") return await task.parse(cfg, deps, input, outcome.text);
			return task.notCompleted(cfg, deps, input, outcome);
		} catch (e) {
			if (task.plan.errorPolicy === "swallow") {
				return task.notCompleted(cfg, deps, input, {
					status: "not-run",
					cause: "host-refused",
					detail: errorMessage(e),
				});
			}
			throw e;
		}
	};

	switch (task.plan.lock) {
		case "none":
			return run();
		case "logical": {
			const result = await ctx.store.tryWithLogicalLock(run);
			if (result === null) return task.notCompleted(cfg, deps, input, { status: "lock-busy" });
			return result;
		}
		case "logical+snapshot":
			// 只有 dream 用这档锁，而 dream 描述符在 Task 6 才落地；在此之前没有任务能走到这里。
			throw new Error(`lock "${task.plan.lock}" is not implemented yet`);
	}
}
