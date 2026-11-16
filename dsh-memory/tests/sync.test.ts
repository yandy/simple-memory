import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	DEFAULT_CONFIG,
	devicePath,
	gitAvailable,
	manifestPath,
	MemoryStore,
	readManifest,
	remoteProjectKey,
	syncRootPath,
} from "@yandy0725/memory-core";
import type { MemoryConfig, ProjectIdentity, SyncConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDshSyncRuntime } from "../src/sync.js";
import type { DshSyncRuntime } from "../src/sync.js";

const execFileP = promisify(execFile);
const GIT = await gitAvailable();
const IDENTITY: ProjectIdentity = { kind: "git", key: "example.com/owner/repo" };
const PROJECT_KEY = "example.com__owner__repo";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolvePromiseFn) => {
		resolvePromise = resolvePromiseFn;
	});
	return { promise, resolve: resolvePromise };
}

describe.skipIf(!GIT)("dsh sync runtime", { timeout: 60_000 }, () => {
	let dir: string;
	let remote: string;
	let secondRemote: string;
	let thirdRemote: string;
	let runtimes: DshSyncRuntime[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "am-dsh-sync-"));
		const emptyGitConfig = join(dir, "gitconfig-empty");
		await writeFile(emptyGitConfig, "", "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		remote = join(dir, "remote.git");
		secondRemote = join(dir, "second.git");
		thirdRemote = join(dir, "third.git");
		for (const path of [remote, secondRemote, thirdRemote]) {
			await execFileP("git", ["init", "--bare", "--quiet", "--initial-branch=main", path]);
		}
		runtimes = [];
	});

	afterEach(async () => {
		for (const runtime of runtimes.reverse()) await runtime.dispose();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	function config(over: Partial<SyncConfig> = {}, memoryDir = join(dir, "memory-root")): MemoryConfig {
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
				pushDebounceMs: 10,
				autoTimeoutMs: 10_000,
				timeoutMs: 10_000,
				...over,
			},
		};
	}

	function storeFor(cfg: MemoryConfig, projectDir = join(dir, "project-memory")): MemoryStore {
		return new MemoryStore({
			memoryDir: projectDir,
			indexMaxLines: cfg.memIndexMaxLines,
			indexMaxBytes: cfg.memIndexMaxBytes,
			lock: cfg.lock,
		});
	}

	async function makeRuntime(
		cfg: MemoryConfig,
		store = storeFor(cfg),
		identity = IDENTITY,
		projectDir = join(dir, "project-memory"),
	): Promise<{ runtime: DshSyncRuntime | null; errors: string[]; notices: string[] }> {
		const assembled = await createDshSyncRuntime({
			config: cfg,
			store,
			projectDir,
			identity,
			now: () => new Date("2026-11-16T01:02:03.000Z"),
		});
		if (assembled.runtime) runtimes.push(assembled.runtime);
		return assembled;
	}

	function paths(cfg: MemoryConfig) {
		const syncRoot = syncRootPath(resolve(cfg.memoryDir));
		return {
			syncRoot,
			manifest: manifestPath(syncRoot, remoteProjectKey(IDENTITY.key)),
			device: devicePath(syncRoot),
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

	async function remoteFile(remotePath: string, file: string): Promise<string> {
		const { stdout } = await execFileP("git", [
			"--git-dir",
			remotePath,
			"show",
			`main:git/${PROJECT_KEY}/${file}`,
		]);
		return stdout;
	}

	function remoteHash(remotePath: string): string {
		return createHash("sha256").update(remotePath).digest("hex");
	}

	async function seedRemote(fileName = "Remote-note.md"): Promise<void> {
		const cfg = config({}, join(dir, "seed-root"));
		const store = storeFor(cfg, join(dir, "seed-project"));
		await store.addEntry({ name: "Remote note", description: "from another device", body: "remote body" });
		const { runtime, errors } = await makeRuntime(cfg, store, IDENTITY, join(dir, "seed-project"));
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("seed runtime was not created");
		expect((await runtime.startup()).ok).toBe(true);
		const pushed = await runtime.run("push", 10_000);
		expect(pushed).toMatchObject({ ok: true, value: { ok: true } });
		await expect(remoteFile(remote, fileName)).resolves.toContain("remote body");
	}

	it("gates disabled, non-git and invalid sync without creating sync state", async () => {
		const disabled = await makeRuntime(config({ enabled: false, remote: "" }));
		expect(disabled).toEqual({ runtime: null, errors: [], notices: [] });

		const nonGit = await makeRuntime(config(), storeFor(config()), { kind: "local", key: resolve(dir) });
		expect(nonGit.runtime).toBeNull();
		expect(nonGit.errors).toEqual([]);
		expect(nonGit.notices.join("\n")).toContain("only supports git projects");

		const invalid = await makeRuntime(config({ remote: "" }));
		expect(invalid.runtime).toBeNull();
		expect(invalid.errors.join("\n")).toContain('"sync.remote" is empty');
		expect(invalid.errors.join("\n")).toContain("plugin row config");
		expect(invalid.errors.join("\n")).not.toContain("memory.json");
		expect(await exists(syncRootPath(resolve(dir, "memory-root")))).toBe(false);
	});

	it("keeps status dry-run, initializes a v2 empty baseline lazily, and does not init twice", async () => {
		const cfg = config();
		const { runtime, errors } = await makeRuntime(cfg);
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("runtime was not created");
		const state = paths(cfg);
		expect(runtime.engine).toBeNull();
		expect(await exists(state.device)).toBe(false);

		const dry = await runtime.status(10_000);
		expect(dry).toEqual({ ok: true, value: { initialized: false, origin: null } });
		expect(await exists(state.syncRoot)).toBe(false);
		expect(await exists(state.manifest)).toBe(false);

		const init = vi.spyOn(runtime.backend, "init");
		expect((await runtime.startup()).ok).toBe(true);
		expect(init).toHaveBeenCalledTimes(1);
		expect(runtime.engine).not.toBeNull();
		expect(await readFile(state.device, "utf8")).toContain("2026-11-16T01:02:03.000Z");
		const initializedRevision = (
			await execFileP("git", ["--git-dir", remote, "rev-parse", "main"])
		).stdout.trim();
		expect(initializedRevision).not.toBe("");
		expect(await readManifest(state.manifest)).toEqual({
			version: 2,
			transport: { remoteHash: remoteHash(remote), branch: "main" },
			base: { revision: initializedRevision, syncedAt: "2026-11-16T01:02:03.000Z" },
			files: {},
		});

		expect((await runtime.startup()).ok).toBe(true);
		expect(init).toHaveBeenCalledTimes(1);
	});

	it("runs one startup push that converges remote and previously unpublished local entries", async () => {
		await seedRemote();
		const cfg = config({ pullOnStart: true });
		const store = storeFor(cfg);
		await store.addEntry({ name: "Local note", description: "from this device", body: "local body" });
		const { runtime } = await makeRuntime(cfg, store);
		if (!runtime) throw new Error("runtime was not created");

		const started = await runtime.startup();
		expect(started).toMatchObject({
			ok: true,
			value: { ok: true, pulled: ["Remote-note.md"], pushed: ["Local-note.md"] },
		});
		expect((await store.listEntries()).map((entry) => entry.name).sort()).toEqual(["Local note", "Remote note"]);
		await expect(remoteFile(remote, "Local-note.md")).resolves.toContain("local body");
		await expect(remoteFile(remote, "Remote-note.md")).resolves.toContain("remote body");
	});

	it("spends one automatic budget across preparation and startup push", async () => {
		await seedRemote();
		const cfg = config({ pullOnStart: true, autoTimeoutMs: 10_000 });
		const store = storeFor(cfg);
		const { runtime } = await makeRuntime(cfg, store);
		if (!runtime) throw new Error("runtime was not created");
		// prepare 完成时预算已经耗尽；若实现另给 push 一份完整预算，这条就会拉回 Remote note。
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(99_000);

		const started = await runtime.startup();
		expect(started.ok).toBe(true);
		if (started.ok) {
			expect(started.value).toBeNull();
			expect(started.warning).toContain("automatic startup budget");
		}
		expect(await store.listEntries()).toEqual([]);
	});

	it("continues to use the initialized origin when the configured remote drifts", async () => {
		const firstConfig = config();
		const firstStore = storeFor(firstConfig);
		const first = await makeRuntime(firstConfig, firstStore);
		if (!first.runtime) throw new Error("first runtime was not created");
		expect((await first.runtime.startup()).ok).toBe(true);
		await firstStore.addEntry({ name: "One", description: "first", body: "one" });
		expect((await first.runtime.run("push", 10_000)).ok).toBe(true);
		await first.runtime.dispose();

		const drifted = config({ remote: secondRemote });
		const driftStore = storeFor(drifted);
		const second = await makeRuntime(drifted, driftStore);
		expect(second.errors.join("\n")).toContain("continuing to use origin");
		if (!second.runtime) throw new Error("drifted runtime was not created");
		expect((await second.runtime.startup()).ok).toBe(true);
		await driftStore.addEntry({ name: "Two", description: "second", body: "two" });
		expect((await second.runtime.run("push", 10_000)).ok).toBe(true);

		await expect(remoteFile(remote, "Two.md")).resolves.toContain("two");
		await expect(remoteFile(secondRemote, "Two.md")).rejects.toThrow();
		expect((await readManifest(paths(drifted).manifest))?.transport.remoteHash).toBe(remoteHash(remote));
	});

	it("changes origin with an empty v2 baseline and never publishes the replacement delta to the old origin", async () => {
		const cfg = config();
		const store = storeFor(cfg);
		const { runtime } = await makeRuntime(cfg, store);
		if (!runtime) throw new Error("runtime was not created");
		expect((await runtime.startup()).ok).toBe(true);
		await store.addEntry({ name: "Before", description: "before", body: "before" });
		expect((await runtime.run("push", 10_000)).ok).toBe(true);

		const changed = await runtime.changeRemote(secondRemote, 10_000);
		expect(changed).toEqual({
			ok: true,
			value: null,
			warning:
				"Memory sync initialized with 1 local entry; same-named entries with different content may be kept as deterministic conflict copies.",
		});
		expect(await runtime.backend.getRemote()).toBe(secondRemote);
		expect(await readManifest(paths(cfg).manifest)).toMatchObject({
			version: 2,
			transport: { remoteHash: remoteHash(secondRemote), branch: "main" },
			files: {},
		});

		await store.addEntry({ name: "After", description: "after", body: "after" });
		expect((await runtime.run("push", 10_000)).ok).toBe(true);
		await expect(remoteFile(secondRemote, "After.md")).resolves.toContain("after");
		await expect(remoteFile(remote, "After.md")).rejects.toThrow();
	});

	it("rejects a second remote URL while a remote change is active", async () => {
		const cfg = config();
		const { runtime } = await makeRuntime(cfg, storeFor(cfg));
		if (!runtime) throw new Error("runtime was not created");
		expect((await runtime.startup()).ok).toBe(true);
		const original = runtime.backend.setRemote.bind(runtime.backend);
		const entered = deferred();
		const release = deferred();
		vi.spyOn(runtime.backend, "setRemote").mockImplementation(async (url, options) => {
			entered.resolve();
			await release.promise;
			await original(url, options);
		});

		const first = runtime.changeRemote(secondRemote, 10_000);
		await entered.promise;
		const second = await runtime.changeRemote(thirdRemote, 10_000);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.reason).toContain("already in progress");
		release.resolve();
		expect((await first).ok).toBe(true);
		expect(await runtime.backend.getRemote()).toBe(secondRemote);
	});

	it("drains the old automatic round and carries a gated write into the replacement engine", async () => {
		const cfg = config({ pushOnWrite: true, pushDebounceMs: 10 });
		const store = storeFor(cfg);
		const { runtime } = await makeRuntime(cfg, store);
		if (!runtime) throw new Error("runtime was not created");
		expect((await runtime.startup()).ok).toBe(true);
		const oldEngine = runtime.engine;
		if (!oldEngine) throw new Error("engine was not prepared");
		const oldRound = deferred();
		Object.defineProperty(oldEngine, "inFlight", { configurable: true, get: () => oldRound.promise });
		const original = runtime.backend.setRemote.bind(runtime.backend);
		const setRemote = vi.spyOn(runtime.backend, "setRemote");

		await store.addEntry({ name: "Gap write", description: "during remote change", body: "gap body" });
		const changed = runtime.changeRemote(secondRemote, 10_000);
		runtime.noteWrite();
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));
		expect(setRemote).not.toHaveBeenCalled();
		oldRound.resolve();
		expect((await changed).ok).toBe(true);

		await vi.waitFor(async () => {
			await expect(remoteFile(secondRemote, "Gap-write.md")).resolves.toContain("gap body");
		});
		await expect(remoteFile(remote, "Gap-write.md")).rejects.toThrow();
	});
});
