/**
 * 宿主类型的唯一入口。
 *
 * 本文件是 `dsh-memory` 里**唯一**允许出现 `@deepseek-ai/*` 说明符的地方，且只允许 `import type`
 * —— tsc 会把它整段擦除，所以 `dist` 目录下所有 `.js` 都零宿主命中（`npm run build` 的验收点）。
 * 运行时能力一律经 `inject` 进来的 `ctx` 服务拿，不 import 宿主的任何值。
 */
import type { Context } from "@deepseek-ai/cordis";
// …按 Task 6–16 的实际需要逐个加：Agent（dsh-agent）、ToolDefinition（dsh-tools）、
// PromptSection（dsh-system-prompt）、UserMessage / GenerateOptions / StreamChunk（dsh-llm）、
// Session / SessionHeader（dsh-session）、CommandDefinition（dsh-commands）
export type { Context };
