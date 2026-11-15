import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * 宿主的思考/推理档位，**不透明字符串**：core 原样透传，不解释、不校验。
 * pi 的合法值是 `off|minimal|low|medium|high|xhigh`；dsh 的合法值按 provider 路线是数据
 * （DeepSeek 路线 `off|low|high|max`），所以 core 不能把它写成闭枚举。
 * 合法性由适配层在启动期用宿主的 resolve 接口校验。
 */
export type EffortLevel = string;
/** @deprecated pi 词汇，等价于 `EffortLevel`；保留是为了已发布适配层的类型重导出不破。 */
export type ThinkLevel = EffortLevel;

/** Session persistence configuration for headless memory-agent sub-sessions. */
export interface SessionPersistenceConfig {
	/** Enable disk persistence (default: false = in-memory). */
	enabled: boolean;
	/** Custom session directory. Defaults to `<project memory dir>/sessions/` (the resolved per-project directory under `memoryDir`). */
	sessionDir?: string;
}

/** Shared defaults that per-task configs inherit. Per-task fields override these. */
export interface DefaultsConfig {
	/** 共享模型：per-task 未指定时生效。**没有默认值** —— 必须由用户显式配置。 */
	model?: string;
	sessionPersistence?: SessionPersistenceConfig;
}

export interface AutoSurfacingConfig {
	enabled: boolean;
	model?: string;
	thinkLevel: EffortLevel;
	maxFiles: number;
	/**
	 * 单条 entry 注入正文的字节上限。
	 * v1 叫 `maxTopicBytes`（一个 topic 文件含多个 `##` 条目）；v2 一个 entry 一个文件，故改名。
	 * **旧键不再生效**（`deepMerge` 会把它挂到对象上，但没有任何代码读它）。
	 */
	maxEntryBytes: number;
	maxInjectionBytes: number;
}

export interface ExtractMemoriesConfig {
	/** 每轮自动提取。opt-in：默认 `false` —— 开启后每轮结束都会跑一次 headless 模型调用。 */
	enabled: boolean;
	model?: string;
	thinkLevel: EffortLevel;
	maxContextTokens: number;
	/** 渲染进 extract prompt 时，单条 tool_result 的字符上限。 */
	maxToolResultChars: number;
	/** 渲染进 extract prompt 时，单条 assistant 文本的字符上限。 */
	maxAssistantChars: number;
}

/**
 * 跨设备同步的配置子树。
 *
 * 这里**只**收两个宿主共有的语义（core 的配置契约不收单宿主策略键，同 `dream` 的触发策略归宿主）：
 * 凡是只有一侧能可靠挂上的接线细节（比如退出时再推一次）就**不设键**，而不是设一个「配了不生效」的键。
 *
 * 本节不触碰文件系统：core 只给默认值与合并语义，配置由适配层从自己的配置源读出后交给 `mergeConfig`。
 */
export interface SyncConfig {
	/**
	 * opt-in：自动往远端写数据必须由用户显式承担（同 `extractMemories`）。
	 *
	 * **必须是布尔值**，而且消费方一律按 `=== true` 判定：这是一道**同意边界**，不是类型洁癖。
	 * 配置从宿主的 JSON 直接合并进来（`mergeConfig` 不校验类型），而 `"false"` 这种字符串在 JS 里
	 * 是真值 —— 按真值判定就会把用户明写的「关」读成「开」，记忆继续往远端推，而校验出口还报「没问题」。
	 * 不为 `true` 时其余键一律不校验（见 `syncConfigErrors`）。
	 */
	enabled: boolean;
	/** git 远端 URL：只供首次初始化用；初始化之后的真相来源是暂存 clone 的 origin。 */
	remote: string;
	/** 远端的跟踪分支名。 */
	branch: string;
	/** 会话开始时自动拉取远端变更。同样是 `=== true` 才算开（见 `enabled`）。 */
	pullOnStart: boolean;
	/** 写入后去抖自动发布。同样是 `=== true` 才算开（见 `enabled`）。 */
	pushOnWrite: boolean;
	/**
	 * 写入触发的静默期：静默期内的多条写入合并成一次推送（一轮 dream 写十几个文件 → 一次推送）。
	 * 它是**两个宿主共有**的语义（两边的写触发都按它去抖），所以属于 core；退出兜底那种只有一侧
	 * 能可靠挂上的接线细节则不设键。
	 */
	pushDebounceMs: number;
	/**
	 * 自动路径（会话开始的拉取、退出兜底的推）每次 git 子进程的时间上限。
	 * 与 `timeoutMs` 分两档是刻意的：自动路径被 await 在会话启动路径上，离线 / 连不上远端时若按
	 * 手动档计时，每开一次会话都要白等满 20s（一轮至少两次子进程）。自动档取短。
	 */
	autoTimeoutMs: number;
	/** 手动命令（用户正在等结果）每次 git 子进程的时间上限，比自动档宽。 */
	timeoutMs: number;
}

