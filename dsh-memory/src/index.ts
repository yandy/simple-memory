import type { HeadlessAgentPort, MemoryToolOnWrite } from "@yandy0725/memory-core";
import { MEMORY_TOOL_GUIDELINES, MEMORY_TOOL_SNIPPET, projectIdentity, TASKS, taskModel } from "@yandy0725/memory-core";
import type { AgentsLike, NestedMemoryToolOptions, SessionWorker } from "./agent-session.js";
import { createSessionWorker } from "./agent-session.js";
import { createDreamCommand, createMemoryCommand } from "./commands.js";
import { errorMessage } from "./errors.js";
import { createTurnStoppingListener } from "./extract.js";
import type { LlmLike } from "./headless.js";
import { createDshHeadless } from "./headless.js";
import type { Context, HostPreStepDecision, HostPromptSection, HostToolDefinition } from "./host-types.js";
import { createIndexCache } from "./index-cache.js";
import { createMemoryTool } from "./memory-tool.js";
import type { ModuleAvailability, ResolveCallConfig } from "./model.js";
import { resolveSurfacingAvailability } from "./model.js";
import { resolveRowConfig, rowConfigSetKeys } from "./row-config.js";
import type { SessionQueryLike } from "./session-search.js";
import { createSessionSearch } from "./session-search.js";
import type { AgentLike, HostDirLike, SessionMemoryRuntime } from "./store-registry.js";
import { createStoreRegistry, isRootAgent } from "./store-registry.js";
import { createPreStepListener } from "./surfacing.js";
import type { PendingRecall } from "./surfacing.js";
import type { DshSyncSession } from "./sync.js";
import { createDshSyncRuntime, syncErrorMessage } from "./sync.js";
import { createDshTranscript } from "./transcript.js";

/**
 * dsh-memory 的 cordis 插件入口：把九个模块装配成一个 bundle。
 *
 * 装配顺序：行 config → auto-surfacing 可用性 → 四个 per-session 容器 → 端口（零工具侧查询 /
 * 嵌套子会话）→ 全局注册（section + `/memory` + `/dream`，每进程一次）→ per-agent 生命周期
 * （created / disposed）→ 每轮召回（pre-step waterfall）→ 每轮结束的抽取（turn-stopping）。
 *
 * 两条贯穿全局的约束：
 *
 * - **`apply` 绝不抛错**（原则：降级，不失败）。宿主把抛错的 `apply` 当成激活失败，于是配置写错的
 *   用户看到的是「插件没起来」而不是「哪一行写错了」。所以坏配置一律记进 `resolved.error`，
 *   照常注册 section 与命令，让 `/memory` 与 memory 工具的报错把原因说出来。
 * - **per-session 状态一律挂在闭包里，绝不挂模块级**：`apply` 每进程只跑一次（配置变更 / HMR 才重跑），
 *   而一个长寿命宿主进程会服务很多会话。每个会话的账本都要在 `agent/disposed` 里销掉，否则无界增长。
 */

export const name = "simple-memory";

/**
 * 用到的服务逐个列全（宿主插件实践文档 `practices.md`）：`inject` 里任一服务缺席时，插件保持
 * inactive（fiber pending）而不是在激活时抛错。所以精简 profile 里缺 `sessionQuery` 的表现是
 * 「记忆层整体不挂」—— 这正是想要的：宁可整体不挂，也不要半挂着（半挂意味着索引在、召回静默失效）。
 *
 * `agents` 是 extract / dream 必需的：它们的子会话必须跑真实的工具循环，而 dsh 里只有 agent 会跑
 * （`ctx.llm.stream()` 不带工具循环）。缺 `agents` 时整个 bundle 不挂，而不是「召回在、dream 静默
 * 不工作」—— 后者是更难查的半挂状态。
 *
 * **`logger` 绝不能出现在这里**：`ctx.logger` 是 cordis 在 `Context` 构造器里赋的**普通属性**
 *（`cordis/lib/index.js:1760`：`this.logger = new LoggerService(self)`），从不注册进服务表。把它写进
 * `inject` 会让 fiber 永远停在 `pending (waiting for service: logger)` —— 插件在真宿主里**一次都
 * 不会激活**（索引段、`/memory`、`memory` 工具全都不出现，模型只能退回去写 AGENTS.md），而单元
 * 测试里假 ctx 直接把它当属性给，永远不会发现。`ctx.logger` 照样能用：属性访问不需要注入。
 */
export const inject = [
	"tools",
	"systemPrompt",
	"llm",
	"agents",
	"commands",
	"workingDirectory",
	"sessionQuery",
] as const;

