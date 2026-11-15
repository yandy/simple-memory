/**
 * `@yandy0725/memory-core` 的公开 API 唯一入口。
 *
 * 子路径不导出：适配层只能从这里拿符号，这样「什么是契约」永远等于这一个文件的内容。
 * 只导出适配层实际用到的符号。
 *
 * 中立性硬约束：本包的任何文件都不得 import 宿主包。`tests/neutrality.test.ts` 是这条约束的
 * 执行点 —— 它按 import 说明符判定，`src/**` 只允许 `node:*` 与相对路径。monorepo 的 hoisting
 * 会让宿主的包在 `node_modules` 里看得见，「编译得过」拦不住一次顺手 import，所以必须有这道门。
 */

// ── store/ 磁盘格式 ────────────────────────────────────────────────────────────
export { ENTRY_TYPES, deriveDescription, parseEntryFile, serializeEntryFile } from "./store/entry-file.js";
export type { EntryMeta, EntryType, ParsedEntryFile } from "./store/entry-file.js";

export {
	formatIndexLine,
	indexCapacity,
	parseEntryIndex,
	removeIndexLine,
	splitLines,
	upsertIndexLine,
} from "./store/entry-index.js";
export type { IndexCapacity, IndexLineEntry, ParsedEntryIndex } from "./store/entry-index.js";

export { ENTRY_EXT, entryFileName, foldFileName, isEntryFileName, resolveUniqueFileName } from "./store/filename.js";

// ── store/ 读写门面 ────────────────────────────────────────────────────────────
export { BACKUP_DIR, INDEX_FILE, LOCK_FILE, MemoryStore } from "./store/memory-store.js";
export type {
	ApplyChange,
	ApplyResult,
	Entry,
	EntrySummary,
	StoreConfig,
	WriteOptions,
} from "./store/memory-store.js";

// ── store/ 并发与容错 ──────────────────────────────────────────────────────────
export { MemoryLockedError, readLockStatus, tryWithLock, withLock } from "./store/fs-lock.js";
export type { LockInfo, LockOptions } from "./store/fs-lock.js";

export { isTransientFsError, withFsRetry } from "./store/fs-retry.js";
export type { FsRetryOptions } from "./store/fs-retry.js";

export {
	ProcessLockTimeoutError,
	isProcessLockActive,
	tryWithProcessLock,
	withProcessLock,
} from "./store/process-lock.js";

export { createSnapshot, pruneSnapshots, snapshotStamp } from "./store/snapshot.js";
export type { SnapshotOptions } from "./store/snapshot.js";

export { withFileMutationQueue } from "./store/mutation-queue.js";

// ── store/ 路径与安全 ──────────────────────────────────────────────────────────
export {
	assertInsideRoot,
	normalizeRemoteUrl,
	projectDirName,
	projectIdentity,
	resolveMemoryDir,
} from "./store/paths.js";
export type { NamingOptions, ProjectIdentity, ProjectKind } from "./store/paths.js";

export { sanitizeForInjection, stripInvisibleChars } from "./store/sanitize.js";

export { escapeWindowsTrailing, isReservedWindowsName, windowsSafeName } from "./store/windows-names.js";

// ── 配置（默认值、合并语义、模型校验、共享数据根）──────────────────────────────
// core 只给默认值与合并语义；配置文件在哪、读不读，是适配层的事。
export {
	DEFAULT_CONFIG,
	defaultMemoryRoot,
	expandTilde,
	mergeConfig,
	modelConfigErrors,
	requiredModel,
	requiredModels,
	syncConfigErrors,
	taskModel,
} from "./config.js";
export type {
	AutoSurfacingConfig,
	DefaultsConfig,
	EffortLevel,
	ExtractMemoriesConfig,
	MemoryConfig,
	ModelTask,
	SessionPersistenceConfig,
	SyncConfig,
	ThinkLevel,
} from "./config.js";

// ── tool/ 中立工具契约 ────────────────────────────────────────────────────────
// schema 是纯 JSON Schema，文案是纯字符串，handler 是纯函数：适配层把它们包成宿主的工具对象
// （pi → typebox + ToolDefinition + pi-tui 渲染；dsh → schemastery + defineTool）。
export { DREAM_ACTIONS, MAIN_AGENT_ACTIONS } from "./tool/actions.js";
export type { MemoryAction } from "./tool/actions.js";

// ── 注入的纯策略 ──────────────────────────────────────────────────────────────
// 这里只有「算出该注入什么字符串」；**注入时机、session 内去重状态、prompt cache 优化**
// 全在适配层 —— pi 的「索引按 session 冻结」与其他宿主的「每次 assembly 重新求值」是互斥语义。
export {
	ENTRY_TRUNCATION_MARKER,
	INDEX_TRUNCATION_MARKER,
	SIDE_QUERY_MANIFEST_CHARS,
	SIDE_QUERY_MAX_ENTRIES,
	SIDE_QUERY_MIN_DESC_CHARS,
	buildIndexSection,
	buildSideQueryTask,
	indexInjectionCapacity,
	renderSurfacedBlock,
	scanEntries,
	truncateForInjection,
	truncateIndexForInjection,
} from "./injection.js";
export type { EntryManifest } from "./injection.js";

