import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG, MemoryStore } from "@yandy0725/memory-core";
import type { MemoryConfig, SyncConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/index.js";
import { createDshSyncRuntime } from "../src/sync.js";
import { createFakeCtx } from "./helpers/fake-ctx.js";
import type { FakeCtxOptions } from "./helpers/fake-ctx.js";

const execFileP = promisify(execFile);
const PROJECT_KEY = "example.com__owner__repo";

type Fake = ReturnType<typeof createFakeCtx>;

describe("dsh sync wiring", { timeout: 60_000 }, () => {
	let dir: string;
	let root: string;
	let repo: string;
	let remote: string;
	let cleanups: Array<() => Promise<void>>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "am-dsh-sync-wiring-"));
		const emptyGitConfig = join(dir, "gitconfig-empty");
		await writeFile(emptyGitConfig, "", "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		root = join(dir, "memory-root");
		repo = join(dir, "repo");
		remote = join(dir, "sync-remote.git");
		await mkdir(repo, { recursive: true });
		await git(["init", "--quiet"], repo);
		await git(["remote", "add", "origin", "https://example.com/owner/repo.git"], repo);
		await git(["init", "--bare", "--quiet", "--initial-branch=main", remote]);
		cleanups = [];
	});

	afterEach(async () => {
		for (const cleanup of cleanups.reverse()) await cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	async function git(args: string[], cwd = dir): Promise<string> {
		const { stdout } = await execFileP("git", args, { cwd, timeout: 15_000 });
		return stdout.trim();
	}

	function syncConfig(over: Partial<SyncConfig> = {}): SyncConfig {
		return {
			...DEFAULT_CONFIG.sync,
			enabled: true,
			remote,
			branch: "main",
			pullOnStart: false,
			pushOnWrite: false,
			pushDebounceMs: 20,
			autoTimeoutMs: 10_000,
			timeoutMs: 10_000,
			...over,
		};
	}

	function rowConfig(syncOver: Partial<SyncConfig> = {}, extra: Record<string, unknown> = {}) {
		return { memoryDir: root, sync: syncConfig(syncOver), ...extra };
	}

	function coreConfig(memoryDir: string, syncOver: Partial<SyncConfig> = {}): MemoryConfig {
		return { ...DEFAULT_CONFIG, memoryDir, sync: syncConfig(syncOver) };
	}

	function storeAt(memoryDir: string, cfg: MemoryConfig): MemoryStore {
		return new MemoryStore({
			memoryDir,
			indexMaxLines: cfg.memIndexMaxLines,
			indexMaxBytes: cfg.memIndexMaxBytes,
			lock: cfg.lock,
		});
	}

	function localMemoryDir(): string {
		return join(resolve(root), "git", PROJECT_KEY);
	}

	async function setup(config: unknown, opts: FakeCtxOptions = {}): Promise<Fake> {
		const fake = createFakeCtx(opts);
		const dispose = await apply(fake.ctx, config);
		cleanups.push(async () => {
			dispose();
			fake.disposeAll();
			await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
		});
		return fake;
	}

	function sectionText(fake: Fake, agent: unknown): string {
		expect(fake.sections).toHaveLength(1);
		return (fake.sections[0].text as (context: unknown) => string)({ agent });
	}

	function memoryTool(fake: Fake, agentId: string) {
		const tool = (fake.agentTools.get(agentId) ?? []).find((candidate) => candidate.name === "memory");
		expect(tool).toBeDefined();
		return tool!;
	}

	function memoryCommand(fake: Fake, agent: unknown, rawInput = "") {
		const command = fake.commands.find((candidate) => candidate.name === "memory");
		expect(command).toBeDefined();
		return command!.handler({ agent, rawInput, signal: new AbortController().signal });
	}

	async function remoteFile(file: string, remotePath = remote): Promise<string> {
		return git(["--git-dir", remotePath, "show", `main:git/${PROJECT_KEY}/${file}`]);
	}

	async function seedRemote(): Promise<void> {
		const cfg = coreConfig(join(dir, "seed-root"));
		const store = storeAt(join(dir, "seed-project"), cfg);
		await store.addEntry({ name: "Remote note", description: "from another device", body: "remote body" });
		const { runtime, errors } = await createDshSyncRuntime({
			config: cfg,
			store,
			projectDir: join(dir, "seed-project"),
			identity: { kind: "git", key: "example.com/owner/repo" },
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("seed runtime was not created");
		expect((await runtime.startup()).ok).toBe(true);
		expect((await runtime.run("push", 10_000)).ok).toBe(true);
		await runtime.dispose();
		await expect(remoteFile("Remote-note.md")).resolves.toContain("remote body");
	}

	async function seedLocal(name = "Local note"): Promise<MemoryStore> {
		const cfg = coreConfig(root);
		const store = storeAt(localMemoryDir(), cfg);
		await store.addEntry({ name, description: "local only", body: "local body" });
		return store;
	}

	it("finishes startup convergence before the first index snapshot", async () => {
		await seedRemote();
		const fake = await setup(rowConfig({ pullOnStart: true }));
		const agent = fake.makeAgent({ id: "s1", cwd: repo });

		await fake.emitter.agentCreated(agent);

		expect(sectionText(fake, agent)).toContain("[Remote note](Remote-note.md)");
		const cfg = coreConfig(root);
		expect((await storeAt(localMemoryDir(), cfg).listEntries()).map((entry) => entry.name)).toContain("Remote note");
	});

	it("prepares without pulling when pullOnStart is false", async () => {
		await seedRemote();
		const fake = await setup(rowConfig({ pullOnStart: false }));
		const agent = fake.makeAgent({ id: "s1", cwd: repo });

		await fake.emitter.agentCreated(agent);

		expect(sectionText(fake, agent)).not.toContain("Remote note");
		expect(await stat(join(resolve(root), ".sync", "state", `${PROJECT_KEY}.json`))).toBeTruthy();
	});

	it.each(["empty-remote", "unreachable-remote"])(
		"keeps the local index and tool healthy after %s initialization failure",
		async (failure) => {
			await seedLocal();
			const configuredRemote = failure === "empty-remote" ? "" : join(dir, "missing", "remote.git");
			const fake = await setup(rowConfig({ remote: configuredRemote }));
			const agent = fake.makeAgent({ id: "s1", cwd: repo });

			await expect(fake.emitter.agentCreated(agent)).resolves.toBeUndefined();

			expect(sectionText(fake, agent)).toContain("Local note");
			const listed = await memoryTool(fake, "s1").execute({ action: "list" }, {});
			expect(listed.content).toContain("Local note");
			const status = await memoryCommand(fake, agent);
			expect(status.text).toContain("Sync error:");
			expect(status.text).toContain("plugin row config");
			const sync = await memoryCommand(fake, agent, "sync pull");
			expect(sync.kind).toBe("error");
			expect(sync.text).not.toContain("memory.json");
		},
	);

	it("degrades to local memory for a non-git project without creating sync state", async () => {
		const plain = join(dir, "plain");
		await mkdir(plain, { recursive: true });
		const fake = await setup(rowConfig({ pullOnStart: true }));
		const agent = fake.makeAgent({ id: "s1", cwd: plain });

		await fake.emitter.agentCreated(agent);
		const added = await memoryTool(fake, "s1").execute({ action: "add", name: "Local", content: "body" }, {});
		expect(added.content).toContain("Saved");
		const status = await memoryCommand(fake, agent);
		expect(status.text).toContain("Sync: disabled");
		expect(status.text).toContain("only supports git projects");
		expect(await stat(join(resolve(root), ".sync")).catch(() => null)).toBeNull();
	});

	it("pushes successful main-tool writes and ignores reads and failed writes", async () => {
		const fake = await setup(rowConfig({ pushOnWrite: true, pushDebounceMs: 20 }));
		const agent = fake.makeAgent({ id: "s1", cwd: repo });
		await fake.emitter.agentCreated(agent);
		const tool = memoryTool(fake, "s1");

		await tool.execute({ action: "add", name: "A", description: "first", content: "one" }, {});
		await vi.waitFor(async () => expect(await remoteFile("A.md")).toContain("one"));
		const addedRevision = await git(["--git-dir", remote, "rev-parse", "main"]);
		await tool.execute({ action: "list" }, {});
		await tool.execute({ action: "search", query: "one" }, {});
		await expect(tool.execute({ action: "add", name: "Broken", content: "" }, {})).rejects.toThrow();
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 60));
		expect(await git(["--git-dir", remote, "rev-parse", "main"])).toBe(addedRevision);

		await tool.execute({ action: "replace", name: "A", content: "two" }, {});
		await vi.waitFor(async () => expect(await remoteFile("A.md")).toContain("two"));
		await tool.execute({ action: "remove", name: "A" }, {});
		await vi.waitFor(async () => {
			await expect(remoteFile("A.md")).rejects.toThrow();
		});
	});

	it("uses the same write trigger for extract and dream worker tools, including rename and rebuild_index", async () => {
		const fake = await setup(
			rowConfig(
				{ pushOnWrite: true, pushDebounceMs: 20 },
				{
					defaults: { model: "prov/extract" },
					extractMemories: { enabled: true },
					dream: { model: "prov/dream" },
				},
			),
		);
		const agent = fake.makeAgent({ id: "s1", cwd: repo });
		await fake.emitter.agentCreated(agent);
		expect(fake.childSessions).toHaveLength(2);
		const nestedTools = fake.childSessions.map((child) => memoryTool(fake, `${child.sessionId}:child`));
		const hasRename = (tool: { parameters: unknown }): boolean => {
			const actions = (tool.parameters as { properties: { action: { enum?: readonly string[] } } }).properties.action
				.enum;
			return actions?.includes("rename") === true;
		};
		const dreamTool = nestedTools.find(hasRename);
		const extractTool = nestedTools.find((tool) => !hasRename(tool));
		expect(dreamTool).toBeDefined();
		expect(extractTool).toBeDefined();
		expect(dreamTool).not.toBe(extractTool);

		await extractTool!.execute({ action: "add", name: "Extract write", content: "from extract" }, {});
		await vi.waitFor(async () => expect(await remoteFile("Extract-write.md")).toContain("from extract"));
		await memoryTool(fake, "s1").execute({ action: "add", name: "Old", content: "before rename" }, {});
		await vi.waitFor(async () => expect(await remoteFile("Old.md")).toContain("before rename"));
		await dreamTool!.execute({ action: "rename", name: "Old", new_name: "New" }, {});
		await vi.waitFor(async () => expect(await remoteFile("New.md")).toContain("before rename"));
		await vi.waitFor(async () => {
			await expect(remoteFile("Old.md")).rejects.toThrow();
		});

		// rebuild_index 本身不同步 MEMORY.md；它触发 noteWrite 后，之前直接写盘的 entry 才到远端。
		const cfg = coreConfig(root);
		await storeAt(localMemoryDir(), cfg).addEntry({ name: "Pending", description: "direct", body: "pending body" });
		await dreamTool!.execute({ action: "rebuild_index" }, {});
		await vi.waitFor(async () => expect(await remoteFile("Pending.md")).toContain("pending body"));
	});

	it("cancels debounce on dispose and recovers the local write on the next agent creation", async () => {
		const fake = await setup(rowConfig({ pullOnStart: true, pushOnWrite: true, pushDebounceMs: 60 }));
		const agent = fake.makeAgent({ id: "s1", cwd: repo });
		await fake.emitter.agentCreated(agent);
		await memoryTool(fake, "s1").execute({ action: "add", name: "Pending", content: "recover me" }, {});

		fake.emitter.agentDisposed(agent);
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 120));
		await expect(remoteFile("Pending.md")).rejects.toThrow();

		const reborn = fake.makeAgent({ id: "s1", cwd: repo });
		await fake.emitter.agentCreated(reborn);
		await vi.waitFor(async () => expect(await remoteFile("Pending.md")).toContain("recover me"));
		fake.emitter.agentDisposed(reborn);
		expect((await memoryCommand(fake, reborn)).text).toContain("not initialized");
		expect((await memoryCommand(fake, reborn, "sync")).kind).toBe("error");
	});

	it("recovers on the next session start after a startup failure and pushes writes made while sync was down", async () => {
		const missingRemote = join(dir, "missing", "remote.git");
		const firstFake = await setup(rowConfig({ remote: missingRemote, pullOnStart: true }));
		const firstAgent = firstFake.makeAgent({ id: "s1", cwd: repo });
		await firstFake.emitter.agentCreated(firstAgent);

		// 同步初始化失败（远端不存在），但本地记忆照常可写 —— 这条写入此时无处可推。
		const added = await memoryTool(firstFake, "s1").execute(
			{ action: "add", name: "Pending", content: "written while sync was down" },
			{},
		);
		expect(added.content).toContain("Saved");
		await expect(remoteFile("Pending.md", missingRemote)).rejects.toThrow();

		// 「修好网络/配置」：真的建出这个 bare 远端，然后用同一份记忆根重新装配一次，
		// 等价于用户改好配置后的下一次会话/进程启动（spec §6.12 的失败恢复路径）。
		await mkdir(join(dir, "missing"), { recursive: true });
		await git(["init", "--bare", "--quiet", "--initial-branch=main", missingRemote]);

		const secondFake = await setup(rowConfig({ remote: missingRemote, pullOnStart: true }));
		const secondAgent = secondFake.makeAgent({ id: "s2", cwd: repo });
		await secondFake.emitter.agentCreated(secondAgent);

		await vi.waitFor(async () => {
			await expect(remoteFile("Pending.md", missingRemote)).resolves.toContain("written while sync was down");
		});
	});

	it("disposes the previous runtime when the same session is re-created without an intervening dispose event", async () => {
		const fake = await setup(rowConfig({ pullOnStart: false, pushOnWrite: true, pushDebounceMs: 60 }));
		const agent = fake.makeAgent({ id: "s1", cwd: repo });
		await fake.emitter.agentCreated(agent);
		await memoryTool(fake, "s1").execute({ action: "add", name: "Pending", content: "first body" }, {});

		// noteWrite 已经排了一个 60ms 的去抖定时器；在它触发之前，宿主对同一个 sessionId 又发了一次
		// created（clear/compact 重建，中间没有 disposed 事件）—— 第二次 created 必须先 dispose 上一代 runtime。
		const agent2 = fake.makeAgent({ id: "s1", cwd: repo });
		await fake.emitter.agentCreated(agent2);
		// 等待窗口要明显长过去抖期 + 一次本地 bare 仓库 push 的真实耗时，否则「没推上去」可能只是
		// 因为等得不够久，而不是旧定时器真的被取消了（诊断实测：60ms 去抖 + 完整 push 一轮约需 <200ms）。
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 300));
		// pullOnStart=false，新 runtime 不会自己补推；若旧定时器没被取消，这里早该推上去了。
		await expect(remoteFile("Pending.md")).rejects.toThrow();

		// 新一代 runtime 仍然健康：再写一条，应该由它自己的去抖定时器推上去，
		// 并且同一轮会连带收敛之前那条一直没发布的 Pending.md（引擎每轮都重新扫全量本地目录）。
		await memoryTool(fake, "s1").execute({ action: "add", name: "Second", content: "second body" }, {});
		await vi.waitFor(async () => expect(await remoteFile("Second.md")).toContain("second body"));
		await expect(remoteFile("Pending.md")).resolves.toContain("first body");
	});
});
