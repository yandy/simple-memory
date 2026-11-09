import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	indexCapacity,
	indexInjectionCapacity,
	LOCK_FILE,
	parseEntryIndex,
	readLockStatus,
	taskModel,
	withFsRetry,
} from "@yandy0725/memory-core";
import type { SessionMemoryRuntime } from "./store-registry.js";

/**
 * `/memory` 命令需要的依赖。命令定义只是数据（Task 16 才做注册与生命周期），
 * 所以这里只拿「查运行时 + 刷索引 + 行 config 的警告」三样。
 */
export interface CommandDeps {
	registry: { get(sessionId: string): SessionMemoryRuntime | undefined };
	indexCache: { refresh(rt: SessionMemoryRuntime): Promise<void> };
	warnings: string[];
}

/**
 * 宿主 `ctx.commands.register` 要求的最小定义形状。结构化、零宿主 import：
 * 宿主的 `normalizeDefinition` 会校验 `name`（`/^[a-z][a-z0-9_-]*$/`，不带斜杠）、
 * 非空 `description`、函数型 `handler` 与非空 `input.hint` —— 这些都不是装饰。
 * 真宿主还会补 `commandId` / `attachments`，这里只声明我们要用的字段。
 */
export interface CommandDefinitionLike {
	name: string;
	description: string;
	input: { hint: string };
	handler(inv: {
		agent: { session: { id: string } };
		rawInput: string;
		signal?: AbortSignal;
	}): Promise<{ kind: "success" | "error"; text: string }>;
}

/** `<op> (pid <N> on <hostname>, started <ISO>)` —— 与 pi 的 `describeHolder` 逐字同格式。 */
export function describeHolder(holder: { op: string; pid: number; hostname: string; startedAt: string }): string {
	return `${holder.op} (pid ${holder.pid} on ${holder.hostname}, started ${holder.startedAt})`;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * `/memory` 的锁状态行。只读不碰 —— `.lock` **永不自动回收**（core 的 fs-lock 说明），
 * 人工清除只有 `unlock --force` 一个入口。带 hostname：`.lock` 是目录里的普通文件，
 * 同一份目录可能被挂载到多台机器，只看 pid 无法判断持有者是「本机已死的进程」还是
 * 「别的机器正在跑」。
 */
async function lockStatusLine(memoryDir: string): Promise<string> {
	const status = await readLockStatus(join(memoryDir, LOCK_FILE));
	if (status.kind === "absent") return "free";
	if (status.kind === "unreadable") return "unreadable — run /memory unlock --force";
	return `held by ${describeHolder(status.holder)}`;
}

/**
 * `/memory unlock`：崩溃遗留的 `.lock` 的**唯一**人工清除入口。宿主的命令 handler 不在任何
 * turn 里、approval 服务会直接拒，所以「人的显式确认」用 `--force` 表达，而不是 pi 的
 * `ui.confirm`（同一属性、不同机制）。只删 `.lock` 本身 —— 删错了就是两个写入者同时持有锁。
 */
async function unlockMemory(memoryDir: string, force: boolean): Promise<{ kind: "success" | "error"; text: string }> {
	const lockPath = join(memoryDir, LOCK_FILE);
	const status = await readLockStatus(lockPath);

	if (!force) {
		if (status.kind === "absent") return { kind: "success", text: "No lock present." };
		const described = status.kind === "held" ? `held by ${describeHolder(status.holder)}` : "unreadable";
		return { kind: "success", text: `Lock is ${described} — re-run /memory unlock --force to remove it.` };
	}

	if (status.kind === "absent") return { kind: "success", text: "No lock present." };
	try {
		// 恢复路径也要重试：删除本身同样会被杀软/索引器/同步客户端打断，再报一次瞬时错误就是
		// 把用户困在原地。幂等（删一个已不存在的文件走 ENOENT 分支），重试无副作用。
		await withFsRetry(() => unlink(lockPath));
		return { kind: "success", text: "Memory lock removed." };
	} catch (e) {
		// check 到 unlink 之间锁自己消失了：那正是想要的结果
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "success", text: "No lock present." };
		return { kind: "error", text: `Failed to remove memory lock: ${messageOf(e)}` };
	}
}

