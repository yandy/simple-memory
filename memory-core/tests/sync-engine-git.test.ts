import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type SyncConfig } from "../src/config.js";
import { createGitSyncBackend, gitAvailable } from "../src/sync/backend-git.js";
import { type DeviceIdentity, loadOrCreateDevice } from "../src/sync/device.js";
import { createSyncEngine, type SyncEngine } from "../src/sync/engine.js";
import { manifestPath, readManifest } from "../src/sync/manifest.js";
import { remoteProjectKey } from "../src/sync/paths.js";
import { serializeEntryFile } from "../src/store/entry-file.js";
import { MemoryStore, type StoreConfig } from "../src/store/memory-store.js";

const execFileP = promisify(execFile);

/**
 * 端到端：**真 git**（一个 bare 仓库当远端）+ **真文件系统** + 两台「设备」（各自的记忆根、
 * 暂存 clone、设备身份与基线）。整条链没有一处是桩 —— 这里失败就是功能真的不能用。
 *
 * 剧本一那条是设计阶段一次 git 实测的回归版本：两台设备各自新增不同条目、碰面之后必须是
 * **零冲突**，且两边的索引都含全部条目。没有 git 的环境整组 skip（skip 不算通过）。
 */
const GIT = await gitAvailable();

/** 一条剧本要跑几十到上百个 git 子进程，windows runner 上 spawn 尤其贵：给足预算。 */
const TEST_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
});

const BRANCH = "main";
/** 两台设备同步的是**同一个项目**，所以远端 key 必须相同。 */
const IDENTITY_KEY = "git.example.com/org/proj";

const entry = (name: string, modified: string, body: string): string =>
	serializeEntryFile({ name, description: "d", type: "feedback", created: "2026-11-09", modified }, body);

interface Device {
	label: string;
	root: string;
	syncRoot: string;
	projectDir: string;
	projectKey: string;
	store: MemoryStore;
	engine: SyncEngine;
	identity: DeviceIdentity;
}

