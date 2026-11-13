import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	indexCapacity,
	indexInjectionCapacity,
	LOCK_FILE,
	parseEntryIndex,
	moduleStatusRows,
	readLockStatus,
	resolveMemoryDir,
	runTask,
	TASKS,
	taskModel,
	withFsRetry,
} from "@yandy0725/memory-core";
import type { HeadlessAgentPort } from "@yandy0725/memory-core";
import { errorMessage } from "./errors.js";
import { parseModelRef } from "./model.js";
import type { SessionMemoryRuntime } from "./store-registry.js";

/**
 * `/memory` 命令需要的依赖。命令定义只是数据（注册与生命周期在装配层），
 * 所以这里只拿「查运行时 + 刷索引 + 行 config 的警告 + 用户在行 config 里写过的白名单顶层键」四样。
 */
export interface CommandDeps {
	registry: { get(sessionId: string): SessionMemoryRuntime | undefined };
	indexCache: { refresh(rt: SessionMemoryRuntime): Promise<void> };
	warnings: string[];
	/**
	 * 用户在行 config 里**确实写过**的白名单顶层键（照用户写的顺序，含已实现的 `autoSurfacing`）。
	 * 由装配层用 `rowConfigSetKeys` 从原始行 config 算出来传进来；没实现的任务
	 * （`moduleStatusRows` 里 `implemented: false`）能无声无息地通过配置校验 —— 是否就地报出来、
	 * 怎么措辞，由 `renderStatus` 里的 `moduleStatusRows` 拼装决定。缺省为空：只为真写了它们的
	 * 用户增加噪声。（本轮三个任务全部实现了，所以这条就是给未来新增任务留的接口。）
	 */
	setKeys?: readonly string[];
}

/**
 * 宿主 `ctx.commands.register` 要求的最小定义形状。结构化、零宿主 import：
 * 宿主的 `normalizeDefinition`（`dsh-commands/lib/index.js:145-164`）会校验 `name`
 *（`/^[a-z][a-z0-9_-]*$/`，不带斜杠）、非空 `description`、函数型 `handler`；`input` 是**可选**的，
 * 一旦给了就必须带**非空** `hint`（`hint: ""` 会直接抛错）。这些都不是装饰：`register()` 抛错会让
 * `apply` 抛错，cordis 于是回滚整个 bundle 的注册（“记忆插件根本没生效”就是这么来的）。
 * 真宿主还会补 `commandId` / `attachments`，这里只声明我们要用的字段。
 */
export interface CommandDefinitionLike {
	name: string;
	description: string;
	/** 可选：不收参数的命令（如 `/dream`）干脆不传 —— 传了就必须非空 hint。 */
	input?: { hint: string };
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
		return { kind: "error", text: `Failed to remove memory lock: ${errorMessage(e)}` };
	}
}

/** `Modules:` 行里未实现任务的后缀：写得很白，不给用户留「它也许在跑」的想像空间。 */
const NOT_IMPLEMENTED = "not implemented in this adapter";

/** 本适配层实现了哪些 core 任务：行数据的 `implemented` 字段据此而来。 */
const IMPLEMENTED_TASKS = ["dream", "extractMemories", "autoSurfacing"] as const;

/**
 * 错误态会话的目录重解：`/memory unlock` 是崩溃遗留 `.lock` 的**唯一**人工入口，所以以配置错误
 * 启动的会话也必须能清锁 —— 不能因为启动时目录没解出来就死路一条。`rt.cwd` 在这条路径上通常
 * 有值（行 config 坏了不影响宿主的 working directory），所以重试很便宜。
 *
 * 安全边界不变：重试只用 `rt.config.memoryDir` 与 `rt.cwd`（两者都来自运行时，**不是**命令输入），
 * 删除仍然只有 `unlockMemory` 里的 `join(memoryDir, LOCK_FILE)` 一处，`--force` 仍然是必需。
 */
async function reResolveMemoryDir(rt: SessionMemoryRuntime): Promise<string | null> {
	if (rt.cwd === "") return null;
	try {
		return await resolveMemoryDir({ memoryDir: rt.config.memoryDir }, rt.cwd);
	} catch {
		return null;
	}
}

