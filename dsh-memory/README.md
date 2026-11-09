# dsh-memory

Memory plugin for [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh) (a cordis-based harness).

**Status: not implemented.** This directory holds a `package.json` and this note. There is no code, no
test, and no dependency yet — it exists so the adapter's home is fixed in the repository layout, and so
`memory-core`'s port surface has a second consumer to design against.

## What it will own

The same split as `pi-memory`: everything whose meaning differs between harnesses stays here, everything
whose meaning is identical lives in `@yandy0725/memory-core`.

| Concern | Where |
|---|---|
| Disk format, `MemoryStore`, locks, snapshots, paths, injection truncation policy, prompt text, dream / extract / side-query orchestration, `memory` tool JSON Schema + handler | `memory-core` |
| When and how a section or context is injected, tool registration and rendering, model resolution, session search, commands | this package |

## dsh APIs this will bind to

From the `.d.ts` of `@deepseek-ai/dsh` 0.2.0-rc.2:

- **System prompt section** — `ctx.systemPrompt.section({ name, order, text })`, where `text` may be
  `(ctx) => string`. dsh re-evaluates it on every assembly, so there is no per-session freezing to
  reproduce: `memory-core` returns the section string and dsh calls the provider each time.
- **Per-turn context** — `ctx.systemPrompt.context({ name, order, text })`, described in the `.d.ts` as a
  "dynamic model context materialized as a durable user-role snapshot". This is where the
  `<relevant_memories>` block goes.
- **Tools** — `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`.
  Parameters use the `@deepseek-ai/schemastery` DSL, not typebox; the model-facing wire format is plain
  JSON Schema, which is exactly what `memory-core`'s `memoryToolSchema()` returns.
- **Headless runs** — `ctx.subagents.start(name, request)` / `.prompt(request, signal)`, or a bare
  `ctx.llm.stream(options: GenerateOptions)` whose `tools?: ToolSchema[]` and `system?: string` support a
  one-shot call. These implement `HeadlessAgentPort.run()`.
- **Session history** — `ctx.sessionQuery` (`dsh-session-query`) and `session/event`. This implements
  `HostTranscriptPort.searchSessions()` and `toExtractMessages()`.
- **Storage and logging** — `ctx.storage` (`dsh-storage`, `$DSH_HOME`) for the data root override and
  `ctx.logger` for what pi reports through `ctx.ui.notify`.

## Packaging constraints

- cordis shape: `export const name`, `export const inject = [...]`, `export async function apply(ctx, config)`.
  A profile assembles it via `package.json → dsh.profile.bundles` plus a `cordis.patch.yml` row, installed
  with `dsh plugin --profile <p> add '<spec>'`.
- Out-of-tree plugins **cannot statically resolve host packages** (they are installed into the profile
  directory). Top-level imports must be `node:*` or the plugin's own dependencies; host packages are
  reachable only through `createRequire` walking up from `process.argv[1]`. This is the reason
  `memory-core` has to be a real dependency of this package rather than something the host provides.
- `@deepseek-ai/schemastery` is a host package too, so this package cannot export a schemastery `Config`.

## Two ports to implement

`HeadlessAgentPort.run(req: HeadlessRunRequest): Promise<string | null>` — `null` means "the round did not
run" (host refused, or it timed out). `model` and `effort` are opaque strings that `memory-core` never
interprets.

`HostTranscriptPort` —

- `searchSessions(cwd, query, cfg): Promise<string>` returns already-formatted text.
- `toExtractMessages(raw: unknown[]): ExtractMessage[]` maps dsh's message shape onto
  `{ role: "user" | "assistant" | "toolResult", text?, toolCalls?, toolName?, isError? }`.
