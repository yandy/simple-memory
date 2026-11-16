import { MEMORY_INDEX_SECTION } from "./index-source";

/**
 * pi 专属的注入**机制**。
 *
 * 「算出该注入什么字符串」是纯策略，住在 core 的 `injection.ts`；这里只剩一件必须认识 pi 的事：
 * 往 `event.systemPromptOptions.sections` 里写。
 * 注入时机、session 内的去重状态、以及为 prompt cache 服务的
 * 「索引按 session 冻结 + resume/fork 重放录制值」（`index-source.ts`）也都在 pi 这一侧。
 */

/**
 * 把冻结的索引值写进 `event.systemPromptOptions.sections`（就地修改这个可变对象）。
 *
 * **无条件设置**，哪怕值是 `""`：省略这个键等于告诉 pi「该 section 不应存在」，
 * `diffSystemPromptSections` 会生成 `{ memory_index: null }`，索引被从 system prompt 里
 * **静默删除**。「不想改」只能靠喂回逐字节相同的值实现。
 *
 * 只声明用得到的那一格（`sections`），不做「宿主没有 sections」的降级：`sections` 是
 * `NormalizedBuildSystemPromptOptions` 的必填字段（宿主 0.99.2 起就有），peer 下限 1.5.0 之后
 * 更不可能缺失 —— 缺了就是宿主违约，不该在每轮注入里静默咽成「整段替换 system prompt」。
 */
export function applyIndexSection(options: { sections: Record<string, string> }, value: string): void {
	options.sections[MEMORY_INDEX_SECTION] = value;
}