/**
 * 状态块。内容口径与 pi 的 `/memory` 一致（同一套 core 窗口核心 + 同一套模块行数据）。
 * 三个「不是状态、而是诊断」的早退路径都返回可读文本：
 * 命令本身是成功的，坏的是记忆层（pi 用 `notify(..., "info")` 表达同一件事）。
 */
export async function renderStatus(
	rt: SessionMemoryRuntime | undefined,
	warnings: string[],
	setKeys: readonly string[] = [],
): Promise<string> {
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

	// 行数据来自 core 的 `moduleStatusRows`（顺序恒为 dream → extractMemories → autoSurfacing）。
	// dsh 用自己的顺序：`autoSurfacing` 在前（它的 on/off 由本会话的宿主可用性决定，不是 cfg），
	// 其余任务按 core 的顺序跟在后面。未实现的任务只在用户真写了该键时才显示 —— 白名单是从
	// `DEFAULT_CONFIG` 派生的，未实现的任务能无声无息地通过校验却没有任何效果，用户写了
	// `dream: { model: "…" }` 时必须就地告诉他「配了但本适配层不跑」。本轮三个任务全部实现，
	// 所以这条分支今天为空，保留它是为了让「新增任务忘实现」这件事仍然可见。
	const rows = moduleStatusRows(rt.config, IMPLEMENTED_TASKS).filter(
		(row) => row.implemented || setKeys.includes(row.id),
	);
	const modules = [
		// autoSurfacing 的 on/off 不来自 core 的 `enabled`，而是本会话运行时的可用性判定
		//（`rt.surfacing.available` / `.reason` 来自启动期的 `resolveSurfacingAvailability`）。
		rt.surfacing.available
			? `autoSurfacing=on(${taskModel(rt.config, "autoSurfacing") ?? "no model"})`
			: `autoSurfacing=off(${rt.surfacing.reason ?? "disabled"})`,
		// 已实现的任务：`off` 时不显示模型（用户问「为什么没生效」时答案在开关上，不在模型上）。
		...rows
			.filter((row) => row.implemented)
			.map((row) => `${row.id}=${row.enabled ? `on(${row.model ?? "no model"})` : "off"}`),
		...rows.filter((row) => !row.implemented).map((row) => `${row.id}=${NOT_IMPLEMENTED}`),
	].join(", ");

	const lines = [
		// Dir 必须打印：memoryDir 是 per-harness 配置 —— 刻意没有跨 harness 的共享配置文件（pi 读自己的
		// memory.json，dsh 只读插件行 config）。
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
				const force = tokens.includes("--force");
				if (rt === undefined) {
					// 没有运行时：这个会话根本没挂上记忆层（子 agent、未 prepare、或插件未激活）。
					// 说清下一步，而不是只报一个状态。
					return {
						kind: "error",
						text:
							'Cannot unlock: no memory runtime for this session. Run /memory in the session that owns the memory directory; if the plugin never activated here, look for a "simple-memory" warning in the host log and fix the row config.',
					};
				}
				// 错误态不是死路：先拿 `rt.cwd` 重解一次目录（只有重解也失败才报错）。
				const memoryDir = rt.memoryDir ?? (await reResolveMemoryDir(rt));
				if (memoryDir === null) {
					return {
						kind: "error",
						text:
							"Cannot unlock: the memory directory is not resolved for this session and could not be re-resolved from its working directory. Fix the plugin row config (or start the session in a real project directory), then run /memory to confirm the Dir: line before retrying /memory unlock --force.",
					};
				}
				return await unlockMemory(memoryDir, force);
			}

			// `/memory` 兼作手动同步入口：报状态前先刷一次索引快照（refresh 永不抛错）。
			if (rt !== undefined) await deps.indexCache.refresh(rt);
			return {
				kind: "success",
				text: await renderStatus(rt, deps.warnings, deps.setKeys ?? []),
			};
		},
	};
}

/**
 * `/dream` 命令需要的依赖：运行时（store + config + memoryDir）、按运行时现造的端口、
 * 以及两条日志通道（dsh 的命令没有 `ui.notify`，宿主日志是唯一能报结果的地方）。
 */
