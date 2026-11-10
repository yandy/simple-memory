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
 */
export async function loadConfig(ctx: LoadConfigContext): Promise<MemoryConfig> {
	let cfg: MemoryConfig = { ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() };
	for (const file of configFiles(ctx)) cfg = mergeConfig(cfg, await readJsonFile(file));
	cfg.memoryDir = expandTilde(cfg.memoryDir, ctx._platform ?? process.platform);
	return cfg;
}

/**
 * 2.x 的数据根（`~/.pi/memory`）。只用于迁移提示 —— core 对 `.pi` 一无所知，
 * 所以这条宿主知识留在 pi 这一侧（见 `legacy-hint.ts`）。
 */
export function legacyMemoryRoot(home: string = homedir()): string {
	return join(home, CONFIG_DIR_NAME, "memory");
}
