import type { SyncRoundResult, SyncStatusReport } from "@yandy0725/memory-core";
import {
	renderSyncRound as renderCoreSyncRound,
	renderSyncStatus as renderCoreSyncStatus,
} from "@yandy0725/memory-core";
import type { DshSyncSession } from "./sync.js";
import { SYNC_REMOTE_DRIFT_ERROR, syncErrorMessage } from "./sync.js";

/**
 * dsh 的报告出口：共同格式（字段集合、排序去重、失败轮展开、revision 空/缺区分、出口脱敏）
 * 由 core 提供，dsh 只补自己那一句 origin 漂移指引。
 *
 * 会话级账本（`session.errors`/`notices`）与 `/memory` 的轻量状态区仍留在这里：那是宿主的通知通道，
 * 不是同步报告的格式。
 */

/** 纯渲染包装：core 拥有全部字段与排序，dsh 不再维护第二份实现；出口再换成 dsh 的配置词汇。 */
export function renderSyncRound(result: SyncRoundResult): string {
	return syncErrorMessage(renderCoreSyncRound(result));
}

/** 纯渲染包装：共同格式 + dsh 自己的漂移指引（origin 是真相来源，配置漂移只是一条非致命提醒）。 */
export function renderSyncStatus(report: SyncStatusReport, configuredRemote: string): string {
	return syncErrorMessage(
		renderCoreSyncStatus(report, configuredRemote, { originDriftMessage: SYNC_REMOTE_DRIFT_ERROR }),
	);
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
