import { runTask, TASKS } from "@yandy0725/memory-core";
import type { HeadlessAgentPort, HostTranscriptPort } from "@yandy0725/memory-core";
import type { SessionLogLike } from "./agent-session.js";
import { errorMessage } from "./errors.js";
import type { SessionMemoryRuntime } from "./store-registry.js";
import { isRootAgent } from "./store-registry.js";

/**
 * extractMemories 的**触发点**：`agent/turn-stopping`。
 *
 * 选这个事件而不是别的三个候选：
 * - `agent/turn-stopping` 是「这一轮即将收口」的串行事件（被 await，然后边界才提交），与 pi 的
 *   `agent_end` 语义最接近：一轮对话结束、消息齐全、模型不再欠任何回复；
 * - `agent/disposed` 太晚（会话已经走了，长会话里等于永不触发）；
 * - `agent/pre-step` 每个 step 都会发，一轮里会重复触发 N 次。
 *
 * 监听器本身**同步返回**：extract 是一次 120s 的 headless 调用，把它 await 进去等于把每一轮都
 * 拖慢到「抽取跑完」。所以这里是 fire-and-forget（与 pi 的 `agent_end` 同一条做法），两条链
 * 都自己兜住错误，绝不产生 unhandled rejection。
 *
 * `enabled` 在这里判：它是**触发点决策**（设计稿 §6.5 明确允许适配层读它），core 只在该跑的
 * 时候才该收到调用。
 */

export interface ExtractListenerDeps {
	registry: { get(sessionId: string): SessionMemoryRuntime | undefined };
	/** 按会话运行时构造端口：`memory` 工具要绑到这条会话的 store / config / cwd 上。 */
	headlessFor(rt: SessionMemoryRuntime): HeadlessAgentPort;
	transcript: HostTranscriptPort;
	warn(message: string, ...params: unknown[]): void;
	info(message: string, ...params: unknown[]): void;
}

/** `agent/turn-stopping` 的 payload 里我们用到的那一片：会话 id、header 与事件日志。 */
export interface TurnStoppingPayloadLike {
	agent: {
		// header 用内联字面量类型（而不是 `Record<string, unknown>`）：宿主的 `SessionHeader` 是
		// 一个有具名可选字段的接口，没有索引签名；内联字面量会在结构上接受它，`isRootAgent` 也认。
		session: SessionLogLike & {
			id: string;
			header?: { cwd?: string; origin?: string; delegationDepth?: number; parentSession?: string };
		};
	};
}

export interface ExtractTrigger {
	/** `agent/turn-stopping` 的监听器本体（同步返回，抽取在后台继续）。 */
	(payload: TurnStoppingPayloadLike): void;
	/**
	 * 尽力等完在途的抽取（最多 `timeoutMs`）。
	 *
	 * 为什么需要：抽取是 fire-and-forget，而 `dsh headless` 这种一次性宿主在父轮结束后**立刻退出
	 * 进程**，在途的子会话会被 `aborted/disposed` 打断（真机实测）。长寿命宿主（web / TUI）本来
	 * 就不会退出，但卸载/切会话时同样需要这个窗口。返回 false 表示还有任务没跑完。
	 */
	drain(timeoutMs?: number): Promise<boolean>;
}

