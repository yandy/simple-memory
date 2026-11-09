# simple-memory

English | [中文](./README.zh.md)

One on-disk memory, shared by every AI coding agent you run. A memory is a plain Markdown file; an
index lists each one on a single line. Two harnesses pointed at the same machine read and write the
same files.

## Packages

| Package | Description | npm |
|---|---|---|
| [memory-core](./memory-core) | Harness-agnostic layer: disk format, `MemoryStore`, two-level locking, snapshots, project paths, injection policy, dream/extract orchestration, and the neutral `memory` tool contract (JSON Schema + handler). Imports only `node:*`. | `@yandy0725/memory-core` |
| [pi-memory](./pi-memory) | pi adapter: extension wiring, `/memory` and `/dream`, typebox schema + pi-tui rendering, prompt-cache section freezing, headless sub-sessions, session search. | `@yandy0725/pi-memory` |
| [dsh-memory](./dsh-memory) | DeepSeek harness (`@deepseek-ai/dsh`, cordis) adapter. **Placeholder — not implemented.** | `@yandy0725/dsh-memory` |

An adapter owns the host-specific half — when to inject, how to render, which model to call. `memory-core`
owns the half that must be identical everywhere, which is why the files below are shared rather than
duplicated per harness.

## Shared data root

```
$XDG_DATA_HOME/simple-memory/<git|local>/<project>/
```

`~/.local/share/simple-memory` when `XDG_DATA_HOME` is unset or relative. `git/<host__owner__repo>` for a
repository with an http(s)/ssh/git remote (clones and worktrees share it); `local/<escaped-absolute-path>`
otherwise.

Each project directory holds `MEMORY.md` (the index), one `*.md` per memory, `.lock`, `.backups/`,
`.dream-meta.json`, and `sessions/`. The `memoryDir` config key overrides the root; `~` and `~/` are
expanded and relative values are resolved against the working directory.

The disk format is byte-for-byte the one `pi-memory` 2.x writes: YAML frontmatter with
`name`/`description`/`type`/`created`/`modified`, one index line per memory
(`- [Name](file.md) — description`), and `.backups/<ts>-<label>/` rollback points.

## Migrating from pi-memory 2.x

2.x kept memory under `~/.pi/memory/`. 3.0 moved it out of the pi directory so any harness can read it.
Nothing migrates automatically — silently moving user data is worse than a prompt — so migrate once:

```sh
root="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$root"
mv ~/.pi/memory "$root/simple-memory"
# only if this machine ran a pre-release build that used the old working name:
mv "$root/auto-memory" "$root/simple-memory" 2>/dev/null || true
```

`/memory` prints a one-line hint when it finds pre-3.0 data still in place; it only reports, it never
moves or modifies anything.

## Development

```bash
npm ci                        # root + both testable workspaces
npm test                      # memory-core and pi-memory
npm run typecheck && npm run lint
npm run build -w memory-core  # dist/ (ESM + .d.ts + maps); CI validates the packed tarball
npm run check:host-deps       # host packages must be peerDependencies, never dependencies
```

`memory-core`'s `src/**` may import only `node:*` and relative paths — `memory-core/tests/neutrality.test.ts`
fails the build if that ever changes, and it is the only reason a second harness can depend on the package.

`dsh-memory` has no code, so it has no test script; `npm test` skips it.

Releases: see [docs/guides/release.md](./docs/guides/release.md).
