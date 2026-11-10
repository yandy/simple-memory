import { extractMemories } from "./extract.js";
import { autoSurfacing } from "./surfacing.js";

/**
 * 任务注册表：描述符的唯一声明处。
 *
 * 这一层单独成文件是为了让依赖方向单向：`tasks.ts → 描述符 → task.ts`。注册表原本住在 `task.ts`
 * 里，而描述符要从 `task.ts` 拿 `runTask` / `MemoryTask`，于是构成模块环 —— 当时只靠「没人
 * 在模块求值时读 `runTask`」才没炸（TDZ 侥幸）。把注册表挪出来后环消失，描述符里出现顶层
 * 使用也不会在 import 时崩。
 *
 * Task 4 落 autoSurfacing、Task 5 落 extractMemories；Task 6 在 dream 落地后把它扩成
 * `Record<ModelTask, MemoryTask<any, any>>`，中间任务不得为缺失条目造假对象。
 */
export const TASKS = { autoSurfacing, extractMemories } as const;
