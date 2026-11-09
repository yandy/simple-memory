import { MemoryStore, resolveMemoryDir } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";
import { errorMessage } from "./errors.js";
import type { ModuleAvailability } from "./model.js";
import type { ResolvedConfig } from "./row-config.js";

/**
 * 本模块读到的最小宿主 agent 形状。
 *
 * 刻意不用宿主真正的 `Agent` 类型：这里只需要 `session.id` 与 `session.header` 里的 cwd /
 * 子 agent 判据字段，保持结构化、零宿主 import，好对着 fake 测试。装配层在接线边界把真
 * 宿主 agent 适配成这个形状。
 */
export interface AgentLike {
	session: { id: string; header: { cwd?: string; origin?: string; delegationDepth?: number; parentSession?: string } };
}

/** 每个 session 一份的运行时：`store === null` 即「该会话没初始化成功」，原因在 `error` 里。 */
export interface SessionMemoryRuntime {
	sessionId: string;
	cwd: string;
	config: MemoryConfig;
	store: MemoryStore | null;
	memoryDir: string | null;
	error: string | null;
	surfacing: ModuleAvailability;
}

/**
 * 宿主 `ctx.workingDirectory` 的结构性接缝。只声明 `ensure` 与 `get`，测试可以用不带 fake ctx
 * 的对象注入失败；生产传 `ctx.workingDirectory`。
 */
export interface HostDirLike {
	ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
	get(session: unknown): string;
}

export interface StoreRegistry {
	/** `agent/created` 里 await。**永不抛错**：失败也返回 `store: null` 的 runtime（降级而不失败）。 */
	prepare(
		agent: AgentLike,
		resolved: ResolvedConfig,
		surfacing: ModuleAvailability,
		signal?: AbortSignal,
	): Promise<SessionMemoryRuntime>;
	/** 同步取用（core 的 `MemoryHandlerDeps.getStore()` 是同步的）。没 prepare 过 → undefined。 */
	get(sessionId: string): SessionMemoryRuntime | undefined;
	forget(sessionId: string): void;
	/** 测试用：当前复用了几个 MemoryStore 实例（按 memoryDir 去重）。 */
	storeCount(): number;
}

/**
 * 根 agent 判据：只有根 agent 才挂记忆层（索引 / 工具 / 召回）。
 *
 * 以 `origin === "subagent"` 为主判据，正的 `delegationDepth` 为辅助。**绝不读 `parentSession`**：
 * 宿主 `dsh-session/lib/types/types.d.ts` 在 `parentSession` 上明文警告「Presence alone does not
 * classify a Session as a subagent; use `origin` for that distinction」—— 普通 fork 也可能带它。
 * 误判会让那个会话的索引 / 工具 / 召回全部静默不挂。
 */
export function isRootAgent(agent: { session?: { header?: Record<string, unknown> } }): boolean {
	const header = agent?.session?.header;
	if (!header) return true;
	if (header.origin === "subagent") return false;
	if (typeof header.delegationDepth === "number" && header.delegationDepth > 0) return false;
	return true;
}

/**
 * 按目录复用 store、按 sessionId 建索引的注册表。
 *
 * `prepare` 在 `agent/created`（serial、创建完成前被 await）里调用，是唯一的异步窗口：
 * `resolveMemoryDir` 要探 git remote，而 core 的工具 handler 只在执行时同步调 `getStore()`。
 * 同一目录的多个 session 共用一个 `MemoryStore` 实例（与 core 的进程内互斥 / 变更队列语义一致），
 * 按目录引用计数，`forget` 归零才丢。
 */
export function createStoreRegistry(dirs: HostDirLike): StoreRegistry {
	const bySession = new Map<string, SessionMemoryRuntime>();
	const byDir = new Map<string, { store: MemoryStore; refs: number }>();

	function releaseDir(memoryDir: string | null): void {
		if (memoryDir === null) return;
		const entry = byDir.get(memoryDir);
		if (!entry) return;
		entry.refs -= 1;
		if (entry.refs <= 0) byDir.delete(memoryDir);
	}

	function fail(
		sessionId: string,
		cwd: string,
		config: MemoryConfig,
		surfacing: ModuleAvailability,
		error: string,
	): SessionMemoryRuntime {
		const rt: SessionMemoryRuntime = {
			sessionId,
			cwd,
			config,
			store: null,
			memoryDir: null,
			error,
			surfacing,
		};
		bySession.set(sessionId, rt);
		return rt;
	}

	async function prepare(
		agent: AgentLike,
		resolved: ResolvedConfig,
		surfacing: ModuleAvailability,
		signal?: AbortSignal,
	): Promise<SessionMemoryRuntime> {
		const sessionId = agent.session.id;
		const headerCwd = agent.session.header.cwd ?? "";

		// 重复 prepare 同一 session（防御性）：先释放旧引用，保证 byDir 的引用数恒等于「已 prepare
		// 且未 forget 的 session 数」，不会因为重复 prepare 悄悄泄漏一个 ref。
		const existing = bySession.get(sessionId);
		if (existing) releaseDir(existing.memoryDir);

		if (resolved.error !== null && resolved.error.trim() !== "") {
			// 已处于错误态的 session 没理由再解析目录：跳过 dirs.ensure，直接给可读原因。
			// 空白 error 视同无错（上游可能给出空字符串），照常解析目录。
			return fail(sessionId, headerCwd, resolved.config, surfacing, resolved.error);
		}

		// cwd 来源：dirs.ensure(agent, signal)，异常回退 agent.session.header.cwd（宿主对同一件事的两个来源）。
		let cwd = "";
		let cwdError: string | null = null;
		try {
			cwd = await dirs.ensure(agent, signal);
		} catch (e) {
			cwdError = errorMessage(e);
		}
		if (!cwd) cwd = headerCwd;
		if (!cwd) {
			const reason = cwdError?.trim() ? cwdError : "no working directory available";
			return fail(
				sessionId,
				"",
				resolved.config,
				surfacing,
				`Failed to resolve the working directory for session ${sessionId}: ${reason}`,
			);
		}

		let memoryDir: string;
		try {
			memoryDir = await resolveMemoryDir({ memoryDir: resolved.config.memoryDir }, cwd);
		} catch (e) {
			return fail(sessionId, cwd, resolved.config, surfacing, `Failed to resolve memory directory: ${errorMessage(e)}`);
		}

		let entry = byDir.get(memoryDir);
		if (!entry) {
			entry = {
				store: new MemoryStore({
					memoryDir,
					indexMaxLines: resolved.config.memIndexMaxLines,
					indexMaxBytes: resolved.config.memIndexMaxBytes,
					lock: resolved.config.lock,
				}),
				refs: 0,
			};
			byDir.set(memoryDir, entry);
		}
		entry.refs += 1;

		const rt: SessionMemoryRuntime = {
			sessionId,
			cwd,
			config: resolved.config,
			store: entry.store,
			memoryDir,
			error: null,
			surfacing,
		};
		bySession.set(sessionId, rt);
		return rt;
	}

	function get(sessionId: string): SessionMemoryRuntime | undefined {
		return bySession.get(sessionId);
	}

	function forget(sessionId: string): void {
		const rt = bySession.get(sessionId);
		if (!rt) return;
		bySession.delete(sessionId);
		releaseDir(rt.memoryDir);
	}

	function storeCount(): number {
		return byDir.size;
	}

	return { prepare, get, forget, storeCount };
}