/**
 * 状态块。内容口径与 pi 的 `/memory` 一致（同一套 core 窗口核心），去掉 dsh 本轮没有的行
 * （dream / extractMemories / Last dream）。三个「不是状态、而是诊断」的早退路径都返回可读文本：
 * 命令本身是成功的，坏的是记忆层（pi 用 `notify(..., "info")` 表达同一件事）。
 */
export async function renderStatus(rt: SessionMemoryRuntime | undefined, warnings: string[]): Promise<string> {
	if (rt === undefined) {
		return "Memory: not initialized — no memory runtime for this session";
	}
	if (rt.error !== null) {
		const lines = ["Memory: misconfigured", "Dir: not initialized"];
		lines.push(...rt.error.split("\n").map((e) => `- ${e}`));
		return lines.join("\n");
	}
	if (rt.store === null || rt.memoryDir === null) {
		// store-registry 保证 store === null 时 error 必非空；这里只是防御，不是可达路径。
		return "Memory: not initialized";
	}

	const dir = rt.memoryDir;
	const store = rt.store;

	const indexRaw = await store.readIndex();
	const cap = indexCapacity(indexRaw, rt.config.memIndexMaxLines, rt.config.memIndexMaxBytes);
	const inject = indexInjectionCapacity(indexRaw, rt.config.memIndexInjectMaxLines, rt.config.memIndexInjectMaxBytes);

	const modules = rt.surfacing.available
		? `autoSurfacing=on(${taskModel(rt.config, "autoSurfacing") ?? "no model"})`
		: `autoSurfacing=off(${rt.surfacing.reason ?? "disabled"})`;

	const lines = [
		// Dir 必须打印：memoryDir 是 per-harness 配置（spec D4 —— 刻意没有共享配置文件）。
		// 用户在 pi 里覆盖了它、在 dsh 里没覆盖时，两个宿主写不同目录，这一行是唯一能看见的地方。
		`Dir: ${dir}`,
		`Index: ${cap.lineCount}/${rt.config.memIndexMaxLines} lines, ${cap.byteLength}/${rt.config.memIndexMaxBytes} bytes, ${parseEntryIndex(indexRaw).unrecognized} unrecognized lines`,
		`Inject: ${inject.lineCount}/${rt.config.memIndexInjectMaxLines} lines, ${inject.byteLength}/${rt.config.memIndexInjectMaxBytes} bytes`,
		`Entries: ${(await store.listEntries()).length}`,
		`Modules: ${modules}`,
		`Lock: ${await lockStatusLine(dir)}`,
	];
	if (warnings.length > 0) {
		lines.push(`Config: ${warnings.length} warning(s)`);
		lines.push(...warnings);
	}
	return lines.join("\n");
}

export function createMemoryCommand(deps: CommandDeps): CommandDefinitionLike {
	return {
		name: "memory",
		description: "Show memory status, or remove a stale lock with `unlock --force`",
		input: { hint: "[unlock --force]" },
		handler: async (inv) => {
			const rt = deps.registry.get(inv.agent.session.id);
			// rawInput 是命令名之后的原文（含分隔空白），先 trim 再按空白拆分。
			const tokens = inv.rawInput
				.trim()
				.split(/\s+/)
				.filter((t) => t.length > 0);

			if (tokens[0] === "unlock") {
				if (rt === undefined || rt.memoryDir === null) {
					return { kind: "error", text: "Cannot unlock: memory directory is not resolved for this session" };
				}
				return await unlockMemory(rt.memoryDir, tokens.includes("--force"));
			}

			// `/memory` 兼作手动同步入口：报状态前先刷一次索引快照（refresh 永不抛错）。
			if (rt !== undefined) await deps.indexCache.refresh(rt);
			return { kind: "success", text: await renderStatus(rt, deps.warnings) };
		},
	};
}
