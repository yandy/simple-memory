import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	DEFAULT_CONFIG,
	LOCK_FILE,
	MemoryStore,
	readLockStatus,
	syncLockPath,
	syncRootPath,
	withFsRetry,
} from "@yandy0725/memory-core";
import type { MemoryConfig, SyncRoundResult, SyncStatusReport } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCommand, renderStatus } from "../src/commands.js";
import type { CommandDeps } from "../src/commands.js";
import { createDshSyncRuntime } from "../src/sync.js";
import type { DshSyncRuntime, DshSyncSession } from "../src/sync.js";
import { SYNC_REMOTE_DRIFT_ERROR } from "../src/sync.js";
import { renderSyncRound, renderSyncStatus, renderSyncSummary } from "../src/sync-view.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";

let dir: string;
let runtimes: DshSyncRuntime[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-dsh-sync-command-"));
	runtimes = [];
});

afterEach(async () => {
	for (const runtime of runtimes.reverse()) await runtime.dispose();
	vi.restoreAllMocks();
	await withFsRetry(() => rm(dir, { recursive: true, force: true }));
});

function config(over: Record<string, unknown> = {}): MemoryConfig {
	return {
		...DEFAULT_CONFIG,
		memoryDir: join(dir, "memory-root"),
		sync: {
			...DEFAULT_CONFIG.sync,
			enabled: true,
			remote: join(dir, "remote.git"),
			pullOnStart: false,
			pushOnWrite: false,
			timeoutMs: 4_321,
			...(over as object),
		},
	};
}

function storeFor(cfg: MemoryConfig): MemoryStore {
	return new MemoryStore({
		memoryDir: join(dir, "project-memory"),
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	});
}

function memoryRuntime(cfg: MemoryConfig, over: Partial<SessionMemoryRuntime> = {}): SessionMemoryRuntime {
	return {
		sessionId: "s1",
		cwd: join(dir, "repo"),
		config: cfg,
		store: storeFor(cfg),
		memoryDir: join(dir, "project-memory"),
		error: null,
		surfacing: { available: false, reason: "off" },
		...over,
	};
}

function fakeRuntime(over: Partial<DshSyncRuntime> = {}): DshSyncRuntime {
	return {
		engine: null,
		prepare: vi.fn(async () => ({ ok: false as const, reason: "commands never prepare directly" })),
		startup: vi.fn(async () => ({ ok: true as const, value: null })),
		run: vi.fn(async () => ({ ok: true as const, value: round({ ok: true }) })),
		status: vi.fn(async () => ({ ok: true as const, value: { initialized: false, origin: null } })),
		changeRemote: vi.fn(async () => ({ ok: true as const, value: null })),
		flush: vi.fn(async () => null),
		noteWrite: vi.fn(),
		dispose: vi.fn(async () => {}),
		...over,
	};
}

function session(runtime: DshSyncRuntime | null, over: Partial<DshSyncSession> = {}): DshSyncSession {
	return { runtime, errors: [], notices: [], persistentErrors: [], ...over };
}

function commandFor(
	rt: SessionMemoryRuntime | undefined,
	syncState: DshSyncSession | undefined,
): { command: ReturnType<typeof createMemoryCommand>; refresh: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
	const refresh = vi.fn(async () => {});
	const info = vi.fn();
	const warn = vi.fn();
	const deps: CommandDeps = {
		registry: { get: () => rt },
		indexCache: { refresh },
		warnings: [],
		sync: { get: () => syncState },
		info,
		warn,
	};
	return { command: createMemoryCommand(deps), refresh, info, warn };
}

function invoke(command: ReturnType<typeof createMemoryCommand>, rawInput: string) {
	return command.handler({ agent: { session: { id: "s1" } }, rawInput, signal: new AbortController().signal });
}

