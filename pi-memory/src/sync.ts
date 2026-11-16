import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createGitSyncBackend,
	createSyncEngine,
	DEFAULT_CONFIG,
	emptyManifest,
	loadOrCreateDevice,
	type MemoryStore,
	manifestMatchesTransport,
	manifestPath,
	type ProjectIdentity,
	readManifest,
	remoteProjectKey,
	sameSyncRemote,
	type SyncBackend,
	type SyncEngine,
	type SyncInitResult,
	type SyncRoundResult,
	type SyncStatusReport,
	syncConfigErrors,
	syncRootPath,
	syncTransport,
	writeManifest,
} from "@yandy0725/memory-core";
import type { MemoryConfig } from "./config";

export type PrepareResult = { ok: true; engine: SyncEngine; warning?: string } | { ok: false; reason: string };

export interface PiSyncRuntime {
	/** lazy：init 的共存检查通过之前，连 device.json 都不能创建，因此 engine 也必须后置。 */
	engine: SyncEngine | null;
	backend: SyncBackend;
	syncRoot: string;
	prepare(timeoutMs: number): Promise<PrepareResult>;
	/** 将启动/命令/退出轮次纳入换远端闸门；闸门关闭后拒绝新活动。 */
	runActivity<T>(activity: () => Promise<T>): Promise<T>;
	/** 已初始化后改 origin；先持久失效旧基线并排空旧轮次，再复核当前 origin。 */
	changeRemote(remote: string, timeoutMs: number): Promise<PrepareResult>;
	dispose(): void;
}

/** core 已脱敏；这里守住适配层自己的通知边界，不把将来新增错误里的口令带进 UI。 */
export function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\b((?:git\+)?https?:\/\/)([^/\s@]+)@/gi, (_whole, scheme: string, userinfo: string) => {
			const colon = userinfo.indexOf(":");
			return colon === -1 ? `${scheme}***@` : `${scheme}${userinfo.slice(0, colon)}:***@`;
		})
		.replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@");
}

function uniqueFiles(files: readonly string[]): string[] {
	return [...new Set(files)].sort();
}

function renderFiles(label: string, files: readonly string[]): string {
	const unique = uniqueFiles(files);
	return unique.length === 0 ? `${label}: none` : `${label} (${unique.length}): ${unique.join(", ")}`;
}