export interface MemoryConfig {
	/** Shared defaults for model and sessionPersistence. Per-task configs override. */
	defaults?: DefaultsConfig;
	memoryDir: string;
	/** Write capacity: max entries in MEMORY.md index. */
	memIndexMaxLines: number;
	/** Write capacity: max bytes of serialized MEMORY.md index. */
	memIndexMaxBytes: number;
	/**
	 * 注入截断：`memory_index` section 最多带多少**行**索引（默认 50）。
	 * 窗口取索引**最新**的一段（索引是纯时间序，见 `truncateIndexForInjection`），所以被丢掉的
	 * 永远是**最旧**的记忆。写入口径（`memIndexMaxLines`）刻意**不随**它收紧：索引里能留更多条目，
	 * 超窗口的部分只靠 auto-surfacing / `memory` 工具检索，不进 system prompt。
	 */
	memIndexInjectMaxLines: number;
	/** 注入截断：`memory_index` section 最多带多少**字节**（默认 16384 ≈ 50 条中文索引行的实测上界）。 */
	memIndexInjectMaxBytes: number;
	/**
	 * 两级锁的参数。结构与 `StoreConfig["lock"]` 逐字一致，因此可以原样传给
	 * `new MemoryStore({ ..., lock: config.lock })`。
	 * **没有** ttl / 心跳 / 接管字段：跨进程 `.lock` 永远只持毫秒且永不自动回收。
	 */
	lock: { timeoutMs: number; snapshotKeep: number };
	/**
	 * dream 任务本身：模型、思考档位、会话落盘。
	 * 触发它的**策略**（隔多少个会话 / 多少小时后提醒）是宿主知识，**不**在这里 —— 需要它的适配层
	 * 自己持有（pi 的 `PiHostConfig`），dsh 没有这套策略。
	 */
	dream: {
		model?: string;
		thinkLevel: EffortLevel;
		sessionPersistence?: SessionPersistenceConfig;
	};
	sessionSearch: { maxSessions: number; maxMatches: number };
	autoSurfacing: AutoSurfacingConfig & {
		sessionPersistence?: SessionPersistenceConfig;
	};
	extractMemories: ExtractMemoriesConfig & {
		sessionPersistence?: SessionPersistenceConfig;
	};
	/**
	 * 跨设备同步。校验出口是 `syncConfigErrors`，**非** `modelConfigErrors`：后者被消费成
	 * 「整个记忆层不可用」，少写一个远端 URL 不该有这个代价（同设计里的降级铁律）。
	 */
	sync: SyncConfig;
}

export const DEFAULT_CONFIG: MemoryConfig = {
	// headless 子会话默认只在内存里跑：extract / dream / 侧查询都不该往用户的 sessions 目录里落盘。
	// **没有模型默认值**：model 必须由用户显式配置（defaults.model 或 per-task），否则会话启动即报错。
	defaults: { sessionPersistence: { enabled: false } },
	memoryDir: defaultMemoryRoot(),
	memIndexMaxLines: 200,
	memIndexMaxBytes: 25600,
	// 注入口径独立于写入口径（v2.3.0 起）：窗口只取索引**最新**的 50 行。
	// 16384 B ≈ 50 条中文索引行的实测上界（本机样本 221–321 B/行），保证「行数」才是真正生效的上限。
	memIndexInjectMaxLines: 50,
	memIndexInjectMaxBytes: 16384,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	dream: { thinkLevel: "high" },
	sessionSearch: { maxSessions: 10, maxMatches: 5 },
	autoSurfacing: {
		enabled: true,
		thinkLevel: "off",
		maxFiles: 3,
		maxEntryBytes: 3072,
		maxInjectionBytes: 10240,
	},
	extractMemories: {
		// 每轮结束都要跑一次 headless 模型调用，代价必须由用户显式承担：默认关闭。
		enabled: false,
		thinkLevel: "high",
		maxContextTokens: 2000,
		maxToolResultChars: 500,
		maxAssistantChars: 2000,
	},
	sync: {
		// 自动往远端写数据必须由用户显式承担：默认关闭（同 extractMemories）。
		enabled: false,
		// 空 remote 只在 enabled 为真时才算错（见 syncConfigErrors）：默认关闭时它只是占位。
		remote: "",
		branch: "main",
		pullOnStart: true,
		pushOnWrite: true,
		// 一轮 dream 写十几个文件 → 去抖后只推送一次。
		pushDebounceMs: 5000,
		// 自动档 5s / 手动档 20s：自动路径在会话启动上被 await，不能让离线把每次启动拖满。
		autoTimeoutMs: 5000,
		timeoutMs: 20000,
	},
};

