# dsh-memory

English | [中文](./README.zh.md)

Memory plugin for [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh) (a cordis-based host) that
reads and writes the **same** on-disk memory as `pi-memory`. All the memory logic lives in
[`@yandy0725/memory-core`](https://www.npmjs.com/package/@yandy0725/memory-core); this plugin only does the
host half: when to inject, how to register the tool, which model to call, how to scan session logs.

## Install

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # order matters: this package builds against core's dist/
dsh plugin --profile web add file:/abs/path/to/dsh-memory
```

Restart dsh afterwards. A `file:` install is a **copy**, so after changing code re-run
`dsh plugin … add` to see the new build. The package is `private: true` at version `0.0.0` for now; once
published, `<spec>` becomes `@yandy0725/dsh-memory`.

Uninstall: `dsh plugin --profile web remove @yandy0725/dsh-memory`.

## Configuration

The only configuration layer is the cordis row `config:`, in the profile's `cordis.patch.yml` (or the
machine-level `~/.dsh/cordis.patch.yml`). No JSON config file is read.

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    defaults: { model: "deepseek-official/deepseek-flash" }   # "<provider>/<model>"
    autoSurfacing: { enabled: true }                          # per-turn recall
    extractMemories: { enabled: false }                       # per-turn extraction (off by default)
    dream: { model: "deepseek-official/deepseek-pro" }        # only runs when you type /dream
```

Key names are **byte-for-byte** the ones in `memory-core`'s `MemoryConfig` and pi's `memory.json`. A
missing model disables only the module that needed it; the `memory_index` section and the `memory` tool
keep working. `memoryDir` is per-harness configuration — if you override it in pi, override it to the same
value here.

## What it does

- A `memory_index` system-prompt section whose body matches pi's byte for byte
- The `memory` tool: `add` / `replace` / `remove` / `list` / `search`
- `/memory` status and `/memory unlock --force`
- Per-turn auto-surfacing
- Per-turn extraction (`extractMemories.enabled`, off by default)
- `/dream` tidy-up

## Real differences from pi

- Sub-sessions are persisted by the host (dsh has no per-session persistence switch), so the session log
  grows.
- There is no hard turn limit; `maxTurns` is best-effort and only the timeout is a hard stop.
- `/dream` returns "started" immediately, with no confirmation prompt — the summary goes to the host log.
- There is no "time to tidy up" nudge; only an explicit `/dream`.
- The extract prompt has no AGENTS.md block (dsh assembles it as opaque text with no stable marker).
- The index is not frozen: dsh reassembles the system prompt every step, so the index is an
  asynchronously refreshed snapshot.

## Requirements

- dsh `>=0.2.2-rc.1 <0.3.0` (the host refuses to load a plugin whose `engines.dsh` does not match)
- Node `>=24.9.0`

## Docs

- [Reference](https://github.com/yandy/simple-memory/blob/main/docs/reference/dsh-memory.md): full configuration, models, verification status, implementation limits
- [Architecture and hard constraints](https://github.com/yandy/simple-memory/blob/main/docs/guides/architecture.md)
- [Dependency management](https://github.com/yandy/simple-memory/blob/main/docs/guides/dependencies.md)

MIT
