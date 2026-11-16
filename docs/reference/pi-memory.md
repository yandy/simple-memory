# pi-memory reference

Detailed reference: full configuration, cross-device sync, internals, tool and command reference. Start at the [README](../../pi-memory/README.md).

## Configuration

Create `memory.json` in the agent directory (`~/.pi/agent/memory.json`) or the project `.pi/` directory (only when the project is trusted):

```json
{
  "memoryDir": "~/project-memories",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "memIndexInjectMaxLines": 50,
  "memIndexInjectMaxBytes": 16384,
  "lock": { "timeoutMs": 5000, "snapshotKeep": 5 },
  "defaults": { "model": "provider/model-id", "sessionPersistence": { "enabled": false } },
  "dream": { "nudgeAfterSessions": 5, "nudgeAfterHours": 24, "thinkLevel": "high" },
  "sessionSearch": { "maxSessions": 10, "maxMatches": 5 },
  "autoSurfacing": {
    "enabled": true,
    "thinkLevel": "off",
    "maxFiles": 3,
    "maxEntryBytes": 3072,
    "maxInjectionBytes": 10240
  },
  "extractMemories": {
    "enabled": false,
    "thinkLevel": "high",
    "maxContextTokens": 2000,
    "maxToolResultChars": 500,
    "maxAssistantChars": 2000
  },
  "sync": {
    "enabled": false,
    "remote": "",
    "branch": "main",
    "pullOnStart": true,
    "pushOnWrite": true,
    "pushDebounceMs": 5000,
    "autoTimeoutMs": 5000,
    "timeoutMs": 20000
  }
}
```

