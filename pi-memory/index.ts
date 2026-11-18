import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	BoundaryContextPreview,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildIndexSection,
	indexCapacity,
	indexInjectionCapacity,
	LOCK_FILE,
	type LockInfo,
	MemoryStore,
	moduleStatusRows,
	parseEntryIndex,
	projectIdentity,
	readLockStatus,
	resolveMemoryDir,
	runTask,
	type SyncRoundResult,
	scanEntries,
	syncLockPath,
	syncRootPath,
	TASKS,
	withFsRetry,
} from "@yandy0725/memory-core";
import { createPiHeadlessAgent } from "./src/agent-runner";
import {
	type LoadedConfig,
	legacyMemoryRoot,
	loadConfig,
	type MemoryConfig,
	modelConfigErrors,
	pathConfigErrors,
} from "./src/config";
import { createPiTranscript } from "./src/host-transcript";
import { readRecordedMemoryIndex } from "./src/index-source";
import { applyIndexSection } from "./src/inject-pi";
import { detectLegacyMemoryDir } from "./src/legacy-hint";
import { createMemoryTool, type MemoryToolDeps, type MemoryToolOptions } from "./src/memory-tool";
import { resolveModel } from "./src/model-resolver";
import { readDreamMeta, shouldNudge, writeDreamMeta } from "./src/nudge";
import { searchSessions } from "./src/session-search";
import {
	createPiSyncRuntime,
	PI_CONFIG_SOURCE,
	type PiSyncRuntime,
	renderSyncRound,
	renderSyncStatus,
	errorMessage as syncErrorMessage,
} from "./src/sync";

function extractAgentsMdBlocks(systemPrompt: string): string[] {
	const blocks: string[] = [];
	const re = /<project_instructions\s+path="([^"]+)">\n([\s\S]*?)<\/project_instructions>/g;
	for (const match of systemPrompt.matchAll(re)) {
		blocks.push(match[0]);
	}
	return blocks;
}

/**
 * dream 的两条 fire-and-forget 链（session_start 的 nudge 与 `/dream`）共用的收尾工具。
 * handler 在**同步段**把 `ctx.ui` 快照成 `ExtensionUIContext | undefined`，链里一律不再读 `ctx`：
 * pi 的 `ExtensionContext` 是代理，`hasUI` / `ui` 的 getter 会 `assertActive()`，session dispose
 * （/new、切换、fork、reload）之后读取即抛错。dream 走 600s timeout，而 `session_shutdown`
 * 只等 `lock.timeoutMs`（默认 5s），所以「dream 在途 + session 已销毁」是常态路径；通知 / 清状态
 * 自己抛错也不能逃逸成未处理 rejection（没有全局 handler 时 Node 会直接杀掉进程）。
 */
function notifyDream(ui: ExtensionUIContext | undefined, message: string, level: "info" | "error"): void {
	try {
		ui?.notify(message, level);
	} catch {
		/* UI 已失效：宿主不再收这条通知 */
	}
}

function clearDreamStatus(ui: ExtensionUIContext | undefined): void {
	try {
		ui?.setStatus("dream", undefined);
	} catch {
		/* UI 已失效 */
	}
}

/** rejected 的值不一定是 Error（pi 的模型层可能抛字符串 / 对象）。 */
function dreamFailureMessage(e: unknown): string {
	return `Dream failed: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * `<relevant_memories>` 里实际注入的块数（每块以 `\n## ` 开头）。
 * 近似值：正文里自己以 `## ` 开头的行会被多算 —— 它只用于一条通知文案（spec §14），
 * 而把 `renderSurfacedBlock` 的返回值改成结构体反而会弄脏已经钉住的接口。
 */
function countInjectedBlocks(content: string): number {
	return Math.max(0, content.split("\n## ").length - 1);
}

/**
 * 取边界上「最后一条真实用户消息」的文本与带图信息（`turn_end` 的归属校验用）。
 *
 * 取 `event.context.contextMessages` 而不是 `ctx.sessionManager.getBranch()`：
 * - 它就是宿主为这个边界合成、下一个请求要用的那份会话上下文（`_buildBoundaryContext`），
 *   所以「真实用户消息」= 真的会进入上下文的 `role: "user"` 消息。我们自己的
 *   `memory-auto-surfacing` 与其它扩展的 custom_message 投影成 `role: "custom"`，
 *   compaction / branch summary 有各自的 role，bash 执行是 `bashExecution` —— 全被排除；
 * - 排队但尚未 drain 的 follow-up / steering 在宿主的 `pendingMessages` 里，不在
 *   `contextMessages`：它们还没进消息流，这个边界仍属于原 prompt；
 * - 纯事件字段，同步读取，不会在 session dispose 后回读失效的 `ctx` 代理。
 *
 * 用户消息的 content 是字符串或块数组（宿主 `_prepareRun` 总是给 `[text, ...images]`），
 * 所以这里同时带回「有没有 image block」：带图那一轮的文本不是纯 prompt，见 `boundaryOwnsRecall`。
 */
interface BoundaryUserMessage {
	text: string;
	/** 该消息的 content 里是否有 image block（宿主只在真的带图时才追加图片）。 */
	hasImages: boolean;
}

function lastUserMessage(context: BoundaryContextPreview | undefined): BoundaryUserMessage | undefined {
	const messages = context?.contextMessages;
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return { text: content, hasImages: false };
		return {
			text: content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join(""),
			hasImages: content.some((block) => block.type === "image"),
		};
	}
	return undefined;
}

/**
 * 这个边界是否仍属于启动本轮检索的那个 user run。两道判据，缺一不可（下面的注释解释为什么
 * 前缀匹配必须被「两边都带图」这一条钉死）。
 *
 * 1. **严格相等**：同文本重复 prompt 视为同一轮 —— 检索 query 相同，召回内容对新 prompt 同样
 *    适用，误判无害；无图 prompt 的用户消息文本就是 prompt 原文（宿主 `_prepareRun` 只在有
 *    提示时才拼接），所以无图轮走到这里就结束。
 * 2. **带图的前缀形态**：宿主把图片归一化提示以 `prompt + "\n\n" + hints` 追加到用户文本后
 *    （`agent-session.js` `_prepareRun`），同一轮的文本因此带一个后缀。但「文本以
 *    `prompt + "\n\n"` 开头」本身不能证明是同一条用户消息 —— 用 `A` 的召回去记 `B` 的
 *    多行 prompt（`A` + 换行 + 更多内容）会把召回记到别人的头上，还会错误标记去重。所以前缀
 *    分支额外要求：启动检索时 pending 确实带图，且边界上的这条用户消息也确实含 image block。
 *    无图的后缀文本一律作废。
 *
 * 残留的极端情形：pending 带图 + 不同 prompt 恰好以 `prompt + "\n\n"` 开头 + 新 prompt 也
 * 带图。此时文本前缀相同，语义上高度相关，召回仍适用（与同文本重复 prompt 同性质），可接受。
 */
function boundaryOwnsRecall(last: BoundaryUserMessage | undefined, pending: PendingRecall): boolean {
	if (last === undefined) return false;
	if (last.text === pending.prompt) return true;
	if (pending.imageCount === 0 || !last.hasImages) return false;
	return last.text.startsWith(`${pending.prompt}\n\n`);
}

/**
 * `startup` 的 `outcome.warning` 是「prepare 预告 + 可能追加的启动预算用尽行」的拼接，而预告已经
 * 由 `onWarning` 通道即时通知过。这里只取尚未通知的尾部，避免同一条预告在账本里记两次。
 */
