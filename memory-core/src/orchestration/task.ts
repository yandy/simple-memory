import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { requiredModel, type MemoryConfig, type ModelTask, type SessionPersistenceConfig } from "../config.js";
import { BACKUP_DIR, type MemoryStore } from "../store/memory-store.js";
import { createSnapshot } from "../store/snapshot.js";
import { isReservedWindowsName } from "../store/windows-names.js";
import type { MemoryAction } from "../tool/actions.js";
import type {
	HeadlessOutcome,
	HeadlessRunRequest,
	HostTranscriptPort,
	IncompleteOutcome,
	OrchestrationPorts,
} from "./ports.js";

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
	/** 宿主自己的模型标识，已由 `runTask` 从 `cfg` 解析（`requiredModel`）。 */
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
export type Incomplete = { status: "no-input" } | { status: "lock-busy" } | IncompleteOutcome;

export interface MemoryTask<I, R> {
	readonly id: ModelTask;
	readonly plan: TaskPlan;
	/** `null` = core 自己判定这一轮不跑（候选为空、消息为空）。预算值自己从 `cfg` 读。 */
	buildPrompt(cfg: MemoryConfig, deps: TaskDeps, input: I): string | null;
	/** 回复 → 结果。必须防御式：dsh 的 stream 通道拿不到强制结构化输出。 */
	parse(cfg: MemoryConfig, deps: TaskDeps, input: I, text: string): R | Promise<R>;
	/** core 没跑、或端口没跑成时怎么呈现（三个任务词汇不同的唯一合法处）。 */
	notCompleted(cfg: MemoryConfig, deps: TaskDeps, input: I, why: Incomplete): R;
	/** 只有 extractMemories 实现：把 `input.onWrite` 透给子会话的工具。 */
	memoryToolHooks?(input: I): { onWrite?: MemoryToolOnWrite } | undefined;
}

/**
 * 构造端口请求：plan 的取值与 `runTask` 从 `cfg` 解析出的宿主参数在这里合流。
 *
 * 只收构造请求真正需要的入参，`cfg` 与 `TaskContext` 都不进来：解析留在 `runTask`
 * （model / effort / sessionPersistence 都从 `cfg` 读），请求形状因此只在这里写一遍。
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
	return cfg[task]?.sessionPersistence ?? cfg.defaults?.sessionPersistence;
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

/** 进入时快照要拍的目录条目：跳过 dotfile；win32 上再跳过保留设备名（CON 等）。 */
async function snapshotFiles(memoryDir: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
	const entries = await readdir(memoryDir, { withFileTypes: true }).catch(() => []);
	return (
		entries
			.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
			// win32：保留设备名文件按名打开会命中设备（CON 等），`createSnapshot` 的 cp 会失败；
			// dream 是 fail-closed 的，一次 cp 失败就打断整轮（与 `MemoryStore` 的 `#entryFiles` 同一契约）。
			.filter((entry) => !(platform === "win32" && isReservedWindowsName(entry.name)))
			.map((entry) => entry.name)
			.sort()
	);
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
	const effort = cfg[task.id]?.thinkLevel;
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

		let outcome: HeadlessOutcome;
		try {
			outcome = await ctx.ports.headless.run(request);
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
		if (outcome.status === "completed") return await task.parse(cfg, deps, input, outcome.text);
		return task.notCompleted(cfg, deps, input, outcome);
	};

	switch (task.plan.lock) {
		case "none":
			return run();
		case "logical": {
			const result = await ctx.store.tryWithLogicalLock(run);
			if (result === null) return task.notCompleted(cfg, deps, input, { status: "lock-busy" });
			return result;
		}
		case "logical+snapshot": {
			// 只有 dream 用这档锁。整轮持锁是刻意的：dream 的多次 `replace` / `remove` 必须对
			// 同进程的 `memory add` 与 extract 呈现为**一个**原子区间，否则用户会在 dream 中途读到
			// 半合并的状态。锁在进程内（不是 `.lock`），所以跨进程的其它 worktree 仍能正常写入 ——
			// 它们的每次物理写入只被挡毫秒级。
			//
			// 其内部的每个原语调用必须带 `{ skipLogicalLock: true, skipSnapshot: true }`（由
			// `memoryTool` 请求字段表达，适配层据此构造子会话的工具），否则它们会去抢自己已持有的
			// 锁而自锁到超时，并且会为同一批变更各拍一次快照。
			return ctx.store.withLogicalLock(async () => {
				// 启动自检：忘了包 withLogicalLock 会静默失去整轮互斥。
				if (!ctx.store.logicalLockActive()) {
					throw new Error(`${task.id} must run under the memory logical lock`);
				}

				// 进入时对整目录拍一次快照；这一轮里各原语的逐文件快照被 skipSnapshot 跳过。
				const files = await snapshotFiles(ctx.cwd, ctx.store.cfg.platform);
				await createSnapshot(join(ctx.cwd, BACKUP_DIR), task.id, files, ctx.cwd, {
					keep: ctx.store.cfg.lock.snapshotKeep,
					platform: ctx.store.cfg.platform,
				});

				return run();
			});
		}
	}
}
