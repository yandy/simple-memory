# dsh-memory

English | [中文](./README.zh.md)

A memory plugin for [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh) (a cordis-based harness):
dsh sessions and pi sessions read and write the **same** on-disk memory.

It implements no memory logic of its own. The disk format, `MemoryStore`, locking, snapshots, injection
truncation, prompt text, and the `memory` tool's JSON Schema and handler all live in
[`@yandy0725/memory-core`](https://www.npmjs.com/package/@yandy0725/memory-core); this plugin only does
the harness half — when to inject, how to register the tool, which model to call, how to read session
logs.

## What it does

It lands in exactly the same directory as `pi-memory`: `$XDG_DATA_HOME/simple-memory/<git|local>/<project>/`
(`~/.local/share/simple-memory` when `XDG_DATA_HOME` is unset or relative). Under the default
`memoryDir`, memories written by a pi session are visible to dsh's index and tool, and vice versa.

Six pieces:

- **`memory_index` system-prompt section** — injects the index (the newest window of `MEMORY.md`) into
  every session's system prompt, byte-identical to what pi injects. Sessions that registered the tool
  also see the `memory` tool's snippet and guidelines before the index body (see "Three prompt channels").
- **`memory` tool** — five actions: `add` / `replace` / `remove` / `list` / `search`. Schema and handler
  come straight from core, so the model sees the same wire format as under pi.
- **`/memory` command** — prints the status block (directory, index capacity, entry count, module
  switches, lock holder). `/memory unlock --force` is the only manual way to clear a stale `.lock`. It
  keeps working even for a session that started misconfigured (directory not resolved at startup): the
  command re-resolves from the session's cwd — it must not become a dead end.
- **Per-turn recall (auto-surfacing)** — before the first step of every turn, a zero-tool side query
  picks the entries relevant to the user prompt and splices their bodies (wrapped in
  `<relevant_memories>`) into the messages entering that step.
- **Per-turn extraction (extractMemories)** — with `extractMemories.enabled`, each turn end
  (`agent/turn-stopping`) feeds the turn's conversation to a sub-session that only has the `memory`
  tool, so it can persist what is worth remembering for future sessions.
- **`/dream` command** — hands the whole memory directory to the same kind of sub-session to merge,
  rename, prune stale entries, and rebuild the index. The round holds the logical lock and takes a
  whole-directory snapshot on entry (the rollback point).

## What it does not do (real differences from pi-memory)

extract and dream both run through a **sub-session** (the only mechanism in dsh that can run a tool
loop), which creates a few structural differences. They are listed here rather than papered over:

1. **Sub-sessions are persisted by the host.** dsh persistence only asks whether the service is mounted;
   there is **no per-session switch**, so pi's `sessionPersistence.enabled: false` cannot be honoured
   here. These sub-sessions (each marked `origin: "subagent"`) therefore show up in the session log:
   behaviour is unaffected, but **the number of sessions on disk grows**.
2. **No hard turn cap.** dsh has no `maxTurns` / `maxSteps` / iteration limit. core's `maxTurns` is
   **best effort** here: we count `agent/pre-step` steps and reject the next one past the cap, ending
   that round as `incomplete` (cause `turn-limit`). It is not a hard budget — a model call stuck inside
   one step is only bounded by `timeoutMs` (120s for extract, 600s for dream, and both really do
   interrupt the sub-session).
3. **`/dream` has no confirmation dialog and does not block.** dsh command handlers get no interactive
   channel (pi's `ctx.ui.confirm` has no counterpart), and dream's timeout is 600s — awaiting it would
   freeze the harness for ten minutes. So `/dream` returns "started" immediately and writes the summary
   or failure to the **host log**.
4. **No dream nudge.** "Remind me after N sessions / N hours" is a pi host policy (`PiHostConfig`); core
   no longer carries those keys and dsh does not implement them. There is no nudge, only explicit
   `/dream`.
5. **No AGENTS.md blocks in the extract prompt.** pi lifts `<project_instructions path="…">` blocks out
   of its system prompt and appends them to the extract prompt. In dsh, AGENTS.md is assembled by
   `dsh-agent-instructions` into **opaque prompt text** with no stable marker, so the
   `## AGENTS.md Rules` section is empty on this side — the instructions are still visible to the main
   agent, they just are not handed to extract separately.

The `dream` / `extractMemories` config subtrees are named exactly as in pi's `memory.json`, so they can
be copied over; their `model` / `thinkLevel` / budget values are consumed by core, not by this adapter
(which only reads them for `/memory` display and the `/dream` pre-flight check).

The index is not frozen for the session because dsh re-assembles the system prompt on every step (pi
freezes the index for the whole session and replays the recorded value to protect the prompt cache), so
the index is a snapshot: it is refreshed asynchronously on `agent/created`, after every successful
memory write, after `/memory`, and before **every** `pre-step`; reads are a synchronous map lookup.

## Install

One command. After the package operation the host writes the package name into the profile's
`dsh.profile.bundles` and applies the bundle's `cordis.patch.yml`
(`dsh-plugin-manager/lib/types/operations.js:101-135`), so you do **not** edit the profile's
`package.json` by hand:

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # produce dist/ first
dsh plugin --profile web add file:/abs/path/to/dsh-memory
```

The order matters: `dsh-memory`'s build resolves core's `dist/` through the workspace symlink, and
`dist/` is not in git.

`<spec>` is a local directory for now (this package is `private: true` at version `0.0.0`); once
published it becomes the package name `@yandy0725/dsh-memory`. Restart dsh to pick it up.

Development loop after code changes: `npm run build -w dsh-memory`, then restart dsh.

> **Caveat**: that loop assumes the install is a **symlink** (pnpm linking the `file:` directory rather
> than copying it). Verified by hand: a `file:` install is copied, so a rebuild is **not** enough — you
> must re-run `dsh plugin … add` (or the equivalent reinstall) to see the new `dist/`.

Uninstall is one command and removes both the `dependencies` entry and the `dsh.profile.bundles` entry:

```sh
dsh plugin --profile web remove @yandy0725/dsh-memory
```

## Requirements

- **Host version**: `engines.dsh` declares `>=0.2.2-rc.1 <0.3.0`. The host gates on this field **before
  importing** the plugin (a mismatch refuses to load rather than failing later). Note that pre-release
  versions do not satisfy `^` ranges: `0.2.2-rc.1` sorts below `0.2.2`, so `^0.2.2` does not match it —
  the range must spell out the rc form.
- **Node**: `engines.node` declares `>=24.9.0`.

## Configuration

**The only configuration layer is the cordis row `config:`** in the profile's own `cordis.patch.yml`
(or the machine-level `~/.dsh/cordis.patch.yml`, which applies to every profile). This plugin reads **no
JSON config file** — neither a project-level one nor `$DSH_HOME/memory.json` nor anything under XDG.
Change the row config, and that is the whole story.

Row config is **replaced wholesale**, so an override must restate `id` and `name` (plus whatever else
you need); key names are identical to core's `MemoryConfig`:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    # memoryDir: ~/memories                                  # optional; defaults to $XDG_DATA_HOME/simple-memory
    defaults: { model: "deepseek-official/deepseek-flash" }   # dsh-specific: "<provider>/<model>"
    autoSurfacing:
      enabled: true
      model: "deepseek-official/deepseek-flash"               # per-task override of defaults.model
      thinkLevel: "high"                                      # passed through as reasoningEffort
      maxFiles: 3
    # per-turn extraction (off by default: one model call per turn)
    extractMemories:
      enabled: true
      thinkLevel: "high"
    # only runs when you type /dream (no package-level switch)
    dream:
      model: "deepseek-official/deepseek-pro"
      thinkLevel: "high"
```

Key names are **byte-identical** to `memory-core`'s `MemoryConfig` (`defaults` / `memoryDir` /
`memIndex*` / `lock` / `sessionSearch` / `autoSurfacing` / `extractMemories` / `dream`), so pi's
`memory.json` and dsh's row config can be copied between hosts. Keys outside the whitelist are not
silently dropped: they are collected into `Config: N warning(s)` and printed by `/memory`, so a typo is
visible instead of silently inert.

## memoryDir warning (important)

`memoryDir` is **per-harness configuration** — this design deliberately has no cross-harness config
file. pi reads it from its own `memory.json`, dsh from its own row config. **If you override `memoryDir`
in pi, you must override it to the same value in dsh**, otherwise the two hosts write to different
directories and the sharing fails silently.

The first line of `/memory` prints the resolved `Dir:` — that is the intended way to spot this: if the
two `Dir:` lines disagree, the configuration is not aligned.

## Models

The model value is core's single string; on the dsh side it is encoded as `"<provider>/<model>"` and
split at the **first** slash, so a model id may itself contain slashes (`megcore/qwen/qwen3.8-max` →
`provider=megcore`, `model=qwen/qwen3.8-max`).

**A missing or unparsable model degrades instead of disabling memory**: only the module that cannot get
a model is turned off; the `memory_index` section and the `memory` tool stay available, and the reason is
shown in `/memory`'s `Modules:` line (`autoSurfacing=off(<reason>)`).

Per-task model needs:

- `autoSurfacing`: probed **at startup** through the host's `resolveCallConfig`; if the host rejects it,
  only recall is turned off.
- `extractMemories`: off by default (one model call per turn — you opt into that cost). When enabled
  without a model, each turn's extraction logs one "extract failed" line; it never blocks the
  conversation.
- `dream`: no package-level switch, only runs on `/dream`. When the model is missing the **command
  result** says so ("set dream.model (or defaults.model)") instead of starting a sub-session that fails
  in the background.

`thinkLevel` is passed through as the host's `reasoningEffort` (core's default is `"off"`). If a host
route has no `reasoning` block in its model info, the host rejects with `UNSUPPORTED_REASONING_EFFORT` —
the `Modules:` reason then names `thinkLevel` rather than `model`, because the level is what needs
changing.