> Every `model` value must resolve in your registry — there is no default. A missing or unresolvable model makes `session_start` report a config error and initialise nothing. See [Model configuration](#model-configuration).

| Key | Default | Description |
|-----|---------|-------------|
| `memoryDir` | `$XDG_DATA_HOME/simple-memory` (default `~/.local/share/simple-memory`) | Root directory for all memory data. `~`, `~/` and (on Windows) `~\` are expanded; relative values are resolved against the working directory |
| `memIndexMaxLines` | `200` | Write capacity: max non-empty lines in `MEMORY.md` (the `# Memory Index` header and hand-written headings count too, so this is not exactly the memory count) |
| `memIndexMaxBytes` | `25600` | Write capacity: max bytes of `MEMORY.md` |
| `memIndexInjectMaxLines` | `50` | Injection window: max lines of the index put into the `memory_index` section. The window keeps the **newest** lines and drops the **oldest** ones — the index is pure chronological order, so a smaller window never hides the memory you just wrote. **`0` (either key) injects no index at all** — the `memory_index` section stays empty |
| `memIndexInjectMaxBytes` | `16384` | Injection window: max bytes of the index section (older lines are dropped first, with a `[truncated: …]` marker at the **top**) |
| `lock.timeoutMs` | `5000` | How long a write waits for the logical lock (single primitive) or the cross-process `.lock`. Also the upper bound `session_shutdown` waits for in-flight writes |
| `lock.snapshotKeep` | `5` | Rollback points kept in `.backups/` (directories named `migrate-*` are never pruned) |
| `defaults.model` | `— (required)` | Shared model for dream / extract / side query. **No default**: every task that will run must resolve a model, otherwise `session_start` fails (see [Model configuration](#model-configuration)). A per-task `model` overrides it |
| `defaults.sessionPersistence.enabled` | `false` | Shared fallback: headless sub-sessions (extract / dream / side query) stay in memory by default |
| `defaults.sessionPersistence.sessionDir` | `<project memory dir>/sessions/` | Custom directory for persisted headless sessions |
| `dream.nudgeAfterSessions` | `5` | Sessions since the last dream before the nudge is shown |
| `dream.nudgeAfterHours` | `24` | Hours since the last dream before the nudge is shown |
| `dream.model` | — | Model for dream consolidation (`"provider/id"`). Falls back to `defaults.model`; required unless `defaults.model` is set (must be resolvable, no parent-model fallback) |
| `dream.thinkLevel` | `"high"` | Thinking effort for the dream agent: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `dream.sessionPersistence.*` | inherits `defaults` | Persist dream sessions to disk (debug/audit) |
| `sessionSearch.maxSessions` | `10` | Max sessions to scan for `search scope=sessions` |
| `sessionSearch.maxMatches` | `5` | Max matches to return from history search |
| `autoSurfacing.enabled` | `true` | ⭐ Enable per-turn entry auto-injection |
| `autoSurfacing.model` | — | ⭐ Model for the relevance side query. Falls back to `defaults.model`; required unless `defaults.model` is set (must be resolvable, no parent-model fallback) |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ Thinking effort for the side query (`"off"` keeps it cheap) |
| `autoSurfacing.maxFiles` | `3` | ⭐ Max entries to inject per turn |
| `autoSurfacing.maxEntryBytes` | `3072` | ⭐ Max bytes of a single injected entry body (truncated) |
| `autoSurfacing.maxInjectionBytes` | `10240` | ⭐ Max total bytes of injected content per turn |
| `autoSurfacing.sessionPersistence.*` | inherits `defaults` | Persist side-query sessions to disk |
| `extractMemories.enabled` | `false` | ⭐ Enable per-turn memory extraction. **Off by default** (opt-in): once enabled, every turn ends with a headless model call |
| `extractMemories.model` | — | ⭐ Model for the extraction agent. Falls back to `defaults.model`; required unless `defaults.model` is set (must be resolvable, no parent-model fallback) |
| `extractMemories.thinkLevel` | `"high"` | ⭐ Thinking effort for extraction |
| `extractMemories.maxContextTokens` | `2000` | ⭐ Budget for the rendered conversation (`× 4` characters; the middle is trimmed first, head and tail are kept, user messages are dropped last) |
| `extractMemories.maxToolResultChars` | `500` | ⭐ Per-message cap for a rendered `tool_result` |
| `extractMemories.maxAssistantChars` | `2000` | ⭐ Per-message cap for rendered assistant text (user messages are never truncated) |
| `extractMemories.sessionPersistence.*` | inherits `defaults` | Persist extract sessions to disk |
| `sync.enabled` | `false` | ⭐ Enable cross-device sync. Validated by **type**: a string such as `"false"` is reported as "sync is disabled because …", never read as truthy |
| `sync.remote` | `""` | ⭐ Git remote URL, used for the **first** initialisation only. Empty is an error only when `enabled` is true and sync is not yet initialised; afterwards the staging clone's `origin` is the source of truth |
| `sync.branch` | `"main"` | ⭐ Remote branch this project syncs on |
| `sync.pullOnStart` | `true` | ⭐ Run one convergence round (a push round: converge, then publish) at session start, **before** the index value is chosen. `false` still prepares (and initialises on first use), it just never fetches/pulls/pushes automatically |
| `sync.pushOnWrite` | `true` | ⭐ Publish after every successful memory write, debounced by `pushDebounceMs` |
| `sync.pushDebounceMs` | `5000` | ⭐ Quiet period, measured from the **first** write: a burst (one `/dream` round rewrites a dozen files) becomes one push round |
| `sync.autoTimeoutMs` | `5000` | ⭐ Budget for one automatic path (startup prepare + convergence round, shutdown flush). One budget shared by all git subprocesses of that call |
| `sync.timeoutMs` | `20000` | ⭐ Budget for a manual command, where the user is explicitly waiting (`/memory sync pull` / `push` / `status`) |

Persisted headless sessions default to `<project memory dir>/sessions/` — inside the project's memory directory, not inside your working copy.

### Disabling the extension

pi-memory has no package-level switch of its own — a top-level `enabled` key in `memory.json` is ignored. Disable the extension the way you disable any pi package, by not loading it:

Project-only (`.pi/settings.json` in the project root — read only after project trust is granted):

```json
{ "packages": [{ "source": "npm:@yandy0725/pi-memory", "extensions": [] }] }
```

A project entry replaces the personal entry, so the extension is not loaded in that project. Globally: `pi remove npm:@yandy0725/pi-memory`, or toggle the package's resources with `pi config` (project scope writes `autoload: false` plus `extensions: ["-index.ts"]`). Module switches (`autoSurfacing.enabled`, `extractMemories.enabled`, `sync.enabled`) still turn off individual behaviors while the extension stays loaded.

## Cross-device sync

pi-memory can replicate a project's memory entries to **one git remote**, so the same repository opened on
another machine lands on the same memories. It is **off by default** — syncing writes your memories to a
remote, so that cost has to be opted into, exactly like `extractMemories`.

### Setup — there is no `/memory sync init`

1. Prepare the remote repository yourself (**empty is fine**) and make sure plain `git` in the environment
   where pi runs can `clone` / `push` it non-interactively — SSH key, credential helper, token in the URL,
   whatever your setup already uses. pi-memory stores no credential of its own and never prompts; it shells
   out to `git` from `PATH`. A **private** remote is the intended default: you provision both the repository
   and its access permissions yourself.
2. Point `memory.json` at it:

```json
{ "sync": { "enabled": true, "remote": "git@github.com:you/simple-memory.git" } }
```

3. Start a session. The first `session_start` with this configuration **initialises automatically**: it
   clones into a unique staging directory, atomically publishes it as `<memoryDir>/.sync/repo`, and writes
   this project's first baseline. Initialisation and origin changes are serialized by the bounded root lock;
   an aborted init cleans only its own staging, never another process's published clone. There is deliberately
   **no `/memory sync init`** command — its first run could be a slow clone, and a typed-but-not-applied command
   would leave one more state to explain (wrong URL? unreachable remote?) than a config line.

Rules that follow from "the origin is the source of truth":

- **Once initialised, the staging clone's `origin` is authoritative**, not `sync.remote`. You may empty
  `sync.remote` afterwards and sync keeps working.
- **A configured remote that differs from `origin` is non-fatal**: one error notice per session
  (`sync.remote differs from the initialized origin; continuing to use origin …`), `/memory sync status`
  prints both values, and every round keeps using `origin`. Nothing is disabled and no local memory is
  touched. Use `/memory sync remote <url>` to actually change it.
- `sync.enabled: true` with an empty `sync.remote` **before** the first initialisation is a config error
  (sync is reported unavailable; the rest of memory keeps working). After initialisation it is not an error.
- `enabled`, `pullOnStart` and `pushOnWrite` are validated by **type**, not truthiness: a string such as
  `"enabled": "false"` is reported as `sync is disabled because …` and never silently read as on.
- Initialisation failures (no `git`, no network, bad URL, no permission) are **non-fatal**: the session runs
  with local memory only and one readable error notice explains it. Fix the cause and the next session start
  — or an explicit `/memory sync pull` / `push` — retries the same idempotent initialisation.
- If `<memoryDir>` is itself a git repository, initialisation **refuses** when one of its remotes points at
  the same URL (two writers pushing one remote is how memory gets lost) and only warns when they point
  elsewhere: the staging clone is separate and your repository is never touched.

### Scope and layout

Only the **current project's** entry files travel: flat `*.md` files under `<memoryDir>/git/<project>/` that
parse as v2 entries. One remote mirrors the whole memory root (`git/<project-key>/…`), but a session syncs
just the project it is in; other projects sync in their own sessions.

| Path | Synced? | Why |
|---|---|---|
| entry `*.md` of the current project | **yes** | the memories themselves |
| `MEMORY.md` | no | a local derivative, rebuilt from disk after each pull. Hand-written headings and groups stay device-local |
| `.lock` | no | a cross-process lock is never reclaimed automatically; syncing it would manufacture a fake dead lock on another device |
| `.backups/` | no | local rollback points; syncing them multiplies their size per device |
| `sessions/` | no | headless transcripts: large, and local execution traces. `memory search scope=sessions` therefore only finds this machine's history |
| `.dream-meta.json` | no | "last dream" is per device — each machine counts its own sessions |
| `<memoryDir>/local/**` | no | non-git projects are not replicated in v1 |
| `<memoryDir>/.sync/**` | no | this feature's own state |

```
<memoryDir>/                     e.g. ~/.local/share/simple-memory
  .sync/                         sync state — created only when sync is enabled
    device.json                  { id, hostname, createdAt }: per-device identity, never synced
    repo/                        the staging clone (worktree + .git) — the whole transport channel
    state/<project-key>.json     v2 baseline: files + { sha256(actual origin), branch }, never the raw URL
    sync.lock                    root-level cross-process lock (fetch/publish and bounded init/setRemote)
  git/<project>/                 your memory: no .git is added here, nothing else is written
  local/<project>/               never synced
```

`.sync` sits at the **memory root**, alongside `git/` and `local/`, not inside any project memory directory:
the project directories stay clean, and every scan skips it (dot-directories are not entries). The root `sync.lock` is a **different lock** from the project
`.lock` described above: sync rounds take it per segment — one `fetch` plus origin read in the transport
segment, one `push` in the publish segment — never for a whole round. Management operations (`init` /
`setRemote`) wait on the same lock with a bounded timeout and are never nested inside a round's lock.
An abandoned one makes every sync round fail with an actionable error; `/memory sync unlock` is the one
sanctioned way to clear it.

### Lifecycle

```
session_start
  1. config + models + memory directory
  2. sync: prepare (initialise on first use, a missing baseline, or an origin/branch transport mismatch)
     — this runs whether or not pullOnStart is set
  3. pullOnStart === true → one push round with only the remaining shared startup budget, BEFORE index selection
  4. choose the index value (disk for startup/new, the recorded transcript value for resume/fork/reload)

every successful memory write
  → core debounce: mark dirty, schedule one push after pushDebounceMs (quiet period from the first write)

session_shutdown
  → flush once regardless of the debounce, bounded by sync.autoTimeoutMs
```

- **A push round is the whole convergence**: transport (fetch) → three-way apply against the baseline
  (snapshot, disk, index rebuild) → publish. So the startup round both pulls in what other devices wrote and
  re-publishes what a previous session failed to push. That is why it is one round instead of "pull, then
  push": the in-process dirty flag only knows about writes made by *this* process. Prepare and startup push
  share one `sync.autoTimeoutMs` deadline; if prepare exhausts it, push is skipped with a nonfatal next-round
  notice (`pi-memory sync notice: …`, info level) instead of starting a 1ms network round.
- **`pullOnStart: false` still prepares** — it just never fetches, pulls or pushes automatically. First-time
  initialisation and recovery from a failed one still happen at session start. The key keeps its established
  name: the startup push round includes pulling as well as publishing.
- **Existing local entries**: when a new baseline is initialised, prepare warns about possible deterministic
  conflict copies **before any startup push**. The notice is emitted once for that baseline, not on every start,
  and it is a **notice, not an error**: it is reported as `pi-memory sync notice: …` at info level and `/memory`
  lists it under a separate `Sync notice:` line. Only real failures use `pi-memory sync error: …` and the
  persistent sync error state.
- **Non-git projects**: when `sync.enabled` is true but the project is not a git repository, v1 does not
  initialise sync at all. This is likewise a **notice, not an error**: it is reported once as
  `pi-memory sync notice: …` at info level, `/memory` lists it under `Sync notice:`, and `/memory sync`
  repeats that reason instead of claiming sync is not enabled.
- **Writes**: every successful entry write (the `memory` tool, a whole `/dream` round, extract's saves) arms
  the debounce. `pushOnWrite: false` installs a no-op trigger — nothing is published automatically, manual
  commands still work.
- **Shutdown** flushes once even if the debounce has not elapsed, with `sync.autoTimeoutMs` for the round and
  the same `lock.timeoutMs` bound on in-flight waits that ordinary writes use. A failed flush only produces
  `Memory sync flush failed: … local changes will be retried at the next session start.` — the content stays
  local, and the next round publishes it: the next session start (with `pullOnStart`, the default) or the
  next write's debounced push. With `pushOnWrite` and `pullOnStart` both off, use `/memory sync push`.
- **Recorded index (known semantics, not a bug)**: `resume` / `fork` / `reload` freeze the index value
  recorded in the transcript. Startup convergence still runs and the disk does change, but the pulled entries
  are **not** in this session's `memory_index` until the next compaction (or the next session).
  `/memory sync status` says so in its last line.

### Commands

```
/memory sync              — status (same as `/memory sync status`); strict dry-run
/memory sync pull         — converge remote changes into disk + rebuild the index; publishes nothing
/memory sync push         — converge, then publish
/memory sync remote <url> — point the staging clone's origin at <url> and reset this project's baseline
/memory sync unlock       — remove a left-behind .sync/sync.lock (asks for confirmation first)
```

`status` is a **strict dry-run**: it computes the same three-way diff a real round would, but it does not
clone, initialise, snapshot, write a baseline or touch a memory file (its `git fetch` only moves transport
metadata inside `.sync/repo`). It reports `Configured` / `Initialized`, `Origin` versus `Configured remote`,
`Branch`, `Device`, the local directory → remote key mapping, the baseline revision, the `Ahead` / `Behind` /
`Conflicts` file lists, `Rejected` (with reasons), `Unparsable local` (files that count as neither entry nor
safe deletion, so they are left untouched), `Out of scope remote` (paths in the remote that are not this
project's entries — for example someone pushed a root `MEMORY.md`), and `Errors`. A v1, malformed, or
transport-mismatched manifest is treated as an empty base; an origin/branch mismatch is reported in `Errors`
without throwing, so status never presents a stale base as current.

`remote <url>` is the only supported way to change the origin:

- It closes the gate for new sync activity (a second `/memory sync remote` reports `sync remote change is
  already in progress`), drains the rounds already in flight, then **invalidates this project's baseline**
  (`state/<project-key>.json` is deleted) and re-runs preparation against the new origin. A missing manifest
  is a *safe* empty baseline: it means "nothing agreed yet", never "the user deleted everything".
- Every v2 manifest is also bound to `sha256(actual origin)` and `branch`, not to a raw credentialed URL.
  Consequently a stale manifest written late by another process is ignored on the new transport — for every
  project, not just the one being changed. A stale publish carries its fetch-time origin and is rejected
  before it can write into the new one.
- Because the baseline is empty, the first round against the new remote may see the same memory on both
  sides with different content. **Both are kept**: the newer `modified` stays at the path (ties broken by the
  content hash), the other becomes a normal entry whose `name` gains ` (冲突 <date> <sha6>)` (the suffix is
  Chinese in every locale — it is part of the name contract). The suffix depends on content only, so two
  devices resolving the same conflict write the **same** file and converge instead of multiplying copies;
  `/dream` merges duplicates afterwards.
- If the new origin is empty, the first publish starts from the staging clone's current HEAD. The new remote
  can therefore receive the existing **whole memory-root history, including other projects**, not just this
  project's latest files. Treat changing to an empty origin as a whole-root history migration and inspect the
  target repository before running it.
- `memory.json` is **never rewritten** (this layer has no config writer) — the notice says exactly that.
  Edit the file yourself if you want the value to be the configured default on the next start.
- Before the first initialisation there is no origin to change: it tells you to set `sync.remote` in
  `memory.json` instead.

## Model configuration

Every task that will run must resolve a model — **there is no shipped default and no parent-model fallback**. `defaults.model` satisfies all of them; a per-task `model` (`dream.model`, `extractMemories.model`, `autoSurfacing.model`) overrides it.

| Task | Required when |
|------|---------------|
| `dream` | always required — every session validates it at startup |
| `extractMemories` | `extractMemories.enabled` is true |
| `autoSurfacing` | `autoSurfacing.enabled` is true |

At `session_start` pi-memory resolves every required model against the model registry. If one is missing or cannot be resolved, it initialises **nothing**: it shows an error notification `pi-memory config error:` followed by one `- <error>` line per problem, and `/memory` reports `Memory: misconfigured` and `Dir: not initialized`, followed by the same lines. The two possible messages are:

- `no model for <task> — set "<task>.model" or "defaults.model" in memory.json`
- `model "<value>" for <task> is not resolvable (unknown id or missing credentials)`

Fix `memory.json` and restart the session — the config is read once at session start. In headless/print sessions a config error is silent (no notification is shown), so check `/memory` in an interactive session.

Resolution happens against the session's model registry, but the headless sub-session runs in a runtime
pi-memory builds itself: providers from `models.json` and providers another extension registered at
runtime with `pi.registerProvider()` are both available. Runtime-registered **virtual models** cannot be
replayed into that runtime — such a model resolves at startup and then fails with an explicit
`… resolves in the host registry but not in a headless runtime` error. Configure a physical provider in
`models.json` if you use one.

## How it works

### Session lifecycle

| Event | What pi-memory does |
|---|---|
| `session_start` | Load config → validate the required models (a failure means nothing is initialised) → resolve the memory directory → **prepare cross-device sync** (auto-initialise on first use, always, even with `pullOnStart: false`) → with `pullOnStart` run one convergence round (a push round) → **pick the index value and freeze it** (disk for `startup`/`new`; the recorded transcript value for `resume`/`fork`/`reload`) → register the `memory` tool (once, five actions) → rebuild the manifest cache → dream nudge |
| `before_agent_start` | Write the frozen value into `sections["memory_index"]` (**unconditionally, every turn**), then auto-surfacing (main session, not a subagent, user-message runs only — a custom message that triggers a run carries no user input to search) |
| `agent_end` | With `extractMemories.enabled`, fire the async extractor; notify `Extracted N memories.` when it wrote something, or `Extract failed: …` once per session |
| `session_compact` | Clear the injected-file set **and re-read the index from disk** — the only in-session refresh point |
| `session_shutdown` | Flush pending sync pushes (bounded by `sync.autoTimeoutMs`) and wait for in-flight writes to finish (bounded by `lock.timeoutMs`) so a quit leaves neither a stale `.lock` nor a memory that only ever reached local disk |

Every successful memory write also arms the sync write trigger, so a burst of writes becomes one debounced
push round. Details in [Cross-device sync](#cross-device-sync).

### Why the index is frozen

pi builds the system prompt from ordered sections and appends a *patch* message only for sections whose value changed; when nothing changed it appends nothing at all. A custom section is inserted **last**, so `memory_index` is the final part of the system prompt with the entire conversation after it. If its value changed mid-session, the folded head would be rewritten and everything after it would lose its prefix cache. Hence: one value per session, refreshed only at compaction (where the middle of the conversation is being rewritten anyway).

The accepted trade-off: memories written during this session are **not** visible in this session's index. The tool result already confirms the write, and the next session sees it.

`systemPromptOptions.sections` is a required field of the host event (pi 0.99.2+), and the
`>=1.5.0` peer floor is stricter still: there is no append-to-prompt fallback. A host that does not
supply `sections` violates the contract that pi-memory is written against.

### Auto-surfacing

1. Build the manifest from the store's `mtime` cache: `[type] file.md — description`, newest first, capped at 200 entries and 4000 characters (the description budget is split evenly, never below 80 characters each).
2. A side query (`maxTurns: 1`, no tools) returns up to `maxFiles` file names from that manifest; anything not in the manifest is dropped.
3. The selected entries' **bodies** (frontmatter excluded) are truncated to `maxEntryBytes`, sanitised, and injected as one `display: false` custom message wrapped in `<relevant_memories>`; the total stops at `maxInjectionBytes`.
4. Injected file names are remembered for the session, and the set is cleared on compaction. You get a `Recalled: N entries` notification.

### Extract memories

> **Off by default.** Set `"extractMemories": { "enabled": true }` in `memory.json` first (config is read once at `session_start`, so a restart is needed), and make sure `extractMemories.model` or `defaults.model` resolves.

The extractor receives a structured rendering instead of a lossy two-message summary:

```
=== Conversation ===
[1] user: <full text>
[2] assistant: <text> | tool_call: memory({"action":"list"})
[3] tool_result: <summary, capped at maxToolResultChars>
[4] user: <correction>
```

It runs with the five main-agent actions (never `rename` / `rebuild_index`), no file tools, `maxTurns: 5`, and a 120s timeout. If the logical lock is busy (a dream owns the round) it **skips the turn** rather than queueing — the next `agent_end` will come.

### Locking

| Level | Scope | Behaviour |
|---|---|---|
| In-process logical lock (per memory dir) | one primitive call; or a whole dream round | Waits up to `lock.timeoutMs`, then throws a readable error naming the directory. `extract` uses the non-waiting form and skips the turn |
| Cross-process `.lock` | milliseconds per retried call around the physical write (a retry storm can hold it for a few seconds) | Acquired with `open(…, "wx")` (`O_CREAT|O_EXCL`) — the **create** is atomic on NTFS, ReFS, exFAT/FAT32 and in a network share's namespace, so the lock excludes processes on every machine using that share; in a sync-client folder it only excludes same-machine processes (see [Windows](#windows)). The holder record is written immediately after the file is created. **Never reclaimed automatically**: no TTL, no heartbeat, no takeover |

A crash inside a write can therefore leave a `.lock` behind, and nothing will ever delete it for you — that is the deliberate price of a hard mutual-exclusion guarantee. The error names the pid, op and start time; `/memory unlock` is the one sanctioned way to clear it.

## Tool reference

```
memory(action: "add" | "replace" | "remove" | "list" | "search",
       name?, description?, content?, type?, query?, scope?)
```

`description` is the only relevance signal a future session gets — always pass a self-contained one with `add` and `replace`.

### `add`

Creates a memory, or **overwrites the one whose `name` matches exactly** (idempotent; `created` is preserved).

- `name` (required) — unique, human-readable title
- `content` (required) — the memory body; it becomes the whole entry file
- `description` (optional) — one self-contained line; defaults to the first sentence of `content`
- `type` (optional) — `user` / `feedback` (default) / `project` / `reference`

### `replace`

Rewrites an existing memory's `content` / `description` / `type`. Looks the entry up by `name`. Renaming is `rename`, which is dream-only.

### `remove`

Deletes the entry matched by `name` — file, index line, and the memory itself. Fails loudly if the entry cannot be found or the file cannot be removed (no silent "deleted").

### `list`

One line per memory: `- name (type, modified …) — description [file]`.

### `search`

- `query` (required)
- `scope` (optional) — `memory` (default: name, description and body of every entry) or `sessions` (past conversation history)

### Dream-only actions

`rename` (`name` + `new_name`; the file name and the index line follow, keeping the line's position) and `rebuild_index` (rebuild from disk, preserving a hand-written header). They are registered **only** inside `/dream`'s headless session, so neither the main agent nor the extractor can call them.

## Commands

### `/memory`

```
/memory                      — status
/memory unlock               — remove a left-behind .lock (asks for confirmation first)
/memory sync                 — sync status (same as `/memory sync status`); strict dry-run
/memory sync pull            — converge remote changes into disk + rebuild the index
/memory sync push            — converge, then publish
/memory sync remote <url>    — change the staging clone's origin and reset this project's baseline
/memory sync unlock          — remove a left-behind .sync/sync.lock (asks for confirmation first)
```

Status output:

```
Dir: /home/you/.local/share/simple-memory/git/github.com__owner__repo
Index: 38/200 lines, 2841/25600 bytes, 1 unrecognized lines
Inject: 39/50 lines, 2841/16384 bytes
Entries: 37
Modules: dream=on(provider/model-a) extractMemories=off autoSurfacing=on(provider/model-b)
Last dream: 2026-10-01T22:10:04.882Z
Lock: free
Sync: ready
```

- `Index` uses the **write** capacity (`memIndexMax*`) and reports how many non-empty lines could not be parsed as index lines (the `# Memory Index` header and hand-written headings count). CRLF (or lone CR) line endings are normalised to LF before parsing, and the next write emits LF too, so a `MEMORY.md` re-saved by a Windows editor does **not** raise this count.
- `Inject` uses the **injection** window (`memIndexInjectMax*`) and counts the window's lines and bytes — the index text that goes into the `memory_index` section, taken from the **newest** end (the truncation marker itself is not counted). It is computed by the same window code that produces the injected value, so the two cannot drift. Note the two lines count different things: `Index` counts **non-empty** lines, `Inject` counts **every** line of the window, so on a canonical index (LF endings, trailing newline, one blank line after the header) `Inject` reports one more line than `Index` and the same byte count. The value in the system prompt is **frozen for the session** (see [Why the index is frozen](#why-the-index-is-frozen)): a memory written after `session_start` appears in `Index` immediately but in `Inject` only after compaction or in the next session.
- `Modules` reports the activation state of the three model-driven features as `on(<effective model>)` / `off`. The effective model is the task's own `model`, otherwise `defaults.model`. `dream` has no switch of its own — it is always available in a healthy session.
- `Lock` is `free`, `held by <op> (pid N on <hostname>, started <ISO>)`, or `unreadable — run /memory unlock`. `/memory unlock` shows the same holder line in its confirmation prompt.
- `Sync` is `ready` (engine prepared), `not initialized` (the runtime exists but preparation has not finished — a `/memory sync pull` or `push` retries it), or `disabled` (no runtime). The line is appended only when sync is enabled or degraded, so a default install still prints the seven lines above; sync errors follow it as `- <error>` lines. Details: [Cross-device sync](#cross-device-sync).
- If a required model is missing or cannot be resolved, nothing is initialized and `/memory` reports `Memory: misconfigured` and `Dir: not initialized`, followed by one `- <error>` line per problem. The same errors are shown as an error notification at session start.

### `/dream`

Asks for confirmation, snapshots the whole directory, then runs a headless agent through four phases:

1. **Orient** — `list`, read the relevant entries
2. **Gather Signal** — find duplicates (several entries for one fact), contradictions, stale items
3. **Consolidate** — merge with `replace` + `remove`, rename with `rename`
4. **Prune & Index** — `rebuild_index` as a backstop

It cannot touch files directly: it only has the seven `memory` actions. A summary notification arrives when it finishes, `Dream failed: …` when it does not. The model is configurable via `dream.model`.

## File layout

The on-disk format, the project-directory derivation, the locking and the snapshot layout are defined by [`@yandy0725/memory-core`](https://www.npmjs.com/package/@yandy0725/memory-core) — the harness-agnostic core this package adapts. See the [memory-core reference](./memory-core.md) for the details; this section only shows where pi puts things.

```
~/.local/share/simple-memory/
  git/
    github.com__yandy__pi-packages/    ← https://github.com/yandy/pi-packages.git
      MEMORY.md            — the index: one line per memory
      SSH-port-on-staging.md
      Test-command.md      — one file per memory
      .lock  .backups/  .dream-meta.json
  local/
    home__yandy__workspace__scratch/   ← non-git directory /home/yandy/workspace/scratch
```

Directory names are derived as follows:

- git repos whose remote is http(s), ssh (including scp-style `[user@]host:owner/repo`, where the user is optional) or `git://`, plus the `git+ssh://` / `git+https://` aliases → `git/<host>__<owner>__<repo>`; port, credentials, trailing `/` and `.git` are stripped and the host is lowercased
- remote URLs are read from the raw git config (`remote.<name>.url`; `origin` first, then alphabetical, first usable URL wins), so `url.*.insteadOf` rewrites do not change the mapping
- scheme forms apply WHATWG URL normalization (IDN hosts become punycode, percent-encoding and `.`/`..` folding apply, credentials/queries/fragments are dropped), while scp forms keep the path as written — equivalent remotes written differently can map to different directories
- everything else — non-git directories, git repos without a remote, `file://`, UNC (`\\server\share\repo.git`), relative and local-path remotes → `local/<absolute-path>` (git repos use the repository root). A Windows drive-letter remote (`Z:\repos\foo.git`) counts as a **local path on Windows**, matching how git treats it there; the same string on POSIX is scp syntax (the drive letter is a host) and still maps to a `git/` name, also matching git
- `/` becomes `__`; characters that are not portable in file names (`<>:"|?*`, control characters) become `_XX` hex escapes
- names longer than 120 UTF-8 bytes are truncated to 100 bytes on a code-point boundary plus a `__<hash8>` suffix
- names are platform-aware: on Windows a backslash is a separator, and names avoid reserved device names and trailing dots/spaces; on POSIX a backslash stays an ordinary character and these Windows-only rules do not apply. The one rule applied everywhere is the `_` prefix for entry file stems that look like a device name (see [Windows](#windows))

The mapping is not injective: underscores are kept as-is, so `/home/a__b` and `/home/a/b` both map to `home__a__b` (and share one memory directory). Changing or renaming a remote, adding a remote that sorts before the one currently in use, or moving a local directory changes the memory directory, orphaning the old one.

## Windows

pi-memory runs natively on Windows — no WSL required.

- **Directory names.** The name derived from a project key is always a single, legal Windows component: `\` counts as a separator (so `C:\Users\you\proj` → `C_3a__Users__you__proj`), a trailing dot or space is hex-escaped (`proj.` → `proj_2e`), and a name whose first `.`-delimited label is a reserved device name gets a `_` prefix (`nul` → `_nul`). Directory names are identical across platforms for an ordinary remote's `git/` key (`github.com__owner__repo`), so a shared `memoryDir` keeps working when the same repository is opened from Linux and Windows. Keys whose first label collides with a reserved device name (`aux.example.com/...`), that contain a backslash, or that end in a dot or a space can still differ between platforms.
- **Repository root.** The root comes from `git rev-parse --show-toplevel`, so a repository subdirectory maps to the same memory directory as the repository root. Note the root is taken from git's output as-is: it must be a native Windows path, which Git for Windows prints (`C:/...`). A cygwin/MSYS build of `git` prints POSIX-style paths (`/cygdrive/c/...`), which would place the memory directory under a wrong prefix — put Git for Windows' `git.exe` first on `PATH` if you have several git builds installed.
- **`memoryDir`.** `~`, `~/` and (on Windows) `~\` are expanded; relative values are resolved to absolute paths. Windows paths and UNC shares both work.
- **Locking.** The cross-process lock is created with `open(…, "wx")` (`CREATE_NEW`). On a network share that primitive is atomic in the share's single namespace, so the lock excludes processes on every machine using that share — a `memoryDir` on a non-NTFS volume is supported. In a **sync-client folder** (OneDrive, Dropbox, …) there is no single namespace: each machine keeps its own copy, so the lock only excludes processes on the same machine — do not share one `memoryDir` between machines that way; use a network share when you need cross-machine exclusion. A transient `EPERM`/`EACCES`/`EBUSY` from an antivirus scanner, an editor or a file indexer is retried with a short backoff; a persistent failure still reports the original error.
- **Line endings.** Every memory file pi-memory reads tolerates CRLF and lone CR (they are normalised to LF before parsing), and every write emits LF. A `MEMORY.md` or entry file re-saved by Notepad or another Windows editor therefore neither disappears from the index nor inflates the unrecognised-line count.
- **Known limitation.** A file whose name is a reserved device name (for example `con.md`, created by hand or on another platform) is skipped on Windows instead of being read, because opening that name reaches the console device rather than the file. Rename it (using a `\\?\` path) or re-create the memory under a new name. While such a file exists, adding a memory whose name derives to it (`CON` now derives `_CON.md`) creates a second file and a second same-named index line; the next `rebuild_index` — which dream runs regularly — drops the stale line.

## Notifications

| When | Notification |
|---|---|
| `memory add` succeeds (interactive session) | `Saved: <name>` |
| Auto-surfacing injected entries | `Recalled: <N> entries` |
| The extractor wrote memories | `Extracted <N> memory.` / `Extracted <N> memories.` |
| The extractor failed | `Extract failed: <message>` — at most once per session |
| `/dream` finished / failed | the headless agent's summary / `Dream failed: <message>` |
| Sync degraded by the environment (`sync.enabled` is true but the project is not a git repository) | `pi-memory sync notice:` with `Memory sync v1 only supports git projects; sync is disabled for this session.` (info level, not an error) |
| Sync fails at startup or on a manual command | `pi-memory sync error:` with one `- <error>` line each / `Memory sync pull failed: <reason>` / `Memory sync push failed: …` / `Memory sync remote failed: …` / `Memory sync status failed: …` |
| A manual sync command succeeded | `Memory sync pull:` / `Memory sync push:` / `Memory sync remote: <url>`, followed by that round's pulled / pushed / conflict / rejected file lists |
| Shutdown flush failed | `Memory sync flush failed: <reason>; local changes will be retried at the next session start.` |

Headless sessions (`hasUI === false`) never notify.
