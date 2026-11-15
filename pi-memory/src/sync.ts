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
function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@");
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

	const runtime: PiSyncRuntime = {
		engine: null,
		backend,
		syncRoot,
		async prepare(timeoutMs: number): Promise<PrepareResult> {
			if (runtime.engine !== null) return { ok: true, engine: runtime.engine };
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				return { ok: false, reason: "sync initialization requires a finite positive timeout budget" };
			}

			let nextEngine: SyncEngine | null = null;
			try {
				// ready 快路径绝不 init：Task 2 的幂等 init 会联网复核 origin，离线启动不该因此失败。
				if (!(await backend.ready())) {
					// init 内部先做 same-remote 共存拒绝，任何 clone/device 写入都排在它之后。
					const initializedResult = await backend.init({ timeoutMs });
					initialRevision = initializedResult.revision;
					initialWarnings = initializedResult.warnings;
				}

				const device = await loadOrCreateDevice(syncRoot, now);
				nextEngine = createSyncEngine({
					syncRoot,
					projectDir,
					projectKey,
					store,
					backend,
					device,
					config: sync,
					now,
				});

				if (initialRevision !== null) {
					const baseline = emptyManifest();
					baseline.base = { revision: initialRevision, syncedAt: now().toISOString() };
					await writeManifest(manifestPath(syncRoot, projectKey), baseline);
					initialRevision = null;
				}

				runtime.engine = nextEngine;
				const warning = initialWarnings.length > 0 ? initialWarnings.map(errorMessage).join("\n") : undefined;
				initialWarnings = [];
				return warning === undefined ? { ok: true, engine: nextEngine } : { ok: true, engine: nextEngine, warning };
			} catch (error) {
				nextEngine?.dispose();
				return { ok: false, reason: errorMessage(error) };
			}
		},
	};

	return { runtime, errors };
}
