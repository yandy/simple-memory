/**
 * index wiring — /memory sync commands, rendering, remote baseline reset, and root-lock recovery
 *
 * harness 必须排在 ../index 与 ../src/sync 之前；git/backend/engine/filesystem 均走真实现，
 * 只有受控报告与故障注入使用 spy。
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	type MemoryConfig,
	type SyncConfig,
	type SyncRoundResult,
	type SyncStatusReport,
	devicePath,
	gitAvailable,
	manifestPath,
	readManifest,
	remoteProjectKey,
	syncLockPath,
	syncRootPath,
	syncTransport,
	writeManifest,
} from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakePi,
	DISK_INDEX,
	enableTestSync,
	flush,
	gitIdentity,
	projectIdentityMock,
	resetWiringMocks,
	sectionsEvent,
	setupSession,
	syncEngines,
	syncEvents,
	syncInitBarrier,
	syncManifestWriteFailure,
	uiWith,
	waitFor,
} from "./helpers/wiring-harness";
import memoryFactory from "../index";
import * as syncApi from "../src/sync";

const execFileP = promisify(execFile);
const GIT = await gitAvailable();

function failedRound(over: Partial<SyncRoundResult> = {}): SyncRoundResult {
	return {
		ok: false,
		skipped: { reason: "controlled publish failure" },
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

describe("sync command pure renderers", () => {
	it("renders every status field with sorted unique file lists, drift, and credential redaction", () => {
		const report: SyncStatusReport = {
			configured: true,
			initialized: true,
			remote: "https://user:origin-secret@example.invalid/org/memory.git",
			branch: "main",
			device: { id: "device-1", hostname: "host-a", createdAt: "2026-01-01T00:00:00.000Z" },
			projectDir: "/memory/project",
			projectKey: "git/example.com/org/project",
			base: { revision: "rev-123", syncedAt: "2026-11-15T01:02:03.000Z" },
			ahead: ["z.md", "a.md", "z.md"],
			behind: ["y.md", "b.md", "y.md"],
			conflicts: ["z.md", "c.md", "z.md"],
			rejected: [
				{ file: "z.md", reason: "bad" },
				{ file: "a.md", reason: "bad" },
				{ file: "z.md", reason: "bad" },
			],
			unparsableLocal: ["u.md", "broken.md", "u.md"],
			outOfScopeRemote: ["MEMORY.md", "git/x/nested/z.md", "MEMORY.md"],
			errors: ["second", "first https://user:error-secret@example.invalid/x", "second"],
		};

		const text = syncApi.renderSyncStatus(
			report,
			"https://user:configured-secret@example.invalid/org/other.git",
		);

		expect(text).toContain("Origin: https://user:***@example.invalid/org/memory.git");
		expect(text).toContain("Configured remote: https://user:***@example.invalid/org/other.git");
		expect(text).toContain("Branch: main");
		expect(text).toContain("Device: host-a (device-1)");
		expect(text).toContain("Project: /memory/project -> git/example.com/org/project");
		expect(text).toContain("Base: rev-123 at 2026-11-15T01:02:03.000Z");
		expect(text).toContain("Ahead (2): a.md, z.md");
		expect(text).toContain("Behind (2): b.md, y.md");
		expect(text).toContain("Conflicts (2): c.md, z.md");
		expect(text).toContain("Rejected (2):\n- a.md: bad\n- z.md: bad");
		expect(text).toContain("Unparsable local (2): broken.md, u.md");
		expect(text).toContain("Out of scope remote (2): MEMORY.md, git/x/nested/z.md");
		expect(text).toContain("Errors (2):\n- first https://user:***@example.invalid/x\n- second");
		expect(text).toContain("sync.remote differs from the initialized origin; continuing to use origin");
		expect(text).toContain("Prompt index: frozen for this session");
		expect(text).not.toMatch(/origin-secret|configured-secret|error-secret/);

		const tokenOnly = syncApi.renderSyncStatus(
			{
				...report,
				remote: "https://origin-token@example.invalid/org/memory.git",
				errors: ["failed https://error-token@example.invalid/x"],
			},
			"https://configured-token@example.invalid/org/other.git",
		);
		expect(tokenOnly).toContain("Origin: https://***@example.invalid/org/memory.git");
		expect(tokenOnly).toContain("Configured remote: https://***@example.invalid/org/other.git");
		expect(tokenOnly).toContain("failed https://***@example.invalid/x");
		expect(tokenOnly).not.toMatch(/origin-token|configured-token|error-token/);
	});

	it("redacts token-only HTTP userinfo while preserving user:pass and plain URLs", () => {
		expect(syncApi.errorMessage("failed https://token-only@example.invalid/o/r.git")).toBe(
			"failed https://***@example.invalid/o/r.git",
		);
		expect(syncApi.errorMessage("failed git+https://token-only@example.invalid/o/r.git")).toBe(
			"failed git+https://***@example.invalid/o/r.git",
		);
		expect(syncApi.errorMessage("failed https://user:password@example.invalid/o/r.git")).toBe(
			"failed https://user:***@example.invalid/o/r.git",
		);
		expect(syncApi.errorMessage("failed https://example.invalid/o/r.git")).toBe(
			"failed https://example.invalid/o/r.git",
		);
	});

	it("renders failed rounds as fully as successes and omits an absent revision", () => {
		const result = failedRound({
			revision: "rev-1",
			pulled: ["z.md", "a.md", "z.md"],
			pushed: ["p.md", "p.md"],
			deletedLocal: ["d.md", "d.md"],
			deletedRemote: ["r.md", "r.md"],
			conflicts: [
				{ file: "c.md", keptAsNew: "c-copy.md" },
				{ file: "c.md", keptAsNew: "c-copy.md" },
			],
			rejected: [
				{ file: "bad.md", reason: "invalid modified" },
				{ file: "bad.md", reason: "invalid modified" },
			],
			unparsableLocal: ["u.md", "u.md"],
			outOfScopeRemote: ["MEMORY.md", "MEMORY.md"],
		});

		const text = syncApi.renderSyncRound(result);
		expect(text).toContain("Result: failed");
		expect(text).toContain("Reason: controlled publish failure");
		expect(text).toContain("Revision: rev-1");
		expect(text).toContain("Pulled (2): a.md, z.md");
		expect(text).toContain("Pushed (1): p.md");
		expect(text).toContain("Deleted local (1): d.md");
		expect(text).toContain("Deleted remote (1): r.md");
		expect(text).toContain("Conflicts (1):\n- c.md -> c-copy.md");
		expect(text).toContain("Rejected (1):\n- bad.md: invalid modified");
		expect(text).toContain("Unparsable local (1): u.md");
		expect(text).toContain("Out of scope remote (1): MEMORY.md");

		const withoutRevision = { ...result, revision: undefined };
		expect(syncApi.renderSyncRound(withoutRevision)).not.toContain("Revision:");
		expect(syncApi.renderSyncRound({ ...result, revision: "" })).toContain("Revision: (empty)");
	});
});

describe.skipIf(!GIT)("index wiring — /memory sync commands", { timeout: 60_000 }, () => {
	let s: Awaited<ReturnType<typeof setupSession>>;
	let remote: string;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
		const emptyGitConfig = join(s.cwd, "gitconfig-empty");
		await writeFile(emptyGitConfig, "", "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		remote = join(s.cwd, "remote.git");
		await git(["init", "--bare", "--quiet", remote]);
	});

	afterEach(async () => {
		for (const engine of syncEngines) engine.dispose();
		await s.cleanup();
	});

	async function git(args: string[], cwd = s.cwd): Promise<string> {
		const { stdout } = await execFileP("git", args, { cwd, timeout: 15_000, encoding: "utf8" });
		return stdout.trim();
	}

	async function enableSync(over: Record<string, unknown> = {}): Promise<void> {
		await enableTestSync(s, {
			remote,
			pullOnStart: false,
			pushOnWrite: false,
			autoTimeoutMs: 10_000,
			timeoutMs: 4_321,
			...over,
		});
	}

	function memoryConfig(over: Partial<SyncConfig> = {}, memoryDir = s.memoryDirRoot): MemoryConfig {
		return {
			...DEFAULT_CONFIG,
			memoryDir,
			sync: {
				...DEFAULT_CONFIG.sync,
				enabled: true,
				remote,
				branch: "main",
				pullOnStart: false,
				pushOnWrite: false,
				autoTimeoutMs: 10_000,
				timeoutMs: 4_321,
				...over,
			},
		};
	}

	function syncPaths(memoryDir = s.memoryDirRoot) {
		const syncRoot = syncRootPath(resolve(memoryDir));
		const projectKey = remoteProjectKey(gitIdentity(s.cwd).key);
		return { syncRoot, projectKey, manifest: manifestPath(syncRoot, projectKey) };
	}

	function newStore(config: MemoryConfig, dir = s.dir): MemoryStore {
		return new MemoryStore({
			memoryDir: dir,
			indexMaxLines: config.memIndexMaxLines,
			indexMaxBytes: config.memIndexMaxBytes,
			lock: config.lock,
		});
	}

	async function snapshotTree(root: string): Promise<Record<string, string>> {
		const output: Record<string, string> = {};
		async function visit(path: string, relative: string): Promise<void> {
			const info = await stat(path);
			if (info.isDirectory()) {
				output[`${relative}/`] = "directory";
				for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), `${relative}/${entry}`);
			} else {
				output[relative] = (await readFile(path)).toString("base64");
			}
		}
		await visit(root, ".");
		return output;
	}

	async function seedRemoteEntry(name = "Remote note"): Promise<void> {
		const root = join(s.cwd, `seed-${name.replace(/\s+/g, "-")}`);
		const projectDir = join(root, "project");
		await mkdir(projectDir, { recursive: true });
		const config = memoryConfig({}, root);
		const store = newStore(config, projectDir);
		await store.addEntry({ name, description: "from another device", body: `${name} body` });
		const { runtime, errors } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir,
			identity: gitIdentity(s.cwd),
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("seed runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`seed prepare failed: ${prepared.reason}`);
		expect((await prepared.engine.push(10_000)).ok).toBe(true);
		runtime.dispose();
		syncEvents.length = 0;
	}

	it("status and /memory are strict dry-runs and render the complete real report", async () => {
		await enableSync();
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		const status = vi.spyOn(engine, "status");
		const paths = syncPaths();
		const before = {
			memory: await snapshotTree(s.dir),
			manifest: await readFile(paths.manifest, "utf8"),
			device: await readFile(devicePath(paths.syncRoot), "utf8"),
			config: await readFile(join(s.agentDir, "memory.json"), "utf8"),
		};
		syncEvents.length = 0;

		await commands["memory"].handler("sync", s.uiCtx(uiWith(notify)));
		await commands["memory"].handler("sync status", s.uiCtx(uiWith(notify)));
		await commands["memory"].handler("", s.uiCtx(uiWith(notify)));

		expect(status).toHaveBeenCalledTimes(2);
		expect(status).toHaveBeenNthCalledWith(1, 4_321);
		expect(status).toHaveBeenNthCalledWith(2, 4_321);
		expect(syncEvents).not.toContain("init:start");
		const rendered = notify.mock.calls[0][0] as string;
		for (const field of [
			"Origin:",
			"Configured remote:",
			"Branch: main",
			"Device:",
			"Project:",
			"Base:",
			"Ahead",
			"Behind",
			"Conflicts",
			"Rejected",
			"Unparsable local",
			"Out of scope remote",
			"Errors",
			"Prompt index: frozen for this session",
		]) {
			expect(rendered).toContain(field);
		}
		expect(notify.mock.calls[2][0]).toContain("Sync: ready");
		expect(await snapshotTree(s.dir)).toEqual(before.memory);
		expect(await readFile(paths.manifest, "utf8")).toBe(before.manifest);
		expect(await readFile(devicePath(paths.syncRoot), "utf8")).toBe(before.device);
		expect(await readFile(join(s.agentDir, "memory.json"), "utf8")).toBe(before.config);
	});

	it("redacts a credentialed origin in not-ready status without repairing initialization", async () => {
		await enableSync();
		const config = memoryConfig();
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store: newStore(config),
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		runtime.dispose();
		const paths = syncPaths();
		const credentialed = "https://user:status-secret@example.invalid/org/memory.git";
		await git(["remote", "set-url", "origin", credentialed], join(paths.syncRoot, "repo"));
		// ready 快路径不联网；让 device 读取真实失败，保留 initialized + engine=null 的中间态。
		await rm(devicePath(paths.syncRoot), { force: true });
		await mkdir(devicePath(paths.syncRoot));
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const before = await snapshotTree(s.memoryDirRoot);
		syncEvents.length = 0;
		const notify = vi.fn();

		await commands["memory"].handler("sync status", s.uiCtx(uiWith(notify)));

		const text = notify.mock.calls.at(-1)?.[0] as string;
		expect(text).toContain("initialized but not ready");
		expect(text).toContain("https://user:***@example.invalid/org/memory.git");
		expect(text).not.toContain("status-secret");
		expect(syncEvents).not.toContain("init:start");
		expect(syncEvents).not.toContain("fetch");
		expect(await snapshotTree(s.memoryDirRoot)).toEqual(before);
	});

	it("uninitialized status and remote give configuration guidance without any initialization or writes", async () => {
		const missing = join(s.cwd, "missing", "remote.git");
		await enableSync({ remote: missing, autoTimeoutMs: 1_000 });
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const before = await snapshotTree(s.memoryDirRoot);
		syncEvents.length = 0;
		const notify = vi.fn();

		await commands["memory"].handler("sync", s.uiCtx(uiWith(notify)));
		await commands["memory"].handler(`sync remote ${remote}`, s.uiCtx(uiWith(notify)));
		await commands["memory"].handler("", s.uiCtx(uiWith(notify)));

		expect(notify.mock.calls[0][0]).toContain("not initialized");
		expect(notify.mock.calls[0][0]).toContain('set "sync.remote" in memory.json');
		expect(notify.mock.calls[1][0]).toContain('set "sync.remote" in memory.json');
		expect(syncEvents).not.toContain("init:start");
		expect(syncEvents).not.toContain("fetch");
		expect(syncEvents).not.toContain("pull");
		expect(syncEvents).not.toContain("push:start");
		expect(await snapshotTree(s.memoryDirRoot)).toEqual(before);
	});

	it("manual pull uses the manual budget, rebuilds only disk state, and never publishes or changes the frozen prompt", async () => {
		await seedRemoteEntry();
		await enableSync();
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const beforePrompt = sectionsEvent();
		await handlers["before_agent_start"][0](beforePrompt, s.uiCtx());
		expect(beforePrompt.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		const pull = vi.spyOn(engine, "pull");
		const push = vi.spyOn(engine, "push");

		await commands["memory"].handler("sync pull", s.uiCtx(uiWith(notify)));

		expect(pull).toHaveBeenCalledWith(4_321);
		expect(push).not.toHaveBeenCalled();
		expect(await readFile(join(s.dir, "Remote-note.md"), "utf8")).toContain("Remote note body");
		expect(await readFile(join(s.dir, "MEMORY.md"), "utf8")).toContain("Remote note");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Memory sync pull:");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Pulled (1): Remote-note.md");
		const afterPrompt = sectionsEvent();
		await handlers["before_agent_start"][0](afterPrompt, s.uiCtx());
		expect(afterPrompt.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("manual push converges then publishes without changing the frozen prompt", async () => {
		await enableSync();
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		await tools[0].execute(
			"local-add",
			{ action: "add", name: "Local note", description: "local", content: "local body" },
			undefined,
			undefined,
			undefined,
		);
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		await seedRemoteEntry();
		const push = vi.spyOn(engine, "push");
		const pull = vi.spyOn(engine, "pull");

		await commands["memory"].handler("sync push", s.uiCtx(uiWith(notify)));

		expect(push).toHaveBeenCalledWith(4_321);
		expect(pull).not.toHaveBeenCalled();
		expect(await readFile(join(s.dir, "Remote-note.md"), "utf8")).toContain("Remote note body");
		const tree = await git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]);
		expect(tree).toContain("Local-note.md");
		expect(tree).toContain("Remote-note.md");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Memory sync push:");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Result: ok");
		const prompt = sectionsEvent();
		await handlers["before_agent_start"][0](prompt, s.uiCtx());
		expect(prompt.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("renders duplicate lists from a failed command round and never rejects when UI notification throws", async () => {
		await enableSync();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		vi.spyOn(engine, "pull").mockResolvedValue(
			failedRound({
				pulled: ["z.md", "a.md", "z.md"],
				pushed: ["p.md", "p.md"],
				deletedLocal: ["d.md", "d.md"],
				deletedRemote: ["r.md", "r.md"],
				conflicts: [
					{ file: "c.md", keptAsNew: "c-copy.md" },
					{ file: "c.md", keptAsNew: "c-copy.md" },
				],
				rejected: [
					{ file: "bad.md", reason: "bad" },
					{ file: "bad.md", reason: "bad" },
				],
				unparsableLocal: ["u.md", "u.md"],
				outOfScopeRemote: ["MEMORY.md", "MEMORY.md"],
			}),
		);
		const notify = vi.fn();

		await expect(commands["memory"].handler("sync pull", s.uiCtx(uiWith(notify)))).resolves.toBeUndefined();

		const text = notify.mock.calls[0][0] as string;
		expect(text).toContain("Memory sync pull failed:");
		expect(text).toContain("controlled publish failure");
		expect(text).toContain("Pulled (2): a.md, z.md");
		expect(text).toContain("Pushed (1): p.md");
		expect(text).toContain("Deleted local (1): d.md");
		expect(text).toContain("Deleted remote (1): r.md");
		expect(text).toContain("Conflicts (1):\n- c.md -> c-copy.md");
		expect(text).toContain("Rejected (1):\n- bad.md: bad");
		expect(text).toContain("Unparsable local (1): u.md");
		expect(text).toContain("Out of scope remote (1): MEMORY.md");
		expect(text).not.toContain("Revision:");

		notify.mockImplementation(() => {
			throw new Error("disposed UI");
		});
		await expect(commands["memory"].handler("sync pull", s.uiCtx(uiWith(notify)))).resolves.toBeUndefined();
	});

	it("changeRemote resets a nonempty baseline to the current origin revision and can publish without the old base", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime, errors } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		await store.addEntry({ name: "Local", description: "local", body: "body" });
		expect((await prepared.engine.push(10_000)).ok).toBe(true);
		const paths = syncPaths();
		expect(Object.keys((await readManifest(paths.manifest))?.files ?? {})).toHaveLength(1);
		const nextRemote = join(s.cwd, "next.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		const init = vi.spyOn(runtime.backend, "init");

		const changed = await runtime.changeRemote(nextRemote, 4_321);

		if (!changed.ok) throw new Error(`changeRemote failed: ${changed.reason}`);
		expect(init).toHaveBeenCalledTimes(1);
		expect(init.mock.calls[0][0].timeoutMs).toBe(4_321);
		expect(await runtime.backend.getRemote()).toBe(nextRemote);
		expect(await readManifest(paths.manifest)).toEqual({
			version: 2,
			transport: syncTransport(nextRemote, "main"),
			base: { revision: "", syncedAt: expect.any(String) },
			files: {},
		});
		expect((await changed.engine.push(10_000)).ok).toBe(true);
		expect(await git(["ls-remote", nextRemote])).not.toBe("");
		runtime.dispose();
	});

	it("keeps baseline reset pending after origin revalidation fails and retries it in prepare", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		const paths = syncPaths();
		const nextRemote = join(s.cwd, "recovery.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		const init = vi
			.spyOn(runtime.backend, "init")
			.mockRejectedValueOnce(new Error("revalidate https://user:super-secret@example.invalid/x failed"));

		const changed = await runtime.changeRemote(nextRemote, 10_000);

		expect(changed.ok).toBe(false);
		if (changed.ok) throw new Error("unexpected remote change success");
		expect(changed.reason).toContain("https://user:***@example.invalid/x");
		expect(changed.reason).not.toContain("super-secret");
		expect(runtime.engine).not.toBeNull();
		expect(await readManifest(paths.manifest)).toBeNull();

		const recovered = await runtime.prepare(10_000);
		if (!recovered.ok) throw new Error(`recovery failed: ${recovered.reason}`);
		expect(init).toHaveBeenCalledTimes(2);
		expect(await runtime.backend.getRemote()).toBe(nextRemote);
		expect((await readManifest(paths.manifest))?.base.revision).toBe("");
		expect((await readManifest(paths.manifest))?.files).toEqual({});
		expect((await recovered.engine.push(10_000)).ok).toBe(true);
		runtime.dispose();
	});

	it("leaves the manifest missing and retries revalidation after the empty baseline write fails", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		const paths = syncPaths();
		syncManifestWriteFailure.current = new Error("controlled manifest write failure");
		const nextRemote = join(s.cwd, "manifest-recovery.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		const init = vi.spyOn(runtime.backend, "init");

		const changed = await runtime.changeRemote(nextRemote, 10_000);
		expect(changed.ok).toBe(false);
		expect(changed.ok ? "" : changed.reason).toContain("controlled manifest write failure");
		expect(runtime.engine).not.toBeNull();
		expect(await readManifest(paths.manifest)).toBeNull();

		const recovered = await runtime.prepare(10_000);
		if (!recovered.ok) throw new Error(`recovery failed: ${recovered.reason}`);
		expect(init).toHaveBeenCalledTimes(2);
		expect(await readManifest(paths.manifest)).toEqual({
			version: 2,
			transport: syncTransport(nextRemote, "main"),
			base: { revision: "", syncedAt: expect.any(String) },
			files: {},
		});
		runtime.dispose();
	});

	it("a new runtime never reuses the old base after revalidation fails following manifest invalidation", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		await store.addEntry({ name: "Local", description: "local", body: "must survive" });
		expect((await prepared.engine.push(10_000)).ok).toBe(true);
		const paths = syncPaths();
		expect(Object.keys((await readManifest(paths.manifest))?.files ?? {})).toHaveLength(1);
		const nextRemote = join(s.cwd, "restart-after-init-failure.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		vi.spyOn(runtime.backend, "init").mockRejectedValueOnce(new Error("controlled revalidation failure"));

		const changed = await runtime.changeRemote(nextRemote, 10_000);
		expect(changed.ok).toBe(false);
		runtime.dispose();

		const restarted = await syncApi.createPiSyncRuntime({
			config,
			store: newStore(config),
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!restarted.runtime) throw new Error("restarted runtime was not created");
		const restartedPrepare = await restarted.runtime.prepare(10_000);
		if (!restartedPrepare.ok) throw new Error(`restarted prepare failed: ${restartedPrepare.reason}`);
		const baselineAfterRestart = await readManifest(paths.manifest);
		expect((await restartedPrepare.engine.pull(10_000)).ok).toBe(true);

		expect(baselineAfterRestart).toEqual({
			version: 2,
			transport: syncTransport(nextRemote, "main"),
			base: { revision: "", syncedAt: expect.any(String) },
			files: {},
		});
		expect(await readFile(join(s.dir, "Local.md"), "utf8")).toContain("must survive");
		restarted.runtime.dispose();
	});

	it("a restart after setRemote but before init converges from an empty base without deleting local entries", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		await store.addEntry({ name: "Local", description: "local", body: "survives crash window" });
		expect((await prepared.engine.push(10_000)).ok).toBe(true);
		const paths = syncPaths();
		const nextRemote = join(s.cwd, "crash-before-init.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		let markInitStarted!: () => void;
		const initStarted = new Promise<void>((resolveStarted) => {
			markInitStarted = resolveStarted;
		});
		vi.spyOn(runtime.backend, "init").mockImplementation(({ signal }) => {
			markInitStarted();
			return new Promise<never>((_resolve, reject) => {
				const stop = () => reject(new Error("process stopped before init"));
				if (signal?.aborted) stop();
				else signal?.addEventListener("abort", stop, { once: true });
			});
		});

		const changing = runtime.changeRemote(nextRemote, 10_000);
		await initStarted;
		expect(await runtime.backend.getRemote()).toBe(nextRemote);
		runtime.dispose();
		await changing;
		expect(await readManifest(paths.manifest)).toBeNull();

		const restarted = await syncApi.createPiSyncRuntime({
			config,
			store: newStore(config),
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!restarted.runtime) throw new Error("restarted runtime was not created");
		const restartedPrepare = await restarted.runtime.prepare(10_000);
		if (!restartedPrepare.ok) throw new Error(`restarted prepare failed: ${restartedPrepare.reason}`);
		expect((await restartedPrepare.engine.pull(10_000)).ok).toBe(true);
		expect(await readFile(join(s.dir, "Local.md"), "utf8")).toContain("survives crash window");
		restarted.runtime.dispose();
	});

	it("does not mutate origin when manifest invalidation fails and still restores one write trigger", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		const paths = syncPaths();
		const backup = `${paths.manifest}.backup`;
		await rename(paths.manifest, backup);
		await mkdir(paths.manifest);
		const nextRemote = join(s.cwd, "invalidation-failure.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		const setRemote = vi.spyOn(runtime.backend, "setRemote");
		syncEvents.length = 0;

		const changed = await runtime.changeRemote(nextRemote, 10_000);

		expect(changed.ok).toBe(false);
		expect(setRemote).not.toHaveBeenCalled();
		expect(await runtime.backend.getRemote()).toBe(remote);
		expect(runtime.engine).not.toBeNull();
		expect(syncEvents.filter((event) => event === "noteWrite")).toHaveLength(1);
		runtime.dispose();
	});

	it("a second concurrent remote URL gets busy instead of sharing the first change's success", async () => {
		const config = memoryConfig();
		const store = newStore(config);
		const { runtime } = await syncApi.createPiSyncRuntime({
			config,
			store,
			projectDir: s.dir,
			identity: gitIdentity(s.cwd),
		});
		if (!runtime) throw new Error("runtime was not created");
		const prepared = await runtime.prepare(10_000);
		if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
		const firstRemote = join(s.cwd, "busy-first.git");
		const secondRemote = join(s.cwd, "busy-second.git");
		await git(["init", "--bare", "--quiet", firstRemote]);
		await git(["init", "--bare", "--quiet", secondRemote]);
		let release!: () => void;
		syncInitBarrier.current = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});

		const first = runtime.changeRemote(firstRemote, 10_000);
		await waitFor(() => syncEvents.includes("init:start"), "first remote change to reach init");
		const pending = Symbol("second change was coalesced");
		const second = await Promise.race([runtime.changeRemote(secondRemote, 10_000), Promise.resolve(pending)]);
		release();
		const firstResult = await first;
		syncInitBarrier.current = null;
		const originAfterFirst = await runtime.backend.getRemote();
		const later = await runtime.changeRemote(secondRemote, 10_000);
		const originAfterLater = await runtime.backend.getRemote();
		runtime.dispose();

		expect(second).not.toBe(pending);
		if (second === pending) throw new Error("second change was coalesced");
		expect(second.ok).toBe(false);
		expect(second.ok ? "" : second.reason).toContain("already in progress");
		expect(firstResult.ok).toBe(true);
		expect(originAfterFirst).toBe(firstRemote);
		expect(later.ok).toBe(true);
		expect(originAfterLater).toBe(secondRemote);
	});

	it("remote change drains a manual round and the disposed engine inFlight before any old-base write can win", async () => {
		await enableSync();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		await tools[0].execute(
			"old-base-add",
			{ action: "add", name: "Old base", description: "local", content: "body" },
			undefined,
			undefined,
			undefined,
		);
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		expect((await engine.push(10_000)).ok).toBe(true);
		const paths = syncPaths();
		const oldManifest = await readManifest(paths.manifest);
		if (!oldManifest) throw new Error("old manifest was not written");
		let releasePull!: () => void;
		const pullGate = new Promise<void>((resolveGate) => {
			releasePull = resolveGate;
		});
		let releaseAutomatic!: () => void;
		const automaticGate = new Promise<void>((resolveGate) => {
			releaseAutomatic = resolveGate;
		});
		const oldRound = automaticGate.then(() => writeManifest(paths.manifest, oldManifest));
		vi.spyOn(engine, "inFlight", "get").mockReturnValue(oldRound);
		const dispose = vi.spyOn(engine, "dispose");
		const pull = vi.spyOn(engine, "pull").mockImplementation(async () => {
			await pullGate;
			await writeManifest(paths.manifest, oldManifest);
			return { ...failedRound(), ok: true, skipped: undefined };
		});
		const nextRemote = join(s.cwd, "drain-before-change.git");
		await git(["init", "--bare", "--quiet", nextRemote]);

		const manual = commands["memory"].handler("sync pull", s.uiCtx());
		await waitFor(() => pull.mock.calls.length === 1, "manual pull to start");
		const changing = commands["memory"].handler(`sync remote ${nextRemote}`, s.uiCtx());
		await flush();
		await flush();
		const originBeforeManualRelease = await git(["remote", "get-url", "origin"], join(paths.syncRoot, "repo"));
		const manifestBeforeManualRelease = await readManifest(paths.manifest);

		releasePull();
		await waitFor(() => dispose.mock.calls.length === 1, "old engine disposal after manual pull");
		await flush();
		const originBeforeAutomaticRelease = await git(["remote", "get-url", "origin"], join(paths.syncRoot, "repo"));
		releaseAutomatic();
		await Promise.all([manual, changing, oldRound]);

		expect(originBeforeManualRelease).toBe(remote);
		expect(manifestBeforeManualRelease).toEqual(oldManifest);
		expect(originBeforeAutomaticRelease).toBe(remote);
		expect(await git(["remote", "get-url", "origin"], join(paths.syncRoot, "repo"))).toBe(nextRemote);
		expect(await readManifest(paths.manifest)).toEqual({
			version: 2,
			transport: syncTransport(nextRemote, "main"),
			base: { revision: "", syncedAt: expect.any(String) },
			files: {},
		});
	});

	it("a successful remote change transfers dirty and blocked writes through exactly one replacement noteWrite", async () => {
		await enableSync({ pushOnWrite: true, pushDebounceMs: 60_000 });
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const oldEngine = syncEngines.at(-1);
		if (!oldEngine) throw new Error("sync engine was not prepared");
		oldEngine.noteWrite();
		const nextRemote = join(s.cwd, "successful-trigger.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		let releaseInit!: () => void;
		syncInitBarrier.current = new Promise<void>((resolveGate) => {
			releaseInit = resolveGate;
		});
		const changing = commands["memory"].handler(`sync remote ${nextRemote}`, s.uiCtx());
		await waitFor(() => syncEvents.includes("init:start"), "remote revalidation to block");
		await tools[0].execute(
			"during-successful-change",
			{ action: "add", name: "During success", description: "local", content: "must auto publish" },
			undefined,
			undefined,
			undefined,
		);
		syncEvents.length = 0;
		syncInitBarrier.current = null;
		releaseInit();
		await changing;
		const replacementTriggers = syncEvents.filter((event) => event === "noteWrite").length;

		await handlers["session_shutdown"][0]({ reason: "quit" }, s.uiCtx());

		expect(replacementTriggers).toBe(1);
		expect(syncEngines.at(-1)).not.toBe(oldEngine);
		expect(await git(["--git-dir", nextRemote, "ls-tree", "-r", "--name-only", "main"])).toContain(
			"During-success.md",
		);
	});

	it("a failed remote change restores exactly one noteWrite and keeps later writes auto-publishable", async () => {
		await enableSync({ pushOnWrite: true, pushDebounceMs: 60_000 });
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		const oldEngine = syncEngines.at(-1);
		if (!oldEngine) throw new Error("sync engine was not prepared");
		oldEngine.noteWrite();
		const nextRemote = join(s.cwd, "failed-trigger.git");
		let releaseInit!: () => void;
		syncInitBarrier.current = new Promise<void>((resolveGate) => {
			releaseInit = resolveGate;
		});
		const changing = commands["memory"].handler(`sync remote ${nextRemote}`, s.uiCtx());
		await waitFor(() => syncEvents.includes("init:start"), "failed remote revalidation to block");
		await tools[0].execute(
			"during-failed-change",
			{ action: "add", name: "During failure", description: "local", content: "must survive" },
			undefined,
			undefined,
			undefined,
		);
		syncEvents.length = 0;
		syncInitBarrier.current = null;
		releaseInit();
		await changing;
		const replacementTriggers = syncEvents.filter((event) => event === "noteWrite").length;

		await git(["init", "--bare", "--quiet", nextRemote]);
		await commands["memory"].handler("sync pull", s.uiCtx());
		const triggersAfterRecovery = syncEvents.filter((event) => event === "noteWrite").length;
		syncEvents.length = 0;
		await tools[0].execute(
			"after-failed-change",
			{ action: "add", name: "After failure", description: "local", content: "new write" },
			undefined,
			undefined,
			undefined,
		);
		const newWriteTriggers = syncEvents.filter((event) => event === "noteWrite").length;
		await handlers["session_shutdown"][0]({ reason: "quit" }, s.uiCtx());

		expect(replacementTriggers).toBe(1);
		expect(triggersAfterRecovery).toBe(1);
		expect(newWriteTriggers).toBe(1);
		const tree = await git(["--git-dir", nextRemote, "ls-tree", "-r", "--name-only", "main"]);
		expect(tree).toContain("During-failure.md");
		expect(tree).toContain("After-failure.md");
	});

	it("/memory sync remote leaves memory.json untouched and the next status reports drift while using origin", async () => {
		await enableSync();
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		await tools[0].execute(
			"remote-add",
			{ action: "add", name: "Remote reset", description: "local", content: "body" },
			undefined,
			undefined,
			undefined,
		);
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		expect((await engine.push(10_000)).ok).toBe(true);
		const nextRemote = join(s.cwd, "command-next.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		const configPath = join(s.agentDir, "memory.json");
		const configBefore = await readFile(configPath, "utf8");

		await commands["memory"].handler(`sync remote ${nextRemote}`, s.uiCtx(uiWith(notify)));

		expect(await readFile(configPath, "utf8")).toBe(configBefore);
		const paths = syncPaths();
		const repo = join(paths.syncRoot, "repo");
		expect(await git(["remote", "get-url", "origin"], repo)).toBe(nextRemote);
		expect((await readManifest(paths.manifest))?.base.revision).toBe("");
		expect((await readManifest(paths.manifest))?.files).toEqual({});
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Memory sync remote:");

		await commands["memory"].handler("sync status", s.uiCtx(uiWith(notify)));
		const status = notify.mock.calls.at(-1)?.[0] as string;
		expect(status).toContain(`Origin: ${nextRemote}`);
		expect(status).toContain(`Configured remote: ${remote}`);
		expect(status).toContain("continuing to use origin");

		await commands["memory"].handler("sync push", s.uiCtx(uiWith(notify)));
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Result: ok");
		expect(await git(["--git-dir", nextRemote, "ls-tree", "-r", "--name-only", "main"])).toContain(
			"Remote-reset.md",
		);
	});

	it("shows actionable usage for missing, extra, removed, and unknown subcommands", async () => {
		await enableSync();
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		for (const args of [
			"sync remote",
			"sync remote one two",
			"sync status extra",
			"sync pull extra",
			"sync push extra",
			"sync unlock extra",
			"sync init",
			"sync unknown",
		]) {
			await expect(commands["memory"].handler(args, s.uiCtx(uiWith(notify)))).resolves.toBeUndefined();
			expect(notify.mock.calls.at(-1)?.[0], args).toContain("Usage: /memory sync");
		}
	});

	it("explains disabled sync and non-git projects without throwing", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		await commands["memory"].handler("sync", s.uiCtx(uiWith(notify)));
		expect(notify.mock.calls.at(-1)?.[0]).toContain('set "sync.enabled"');
		expect(notify.mock.calls.at(-1)?.[0]).toContain("memory.json");

		projectIdentityMock.mockResolvedValueOnce({ kind: "local", key: s.cwd });
		await enableSync();
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		await commands["memory"].handler("sync", s.uiCtx(uiWith(notify)));
		expect(notify.mock.calls.at(-1)?.[0]).toContain("v1 only supports git projects");
	});

	it("shows the real model config error before generic sync-disabled text", async () => {
		await s.writeConfig({ defaults: { sessionPersistence: { enabled: false } } });
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());

		for (const args of ["sync", "sync pull", "sync push", `sync remote ${remote}`]) {
			await commands["memory"].handler(args, s.uiCtx(uiWith(notify)));
			const text = notify.mock.calls.at(-1)?.[0] as string;
			expect(text).toContain("no model for dream");
			expect(text).not.toContain("sync is not enabled");
		}
	});

	it("sync unlock confirms the root holder and removes only sync.lock even with model config errors", async () => {
		for (const confirmed of [false, true]) {
			await s.writeConfig({ defaults: { sessionPersistence: { enabled: false } } });
			const notify = vi.fn();
			const confirm = vi.fn().mockResolvedValue(confirmed);
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			const rootLock = syncLockPath(syncRootPath(resolve(s.memoryDirRoot)));
			await mkdir(join(rootLock, ".."), { recursive: true });
			await writeFile(
				rootLock,
				JSON.stringify({ pid: 4242, hostname: "sync-host", startedAt: "2026-10-02T01:02:03.000Z", op: "sync" }),
				"utf8",
			);
			await writeFile(join(rootLock, "..", "keep.json"), "keep", "utf8");
			await writeFile(join(s.dir, ".lock"), "project lock", "utf8");
			await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());

			await commands["memory"].handler(
				"sync unlock",
				s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }),
			);

			expect(confirm).toHaveBeenCalledWith(
				"Memory sync lock",
				"Remove the memory sync lock file? It is held by sync (pid 4242 on sync-host, started 2026-10-02T01:02:03.000Z). Only do this if no memory sync operation is running.",
			);
			expect(await stat(join(s.dir, ".lock"))).toBeDefined();
			expect(await stat(join(rootLock, "..", "keep.json"))).toBeDefined();
			if (confirmed) {
				await expect(stat(rootLock)).rejects.toMatchObject({ code: "ENOENT" });
				expect(notify).toHaveBeenCalledWith("Memory sync lock removed.", "info");
				await rm(rootLock, { force: true });
			} else {
				expect(await stat(rootLock)).toBeDefined();
				expect(notify).not.toHaveBeenCalled();
				await rm(rootLock, { force: true });
			}
		}
	});

	it("sync unlock is ENOENT-idempotent and does not ask for confirmation without a lock", async () => {
		const notify = vi.fn();
		const confirm = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());

		await commands["memory"].handler(
			"sync unlock",
			s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }),
		);

		expect(confirm).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("No lock present.", "info");
	});
});
