import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createGitSyncBackend,
	createSyncEngine,
	DEFAULT_CONFIG,
	emptyManifest,
	loadOrCreateDevice,
	type MemoryStore,
	manifestPath,
	normalizeRemoteUrl,
	type ProjectIdentity,
	remoteProjectKey,
	type SyncBackend,
	type SyncEngine,
	type SyncInitResult,
	type SyncRoundResult,
	type SyncStatusReport,
	syncConfigErrors,
	syncRootPath,
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
	/** 已初始化后改 origin；旧基线在新 origin 上没有意义，必须复核 revision 并重建空 files 基线。 */
	changeRemote(remote: string, timeoutMs: number): Promise<PrepareResult>;
	dispose(): void;
}

/** 与 git backend 相同的本地/URL 比较口径；适配层只用它判断要不要提醒配置漂移。 */
function sameRemote(left: string, right: string): boolean {
	const key = (value: string): string => {
		const normalized = normalizeRemoteUrl(value);
		if (normalized !== null) return `url:${normalized}`;
		const raw = value.trim();
		if (/^file:\/\//i.test(raw)) {
			try {
				return `path:${resolve(fileURLToPath(raw))}`;
			} catch {
				return `path:${resolve(raw.replace(/^file:\/\//i, ""))}`;
			}
		}
		return `path:${resolve(raw)}`;
	};
	return key(left) === key(right);
}

/** core 已脱敏；这里守住适配层自己的通知边界，不把将来新增错误里的口令带进 UI。 */
export function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@");
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
	if (configuredRemote.trim() !== "" && report.remote.trim() !== "" && !sameRemote(configuredRemote, report.remote)) {
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
}): Promise<{ runtime: PiSyncRuntime | null; errors: string[] }> {
	const { config, store, projectDir, identity } = options;
	const now = options.now ?? (() => new Date());
	const sync = config.sync;
	const enabled = sync?.enabled === true;

	if (identity.kind !== "git") {
		const errors = syncConfigErrors(config);
		if (enabled) errors.push("Memory sync v1 only supports git projects; sync is disabled for this session.");
		return { runtime: null, errors };
	}
	if (!enabled) return { runtime: null, errors: syncConfigErrors(config) };

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
	if (configErrors.length > 0) return { runtime: null, errors: [...errors, ...configErrors] };

	if (initialized && remote.trim() !== "") {
		try {
			const origin = await backend.getRemote();
			if (origin !== null && !sameRemote(origin, remote)) {
				errors.push(
					'sync.remote differs from the initialized origin; continuing to use origin (use "/memory sync remote <url>" to change it)',
				);
			}
		} catch (error) {
			errors.push(`Failed to read the initialized sync origin: ${errorMessage(error)}`);
		}
	}

	const projectKey = remoteProjectKey(identity.key);
	/** init 已成功、后续写 device/manifest 失败时，同一 runtime 重试仍使用那次真实 revision。 */
	let initialRevision: string | null = null;
	let initialWarnings: string[] = [];
	let disposed = false;
	let initController: AbortController | null = null;
	let pendingEngine: SyncEngine | null = null;
	let prepareInFlight: Promise<PrepareResult> | null = null;
	/** setRemote 成功后、当前 origin 复核与空 files 基线落盘前，任何 pull/push 都不得沿用旧 base。 */
	let baselineResetRequired = false;
	const disposedResult = (): PrepareResult => ({ ok: false, reason: "sync runtime is disposed" });

	async function runPrepare(timeoutMs: number): Promise<PrepareResult> {
		try {
			// ready 快路径绝不 init：Task 2 的幂等 init 会联网复核 origin，离线启动不该因此失败。
			const ready = await backend.ready();
			if (disposed) return disposedResult();
			if (baselineResetRequired && !ready) {
				throw new Error("the initialized sync backend disappeared while resetting its baseline; inspect .sync/repo");
			}
			if (baselineResetRequired || !ready) {
				// 首次 init 内部先做 same-remote 共存拒绝；换远端后的幂等 init 则重新 fetch 当前 origin。
				const controller = new AbortController();
				initController = controller;
				let initializedResult: SyncInitResult;
				try {
					initializedResult = await backend.init({ timeoutMs, signal: controller.signal });
				} finally {
					if (initController === controller) initController = null;
				}
				if (disposed) return disposedResult();
				initialRevision = initializedResult.revision;
				initialWarnings = initializedResult.warnings;
			}

			if (disposed) return disposedResult();
			const device = await loadOrCreateDevice(syncRoot, now);
			if (disposed) return disposedResult();
			const engine = createSyncEngine({
				syncRoot,
				projectDir,
				projectKey,
				store,
				backend,
				device,
				config: sync,
				now,
			});
			pendingEngine = engine;

			if (initialRevision !== null) {
				if (disposed) return disposedResult();
				const baseline = emptyManifest();
				baseline.base = { revision: initialRevision, syncedAt: now().toISOString() };
				await writeManifest(manifestPath(syncRoot, projectKey), baseline);
				if (disposed) return disposedResult();
				initialRevision = null;
				baselineResetRequired = false;
			}

			if (disposed) return disposedResult();
			pendingEngine = null;
			runtime.engine = engine;
			const warning = initialWarnings.length > 0 ? initialWarnings.map(errorMessage).join("\n") : undefined;
			initialWarnings = [];
			return warning === undefined ? { ok: true, engine } : { ok: true, engine, warning };
		} catch (error) {
			pendingEngine?.dispose();
			pendingEngine = null;
			return disposed ? disposedResult() : { ok: false, reason: errorMessage(error) };
		}
	}

	const runtime: PiSyncRuntime = {
		engine: null,
		backend,
		syncRoot,
		prepare(timeoutMs: number): Promise<PrepareResult> {
			if (disposed) return Promise.resolve(disposedResult());
			if (runtime.engine !== null && !baselineResetRequired) return Promise.resolve({ ok: true, engine: runtime.engine });
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
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				return Promise.resolve({ ok: false, reason: "sync initialization requires a finite positive timeout budget" });
			}
			if (prepareInFlight !== null) {
				return Promise.resolve({
					ok: false,
					reason: "sync preparation is already in progress; retry the remote change afterwards",
				});
			}

			const runChange = async (): Promise<PrepareResult> => {
				try {
					if (!(await backend.ready())) {
						return { ok: false, reason: 'sync is not initialized: set "sync.remote" in memory.json instead' };
					}
					if (disposed) return disposedResult();

					// 先封住旧 engine 的写触发与在途 I/O，再改 origin；失败后的 prepare 也只能走恢复路径。
					const previous = runtime.engine;
					runtime.engine = null;
					previous?.dispose();
					const controller = new AbortController();
					initController = controller;
					try {
						await backend.setRemote(remote, { timeoutMs, signal: controller.signal });
					} finally {
						if (initController === controller) initController = null;
					}
					if (disposed) return disposedResult();
					baselineResetRequired = true;
					initialRevision = null;
					initialWarnings = [];
					return await runPrepare(timeoutMs);
				} catch (error) {
					pendingEngine?.dispose();
					pendingEngine = null;
					return disposed ? disposedResult() : { ok: false, reason: errorMessage(error) };
				}
			};
			const flight = runChange();
			const tracked = flight.finally(() => {
				if (prepareInFlight === tracked) prepareInFlight = null;
			});
			prepareInFlight = tracked;
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

	return { runtime, errors };
}