// ── orchestration/ LLM 编排 ───────────────────────────────────────────────────
// 适配层实现 `HeadlessAgentPort` 与 `HostTranscriptPort` 两个端口，就能拿到与 pi 完全相同的
// dream / extract / 侧查询行为（prompt 文本、锁与快照边界、截断预算、错误语义）。
export { runTask } from "./orchestration/task.js";
export { TASKS } from "./orchestration/tasks.js";
export { moduleStatusRows } from "./orchestration/status.js";
export type { ModuleStatusRow } from "./orchestration/status.js";
export type {
	Incomplete,
	MemoryTask,
	MemoryToolOnWrite,
	TaskContext,
	TaskDeps,
	TaskPlan,
} from "./orchestration/task.js";
export type { ExtractInput, ExtractResult } from "./orchestration/extract.js";
export { renderConversation } from "./orchestration/conversation.js";
export type { ConversationLimits } from "./orchestration/conversation.js";
export type { SurfacingInput, SurfacingResult } from "./orchestration/surfacing.js";
export { buildDreamTask, buildExtractTask } from "./orchestration/prompts.js";
export type {
	ExtractMessage,
	HeadlessAgentPort,
	HeadlessOutcome,
	HeadlessRunRequest,
	HostTranscriptPort,
	IncompleteOutcome,
	OrchestrationPorts,
} from "./orchestration/ports.js";
export { memoryToolSchema } from "./tool/schema.js";
export type { MemoryToolField, MemoryToolJsonSchema } from "./tool/schema.js";
export {
	MEMORY_TOOL_DESCRIPTION,
	MEMORY_TOOL_GUIDELINES,
	MEMORY_TOOL_LABEL,
	MEMORY_TOOL_NAME,
	MEMORY_TOOL_SNIPPET,
} from "./tool/texts.js";
export { capacityWarning, createMemoryActionHandler } from "./tool/handler.js";
export type {
	MemoryActionResult,
	MemoryHandlerConfig,
	MemoryHandlerDeps,
	MemoryHandlerOptions,
} from "./tool/handler.js";

// ── sync/ 跨设备同步 ──────────────────────────────────────────────────────────
// 适配层只从这里拿同步能力：装引擎（`createSyncEngine`）与写触发调度器、选或实现传输端口
// （`SyncBackend` / `createGitSyncBackend`）、以及读同步状态要用的远端布局与 manifest 助手。
// 文件名口径（`isEntryFileName` / `foldFileName`）与 `applyEntryFiles` 的入参类型
// （`ApplyChange` / `ApplyResult`）在 store 分区、配置子树（`SyncConfig` / `syncConfigErrors`）
// 在配置分区：一个符号只导一次，分区跟拥有它的模块走。
export { NonFastForwardError } from "./sync/backend.js";
export type { RemoteView, SyncBackend, SyncPublishChanges, SyncRunOptions, SyncScope } from "./sync/backend.js";

export { createGitSyncBackend, gitAvailable } from "./sync/backend-git.js";
export type { GitSyncBackendOptions } from "./sync/backend-git.js";

export { conflictSuffix, resolveConflict } from "./sync/conflict.js";
export type { ConflictInput, ConflictOutcome, ConflictSide } from "./sync/conflict.js";

export { devicePath, loadOrCreateDevice } from "./sync/device.js";
export type { DeviceIdentity } from "./sync/device.js";

export { diffThreeWay, isEmptyDiff } from "./sync/diff.js";
export type { SyncConflict, SyncDiff } from "./sync/diff.js";

export { createSyncEngine } from "./sync/engine.js";
export type { SyncEngine, SyncEngineOptions, SyncRoundResult, SyncStatusReport } from "./sync/engine.js";

export { sha256Hex } from "./sync/hash.js";

export { MANIFEST_VERSION, emptyManifest, manifestPath, readManifest, writeManifest } from "./sync/manifest.js";
export type { SyncManifest } from "./sync/manifest.js";

export { SYNC_DIR_NAME, remoteEntryPath, remotePrefix, remoteProjectKey, syncRootPath } from "./sync/paths.js";

export { scanLocalEntries } from "./sync/scan.js";
export type { LocalScan } from "./sync/scan.js";

// 调度器是泛型：`T` 是「一轮推送的结果」，引擎那一侧代入 `SyncRoundResult` 就不必在公开边界上转型。
export { createSyncScheduler } from "./sync/scheduler.js";
export type { SyncScheduler, SyncSchedulerOptions } from "./sync/scheduler.js";

export type { SyncFileInfo, SyncFileSet } from "./sync/types.js";
