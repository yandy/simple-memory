# memory-core

English | [中文](./README.zh.md)

Harness-agnostic, file-system driven memory layer. One memory is one Markdown file, listed on a single
line in `MEMORY.md`; the store, two-level locking, snapshot rollback, injection policy, and the LLM
orchestration around them all live here. `src/**` imports only `node:*` and relative paths.

Adapters own the host-specific half: when to inject, how to render, which model to call. This package
owns the half that must be identical everywhere — which is why two harnesses on one machine share one
memory.

## Install

```sh
npm i @yandy0725/memory-core
```

## Minimal usage

```ts
import { DEFAULT_CONFIG, MemoryStore, resolveMemoryDir } from "@yandy0725/memory-core";

const memoryDir = await resolveMemoryDir(DEFAULT_CONFIG, process.cwd());
const store = new MemoryStore({
	memoryDir,
	indexMaxLines: DEFAULT_CONFIG.memIndexMaxLines,
	indexMaxBytes: DEFAULT_CONFIG.memIndexMaxBytes,
	lock: DEFAULT_CONFIG.lock,
});

await store.addEntry({
	name: "SSH port on staging",
	description: "staging SSH listens on 2222, not 22",
	type: "project",
	body: "staging SSH uses port 2222.",
});

for (const entry of await store.listEntries()) console.log(entry.name, entry.description);
```

`DEFAULT_CONFIG.memoryDir` is the shared root `$XDG_DATA_HOME/simple-memory`
(`~/.local/share/simple-memory` when unset), and `resolveMemoryDir` turns it into this project's
`<git|local>/<project>/`. The rule contains no host name and no platform branch, so every adapter computes
the same directory independently. Adapters can also use `mergeConfig` for their own configuration files
and `runTask` for autoSurfacing / extractMemories / dream.

## What lives here

| Layer | Contents |
|---|---|
| Disk format | one Markdown file per memory with YAML frontmatter; `MEMORY.md` with one index line per memory; file names derived from `name` |
| Store | `MemoryStore` — `listEntries` / `readEntry` / `readIndex` / `searchEntries` / `addEntry` / `replaceEntry` / `removeEntry` / `renameEntry` / `rebuildIndex` |
| Concurrency & recovery | a cross-process `.lock` (held for milliseconds, never auto-reclaimed) + an in-process logical lock + transient-error retry + `.backups/` rollback points |
| Paths & safety | git remotes normalised to one legal directory component, directory-escape assertion, injection sanitising, Windows reserved-name handling |
| Orchestration | the three task descriptors in `TASKS` and the `runTask` entry point, over `HeadlessAgentPort` / `HostTranscriptPort` |
| Injection policy | index windowing, entry truncation, capacity reporting, `scanEntries`, `renderSurfacedBlock` — pure functions returning strings |
| Tool contract | action sets, JSON Schema, model-facing text, `createMemoryActionHandler` |
| Config | defaults, `mergeConfig`, `~` expansion, model validation, `defaultMemoryRoot()` — no file IO |

No LLM call, no UI, no host API. `tests/neutrality.test.ts` enforces that, and it is the only reason a
second harness can depend on this package.

## Development

```sh
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # biome
npm run build     # tsc -p tsconfig.build.json → dist/ (ESM + .d.ts)
```

## Docs

- [Reference](https://github.com/yandy/simple-memory/blob/main/docs/reference/memory-core.md): disk format, capacity, locking, ports for a new harness, Windows
- [Architecture and hard constraints](https://github.com/yandy/simple-memory/blob/main/docs/guides/architecture.md)
- [Dependency management](https://github.com/yandy/simple-memory/blob/main/docs/guides/dependencies.md)

MIT
