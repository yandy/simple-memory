import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, type MemoryConfig, syncConfigErrors } from "../config.js";
import { withFsRetry } from "../store/fs-retry.js";
import type { MemoryStore } from "../store/memory-store.js";
import type { ProjectIdentity } from "../store/paths.js";
import type { SyncBackend } from "./backend.js";
import { loadOrCreateDevice } from "./device.js";
import type { SyncEngine, SyncEngineOptions, SyncRoundResult, SyncStatusReport } from "./engine.js";
import { syncErrorMessage } from "./errors.js";
import {
	emptyManifest,
	manifestMatchesTransport,
	manifestPath,
	readManifest,
	type SyncTransport,
	syncTransport,
	type writeManifest,
} from "./manifest.js";
import { remoteProjectKey, sameSyncRemote, syncRootPath } from "./paths.js";

/**
 * 会话级同步 runtime：把「门禁 → backend 装配 → 懒 engine → prepare → 启动/手动轮次 → 收摊」
 * 收成**一份**宿主中立的实现，pi 与 dsh 只注入自己的配置、生命周期与通知。
 *
 * 三条边界写在这里，因为越界的代价都是静默分叉：
 *
 * - **不认识宿主**：backend、engine 与首份基线的 writer 都由宿主从公开出口注入。runtime 拥有它们的
 *   生命周期与调用顺序，但这里没有 `createGitSyncBackend` 的默认装配 —— 一旦写死，core 就替宿主
 *   决定了「同步去哪儿」，而换一个存储实现要改 core。
 * - **不碰宿主配置文件**：这里的输入只有传进来的 config/store/identity，没有任何宿主配置文件路径。
 * - **失败不阻塞会话**：所有出口都是 `{ ok: false, reason }`，reason 先经 {@link syncErrorMessage}
 *   脱敏；同步坏掉最多退回手动，不影响其他记忆功能。
 *
 * `writeManifest` 刻意作为注入项而不是包内相对 import：适配层用包级测试替身注入故障时，runtime 若
 * 绕过注入直接调用同包的 `writeManifest`，那个观察点就失效了 —— 首份基线写失败这条路径会悄悄变成
 * 「测不到」。
 */

/** runtime 的装配参数。全部由适配层算好交进来：core 不读配置文件，也不猜项目身份。 */
export interface SyncRuntimeOptions {
	config: MemoryConfig;
	store: MemoryStore;
	projectDir: string;
	identity: ProjectIdentity;
	/**
	 * 活动协调方式。`concurrent` 的高层调用立即起跑并登记；`serial` 走一条 FIFO tail。
	 * 两种模式共用同一本活动账与同一套持久顺序，差异只在排队方式。
	 */
	scheduling: "concurrent" | "serial";
	createBackend(context: { syncRoot: string; memoryRoot: string; remote: string; branch: string }): SyncBackend;
	createEngine(options: SyncEngineOptions): SyncEngine;
	/** 首份基线的写入原语；由宿主从公开出口传入，保留故障注入观察点。 */
	writeManifest: typeof writeManifest;
	messages: {
		/** 含宿主自己的命令指引；core 不内置 slash 命令。 */
		originDrift: string;
		/** 未初始化却请求换远端时，指向宿主自己的配置来源。 */
		uninitializedRemoteChange: string;
		/**
		 * 可选：保留宿主对「origin 已改但后续失败」的既有措辞。
		 *
		 * `remote` 是原始输入，可能含 URL userinfo，不得未脱敏就写日志；`reason` 已脱敏，formatter
		 * 返回的完整文本也会再次脱敏。formatter 抛错时退回已脱敏原 reason，并补上中立的 stage /
		 * originChanged 上下文；正常的 replacement engine 恢复与写触发仍会继续。
		 */
		formatRemoteChangeFailure?(failure: {
			remote: string;
			originChanged: boolean;
			stage: "prepare" | "operation";
			reason: string;
		}): string;
	};
	/** 只为测试可固定：基线的 `syncedAt` 与设备身份都走它。 */
	now?: () => Date;
}