function unwarnedStartupTail(delivered: string | undefined, warning: string | undefined): string {
	if (warning === undefined || warning === "") return "";
	if (delivered === undefined || delivered === "") return warning;
	if (warning === delivered) return "";
	// core 用 `joinWarning` 以换行追加；只剥一层分隔符，不改写内容。
	return warning.startsWith(`${delivered}\n`) ? warning.slice(delivered.length + 1) : warning;
}

/**
 * prefetch 的结果槽：`settled` 之前 `content` 一律不可信（消费点必须先看它）。
 *
 * 归属有两道闸，缺一不可：
 * 1. `before_agent_start` 一到就无条件作废旧 pending（新 run 取代旧 run）；
 * 2. 消费点（`turn_end`）比对 `prompt` 与边界上「最后一条真实用户消息」—— 宿主允许在
 *    `before_agent_start` handlers 未完成时收到并排队输入（`_startRun` 先把 `_isAgentRunActive`
 *    置为 true），因此「B 的 queued 输入 → A 的 before_agent_start 建 pending」这一时序里第 1 道闸
 *    是哑的，只有消费点按当前上下文校验才能把结果扣在正确的 prompt 上。
 */
interface PendingRecall {
	settled: boolean;
	/** 启动这一轮检索的 user run 的 prompt（`BeforeAgentStartUserEvent.prompt`，已展开）。 */
	prompt: string;
	/** 启动时这条 prompt 附带的图片数（`BeforeAgentStartUserEvent.images`）：0 = 无图轮。 */
	imageCount: number;
	files: string[];
	content: string;
}

export const IMPLEMENTED_TASKS = ["dream", "extractMemories", "autoSurfacing"] as const;

/**
 * `/memory` 的模块激活状态一行：`dream=on(model) extractMemories=off autoSurfacing=on(model)`。
 *
 * `dream` 没有独立开关 —— 健康会话里（能走到状态分支）它就可用；另外两个直接反映各自的
 * `enabled`。模型是**生效值**（per-task 优先，其次 `defaults.model`），关闭的模块不显示模型：
 * 用户问「为什么没生效」时答案在开关上，而不在模型上。
 *
 * 行数据来自 core 的 `moduleStatusRows`：core 只给 `implemented` / `enabled` / `model` 三个事实，
 * 展示顺序与措辞（空格分隔、`on(…)` / `off`）仍是 pi 自己的事。
 *
 * 导出供测试直接覆盖：正常会话里「模型解析不出」那条路径走不到（`session_start` 会先拦成
 * misconfigured），只能直接调纯函数。
 */
export function moduleStatusLine(cfg: MemoryConfig): string {
	return moduleStatusRows(cfg, IMPLEMENTED_TASKS)
		.map((row) => `${row.id}=${row.enabled ? `on(${row.model ?? "no model"})` : "off"}`)
		.join(" ");
}

/** `<op> (pid N on <hostname>, started <ISO>)` —— `/memory` 的 Lock 行与 unlock 确认框共用同一份描述。 */
function describeHolder(holder: LockInfo): string {
	return `${holder.op} (pid ${holder.pid} on ${holder.hostname}, started ${holder.startedAt})`;
}

/**
 * `/memory` 的锁状态行。只读不碰 —— `.lock` **永不自动回收**（spec §5.1），
 * 人工清除只有 `/memory unlock` 一个入口。
 * 带 hostname：`.lock` 是目录里的普通文件，同一份目录可能被挂载到多台机器（spec §19），
 * 只看 pid 无法判断持有者是不是“本机的另一个进程”。
 */
async function lockStatusLine(memoryDir: string): Promise<string> {
	const status = await readLockStatus(join(memoryDir, LOCK_FILE));
	if (status.kind === "absent") return "free";
	if (status.kind === "unreadable") return "unreadable — run /memory unlock";
	return `held by ${describeHolder(status.holder)}`;
}

/** 两类人工锁恢复共用：显式确认、withFsRetry、ENOENT 幂等，并且只 unlink 目标文件。 */
async function unlockFile(
	lockPath: string,
	ui: ExtensionUIContext,
	copy: { title: string; noun: string; operation: string; removed: string; failure: string },
): Promise<void> {
	const status = await readLockStatus(lockPath);
	if (status.kind === "absent") {
		ui.notify("No lock present.", "info");
		return;
	}
	const question =
		status.kind === "held"
			? `Remove the ${copy.noun} file? It is held by ${describeHolder(status.holder)}. Only do this if no ${copy.operation} is running.`
			: `Remove the ${copy.noun} file? Only do this if no ${copy.operation} is running.`;
	const ok = await ui.confirm(copy.title, question);
	if (!ok) return;
	try {
		// 恢复路径也要重试：删除本身同样会被杀软/索引器/同步客户端瞬时打断。
		await withFsRetry(() => unlink(lockPath));
		ui.notify(copy.removed, "info");
	} catch (e) {
		// confirm 到 unlink 之间锁自己消失了：那正是想要的结果。
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			ui.notify("No lock present.", "info");
			return;
		}
		ui.notify(`${copy.failure}: ${(e as Error).message}`, "error");
	}
}

/**
 * `/memory unlock`：崩溃遗留的 `.lock` 的**唯一**人工清除入口（spec §19 风险表）。
 * 文案与确认语义保持原样；共享 helper 只是让根锁恢复复用同一条安全边界。
 */
async function unlockMemory(memoryDir: string, ui: ExtensionUIContext): Promise<void> {
	await unlockFile(join(memoryDir, LOCK_FILE), ui, {
		title: "Memory lock",
		noun: "memory lock",
		operation: "memory operation",
		removed: "Memory lock removed.",
		failure: "Failed to remove memory lock",
	});
}

/** `/memory sync unlock` 只依赖配置根，不需要 store、device 或 engine。 */
async function unlockMemorySync(config: MemoryConfig, ui: ExtensionUIContext): Promise<void> {
	const lockPath = syncLockPath(syncRootPath(resolve(config.memoryDir)));
	await unlockFile(lockPath, ui, {
		title: "Memory sync lock",
		noun: "memory sync lock",
		operation: "memory sync operation",
		removed: "Memory sync lock removed.",
		failure: "Failed to remove memory sync lock",
	});
}

