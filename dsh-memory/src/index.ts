import { MEMORY_TOOL_GUIDELINES, MEMORY_TOOL_SNIPPET } from "@yandy0725/memory-core";
import { createMemoryCommand } from "./commands.js";
import { errorMessage } from "./errors.js";
import { createDshHeadless } from "./headless.js";
import type { LlmLike } from "./headless.js";
import type { Context, HostPreStepDecision, HostPromptSection, HostToolDefinition } from "./host-types.js";
import { createIndexCache } from "./index-cache.js";
import { createMemoryTool } from "./memory-tool.js";
import { resolveSurfacingAvailability } from "./model.js";
import type { ModuleAvailability, ResolveCallConfig } from "./model.js";
import { resolveRowConfig, rowConfigSetKeys } from "./row-config.js";
import { createSessionSearch } from "./session-search.js";
import type { SessionQueryLike } from "./session-search.js";
import { createStoreRegistry, isRootAgent } from "./store-registry.js";
import type { AgentLike, HostDirLike } from "./store-registry.js";
import { createPreStepListener } from "./surfacing.js";

/**
 * dsh-memory 的 cordis 插件入口：把九个模块装配成一个 bundle。
 *
 * 装配顺序：行 config → auto-surfacing 可用性 → 四个 per-session 容器 →
 * 全局注册（section + `/memory`，每进程一次）→ per-agent 生命周期（created / disposed）→
 * 每轮召回（pre-step waterfall）。
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
 */
export const inject = ["tools", "systemPrompt", "llm", "commands", "workingDirectory", "sessionQuery", "logger"] as const;

/** 索引 section 的名字与位次：宿主 `SECTION_ORDERS` 里 4000 未被占用（MCP_SERVERS 3100 … TOOLS_SDK 5000）。 */
const INDEX_SECTION_NAME = "memory_index";
const INDEX_SECTION_ORDER = 4000;

/** per-agent effect 的标签，出现在宿主 `fiber.getEffects()` 的诊断树里。 */
const AGENT_EFFECT_LABEL = "memory/agent";

/**
 * 本适配层**没有实现**的 core 模块。行 config 的白名单是从 `DEFAULT_CONFIG` 派生的，所以这两棵子树
 * 天生能通过校验（无告警）却没有任何效果 —— 用户写了 `dream: { model: "…" }` 时，`/memory` 必须就地
 * 告诉他「配了但本适配层不跑」，否则他得到的是一句「你没配 model」式的误导。
 * 只在用户真写了它们时才显示，不给其余人增加噪声。
 */
const UNIMPLEMENTED_MODULES: readonly string[] = Object.freeze(["dream", "extractMemories"]);

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
		surfacing = await resolveSurfacingAvailability(
			resolved.config,
			resolveCallConfig,
			AbortSignal.timeout(10_000),
		);
	} catch (e) {
		surfacing = { available: false, reason: `autoSurfacing could not be resolved: ${errorMessage(e)}` };
	}

	// 4. per-session 容器：全部挂在闭包里（apply 每进程只跑一次，会话却有很多）。
	const registry = createStoreRegistry(dirs);
	const indexCache = createIndexCache();
	const headless = createDshHeadless(llm);
	const searchSessions = createSessionSearch(sessionQuery);
	/** sessionId → 本会话已注入过召回的 entry 文件名。surfacing 读写它，装配层负责在会话结束时销账。 */
	const injected = new Map<string, Set<string>>();
	/** sessionId → 工具注册的清理项。 */
	const cleanups = new Map<string, SessionCleanup>();

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
	// 用户真在行 config 里写了本适配层没实现的子树时，把它们交给 `/memory` 就地报出来。
	const setKeys = rowConfigSetKeys(config);
	const unimplementedModules = UNIMPLEMENTED_MODULES.filter((key) => setKeys.includes(key));
	ctx.commands.register(
		createMemoryCommand({ registry, indexCache, warnings: resolved.warnings, unimplementedModules }),
	);

	// 6. `agent/created`：串行、且在创建完成前被 await —— 这是唯一的异步窗口。记忆目录要探 git remote
	//    （异步），而 core 的工具 handler 只能在执行时同步 `getStore()`，所以目录必须在这里解析完。
	ctx.on("agent/created", async ({ agent, signal }) => {
		const like: AgentLike = agent; // 宿主 Agent 结构化满足我们的接缝，无需 cast
		// 子 agent 门禁：`agent/created` 对每个 agent 都发（子 agent 由 dsh-subagent 走 ctx.agents.create，
		// 根 ctx 的监听器看得到全部）。不过滤的话每个子 agent 都要付一次 git 探测 + 建 store，
		// 且每轮多付一次侧查询。判据是 `session.header.origin`（见 isRootAgent）。
		if (!isRootAgent(like)) return;
		const sessionId = like.session.id;

		// prepare 永不抛错：失败也给一个 store=null + error 的 runtime，让 /memory 与工具报错说出原因。
		const rt = await registry.prepare(like, resolved, surfacing, signal);
		await indexCache.refresh(rt);

		const tool = createMemoryTool(rt, {
			searchSessions,
			// 写入成功后刷新索引快照。core 的 onWrite 是同步回调（handler.ts:183 不 await 它），
			// 而宿主的 section text 必须同步 —— 所以这里只能 fire-and-forget；refresh 自己永不抛错，
			// 失败也只是保留旧快照。不过「refresh 不 reject」的保证住在另一个模块（index-cache.ts），
			// 这里就地吞掉，让「本文件绝不产生 unhandled rejection」本地成立、不被未来的改动打破
			// （Node 里一次 unhandled rejection 就能在没有全局 handler 时杀死进程）。
			onWrite: () => void indexCache.refresh(rt).catch(() => {}),
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
		runCleanup(cleanups.get(sessionId));
		cleanups.delete(sessionId);
		registry.forget(sessionId);
		indexCache.forget(sessionId);
		injected.delete(sessionId);
	});

	// 8. 每轮召回挂在 `agent/pre-step` waterfall 上，`{ prepend: true }` 让我们在最外层：先进入、
	//    最后看到 decision，于是 splice 进去的是所有内层监听器（compaction / instructions /
	//    time-context）都处理过的最终消息数组。监听器本体在 surfacing.ts（它自己绝不外抛）。
	const recall = createPreStepListener({
		registry,
		indexCache,
		headless,
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

	// 9. `apply` 的 disposer 只拥有 apply 自己创建的东西（per-session 账本）。宿主注册归 fiber：
	//    它们在 `apply` 内部就已经被宿主的 `register()` 包进 `ctx.fiber.effect(...)`，fiber 卸载时
	//    自动撤销，不经过这个返回值。这里的清理对宿主是幂等的重复。
	return () => {
		for (const [sessionId, cleanup] of cleanups) {
			runCleanup(cleanup);
			registry.forget(sessionId);
			indexCache.forget(sessionId);
		}
		cleanups.clear();
		injected.clear();
	};
}