/** 需要显式模型的子任务。顺序固定：dream → extractMemories → autoSurfacing（校验信息按此顺序输出）。 */
export type ModelTask = "dream" | "extractMemories" | "autoSurfacing";

/** 某任务的模型值：per-task 优先，其次共享的 defaults.model。宿主的状态命令也用它。 */
export function taskModel(cfg: MemoryConfig, task: ModelTask): string | undefined {
	// `?.`：`deepMerge` 把用户写的 `"dream": null` 原样带进来 —— 那时应该报「没有模型」，
	// 而不是抛 TypeError，把启动校验变成一句看不懂的初始化失败。
	return cfg[task]?.model ?? cfg.defaults?.model;
}

/**
 * 会执行的任务及其模型值。
 *
 * `tasks`：适配层声明自己实现了哪些任务（如 dsh 本轮不实现 dream，就传 `["autoSurfacing"]`）。
 * 省略 = 既有行为不变（dream 恒在执行集合内，另两个按 `enabled`）；给定则**只**考虑这些任务，
 * dream 不再被强制加入，另两个仍按 `enabled` 过滤。顺序与调用方列举顺序无关，恒为
 * dream → extractMemories → autoSurfacing。
 *
 * 缺省路径上**不是**逐字不变，唯一的例外（实现期已裁定）：`deepMerge` 会把用户写的
 * `"extractMemories": null` / `"autoSurfacing": null` 原样带进来，旧实现直接读 `.enabled` 会抛
 * `TypeError`，现在按 falsy 跳过该任务。这与 `taskModel` 对 `"dream": null` 的既有防御同一取向：
 * 配置读不懂时应给出「该任务关闭 / 没有模型」这种可读结果，而不是把启动校验变成一句看不懂的
 * 初始化失败。
 */
export function requiredModels(
	cfg: MemoryConfig,
	tasks?: readonly ModelTask[],
): Array<{ task: ModelTask; value: string | undefined }> {
	const order: readonly ModelTask[] = ["dream", "extractMemories", "autoSurfacing"];
	const out: Array<{ task: ModelTask; value: string | undefined }> = [];
	for (const task of order) {
		if (tasks !== undefined && !tasks.includes(task)) continue;
		// dream 没有包级开关：进了候选即在执行集合内（省略 `tasks` 时它恒是候选）。另两个看 `enabled`。
		// 这里用 `?.`，与 `taskModel` 同理：`deepMerge` 会把用户写的 `"extractMemories": null` 原样带进来。
		if (task === "dream" || cfg[task]?.enabled) out.push({ task, value: taskModel(cfg, task) });
	}
	return out;
}

/**
 * 启动校验：空数组 = 通过。
 * `resolve` 由调用方注入（生产时是 `(v) => resolveModel(v, ctx.modelRegistry) !== undefined`），
 * 因此本函数不依赖 SDK 的 registry 类型，可用假 resolve 单测。
 * `tasks`：原样透传给 `requiredModels`（只校验列出的任务；`null` 子树跳过那个例外同上）。
 */
export function modelConfigErrors(
	cfg: MemoryConfig,
	resolve: (value: string) => boolean,
	tasks?: readonly ModelTask[],
): string[] {
	const errors: string[] = [];
	for (const { task, value } of requiredModels(cfg, tasks)) {
		if (value === undefined) {
			errors.push(`no model for ${task} — set "${task}.model" or "defaults.model" in memory.json`);
		} else if (!resolve(value)) {
			errors.push(`model "${value}" for ${task} is not resolvable (unknown id or missing credentials)`);
		}
	}
	return errors;
}

/**
 * 同步配置的校验出口，**非致命**（形状仿 `modelConfigErrors`，但刻意是另一个函数）。
 *
 * 为什么不并进 `modelConfigErrors`：那条路的唯一消费者会把配置错误当成「整个记忆层不可用」——
 * 不解析目录、不建 store、不注册工具、没有索引段。少写一个远端 URL 不该让用户丢掉全部记忆功能，
 * 所以收到非空列表的适配层只需把同步当成未启用并报出来，其余记忆功能照常。
 *
 * 三个布尔键**无条件**校验类型（它们就是开关本身，包括 `enabled`）；其余键只在 `enabled === true`
 * 时才检查：关掉的开关不该逼用户先去修它管辖的键。
 * 顺序固定：enabled → pullOnStart → pushOnWrite → remote → branch → pushDebounceMs → autoTimeoutMs
 * → timeoutMs；每条消息都点名键，便于直接改配置。
 * `options.initialized === true` 时本地 origin 已是远端真相来源，因此只放宽 remote 为空这一条，
 * 其余键与同意边界的校验完全不变。
 */
