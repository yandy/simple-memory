import {
	MAIN_AGENT_ACTIONS,
	MEMORY_TOOL_DESCRIPTION,
	MEMORY_TOOL_NAME,
	createMemoryActionHandler,
	memoryToolSchema,
} from "@yandy0725/memory-core";
import type { SessionMemoryRuntime } from "./store-registry.js";

/**
 * dsh 侧 `memory` 工具的返回值 schema。
 *
 * **只有 `content`**：core 的 handler 返回 `{ text, details }`，而 `details` 里常规携带
 * `capacityWarning: string | undefined` —— dsh 的 `snapshotJsonValue` 拒绝值里**任何位置**的
 * `undefined`（顶层条件展开不够，`add`/`replace` 会 100% 变成 `ToolOutputError`）。dsh 侧
 * `details` 又没有消费者（Web 客户端忽略 `presentCall` / `presentResult`），所以直接不放。
 */
export const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["content"],
	properties: { content: { type: "string" } },
} as const;

export interface MemoryToolDeps {
	/** 每次**成功**写 action 之后回调（core 的 `MemoryHandlerOptions.onWrite` 原样透传）。 */
	onWrite?(info: { action: string; name?: string }): void;
	/** `search scope=sessions` 的宿主实现：返回已格式化好的文本。 */
	searchSessions(cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }): Promise<string>;
}

/** 手搓的最小 `ToolDefinition`：刻意不经宿主的 `defineTool`，零宿主 import。 */
export interface ToolDefinitionLike {
	name: string;
	description: string;
	parameters: unknown;
	output: { schema: unknown; render(args: unknown, value: { content: string }): Array<{ type: "text"; text: string }> };
	execute(args: unknown, exec: { signal?: AbortSignal }): Promise<{ content: string }>;
	isConcurrencySafe(args: { action?: string } | undefined): boolean;
}

/**
 * 把 core 的中立工具契约包成 dsh 的 `ToolDefinition` 字面量。
 *
 * - `parameters` 直接透传 `memoryToolSchema(MAIN_AGENT_ACTIONS)`：`ctx.tools.register()` 不校验
 *   parameters，宿主把它原样投给模型（`input_schema`），所以模型看到的线格式与 pi 逐字相同。
 * - 失败靠 handler **抛错**（missing name / unknown action / store unavailable），与 dsh 的
 *   throw → `isError: true` 语义天然对齐，绝不 catch-and-convert。
 * - `isConcurrencySafe` 是总函数：宿主调度器可能回放或塞进畸形 args（含 `null` / `{}`），
 *   只对读 action（list / search）返回 true。
 */
export function createMemoryTool(rt: SessionMemoryRuntime, deps: MemoryToolDeps): ToolDefinitionLike {
	const handler = createMemoryActionHandler(
		{
			getStore: () => rt.store,
			getConfig: () => rt.config,
			getUnavailableMessage: () => rt.error,
			searchSessions: deps.searchSessions,
			cwd: () => rt.cwd,
		},
		{ actions: MAIN_AGENT_ACTIONS, onWrite: deps.onWrite },
	);

	return {
		name: MEMORY_TOOL_NAME,
		description: MEMORY_TOOL_DESCRIPTION,
		parameters: memoryToolSchema(MAIN_AGENT_ACTIONS),
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: "text", text: value.content }],
		},
		async execute(args, _exec) {
			// `_exec.signal` 仅为宿主接口兼容而被接受：core 的 handler 返回
			// `(params: unknown) => Promise<...>`，没有 abort 入参，取消在本层无法落地；
			// 要真正支持取消得先改 core 的端口签名（它没有取消入参），适配层自己做不到。
			const r = await handler(args);
			// 只保留 content：`r.details` 含 `capacityWarning: undefined`，进 output 会触发
			// 宿主的 `snapshotJsonValue` 抛 `ToolOutputError`（见 OUTPUT_SCHEMA 上方的注释）。
			return { content: r.text };
		},
		isConcurrencySafe: (args) => args?.action === "list" || args?.action === "search",
	};
}
