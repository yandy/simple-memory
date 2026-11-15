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
} from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakePi,
	DISK_INDEX,
	enableTestSync,
	gitIdentity,
	projectIdentityMock,
	resetWiringMocks,
	sectionsEvent,
	setupSession,
	syncEngines,
	syncEvents,
	uiWith,
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
			version: 1,
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
		const before = await readFile(paths.manifest, "utf8");
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
		expect(runtime.engine).toBeNull();
		expect(await readFile(paths.manifest, "utf8")).toBe(before);

		const recovered = await runtime.prepare(10_000);
		if (!recovered.ok) throw new Error(`recovery failed: ${recovered.reason}`);
		expect(init).toHaveBeenCalledTimes(2);
		expect(await runtime.backend.getRemote()).toBe(nextRemote);
		expect((await readManifest(paths.manifest))?.base.revision).toBe("");
		expect((await readManifest(paths.manifest))?.files).toEqual({});
		expect((await recovered.engine.push(10_000)).ok).toBe(true);
		runtime.dispose();
	});

	it("retries both revalidation and the empty baseline write after a real manifest write failure", async () => {
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
		const nextRemote = join(s.cwd, "manifest-recovery.git");
		await git(["init", "--bare", "--quiet", nextRemote]);
		const init = vi.spyOn(runtime.backend, "init");

		const changed = await runtime.changeRemote(nextRemote, 10_000);
		expect(changed.ok).toBe(false);
		expect(runtime.engine).toBeNull();

		await rm(paths.manifest, { recursive: true });
		await rename(backup, paths.manifest);
		const recovered = await runtime.prepare(10_000);
		if (!recovered.ok) throw new Error(`recovery failed: ${recovered.reason}`);
		expect(init).toHaveBeenCalledTimes(2);
		expect(await readManifest(paths.manifest)).toEqual({
			version: 1,
			base: { revision: "", syncedAt: expect.any(String) },
			files: {},
		});
		runtime.dispose();
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
