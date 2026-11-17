import type {
	MemoryConfig,
	MemoryStore,
	ProjectIdentity,
	SyncRuntime,
	SyncRuntimeOptions,
} from "@yandy0725/memory-core";
import {
	syncErrorMessage as coreSyncErrorMessage,
	createGitSyncBackend,
	createSyncEngine,
	createSyncRuntime,
	writeManifest,
} from "@yandy0725/memory-core";

/**
 * dsh 的同步适配层：**只有宿主文案与出口包装**。
 *
 * 编排（门禁、懒 engine、prepare、startup/run/status/changeRemote、换远端持久顺序、写触发与
 * 收摊）全部在 core 的 `createSyncRuntime` 里；这里保留的每一行都属于宿主策略：
 *
 * - 调度固定 `serial`：dsh 的手动命令排成一条 FIFO，前一个活动结束前下一个不开始。
 * - 漂移提示与「未初始化却要换远端」的指引必须指向 dsh 自己的配置来源（行 config）与
 *   `/memory sync remote` —— core 不认宿主的斜杠命令，也不认识配置放在哪里。
 * - 「origin 已切换，但 prepare/后续操作失败」是 dsh 的既有诊断措辞，经 `formatRemoteChangeFailure`
 *   保留；pi 不传该 formatter，保持原始、已脱敏 reason。
 * - backend/engine/manifest writer 原样注入**公开** core 出口：测试注入的捕获工厂与
 *   `writeManifest` 故障注入因此继续命中真实现，而不是被 core 内部的相对 import 绕开。
 */

/**
 * origin 漂移的可读诊断。导出为常量而不是就地字面量：`/memory sync remote <url>` 成功后要
 * 精确地移除这一条（而不是盲目清空全部持久错误），靠文案字符串比对而不是索引位置。
 */
export const SYNC_REMOTE_DRIFT_ERROR =
	'sync.remote differs from the initialized origin; continuing to use origin (use "/memory sync remote <url>" to change it)';

/** 尚未初始化却请求换远端：dsh 的配置来源叫行 config，不是 memory.json。 */
const UNINITIALIZED_REMOTE_CHANGE = 'sync is not initialized: set "sync.remote" in the plugin row config instead';

/** 既有公开形状：runtime 以 core 的 `SyncRuntime` 为基，类型别名保留宿主侧叫法。 */
export type DshSyncRuntime = SyncRuntime;

export interface DshSyncSession {
	runtime: DshSyncRuntime | null;
	/** 当前要展示的错误/预告；启动与手动操作会更新它们。 */
	errors: string[];
	notices: string[];
	/** 工厂阶段仍成立的错误（例如 origin 漂移）；手动成功只清瞬时错误。 */
	persistentErrors?: string[];
}

/** core 已脱敏；这里再把配置入口换成 dsh 的叫法，不把 JSON 文件名词带进提示。 */
export function syncErrorMessage(error: unknown): string {
	return coreSyncErrorMessage(error).replaceAll("memory.json", "plugin row config");
}

/**
 * origin 已切换之后才失败时，核心已经不知道宿主怎么称呼这个远端，所以由宿主补一句「已经切过去了」。
 * 两种阶段（准备新基线 / 其余操作）沿用 dsh 既有措辞；未切换时原样交回已脱敏 reason。
 */
function formatRemoteChangeFailure(failure: {
	remote: string;
	originChanged: boolean;
	stage: "prepare" | "operation";
	reason: string;
}): string {
	if (!failure.originChanged) return failure.reason;
	const changed = `the origin was already changed to ${syncErrorMessage(failure.remote)}`;
	return failure.stage === "prepare"
		? `${changed}, but preparing the new baseline failed: ${failure.reason}`
		: `${changed}, but the remote change failed afterwards: ${failure.reason}`;
}

/**
 * 装配本会话的同步 runtime（不做任何初始化写入）。门禁顺序、错误通道与 origin 漂移提醒
 * 都由 core 决定，dsh 只提供配置、store、项目身份、文案与注入的真实实现。
 *
 * `createBackend`/`createEngine` 只是**测试捕获缝**：生产调用从不传，默认就是 core 的公开真实工厂。
 * core 的 runtime 刻意不把 backend 放上公开面，故障注入因此需要一个能在装配时拿到实例的位置。
 */
export async function createDshSyncRuntime(options: {
	config: MemoryConfig;
	store: MemoryStore;
	projectDir: string;
	identity: ProjectIdentity;
	now?: () => Date;
	createBackend?: SyncRuntimeOptions["createBackend"];
	createEngine?: SyncRuntimeOptions["createEngine"];
}): Promise<{ runtime: DshSyncRuntime | null; errors: string[]; notices: string[] }> {
	const assembled = await createSyncRuntime({
		config: options.config,
		store: options.store,
		projectDir: options.projectDir,
		identity: options.identity,
		scheduling: "serial",
		createBackend: options.createBackend ?? ((context) => createGitSyncBackend(context)),
		createEngine: options.createEngine ?? ((engineOptions) => createSyncEngine(engineOptions)),
		writeManifest,
		messages: {
			originDrift: SYNC_REMOTE_DRIFT_ERROR,
			uninitializedRemoteChange: UNINITIALIZED_REMOTE_CHANGE,
			formatRemoteChangeFailure,
		},
		now: options.now,
	});
	// core 已脱敏；这里只做 dsh 自己的配置词汇替换 —— 这些字符串会直接进会话账本与宿主日志。
	return { ...assembled, errors: assembled.errors.map(syncErrorMessage) };
}
