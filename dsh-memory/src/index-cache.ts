import { buildIndexSection } from "@yandy0725/memory-core";
import type { SessionMemoryRuntime } from "./store-registry.js";

/**
 * 每个 session 一份的索引快照。
 *
 * 读侧（`read`）挂在宿主的 system prompt 装配路径上（spec §5.4 的 `text` 回调必须同步），
 * 而 `buildIndexSection` 是异步的（读 MEMORY.md + 截断 + 净化）。所以这里把两者拆开：
 * 刷新在 `agent/created`、memory 工具写入后、`/memory` 执行后、每轮第一个 step 之前异步发生，
 * 读则只是同步查一张 `Map`。
 *
 * 两条硬约束（spec §5.4）：
 * - `read` **永不抛错、永不返回 `undefined`**：一次读盘失败绝不能让 prompt 装配整体失败。
 * - `refresh` **永不抛错**，失败必须**保留旧值**：过期索引只是轻微降级，消失的索引是坏掉的会话。
 */
export interface IndexCache {
	/** 异步刷新；失败保留旧值（section 绝不能因为一次读盘失败而消失）。 */
	refresh(rt: SessionMemoryRuntime): Promise<void>;
	/** section 的 text 回调：同步、永不抛错。没有值 → 空串（该 session 不注入索引）。 */
	read(sessionId: string): string;
	forget(sessionId: string): void;
	/** 测试/诊断用：最近一次 refresh 是否失败。不对外暴露给宿主，也不是 read 失败的信道。 */
	lastError(sessionId: string): string | null;
}

interface Snapshot {
	text: string;
	error: string | null;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * 纯内存 `Map`：`sessionId → { text, error }`。没有 TTL、没有 watcher、没有失效事件 ——
 * 刷新时机由调用方（Task 16 的装配）决定，这里只管「异步写、同步读、失败保留旧值」。
 * `forget` 由 `agent/disposed` 调用，删除整个快照，长驻宿主进程里不会按 session 无限增长。
 */
export function createIndexCache(): IndexCache {
	const bySession = new Map<string, Snapshot>();

	async function refresh(rt: SessionMemoryRuntime): Promise<void> {
		let snapshot = bySession.get(rt.sessionId);
		if (!snapshot) {
			snapshot = { text: "", error: null };
			bySession.set(rt.sessionId, snapshot);
		}

		// store === null 是「没初始化成功」的正常空态（D13），不是刷新失败：给空串、不记 error。
		if (rt.store === null) {
			snapshot.text = "";
			snapshot.error = null;
			return;
		}

		try {
			// core 出口已含截断与净化：这里原样透传，不做任何二次转义（byte-identical 是刻意的
			// 跨 harness 属性 —— dsh 注入的索引与 pi 注入的逐字相同）。`{{...}}` 由 section 的
			// `interpolate: false`（Task 16）负责，不在这里处理。
			snapshot.text = await buildIndexSection(
				rt.store,
				rt.config.memIndexInjectMaxLines,
				rt.config.memIndexInjectMaxBytes,
			);
			snapshot.error = null;
		} catch (e) {
			// 只记 error，绝不覆盖 text：旧的索引仍可注入，section 不会因此消失。
			snapshot.error = messageOf(e);
		}
	}

	function read(sessionId: string): string {
		return bySession.get(sessionId)?.text ?? "";
	}

	function forget(sessionId: string): void {
		bySession.delete(sessionId);
	}

	function lastError(sessionId: string): string | null {
		return bySession.get(sessionId)?.error ?? null;
	}

	return { refresh, read, forget, lastError };
}