/** runtime 的出口形状：失败只带一句已脱敏的 reason，成功可附带非致命 warning。 */
export type SyncRuntimeOutcome<T> = { ok: true; value: T; warning?: string } | { ok: false; reason: string };

/** prepare 的结果：成功时交出可直接跑轮次的 engine（可能附带首次基线预告）。 */
export type SyncPrepareResult = { ok: true; engine: SyncEngine; warning?: string } | { ok: false; reason: string };

/**
 * status 的两种形状：engine 已准备时是完整报告；否则只有「初始化了没有 + 真实 origin」，
 * 因为严格 dry-run 不允许为了报告去 prepare、建 engine 或写基线。
 */
export type SyncRuntimeStatus = SyncStatusReport | { initialized: boolean; origin: string | null };

export interface SyncRuntime {
	/** 当前已交付的 engine；`null` 表示还没 prepare 过（或已收摊）。 */
	readonly engine: SyncEngine | null;
	prepare(timeoutMs: number): Promise<SyncPrepareResult>;
	startup(onWarning?: (warning: string) => void): Promise<SyncRuntimeOutcome<SyncRoundResult | null>>;
	run(
		kind: "pull" | "push",
		timeoutMs: number,
		onWarning?: (warning: string) => void,
	): Promise<SyncRuntimeOutcome<SyncRoundResult>>;
	status(timeoutMs: number): Promise<SyncRuntimeOutcome<SyncRuntimeStatus>>;
	changeRemote(
		remote: string,
		timeoutMs: number,
		onWarning?: (warning: string) => void,
	): Promise<SyncRuntimeOutcome<null>>;
	/** 无已准备 engine 时返回 `null`；其余语义与 `SyncEngine.flush` 相同。 */
	flush(timeoutMs: number): Promise<SyncRoundResult | null>;
	noteWrite(): void;
	/**
	 * 调用时同步关闭入口并 abort/dispose；返回的 promise 只负责 drain，不发起 flush。
	 * dispose 前已启动的 manifest writer 可在 drain 内完成且必须被等待；之后不得新起写入，
	 * drain 完成后不得残留写入/I/O，也不交付 engine 或补发 replacement noteWrite。
	 */
	dispose(): Promise<void>;
}

const DISPOSED_REASON = "sync runtime is disposed";
const BUDGET_REASON = "sync initialization requires a finite positive timeout budget";
const BUSY_REASON = "sync remote change is already in progress; retry the operation afterwards";
const NOT_INITIALIZED_ORIGIN = "the initialized sync origin is unavailable";

/** 所有失败出口的唯一构造器：固定 reason 与动态错误都在这里过一遍脱敏。 */
function failure(reason: unknown): { ok: false; reason: string } {
	return { ok: false, reason: syncErrorMessage(reason) };
}