function round(over: Partial<SyncRoundResult> = {}): SyncRoundResult {
	return {
		ok: true,
		pulled: [],
		pushed: [],
		deletedLocal: [],
		deletedRemote: [],
		conflicts: [],
		rejected: [],
		unparsableLocal: [],
		outOfScopeRemote: [],
		...over,
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("sync rendering", () => {
	it("renders every partial result of a failed round, deduplicated and redacted", () => {
		const text = renderSyncRound(
			round({
				ok: false,
				skipped: { reason: "fetch https://token-only@example.invalid/private failed" },
				revision: "abc123",
				pulled: ["b.md", "a.md", "a.md"],
				pushed: ["push.md"],
				deletedLocal: ["local.md"],
				deletedRemote: ["remote.md"],
				conflicts: [{ file: "a.md", keptAsNew: "a-conflict.md" }],
				rejected: [
					{ file: "bad.md", reason: "bad frontmatter" },
					{ file: "bad.md", reason: "duplicate rejection" },
				],
				unparsableLocal: ["broken.md"],
				outOfScopeRemote: ["MEMORY.md"],
			}),
		);

		expect(text).toContain("Result: failed");
		expect(text).toContain("Pulled (2): a.md, b.md");
		expect(text).toContain("Pushed (1): push.md");
		expect(text).toContain("Deleted local (1): local.md");
		expect(text).toContain("Deleted remote (1): remote.md");
		expect(text).toContain("a.md -> a-conflict.md");
		expect(text).toContain("bad.md: bad frontmatter");
		expect(text).not.toContain("duplicate rejection");
		expect(text).toContain("Unparsable local (1): broken.md");
		expect(text).toContain("Out of scope remote (1): MEMORY.md");
		expect(text).toContain("https://***@example.invalid/private");
		expect(text).not.toContain("token-only");
	});

	it("renders origin, mapping, baseline, differences and drift without leaking configured credentials", () => {
		const report: SyncStatusReport = {
			configured: true,
			initialized: true,
			remote: "https://token-only@example.invalid/actual.git",
			branch: "main",
			device: { id: "device-id", hostname: "laptop", createdAt: "2026-11-16T00:00:00.000Z" },
			projectDir: join(dir, "project-memory"),
			projectKey: "example.com__owner__repo",
			base: { revision: "abc123", syncedAt: "2026-11-16T01:00:00.000Z" },
			ahead: ["ahead.md"],
			behind: ["behind.md"],
			conflicts: ["conflict.md"],
			rejected: [{ file: "bad.md", reason: "invalid" }],
			unparsableLocal: ["broken.md"],
			outOfScopeRemote: ["local/other/file.md"],
			errors: ["transport reset"],
		};
		const text = renderSyncStatus(report, "https://user:super-secret@elsewhere.invalid/configured.git");

		expect(text).toContain("Origin: https://***@example.invalid/actual.git");
		expect(text).toContain("Configured remote: https://user:***@elsewhere.invalid/configured.git");
		expect(text).not.toContain("super-secret");
		expect(text).not.toContain("token-only");
		expect(text).toContain("Device: laptop (device-id)");
		expect(text).toContain("Base: abc123 at 2026-11-16T01:00:00.000Z");
		expect(text).toContain("Ahead (1): ahead.md");
		expect(text).toContain("Behind (1): behind.md");
		expect(text).toContain("Conflicts (1): conflict.md");
		expect(text).toContain("transport reset");
		expect(text).toContain("continuing to use origin");
	});

	it("renders a failed round reason in the row config vocabulary, not memory.json", () => {
		const text = renderSyncRound(
			round({
				ok: false,
				skipped: {
					reason:
						'the sync backend is not initialized: set "sync.remote" in memory.json so the host can initialize it',
				},
			}),
		);

		expect(text).toContain("Result: failed");
		expect(text).toContain('set "sync.remote" in plugin row config so the host can initialize it');
		expect(text).not.toContain("memory.json");
	});

	it("renders status errors in the row config vocabulary, not memory.json", () => {
		const report: SyncStatusReport = {
			configured: false,
			initialized: false,
			remote: "",
			branch: "main",
			device: { id: "device-id", hostname: "laptop", createdAt: "2026-11-16T00:00:00.000Z" },
			projectDir: join(dir, "project-memory"),
			projectKey: "example.com__owner__repo",
			base: null,
			ahead: [],
			behind: [],
			conflicts: [],
			rejected: [],
			unparsableLocal: [],
			outOfScopeRemote: [],
			errors: ['sync is not configured: set "sync.enabled" and "sync.remote" in memory.json'],
		};
		const text = renderSyncStatus(report, "");

		expect(text).toContain("Errors (1):");
		expect(text).toContain('set "sync.enabled" and "sync.remote" in plugin row config');
		expect(text).not.toContain("memory.json");
	});

	it("appends ready, uninitialized, notice and error state to the normal memory status", async () => {
		const cfg = config();
		const rt = memoryRuntime(cfg);
		const ready = fakeRuntime({ engine: {} as DshSyncRuntime["engine"] });
		const text = await renderStatus(
			rt,
			[],
			[],
			session(ready, { errors: ["origin drift"], notices: ["first sync may keep copies"] }),
		);
		expect(text).toContain("Sync: ready");
		expect(text).toContain("Sync notice:");
		expect(text).toContain("first sync may keep copies");
		expect(text).toContain("Sync error:");
		expect(text).toContain("origin drift");

		expect(renderSyncSummary(session(fakeRuntime()))).toContain("Sync: not initialized");
		expect(renderSyncSummary(session(null))).toContain("Sync: disabled");
	});
});

describe("/memory sync commands", () => {
	it("treats bare sync as a strictly dry-run status before initialization", async () => {
		const cfg = config();
		const assembled = await createDshSyncRuntime({
			config: cfg,
			store: storeFor(cfg),
			projectDir: join(dir, "project-memory"),
			identity: { kind: "git", key: "example.com/owner/repo" },
		});
		expect(assembled.errors).toEqual([]);
		if (!assembled.runtime) throw new Error("runtime was not created");
		runtimes.push(assembled.runtime);
		const rt = memoryRuntime(cfg);
		const state = session(assembled.runtime);
		const { command } = commandFor(rt, state);

		const bare = await invoke(command, "sync");
		const explicit = await invoke(command, "sync status");
		expect(bare).toEqual({ kind: "success", text: explicit.text });
		expect(bare.text).toContain("not initialized");
		expect(bare.text).toContain("plugin row config");
		expect(await exists(syncRootPath(resolve(cfg.memoryDir)))).toBe(false);
		expect(assembled.runtime.engine).toBeNull();
	});

	it.each(["pull", "push"] as const)("runs %s with the manual budget, renders failures and refreshes the index", async (kind) => {
		const cfg = config();
		const failed = round({
			ok: false,
			skipped: { reason: "root lock is held" },
			pulled: ["partial.md"],
			rejected: [{ file: "bad.md", reason: "invalid" }],
		});
		const runtime = fakeRuntime({ run: vi.fn(async () => ({ ok: true as const, value: failed })) });
		const rt = memoryRuntime(cfg);
		const state = session(runtime);
		const { command, refresh } = commandFor(rt, state);

		const result = await invoke(command, `sync ${kind}`);
		expect(runtime.run).toHaveBeenCalledWith(kind, 4_321, expect.any(Function));
		expect(refresh).toHaveBeenCalledWith(rt);
		expect(result.kind).toBe("error");
		expect(result.text).toContain("root lock is held");
		expect(result.text).toContain("partial.md");
		expect(result.text).toContain("bad.md: invalid");
		expect(state.errors).toContain("root lock is held");
	});

	it("changes origin without exposing credentials and says the row config was not modified", async () => {
		const cfg = config();
		const runtime = fakeRuntime();
		const { command } = commandFor(memoryRuntime(cfg), session(runtime));
		const url = "https://user:super-secret@example.invalid/private.git";

		const result = await invoke(command, `sync remote ${url}`);
		expect(runtime.changeRemote).toHaveBeenCalledWith(url, 4_321, expect.any(Function));
		expect(result.kind).toBe("success");
		expect(result.text).toContain("https://user:***@example.invalid/private.git");
		expect(result.text).not.toContain("super-secret");
		expect(result.text).toContain("plugin row config was not modified");
	});

	it("reports disabled sync and malformed usage against the row config, not memory.json", async () => {
		const cfg = config({ enabled: false, remote: "" });
		const { command } = commandFor(memoryRuntime(cfg), session(null));

		const disabled = await invoke(command, "sync pull");
		expect(disabled.kind).toBe("error");
		expect(disabled.text).toContain("plugin row config");
		expect(disabled.text).not.toContain("memory.json");

		const usage = await invoke(command, "sync unknown");
		expect(usage.kind).toBe("error");
		expect(usage.text).toContain("Usage: /memory sync");
		expect(usage.text).toContain("unlock [--force]");
	});

	it("requires --force for sync unlock and removes only the root sync lock in a config-error session", async () => {
		const cfg = config();
		const syncRoot = syncRootPath(resolve(cfg.memoryDir));
		const lockPath = syncLockPath(syncRoot);
		await mkdir(syncRoot, { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({ op: "sync", pid: 4242, hostname: "somehost", startedAt: "2026-11-16T00:00:00.000Z" }),
			"utf8",
		);
		const sibling = join(syncRoot, "device.json");
		await writeFile(sibling, "keep me", "utf8");
		const projectLock = join(dir, "project-memory", LOCK_FILE);
		await mkdir(join(dir, "project-memory"), { recursive: true });
		await writeFile(projectLock, "also keep me", "utf8");
		const rt = memoryRuntime(cfg, {
			store: null,
			memoryDir: null,
			error: "dsh-memory row config must be an object",
		});
		const { command } = commandFor(rt, undefined);

		const preview = await invoke(command, "sync unlock");
		expect(preview.kind).toBe("success");
		expect(preview.text).toContain("pid 4242 on somehost");
		expect(preview.text).toContain("/memory sync unlock --force");
		expect((await readLockStatus(lockPath)).kind).toBe("held");

		const removed = await invoke(command, "sync unlock --force");
		expect(removed).toEqual({ kind: "success", text: "Memory sync lock removed." });
		expect(await exists(lockPath)).toBe(false);
		expect(await readFile(sibling, "utf8")).toBe("keep me");
		expect(await readFile(projectLock, "utf8")).toBe("also keep me");
		expect((await invoke(command, "sync unlock --force")).text).toContain("No sync lock present");
	});

	it.each(["pull", "push"] as const)("surfaces the conflict-copy warning in the %s result and logs it before the round finishes", async (kind) => {
		const cfg = config();
		const events: string[] = [];
		const runtime = fakeRuntime({
			run: vi.fn(async (_kind, _timeout, onWarning) => {
				// 这个 fake 忠实地复现真实 run() 的契约：prepare 产生预告时先回调 onWarning，再跑真正的一轮。
				onWarning?.("same-named entries may be kept as deterministic conflict copies");
				events.push("round");
				return { ok: true as const, value: round({ ok: true }), warning: "same-named entries may be kept as deterministic conflict copies" };
			}),
		});
		const state = session(runtime);
		const { command, info } = commandFor(memoryRuntime(cfg), state);

		info.mockImplementation(() => events.push("info"));
		const result = await invoke(command, `sync ${kind}`);

		expect(events).toEqual(["info", "round"]);
		expect(info).toHaveBeenCalledWith(
			"simple-memory: memory sync notice: %s",
			"same-named entries may be kept as deterministic conflict copies",
		);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("same-named entries may be kept as deterministic conflict copies");
		expect(state.notices).toEqual(["same-named entries may be kept as deterministic conflict copies"]);
	});

	it("surfaces the conflict-copy warning in the remote result and logs it before the change finishes", async () => {
		const cfg = config();
		const events: string[] = [];
		const runtime = fakeRuntime({
			changeRemote: vi.fn(async (_remote, _timeout, onWarning) => {
				onWarning?.("same-named entries may be kept as deterministic conflict copies");
				events.push("noteWrite");
				return { ok: true as const, value: null, warning: "same-named entries may be kept as deterministic conflict copies" };
			}),
		});
		const state = session(runtime);
		const { command, info } = commandFor(memoryRuntime(cfg), state);

		info.mockImplementation(() => events.push("info"));
		const result = await invoke(command, "sync remote https://example.invalid/new.git");

		expect(events).toEqual(["info", "noteWrite"]);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("same-named entries may be kept as deterministic conflict copies");
	});

	it("clears a resolved origin-drift error after remote change, but keeps unrelated persistent errors", async () => {
		const cfg = config({ remote: join(dir, "second-remote.git") });
		const driftError = SYNC_REMOTE_DRIFT_ERROR;
		const unrelatedError = "Failed to inspect memory sync state: disk on fire";
		const runtime = fakeRuntime();
		const state = session(runtime, { persistentErrors: [driftError, unrelatedError], errors: [driftError, unrelatedError] });
		const { command } = commandFor(memoryRuntime(cfg), state);

		const result = await invoke(command, `sync remote ${join(dir, "second-remote.git")}`);
		expect(result.kind).toBe("success");
		expect(state.persistentErrors).toEqual([unrelatedError]);
		expect(state.errors).toEqual([unrelatedError]);
	});

	it("keeps the origin-drift error when the new remote still does not match the configured remote", async () => {
		const cfg = config({ remote: join(dir, "configured.git") });
		const driftError = SYNC_REMOTE_DRIFT_ERROR;
		const runtime = fakeRuntime();
		const state = session(runtime, { persistentErrors: [driftError], errors: [driftError] });
		const { command } = commandFor(memoryRuntime(cfg), state);

		const result = await invoke(command, `sync remote ${join(dir, "somewhere-else.git")}`);
		expect(result.kind).toBe("success");
		expect(state.persistentErrors).toEqual([driftError]);
		expect(state.errors).toEqual([driftError]);
	});
});
