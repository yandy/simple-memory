import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	createGitSyncBackend,
	createSyncEngine,
	createSyncRuntime,
	gitAvailable,
	manifestPath,
	readManifest,
	remoteProjectKey,
	syncRootPath,
	syncTransport,
	withFsRetry,
	writeManifest,
	type MemoryConfig,
	type ProjectIdentity,
	type StoreConfig,
	type SyncBackend,
	type SyncRuntime,
} from "../src/index.js";

const execFileP = promisify(execFile);

/**
 * 真 git + 真 engine + 真 runtime 的**并发**用例。
 *
 * 既有 `sync-runtime-remote.test.ts` 用带屏障的假 engine 钉住了协调顺序；这里补的是它刻意
 * 做不到的另一半：把**真的**引擎、真的 git 子进程与真的 manifest 写盘放进同一场竞态，验证
 * 「drain 在途活动」不是桩上的假象。
 *
 * 时序靠包装 backend 的 `publish` 前置屏障确定性地造出来（真 backend 自身不做任何替换），
 * 所以两条用例都不会 flaky：`sleep` 只用来断言「此刻还没完成」，而那一段必然被屏障挡住。
 */
const GIT = await gitAvailable();

/** 一轮同步要跑几十个 git 子进程，windows runner 上 spawn 尤其贵。 */
const TEST_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;
const BRANCH = "main";
const IDENTITY: ProjectIdentity = { kind: "git", key: "example.com/org/proj" };

