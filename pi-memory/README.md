# pi-memory

English | [中文](./README.zh.md)

Persistent memory for the pi coding agent: project knowledge (facts, preferences, debugging history)
kept as plain Markdown files, available across sessions and across harnesses. Memory lives on disk, not
in the conversation.

## Install

```sh
pi install npm:@yandy0725/pi-memory
```

Requires pi **1.5.0 or newer** (`@earendil-works/pi-coding-agent` peer range is `>=1.5.0`).

Or add it to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@yandy0725/pi-memory"] }
```

## Configure a model first

```json
// ~/.pi/agent/memory.json
{ "defaults": { "model": "provider/model-id" } }
```

There is **no bundled default model**, and it does not fall back to the parent session's model:
`defaults.model` must resolve in your registry. `dream` always needs it; `autoSurfacing` /
`extractMemories` need it when enabled. A missing model makes `session_start` report a config error and
initialise nothing.

## What it does

- **One `memory` tool** — `add` / `replace` / `remove` / `list` / `search`. One memory per file, `name`
  is the lookup key, and `add` with an existing name overwrites it.
- **`MEMORY.md` in the system prompt** — the `memory_index` section is frozen for the whole session, so
  pi's section diff appends nothing per turn and the provider prefix cache keeps hitting.
- **Auto-surfacing** — one lightweight side query per turn picks relevant memories and injects their
  bodies inside `<relevant_memories>`.
- **Automatic extraction** (off by default) — after each turn a sub-session picks out what is worth
  remembering and writes it through the same tool.
- **`/dream`** — a headless tidy-up: merge duplicates, resolve contradictions, rebuild the index.
- **Cross-device sync** (off by default) — push this project's memory to a git remote and share it with
  another machine working on the same repository (see below).
- Runs natively on Windows; no WSL needed.

## Cross-device sync (optional, off by default)

Push **this project's** memory entries to a git remote so another machine working on the same
repository shares them:

```json
// ~/.pi/agent/memory.json
{ "sync": { "enabled": true, "remote": "git@github.com:you/project-memory.git" } }
```

- **There is no init command**: the next session start with this config clones into
  `<memoryDir>/.sync/repo` and records a baseline.
- Prepare the remote yourself (an empty repository is fine) and make sure `git` can clone/push it
  non-interactively — pi-memory stores no credentials.
- Only entry `*.md` files sync: `MEMORY.md`, `.lock`, `.backups/` and `sessions/` stay local.
- If both sides rewrite the same memory, **both are kept**: the other becomes a deterministic conflict
  copy that `/dream` merges later.
- On the **first** sync of a project that already has local entries, expect one info notice
  (`pi-memory sync notice: …`) that same-named entries may land as conflict copies. It is not a failure and
  it does not repeat for that baseline.
- Manual convergence: `/memory sync pull` / `push` / `status` (strict dry-run) / `remote <url>`.

Full semantics: [cross-device sync](https://github.com/yandy/simple-memory/blob/main/docs/reference/pi-memory.md#cross-device-sync).

## Commands

| Command | What it does |
|---|---|
| `/memory` | Memory dir, index capacity, entry count, module status, lock holder |
| `/memory unlock` | Clear a `.lock` left behind by a crash |
| `/memory sync [status\|pull\|push\|remote <url>\|unlock]` | Sync status and manual convergence |
| `/dream` | Tidy the memory (confirms first, then snapshots the whole directory) |

Full tool and argument reference: [tool reference](https://github.com/yandy/simple-memory/blob/main/docs/reference/pi-memory.md#tool-reference).

## Where memory lives

```
$XDG_DATA_HOME/simple-memory/<git|local>/<project>/
```

`~/.local/share/simple-memory` when `XDG_DATA_HOME` is unset or relative. The disk format (entry
frontmatter, `MEMORY.md`, `.lock`, `.backups/`) is defined by
[memory-core](https://www.npmjs.com/package/@yandy0725/memory-core); `memoryDir` overrides the root, but
it is per-harness configuration — with dsh, override it to the same value on that side too.

**The index is frozen for the whole session**: memories written this session appear in the system prompt
only after a compaction or in the next session. The tool's return value is the confirmation that the
write happened.

## Docs

- [Reference](https://github.com/yandy/simple-memory/blob/main/docs/reference/pi-memory.md): full configuration, cross-device sync, internals, tool and command reference
- [Repository](https://github.com/yandy/simple-memory): `memory-core` / `dsh-memory` and how to develop

MIT