export function syncConfigErrors(cfg: MemoryConfig, options: { initialized?: boolean } = {}): string[] {
	const sync = cfg.sync;
	// 读不懂的子树（`deepMerge` 会把用户写的 `"sync": null`、甚至一个字符串原样带进来）按「未启用」
	// 处理，一条都不报：没有键可校验，也没有开关可开。不抛 TypeError 是底线。
	if (typeof sync !== "object" || sync === null) return [];

	const errors: string[] = [];
	// 三个布尔键按**类型**校验，不按真值：`"enabled": "false"` 在 JS 里是真值，
	// 只判真值的话用户明写的「关」会被当成「开」，而这个函数还返回空数组（= 配置没问题）。
	// 自动往远端推数据必须由用户显式承担，所以「不是明确的 true」一律按关处理并报出来。
	for (const key of ["enabled", "pullOnStart", "pushOnWrite"] as const) {
		const value: unknown = sync[key];
		if (typeof value !== "boolean") {
			const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
			errors.push(`sync is disabled because "sync.${key}" must be true or false (got ${shown})`);
		}
	}
	// 不是明确的 true 就到此为止：开关没开，它管辖的键不必逼用户先修（与消费方 `=== true` 同口径）。
	if (sync.enabled !== true) return errors;

	// 非字符串也算空：`mergeConfig` 不校验类型，这里一 `.trim()` 就把非致命校验变成一次崩溃。
	if (options.initialized !== true && (typeof sync.remote !== "string" || sync.remote.trim() === "")) {
		errors.push('sync is enabled but "sync.remote" is empty — set "sync.remote" in memory.json or unset "sync.enabled"');
	}
	if (typeof sync.branch !== "string" || sync.branch.trim() === "") {
		errors.push('sync is enabled but "sync.branch" is empty — set a branch name or unset "sync.enabled"');
	}
	for (const key of ["pushDebounceMs", "autoTimeoutMs", "timeoutMs"] as const) {
		const value: unknown = sync[key];
		// 类型也在这里查：`mergeConfig` 不校验类型，手写的配置里 `"5000"` 会一路传到定时器 /
		// 子进程的 budget 上，那时是一句看不懂的失败而不是一条可读错误。
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
			errors.push(`sync is enabled but "sync.${key}" must be a positive number of milliseconds (got ${shown})`);
		}
	}
	return errors;
}

/** 已通过启动校验的模型值；缺失时抛错（真正的守卫在适配层的会话启动路径上，这里是防御）。 */
export function requiredModel(cfg: MemoryConfig, task: ModelTask): string {
	const value = taskModel(cfg, task);
	if (value === undefined) {
		throw new Error(`no model for ${task} — set "${task}.model" or "defaults.model" in memory.json`);
	}
	return value;
}

export function expandTilde(p: string, platform: NodeJS.Platform = process.platform): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	// `~\` 只在 Windows 上展开：POSIX 上 `~\foo` 是以 `~` 开头的合法文件名，
	// 改写它会破坏用户真实的路径。
	if (platform === "win32" && p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

function deepMerge<T>(base: T, over: Partial<T>): T {
	// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
	const out: any = { ...base };
	for (const k of Object.keys(over) as (keyof T)[]) {
		// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
		const ov = over[k] as any;
		// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
		if (ov && typeof ov === "object" && !Array.isArray(ov) && typeof (out as any)[k] === "object") {
			// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
			(out as any)[k] = deepMerge((out as any)[k], ov);
		} else if (ov !== undefined) {
			// biome-ignore lint/suspicious/noExplicitAny: generic deep merge
			(out as any)[k] = ov;
		}
	}
	return out;
}

/**
 * 把 `overlay` 深合并到 `base` 上：`undefined` 跳过、plain object 递归、数组整体替换、`null` 子树原样带入。
 * 返回**新对象**，不改 `base` —— 这是合并语义的**唯一**一份实现：适配层读文件、读行 config、
 * 读任何宿主侧的 overlay，都把它交给这里。core 不读任何配置文件。
 */
export function mergeConfig(base: MemoryConfig, overlay: unknown): MemoryConfig {
	return deepMerge(base, (overlay ?? {}) as Partial<MemoryConfig>);
}

/**
 * 共享数据根。
 *
 * 这是「跳 harness 共享同一份记忆」的地基：任何宿主都必须独立算出**同一个**目录，所以规则里
 * 既不能出现宿主名，也不能有平台分支 —— 所有平台走同一条 XDG 规则（不为 darwin/win32 开例外）。
 *
 * `XDG_DATA_HOME` 是相对路径时按规范忽略：相对根会让「哪个项目用哪个目录」取决于 cwd，共享就失效了。
 * `env` 与 `home` 做成参数是为了可单测（沿用 `store/paths.ts` 的注入缝风格）。
 */
export function defaultMemoryRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const xdg = env.XDG_DATA_HOME?.trim();
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
	return join(base, "simple-memory");
}
