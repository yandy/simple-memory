import type { ModelTask } from "../config.js";
import { dream } from "./dream.js";
import { extractMemories } from "./extract.js";
import { autoSurfacing } from "./surfacing.js";
import type { MemoryTask } from "./task.js";

/**
 * 任务注册表：描述符的唯一声明处。
 *
 * 这一层单独成文件是为了让依赖方向单向：`tasks.ts → 描述符 → task.ts`。注册表原本住在 `task.ts`
 * 里，而描述符要从 `task.ts` 拿 `runTask` / `MemoryTask`，于是构成模块环 —— 当时只靠「没人
 * 在模块求值时读 `runTask`」才没炸（TDZ 侥幸）。把注册表挪出来后环消失，描述符里出现顶层
 * 使用也不会在 import 时崩。
 *
 * `satisfies Record<ModelTask, MemoryTask<any, any>>` 让注册表**可证明完整**：漏一个描述符、
 * 或键名写错，这里直接编译报错，而不是等调用方在运行时撞 `TASKS.dream === undefined`。
 */
export const TASKS = { autoSurfacing, extractMemories, dream } as const satisfies Record<
	ModelTask,
	// biome-ignore lint/suspicious/noExplicitAny: registry completeness needs per-descriptor type erasure
	MemoryTask<any, any>
>;
