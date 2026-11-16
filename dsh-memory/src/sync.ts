import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	MemoryConfig,
	MemoryStore,
	ProjectIdentity,
	SyncBackend,
	SyncEngine,
	SyncInitResult,
	SyncRoundResult,
	SyncStatusReport,
} from "@yandy0725/memory-core";
import {
	createGitSyncBackend,
	createSyncEngine,
	DEFAULT_CONFIG,
	emptyManifest,
	loadOrCreateDevice,
	manifestMatchesTransport,
	manifestPath,
	readManifest,
	remoteProjectKey,
	sameSyncRemote,
	syncConfigErrors,
	syncRootPath,
	syncTransport,
	writeManifest,
} from "@yandy0725/memory-core";

export type DshSyncOutcome<T> = { ok: true; value: T; warning?: string } | { ok: false; reason: string };
export type DshSyncStatus = SyncStatusReport | { initialized: boolean; origin: string | null };

type PrepareResult = { ok: true; engine: SyncEngine; warning?: string } | { ok: false; reason: string };

/**
 * dsh 的同步协调器。core 拥有差集、锁、manifest 与自动 scheduler；这里只负责把一次会话的
 * 配置、目录与宿主生命周期接到这些公开端口上。
 */
export interface DshSyncRuntime {
	readonly engine: SyncEngine | null;
	readonly backend: SyncBackend;
	readonly syncRoot: string;
	/** 自动初始化；pullOnStart 开启时再共用同一份预算执行一轮启动 push。 */
	startup(): Promise<DshSyncOutcome<SyncRoundResult | null>>;
	run(kind: "pull" | "push", timeoutMs: number): Promise<DshSyncOutcome<SyncRoundResult>>;
	/** 严格 dry-run：engine 尚未准备时只读 ready/origin，绝不 prepare。 */
	status(timeoutMs: number): Promise<DshSyncOutcome<DshSyncStatus>>;
	changeRemote(remote: string, timeoutMs: number): Promise<DshSyncOutcome<null>>;
	noteWrite(): void;
	/** abort + drain，不执行 flush；dsh 没有可靠的退出兜底事件。 */
	dispose(): Promise<void>;
}

export interface DshSyncSession {
	runtime: DshSyncRuntime | null;
	/** 当前要展示的错误/预告；启动与手动操作会更新它们。 */
	errors: string[];
	notices: string[];
	/** 工厂阶段仍成立的错误（例如 origin 漂移）；手动成功只清瞬时错误。 */
	persistentErrors?: string[];
}

/** 同步提示在 dsh 的唯一配置层是行 config；同时守住 URL userinfo 的日志/命令边界。 */
export function syncErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\b((?:git\+)?https?:\/\/)([^/\s@]+)@/gi, (_whole, scheme: string, userinfo: string) => {
			const colon = userinfo.indexOf(":");
			return colon === -1 ? `${scheme}***@` : `${scheme}${userinfo.slice(0, colon)}:***@`;
		})
		.replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@")
		.replaceAll("memory.json", "plugin row config");
}