export interface DreamCommandDeps {
	registry: { get(sessionId: string): SessionMemoryRuntime | undefined };
	headlessFor(rt: SessionMemoryRuntime): HeadlessAgentPort;
	warn(message: string, ...params: unknown[]): void;
	info(message: string, ...params: unknown[]): void;
}

/**
 * `/dream`：把整目录记忆交给一个 headless 子会话整理。
 *
 * 与 pi 的两处**刻意不同**，都写进 README：
 *
 * 1. **没有确认框**：dsh 的命令处理器拿不到任何交互通道（pi 的 `ctx.ui.confirm` 在 dsh 侧没有
 *    对应物），所以命令一进来就开始跑。代价是「误触发一次会真的改写记忆」，收益是不发明第二套
 *    「半交互」语义。dream 进入时会拍整目录快照（core 的 `lock: "logical+snapshot"`），那是
 *    用户唯一的回滚点。
 * 2. **不 await 整轮**：dream 的 timeout 是 600s，把它 await 进命令处理器等于让宿主等十分钟。
 *    所以命令立刻返回「已开始」，摘要与失败都写宿主日志（`logger.info` / `logger.warn`）。
 *
 * 缺模型 / 模型引用不像 `<provider>/<model>` 这类**能在发起前判定**的错误就地报在命令结果里：
 * 让用户看到「为什么没跑」，而不是一条稍后才出现在日志里的 `host-refused`。
 */
export function createDreamCommand(deps: DreamCommandDeps): CommandDefinitionLike {
	return {
		name: "dream",
		description: "Consolidate all memory files via a headless agent (starts immediately, runs in the background)",
		// **不传 `input`**：`/dream` 不收参数，而宿主的 `normalizeDefinition` 要求 `input.hint` **非空**
		//（`dsh-commands/lib/index.js:157-158`）。写一个 `hint: ""` 会让 `register()` 抛错，而 `apply`
		// 抛错 = cordis 回滚这个 bundle 的**全部**注册（索引段、`/memory`、`memory` 工具一起消失，
		// 用户看到的是「记忆插件根本没生效」）。一方插件 `/compact` 同样是不传 `input`。
		async handler(inv) {
			const rt = deps.registry.get(inv.agent.session.id);
			if (rt === undefined) {
				return {
					kind: "error",
					text:
						'Cannot dream: no memory runtime for this session. Run /memory in the session that owns the memory directory; if the plugin never activated here, look for a "simple-memory" warning in the host log and fix the row config.',
				};
			}
			if (rt.error !== null) {
				return { kind: "error", text: `Cannot dream: the memory layer is not initialized.\n${rt.error}` };
			}
			if (rt.store === null || rt.memoryDir === null) {
				// store-registry 保证 store === null 时 error 必非空；这里只是防御，不是可达路径。
				return { kind: "error", text: "Cannot dream: the memory layer is not initialized." };
			}
			const model = taskModel(rt.config, "dream");
			if (model === undefined) {
				return {
					kind: "error",
					text: "Cannot dream: no model configured — set dream.model (or defaults.model) in the plugin row config.",
				};
			}
			if (parseModelRef(model) === null) {
				return {
					kind: "error",
					text: `Cannot dream: dream model "${model}" must be "<provider>/<model>" — fix dream.model (or defaults.model) in the plugin row config.`,
				};
			}

			// `runTask` 是 async：缺模型这类错误不会在调用点同步抛，而是变成这条链的 rejection，
			// 由下面的失败分支写日志。整轮持锁与进入时的全目录快照都在 core 里。
			const run = runTask(
				TASKS.dream,
				{},
				{
					cfg: rt.config,
					cwd: rt.memoryDir,
					store: rt.store,
					ports: { headless: deps.headlessFor(rt) },
				},
			);
			void run.then(
				(summary) => deps.info("simple-memory: dream finished:\n%s", summary),
				(e: unknown) => deps.warn("simple-memory: dream failed: %s", errorMessage(e)),
			);
			return {
				kind: "success",
				text: "Dream started: consolidating memory files in the background. The summary is written to the host log.",
			};
		},
	};
}
