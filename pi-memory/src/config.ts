import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, defaultMemoryRoot, expandTilde, mergeConfig, type MemoryConfig } from "@yandy0725/memory-core";

/**
 * pi 侧的配置层负责两件事：把「配置文件在哪」这条宿主知识组装成文件列表，然后**自己读**它们。
 *
 * 默认值、deep-merge 语义、`~` 展开、模型校验（`modelConfigErrors` / `requiredModel` / `taskModel`）
 * 全部在 `@yandy0725/memory-core`，这里原样重导出，使 `index.ts` 与其余 pi 模块的 import 面不变。
 * core 不认识任何宿主的配置文件路径（也不读文件）：读不读、读哪几个，由适配层决定。
 */
export {
	DEFAULT_CONFIG,
	defaultMemoryRoot,
	expandTilde,
	modelConfigErrors,
	requiredModel,
	requiredModels,
	taskModel,
} from "@yandy0725/memory-core";
export type {
	AutoSurfacingConfig,
	DefaultsConfig,
	ExtractMemoriesConfig,
	MemoryConfig,
	ModelTask,
	SessionPersistenceConfig,
	ThinkLevel,
} from "@yandy0725/memory-core";

/**
 * pi 的**宿主扩展位**：不属于 core 的 `MemoryConfig`。
 *
 * dream 的触发策略（隔多少个会话 / 多少小时提醒）只有带 UI、有 `/dream` 命令的宿主才有意义，
 * core 不知道也不该知道。字段名与默认值属于**用户契约**：它们仍写在 `memory.json` 的 `dream`
 * 子树下（`{ "dream": { "nudgeAfterSessions": 3 } }`），值原样搬自 core 1.x 的 `DEFAULT_CONFIG.dream`。
 */
export interface PiHostConfig {
	nudgeAfterSessions: number;
	nudgeAfterHours: number;
}

/** 原样搬自 core 1.x 的 `DEFAULT_CONFIG.dream`：5 / 24 是用户契约，不得变化。 */
export const PI_HOST_DEFAULTS: PiHostConfig = { nudgeAfterSessions: 5, nudgeAfterHours: 24 };

/** `loadConfig` 的结果：core 的共享配置 + pi 自己的宿主配置，**同一遍**文件读取得出。 */
export interface LoadedConfig {
	config: MemoryConfig;
	host: PiHostConfig;
}

/**
 * 从**已解析的** `memory.json` 对象（`{ dream?: {...} }` 形状）读出宿主配置。
 *
 * 白名单只认两个键，且只接受 `typeof === "number" && Number.isFinite(v)` 的值：字符串、`null`、
 * `NaN` / `Infinity`（后两个在 JSON 里写不出来，但这里的入参不只来自 `JSON.parse`）都落回
 * `PI_HOST_DEFAULTS`。**任何垃圾输入都不抛错** —— 配置文件是用户写的，读不懂时给默认值远比
 * 把一个启动错误糊在用户脸上有用。
 */
export function readPiHostConfig(overlay: unknown): PiHostConfig {
	const dream = (overlay as { dream?: unknown } | null | undefined)?.dream;
	const field = dream && typeof dream === "object" ? (dream as Record<string, unknown>) : {};
	const read = (key: keyof PiHostConfig): number => {
		const value = field[key];
		return typeof value === "number" && Number.isFinite(value) ? value : PI_HOST_DEFAULTS[key];
	};
	return { nudgeAfterSessions: read("nudgeAfterSessions"), nudgeAfterHours: read("nudgeAfterHours") };
}

export interface LoadConfigContext {
	cwd: string;
	isProjectTrusted(): boolean;
	/** 测试注入缝：全局配置目录。默认 `getAgentDir()`。 */
	_globalDir?: string;
	/** 测试注入缝：项目内配置目录名。默认 pi 的 `CONFIG_DIR_NAME`。 */
	_configDirName?: string;
	/** 测试注入缝：命名/展开规则跟随的平台。默认 `process.platform`。 */
	_platform?: NodeJS.Platform;
}

/**
 * pi 读哪些配置文件，按合并优先级排列：全局 `~/.pi/agent/memory.json` 在前，
 * 项目级 `<cwd>/.pi/memory.json` 在后（后者覆盖前者）。
 *
 * 项目级配置**只在项目受信任时**才读：不受信任的项目不能靠一份跟仓库一起 clone 下来的
 * `memory.json` 改写记忆目录或模型选择。
 */
export function configFiles(ctx: LoadConfigContext): string[] {
	const agentDir = ctx._globalDir ?? getAgentDir();
	const configDirName = ctx._configDirName ?? CONFIG_DIR_NAME;
	const files = [join(agentDir, "memory.json")];
	if (ctx.isProjectTrusted()) {
		files.push(join(ctx.cwd, configDirName, "memory.json"));
	}
	return files;
}

/** 缺文件、不可读、坏 JSON 一律返回 {} —— 与 core 1.x 的 readJsonSafe 同语义。 */
async function readJsonFile(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return {};
	}
}

/**
 * 合并顺序即 `configFiles` 的顺序；`~` 展开在最后一步，`_platform` 只影响展开规则
 * （`~\` 只在 win32 展开，POSIX 上它是合法文件名）。
 *
 * 起始值刻意用 `{ ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() }` 的浅展开：嵌套子树在 overlay
 * 未触及处仍与 `DEFAULT_CONFIG` 共享引用（`mergeConfig` 只对真正被覆盖的子树建新对象）——
 * 这正是 1.x 的语义，不要改成深拷贝。
 *
 * 宿主配置（`host`）与 `config` 从**同一份**解析结果得出（每个文件只读一次），合并顺序也一致：
 * 全局先、可信项目后，后者逐键覆盖前者。
 */
export async function loadConfig(ctx: LoadConfigContext): Promise<LoadedConfig> {
	let cfg: MemoryConfig = { ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() };
	// 宿主配置的 `dream` 子树累积器：两个键都是标量，所以逐文件浅合并与深合并等价
	//（`mergeConfig` 的 deepMerge 只对 plain object 递归，标量一律整体覆盖），
	// 也就不需要把 core 内部的 deepMerge 再导出一份来。
	let hostDream: Record<string, unknown> = {};
	for (const file of configFiles(ctx)) {
		const parsed = await readJsonFile(file);
		cfg = mergeConfig(cfg, parsed);
		// `mergeConfig` 会把用户写的 `"dream": null` 原样带进来；这里同样只在它确实是对象时才累积。
		const dream = (parsed as { dream?: unknown } | null)?.dream;
		if (dream && typeof dream === "object") hostDream = { ...hostDream, ...(dream as Record<string, unknown>) };
	}
	cfg.memoryDir = expandTilde(cfg.memoryDir, ctx._platform ?? process.platform);
	return { config: cfg, host: readPiHostConfig({ dream: hostDream }) };
}

/**
 * 2.x 的数据根（`~/.pi/memory`）。只用于迁移提示 —— core 对 `.pi` 一无所知，
 * 所以这条宿主知识留在 pi 这一侧（见 `legacy-hint.ts`）。
 */
export function legacyMemoryRoot(home: string = homedir()): string {
	return join(home, CONFIG_DIR_NAME, "memory");
}
