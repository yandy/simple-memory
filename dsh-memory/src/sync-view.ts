import type { SyncRoundResult, SyncStatusReport } from "@yandy0725/memory-core";
import { sameSyncRemote } from "@yandy0725/memory-core";
import type { DshSyncSession } from "./sync.js";
import { syncErrorMessage } from "./sync.js";

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

/** 失败轮也展开全部部分结果；revision 只有 core 真正写回基线后才显示。 */
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

/** origin 是真相来源；配置漂移只是一条非致命提醒。所有出口统一脱敏。 */
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
	return syncErrorMessage(lines.join("\n"));
}

/** `/memory` 的轻量状态区：不调用 engine.status，因此不会联网或初始化。 */
export function renderSyncSummary(session: DshSyncSession): string[] {
	const lines = [`Sync: ${session.runtime?.engine ? "ready" : session.runtime ? "not initialized" : "disabled"}`];
	const notices = [...new Set(session.notices.map((notice) => notice.trim()).filter(Boolean))];
	const errors = [...new Set(session.errors.map((error) => error.trim()).filter(Boolean))];
	if (notices.length > 0) lines.push("Sync notice:", ...notices.map((notice) => `- ${notice}`));
	if (errors.length > 0) lines.push("Sync error:", ...errors.map((error) => `- ${error}`));
	return lines.map(syncErrorMessage);
}
