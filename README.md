# simple-memory

English | [中文](./README.zh.md)

One on-disk memory, shared by every AI coding agent you run. A memory is one Markdown file, listed on a
single line in `MEMORY.md`; two harnesses pointed at the same machine read and write the same files.

| Package | What it is | npm |
|---|---|---|
| [memory-core](./memory-core) | Harness-agnostic layer: disk format, `MemoryStore`, two-level locking, snapshots, injection policy, the `memory` tool contract. Imports only `node:*`. | `@yandy0725/memory-core` |
| [pi-memory](./pi-memory) | pi adapter: the `memory` tool, `/memory`, `/dream`, auto-surfacing and extraction, cross-device sync. | `@yandy0725/pi-memory` |
| [dsh-memory](./dsh-memory) | DeepSeek harness (`@deepseek-ai/dsh`, cordis) adapter, sharing the same on-disk memory as pi. | `@yandy0725/dsh-memory` |

The adapter owns the host-specific half — when to inject, how to render, which model to call.
`memory-core` owns the half that must be identical everywhere.

## Try it

With pi:

```sh
pi install npm:@yandy0725/pi-memory
```

With dsh: see the two build/install commands in [dsh-memory](./dsh-memory).

You do not install `memory-core` yourself; both adapters depend on it.

## Where memory lives

```
$XDG_DATA_HOME/simple-memory/<git|local>/<project>/
```

`~/.local/share/simple-memory` when `XDG_DATA_HOME` is unset or relative. A repository with a remote
lands in `git/<host__owner__repo>` (clones and worktrees share it); anything else in `local/<path>`.
`memoryDir` overrides the root, but it is **per-harness configuration** — if you override it, override it
in every harness, or sharing silently stops working.

## Docs

- Reference: [memory-core](./docs/reference/memory-core.md) · [pi-memory](./docs/reference/pi-memory.md) · [dsh-memory](./docs/reference/dsh-memory.md)
- Development: [architecture](./docs/guides/architecture.md) · [dependencies](./docs/guides/dependencies.md) · [testing](./docs/guides/testing.md) · [release](./docs/guides/release.md)

## Development

```sh
npm ci                         # root + all three workspaces
npm test                       # tests for all three packages
npm run typecheck && npm run lint
npm run build -w memory-core   # dist/ (ESM + .d.ts + maps)
npm run smoke:registry         # build first: pulls memory-core from the registry and checks the published shape
```

MIT