function positiveBudget(timeoutMs: number): boolean {
	return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

function withWarning(warning: string | undefined, extra: string | undefined): string | undefined {
	if (warning === undefined) return extra;
	if (extra === undefined) return warning;
	return `${warning}\n${extra}`;
}

/**
 * 只装配，不做初始化写入。与 pi 的通知/UI 生命周期无关：dsh 的手动操作走一条队列，
 * 自动在途轮次仍由 core engine 自己登记与串行化。
 */
export async function createDshSyncRuntime(options: {
	config: MemoryConfig;
	store: MemoryStore;
	projectDir: string;
	identity: ProjectIdentity;
	now?: () => Date;
}): Promise<{ runtime: DshSyncRuntime | null; errors: string[]; notices: string[] }> {
	const { config, store, projectDir, identity } = options;
	const now = options.now ?? (() => new Date());
	const sync = config.sync;
	const enabled = sync?.enabled === true;
	const notices: string[] = [];

	if (identity.kind !== "git") {
		const errors = syncConfigErrors(config).map(syncErrorMessage);
		if (enabled) notices.push("Memory sync v1 only supports git projects; sync is disabled for this session.");
		return { runtime: null, errors, notices };
	}
	if (!enabled) return { runtime: null, errors: syncConfigErrors(config).map(syncErrorMessage), notices };

	const memoryRoot = resolve(config.memoryDir);
	const syncRoot = syncRootPath(memoryRoot);
	const remote = typeof sync.remote === "string" ? sync.remote : "";
	const branch = typeof sync.branch === "string" && sync.branch.trim() !== "" ? sync.branch : DEFAULT_CONFIG.sync.branch;
	const backend = createGitSyncBackend({ syncRoot, memoryRoot, remote, branch });
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
			if (origin !== null && !sameSyncRemote(origin, remote)) {
				errors.push(
					'sync.remote differs from the initialized origin; continuing to use origin (use "/memory sync remote <url>" to change it)',
				);
			}
		} catch (error) {
			errors.push(`Failed to read the initialized sync origin: ${syncErrorMessage(error)}`);
		}
	}

	const projectKey = remoteProjectKey(identity.key);
	const projectManifest = manifestPath(syncRoot, projectKey);
	let currentEngine: SyncEngine | null = null;
	let pendingEngine: SyncEngine | null = null;
	let initController: AbortController | null = null;
	let disposed = false;
	let remoteChangeActive = false;
	let tail: Promise<unknown> = Promise.resolve();
	let disposeInFlight: Promise<void> | null = null;

	const disposedResult = <T>(): DshSyncOutcome<T> => ({ ok: false, reason: "sync runtime is disposed" });
	const busyResult = <T>(): DshSyncOutcome<T> => ({
		ok: false,
		reason: "sync remote change is already in progress; retry the operation afterwards",
	});

	/** 手动命令与换远端串行；core scheduler 的自动轮次仍由 engine.inFlight 单独登记。 */
	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const flight = tail.then(operation, operation);
		tail = flight.then(
			() => undefined,
			() => undefined,
		);
		return flight;
	}

	async function buildEngine(): Promise<SyncEngine> {
		const device = await loadOrCreateDevice(syncRoot, now);
		return createSyncEngine({ syncRoot, projectDir, projectKey, store, backend, device, config: sync, now });
	}

	/** 失败恢复也要留一个 engine 接住旧 dirty 与换远端空档写入；缺失 manifest 仍是安全空 base。 */
	async function ensureRuntimeEngine(): Promise<SyncEngine | null> {
		if (currentEngine) return currentEngine;
		const engine = await buildEngine();
		if (disposed) {
			engine.dispose();
			return null;
		}
		currentEngine = engine;
		return engine;
	}

	async function prepare(timeoutMs: number): Promise<PrepareResult> {
		if (disposed) return { ok: false, reason: "sync runtime is disposed" };
		if (!positiveBudget(timeoutMs)) {
			return { ok: false, reason: "sync initialization requires a finite positive timeout budget" };
		}
		try {
			const ready = await backend.ready();
			if (disposed) return { ok: false, reason: "sync runtime is disposed" };
			const manifest = await readManifest(projectManifest);
			let transport: ReturnType<typeof syncTransport> | null = null;
			if (ready && manifest !== null) {
				const origin = await backend.getRemote();
				if (origin === null) throw new Error("the initialized sync origin is unavailable; no baseline was trusted");
				transport = syncTransport(origin, branch);
			}
			const transportMatches = manifest !== null && transport !== null && manifestMatchesTransport(manifest, transport);
			if (ready && transportMatches && currentEngine !== null) return { ok: true, engine: currentEngine };

			let initializedResult: SyncInitResult | null = null;
			if (!ready || !transportMatches) {
				const controller = new AbortController();
				initController = controller;
				try {
					initializedResult = await backend.init({ timeoutMs, signal: controller.signal });
				} finally {
					if (initController === controller) initController = null;
				}
				if (disposed) return { ok: false, reason: "sync runtime is disposed" };
			}

			let engine = currentEngine;
			if (engine === null) {
				engine = await buildEngine();
				if (disposed) {
					engine.dispose();
					return { ok: false, reason: "sync runtime is disposed" };
				}
				pendingEngine = engine;
			}

			if (initializedResult !== null) {
				const origin = await backend.getRemote();
				if (origin === null) throw new Error("the initialized sync origin is unavailable; no baseline was written");
				const baseline = emptyManifest(syncTransport(origin, branch));
				baseline.base = { revision: initializedResult.revision, syncedAt: now().toISOString() };
				await writeManifest(projectManifest, baseline);
				if (disposed) return { ok: false, reason: "sync runtime is disposed" };
			}

			const warnings = [...(initializedResult?.warnings ?? [])];
			if (initializedResult !== null) {
				const localEntries = await store.listEntries();
				if (localEntries.length > 0) {
					warnings.push(
						`Memory sync initialized with ${localEntries.length} local ${
							localEntries.length === 1 ? "entry" : "entries"
						}; same-named entries with different content may be kept as deterministic conflict copies.`,
					);
				}
			}
			if (disposed) return { ok: false, reason: "sync runtime is disposed" };
			pendingEngine = null;
			currentEngine = engine;
			const warning = warnings.length > 0 ? warnings.map(syncErrorMessage).join("\n") : undefined;
			return warning === undefined ? { ok: true, engine } : { ok: true, engine, warning };
		} catch (error) {
			pendingEngine?.dispose();
			pendingEngine = null;
			return disposed ? { ok: false, reason: "sync runtime is disposed" } : { ok: false, reason: syncErrorMessage(error) };
		}
	}

	function startup(): Promise<DshSyncOutcome<SyncRoundResult | null>> {
		if (disposed) return Promise.resolve(disposedResult());
		if (remoteChangeActive) return Promise.resolve(busyResult());
		return enqueue(async () => {
			if (disposed) return disposedResult();
			const deadline = Date.now() + sync.autoTimeoutMs;
			const prepared = await prepare(sync.autoTimeoutMs);
			if (!prepared.ok) return prepared;
			if (sync.pullOnStart !== true) {
				return prepared.warning === undefined
					? { ok: true as const, value: null }
					: { ok: true as const, value: null, warning: prepared.warning };
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return {
					ok: true as const,
					value: null,
					warning: withWarning(
						prepared.warning,
						`the automatic startup budget of ${sync.autoTimeoutMs}ms was exhausted during preparation; ` +
							"startup push was skipped and will run on the next round",
					),
				};
			}
			const round = await prepared.engine.push(remaining);
			return prepared.warning === undefined
				? { ok: true as const, value: round }
				: { ok: true as const, value: round, warning: prepared.warning };
		});
	}

	function run(kind: "pull" | "push", timeoutMs: number): Promise<DshSyncOutcome<SyncRoundResult>> {
		if (disposed) return Promise.resolve(disposedResult());
		if (remoteChangeActive) return Promise.resolve(busyResult());
		return enqueue(async () => {
			if (disposed) return disposedResult();
			const prepared = await prepare(timeoutMs);
			if (!prepared.ok) return prepared;
			const round = await prepared.engine[kind](timeoutMs);
			return prepared.warning === undefined
				? { ok: true as const, value: round }
				: { ok: true as const, value: round, warning: prepared.warning };
		});
	}

	function status(timeoutMs: number): Promise<DshSyncOutcome<DshSyncStatus>> {
		if (disposed) return Promise.resolve(disposedResult());
		if (remoteChangeActive) return Promise.resolve(busyResult());
		return enqueue(async () => {
			if (disposed) return disposedResult();
			try {
				const engine = currentEngine;
				if (engine) return { ok: true as const, value: await engine.status(timeoutMs) };
				const ready = await backend.ready();
				if (!ready) return { ok: true as const, value: { initialized: false, origin: null } };
				return { ok: true as const, value: { initialized: true, origin: await backend.getRemote() } };
			} catch (error) {
				return { ok: false as const, reason: syncErrorMessage(error) };
			}
		});
	}

	function changeRemote(newRemote: string, timeoutMs: number): Promise<DshSyncOutcome<null>> {
		if (disposed) return Promise.resolve(disposedResult());
		if (remoteChangeActive) return Promise.resolve(busyResult());
		if (!positiveBudget(timeoutMs)) {
			return Promise.resolve({ ok: false, reason: "sync initialization requires a finite positive timeout budget" });
		}
		remoteChangeActive = true;
		const flight = enqueue(async (): Promise<DshSyncOutcome<null>> => {
			let result: DshSyncOutcome<null>;
			try {
				if (disposed) return disposedResult();
				if (!(await backend.ready())) {
					return { ok: false, reason: 'sync is not initialized: set "sync.remote" in the plugin row config instead' };
				}

				const previous = currentEngine;
				currentEngine = null;
				previous?.dispose();
				const previousRound = previous?.inFlight;
				if (previousRound) await previousRound;
				if (disposed) return disposedResult();

				try {
					await unlink(projectManifest);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (disposed) return disposedResult();
				const controller = new AbortController();
				initController = controller;
				try {
					await backend.setRemote(newRemote, { timeoutMs, signal: controller.signal });
				} finally {
					if (initController === controller) initController = null;
				}
				if (disposed) return disposedResult();
				const prepared = await prepare(timeoutMs);
				result = prepared.ok
					? { ok: true, value: null, ...(prepared.warning === undefined ? {} : { warning: prepared.warning }) }
					: { ok: false, reason: prepared.reason };
			} catch (error) {
				pendingEngine?.dispose();
				pendingEngine = null;
				result = disposed ? disposedResult() : { ok: false, reason: syncErrorMessage(error) };
			}

			if (!disposed) {
				try {
					const replacement = await ensureRuntimeEngine();
					// 不猜 flush(null)：旧 dirty 与关闸期间的写入统一转成一次新 engine 触发。
					replacement?.noteWrite();
				} catch (error) {
					const recovery = `failed to restore the sync write trigger: ${syncErrorMessage(error)}`;
					result = result.ok ? { ok: false, reason: recovery } : { ok: false, reason: `${result.reason}\n${recovery}` };
				}
			}
			return result;
		});
		return flight.finally(() => {
			remoteChangeActive = false;
		});
	}

	const runtime: DshSyncRuntime = {
		get engine() {
			return currentEngine;
		},
		backend,
		syncRoot,
		startup,
		run,
		status,
		changeRemote,
		noteWrite(): void {
			if (disposed || remoteChangeActive) return;
			currentEngine?.noteWrite();
		},
		dispose(): Promise<void> {
			if (disposeInFlight) return disposeInFlight;
			disposed = true;
			initController?.abort();
			initController = null;
			const engine = currentEngine;
			const pending = pendingEngine;
			currentEngine = null;
			pendingEngine = null;
			engine?.dispose();
			pending?.dispose();
			const automaticRound = engine?.inFlight;
			disposeInFlight = Promise.allSettled([tail, automaticRound]).then(() => undefined);
			return disposeInFlight;
		},
	};

	return { runtime, errors, notices };
}