const STORE: Omit<StoreConfig, "memoryDir"> = {
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Session {
	runtime: SyncRuntime;
	root: string;
	syncRoot: string;
	projectDir: string;
	store: MemoryStore;
}

describe.skipIf(!GIT)("sync runtime × 真 git 的并发边界", { timeout: TEST_TIMEOUT_MS }, () => {
	let dir: string;
	let remoteA: string;
	let remoteB: string;
	const runtimes: SyncRuntime[] = [];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-sync-race-"));
		// git 保持密闭：全局/系统配置（user.name、init.defaultBranch、gpgsign）会渗进断言
		const emptyConfig = join(dir, "gitconfig-empty");
		await writeFile(emptyConfig, "", "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		remoteA = join(dir, "remote-a.git");
		remoteB = join(dir, "remote-b.git");
		await git(["init", "--bare", "--quiet", remoteA], dir);
		await git(["init", "--bare", "--quiet", remoteB], dir);
	});

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.dispose();
		vi.unstubAllEnvs();
		// windows：即使 dispose() 已 await 过 drain，被 abort 的 git 子进程也可能还没释放
		// 句柄，直接 rm 会撞 EBUSY（本仓在 CI 上实测过）。withFsRetry 就是为这类瞬时占用写的。
		await withFsRetry(() => rm(dir, { recursive: true, force: true }));
	});

	async function git(args: string[], cwd: string): Promise<string> {
		const { stdout } = await execFileP("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf8",
		});
		return stdout.trim();
	}

	async function remoteTree(remote: string): Promise<string[]> {
		const out = await git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "-z", BRANCH], dir);
		return out.split("\0").filter((line) => line !== "").sort();
	}

	/**
	 * 一个会话 = 一个记忆根（自己的暂存 clone、身份与基线）。
	 *
	 * `wrapBackend` 是唯一注入缝：生产装配拿到的是未包装的真 backend。第一轮（startup 的那次
	 * push）必须放行，包装层用 `blockFrom` 决定从第几次 `publish` 起挂起。
	 */
	async function makeSession(
		remote: string,
		wrapBackend?: (backend: SyncBackend) => SyncBackend,
	): Promise<Session> {
		const root = join(dir, `session-${runtimes.length}`);
		const projectDir = join(root, "git", "proj");
		await mkdir(projectDir, { recursive: true });
		const store = new MemoryStore({ memoryDir: projectDir, ...STORE });
		const config: MemoryConfig = {
			...DEFAULT_CONFIG,
			memoryDir: root,
			sync: {
				...DEFAULT_CONFIG.sync,
				enabled: true,
				remote,
				branch: BRANCH,
				// 关掉写触发，断言只反映手动轮次与换远端自身的恢复推
				pushOnWrite: false,
				autoTimeoutMs: GIT_TIMEOUT_MS,
				timeoutMs: GIT_TIMEOUT_MS,
			},
		};
		const assembled = await createSyncRuntime({
			config,
			store,
			projectDir,
			identity: IDENTITY,
			scheduling: "concurrent",
			messages: {
				originDrift: "configured remote differs from the initialized origin; the origin stays authoritative",
				uninitializedRemoteChange: "initialize sync before changing the remote",
			},
			createBackend: (context) => {
				const backend = createGitSyncBackend(context);
				return wrapBackend ? wrapBackend(backend) : backend;
			},
			createEngine: (options) => createSyncEngine(options),
			writeManifest,
		});
		expect(assembled.errors).toEqual([]);
		if (assembled.runtime === null) throw new Error("expected a sync runtime");
		runtimes.push(assembled.runtime);
		return { runtime: assembled.runtime, root, syncRoot: syncRootPath(root), projectDir, store };
	}

	it("push 在 publish 段时换远端：先 drain 完在途轮次，再切 origin 与基线", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const publishEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let publishes = 0;
		const session = await makeSession(remoteA, (backend) => ({
			...backend,
			async publish(scope, changes, base, opts) {
				publishes += 1;
				if (publishes >= 2) {
					entered();
					await gate;
				}
				return backend.publish(scope, changes, base, opts);
			},
		}));

		await session.store.addEntry({ name: "A", body: "第一条" });
		const startup = await session.runtime.startup();
		expect(startup.ok).toBe(true);

		await session.store.addEntry({ name: "B", body: "第二条" });
		const pushing = session.runtime.run("push", GIT_TIMEOUT_MS);
		await publishEntered;

		const changing = session.runtime.changeRemote(remoteB, GIT_TIMEOUT_MS);
		// 在途 push 还在 publish 里：换远端不得抢先完成（它的第一步是 drain 这本账）
		expect(await Promise.race([changing.then(() => "done" as const), sleep(1000).then(() => "pending" as const)])).toBe(
			"pending",
		);

		release();
		const pushed = await pushing;
		expect(pushed.ok).toBe(true);
		expect((await changing).ok).toBe(true);

		// 旧轮次真的推完了，而不是被换远端丢掉
		const prefix = `git/${remoteProjectKey(IDENTITY.key)}`;
		expect(await remoteTree(remoteA)).toEqual([`${prefix}/A.md`, `${prefix}/B.md`]);

		// 基线切到新远端且为空（不把旧远端的文件当成新远端的 base）
		const manifest = await readManifest(manifestPath(session.syncRoot, remoteProjectKey(IDENTITY.key)));
		expect(manifest?.transport).toEqual(syncTransport(remoteB, BRANCH));
		expect(manifest?.files).toEqual({});

		// 新远端尚未收到任何提交：换远端只换 origin 与本地基线，不猜远端内容
		expect(await git(["--git-dir", remoteB, "branch", "--list", BRANCH], dir)).toBe("");

		const status = await session.runtime.status(GIT_TIMEOUT_MS);
		expect(status.ok).toBe(true);
		if (status.ok) expect(status.value).toMatchObject({ initialized: true, remote: remoteB });
	});

	it("dispose 时 push 在 publish 段：drain 等它收摊，之后入口一律 disposed", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const publishEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let publishes = 0;
		const session = await makeSession(remoteA, (backend) => ({
			...backend,
			async publish(scope, changes, base, opts) {
				publishes += 1;
				if (publishes >= 2) {
					entered();
					await gate;
				}
				return backend.publish(scope, changes, base, opts);
			},
		}));

		await session.store.addEntry({ name: "A", body: "第一条" });
		expect((await session.runtime.startup()).ok).toBe(true);

		await session.store.addEntry({ name: "B", body: "第二条" });
		const pushing = session.runtime.run("push", GIT_TIMEOUT_MS);
		await publishEntered;

		const disposing = session.runtime.dispose();
		expect(await Promise.race([disposing.then(() => "done" as const), sleep(1000).then(() => "pending" as const)])).toBe(
			"pending",
		);

		release();
		await disposing;
		// 在途轮次的结局可以是成功、也可以被收摊中断，但必须已经尘埃落定（不许悬挂）
		await expect(pushing).resolves.toBeDefined();
		expect(session.runtime.engine).toBeNull();

		const after = publishes;
		const rejected = await session.runtime.run("pull", 1000);
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.reason).toContain("disposed");
		await expect(session.runtime.status(1000)).resolves.toMatchObject({ ok: false });
		// dispose 之后不得再起新一轮 publish
		await sleep(50);
		expect(publishes).toBe(after);
	});
});