/** 索引 section 的名字与位次：宿主 `SECTION_ORDERS` 里 4000 未被占用（MCP_SERVERS 3100 … TOOLS_SDK 5000）。 */
const INDEX_SECTION_NAME = "memory_index";
const INDEX_SECTION_ORDER = 4000;

/** per-agent effect 的标签，出现在宿主 `fiber.getEffects()` 的诊断树里。 */
const AGENT_EFFECT_LABEL = "memory/agent";

/** 一个会话的工具注册清理项（双 owner：agent 的 fiber 与我们的 fiber 各持一份 disposer）。 */
interface SessionCleanup {
	disposeTool(): void;
	disposeEffect?(): void;
}

/**
 * core 的 `MEMORY_TOOL_GUIDELINES` 是一个字符串数组（一条规则一项），而宿主只给我们一个纯文本
 * 通道，所以得自己拼：一条一行、`- ` 前缀 —— 与 pi 侧模型看到的渲染同式（pi-memory 把数组
 * 原样交给 `ToolDefinition.promptGuidelines`，pi 宿主再把每条渲染成 `- <rule>` 并逐行拼接）。
 * 文本逐字来自 core：不 trim、不去重、不改写（提示词文本是用户契约，改一个字就同时改了两个宿主）。
 */
const GUIDELINES_BLOCK = MEMORY_TOOL_GUIDELINES.map((rule) => `- ${rule}`).join("\n");

/**
 * `memory_index` section 的静态前缀：snippet → guidelines。两个通道的出现判据完全相同，
 * 所以合成一块；它是静态文本，能被宿主的 prompt cache 命中，相对于索引本身最多 16KB 的
 * 注入预算占比很小。
 */
const PROMPT_PREAMBLE = `${MEMORY_TOOL_SNIPPET}\n\n${GUIDELINES_BLOCK}`;

function runCleanup(cleanup: SessionCleanup | undefined): void {
	if (cleanup === undefined) return;
	// 先撤注册本身，再撤我们 effect 里的副本。宿主的 undo 明确幂等（dsh-scope `NamedEntries.insert`
	// 的文档：「an idempotent undo for that exact entry」），所以两次调用不会把别人的注册摘掉。
	cleanup.disposeTool();
	cleanup.disposeEffect?.();
}