## search scope=sessions

`memory search scope=sessions` scans sessions **itself**: `ctx.sessionQuery.filterSessions` lists the
project's recent sessions, `readSession` returns decoded events, and it extracts text, matches and
truncates — semantically aligned with pi's implementation. It deliberately does **not** use the host's
SQLite full-text index: that is off by default, and turning it on would make dsh recall stronger than pi,
so the same memory would return different results in the two harnesses.

## Three prompt channels

core exposes the tool text through three channels; on dsh they land like this:

- `MEMORY_TOOL_DESCRIPTION` → the tool schema's `description` (visible to the model).
- `MEMORY_TOOL_SNIPPET` and `MEMORY_TOOL_GUIDELINES` → the same `memory_index` section, and **only for a
  session that registered the `memory` tool** (sessions without a runtime and sub-agents get neither).
  Fixed order: snippet → guidelines → index body, one blank line between parts, index body untouched.

  The host's `ToolSchema` is just `{name, description, parameters, deferLoading?}` — it has no
  equivalent of pi's `promptSnippet` / `promptGuidelines`, so two of the three channels ride the section
  instead. The guidelines are seven strings rendered as `- <rule>` per line (matching how pi renders
  `promptGuidelines`), text taken verbatim from core. The cost is ~1143 extra characters (≈300 tokens)
  per assembled system prompt, but it is **static** text that the prompt cache can hit. It is worth it
  because the memory directory is shared: guidelines govern write quality ("a description must be
  self-contained", with examples), and a vague description written by a dsh session degrades recall for
  pi sessions too.

## Development

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # order matters: build resolves core's dist/ through the workspace symlink
npm test -w dsh-memory
```

`@yandy0725/memory-core` has two resolution paths, same as `pi-memory`: **development** (`npm test` /
`typecheck`) resolves `../memory-core/src/index.ts` through the `vitest.config.ts` alias and the
`tsconfig.json` paths, while **build and runtime** resolve `dist/` through the package `exports` — the
version installed from the registry on a user machine. `npm run check:memory-core-deps` guards this
statically and `npm run smoke:registry` proves it by installing for real (see
[docs/guides/dependencies.md](../docs/guides/dependencies.md)).

Design guarantee: `dsh-memory/dist/**/*.js` contains **zero** `@deepseek-ai` references. Host packages
appear only as `import type` (erased by tsc) and runtime capabilities come from `inject`ed `ctx`
services, so the emitted `.js` has no host imports. CI guards it with
`grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` (host types in `.d.ts` are fine).

`inject` declares **seven** services: `tools` / `systemPrompt` / `llm` / `agents` / `commands` /
`workingDirectory` / `sessionQuery`. Two notes:

- **`agents` is required** by extract and dream (only it can open a sub-session's tool loop). A profile
  missing it keeps the whole bundle inactive rather than half-mounted (recall working while `/dream`
  silently does nothing is much harder to diagnose).
- **`logger` must never be listed.** `ctx.logger` is a plain property assigned in cordis's `Context`
  constructor, not a service; listing it leaves the fiber `pending (waiting for service: logger)` forever
  and the plugin never activates.

## Verification status

Unit tests are green (dsh-memory `282 passed`) and the plugin has been run **end-to-end on real dsh
`0.2.2-rc.1`** (isolated `DSH_HOME`, `file:` install) — the notes below are that verification record.

Confirmed on a real host (web profile, long-lived):

- The plugin **really activates** (see the `logger` note above — listing it was a real bug that made the
  plugin a no-op on real hosts while all unit tests passed).
- The `memory_index` section and the `memory` tool appear in a real session, and memories the model
  writes land correctly on disk.
- **extract works end to end**: the parent was told not to call any tool and ran 1 turn / 1 step, yet two
  memories appeared — written by the extract sub-session, whose `request/header` lists exactly
  `["memory"]` as its tool surface (`memory list` → `memory add` ×2, `turn/end: completed`).
- **`/dream` works end to end**: seeded with four entries (two of them contradicting each other),
  `/dream` merged the pair into one entry (old files gone), rewrote another entry's description, rebuilt
  the index to three lines, and left a whole-directory snapshot under `<memoryDir>/.backups/`.
- `/memory` and `/dream` register successfully (an empty `input.hint` makes the host reject the
  registration and roll back the whole bundle).

### Why the sub-session is a long-lived worker

`AgentRegistry.create()` uses `this.ctx` as the owner of the child agent, and cordis's traceable
machinery resolves that to "the caller scope at the time the service was accessed". Creating a
sub-session inside the `agent/turn-stopping` / `agent/status` dispatch throws
`cannot create effect on inactive context` (reproduced with plugin-scope binding, agent-scope
`agent.ctx.agents` binding, and a macrotask deferral); the same call during `agent/created` succeeds.

So this adapter creates one long-lived sub-session **per task at session start** (extract: 5 actions,
dream: 7 — different capability surfaces, so they cannot share one) and only `followup`s a message into
it per turn, waiting for its `turn/end`. Gates and cost:

- The extract worker is created only when `extractMemories.enabled` is true; the dream worker only when
  the user explicitly configured a `dream` key. Neither enabled means **zero extra sub-sessions**.
- A session with a worker gains one **empty** sub-session record (it only has turn content after a
  `followup`).

### Limitations in one-shot hosts

`dsh headless` answers one task and exits: the parent turn ends, the process exits, and in-flight
background extraction is interrupted with `aborted/disposed` (measured). The adapter `drain()`s in-flight
extraction for up to 5s on unload / `agent/disposed`, but process exit does not wait for us. So
**extract / dream only have their full semantics in a long-lived host (web / TUI)**; in one-shot headless
they are best effort.
