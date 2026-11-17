import {
	createGitSyncBackend,
	createSyncEngine,
	createSyncRuntime,
	type MemoryStore,
	type ProjectIdentity,
	renderSyncRound as renderCoreSyncRound,
	renderSyncStatus as renderCoreSyncStatus,
	type SyncRoundResult,
	type SyncRuntime,
	type SyncStatusReport,
	syncErrorMessage,
	writeManifest,
} from "@yandy0725/memory-core";
import type { MemoryConfig } from "./config";

/**
 * pi 的同步适配层：**只有宿主文案与出口包装**。
 *
 * 编排（门禁、懒 engine、prepare、startup/run/status/changeRemote、换远端持久顺序、写触发与
 * 收摊）全部在 core 的 `createSyncRuntime` 里；这里保留的每一行都属于宿主策略：
 *
 * - 调度固定 `concurrent`：pi 的活动在公开调用返回前就开始并登记，与其他会话级工作并发。
 * - 漂移提示与「未初始化却要换远端」的指引必须指向 pi 自己的配置来源 `memory.json` 与
 *   `/memory sync remote` —— core 不认宿主的斜杠命令。
 * - 报告的尾部行（索引只在会话开始冻结）同样是 pi 的展示策略。
 * - backend/engine/manifest writer 原样注入**公开** core 出口：接线测试的包装工厂与
 *   `writeManifest` 故障注入因此继续命中真实现，而不是被 core 内部的相对 import 绕开。
 */

/** 配置与 origin 漂移：origin 是真相来源，提醒用户该改哪里。 */
const ORIGIN_DRIFT_MESSAGE =
	'sync.remote differs from the initialized origin; continuing to use origin (use "/memory sync remote <url>" to change it)';

/** 尚未初始化却请求换远端：pi 的配置来源叫 memory.json。 */
const UNINITIALIZED_REMOTE_CHANGE = 'sync is not initialized: set "sync.remote" in memory.json instead';

/** 索引在会话内冻结：手动同步只改磁盘，下一轮 prompt 仍是同一个值。 */
const FROZEN_PROMPT_LINE = "Prompt index: frozen for this session; manual sync updates disk only.";

/** 既有公开形状：runtime 以 core 的 `SyncRuntime` 为基，类型别名保留宿主侧叫法。 */
export type PiSyncRuntime = SyncRuntime;

/** core 已脱敏；这里守住适配层自己的通知边界，不把将来新增错误里的口令带进 UI。 */
export function errorMessage(error: unknown): string {
	return syncErrorMessage(error);
}

/** 纯渲染包装：字段/排序/去重由 core 提供，pi 不再维护第二份实现。 */
export function renderSyncRound(result: SyncRoundResult): string {
	return renderCoreSyncRound(result);
}

/** 纯渲染包装：共同格式 + pi 的漂移指引与冻结索引尾行。 */
export function renderSyncStatus(report: SyncStatusReport, configuredRemote: string): string {
	return renderCoreSyncStatus(report, configuredRemote, {
		originDriftMessage: ORIGIN_DRIFT_MESSAGE,
		trailingLines: [FROZEN_PROMPT_LINE],
	});
}

/**
 * 装配本会话的同步 runtime（不做任何初始化写入）。门禁顺序、错误通道与 origin 漂移提醒
 * 都由 core 决定，pi 只提供配置、store、项目身份、文案与注入的真实实现。
 */
export async function createPiSyncRuntime(options: {
	config: MemoryConfig;
	store: MemoryStore;
	projectDir: string;
	identity: ProjectIdentity;
	now?: () => Date;
}): Promise<{ runtime: PiSyncRuntime | null; errors: string[]; notices: string[] }> {
	return createSyncRuntime({
		config: options.config,
		store: options.store,
		projectDir: options.projectDir,
		identity: options.identity,
		scheduling: "concurrent",
		createBackend: (context) => createGitSyncBackend(context),
		createEngine: (engineOptions) => createSyncEngine(engineOptions),
		writeManifest,
		messages: { originDrift: ORIGIN_DRIFT_MESSAGE, uninitializedRemoteChange: UNINITIALIZED_REMOTE_CHANGE },
		now: options.now,
	});
}