/** 有限正预算：`NaN` / `0` / `Infinity` 传到子进程 timeout 或定时器上都会变成「无限等」。 */
function positiveBudget(timeoutMs: number): boolean {
	return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

/**
 * 装配同步，**不做任何初始化写入**：不 init、不写 device、不写 manifest。
 *
 * 门禁与今天的宿主实现逐条相同，只是收成了一份：非 git 项目是**降级**（走 notices），
 * disabled 与非法配置返回 `runtime: null`，且错误文本在这里就过一遍脱敏。
 * 返回的 runtime 即使 prepare 失败也保留 —— 显式 pull/push 可以在修好远端之后走同一个恢复入口。
 */
export async function createSyncRuntime(options: SyncRuntimeOptions): Promise<{
	runtime: SyncRuntime | null;
	errors: string[];
	notices: string[];
}> {
	const { config, store, projectDir, identity, messages } = options;
	const now = options.now ?? ((): Date => new Date());
	const sync = config.sync;
	const enabled = sync?.enabled === true;
	const notices: string[] = [];

	if (identity.kind !== "git") {
		// 环境不支持（非 git 项目）是**降级**，不是故障：走预告通道，别让宿主把它渲染成红色 Error。
		if (enabled) notices.push("Memory sync v1 only supports git projects; sync is disabled for this session.");
		return { runtime: null, errors: syncConfigErrors(config).map(syncErrorMessage), notices };
	}
	if (!enabled) return { runtime: null, errors: syncConfigErrors(config).map(syncErrorMessage), notices };

	const memoryRoot = resolve(config.memoryDir);
	const syncRoot = syncRootPath(memoryRoot);
	const remote = typeof sync.remote === "string" ? sync.remote : "";
	const branch = typeof sync.branch === "string" && sync.branch.trim() !== "" ? sync.branch : DEFAULT_CONFIG.sync.branch;
	const backend = options.createBackend({ syncRoot, memoryRoot, remote, branch });

	// 首次 ready() 只为两件事：配置校验（已初始化后配置 remote 留空合法）与 origin 漂移提示。
	const errors: string[] = [];
	let initialized = false;
	try {
		initialized = await backend.ready();
	} catch (error) {
		errors.push(`Failed to inspect memory sync state: ${syncErrorMessage(error)}`);
	}

	const configErrors = syncConfigErrors(config, { initialized }).map(syncErrorMessage);
	if (configErrors.length > 0) return { runtime: null, errors: [...errors, ...configErrors], notices };

	if (initialized && remote.trim() !== "") {
		try {
			const origin = await backend.getRemote();
			// origin 是真相来源：配置与它不一致时**不改任何行为**，只把宿主自己的那句提醒交出去。
			if (origin !== null && !sameSyncRemote(origin, remote)) errors.push(syncErrorMessage(messages.originDrift));
		} catch (error) {
			errors.push(`Failed to read the initialized sync origin: ${syncErrorMessage(error)}`);
		}
	}

	const projectKey = remoteProjectKey(identity.key);
	const projectManifest = manifestPath(syncRoot, projectKey);

	/** 已交付的 engine（公开面看到的那一个）。 */
	let currentEngine: SyncEngine | null = null;
	/**
	 * 已创建但还没交付的 engine。
	 *
	 * init 的共存检查通过之前连 device 都不能创建，所以 engine 必须后置；而「造出来了、预告还没读完」
	 * 这段时间里失败收摊必须有人负责 dispose 它 —— 这个账本就是那份责任。
	 */
	let pendingEngine: SyncEngine | null = null;
	let initController: AbortController | null = null;
	let prepareInFlight: Promise<SyncPrepareResult> | null = null;
	let remoteChangeInFlight: Promise<SyncRuntimeOutcome<null>> | null = null;
	let disposeFlight: Promise<void> | null = null;
	let disposed = false;
	let remoteChangeActive = false;
	/** serial 的 FIFO 只编排高层活动；engine 自己的自动轮仍由 engine.inFlight 单独登记。 */
	let tail: Promise<unknown> = Promise.resolve();
	/** 两种协调模式共用一本活动账，换远端与 dispose 都从它 drain。 */
	const activities = new Set<Promise<unknown>>();

	function disposedOutcome<T>(): SyncRuntimeOutcome<T> {
		return failure(DISPOSED_REASON);
	}

	function busyOutcome<T>(): SyncRuntimeOutcome<T> {
		return failure(BUSY_REASON);
	}

	function okOutcome<T>(value: T, warning: string | undefined): SyncRuntimeOutcome<T> {
		return warning === undefined ? { ok: true, value } : { ok: true, value, warning };
	}

	function joinWarning(warning: string | undefined, extra: string): string {
		return warning === undefined ? extra : `${warning}\n${extra}`;
	}

	/**
	 * 登记一次活动。
	 *
	 * `activity()` 在登记之前就执行：`concurrent` 的既有语义是「公开调用返回前已经开始」，
	 * 为记账多引入一个微任务会改变调用方的观察顺序。登记只为后续 drain 与换远端闸服务。
	 */
	function track<T>(activity: () => Promise<T>): Promise<T> {
		let flight: Promise<T>;
		try {
			flight = activity();
		} catch (error) {
			flight = Promise.reject(error);
		}
		activities.add(flight);
		void flight
			.catch(() => undefined)
			.finally(() => {
				activities.delete(flight);
			});
		return flight;
	}

	/** 手动活动与换远端共用一条 tail；tail 自身永不 reject，后续活动不会被前一次失败截断。 */
	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const flight = tail.then(operation, operation);
		tail = flight.then(
			() => undefined,
			() => undefined,
		);
		return flight;
	}

	function coordinate<T>(operation: () => Promise<T>): Promise<T> {
		// serial 只在真正出队时登记，避免把尚未开始的操作误算成正在执行的 engine I/O。
		return options.scheduling === "serial" ? enqueue(() => track(operation)) : track(operation);
	}

	async function buildEngine(): Promise<SyncEngine> {
		const device = await loadOrCreateDevice(syncRoot, now);
		return options.createEngine({ syncRoot, projectDir, projectKey, store, backend, device, config: sync, now });
	}

	/** 失败恢复也留一台 engine 接住旧 dirty 与关闸期间的写入；缺失 manifest 仍是安全空基线。 */
	async function ensureRuntimeEngine(): Promise<SyncEngine | null> {
		if (currentEngine !== null) return currentEngine;
		const engine = await buildEngine();
		if (disposed) {
			engine.dispose();
			return null;
		}
		currentEngine = engine;
		return engine;
	}

	/**
	 * 一次 prepare 的真实流程（single-flight 由公开的 `prepare` 负责）。
	 *
	 * 顺序是安全边界，不是风格：init 的共存检查通过之前不建 device；init 之后重新读**实际** origin
	 * 才写基线（配置里那个值可能早就与 origin 漂移，也可能为空）；预告读完之后才把 engine 从
	 * pending 账本交出去。任一 await 之后都要重新检查 disposed，避免收摊后新起写入；已经启动的
	 * writer 则由 prepare flight 纳入 dispose drain，允许完成且必须等它完成。
	 */
	async function runPrepare(timeoutMs: number): Promise<SyncPrepareResult> {
		try {
			// 有完整 manifest 的 ready 快路径绝不联网；缺失 manifest 则是跨进程持久 pending。
			const ready = await backend.ready();
			if (disposed) return failure(DISPOSED_REASON);
			const manifest = await readManifest(projectManifest);
			if (disposed) return failure(DISPOSED_REASON);
			let transport: SyncTransport | null = null;
			if (ready && manifest !== null) {
				const origin = await backend.getRemote();
				// 收摊之后到写基线之间还有 buildEngine：迟到的 device.json 在这里就必须被拦住。
				if (disposed) return failure(DISPOSED_REASON);
				if (origin === null) throw new Error(`${NOT_INITIALIZED_ORIGIN}; no baseline was trusted`);
				transport = syncTransport(origin, branch);
			}
			const transportMatches = manifest !== null && transport !== null && manifestMatchesTransport(manifest, transport);
			if (ready && transportMatches && currentEngine !== null) return { ok: true, engine: currentEngine };

			let initializedNow: { revision: string; warnings: string[] } | null = null;
			if (!ready || !transportMatches) {
				// 首次 init 做共存检查；缺失/不匹配的基线时复核当前 origin，绝不沿用旧 base。
				const controller = new AbortController();
				initController = controller;
				try {
					initializedNow = await backend.init({ timeoutMs, signal: controller.signal });
				} finally {
					if (initController === controller) initController = null;
				}
				if (disposed) return failure(DISPOSED_REASON);
			}

			let engine = currentEngine;
			if (engine === null) {
				engine = await buildEngine();
				if (disposed) {
					engine.dispose();
					return failure(DISPOSED_REASON);
				}
				pendingEngine = engine;
			}

			if (initializedNow !== null) {
				// init 之后的真实 origin 才是基线身份：配置漂移或跨进程旧写入都不能换掉它。
				const origin = await backend.getRemote();
				if (origin === null) throw new Error(`${NOT_INITIALIZED_ORIGIN}; no baseline was written`);
				// 读 origin 是启动 writer 前的最后一个 await：这里收摊就必须拦住新写；writer 一旦启动，
				// 这次原子写可在 dispose drain 内完成，但 engine 不会再交付。
				if (disposed) return failure(DISPOSED_REASON);
				const baseline = emptyManifest(syncTransport(origin, branch));
				baseline.base = { revision: initializedNow.revision, syncedAt: now().toISOString() };
				await options.writeManifest(projectManifest, baseline);
				if (disposed) return failure(DISPOSED_REASON);
			}

			const warnings = [...(initializedNow?.warnings ?? [])];
			if (initializedNow !== null) {
				// 首次基线的冲突副本预告：本地已有 entry 时，同名不同内容会被收敛成确定性副本。
				const localEntries = await store.listEntries();
				if (disposed) return failure(DISPOSED_REASON);
				if (localEntries.length > 0) {
					warnings.push(
						`Memory sync initialized with ${localEntries.length} local ${
							localEntries.length === 1 ? "entry" : "entries"
						}; same-named entries with different content may be kept as deterministic conflict copies.`,
					);
				}
			}
			if (disposed) return failure(DISPOSED_REASON);
			// 交付之后 pending 账本清空：这台 engine 的生命周期自此由 currentEngine 负责。
			pendingEngine = null;
			currentEngine = engine;
			const warning = warnings.length > 0 ? warnings.map(syncErrorMessage).join("\n") : undefined;
			return warning === undefined ? { ok: true, engine } : { ok: true, engine, warning };
		} catch (error) {
			// 失败时收摊 pending engine；manifest 缺失/不匹配留待下一次 prepare 重试。
			pendingEngine?.dispose();
			pendingEngine = null;
			return disposed ? failure(DISPOSED_REASON) : failure(error);
		}
	}

	/**
	 * prepare 的公开入口：single-flight。
	 *
	 * concurrent 模式下并发的 prepare 共用一个 flight 并返回同一 engine（两条启动路径不该各自 init
	 * 一次）；serial 模式的高层操作同样走这里，所以排到后面的调用也不会重复 init。
	 */
	function prepareInternal(timeoutMs: number): Promise<SyncPrepareResult> {
		if (disposed) return Promise.resolve(failure(DISPOSED_REASON));
		if (!positiveBudget(timeoutMs)) return Promise.resolve(failure(BUDGET_REASON));
		if (prepareInFlight !== null) return prepareInFlight;

		const flight = runPrepare(timeoutMs);
		const tracked = flight.finally(() => {
			if (prepareInFlight === tracked) prepareInFlight = null;
		});
		prepareInFlight = tracked;
		return tracked;
	}

	function prepare(timeoutMs: number): Promise<SyncPrepareResult> {
		if (disposed) return Promise.resolve(failure(DISPOSED_REASON));
		if (remoteChangeActive) return Promise.resolve(failure(BUSY_REASON));
		return prepareInternal(timeoutMs);
	}

	function remoteChangeFailure(
		remote: string,
		originChanged: boolean,
		stage: "prepare" | "operation",
		reason: string,
	): SyncRuntimeOutcome<null> {
		const cleanReason = syncErrorMessage(reason);
		if (messages.formatRemoteChangeFailure === undefined) return failure(cleanReason);
		try {
			return failure(messages.formatRemoteChangeFailure({ remote, originChanged, stage, reason: cleanReason }));
		} catch {
			// formatter 只是诊断包装；它自己失败时保留已脱敏原 reason，并明确补上 stage/origin 上下文，
			// 绝不能越过 replacement 恢复收尾，也不能吞掉“origin 是否已经切换”这个关键事实。
			return failure(`${cleanReason}\nremote change context: stage=${stage}, originChanged=${originChanged}`);
		}
	}

	/** 无论原结果成败都恢复写触发；恢复自己的错误追加在原诊断之后，而不是吞掉它。 */
	async function finishRemoteChange(result: SyncRuntimeOutcome<null>): Promise<SyncRuntimeOutcome<null>> {
		if (disposed) return disposedOutcome();
		try {
			const replacement = await ensureRuntimeEngine();
			if (disposed || replacement === null) return disposedOutcome();
			// 不猜 flush(null)：旧 dirty 与关闸期间的写入统一转成一次新 engine 触发。
			replacement.noteWrite();
		} catch (error) {
			const recovery = `failed to restore the sync write trigger: ${syncErrorMessage(error)}`;
			return result.ok ? failure(recovery) : failure(`${result.reason}\n${recovery}`);
		}
		return result;
	}

	/** 关闸后新活动进不来，因此这里只需等待调用时已经登记的旧活动、prepare 与 serial 前序 tail。 */
	async function drainRemoteChange(previousTail: Promise<unknown> | null): Promise<void> {
		const draining: Array<Promise<unknown>> = [...activities];
		if (prepareInFlight !== null) draining.push(prepareInFlight);
		if (previousTail !== null) draining.push(previousTail);
		await Promise.allSettled(draining);
		// serial 前序活动可能在快照之后才进入 prepare；tail 已等它完成，这里再复核一次账本。
		const preparing = prepareInFlight;
		if (preparing !== null && !draining.includes(preparing)) await Promise.allSettled([preparing]);
	}

	/** 两种调度模式共用同一份持久切换顺序；formatter 只包诊断，不参与任何持久决策。 */
	async function runRemoteChange(
		remote: string,
		timeoutMs: number,
		onWarning: ((warning: string) => void) | undefined,
		previousTail: Promise<unknown> | null,
	): Promise<SyncRuntimeOutcome<null>> {
		let originChanged = false;
		let result: SyncRuntimeOutcome<null>;
		try {
			await drainRemoteChange(previousTail);
			if (disposed) return disposedOutcome();
			const ready = await backend.ready();
			if (disposed) return disposedOutcome();
			if (!ready) {
				// 尚未开始的切换没有旧状态可恢复，也不能借收尾偷偷初始化 device。
				return failure(messages.uninitializedRemoteChange);
			}

			const previous = currentEngine;
			const previousRound = previous?.inFlight ?? null;
			currentEngine = null;
			previous?.dispose();
			// abort/dispose 不等于 settled：旧自动轮未结束前不能删除它还可能写回的旧基线。
			if (previousRound !== null) await Promise.allSettled([previousRound]);
			if (disposed) return disposedOutcome();

			try {
				await withFsRetry(() => unlink(projectManifest));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (disposed) return disposedOutcome();
			const controller = new AbortController();
			initController = controller;
			try {
				await backend.setRemote(remote, { timeoutMs, signal: controller.signal });
				originChanged = true;
			} finally {
				if (initController === controller) initController = null;
			}
			if (disposed) return disposedOutcome();

			const prepared = await prepareInternal(timeoutMs);
			if (disposed) return disposedOutcome();
			if (!prepared.ok) {
				result = remoteChangeFailure(remote, originChanged, "prepare", prepared.reason);
			} else {
				// 预告必须先于 replacement noteWrite；回调异常则属于 origin 已切换后的 operation 失败。
				if (prepared.warning !== undefined) onWarning?.(prepared.warning);
				if (disposed) return disposedOutcome();
				result = okOutcome(null, prepared.warning);
			}
		} catch (error) {
			pendingEngine?.dispose();
			pendingEngine = null;
			result = disposed
				? disposedOutcome()
				: remoteChangeFailure(remote, originChanged, "operation", syncErrorMessage(error));
		}
		return finishRemoteChange(result);
	}

	const runtime: SyncRuntime = {
		get engine(): SyncEngine | null {
			return currentEngine;
		},

		prepare,

		startup(onWarning?: (warning: string) => void): Promise<SyncRuntimeOutcome<SyncRoundResult | null>> {
			if (disposed) return Promise.resolve(disposedOutcome());
			if (remoteChangeActive) return Promise.resolve(busyOutcome());
			return coordinate(async () => {
				// 自动预算只算一次：prepare 与启动轮次共享同一份 deadline，谁也别各自重新满格。
				// 计时点是**出队之后**的这里，不是公开调用时：serial 排队等待不该消耗宿主的启动预算。
				const autoTimeoutMs = sync.autoTimeoutMs;
				const deadline = Date.now() + autoTimeoutMs;
				try {
					if (disposed) return disposedOutcome<SyncRoundResult | null>();
					const prepared = await prepareInternal(autoTimeoutMs);
					if (!prepared.ok) return prepared;
					if (disposed) return disposedOutcome<SyncRoundResult | null>();
					// 首次基线的冲突副本预告必须先于任何可能产生/发布副本的轮次。
					if (prepared.warning !== undefined) onWarning?.(prepared.warning);
					// 回调里同步 dispose 是合法时序：此后绝不可以在已收摊的引擎上开轮。
					if (disposed) return disposedOutcome<SyncRoundResult | null>();
					if (sync.pullOnStart !== true) return okOutcome<SyncRoundResult | null>(null, prepared.warning);
					const remaining = deadline - Date.now();
					if (remaining <= 0) {
						return okOutcome<SyncRoundResult | null>(
							null,
							joinWarning(
								prepared.warning,
								`the automatic startup budget of ${autoTimeoutMs}ms was exhausted during preparation; ` +
									"startup push was skipped and will run on the next round",
							),
						);
					}
					const round = await prepared.engine.push(remaining);
					return okOutcome<SyncRoundResult | null>(round, prepared.warning);
				} catch (error) {
					// 引擎/后端异常同样要过出口脱敏：裸 rejection 会把 URL 里的 token 直接送给宿主日志。
					return disposed ? disposedOutcome<SyncRoundResult | null>() : failure(error);
				}
			});
		},

		run(
			kind: "pull" | "push",
			timeoutMs: number,
			onWarning?: (warning: string) => void,
		): Promise<SyncRuntimeOutcome<SyncRoundResult>> {
			if (disposed) return Promise.resolve(disposedOutcome());
			if (remoteChangeActive) return Promise.resolve(busyOutcome());
			return coordinate(async () => {
				try {
					if (disposed) return disposedOutcome<SyncRoundResult>();
					const prepared = await prepareInternal(timeoutMs);
					if (!prepared.ok) return prepared;
					if (disposed) return disposedOutcome<SyncRoundResult>();
					// 手动恢复初始化时，预告同样要先于会产生/发布副本的那一轮。
					if (prepared.warning !== undefined) onWarning?.(prepared.warning);
					if (disposed) return disposedOutcome<SyncRoundResult>();
					// 手动轮次拿调用方给的完整预算：prepare 用掉的时长不从里面扣。
					const round = await prepared.engine[kind](timeoutMs);
					return okOutcome(round, prepared.warning);
				} catch (error) {
					// 同 startup：端口异常变成已脱敏的失败 outcome，不让调用方拿到裸 rejection。
					return disposed ? disposedOutcome<SyncRoundResult>() : failure(error);
				}
			});
		},

		status(timeoutMs: number): Promise<SyncRuntimeOutcome<SyncRuntimeStatus>> {
			if (disposed) return Promise.resolve(disposedOutcome());
			if (remoteChangeActive) return Promise.resolve(busyOutcome());
			return coordinate(async () => {
				if (disposed) return disposedOutcome<SyncRuntimeStatus>();
				try {
					const engine = currentEngine;
					if (engine !== null) {
						const report = await engine.status(timeoutMs);
						return disposed ? disposedOutcome<SyncRuntimeStatus>() : { ok: true, value: report };
					}
					// 严格 dry-run：只问本地那点状态，绝不 prepare/init、创建设备或写 manifest。
					const ready = await backend.ready();
					if (disposed) return disposedOutcome<SyncRuntimeStatus>();
					if (!ready) return { ok: true, value: { initialized: false, origin: null } };
					const origin = await backend.getRemote();
					// 关闸之后连一次只读 origin 都不该再发出去。
					if (disposed) return disposedOutcome<SyncRuntimeStatus>();
					return { ok: true, value: { initialized: true, origin } };
				} catch (error) {
					return failure(error);
				}
			});
		},

		changeRemote(
			remote: string,
			timeoutMs: number,
			onWarning?: (warning: string) => void,
		): Promise<SyncRuntimeOutcome<null>> {
			if (disposed) return Promise.resolve(disposedOutcome());
			if (remoteChangeActive) return Promise.resolve(busyOutcome());
			if (!positiveBudget(timeoutMs)) return Promise.resolve(failure(BUDGET_REASON));

			// 必须在公开调用时同步关闸：serial 中排在前面的活动允许完成，之后的活动立即 busy。
			remoteChangeActive = true;
			const previousTail = options.scheduling === "serial" ? tail : null;
			const flight =
				options.scheduling === "serial"
					? enqueue(() => runRemoteChange(remote, timeoutMs, onWarning, previousTail))
					: runRemoteChange(remote, timeoutMs, onWarning, null);
			const tracked = flight.finally(() => {
				if (remoteChangeInFlight === tracked) {
					remoteChangeInFlight = null;
					remoteChangeActive = false;
				}
			});
			remoteChangeInFlight = tracked;
			return tracked;
		},

		flush(timeoutMs: number): Promise<SyncRoundResult | null> {
			if (disposed) return Promise.resolve(null);
			if (remoteChangeActive) return Promise.reject(new Error(BUSY_REASON));
			return coordinate(async () => {
				if (disposed) return null;
				const engine = currentEngine;
				if (engine === null) return null;
				// `null` 不表示成功：成败仍由返回的 round 自己表达；rejection 形状保留，但文本必须脱敏。
				try {
					return await engine.flush(timeoutMs);
				} catch (error) {
					throw new Error(syncErrorMessage(error));
				}
			});
		},

		noteWrite(): void {
			// 收摊或换远端关闸期间不得触碰旧 engine；replacement trigger 会接住这段空档的写入。
			if (disposed || remoteChangeActive) return;
			currentEngine?.noteWrite();
		},

		dispose(): Promise<void> {
			if (disposeFlight !== null) return disposeFlight;
			// 同步部分立即生效：关入口、abort init、两本 engine 一起 dispose。
			disposed = true;
			initController?.abort();
			initController = null;
			const delivered = currentEngine;
			const pending = pendingEngine;
			currentEngine = null;
			pendingEngine = null;
			// abort/dispose 不等于 settled：在途的自动轮次仍要进 drain 账本（绝不 flush）。
			const automaticRound = delivered?.inFlight ?? null;
			// 端口契约说 dispose 绝不抛错；万一违约，也必须先收掉另一本账并建立 drain，
			// 不能让一次同步异常把整个收摊（以及宿主的退出/会话切换）拖停。
			try {
				delivered?.dispose();
			} catch {
				/* 没有第二个错误出口；保持 dispose() 总不抛、drain 永不 reject */
			}
			try {
				pending?.dispose();
			} catch {
				/* pending engine 违约时同样不得阻断 drain */
			}
			const draining: Array<Promise<unknown>> = [...activities];
			if (prepareInFlight !== null) draining.push(prepareInFlight);
			if (automaticRound !== null) draining.push(automaticRound);
			if (remoteChangeInFlight !== null) draining.push(remoteChangeInFlight);
			// serial 的 tail 覆盖调用时尚未出队的活动；concurrent 的换远端则由上面那本 flight 账覆盖。
			draining.push(tail);
			// drain 只等待已登记工作，不发起 flush 或新操作；已启动的 writer 可在等待期间完成。
			// promise 不 reject，宿主可以安全地 `void` 它。
			disposeFlight = Promise.allSettled(draining).then(() => undefined);
			return disposeFlight;
		},
	};

	return { runtime, errors, notices };
}
