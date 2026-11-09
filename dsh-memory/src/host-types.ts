/**
 * 宿主类型的唯一入口。
 *
 * 本文件是 `dsh-memory` 里**唯一**允许出现 `@deepseek-ai/*` 说明符的地方，且只允许 `import type`
 * —— tsc 会把它整段擦除，所以 `dist` 目录下所有 `.js` 都零宿主命中（`npm run build` 的验收点）。
 * 运行时能力一律经 `inject` 进来的 `ctx` 服务拿，不 import 宿主的任何值。
 *
 * 这里再导出两套东西：
 *
 * 1. **接线边界的宿主类型词汇**：`Context`（`apply` 的入参）、`HostPromptSection`（section 字面量）、
 *    `HostToolDefinition` / `HostPreStepDecision`（index.ts 里两处收窄的目标类型），以及
 *    `HostAgent` / `HostCommandDefinition`（边界文档；index.ts 靠上下文类型拿到它们，未显式命名）。
 *    其余模块一律用本地结构化接缝（`AgentLike` / `LlmLike` / `SessionQueryLike` / `ToolDefinitionLike` …），
 *    这样它们脱离宿主也能单测：宿主类型只在接线边界出现一次。
 * 2. **`inject` 里那七个服务在宿主侧的真身**。导出它们不只是为了文档化边界：宿主是用
 *    `declare module '@deepseek-ai/cordis' { interface Context { … } }` 的**增广**把服务挂到 `Context`
 *    上的，只有把对应包的类型拉进编译单元，`ctx.systemPrompt` / `ctx.tools` / `ctx.llm` … 才存在。
 *    `@deepseek-ai/dsh-agent` 同时增广了 `Events`（`agent/created` / `agent/disposed` / `agent/pre-step`）
 *    与 `AssembleContext.agent`（section 的 `text` 回调靠它拿当前会话）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { CommandDefinition, CommandRuntime } from "@deepseek-ai/dsh-commands";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { PromptSection, SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolsService } from "@deepseek-ai/dsh-tools";
import type { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";

export type { Context };

/** 宿主 `dsh-agent` 的活 agent 句柄：`session`（含 `header.origin` 子 agent 判据）+ `ctx`（agent 作用域）。 */
export type { Agent as HostAgent };

/** system prompt 的一个 section 贡献。`text` 回调收到宿主的 `AssembleContext`（含 `agent?`）。 */
export type { PromptSection as HostPromptSection };

/** 宿主真正的工具定义。我们的替身比它松（`parameters` / `output.schema` 是 `unknown`），见 index.ts 的注册处。 */
export type { ToolDefinition as HostToolDefinition };

/** 宿主真正的命令定义。我们的 `CommandDefinitionLike` 结构化可赋值给它，注册处无需 cast。 */
export type { CommandDefinition as HostCommandDefinition };

/** `agent/pre-step` waterfall 的裁决：`{kind:"reject"}` 或 `{kind:"enter", messages: UserMessage[]}`。 */
export type { PreStepDecision as HostPreStepDecision };

/** `inject` 声明的七个服务在宿主侧的类型（顺序与 `inject` 一致，便于逐条对照）。 */
export type { ToolsService as HostTools };
export type { SystemPrompt as HostSystemPrompt };
export type { LlmRuntime as HostLlm };
export type { CommandRuntime as HostCommands };
export type { WorkingDirectoryService as HostWorkingDirectory };
export type { SessionQueryEngine as HostSessionQuery };
/** 第七个服务 `logger` 由 cordis 自己声明在 `Context` 上（`LoggerService`），不需要增广。 */