export default function (pi: ExtensionAPI) {
	let memoryDir: string | null = null;
	let config: MemoryConfig | null = null;
	/** 唯一写入通道（D4）。session_start 里建，之后工具 / extract / dream 都只经它读写。 */
	let store: MemoryStore | null = null;
	/** 配置错误态（模型校验失败或初始化失败）。/memory 重复显示它，直到用户改好配置并重启。 */
	let configError: string | null = null;
	/** 同步错误是独立的非致命通道：健康 store/tool/index 绝不被它清空。 */
	let syncError: string | null = null;
	/**
	 * 同步预告（**不是故障**）：首个基线「同名条目会留成确定性副本」、启动预算用尽导致本轮跳过等。
	 * 刻意与 `syncError` 分开两套通道 —— 混进错误态会让 `/memory` 把「第一次同步会留副本」显示成同步坏了，
	 * 而通知侧 `notifySync` 默认 level 是 error，会把它渲染成红色 `Error:`。
	 */
	let syncNotice: string | null = null;
	let syncRuntime: PiSyncRuntime | null = null;
	/** 每次 session_start 都使上一代的所有异步 continuation 失效。 */
	let sessionGeneration = 0;
	/** create 阶段仍成立的错误（如 origin 漂移）；手动恢复成功时只清瞬时错误，保留这些。 */
	let syncPersistentErrors: string[] = [];
	let indexSnapshot = "";
	let toolRegistered = false;
	let currentCwd = "";
	/** 本 session 已注入过的 entry **文件名**（spec §9.3）。session_compact 会清空它。 */
	const injectedFiles = new Set<string>();
	/**
	 * 本轮 `before_agent_start` 启动的侧查询（spec §5.2）。`before_agent_start` 不 await 它，
	 * 只在结果就绪、本轮还有后续请求、且边界仍属于同一个 prompt 时由 `turn_end` 持久化一次。
	 */
	let pendingRecall: PendingRecall | undefined;
	/**
	 * 当前**拥有** `surfacing` 状态行的那一份 pending。收尾时必须持有它才能清 —— 被新一轮取代的
	 * prefetch 若无条件清，会把新一轮已经亮出来的状态行擦掉；反之（被作废且没有新检索）则必须由
	 * 它自己清，否则状态行就永久挂着。
	 */
	let surfacingStatusFor: PendingRecall | undefined;
	let lastSystemPrompt = "";
	/** extract 失败通知的限流（spec §14：同一 session 最多 1 次）。session_start 重置。 */
	let extractErrorNotified = false;
	/**
	 * 在途的后台写操作（dream / extract）。`session_shutdown` 等它们收尾，上限
	 * `lock.timeoutMs`（spec §10）—— 进程在写入中途被杀会留下永远没人释放的 `.lock`。
	 */
	const inFlight = new Set<Promise<unknown>>();

	/** 每次 session_start 先收掉旧 runtime；init 阶段 engine 仍为空，也必须 abort。 */
	function disposeSyncRuntime(target: PiSyncRuntime | null = syncRuntime): void {
		try {
			// core 的 dispose 已经同步关闸/abort/dispose，返回的 promise 只负责 drain 且永不 reject。
			// 退出路径不 await 它：无界 drain 不能变成 shutdown 的等待上限。
			void target?.dispose();
		} catch {
			/* 同步收摊不得影响新会话 */
		} finally {
			// shutdown 可能跨过一个新 session_start：只能清掉自己快照的那一代 runtime。
			if (syncRuntime === target) syncRuntime = null;
		}
	}

	/**
	 * 清空本 session 的运行时状态。两条早退路径（配置错误 / 初始化失败）共用：
	 * 残留上一 session 的 store 会让后续写入落到别的项目目录（Plan C ledger R51）。
	 */
	function resetSessionState(): void {
		disposeSyncRuntime();
		memoryDir = null;
		store = null;
		indexSnapshot = "";
		injectedFiles.clear();
	}

	function setSyncError(errors: string[]): void {
		const unique = [...new Set(errors.map((error) => error.trim()).filter((error) => error !== ""))];
		syncError = unique.length > 0 ? unique.join("\n") : null;
	}

	function setSyncNotice(notices: string[]): void {
		const unique = [...new Set(notices.map((notice) => notice.trim()).filter((notice) => notice !== ""))];
		syncNotice = unique.length > 0 ? unique.join("\n") : null;
	}

	function notifySync(ui: ExtensionUIContext | undefined, message: string, level: "info" | "error" = "error"): void {
		try {
			ui?.notify(message, level);
		} catch {
			/* session 在 await 期间 dispose：同步降级不能因此拖垮宿主 */
		}
	}

	/** 统一的配置错误态：记录 → 清空运行时 → 通知。无 UI 时只记录（`/memory` 仍可读到）。 */
	function failConfig(errors: string[], ui: ExtensionUIContext | undefined): void {
		configError = errors.join("\n");
		syncError = null;
		syncNotice = null;
		syncPersistentErrors = [];
		resetSessionState();
		notifySync(ui, `pi-memory config error:\n${errors.map((e) => `- ${e}`).join("\n")}`);
	}

	/** 登记一个后台 promise，settle 后自动摘掉；返回同一个 promise 以便调用方继续链式处理。 */
	function track<T>(promise: Promise<T>): Promise<T> {
		inFlight.add(promise);
		promise.catch(() => undefined).finally(() => inFlight.delete(promise));
		return promise;
	}

	/** 同一个 lock.timeoutMs 有界等待；空闲时连兜底定时器都不创建。 */
	async function waitForShutdownInFlight(timeoutMs: number): Promise<void> {
		if (inFlight.size === 0) return;
		// `Promise.race` 胜出后兜底定时器仍然挂在事件循环上：显式 clear + unref。
		let timer: ReturnType<typeof setTimeout> | undefined;
		const giveUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		});
		try {
			await Promise.race([Promise.allSettled([...inFlight]), giveUp]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * 主 agent、extract、dream 共用同一份依赖，三者只差 `actions` 与锁/快照选项（D12）。
	 * 用 getter 而不是快照值：config / memoryDir / store 都在 session_start 里才确定。
	 */
	const toolDeps: MemoryToolDeps = {
		getMemoryDir: () => memoryDir,
		getStore: () => store,
		// biome-ignore lint/style/noNonNullAssertion: config 在 session_start 里赋值，工具执行必然晚于它
		getConfig: () => config!,
		getUnavailableMessage: () =>
			configError ? `Memory not initialized — ${configError.split("\n")[0]}; run /memory for details` : null,
		searchSessions,
		cwd: () => currentCwd,
	};

	/**
	 * core 的编排（dream / extract / 侧查询）经这两个端口用到 pi 的能力。
	 * `headless` 每次现造：`ctx.modelRegistry` 来自事件上下文，不在工厂作用域里。
	 */
	const piTranscript = createPiTranscript();
	/** 主工具与所有 headless 工具共用：保留原回调语义，再通知当前这一代的 engine。 */
	function buildMemoryTool(spec: MemoryToolOptions = {}): ToolDefinition {
		return createMemoryTool(toolDeps, {
			...spec,
			onWrite: (info) => {
				spec.onWrite?.(info);
				// 写入必须经 runtime 入口：收摊或换远端关闸期间它会拒绝触碰旧 engine。
				syncRuntime?.noteWrite();
			},
		});
	}

	const headlessFor = (modelRegistry: ExtensionContext["modelRegistry"]) =>
		createPiHeadlessAgent({
			modelRegistry,
			// headless（dream / extract）的 `memory` 工具规格来自 core，**不带** `onContentSeen`：
			// 它们读到的正文只进了子会话，主模型没见过 —— 标成「已见过」会把本该浮现的条目吞掉。
			buildMemoryTool,
		});

	/**
	 * 建立本 session 的记忆运行时：目录 → store → 索引来源 → 注册工具。
	 *
	 * 只在 `session_start` 调用，且调用方已通过模型校验。
	 * 抛错 = 初始化失败，由调用方转成配置错误态（`configError`）。
	 * `reason` 只有 `session_start` 会传：resume / fork / reload 用 transcript 的录制值（D14）。
	 */
	async function initMemory(
		cwd: string,
		sessionManager: ExtensionContext["sessionManager"],
		reason: string | undefined,
		syncUi: ExtensionUIContext | undefined,
		generation: number,
	): Promise<void> {
		const isCurrent = () => generation === sessionGeneration;
		if (!isCurrent()) return;
		// biome-ignore lint/style/noNonNullAssertion: 调用方已通过模型校验
		const cfg = config!;
		currentCwd = cwd;
		const dir = await resolveMemoryDir(cfg, cwd);
		if (!isCurrent()) return;
		const activeStore = new MemoryStore({
			memoryDir: dir,
			indexMaxLines: cfg.memIndexMaxLines,
			indexMaxBytes: cfg.memIndexMaxBytes,
			lock: cfg.lock,
		});
		memoryDir = dir;
		store = activeStore;

		// 同步配置、init、传输都只是非致命降级。准备与启动收敛全部结束后才选择索引来源：
		// startup/new 读到同步后的磁盘；resume/fork/reload 仍逐字冻结 transcript 的录制值。
		const syncErrors: string[] = [];
		// 预告与失败分两个通道：`prepared.warning` 是「首次基线可能留副本」这类**预告**，不是失败。
		const syncNotices: string[] = [];
		let notifiedSyncErrors = 0;
		let notifiedSyncNotices = 0;
		const notifyPendingSyncNotices = (): void => {
			const pending = syncNotices.slice(notifiedSyncNotices);
			if (pending.length === 0) return;
			setSyncNotice(syncNotices);
			notifySync(syncUi, `pi-memory sync notice:\n${pending.map((notice) => `- ${notice}`).join("\n")}`, "info");
			notifiedSyncNotices = syncNotices.length;
		};
		const notifyPendingSyncErrors = (): void => {
			const pending = syncErrors.slice(notifiedSyncErrors);
			if (pending.length === 0) return;
			setSyncError(syncErrors);
			notifySync(syncUi, `pi-memory sync error:\n${pending.map((error) => `- ${error}`).join("\n")}`);
			notifiedSyncErrors = syncErrors.length;
		};
		try {
			const identity = await projectIdentity(cwd);
			if (!isCurrent()) return;
			const assembled = await createPiSyncRuntime({ config: cfg, store: activeStore, projectDir: dir, identity });
			if (!isCurrent()) {
				void assembled.runtime?.dispose();
				return;
			}
			syncRuntime = assembled.runtime;
			syncPersistentErrors = [...assembled.errors];
			syncErrors.push(...assembled.errors);
			// create 阶段的预告（如「非 git 项目本会话不同步」）不是失败：只登记为预告并走 info 级通知。
			if (assembled.notices.length > 0) {
				syncNotices.push(...assembled.notices);
				notifyPendingSyncNotices();
			}
			const activeRuntime = assembled.runtime;
			if (activeRuntime) {
				// 自动预算、prepare 与启动轮次全在 core 的一次 startup 里共享同一个 deadline；宿主的
				// 职责是保留两套通道：预告即时通知（必须在 push 之前），失败进错误账。
				let preparedWarning: string | undefined;
				const startup = await activeRuntime.startup((warning) => {
					// 已换代（新 session_start 已经换掉了这一代的账本与 runtime）：预告不得再写进新会话。
					if (!isCurrent()) return;
					preparedWarning = warning;
					syncNotices.push(warning);
					// 首次本地记忆的冲突预告必须发生在任何启动 push 之前，不能等副本已经落盘才说。
					notifyPendingSyncNotices();
				});
				if (!isCurrent()) return;
				if (!startup.ok) {
					syncErrors.push(startup.reason);
				} else {
					// 预算用尽是「本轮跳过、下一轮再推」，不是失败：它在 outcome.warning 尾部追加，
					// 而 prepare 的预告已经由回调通知过，这里只补新增的那一段。
					const pendingNotice = unwarnedStartupTail(preparedWarning, startup.warning);
					if (pendingNotice !== "") syncNotices.push(pendingNotice);
					if (startup.value !== null && !startup.value.ok) {
						syncErrors.push(startup.value.skipped?.reason ?? "memory sync startup round failed");
					}
				}
			}
		} catch (error) {
			if (!isCurrent()) return;
			syncErrors.push(error instanceof Error ? error.message : String(error));
		}
		if (!isCurrent()) return;
		// prepare 之后新发生的预告/传输错误按增量通知：早期预告不重复，后续失败也不漏报。
		notifyPendingSyncNotices();
		notifyPendingSyncErrors();

		// D13 / D14：索引值在整个 session 内**冻结**。resume / fork / reload 必须用 transcript 里的
		// 录制值 —— 否则被恢复会话的 system prompt 头部会被改写，而 memory_index 是头部的最后一段，
		// 折叠路径下其后的整段对话全部失去缓存。录制值拿不到（更老的 session 形状 / 投影不可用）
		// 才回退磁盘读。
		// 录制值**不再 re-sanitize**：写入当年已经净化过，而 sanitizeForInjection 是幂等的 ——
		// 保持字节恒等更利于缓存。
		const useRecorded = reason === "resume" || reason === "fork" || reason === "reload";
		const recorded = useRecorded ? readRecordedMemoryIndex(sessionManager) : null;
		const nextIndex =
			recorded ?? (await buildIndexSection(activeStore, cfg.memIndexInjectMaxLines, cfg.memIndexInjectMaxBytes));
		if (!isCurrent()) return;
		indexSnapshot = nextIndex;

		// register memory tool once
		if (!toolRegistered) {
			const tool = buildMemoryTool({
				// 主 session 才计入召回去重：工具把正文交给了主模型，下一轮 surfaced 不该重复。
				onContentSeen: ({ files }) => {
					for (const f of files) injectedFiles.add(f);
				},
			});
			pi.registerTool(
				// biome-ignore lint/suspicious/noExplicitAny: pi registerTool type cast
				tool as any,
			);
			toolRegistered = true;
		}
	}
	pi.on("session_start", async (event, ctx) => {
		const generation = ++sessionGeneration;
		// 复位必须在**任何可能抛错的调用之前**跑完：冷启动与配置错误会话都要有干净的一次失败通知
		// 配额、干净的错误态，以及**清空的运行时**。loadConfig（里面的 getAgentDir）与下面的
		// modelConfigErrors（宿主给的 registry 可能既没有 getAvailable 也没有 getAll）都属于宿主契约
		// 之外的部分：它们一旦抛出而复位还没跑，上一 session 的 store / memoryDir 就会留在**已经注册**
		// 的 `memory` 工具背后 —— 项目 B 的 agent 能写进项目 A 的目录（Plan C ledger R51）。
		extractErrorNotified = false;
		// `configError = null` 是纯防御：所有把 store 置空的路径都会经 failConfig 覆写它，所以这次复位
		// 本身不可观测 —— 没有测试钉它，删掉也不会让任何用例变红（2026-10-03 final review 的结论）。
		configError = null;
		syncError = null;
		syncNotice = null;
		syncPersistentErrors = [];
		resetSessionState();
		// 同步段可能等待远端预算：所有宿主值都在其第一个 await 之前快照，之后绝不回读已 dispose 的 ctx。
		const syncUi = ctx.hasUI ? ctx.ui : undefined;
		const sessionCwd = ctx.cwd;
		const sessionManager = ctx.sessionManager;
		const modelRegistry = ctx.modelRegistry;
		const startupHeadless = headlessFor(modelRegistry);
		// `loadConfig` 抛错（`getAgentDir` / `isProjectTrusted` 属宿主契约）与初始化失败同一处理：
		// 转成配置错误态，不把裸 reject 冒给宿主（spec §2.4）。用局部变量承接是为了让后面的收窄
		// 不受 `config` 这个工厂作用域 let 影响。（nudge 块仍可能抛错，属既有暴露面，不在本次范围。）
		let loaded: LoadedConfig;
		try {
			loaded = await loadConfig(ctx);
		} catch (e) {
			if (generation !== sessionGeneration) return;
			failConfig([`Failed to load memory config: ${e instanceof Error ? e.message : String(e)}`], syncUi);
			return;
		}
		if (generation !== sessionGeneration) return;
		config = loaded.config;
		try {
			// 启动校验（spec §2.3）：模型键缺失 / 不可解析 → 本会话**完全不初始化**
			//（不解析目录、不建 store、不注册工具），错误态由 `/memory` 重复显示。
			// 校验本身抛错（registry 不合契约）也走同一个 catch：failConfig 自己会复位运行时。
			// 路径错误排在模型错误之前：`memoryDir` 指错地方时，后面所有「能不能用」的判断都没意义。
			// 它守的是**静默分叉**：另一个平台写法的绝对路径会被 `resolve()` 改写成相对 cwd 的
			// 路径（POSIX 上的 `E:/…`、win32 上的 `/mnt/…`），于是记忆落进一个用户没预期的
			// 新库 —— 现象就是「记忆全丢了」（issue #12）。
			const errors = [
				...pathConfigErrors(loaded.config, process.platform, { configSource: PI_CONFIG_SOURCE }),
				...modelConfigErrors(
					loaded.config,
					(value) => resolveModel(value, modelRegistry) !== undefined,
					undefined,
					{
						configSource: PI_CONFIG_SOURCE,
					},
				),
			];
			if (errors.length > 0) {
				failConfig(errors, syncUi);
				return;
			}
			await initMemory(sessionCwd, sessionManager, (event as { reason?: string }).reason, syncUi, generation);
		} catch (e) {
			if (generation !== sessionGeneration) return;
			// spec §2.4：初始化失败走同一个错误态，不冒泡给宿主（那只会变成一条裸报错）。
			failConfig([`Failed to initialize memory: ${e instanceof Error ? e.message : String(e)}`], syncUi);
			return;
		}
		if (generation !== sessionGeneration) return;

		// nudge
		// 先拷到 const：initMemory 里赋的值，TS 在本函数的控制流里看不到收窄。
		const nudgeDir = memoryDir;
		if (syncUi && nudgeDir) {
			// 同步段快照：shouldNudge / confirm 之后的 fire-and-forget 链不再碰 ctx（见 notifyDream）。
			const ui = syncUi;
			const { nudge, message, sessions } = await shouldNudge(nudgeDir, loaded.host, sessionCwd);
			if (generation !== sessionGeneration) return;
			if (nudge) {
				const ok = await ui.confirm("Memory Consolidation", `${message}\n\nConsolidate memory files now?`);
				if (generation !== sessionGeneration) return;
				// dream 需要 store（整轮逻辑锁 + 快照都挂在它上面）；这里必然非空，但 const 拷贝让 TS 也能看到。
				const activeStore = store;
				if (ok && activeStore) {
					// Fire-and-forget: does not block session_start. The headless
					// dream agent runs independently; completion notifies the user.
					const dir = nudgeDir;
					// `runTask` 是 async：缺模型不会在调用点同步抛，而是变成这条链的 rejection，
					// 由下面的两参 `.then` 失败分支报「Dream failed」，`.finally` 负责清状态行。
					const dreamRun = runTask(
						TASKS.dream,
						{},
						{ cfg: config, cwd: dir, store: activeStore, ports: { headless: startupHeadless } },
					);
					ui.setStatus("dream", "Consolidating memory...");
					// dream 的 7 个 action 只注入它自己的 headless 子会话；整轮持锁与进入时的
					// 全目录快照都在 runTask(TASKS.dream) 里，所以内部原语两个 skip 都开（由 core 表达）。
					track(dreamRun);
					// 两参 `.then`（而不是 `.then().catch()`）：成功分支自己写 meta，两个分支都不再读 ctx；
					// writeDreamMeta 的失败也必须在分支内兜住，否则它会变成无人接管的 rejection。
					void dreamRun
						.then(
							async (summary) => {
								try {
									await writeDreamMeta(dir, sessions);
								} catch (e) {
									notifyDream(ui, dreamFailureMessage(e), "error");
									return;
								}
								notifyDream(ui, summary, "info");
							},
							(e: unknown) => notifyDream(ui, dreamFailureMessage(e), "error"),
						)
						.finally(() => clearDreamStatus(ui));
				}
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		lastSystemPrompt = event.systemPrompt;
		// 先拷到 const：`store` 是工厂作用域的 let，在异步回调里 TS 不会保留它的外层收窄。
		const activeStore = store;
		// 任何 run（含 custom）都先作废旧 pending：它属于被这一轮取代的那个 prompt
		//（spec §5.1「新用户轮启动时旧 pending 一律作废」）。
		pendingRecall = undefined;
		if (!config || !memoryDir || !activeStore) return {};

		// 索引 section：**每一轮无条件**写入冻结值（含 resume / fork / reload）。
		// 省略这个键 = pi 的 diffSystemPromptSections 生成 { memory_index: null } = 把索引从
		// system prompt 里静默删掉（spec §9.1 的 null 陷阱）。「不想改」只能靠喂回同一个值。
		// 它必须在**任何 await 之前**：handler 一旦在写 section 之前让出，session 途中 dispose
		// 就能让这一轮从「喂回冻结值」变成「删段」（R49）。
		applyIndexSection(event.systemPromptOptions, indexSnapshot);
		const autoSurfacing = config.autoSurfacing;
		// Skip auto-surfacing in subagent sessions: pi-subagents injects an
		// <active_agent name="..."/> tag into every subagent's system prompt.
		// Main sessions (including forks) never have this tag. Our own headless
		// sessions use noExtensions (never bind), so they never reach here.
		const isSubagent = event.systemPrompt.includes('<active_agent name="');
		// 1.2.0 起 `before_agent_start` 是两种 run 的联合：`messageType: "user"` 带 `prompt`，
		// `messageType: "custom"`（`pi.sendMessage(..., { triggerTurn: true })` 空闲触发）带 `message`。
		// 自动浮现按用户输入检索，custom run 没有用户输入可检索，跳过（不是降级）。
		const promptText = event.messageType === "user" ? event.prompt : undefined;
		// 带图轮的归属判据（见 `boundaryOwnsRecall`）：只有 user run 才可能带图。
		const imageCount = event.messageType === "user" ? (event.images?.length ?? 0) : 0;
		if (autoSurfacing?.enabled && promptText && !isSubagent) {
			// prefetch 与主循环并行：**同步段**把宿主值与本轮输入抓成局部量，异步链此后不再回读
			// `ctx`（pi 的 ExtensionContext 是代理，session dispose 之后 `hasUI` / `ui` 直接抛错）。
			const ui = ctx.hasUI ? ctx.ui : undefined;
			const cfg = config;
			const dir = memoryDir;
			const headless = headlessFor(ctx.modelRegistry);
			const pending: PendingRecall = {
				settled: false,
				prompt: promptText,
				imageCount,
				files: [],
				content: "",
			};
			pendingRecall = pending;
			if (ui) {
				surfacingStatusFor = pending;
				try {
					ui.setStatus("surfacing", "Searching relevant memories…");
				} catch {
					/* UI 拒绝画状态行不影响检索 */
				}
			}
			const prefetch = (async () => {
				try {
					const manifest = await scanEntries(activeStore);
					if (manifest.length === 0) return;
					const { files, content } = await runTask(
						TASKS.autoSurfacing,
						// 去重集合递**快照**（spec §5.2.1）：侧查询在飞的时候 `turn_end` 可能已经把
						// 本轮召回的文件标进活 Set，传引用会让「查询输入」随之后写而变。
						{ userPrompt: promptText.slice(0, 4000), injectedFiles: new Set(injectedFiles), manifest },
						{ cfg, cwd: dir, store: activeStore, ports: { headless } },
					);
					// 期间有新一轮 run 启动（这一份 pending 已被作废）：结果随轮作废，不写回。
					if (pendingRecall !== pending) return;
					pending.files = files;
					pending.content = content;
				} catch {
					/* silently skip auto-surfacing on error */
				} finally {
					pending.settled = true;
					// 只有仍是状态行的持有者才收：新一轮已在搜的话，它的 finally 负责收尾。
					if (surfacingStatusFor === pending) {
						surfacingStatusFor = undefined;
						try {
							ui?.setStatus("surfacing", undefined);
						} catch {
							/* session 在途中 dispose：UI 已失效 */
						}
					}
				}
			})();
			// 未处理 rejection 在 pi 里没有全局 handler（Node 会直接杀进程）：链内已全 catch，
			// 这里再兜一层，保证 prefetch 永不影响宿主。
			void prefetch.catch(() => undefined);
		}

		return {};
	});

	/**
	 * prefetch 的消费点（spec §5.2）：只有「本轮还有后续请求」且「这个边界仍属于启动检索的 prompt」
	 * 的 turn 边界才持久化。
	 *
	 * - 零工具调用的 turn（含单请求轮）= 本轮之后再没有请求：召回作废，不落 session、不标去重；
	 * - 归属校验（`boundaryOwnsRecall`）：`event.context` 里最后一条真实用户消息不是下一个 run
	 *   的 prompt 时，这个边界已经属于别的输入（例如排队中的 follow-up 已被 drain），旧 pending
	 *   作废而不是记到新输入头上；
	 * - `custom_message` entries 只能追加在边界，所以持久块位置固定、只出现一次（prefix cache）；
	 * - 不 `continue`：工具结果本身就会引发下一请求，额外请求只会重算前缀。
	 */
	pi.on("turn_end", (event, ctx) => {
		const pending = pendingRecall;
		if (!pending?.settled || pending.content === "") return;
		if (event.outcome !== "completed" || event.toolResults.length === 0) return;
		// 消费点归属校验：无论结果要不要，这个边界上的 pending 都只能消费一次。
		pendingRecall = undefined;
		if (!boundaryOwnsRecall(lastUserMessage(event.context), pending)) return;
		// 渲染成功才算注入（content 非空）；持久化保证它最迟在下一请求进入上下文。
		for (const f of pending.files) injectedFiles.add(f);
		// spec §14：让用户看见「这一轮想起了什么」。headless 会话不通知；ctx 只在同步段读一次。
		try {
			if (ctx.hasUI) ctx.ui.notify(`Recalled: ${countInjectedBlocks(pending.content)} entries`, "info");
		} catch {
			/* session 在边界上 dispose：通知丢了，召回本身仍然有效 */
		}
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: "memory-auto-surfacing", content: pending.content, display: false },
			],
		};
	});

	// D14：compaction 是**唯一**的会话内刷新点。compaction 已经重写了对话中段，头部再变一次
	// 的边际缓存损失最小，而长会话到这时候往往已经攒下了新记忆（spec §9.1(c) / §10）。
	pi.on("session_compact", async () => {
		const activeStore = store;
		if (!config || !activeStore) return;
		// compaction 会把已注入的内容挤出上下文：不清空，这些 entry 本会话再也不会浮现。
		injectedFiles.clear();
		indexSnapshot = await buildIndexSection(activeStore, config.memIndexInjectMaxLines, config.memIndexInjectMaxBytes);
	});

	// spec §10：所有 reason 共用同一条退出兜底；不按 quit/new/resume/fork/reload 分支。
	pi.on("session_shutdown", async (_event, ctx) => {
		// 同步段快照：后续 await 之后绝不回读可能已 dispose 的 ExtensionContext。
		const runtime = syncRuntime;
		const engine = runtime?.engine ?? null;
		const cfg = config;
		const timeoutMs = cfg?.lock.timeoutMs ?? 5000;
		let ui: ExtensionUIContext | undefined;
		try {
			ui = ctx.hasUI ? ctx.ui : undefined;
		} catch {
			/* session 已经 dispose：只走无 UI 收尾 */
		}

		// 先登记已有的同步轮，再启动 flush；两者都进入既有账本，并共享 lock.timeoutMs 上限。
		const existing = engine?.inFlight;
		if (existing) track(existing);
		const hadWorkBeforeFlush = inFlight.size > 0;
		let flushPromise: Promise<SyncRoundResult | null> | null = null;
		let flushSettled = false;
		let flushWarningShown = false;
		const warnFlush = (reason: string): void => {
			if (flushWarningShown) return;
			flushWarningShown = true;
			notifySync(ui, `Memory sync flush failed: ${reason}; local changes will be retried at the next session start.`);
		};
		if (runtime && cfg) {
			// core 的 flush 在没有已准备 engine 时返回 null（并已登记到活动账）：outcome 成败仍由 round 自己表达。
			try {
				flushPromise = runtime.flush(cfg.sync.autoTimeoutMs);
			} catch (error) {
				flushPromise = Promise.reject(error);
			}
			const activeFlush = flushPromise;
			track(activeFlush);
			// null 只表示没有可回报的结果；只有明确的 ok:false / rejection 才进入失败通知。
			void activeFlush.then(
				(result) => {
					flushSettled = true;
					if (result !== null && !result.ok) warnFlush(result.skipped?.reason ?? "unknown sync flush failure");
				},
				(error: unknown) => {
					flushSettled = true;
					warnFlush(error instanceof Error ? error.message : String(error));
				},
			);
		}

		if (hadWorkBeforeFlush) {
			await waitForShutdownInFlight(timeoutMs);
		} else if (flushPromise) {
			// 干净 engine 的 flush 已 resolve：让 track 的清理链先跑完，不为空转创建一个 give-up timer。
			await Promise.resolve();
			await Promise.resolve();
			await waitForShutdownInFlight(timeoutMs);
		}
		if (flushPromise && !flushSettled) warnFlush("shutdown timed out while waiting for memory sync");

		// 中止超时残留；绝不能 dispose 新 session 的 runtime，也不能在 dispose 后再调用 flush。
		disposeSyncRuntime(runtime);
		const leftover = engine?.inFlight;
		if (leftover) {
			track(leftover);
			await waitForShutdownInFlight(timeoutMs);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		// 先拷到 const：`store` / `memoryDir` 是工厂作用域的 let，在异步回调里 TS 不保留外层收窄。
		const activeStore = store;
		const dir = memoryDir;
		if (!config || !dir || !activeStore) return;
		const extractConfig = config.extractMemories;
		if (!extractConfig?.enabled) return;
		if (!event.messages || event.messages.length === 0) return;
		// 本轮经 extract 的工具真实写入了几条（工具的 onWrite 回调计数，spec §14）。
		let written = 0;
		// pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
		// session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。extract 是
		// 长时后台任务（120s timeout），而 `session_shutdown` 只等 `lock.timeoutMs`（默认 5s），
		// 所以「extract 在途 + session 已销毁」是常态路径：UI 必须在**同步段**快照，回调里不再碰 ctx。
		const ui = ctx.hasUI ? ctx.ui : undefined;
		// extract 的工具集与主 agent 相同（5 个 action），且**只**注入它自己的 headless 子会话；
		// 不开 skipSnapshot：extract 没有整轮快照，它的每次写入都该留下自己的回滚点。
		// 这两件事都由 core 的 runTask(TASKS.extractMemories) 表达，pi 只提供 onWrite 计数与两个端口。
		// `runTask` 是 async：缺模型不在这里同步抛，而是作为 rejection 走下面的两参 `.then`
		// 失败分支（消耗本 session 的失败配额、报「Extract failed」），track 的收尾链照常挂接。
		const extractRun = runTask(
			TASKS.extractMemories,
			{
				// **不再**把消息压成 `{role, content}` 字符串（那是提取失真的根因）：原样交给
				// core，由 pi 的 HostTranscriptPort 保留角色 / tool_call / tool_result。
				messages: event.messages,
				agentsMdBlocks: extractAgentsMdBlocks(lastSystemPrompt),
				onWrite: () => {
					written += 1;
				},
			},
			{
				cfg: config,
				cwd: dir,
				store: activeStore,
				ports: { headless: headlessFor(ctx.modelRegistry), transcript: piTranscript },
			},
		);
		track(extractRun);
		// 用两参 `.then`（而不是 `.then().catch()`）：成功通知自己抛错只会进它自己的分支，
		// 不会被失败回调接住 —— 否则会被误报成 `Extract failed:` 并烧掉本 session 的失败配额。
		void extractRun.then(
			(result) => {
				// 只有「没被锁跳过」且「真的写了东西」才报数：否则每轮都弹一条空通知。
				if (result.skipped || written === 0 || !ui) return;
				try {
					ui.notify(`Extracted ${written} ${written === 1 ? "memory" : "memories"}.`, "info");
				} catch {
					// UI 已失效（session dispose 后宿主会忽略这条通知）：不能拖垮进程。
				}
			},
			(e: unknown) => {
				// spec §14：失败不再被静默吞掉，但同一 session 只报一次（extract 每轮都跑，
				// 模型挂了的时候不能把用户淹没在重复通知里）。
				if (extractErrorNotified || !ui) return;
				extractErrorNotified = true;
				try {
					// rejected 的值不一定是 Error（pi 的模型层可能抛字符串 / 对象）。
					ui.notify(`Extract failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				} catch {
					// 配额已经用掉，不再重试。
				}
			},
		);
	});

	const SYNC_USAGE =
		'Usage: /memory sync [status] | pull | push | remote <url> | unlock. Initialization is automatic; set "sync.enabled" and "sync.remote" in memory.json.';

	function showSyncConfigError(ui: ExtensionUIContext): boolean {
		if (!configError) return false;
		notifySync(ui, `Memory sync unavailable:\n${configError}`, "info");
		return true;
	}

	function showSyncUnavailable(ui: ExtensionUIContext): void {
		if (showSyncConfigError(ui)) return;
		// 没有 runtime 也可能是环境降级（非 git 项目）而非配置错误：原文照显预告，别退化成「未启用」。
		const reason = syncError ?? syncNotice;
		notifySync(
			ui,
			reason
				? `Memory sync unavailable:\n${reason}`
				: 'Memory sync unavailable: sync is not enabled; set "sync.enabled" and "sync.remote" in memory.json.',
			"info",
		);
	}

	/** 严格 dry-run：engine 尚未准备时只读 ready/origin，绝不 prepare/init 或创建 device/manifest。 */
	async function showMemorySyncStatus(ctx: ExtensionContext): Promise<void> {
		const ui = ctx.ui;
		const cfg = config;
		const activeRuntime = syncRuntime;
		if (!cfg || !activeRuntime) {
			showSyncUnavailable(ui);
			return;
		}
		try {
			// 严格 dry-run 由 core 保证：engine 尚未准备时只读 ready/origin，绝不 prepare/init。
			const status = await activeRuntime.status(cfg.sync.timeoutMs);
			if (!status.ok) {
				notifySync(ui, `Memory sync status failed: ${syncErrorMessage(status.reason)}`);
				return;
			}
			if (!("origin" in status.value)) {
				notifySync(ui, renderSyncStatus(status.value, typeof cfg.sync.remote === "string" ? cfg.sync.remote : ""), "info");
				return;
			}
			if (!status.value.initialized) {
				notifySync(
					ui,
					'Memory sync is not initialized: set "sync.remote" in memory.json; initialization runs at session start, or use /memory sync pull to retry.',
					"info",
				);
				return;
			}
			notifySync(
				ui,
				syncErrorMessage(
					[
						"Memory sync is initialized but not ready; run /memory sync pull or push to finish preparation.",
						`Origin: ${status.value.origin ?? "(not set)"}`,
						`Configured remote: ${typeof cfg.sync.remote === "string" && cfg.sync.remote.trim() !== "" ? cfg.sync.remote : "(not set)"}`,
					].join("\n"),
				),
				"info",
			);
		} catch (error) {
			notifySync(ui, `Memory sync status failed: ${syncErrorMessage(error)}`);
		}
	}

	async function runMemorySyncRound(kind: "pull" | "push", ctx: ExtensionContext): Promise<void> {
		const ui = ctx.ui;
		const cfg = config;
		const activeRuntime = syncRuntime;
		if (!cfg || !activeRuntime) {
			showSyncUnavailable(ui);
			return;
		}
		try {
			let preparedWarning: string | undefined;
			const outcome = await activeRuntime.run(kind, cfg.sync.timeoutMs, (warning) => {
				preparedWarning = warning;
				// 手动恢复也必须先让人看到预告，再执行会产生/发布副本的那一轮。
				notifySync(ui, `Memory sync ${kind} preparation:\n${syncErrorMessage(warning)}`, "info");
			});
			if (!outcome.ok) {
				setSyncError([...syncPersistentErrors, outcome.reason]);
				notifySync(ui, `Memory sync ${kind} failed: ${syncErrorMessage(outcome.reason)}`);
				return;
			}
			const round = outcome.value;
			const preparationWarning = outcome.warning ?? preparedWarning;
			const errors = [...syncPersistentErrors];
			if (!round.ok) errors.push(round.skipped?.reason ?? `unknown sync ${kind} failure`);
			setSyncError(errors);
			setSyncNotice(preparationWarning ? [preparationWarning] : []);
			const rendered = renderSyncRound(round);
			if (!round.ok) {
				notifySync(
					ui,
					`Memory sync ${kind} failed: ${syncErrorMessage(round.skipped?.reason ?? "unknown sync failure")}\n${rendered}`,
				);
				return;
			}
			notifySync(ui, `Memory sync ${kind}:\n${rendered}`, "info");
		} catch (error) {
			const reason = syncErrorMessage(error);
			setSyncError([...syncPersistentErrors, reason]);
			notifySync(ui, `Memory sync ${kind} failed: ${reason}`);
		}
	}

	async function changeMemorySyncRemote(remote: string, ctx: ExtensionContext): Promise<void> {
		const ui = ctx.ui;
		const cfg = config;
		const activeRuntime = syncRuntime;
		if (!cfg || !activeRuntime) {
			showSyncUnavailable(ui);
			return;
		}
		try {
			// core 在公开调用时就关闸；预告经回调即时通知，才能先于 replacement 写触发到达用户。
			const changed = await activeRuntime.changeRemote(remote, cfg.sync.timeoutMs, (warning) => {
				notifySync(ui, `Memory sync remote preparation:\n${syncErrorMessage(warning)}`, "info");
			});
			const errors = [...syncPersistentErrors];
			if (!changed.ok) errors.push(changed.reason);
			setSyncError(errors);
			setSyncNotice(changed.ok && changed.warning ? [changed.warning] : []);
			if (!changed.ok) {
				notifySync(ui, `Memory sync remote failed: ${syncErrorMessage(changed.reason)}`);
				return;
			}
			notifySync(
				ui,
				`Memory sync remote: ${syncErrorMessage(remote)}\nOrigin changed and this project's baseline was reset; memory.json was not modified.`,
				"info",
			);
		} catch (error) {
			const reason = syncErrorMessage(error);
			setSyncError([...syncPersistentErrors, reason]);
			notifySync(ui, `Memory sync remote failed: ${reason}`);
		}
	}

	pi.registerCommand("memory", {
		description: "Show memory status or remove a stale lock",
		handler: async (args, ctx) => {
			const parts = args.trim() === "" ? [] : args.trim().split(/\s+/);
			if (parts[0] === "sync") {
				const subcommand = parts[1] ?? "status";
				// 根锁恢复只依赖配置根；模型错误绝不能把唯一人工恢复入口一并禁掉。
				if (subcommand === "unlock" && parts.length === 2 && config) {
					await unlockMemorySync(config, ctx.ui);
					return;
				}
				// 其他 sync 命令必须先暴露真实配置错误，不能落成笼统的 not enabled。
				if (showSyncConfigError(ctx.ui)) return;
				if (!config) {
					notifySync(ctx.ui, "Memory not initialized; start a session before using /memory sync.", "info");
					return;
				}
				if (subcommand === "status" && parts.length <= 2) {
					await showMemorySyncStatus(ctx);
					return;
				}
				if ((subcommand === "pull" || subcommand === "push") && parts.length === 2) {
					await runMemorySyncRound(subcommand, ctx);
					return;
				}
				if (subcommand === "remote" && parts.length === 3) {
					await changeMemorySyncRemote(parts[2], ctx);
					return;
				}
				notifySync(ctx.ui, SYNC_USAGE, "info");
				return;
			}
			// 配置都读不出来（`loadConfig` 抛错）时也要报真实原因，而不是笼统的「未初始化」——
			// `/memory` 是重读错误态的唯一入口。首次会话就失败时 `config` 仍是 null，所以这里先看错误态。
			if (!config) {
				if (configError) {
					ctx.ui.notify(
						["Memory: misconfigured", "Dir: not initialized", ...configError.split("\n").map((e) => `- ${e}`)].join("\n"),
						"info",
					);
					return;
				}
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			if (args === "unlock") {
				// `unlock` 只需要**目录**、不需要 store：以配置错误启动的会话也要能清锁
				//（它是崩溃遗留 `.lock` 的唯一人工入口，spec §19）。
				let dir = memoryDir;
				if (!dir) {
					// 目录解析本身可能失败（HOME 不可写 / git 探测炸了）：失败要变成一条可读的 error
					// 通知，不能冒泡成命令 handler 抛错（那只会变成一条裸的宿主报错）。
					try {
						dir = await resolveMemoryDir(config, ctx.cwd);
					} catch (e) {
						ctx.ui.notify(`Failed to resolve memory dir: ${e instanceof Error ? e.message : String(e)}`, "error");
						return;
					}
				}
				await unlockMemory(dir, ctx.ui);
				return;
			}
			// 先拷到 const：`store` / `memoryDir` 是工厂作用域的 let，异步回调里 TS 不保留外层收窄。
			const activeStore = store;
			const dir = memoryDir;
			if (!dir || !activeStore) {
				// `config` 非 null 而 store 为 null 只可能来自 session_start 的两条早退路径，
				// 因此 configError 在这里必非空；`/memory` 是用户重读错误态的唯一入口。
				const lines = ["Memory: misconfigured", "Dir: not initialized"];
				if (configError) lines.push(...configError.split("\n").map((e) => `- ${e}`));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			// 两套口径都要报：`Index:` 是写入口径（用户要知道「还能不能写」），`Inject:` 是注入口径
			// —— 窗口只取索引**最新**的 50 行，与写入口径解耦，只报前者会让用户以为 Entries 全在
			// prompt 里。`indexInjectionCapacity` 与真正注入共用同一个窗口核心，数字不可能漂移。
			// unrecognized 是索引里非空但解析不了的行数 —— 手写标题/分组/被 Windows 编辑器改坏的行
			// 都在这里露出来。
			const indexRaw = await activeStore.readIndex();
			const cap = indexCapacity(indexRaw, config.memIndexMaxLines, config.memIndexMaxBytes);
			const inject = indexInjectionCapacity(indexRaw, config.memIndexInjectMaxLines, config.memIndexInjectMaxBytes);
			const summaryLines = [
				`Dir: ${dir}`,
				`Index: ${cap.lineCount}/${config.memIndexMaxLines} lines, ${cap.byteLength}/${config.memIndexMaxBytes} bytes, ${parseEntryIndex(indexRaw).unrecognized} unrecognized lines`,
				`Inject: ${inject.lineCount}/${config.memIndexInjectMaxLines} lines, ${inject.byteLength}/${config.memIndexInjectMaxBytes} bytes`,
				`Entries: ${(await activeStore.listEntries()).length}`,
				`Modules: ${moduleStatusLine(config)}`,
				`Last dream: ${(await readDreamMeta(dir))?.lastDreamAt ?? "never"}`,
				`Lock: ${await lockStatusLine(dir)}`,
			];
			// 默认未启用时保留既有 7 行状态；启用/降级后追加同步段，且不调用 engine.status/init。
			if (syncRuntime || syncError || syncNotice) {
				summaryLines.push(`Sync: ${syncRuntime?.engine ? "ready" : syncRuntime ? "not initialized" : "disabled"}`);
				// 预告与错误分区显示：预告不是故障，混在错误行里会让人以为同步坏了。
				if (syncNotice) {
					summaryLines.push("Sync notice:", ...syncNotice.split("\n").map((notice) => `- ${notice}`));
				}
				if (syncError) summaryLines.push(...syncError.split("\n").map((error) => `- ${error}`));
			}
			// 2.x 数据根的迁移提示：只提示、不动数据。探测失败不得让 `/memory` 报错 ——
			// 状态块本身才是这个命令的交付物。
			try {
				const hint = await detectLegacyMemoryDir({
					newDir: dir,
					// 必须是**配置生效后**的根（`resolveMemoryDir` 内部也是先 `resolve(config.memoryDir)`）：
					// 用户配了自定义 memoryDir 时，指向 XDG 默认根会让他把记忆搬到 agent 永远不读的地方。
					newRoot: resolve(config.memoryDir),
					legacyRoot: legacyMemoryRoot(),
					cwd: ctx.cwd,
				});
				if (hint) summaryLines.push("", hint);
			} catch {
				/* 探测失败：状态块照常输出 */
			}
			ctx.ui.notify(summaryLines.join("\n"), "info");
		},
	});

	pi.registerCommand("dream", {
		description: "Consolidate all memory files via a headless agent",
		handler: async (_args, ctx) => {
			const activeStore = store;
			if (!config || !memoryDir || !activeStore) {
				ctx.ui.notify("Memory not initialized.", "info");
				return;
			}
			// 同步段快照：dream 在途时用户可能 /new、切换、fork、reload。`cwd` 也要快照 ——
			// 完成回调里的 `SessionManager.list` 在 await 之后才读它（见 notifyDream 的说明）。
			const ui = ctx.hasUI ? ctx.ui : undefined;
			const cwd = ctx.cwd;
			const headless = headlessFor(ctx.modelRegistry);
			const ok = await ctx.ui.confirm("Dream", "Consolidate all memory files? This rewrites them in-place.");
			if (!ok) return;
			const dir = memoryDir;
			// `runTask` 是 async：缺模型不在这里同步抛，而是作为 rejection 走下面的两参
			// `.then` 失败分支（报「Dream failed」）；状态行由 `.finally` 兜底清除，不会残留。
			const dreamRun = runTask(TASKS.dream, {}, { cfg: config, cwd: dir, store: activeStore, ports: { headless } });
			ui?.setStatus("dream", "Consolidating memory...");
			track(dreamRun);
			void dreamRun
				.then(
					async (summary) => {
						try {
							const sessions = (await SessionManager.list(cwd)).length;
							await writeDreamMeta(dir, sessions);
						} catch (e) {
							notifyDream(ui, dreamFailureMessage(e), "error");
							return;
						}
						notifyDream(ui, summary, "info");
					},
					(e: unknown) => notifyDream(ui, dreamFailureMessage(e), "error"),
				)
				.finally(() => clearDreamStatus(ui));
		},
	});
}