function renderRejected(rejected: ReadonlyArray<{ file: string; reason: string }>): string {
	const byFile = new Map<string, { file: string; reason: string }>();
	for (const item of rejected) if (!byFile.has(item.file)) byFile.set(item.file, item);
	const unique = [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
	if (unique.length === 0) return "Rejected: none";
	return `Rejected (${unique.length}):\n${unique.map((item) => `- ${item.file}: ${item.reason}`).join("\n")}`;
}

/** 纯渲染：失败轮同样展开所有部分结果；revision 只有 core 真正交出时才显示。 */
export function renderSyncRound(result: SyncRoundResult): string {
	const lines = [`Result: ${result.ok ? "ok" : "failed"}`];
	if (!result.ok) lines.push(`Reason: ${result.skipped?.reason ?? "unknown sync failure"}`);
	if (result.revision !== undefined) lines.push(`Revision: ${result.revision === "" ? "(empty)" : result.revision}`);
	lines.push(
		renderFiles("Pulled", result.pulled),
		renderFiles("Pushed", result.pushed),
		renderFiles("Deleted local", result.deletedLocal),
		renderFiles("Deleted remote", result.deletedRemote),
	);
	const conflicts = new Map<string, string>();
	for (const conflict of result.conflicts)
		if (!conflicts.has(conflict.file)) conflicts.set(conflict.file, conflict.keptAsNew);
	const conflictFiles = [...conflicts.keys()].sort();
	lines.push(
		conflictFiles.length === 0
			? "Conflicts: none"
			: `Conflicts (${conflictFiles.length}):\n${conflictFiles.map((file) => `- ${file} -> ${conflicts.get(file)}`).join("\n")}`,
		renderRejected(result.rejected),
		renderFiles("Unparsable local", result.unparsableLocal),
		renderFiles("Out of scope remote", result.outOfScopeRemote),
	);
	return errorMessage(lines.join("\n"));
}

/** 纯渲染：origin 是真相来源，配置漂移只追加非致命提醒；所有出口统一脱敏。 */
export function renderSyncStatus(report: SyncStatusReport, configuredRemote: string): string {
	const lines = [
		`Configured: ${report.configured ? "yes" : "no"}`,
		`Initialized: ${report.initialized ? "yes" : "no"}`,
		`Origin: ${report.remote === "" ? "(not set)" : report.remote}`,
		`Configured remote: ${configuredRemote.trim() === "" ? "(not set)" : configuredRemote}`,
		`Branch: ${report.branch}`,
		`Device: ${report.device.hostname} (${report.device.id})`,
		`Project: ${report.projectDir} -> ${report.projectKey}`,
		`Base: ${report.base === null ? "none" : `${report.base.revision === "" ? "(empty)" : report.base.revision} at ${report.base.syncedAt}`}`,
		renderFiles("Ahead", report.ahead),
		renderFiles("Behind", report.behind),
		renderFiles("Conflicts", report.conflicts),
		renderRejected(report.rejected),
		renderFiles("Unparsable local", report.unparsableLocal),
		renderFiles("Out of scope remote", report.outOfScopeRemote),
	];
	const errors = uniqueFiles(report.errors);
	lines.push(
		errors.length === 0
			? "Errors: none"
			: `Errors (${errors.length}):\n${errors.map((error) => `- ${error}`).join("\n")}`,
	);
	if (
		configuredRemote.trim() !== "" &&
		report.remote.trim() !== "" &&
		!sameSyncRemote(configuredRemote, report.remote)
	) {
		lines.push(
			'sync.remote differs from the initialized origin; continuing to use origin (use "/memory sync remote <url>" to change it)',
		);
	}
	lines.push("Prompt index: frozen for this session; manual sync updates disk only.");
	return errorMessage(lines.join("\n"));
}

/**
 * 装配同步，但不做任何初始化写入。`ready()` / `getRemote()` 只读本地状态，用来允许
 * 「已有 origin + 配置 remote 留空」并检测配置漂移。返回的 runtime 即使 prepare 失败也保留，
 * 显式 pull/push 可以在修复远端后走同一个恢复入口。
 */
export async function createPiSyncRuntime(options: {
	config: MemoryConfig;
	store: MemoryStore;
	projectDir: string;
	identity: ProjectIdentity;
	now?: () => Date;
}): Promise<{ runtime: PiSyncRuntime | null; errors: string[]; notices: string[] }> {
	const { config, store, projectDir, identity } = options;
	const now = options.now ?? (() => new Date());
	const sync = config.sync;
	const enabled = sync?.enabled === true;
	const notices: string[] = [];

	if (identity.kind !== "git") {
		const errors = syncConfigErrors(config);
		// 环境不支持（非 git 项目）是**降级**，不是故障：走预告通道，别让宿主把它渲染成红色 Error。
		if (enabled) notices.push("Memory sync v1 only supports git projects; sync is disabled for this session.");
		return { runtime: null, errors, notices };
	}
	if (!enabled) return { runtime: null, errors: syncConfigErrors(config), notices };

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
		errors.push(`Failed to inspect memory sync state: ${errorMessage(error)}`);
	}

	const configErrors = syncConfigErrors(config, { initialized });
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
			errors.push(`Failed to read the initialized sync origin: ${errorMessage(error)}`);
		}
	}

	const projectKey = remoteProjectKey(identity.key);
	const projectManifest = manifestPath(syncRoot, projectKey);
	let disposed = false;
	let initController: AbortController | null = null;
	let pendingEngine: SyncEngine | null = null;
	let prepareInFlight: Promise<PrepareResult> | null = null;
	let remoteChangeInFlight: Promise<PrepareResult> | null = null;
	let remoteChangeActive = false;
	const activities = new Set<Promise<unknown>>();
	const disposedResult = (): PrepareResult => ({ ok: false, reason: "sync runtime is disposed" });
	const busyResult = (): Extract<PrepareResult, { ok: false }> => ({
		ok: false,
		reason: "sync remote change is already in progress; retry the operation afterwards",
	});

	async function buildEngine(): Promise<SyncEngine> {
		const device = await loadOrCreateDevice(syncRoot, now);
		return createSyncEngine({
			syncRoot,
			projectDir,
			projectKey,
			store,
			backend,
			device,
			config: sync,
			now,
		});
	}

	/** 失败恢复也必须有新 engine 接住旧 dirty 与空档期写入；manifest 缺失本身仍是安全基线。 */
	async function ensureRuntimeEngine(): Promise<SyncEngine | null> {
		if (runtime.engine) return runtime.engine;
		const engine = await buildEngine();
		if (disposed) {
			engine.dispose();
			return null;
		}
		runtime.engine = engine;
		return engine;
	}

	async function runPrepare(timeoutMs: number): Promise<PrepareResult> {
		try {
			// 有完整 manifest 的 ready 快路径绝不联网；缺失 manifest 则是跨进程持久 pending。
			const ready = await backend.ready();
			if (disposed) return disposedResult();
			const manifest = await readManifest(projectManifest);
			if (disposed) return disposedResult();
			let transport: ReturnType<typeof syncTransport> | null = null;
			if (ready && manifest !== null) {
				const origin = await backend.getRemote();
				if (origin === null) throw new Error("the initialized sync origin is unavailable; no baseline was trusted");
				transport = syncTransport(origin, branch);
			}
			const transportMatches = manifest !== null && transport !== null && manifestMatchesTransport(manifest, transport);
			if (ready && transportMatches && runtime.engine !== null) {
				return { ok: true, engine: runtime.engine };
			}

			let initializedResult: SyncInitResult | null = null;
			if (!ready || !transportMatches) {
				// 首次 init 做共存检查；缺失基线时复核当前 origin，绝不沿用旧 base。
				const controller = new AbortController();
				initController = controller;
				try {
					initializedResult = await backend.init({ timeoutMs, signal: controller.signal });
				} finally {
					if (initController === controller) initController = null;
				}
				if (disposed) return disposedResult();
			}

			let engine = runtime.engine;
			if (engine === null) {
				if (disposed) return disposedResult();
				engine = await buildEngine();
				if (disposed) {
					engine.dispose();
					return disposedResult();
				}
				pendingEngine = engine;
			}

			if (initializedResult !== null) {
				// init 之后的真实 origin 才是基线身份；配置漂移或跨进程旧写入都不能换掉它。
				const origin = await backend.getRemote();
				if (origin === null) throw new Error("the initialized sync origin is unavailable; no baseline was written");
				const baseline = emptyManifest(syncTransport(origin, branch));
				baseline.base = { revision: initializedResult.revision, syncedAt: now().toISOString() };
				await writeManifest(projectManifest, baseline);
				if (disposed) return disposedResult();
			}

			if (disposed) return disposedResult();
			const warnings = [...(initializedResult?.warnings ?? [])];
			if (initializedResult !== null) {
				const localEntries = await store.listEntries();
				if (disposed) return disposedResult();
				if (localEntries.length > 0) {
					warnings.push(
						`Memory sync initialized with ${localEntries.length} local ${
							localEntries.length === 1 ? "entry" : "entries"
						}; same-named entries with different content may be kept as deterministic conflict copies.`,
					);
				}
			}
			// 预告读取也可能失败：在它成功之前 engine 一直留在 pending 账本里，catch 才能负责收摊。
			if (disposed) return disposedResult();
			pendingEngine = null;
			runtime.engine = engine;
			const warning = warnings.length > 0 ? warnings.map(errorMessage).join("\n") : undefined;
			return warning === undefined ? { ok: true, engine } : { ok: true, engine, warning };
		} catch (error) {
			pendingEngine?.dispose();
			pendingEngine = null;
			return disposed ? disposedResult() : { ok: false, reason: errorMessage(error) };
		}
	}

	async function finishRemoteChange(result: PrepareResult): Promise<PrepareResult> {
		if (disposed) return disposedResult();
		try {
			const replacement = await ensureRuntimeEngine();
			if (disposed || replacement === null) return disposedResult();
			// 不猜 flush(null) 的含义：旧 dirty/unpublished 与换远端期间的写入统一转成一次触发。
			replacement.noteWrite();
		} catch (error) {
			const recovery = `failed to restore the sync write trigger: ${errorMessage(error)}`;
			return { ok: false, reason: result.ok ? recovery : `${result.reason}\n${recovery}` };
		}
		return result;
	}

	const runtime: PiSyncRuntime = {
		engine: null,
		backend,
		syncRoot,
		runActivity<T>(activity: () => Promise<T>): Promise<T> {
			if (disposed) return Promise.reject(new Error("sync runtime is disposed"));
			if (remoteChangeActive) return Promise.reject(new Error(busyResult().reason));
			let flight: Promise<T>;
			try {
				// flush/status 的既有入口在调用返回前就开始；登记不能额外引入一个微任务延迟。
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
		},
		prepare(timeoutMs: number): Promise<PrepareResult> {
			if (disposed) return Promise.resolve(disposedResult());
			if (remoteChangeActive) return Promise.resolve(busyResult());
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				return Promise.resolve({ ok: false, reason: "sync initialization requires a finite positive timeout budget" });
			}
			if (prepareInFlight !== null) return prepareInFlight;

			const flight = runPrepare(timeoutMs);
			const tracked = flight.finally(() => {
				if (prepareInFlight === tracked) prepareInFlight = null;
			});
			prepareInFlight = tracked;
			return tracked;
		},
		changeRemote(remote: string, timeoutMs: number): Promise<PrepareResult> {
			if (disposed) return Promise.resolve(disposedResult());
			if (remoteChangeInFlight !== null) return Promise.resolve(busyResult());
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				return Promise.resolve({ ok: false, reason: "sync initialization requires a finite positive timeout budget" });
			}

			remoteChangeActive = true;
			const runChange = async (): Promise<PrepareResult> => {
				let result: PrepareResult;
				try {
					// 关闸后拒绝新活动，再排空已登记的 status/pull/push/flush 与直接 prepare。
					await Promise.allSettled([...activities]);
					const preparing = prepareInFlight;
					if (preparing !== null) await preparing;
					if (disposed) return disposedResult();
					if (!(await backend.ready())) {
						return { ok: false, reason: 'sync is not initialized: set "sync.remote" in memory.json instead' };
					}
					if (disposed) return disposedResult();

					const previous = runtime.engine;
					runtime.engine = null;
					previous?.dispose();
					// abort/dispose 不是 settled：旧调度轮未结束前绝不能失效 manifest 或改 origin。
					const previousRound = previous?.inFlight;
					if (previousRound) await previousRound;
					if (disposed) return disposedResult();

					// 删除是换 origin 的持久前置条件；失败时保持 origin 不动。
					try {
						await unlink(projectManifest);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					if (disposed) return disposedResult();
					const controller = new AbortController();
					initController = controller;
					try {
						await backend.setRemote(remote, { timeoutMs, signal: controller.signal });
					} finally {
						if (initController === controller) initController = null;
					}
					if (disposed) return disposedResult();
					result = await runPrepare(timeoutMs);
				} catch (error) {
					pendingEngine?.dispose();
					pendingEngine = null;
					if (disposed) return disposedResult();
					result = { ok: false, reason: errorMessage(error) };
				}
				return finishRemoteChange(result);
			};
			const flight = runChange();
			const tracked = flight.finally(() => {
				remoteChangeActive = false;
				if (remoteChangeInFlight === tracked) remoteChangeInFlight = null;
			});
			remoteChangeInFlight = tracked;
			return tracked;
		},
		dispose(): void {
			disposed = true;
			initController?.abort();
			initController = null;
			const engine = runtime.engine;
			const pending = pendingEngine;
			runtime.engine = null;
			pendingEngine = null;
			try {
				engine?.dispose();
			} finally {
				pending?.dispose();
			}
		},
	};

	return { runtime, errors, notices };
}