export async function apply(ctx: Context, config: unknown): Promise<() => void> {
	// 1. 行 config：唯一的配置来源（刻意不读任何配置文件）。`resolveRowConfig` 永不抛错：
	//    非对象 → error 非空，类型不对的键 → warnings，两者都由 /memory 打印。
	const resolved = resolveRowConfig(config);
	if (resolved.error !== null) ctx.logger.warn("simple-memory: %s", resolved.error);

	// 2. 接线边界：宿主服务 → 我们模块的结构化接缝。三处都是结构化可赋值，**无需 cast**；
	//    唯一的例外是下面 `resolveCallConfig`（宿主把 reasoningEffort 定成 branded string）。
	const dirs: HostDirLike = ctx.workingDirectory;
	const sessionQuery: SessionQueryLike = ctx.sessionQuery;
	const llm: LlmLike = ctx.llm;

	// 3. 启动期判定 auto-surfacing 是否可用。`resolveSurfacingAvailability` 自己兜住了「没配模型」与
	//    「宿主拒绝该模型」，这里再兜一层「服务形状不是我们预期的」（含 bind 本身）：apply 抛错 =
	//    整个 bundle 激活失败，而降级只是少一个模块。
	let surfacing: ModuleAvailability;
	try {
		// `resolveCallConfig` 是方法，直接摘下来会丢掉 `this`，所以先 bind。宿主签名收
		// `LlmCallConfig`（`reasoningEffort?: ReasoningEffortId`，品牌化 string），而 model.ts 的接缝刻意
		// 用裸 string 以便脱离宿主单测；运行时是同一个字符串，所以只在接线处收窄这一次。
		const resolveCallConfig = ctx.llm.resolveCallConfig.bind(ctx.llm) as ResolveCallConfig;
		// 10s 上界是刻意的，不是防御性装饰：这个 await 发生在**任何**注册（索引 section、/memory、
		// 三个 ctx.on）之前，而 `resolveCallConfig` 会进宿主的 capability 查找、自己没有任何 deadline。
		// 一旦它挂起，`apply` 就永远不 settle —— 没有索引 section、没有 /memory、没有工具、没有监听器，
		// 而且连一行日志都没有（因为根本没抛错）。这是比「抛错型激活失败」更糟的静默失败。
		// 有界之后，abort 会走 model.ts 既有的 try，降级成 `{ available: false, reason }` —— 正是「降级而
		// 不失败」要的路径，所以不需要任何新的错误处理。别把它当「多余」删掉。
		surfacing = await resolveSurfacingAvailability(resolved.config, resolveCallConfig, AbortSignal.timeout(10_000));
	} catch (e) {
		surfacing = { available: false, reason: `autoSurfacing could not be resolved: ${errorMessage(e)}` };
	}

	// 4. per-session 容器：全部挂在闭包里（apply 每进程只跑一次，会话却有很多）。
	const registry = createStoreRegistry(dirs);
	const indexCache = createIndexCache();
	const searchSessions = createSessionSearch(sessionQuery);
	/** 零工具端口：autoSurfacing 的侧查询（零工具是意图本身，不需要会话、不需要工具循环）。 */
	const zeroToolHeadless = createDshHeadless(llm);
	/**
	 * 宿主 agent 注册表的结构化接缝。extract / dream 的子会话由它创建（`ctx.agents.create`）：
	 * 这是 dsh 里唯一能拿到「带工具循环的会话」的公开入口（设计稿 §4.1）。
	 */
	/**
	 * `agents` 服务：子会话的唯一创建入口。
	 *
	 * **已知限制（真机实测，未解决）**：`AgentRegistry.create()` 用 `this.ctx` 作为子 agent 的
	 * owner，而 cordis 的 traceable 机制把 `this.ctx` 解析成「访问服务时的调用方作用域」。
	 * 在 `agent/turn-stopping` / `agent/status` 的派发里创建子会话会抛
	 * `cannot create effect on inactive context`；同样调用在 `apply` 期间、以及 `agent/created`
	 * 期间都是成功的。插件作用域绑定、agent 作用域（`agent.ctx.agents`）绑定、宏任务延迟三种写法
	 * 都复现该错误，所以 owner 的解析点还没找到。README 的「验证状态」里写明了这条。
	 */
	/** 插件作用域下的 `agents` 服务（兜底）。子会话优先用 agent 作用域的绑定，见 `agentAgents`。 */
	const agents: AgentsLike = ctx.agents;
	/** extract 的对话来源与 `search scope=sessions` 共用一份 dsh 实现。 */
	const transcript = createDshTranscript(searchSessions);
	/**
	 * 按会话运行时现造的端口。**为什么不是全局一个**：`memory` 工具必须绑到**这条会话**的
	 * store / config / cwd 上（子会话自己拿不到运行时的写入通道），而 `run(req)` 的签名里没有
	 * sessionId。所以端口在调用点按 `rt` 生成 —— 与 pi 的 `headlessFor(ctx)` 同款做法。
	 *
	 * 零工具的请求（autoSurfacing 侧查询）走 `llm.stream()`：它不需要会话，也就不会在宿主的会话
	 * 日志里留下子会话。
	 */
	const headlessFor = (rt: SessionMemoryRuntime): HeadlessAgentPort => ({
		run(req) {
			// 零工具的侧查询（autoSurfacing）不需要会话，直接走 `llm.stream()`。
			if (req.builtinTools === "none" && req.memoryTool === null) return zeroToolHeadless.run(req);

			const slot = workers.get(rt.sessionId);
			if (slot === undefined) {
				return Promise.resolve({
					status: "not-run" as const,
					cause: "host-refused" as const,
					detail: "no memory worker is prepared for this session",
				});
			}
			if (slot.failure !== null) {
				return Promise.resolve({ status: "not-run" as const, cause: "host-refused" as const, detail: slot.failure });
			}
			// 按 action 集（= 任务）挑 worker：extract 5 个、dream 7 个，两者能力面不同，不能混用。
			const memoryTool = req.memoryTool;
			if (memoryTool === null) {
				return Promise.resolve({
					status: "not-run" as const,
					cause: "host-refused" as const,
					detail: "no memory tool requested",
				});
			}
			const actions = memoryTool.actions;
			const isDream = actions === TASKS.dream.plan.memoryTool;
			const worker = isDream ? slot.dream : slot.extract;
			if (worker === null) {
				return Promise.resolve({
					status: "not-run" as const,
					cause: "host-refused" as const,
					detail: isDream
						? 'dream has no prepared worker for this session: this adapter creates its sub-session at session start, so add a "dream" key (for example dream: { model: "<provider>/<model>" }) to the plugin row config and restart the session'
						: "extractMemories has no prepared worker for this session",
				});
			}
			return worker.run(req);
		},
	});
	/** sessionId → 本会话已注入过召回的 entry 文件名。surfacing 读写它，装配层负责在会话结束时销账。 */
	const injected = new Map<string, Set<string>>();
	/**
	 * sessionId → 在途召回（prefetch）状态。传输写入在 surfacing 侧；装配层只负责在会话边界作废它
	 * （compact / clear / disposed）——「哪一代 agent 的召回」不能跨代复用。
	 */
	const pendingRecalls = new Map<string, PendingRecall>();
	/**
	 * sessionId → **agent 作用域**下的 `agents` 服务绑定。
	 *
	 * 子会话必须通过它创建：cordis 的 traceable 机制会把 `create()` 的 owner 解析成「访问服务时的
	 * 调用方作用域」。用插件作用域的 `ctx.agents` 在 `agent/turn-stopping` 里创建，owner 就是
	 * **正在收口的那一轮**（fiber 已失活）→ 抛 `cannot create effect on inactive context`（真机实测：
	 * 同样调用在 apply 期间、在 agent 作用域下都成功）。用 `agent.ctx` 的绑定，owner 是这条会话的
	 * agent（活着），子会话也因此随 agent 一起被回收。
	 */
	const agentAgents = new Map<string, AgentsLike>();
	/**
	 * sessionId → 该会话的**常驻子会话**（extract / dream 各一个）。
	 *
	 * 为什么常驻：`agents.create()` 只有在**会话启动阶段**（`agent/created`）才能成功；在
	 * `agent/turn-stopping` 的派发里创建会抛 `cannot create effect on inactive context`（真机实测，
	 * 三种绑定方式 + 宏任务延迟全部复现）。所以建会话提前到这里，每一轮只往里 `followup` 一条消息。
	 * 代价：每个会话多一条**空的**子会话记录（只在相关任务启用时才建，见下方的门禁）。
	 */
	const workers = new Map<
		string,
		{ extract: SessionWorker | null; dream: SessionWorker | null; failure: string | null }
	>();
	/** sessionId → 工具注册的清理项。 */
	const cleanups = new Map<string, SessionCleanup>();
	/** sessionId → 同步运行时与当前提示。dispose 只 abort/drain，绝不在 dsh 做退出 flush。 */
	const syncSessions = new Map<string, DshSyncSession>();

	/** 删除账本并等待该 runtime 已登记的手动/自动在途轮次 settle；重复调用是 no-op。 */
	function disposeSyncSession(sessionId: string): Promise<void> | undefined {
		const state = syncSessions.get(sessionId);
		if (state === undefined) return undefined;
		syncSessions.delete(sessionId);
		return state.runtime?.dispose().catch((error: unknown) => {
			ctx.logger.warn("simple-memory: memory sync cleanup failed: %s", syncErrorMessage(error));
		});
	}

	function recordSyncErrors(state: DshSyncSession, values: readonly string[]): void {
		const fresh = values.map(syncErrorMessage).filter((value) => value.trim() !== "" && !state.errors.includes(value));
		if (fresh.length === 0) return;
		state.errors = [...state.errors, ...fresh];
		for (const message of fresh) ctx.logger.warn("simple-memory: memory sync: %s", message);
	}

	function recordSyncNotices(state: DshSyncSession, values: readonly string[]): void {
		const fresh = values.map(syncErrorMessage).filter((value) => value.trim() !== "" && !state.notices.includes(value));
		if (fresh.length === 0) return;
		state.notices = [...state.notices, ...fresh];
		for (const message of fresh) ctx.logger.info("simple-memory: memory sync notice: %s", message);
	}

	// 5. 全局注册（每进程一次）。宿主的 `section()` / `register()` / `on()` 内部就是
	//    `ctx.fiber.effect(...)`（dsh-system-prompt/lib/index.js:257、dsh-tools:441、dsh-commands:268、
	//    cordis events `register()`），所以这些注册已经归我们的 fiber 所有、随 fiber 卸载而撤销，
	//    不需要（也不该）再套一层自己的 effect —— 那只会让同一个 disposer 进两次账。
	const section: HostPromptSection = {
		name: INDEX_SECTION_NAME,
		order: INDEX_SECTION_ORDER,
		// 硬要求：索引正文是用户与模型写的，可能含 `{{`；宿主的渲染器会插值 section 文本，
		// 遇到未知/畸形的 `{{...}}` 直接抛错 —— 一次写坏的索引就会让整个 system prompt 装配失败。
		interpolate: false,
		// text 必须是全函数：宿主每次装配都调它（诊断路径还会传一个没有 agent 的 `{}`），
		// 查不到运行时（没 prepare 过、子 agent、诊断路径）就返回空串，永不抛错、永不返回 undefined。
		//
		// 三通道文案里有两个落在这里：dsh 的 ToolSchema 没有 pi 的 `promptSnippet` / `promptGuidelines`
		// 通道，这个 section 是唯一能把它们递给模型的通道。**出现判据：该 session 有 runtime**
		// （`registry.get(sessionId) !== undefined`），那正是 `agent/created` 给该 agent 注册工具的条件 ——
		// 工具在，工具文案就在，与 pi 一致（子 agent 拿不到 runtime，自然两样都拿不到）。拼接规则：
		//   无 runtime → ""
		//   有 runtime 且索引空 → snippet + guidelines（新项目第一次被告知工具存在的时机）
		//   有 runtime 且索引非空 → snippet + guidelines + 索引正文（每段之间空一行）
		// guidelines 也要落进来的理由：记忆目录是共享的，所以**写入质量是跨宿主的** —— guidelines
		// 管的正是写入质量（「description 必须自足」及其正反例），dsh 会话写出含糊的 description 会
		// 连带降低 pi 会话的召回质量。
		// 只在前面拼，索引正文本身逐字不动（跨宿主字节恒等是硬要求，见 index-cache.ts）。
		text: (context) => {
			const sessionId = context.agent?.session.id ?? "";
			if (registry.get(sessionId) === undefined) return "";
			const indexBody = indexCache.read(sessionId);
			return indexBody === "" ? PROMPT_PREAMBLE : `${PROMPT_PREAMBLE}\n\n${indexBody}`;
		},
	};
	ctx.systemPrompt.section(section);
	// 用户在行 config 里写过的白名单顶层键，交给 `/memory` 就地报出未实现的任务
	//（那些算未实现、是否只在真写了该键时才显示、怎么措辞，都在 commands.ts 的 renderStatus）。
	const setKeys = rowConfigSetKeys(config);
	ctx.commands.register(
		createMemoryCommand({
			registry,
			indexCache,
			warnings: resolved.warnings,
			setKeys,
			sync: { get: (sessionId) => syncSessions.get(sessionId) },
			warn: (message, ...params) => ctx.logger.warn(message, ...params),
			info: (message, ...params) => ctx.logger.info(message, ...params),
		}),
	);
	// `/dream`：整目录整理。命令立刻返回「已开始」，摘要在宿主日志里（dream 的 timeout 是 600s，
	// 不能把命令处理器挂在那里等）。
	ctx.commands.register(
		createDreamCommand({
			registry,
			headlessFor,
			warn: (message, ...params) => ctx.logger.warn(message, ...params),
			info: (message, ...params) => ctx.logger.info(message, ...params),
		}),
	);

	// 6. `agent/created`：串行、且在创建完成前被 await —— 这是唯一的异步窗口。记忆目录要探 git remote
	//    （异步），而 core 的工具 handler 只能在执行时同步 `getStore()`，所以目录必须在这里解析完。
	ctx.on("agent/created", async ({ agent, source, signal }) => {
		const like: AgentLike = agent; // 宿主 Agent 结构化满足我们的接缝，无需 cast
		// 子 agent 门禁：`agent/created` 对每个 agent 都发（子 agent 由 dsh-subagent 走 ctx.agents.create，
		// 根 ctx 的监听器看得到全部）。不过滤的话每个子 agent 都要付一次 git 探测 + 建 store，
		// 且每轮多付一次侧查询。判据是 `session.header.origin`（见 isRootAgent）。
		if (!isRootAgent(like)) return;
		const sessionId = like.session.id;
		// 宿主 compact / clear 会用**同一个 sessionId** 重建 agent：被挤掉的召回正文不再在上下文里，
		// 去重状态与在途召回必须随之作废，否则这些文件在本会话里永不再浮现（正文已不在历史里）。
		// `startup` / `resume` 相反：历史还在，去重状态必须保留。
		if (source === "compact" || source === "clear") {
			injected.delete(sessionId);
			pendingRecalls.delete(sessionId);
		}
		// 同一 session 重建时先收掉上一代 engine/timer，避免旧自动轮次跨代写远端。
		await disposeSyncSession(sessionId);

		// prepare 永不抛错：失败也给一个 store=null + error 的 runtime，让 /memory 与工具报错说出原因。
		const rt = await registry.prepare(like, resolved, surfacing, signal);
		const syncState: DshSyncSession = { runtime: null, errors: [], notices: [], persistentErrors: [] };
		syncSessions.set(sessionId, syncState);
		const isCurrent = () => syncSessions.get(sessionId) === syncState;

		// 同步只是非致命增强：init/startup 的任何失败都只进同步账本与宿主日志。
		// 这一段必须排在首次 indexCache.refresh 之前，startup push 拉下的 entry 才能进第一份 prompt 快照。
		if (rt.store !== null && rt.memoryDir !== null && rt.config.sync?.enabled === true) {
			try {
				const identity = await projectIdentity(rt.cwd);
				if (!isCurrent()) return;
				const assembled = await createDshSyncRuntime({
					config: rt.config,
					store: rt.store,
					projectDir: rt.memoryDir,
					identity,
				});
				if (!isCurrent()) {
					await assembled.runtime?.dispose();
					return;
				}
				syncState.runtime = assembled.runtime;
				syncState.persistentErrors = [...assembled.errors];
				recordSyncErrors(syncState, assembled.errors);
				recordSyncNotices(syncState, assembled.notices);
				if (assembled.runtime) {
					const started = await assembled.runtime.startup((warning) => recordSyncNotices(syncState, [warning]));
					if (!isCurrent()) return;
					if (!started.ok) {
						recordSyncErrors(syncState, [started.reason]);
					} else {
						if (started.warning) recordSyncNotices(syncState, [started.warning]);
						if (started.value !== null && !started.value.ok) {
							recordSyncErrors(syncState, [started.value.skipped?.reason ?? "memory sync startup round failed"]);
						}
					}
				}
			} catch (error) {
				if (!isCurrent()) return;
				recordSyncErrors(syncState, [syncErrorMessage(error)]);
			}
		}
		if (!isCurrent()) return;
		await indexCache.refresh(rt);

		/** 主工具与常驻 worker 共用：先保留原回调，再把每次成功写交给当前 engine。 */
		const writeHook = (onWrite: MemoryToolOnWrite | undefined, refresh: boolean): MemoryToolOnWrite => {
			return (info) => {
				onWrite?.(info);
				syncSessions.get(sessionId)?.runtime?.noteWrite();
				if (refresh) void indexCache.refresh(rt).catch(() => {});
			};
		};
		// 记住这条会话 agent 作用域下的 `agents` 服务（子会话的 owner 用它）。
		const scopedAgents = (like as unknown as { ctx?: { agents?: AgentsLike } }).ctx?.agents;
		if (scopedAgents !== undefined) agentAgents.set(sessionId, scopedAgents);

		// 会话启动阶段（允许建子会话的唯一时机）把 worker 建好。零成本默认：只有相关任务被显式
		// 启用（extract）或用户写了 `dream` 键时才建，避免给每个会话留一对空子会话。
		// dream worker 只在用户**显式配了** dream 键时才建（`/dream` 是手动命令，没写就别为它留一个空
		// 子会话）。没建时 `/dream` 会返回一条可操作的报错，而不是静默什么都不做。
		const wantsDream = setKeys.includes("dream");
		if (rt.store !== null && rt.memoryDir !== null) {
			const ownerAgents = scopedAgents ?? agents;
			const extractPlan = TASKS.extractMemories.plan;
			const dreamPlan = TASKS.dream.plan;
			const buildTool = (options: NestedMemoryToolOptions): unknown =>
				// worker（extract / dream）**不**传 `onContentSeen`：它们读到的正文只进了子会话，主模型没见过，
				// 标成「已见过」会把本该浮现的条目吞掉。
				createMemoryTool(rt, { searchSessions, onWrite: writeHook(options.onWrite, false) }, options);
			const makeWorker = async (task: "extractMemories" | "dream") => {
				const plan = task === "dream" ? dreamPlan : extractPlan;
				const model = taskModel(rt.config, task);
				if (model === undefined || plan.memoryTool === null) return { worker: null, error: null };
				const result = await createSessionWorker({
					agents: ownerAgents,
					cwd: rt.memoryDir as string,
					model,
					effort: rt.config[task]?.thinkLevel,
					actions: plan.memoryTool,
					skipLogicalLock: plan.lock !== "none",
					skipSnapshot: plan.lock === "logical+snapshot",
					maxTurns: plan.maxTurns,
					buildMemoryTool: buildTool,
					warn: (message, ...params) => ctx.logger.warn(message, ...params),
				});
				return "error" in result ? { worker: null, error: result.error } : { worker: result, error: null };
			};

			const slot = {
				extract: null as SessionWorker | null,
				dream: null as SessionWorker | null,
				failure: null as string | null,
			};
			if (rt.config.extractMemories?.enabled === true) {
				const made = await makeWorker("extractMemories");
				slot.extract = made.worker;
				if (made.error !== null) slot.failure = `extract worker: ${made.error}`;
			}
			if (wantsDream) {
				const made = await makeWorker("dream");
				slot.dream = made.worker;
				if (made.error !== null && slot.failure === null) slot.failure = `dream worker: ${made.error}`;
			}
			workers.set(sessionId, slot);
			for (const extra of [slot.extract, slot.dream]) {
				if (extra !== null && extra.sessionId !== "")
					ctx.logger.debug("simple-memory: sub-session %s prepared", extra.sessionId);
			}
		}

		const tool = createMemoryTool(rt, {
			searchSessions,
			// refresh 必须 fire-and-forget：core onWrite 同步、宿主 section text 也同步。
			// 原写入语义不变，writeHook 另外把同一次成功写交给当前 sync engine。
			onWrite: writeHook(undefined, true),
			// 主 session 才计入召回去重：工具把正文交给了主模型，下一轮 surfaced 不该重复。
			// 与召回共用同一个 Set（`injected` 由 surfacing 读写，装配层负责在会话结束时销账）。
			onContentSeen: ({ files }) => {
				const seen = injected.get(sessionId) ?? new Set<string>();
				for (const file of files) seen.add(file);
				injected.set(sessionId, seen);
			},
		});

		// 同一个 sessionId 可能再来一次 created（宿主的 clear / compact 会重建 agent）：先撤掉上一份，
		// 否则上一份 disposer 会从账本里掉出去，且同层重名注册会被宿主拒。
		runCleanup(cleanups.get(sessionId));
		cleanups.delete(sessionId);

		try {
			// 宿主 `ToolDefinition` 把 `parameters` 与 `output.schema` 钉成具体的 JSON Schema 类型，
			// 而 memory-tool.ts 刻意返回零宿主类型的结构化替身（这样它脱离宿主也能单测，且线格式由 core
			// 独占）。所以只在注册处收窄一次，绝不为迎合宿主去放宽替身类型。
			const disposeTool = agent.ctx.tools.register(tool as HostToolDefinition);
			// 宿主插件实践文档 `practices.md` 的「双 owner」规则：`agent.ctx` 上的注册同时属于 agent 的 fiber 和我们，
			// 所以把 disposer 也挂进我们自己的 effect —— 任一侧卸载都会撤掉它。
			const effect = ctx.effect(() => () => disposeTool(), AGENT_EFFECT_LABEL);
			// cordis 4 的 `ctx.effect` 返回该 effect 自己的 disposer（fiber.d.ts:「Calling the disposer
			// twice is a no-op」）：agent 走掉时调它，才能把我们 fiber 里这条 per-agent 清理项摘掉，
			// 否则它随会话数无界增长。按可调用性判定而不是假定它存在（测试用的假 ctx 不返回）。
			const disposeEffect: (() => void) | undefined = typeof effect === "function" ? effect : undefined;
			cleanups.set(sessionId, { disposeTool, disposeEffect });
		} catch (e) {
			// 我们的 fiber 正在卸载（`INACTIVE_EFFECT`），或 agent.ctx 已拒绝注册。在 `agent/created`
			// 里抛错等于让宿主的 agent 创建失败 —— 宁可这个会话没有 memory 工具。
			ctx.logger.warn("simple-memory: memory tool unavailable for session %s: %s", sessionId, errorMessage(e));
		}

		if (rt.error !== null) ctx.logger.warn("simple-memory: %s", rt.error);
	});

	// 7. `agent/disposed`：销掉这个会话的全部 per-session 状态。漏一处就在长寿命宿主进程里按会话数
	//    无界增长（子 agent 也发这个事件，但它们本来就没进账本，各调用都是幂等 no-op）。
	ctx.on("agent/disposed", ({ agent }) => {
		const sessionId = agent.session.id;
		void disposeSyncSession(sessionId);
		runCleanup(cleanups.get(sessionId));
		cleanups.delete(sessionId);
		registry.forget(sessionId);
		indexCache.forget(sessionId);
		agentAgents.delete(sessionId);
		const slot = workers.get(sessionId);
		workers.delete(sessionId);
		// 先尽力等在途抽取跑完（一次性宿主退出时这是唯一的宽限窗口），再拆 worker。
		void extractTrigger
			.drain()
			.catch(() => false)
			.then(() => Promise.allSettled([slot?.extract?.dispose(), slot?.dream?.dispose()]));
		injected.delete(sessionId);
		pendingRecalls.delete(sessionId);
	});

	// 8. 每轮召回挂在 `agent/pre-step` waterfall 上，`{ prepend: true }` 让我们在最外层：先进入、
	//    最后看到 decision，于是 splice 进去的是所有内层监听器（compaction / instructions /
	//    time-context）都处理过的最终消息数组。监听器本体在 surfacing.ts（它自己绝不外抛）。
	const recall = createPreStepListener({
		registry,
		indexCache,
		// 召回是零工具侧查询（`TASKS.autoSurfacing` 的 `builtinTools: "none"` + `memoryTool: null`），
		// 所以固定用零工具端口：不建子会话，也不在宿主会话日志里留痕。
		headless: zeroToolHeadless,
		injected,
		warn: (message, ...args) => ctx.logger.warn(message, ...args),
	});
	ctx.on(
		"agent/pre-step",
		// surfacing.ts 的接缝把消息保持成 `unknown[]`（零宿主类型），宿主的 decision 里是
		// `UserMessage[]`。这个 cast 不只担保宿主自己产出的消息（同一份数组、同一份语义）——
		// 那份数组里还会混进**我们注入的召回消息**（surfacing.ts 的 `createRecallMessage`）：它的
		// `source.kind: "simple-memory"` 不在宿主的 `MessageSourceMap` 里、`id` 是未品牌化的
		// `randomUUID()` 而不是品牌化 `MessageId`。运行期因此可容忍（宿主 `MessageSourceMap` 可合并
		// 扩展、未知 kind 消费者 fall-through；品牌只是类型面），所以这不是缺陷，但这个 cast 同样
		// 在替我们的注入消息担保。只在接线处收窄这一次。
		async (payload, next) => (await recall(payload, next)) as HostPreStepDecision,
		{ prepend: true },
	);

	// 9. 每轮收口的抽取挂在 `agent/turn-stopping`（串行、被 await，然后边界才提交）。监听器本体
	//    同步返回：extract 是一次 120s 的 headless 调用，await 进去等于把每一轮都拖到抽取跑完。
	//    `enabled` / 子 agent / 无运行时这三道门禁都在 extract.ts 里（触发点决策属于适配层）。
	// 9. 每轮收口的抽取挂在 `agent/turn-stopping`（串行、被 await，然后边界才提交）。监听器本体
	//    同步返回：extract 是一次 120s 的 headless 调用，await 进去等于把每一轮都拖到抽取跑完。
	//    `enabled` / 子 agent / 无运行时这三道门禁都在 extract.ts 里（触发点决策属于适配层）。
	// 9. 每轮收口的抽取挂在 `agent/turn-stopping`（串行、被 await，然后边界才提交）。监听器本体
	//    同步返回：extract 是一次 120s 的 headless 调用，await 进去等于把每一轮都拖到抽取跑完。
	//    `enabled` / 子 agent / 无运行时这三道门禁都在 extract.ts 里（触发点决策属于适配层）。
	const extractTrigger = createTurnStoppingListener({
		registry,
		headlessFor,
		transcript,
		warn: (message, ...params) => ctx.logger.warn(message, ...params),
		info: (message, ...params) => ctx.logger.info(message, ...params),
	});
	ctx.on("agent/turn-stopping", extractTrigger);

	// 10. `apply` 的 disposer 只拥有 apply 自己创建的东西（per-session 账本）。宿主注册归 fiber：
	//    它们在 `apply` 内部就已经被宿主的 `register()` 包进 `ctx.fiber.effect(...)`，fiber 卸载时
	//    自动撤销，不经过这个返回值。这里的清理对宿主是幂等的重复。
	return () => {
		for (const [sessionId, cleanup] of cleanups) {
			runCleanup(cleanup);
			registry.forget(sessionId);
			indexCache.forget(sessionId);
		}
		const slots = [...workers.values()];
		workers.clear();
		void extractTrigger
			.drain()
			.catch(() => false)
			.then(() => Promise.allSettled(slots.flatMap((slot) => [slot.extract?.dispose(), slot.dream?.dispose()])));
		for (const sessionId of [...syncSessions.keys()]) void disposeSyncSession(sessionId);
		cleanups.clear();
		agentAgents.clear();
		injected.clear();
		pendingRecalls.clear();
	};
}
