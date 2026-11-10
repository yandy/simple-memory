import { taskModel } from "../config.js";
import type { MemoryConfig, ModelTask } from "../config.js";

/**
 * 一行模块状态：core 只给**数据**，不给文案。怎么措辞、按什么顺序展示，是适配层的事。
 */
export interface ModuleStatusRow {
	id: ModelTask;
	/** 适配层是否声明实现了该任务（`tasks` 参数里有没有它）。 */
	implemented: boolean;
	/** 该任务是否可用：`dream` 无包级开关恒 `true`，其余取各自的 `enabled`。 */
	enabled: boolean;
	/** 生效模型值（per-task 优先，其次 defaults.model）；仅当 `enabled && implemented` 时给出。 */
	model?: string;
}

/** 顺序恒为 dream → extractMemories → autoSurfacing（与 `requiredModels` 同一口径）。 */
const ORDER: readonly ModelTask[] = ["dream", "extractMemories", "autoSurfacing"];

/**
 * 每个任务的模块状态行数据。适配层声明自己实现了哪些任务（`tasks`），core 补上
 * `implemented` / `enabled` / `model` 三样事实；展示顺序与措辞仍是适配层自己的事。
 */
export function moduleStatusRows(cfg: MemoryConfig, tasks: readonly ModelTask[]): ModuleStatusRow[] {
	return ORDER.map((id) => {
		const implemented = tasks.includes(id);
		// dream 没有包级开关：恒启用。其余取各自的 `enabled`（`deepMerge` 可能把用户写的
		// `null` 子树原样带进来，`?.` 让那类配置按「关闭」读，而不是抛 TypeError）。
		const enabled = id === "dream" ? true : cfg[id]?.enabled === true;
		const row: ModuleStatusRow = { id, implemented, enabled };
		if (enabled && implemented) {
			const model = taskModel(cfg, id);
			if (model !== undefined) row.model = model;
		}
		return row;
	});
}
