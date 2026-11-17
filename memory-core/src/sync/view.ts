import type { SyncRoundResult, SyncStatusReport } from "./engine.js";
import { syncErrorMessage } from "./errors.js";
import { sameSyncRemote } from "./paths.js";

/**
 * 同步报告的**共同格式化**：一轮结果（`renderSyncRound`）与状态报告（`renderSyncStatus`）。
 *
 * 这里只放两个宿主真正一致的部分：字段集合、列表的排序去重、失败轮照样展开、revision 的
 * 空/缺区分，以及出口处那一次统一的凭据脱敏。**展示策略留在宿主**：
 *
 * - 漂移提示由宿主注入（`originDriftMessage`）：core 不含任何 slash 命令，也不猜宿主的配置入口叫
 *   什么 —— 各宿主都有一句自己的「该去改哪里」，把那两句塞进 core 就等于让 core 认识宿主。
 * - 尾部扩展行同样由宿主注入（`trailingLines`），只放确实跨宿主一致的报告尾巴，不是通知通道；
 *   通知前缀、notice/error 级别、去重都在宿主那一侧。
 */

/** `renderSyncStatus` 的宿主注入项。两者都可缺席：不传就是纯共同格式。 */
export interface SyncViewOptions {
	/** 检测到「配置的 remote 与已初始化的 origin 不一致」时追加的那一句（宿主自己的指引文案）。 */
	originDriftMessage?: string;
	/** 报告末尾按**原序**追加的行。 */
	trailingLines?: readonly string[];
}

function uniqueFiles(files: readonly string[]): string[] {
	return [...new Set(files)].sort();
}

function renderFiles(label: string, files: readonly string[]): string {
	const unique = uniqueFiles(files);
	return unique.length === 0 ? `${label}: none` : `${label} (${unique.length}): ${unique.join(", ")}`;
}

/** 同一文件只留第一条拒收原因：其余是同一件事的重复记账，凑成多行只会稀释信号。 */
function renderRejected(rejected: ReadonlyArray<{ file: string; reason: string }>): string {
	const byFile = new Map<string, { file: string; reason: string }>();
	for (const item of rejected) if (!byFile.has(item.file)) byFile.set(item.file, item);
	const unique = [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
	if (unique.length === 0) return "Rejected: none";
	return `Rejected (${unique.length}):\n${unique.map((item) => `- ${item.file}: ${item.reason}`).join("\n")}`;
}

/**
 * 一轮同步的文本报告。
 *
 * 失败轮与成功轮**结构完全相同**：失败也可能已经改过本地（拉下来的内容、冲突副本、`-sync` 快照），
 * 只报原因不报这些部分结果，用户就看不到「失败的一轮其实动了什么」。
 * `revision` 只在 core 真的交出时才打印 —— 它缺席意味着基线没写进盘，报一个盘上不存在的版本
 * 等于让人对着假状态排查；空串则是「远端还没有基线」这一**已知**状态，打印成 `(empty)`。
 */
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
	for (const conflict of result.conflicts) {
		if (!conflicts.has(conflict.file)) conflicts.set(conflict.file, conflict.keptAsNew);
	}
	const conflictFiles = [...conflicts.keys()].sort();
	lines.push(
		conflictFiles.length === 0
			? "Conflicts: none"
			: `Conflicts (${conflictFiles.length}):\n${conflictFiles.map((file) => `- ${file} -> ${conflicts.get(file)}`).join("\n")}`,
		renderRejected(result.rejected),
		renderFiles("Unparsable local", result.unparsableLocal),
		renderFiles("Out of scope remote", result.outOfScopeRemote),
	);
	return syncErrorMessage(lines.join("\n"));
}

/**
 * 同步状态的文本报告。
 *
 * `origin` 是真相来源：配置与它不一致时**不改任何行为**，只是追加宿主注入的那一句提醒。
 * 两侧都是非空才比较 —— 未配置 / 未初始化的时候根本没有「漂移」这回事，把空串拿去比
 * 只会让报告凭空多一条警告。
 */
export function renderSyncStatus(
	report: SyncStatusReport,
	configuredRemote: string,
	options?: SyncViewOptions,
): string {
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
	const drift =
		configuredRemote.trim() !== "" && report.remote.trim() !== "" && !sameSyncRemote(configuredRemote, report.remote);
	if (drift && options?.originDriftMessage !== undefined) lines.push(options.originDriftMessage);
	if (options?.trailingLines !== undefined) lines.push(...options.trailingLines);
	return syncErrorMessage(lines.join("\n"));
}
