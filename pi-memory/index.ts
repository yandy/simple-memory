import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
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
import { type LoadedConfig, legacyMemoryRoot, loadConfig, type MemoryConfig, modelConfigErrors } from "./src/config";
import { createPiTranscript } from "./src/host-transcript";
import { readRecordedMemoryIndex } from "./src/index-source";
import { applyIndexSection, buildInjection } from "./src/inject-pi";
import { detectLegacyMemoryDir } from "./src/legacy-hint";
import { createMemoryTool, type MemoryToolDeps, type MemoryToolOptions } from "./src/memory-tool";
import { resolveModel } from "./src/model-resolver";
import { readDreamMeta, shouldNudge, writeDreamMeta } from "./src/nudge";
import { searchSessions } from "./src/session-search";
import {
	createPiSyncRuntime,
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
			target?.dispose();
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
				syncRuntime?.engine?.noteWrite();
			},
		});
	}

	const headlessFor = (modelRegistry: ExtensionContext["modelRegistry"]) =>
		createPiHeadlessAgent({
			modelRegistry,
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
				assembled.runtime?.dispose();
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
				// 自动初始化与启动收敛共用一份预算；prepare 之外绝不再造一份完整网络预算。
				const startupDeadline = Date.now() + cfg.sync.autoTimeoutMs;
				const prepared = await activeRuntime.prepare(cfg.sync.autoTimeoutMs);
				if (!isCurrent()) return;
				if (!prepared.ok) {
					syncErrors.push(prepared.reason);
				} else {
					if (prepared.warning) {
						syncNotices.push(prepared.warning);
						// 首次本地记忆的冲突预告必须发生在任何启动 push 之前，不能等副本已经落盘才说。
						notifyPendingSyncNotices();
					}
					// 一轮 push = 收敛 + 补推；pullOnStart false 仍 prepare，但绝不 fetch/pull/push。
					if (cfg.sync.pullOnStart === true) {
						const remaining = startupDeadline - Date.now();
						if (remaining <= 0) {
							// 预算用尽是「本轮跳过、下一轮再推」，不是失败：走预告通道，别染红启动日志。
							syncNotices.push(
								`the automatic startup budget of ${cfg.sync.autoTimeoutMs}ms was exhausted during preparation; ` +
									"startup push was skipped and will run on the next round",
							);
						} else {
							const round = await activeRuntime.runActivity(() => prepared.engine.push(remaining));
							if (!isCurrent()) return;
							if (!round.ok) syncErrors.push(round.skipped?.reason ?? "memory sync startup round failed");
						}
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
		// 折叠路径下其后的整段对话全部失去缓存。录制值拿不到（更老的 session、旧 SDK 没有
		// sessionEntryToContextMessages）才回退磁盘读。
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
			pi.registerTool(
				// biome-ignore lint/suspicious/noExplicitAny: pi registerTool type cast
				buildMemoryTool() as any,
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
			const errors = modelConfigErrors(loaded.config, (value) => resolveModel(value, modelRegistry) !== undefined);
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
		if (!config || !memoryDir || !activeStore) return;
		const headless = headlessFor(ctx.modelRegistry);

		// 索引 section：**每一轮无条件**写入冻结值（含 resume / fork / reload）。
		// 省略这个键 = pi 的 diffSystemPromptSections 生成 { memory_index: null } = 把索引从
		// system prompt 里静默删掉（spec §9.1 的 null 陷阱）。「不想改」只能靠喂回同一个值。
		// 必须在 auto-surfacing **之前**：surfacing 的 `finally` 在 await 之后读 `ctx.hasUI`，
		// session 在途中 dispose 会让 handler 从那里抛出（R49）——那时 section 已经被跳过，
		// 这一轮就从「喂回冻结值」变成了「删段」。
		const applied = applyIndexSection(event.systemPromptOptions, indexSnapshot);

		const autoSurfacing = config.autoSurfacing;
		// Skip auto-surfacing in subagent sessions: pi-subagents injects an
		// <active_agent name="..."/> tag into every subagent's system prompt.
		// Main sessions (including forks) never have this tag. Our own headless
		// sessions use noExtensions (never bind), so they never reach here.
		const isSubagent = event.systemPrompt?.includes('<active_agent name="');
		// 1.2.0 起 `before_agent_start` 是两种 run 的联合：`messageType: "user"` 带 `prompt`，
		// `messageType: "custom"`（`pi.sendMessage(..., { triggerTurn: true })` 空闲触发）带 `message`。
		// 自动浮现按用户输入检索，custom run 没有用户输入可检索，跳过（不是降级）。
		const promptText = event.messageType === "user" ? event.prompt : undefined;
		// biome-ignore lint/suspicious/noExplicitAny: message injection result
		let injectedMessage: any;
		if (autoSurfacing?.enabled && promptText && !isSubagent) {
			try {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", "Searching relevant memories…");
				const manifest = await scanEntries(activeStore);
				if (manifest.length > 0) {
					const { files, content } = await runTask(
						TASKS.autoSurfacing,
						{ userPrompt: promptText.slice(0, 4000), injectedFiles, manifest },
						{ cfg: config, cwd: memoryDir, store: activeStore, ports: { headless } },
					);
					// 渲染成功才算注入（content 非空）；渲染不出的文件不标记，下一轮仍有机会再选。
					if (content !== "") {
						for (const f of files) injectedFiles.add(f);
						injectedMessage = { customType: "memory-auto-surfacing", content, display: false };
						// spec §14：让用户看见「这一轮想起了什么」。headless 会话不通知。
						if (ctx.hasUI) {
							ctx.ui.notify(`Recalled: ${countInjectedBlocks(content)} entries`, "info");
						}
					}
				}
			} catch {
				/* silently skip auto-surfacing on error */
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("surfacing", undefined);
			}
		}

		return {
			// 没有 `sections` 的老宿主（0.99.2 之前）走这条退路：整段替换 system prompt，
			// 功能不受损，只是缓存变差。
			...(applied ? {} : { systemPrompt: buildInjection(event.systemPrompt, indexSnapshot) }),
			...(injectedMessage ? { message: injectedMessage } : {}),
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
		if (engine && cfg && runtime) {
			try {
				flushPromise = runtime.runActivity(() => engine.flush(cfg.sync.autoTimeoutMs));
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
			await activeRuntime.runActivity(async () => {
				const engine = activeRuntime.engine;
				if (!engine) {
					const initialized = await activeRuntime.backend.ready();
					if (!initialized) {
						notifySync(
							ui,
							'Memory sync is not initialized: set "sync.remote" in memory.json; initialization runs at session start, or use /memory sync pull to retry.',
							"info",
						);
						return;
					}
					const origin = await activeRuntime.backend.getRemote();
					notifySync(
						ui,
						syncErrorMessage(
							[
								"Memory sync is initialized but not ready; run /memory sync pull or push to finish preparation.",
								`Origin: ${origin ?? "(not set)"}`,
								`Configured remote: ${typeof cfg.sync.remote === "string" && cfg.sync.remote.trim() !== "" ? cfg.sync.remote : "(not set)"}`,
							].join("\n"),
						),
						"info",
					);
					return;
				}
				const report = await engine.status(cfg.sync.timeoutMs);
				notifySync(ui, renderSyncStatus(report, typeof cfg.sync.remote === "string" ? cfg.sync.remote : ""), "info");
			});
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
			await activeRuntime.runActivity(async () => {
				const prepared = await activeRuntime.prepare(cfg.sync.timeoutMs);
				if (!prepared.ok) {
					setSyncError([...syncPersistentErrors, prepared.reason]);
					notifySync(ui, `Memory sync ${kind} failed: ${syncErrorMessage(prepared.reason)}`);
					return;
				}
				if (prepared.warning) {
					// 手动恢复也必须先让人看到预告，再执行会产生/发布副本的那一轮。
					notifySync(ui, `Memory sync ${kind} preparation:\n${syncErrorMessage(prepared.warning)}`, "info");
				}
				const round = await prepared.engine[kind](cfg.sync.timeoutMs);
				const errors = [...syncPersistentErrors];
				if (!round.ok) errors.push(round.skipped?.reason ?? `unknown sync ${kind} failure`);
				setSyncError(errors);
				setSyncNotice(prepared.warning ? [prepared.warning] : []);
				const rendered = renderSyncRound(round);
				if (!round.ok) {
					notifySync(
						ui,
						`Memory sync ${kind} failed: ${syncErrorMessage(round.skipped?.reason ?? "unknown sync failure")}\n${rendered}`,
					);
					return;
				}
				notifySync(ui, `Memory sync ${kind}:\n${rendered}`, "info");
			});
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
			const prepared = await activeRuntime.changeRemote(remote, cfg.sync.timeoutMs);
			const errors = [...syncPersistentErrors];
			if (!prepared.ok) errors.push(prepared.reason);
			setSyncError(errors);
			setSyncNotice(prepared.ok && prepared.warning ? [prepared.warning] : []);
			if (!prepared.ok) {
				notifySync(ui, `Memory sync remote failed: ${syncErrorMessage(prepared.reason)}`);
				return;
			}
			if (prepared.warning) {
				notifySync(ui, `Memory sync remote preparation:\n${syncErrorMessage(prepared.warning)}`, "info");
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