export function createTurnStoppingListener(deps: ExtractListenerDeps): ExtractTrigger {
	const inFlight = new Set<Promise<unknown>>();

	const listener = (payload: TurnStoppingPayloadLike): void => {
		// 整个函数同步返回；内部任何一步失败都只记一行 —— 这是宿主 await 的串行监听器，
		// 抛错会变成「这一轮收口失败」，而抽取只是增强。
		try {
			const agent = { session: payload.agent.session };
			// 子会话（我们自己的 extract / dream 子会话、以及宿主的 subagent）不跑抽取：它们没有
			// 记忆层运行时，也不该按自己的对话去写记忆。
			if (!isRootAgent(agent)) {
				return;
			}

			const sessionId = payload.agent.session.id;
			const rt = deps.registry.get(sessionId);
			// 没运行时 = 这条会话没挂记忆层（配置坏了 / 子 agent / 未 prepare）：不跑，也不报。
			if (rt === undefined) return;
			// 收窄后立刻落成 const：延迟到宏任务执行时，TS 不再保留属性上的 null 收窄。
			const store = rt.store;
			const memoryDir = rt.memoryDir;
			const cfg = rt.config;
			if (store === null || memoryDir === null) return;
			// 触发点决策：没开启就不该调 `runTask`（连带的模型/锁都不该碰）。
			if (cfg.extractMemories?.enabled !== true) {
				return;
			}

			// **同步**取一份事件快照：`turn-stopping` 之后宿主还会追加 `turn/end`，而我们要的是
			// 「这一轮已经发生的对话」。同步快照也让我们在异步链里不再回头读宿主对象。
			let events: readonly unknown[];
			try {
				events = payload.agent.session.snapshotEvents();
			} catch (e) {
				deps.warn("simple-memory: extract skipped, could not read the session transcript: %s", errorMessage(e));
				return;
			}
			if (events.length === 0) return;

			// 本轮经子会话的 `memory` 工具真实写入了几条（core 的 `onWrite` 回调）。声明在闭包之前。
			let written = 0;
			const run = runTask(
				TASKS.extractMemories,
				{
					// dsh 的对话**就是**会话事件日志；`transcript.toExtractMessages` 负责解释它
					// （core 只把 `messages` 当 `unknown[]` 转手，两个适配层的差别被这个接缝吃掉）。
					messages: events as unknown[],
					// dsh 没有 pi 的 `<project_instructions path="…">` 片段：AGENTS.md 由
					// `dsh-agent-instructions` 拼成不透明的 prompt 文本，适配层没有稳定的标记可以
					// 把它们切出来。所以 extract prompt 的「## AGENTS.md Rules」段落在 dsh 侧为空 ——
					// 这一点写进 README，而不是在适配层猜宿主 prompt 的格式。
					agentsMdBlocks: [],
					onWrite: () => {
						written += 1;
					},
				},
				{
					cfg,
					cwd: memoryDir,
					store,
					ports: { headless: deps.headlessFor(rt), transcript: deps.transcript },
				},
			);

			// 记账：卸载/退出时 `drain()` 用它等在途的抽取。
			//
			// 注意 `run.catch(...)` 这一层不是装饰：extract 的 `errorPolicy` 是 `rethrow`，而 `run` 的
			// 失败只由下面那个两参 `.then` 处理；若把 `run.finally(...)` 直接放进 `inFlight`，派生出的
			// 那个 promise 没人接管 —— 它会变成一个未处理拒绝（CI 上真的红了）。记账用的这一份必须
			// **永不 reject**。
			const tracked = run.catch(() => undefined).finally(() => inFlight.delete(tracked));
			inFlight.add(tracked);

			// 两参 `.then`（而不是 `.then().catch()`）：成功分支自己抛错只会进它自己的分支，
			// 不会被失败回调接住而误报成抽取失败。
			void run.then(
				(result) => {
					// 只有「没被锁跳过」且「真的写了东西」才报数：否则每轮都写一行空日志。
					if (result.skipped || written === 0) return;
					deps.info("simple-memory: extracted %d %s", written, written === 1 ? "memory" : "memories");
				},
				(e: unknown) => {
					deps.warn("simple-memory: extract failed: %s", errorMessage(e));
				},
			);
		} catch (e) {
			deps.warn("simple-memory: extract skipped: %s", errorMessage(e));
		}
	};

	return Object.assign(listener, {
		async drain(timeoutMs = 5_000): Promise<boolean> {
			if (inFlight.size === 0) return true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			});
			try {
				const done = await Promise.race([Promise.allSettled([...inFlight]).then(() => true as const), timeout]);
				return done === true;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		},
	});
}