describe.skipIf(!GIT)("sync engine（真 git）", { timeout: TEST_TIMEOUT_MS }, () => {
	let dir: string;
	let remoteUrl: string;
	let config: SyncConfig;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-sync-engine-git-"));
		// git 保持密闭：绝不读机器上的全局/系统配置（user.name、init.defaultBranch、gpgsign 都会渗进来）
		const emptyConfig = join(dir, "gitconfig-empty");
		await writeFile(emptyConfig, "", "utf8");
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

		remoteUrl = join(dir, "remote.git");
		await git(["init", "--bare", "--quiet", remoteUrl], dir);
		config = { ...DEFAULT_CONFIG.sync, enabled: true, remote: remoteUrl, branch: BRANCH, autoTimeoutMs: GIT_TIMEOUT_MS, timeoutMs: GIT_TIMEOUT_MS };
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
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

	/** 一台设备 = 一个记忆根（自己的暂存 clone、身份、基线）+ 一个引擎，都指向同一个 bare 远端。 */
	async function makeDevice(label: string): Promise<Device> {
		const root = join(dir, label);
		const syncRoot = join(root, ".sync");
		const projectDir = join(root, "git", "proj");
		await mkdir(projectDir, { recursive: true });
		const store = new MemoryStore(CFG(projectDir));
		// memoryRoot 就是这台设备的记忆根（`.sync` 的上一层）：初始化前的共存检查靠它。
		// 这里没有 `<root>/.git`，所以检查直接跳过，而 init 也不会往记忆根里写任何东西。
		const backend = createGitSyncBackend({ syncRoot, memoryRoot: root, remote: remoteUrl, branch: BRANCH });
		// 初始化只由适配层触发：引擎绝不偷偷 clone
		await backend.init({ timeoutMs: GIT_TIMEOUT_MS });
		const identity = await loadOrCreateDevice(syncRoot);
		const projectKey = remoteProjectKey(IDENTITY_KEY);
		return {
			label,
			root,
			syncRoot,
			projectDir,
			projectKey,
			store,
			identity,
			engine: createSyncEngine({ syncRoot, projectDir, projectKey, store, backend, device: identity, config }),
		};
	}

	/** 绕过引擎往远端推一份内容（模拟「第三台设备已经推过了」）。 */
	async function handPush(files: Record<string, string>, prefix: string): Promise<void> {
		const work = join(dir, `handpush-${Object.keys(files).length}-${Date.now()}`);
		await git(["clone", "--quiet", remoteUrl, work], dir);
		await git(["checkout", "--quiet", "-B", BRANCH, `origin/${BRANCH}`], work);
		for (const [path, content] of Object.entries(files)) {
			const full = join(work, prefix, path);
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, content, "utf8");
		}
		await git(["add", "-A"], work);
		await git(["-c", "user.name=第三台设备", "-c", "user.email=third@example.com", "commit", "--quiet", "-m", "hand push"], work);
		await git(["push", "--quiet", "origin", `HEAD:${BRANCH}`], work);
		await rm(work, { recursive: true, force: true });
	}

	/** 远端那棵树的全部路径（仓库根相对）。**必须带 `-z`**：否则 git 会把非 ASCII 路径 C-quote 成八进制转义串。 */
	async function remoteTree(): Promise<string[]> {
		const out = await git(["--git-dir", remoteUrl, "ls-tree", "-r", "--name-only", "-z", BRANCH], dir);
		return out.split("\0").filter((line) => line !== "").sort();
	}

	/** 某台设备盘上的 entry 文件名（不含索引与快照目录）。 */
	async function localEntries(one: Device): Promise<string[]> {
		const names = await readdir(one.projectDir);
		return names.filter((name) => name.endsWith(".md") && name !== "MEMORY.md").sort();
	}

	it("剧本一：各自新增不同条目 → 碰面 → 零冲突，两边索引都含全部条目", async () => {
		const a = await makeDevice("a");
		const b = await makeDevice("b");

		await a.store.addEntry({ name: "C", body: "c" });
		expect((await a.engine.push()).ok).toBe(true);
		await b.store.addEntry({ name: "E", body: "e" });
		expect((await b.engine.push()).ok).toBe(true);

		const pullA = await a.engine.pull();
		const pullB = await b.engine.pull();
		for (const round of [pullA, pullB]) {
			expect(round.ok).toBe(true);
			expect(round.conflicts).toEqual([]); // 载重：不同条目各改各的，绝不产生冲突副本
			expect(round.rejected).toEqual([]);
			expect(round.unparsableLocal).toEqual([]);
			expect(round.outOfScopeRemote).toEqual([]);
		}

		for (const one of [a, b]) {
			expect((await one.store.listEntries()).map((e) => e.name).sort()).toEqual(["C", "E"]);
			// 头部 + 2 条：pull 之后索引被重建过，两条记忆都在里面
			expect((await one.store.readIndex()).split("\n").filter(Boolean)).toHaveLength(3);
			expect(await localEntries(one)).toEqual(["C.md", "E.md"]);
			expect((await one.store.readEntry("C"))?.body).toBe("c");
			expect((await one.store.readEntry("E"))?.body).toBe("e");
		}
		expect(await remoteTree()).toEqual([`git/${a.projectKey}/C.md`, `git/${a.projectKey}/E.md`]);
	});

	it("剧本二：两台设备各自解同一次冲突 → 产出的新文件名逐字节相同，且收敛成一份", async () => {
		const a = await makeDevice("a");
		const b = await makeDevice("b");
		const prefix = `git/${a.projectKey}`;

		// 先让两台设备与远端对齐在同一条记忆上
		await a.store.addEntry({ name: "发布状态", body: "最早的版本" });
		await a.engine.push();
		expect((await b.engine.pull()).pulled).toEqual(["发布状态.md"]);

		// 两台设备各自把它改成**同一份**新内容（本地领先、还没发布），远端则被第三台设备改成另一份
		const ours = entry("发布状态", "2026-11-10T00:00:00.000Z", "两台设备各自的版本");
		const theirs = entry("发布状态", "2026-11-12T00:00:00.000Z", "第三台设备的版本");
		for (const one of [a, b]) {
			await one.store.applyEntryFiles({ writes: [{ file: "发布状态.md", raw: ours }], deletes: [] });
		}
		await handPush({ "发布状态.md": theirs }, prefix);

		const resA = await a.engine.pull();
		const resB = await b.engine.pull();
		expect(resA.conflicts).toHaveLength(1);
		expect(resB.conflicts).toHaveLength(1);
		// 载重不变量：冲突副本的名字与字节都只是冲突内容的函数，两台设备必须算出同一份
		expect(resA.conflicts[0].keptAsNew).toBe(resB.conflicts[0].keptAsNew);
		const copy = resA.conflicts[0].keptAsNew;
		expect(copy).toMatch(/^发布状态-\(冲突-2026-11-10\)-[0-9a-f]{6}\.md$/);
		expect(await readFile(join(a.projectDir, copy), "utf8")).toBe(await readFile(join(b.projectDir, copy), "utf8"));
		// 胜者（modified 更新的远端那份）逐字留在原路径
		for (const one of [a, b]) {
			expect(await readFile(join(one.projectDir, "发布状态.md"), "utf8")).toBe(theirs);
			expect(await localEntries(one)).toEqual(["发布状态.md", copy].sort());
		}

		// 两台设备先后发布：第二台必须认出远端已经有同一份副本，而不是再造一份
		expect((await a.engine.push()).ok).toBe(true);
		const pushB = await b.engine.push();
		expect(pushB.ok).toBe(true);
		expect(pushB.conflicts).toEqual([]);
		expect(pushB.pushed).toEqual([]); // 增量已经为空：远端那份与本地逐字节相同
		expect(await remoteTree()).toEqual([`${prefix}/${copy}`, `${prefix}/发布状态.md`].sort());
		for (const one of [a, b]) {
			expect(await localEntries(one)).toEqual(["发布状态.md", copy].sort());
			expect((await one.store.listEntries()).filter((e) => e.name.includes("(冲突 "))).toHaveLength(1);
		}
	});

	it("剧本三：A 删 → B 改 → 碰面 → 原文件已删，B 的版本作为新 entry 留下", async () => {
		const a = await makeDevice("a");
		const b = await makeDevice("b");

		await a.store.addEntry({ name: "A", body: "a" });
		await a.engine.push();
		expect((await b.engine.pull()).pulled).toEqual(["A.md"]);

		await a.store.removeEntry("A");
		expect((await a.engine.push()).deletedRemote).toEqual(["A.md"]);
		expect(await remoteTree()).toEqual([]);

		await b.store.replaceEntry("A", { body: "B 改过的版本" });
		const resB = await b.engine.push();
		expect(resB.conflicts).toHaveLength(1);
		// 删除照办：原路径在本地也没了
		expect(resB.deletedLocal).toEqual(["A.md"]);
		expect(await localEntries(b)).not.toContain("A.md");
		const kept = (await b.store.listEntries()).find((e) => e.name.startsWith("A (冲突 "));
		expect(kept).toBeDefined();
		expect(resB.conflicts[0].keptAsNew).toBe(kept?.file);
		// 被改的那份一个字都没丢，作为一条正常记忆留下来了
		expect((await b.store.readEntry(kept?.name as string))?.body).toBe("B 改过的版本");
		expect(await remoteTree()).toEqual([`git/${b.projectKey}/${kept?.file}`]);

		const resA = await a.engine.pull();
		expect(resA.ok).toBe(true);
		expect(resA.pulled).toEqual([kept?.file]);
		expect(await localEntries(a)).toEqual([kept?.file as string]);
		expect((await a.store.readEntry(kept?.name as string))?.body).toBe("B 改过的版本");
		// 删除没有被撤销：两边都不再有 A.md
		expect(await readdir(a.projectDir)).not.toContain("A.md");
		expect(await readdir(b.projectDir)).not.toContain("A.md");
	});

	it("剧本四：两台设备都跑过同一次整理（内容相同）→ 零冲突、零副本", async () => {
		const a = await makeDevice("a");
		const b = await makeDevice("b");
		// 同一份字节落到两台设备上：模拟「两台设备各自跑了同一次整理，产出了一样的结果」
		const same = entry("整理结论", "2026-11-11T00:00:00.000Z", "同一份整理结论");
		for (const one of [a, b]) {
			await one.store.applyEntryFiles({ writes: [{ file: "整理结论.md", raw: same }], deletes: [] });
			await one.store.rebuildIndex();
		}

		expect((await a.engine.push()).pushed).toEqual(["整理结论.md"]);
		const resB = await b.engine.push();
		expect(resB.ok).toBe(true);
		expect(resB.conflicts).toEqual([]); // 内容相同不算冲突
		expect(resB.pushed).toEqual([]); // 增量已经是空的
		expect(await remoteTree()).toEqual([`git/${a.projectKey}/整理结论.md`]);
		for (const one of [a, b]) {
			expect(await localEntries(one)).toEqual(["整理结论.md"]); // 没有任何副本
			expect((await one.store.listEntries()).map((e) => e.name)).toEqual(["整理结论"]);
		}
	});

	it("★一台设备上的坏文件绝不删掉另一台设备上的同一条记忆", async () => {
		const a = await makeDevice("a");
		const b = await makeDevice("b");

		await a.store.addEntry({ name: "A", body: "a" });
		await a.engine.push();
		expect((await b.engine.pull()).pulled).toEqual(["A.md"]);
		const goodBytes = await readFile(join(b.projectDir, "A.md"), "utf8");

		// 手滑编辑 / 半截写入：本地这份突然解析不出了。扫描会把它归进 unparsable，
		// 于是差集看到「base 有 / ours 无 / theirs 未动」—— 标准三方语义会读成「用户删了它」，
		// 把这个删除推到远端，两台设备上的这条记忆就一起没了，而本地那份坏文件还躺在盘上。
		await writeFile(join(a.projectDir, "A.md"), "没有 frontmatter 了", "utf8");
		const res = await a.engine.push();
		expect(res.ok).toBe(true);
		expect(res.unparsableLocal).toEqual(["A.md"]);
		expect(res.deletedRemote).toEqual([]);
		expect(res.pushed).toEqual([]);
		expect(await readFile(join(a.projectDir, "A.md"), "utf8")).toBe("没有 frontmatter 了");

		// 对端设备：远端副本没被删，拉取也不会删掉本地那份
		expect(await remoteTree()).toEqual([`git/${a.projectKey}/A.md`]);
		const pullB = await b.engine.pull();
		expect(pullB.deletedLocal).toEqual([]);
		expect(await readFile(join(b.projectDir, "A.md"), "utf8")).toBe(goodBytes);

		// 修好之后下一轮能重新收敛（基线里它从未被记成已删）
		const fixed = entry("A", "2026-11-13T00:00:00.000Z", "修好之后的内容");
		await writeFile(join(a.projectDir, "A.md"), fixed, "utf8");
		expect((await a.engine.push()).pushed).toEqual(["A.md"]);
		expect((await b.engine.pull()).pulled).toEqual(["A.md"]);
		for (const one of [a, b]) {
			expect(await readFile(join(one.projectDir, "A.md"), "utf8")).toBe(fixed);
			expect((await one.store.readEntry("A"))?.body).toBe("修好之后的内容");
		}
	});

	it("远端 git log 里能看到设备归属（提交作者 = device.json）", async () => {
		const a = await makeDevice("a");
		const b = await makeDevice("b");

		await a.store.addEntry({ name: "A", body: "a" });
		expect((await a.engine.push()).ok).toBe(true);
		await b.store.addEntry({ name: "B", body: "b" });
		expect((await b.engine.push()).ok).toBe(true);

		const authors = (await git(["--git-dir", remoteUrl, "log", "--format=%an <%ae>", BRANCH], dir))
			.split("\n")
			.filter((line) => line !== "");
		// 两台设备的提交各自挂在自己的身份上：hostname 给人看，设备 id 保证唯一归属
		expect(authors).toContain(`${a.identity.hostname} <${a.identity.id}@sync.invalid>`);
		expect(authors).toContain(`${b.identity.hostname} <${b.identity.id}@sync.invalid>`);
		expect(a.identity.id).not.toBe(b.identity.id);
		// 提交作者就是盘上那份身份，不是每次运行重铸的
		expect(await readFile(join(a.syncRoot, "device.json"), "utf8")).toContain(a.identity.id);
		expect(await readFile(join(b.syncRoot, "device.json"), "utf8")).toContain(b.identity.id);
		// 最早那个提交是分支引导用的，不代表任何设备
		expect(authors.at(-1)).toBe("memory sync <sync@localhost>");
	});

	it("离线（远端不可达）→ 一轮跳过并给出可读原因，本地记忆一个字不动", async () => {
		const a = await makeDevice("a");
		await a.store.addEntry({ name: "A", body: "a" });
		expect((await a.engine.push()).ok).toBe(true);
		const before = await readdir(a.projectDir);

		// 把暂存 clone 的 origin 指到一个不存在的本地路径 = 远端不可达
		await git(["remote", "set-url", "origin", join(dir, "gone.git")], join(a.syncRoot, "repo"));
		const res = await a.engine.pull();
		expect(res.ok).toBe(false);
		expect(res.skipped?.reason).toBeTruthy();
		expect(res.skipped?.reason).not.toMatch(/undefined|\[object/);
		expect((await readdir(a.projectDir)).sort()).toEqual(before.sort()); // 失败的一轮不动本地
		expect((await a.store.listEntries()).map((e) => e.name)).toEqual(["A"]);

		const report = await a.engine.status();
		expect(report.errors.length).toBeGreaterThan(0);
		expect(report.initialized).toBe(true);
	});

	it("基线落在 .sync/state 下，记忆目录里不会多出任何同步状态文件", async () => {
		const a = await makeDevice("a");
		await a.store.addEntry({ name: "A", body: "a" });
		expect((await a.engine.push()).ok).toBe(true);

		const manifest = await readManifest(manifestPath(a.syncRoot, a.projectKey));
		expect(manifest?.base.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest?.files["A.md"].hash).toMatch(/^[0-9a-f]{64}$/);
		// 用户的记忆目录里只有记忆：没有 .git，没有清单，没有锁
		expect((await readdir(a.projectDir)).sort()).toEqual([".backups", "A.md", "MEMORY.md"]);
		// 同步自己的状态全部在 .sync 下，而且锁已经释放（不留残锁）
		expect((await readdir(a.syncRoot)).sort()).toEqual(["device.json", "repo", "state"]);
	});
});
