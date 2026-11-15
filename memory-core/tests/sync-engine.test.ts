import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type SyncConfig } from "../src/config.js";
import {
	NonFastForwardError,
	type RemoteView,
	type SyncBackend,
	type SyncPublishChanges,
	type SyncScope,
} from "../src/sync/backend.js";
import type { DeviceIdentity } from "../src/sync/device.js";
import { createSyncEngine, type SyncEngine } from "../src/sync/engine.js";
import { sha256Hex } from "../src/sync/hash.js";
import { MANIFEST_VERSION, manifestPath, readManifest, writeManifest } from "../src/sync/manifest.js";
import { remoteProjectKey } from "../src/sync/paths.js";
import { serializeEntryFile } from "../src/store/entry-file.js";
import { tryWithLock } from "../src/store/fs-lock.js";
import { BACKUP_DIR, INDEX_FILE, MemoryStore, type StoreConfig } from "../src/store/memory-store.js";

/**
 * 引擎的单元/集成测试：**假 backend**（内存里的远端）+ **真的文件系统**（真的 MemoryStore、
 * 真的锁、真的快照、真的 manifest）。只有传输层是假的 —— 合并、冲突收敛、落盘与索引重建
 * 全部走真代码，否则这些用例就只在测我们自己写的桩。
 *
 * 真 git 的端到端剧本在 `sync-engine-git.test.ts`。
 */

/**
 * 冲突收敛的抛错路径（败者字节解析不出 frontmatter）在引擎侧被两道校验挡在前面，
 * 从公开面走不到 —— 它是纵深防御。要钉住「引擎接住它、跳过这一条、整轮不失败」，
 * 只能在这里注入那一次抛错；其余用例一律走真实现（包装器默认直接转发）。
 */
const conflictGate = vi.hoisted(() => ({ throwOnResolve: false }));

vi.mock("../src/sync/conflict.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/sync/conflict.js")>();
	return {
		...actual,
		resolveConflict: (
			input: Parameters<typeof actual.resolveConflict>[0],
			taken: Parameters<typeof actual.resolveConflict>[1],
		) => {
			if (conflictGate.throwOnResolve) throw new Error("losing side has unparsable frontmatter");
			return actual.resolveConflict(input, taken);
		},
	};
});

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
});

const SYNC_CONFIG: SyncConfig = {
	...DEFAULT_CONFIG.sync,
	enabled: true,
	remote: "https://git.example.invalid/org/proj.git",
	branch: "main",
	autoTimeoutMs: 30_000,
	timeoutMs: 30_000,
};

const DEVICE: DeviceIdentity = { id: "device-a", hostname: "test-host", createdAt: "2026-11-01T00:00:00.000Z" };

/** 固定的时钟：快照目录名与 `syncedAt` 因此可断言。 */
const NOW = () => new Date("2026-11-15T08:00:00.000Z");

const raw = (name: string, modified = "2026-11-09T10:00:00.000Z", body = "正文") =>
	serializeEntryFile({ name, description: "d", type: "feedback", created: "2026-11-09", modified }, body);

// ---------------------------------------------------------------------------
// 假 backend
// ---------------------------------------------------------------------------

interface FakeRemote extends SyncBackend {
	/** 下一次 `fetch` / `publish` 抛错（一次性，用完即清）。 */
	failNext: "fetch" | "publish" | null;
	/** 接下来 N 次 `publish` 抛非快进（远端不动，模拟「另一台设备抢先推了」）。 */
	nonFastForward: number;
	/** `ready()` 的答案。 */
	initialized: boolean;
	initCalls: number;
	fetches: number;
	publishAttempts: number;
	/** 每次成功发布收到的增量（断言「发布的是增量而不是全量」用）。 */
	publishes: SyncPublishChanges[];
	revision: string;
	hooks: { onFetch?: () => void; onPublish?: () => void };
	/** 模拟另一台设备往某个前缀推了一个文件。 */
	write(prefix: string, path: string, content: string): Promise<void>;
	/** 模拟有人手工往远端根推了一个范围外路径。 */
	writeRaw(path: string, content: string): Promise<void>;
	/** 模拟另一台设备删掉了某个前缀下的文件（远端删除，revision 同样要前进）。 */
	remove(prefix: string, path: string): Promise<void>;
	read(prefix: string, path: string): Promise<string>;
	names(prefix: string): Promise<string[]>;
}

/**
 * 内存里的远端。口径照 git backend：`revision` 是不透明字符串（空串 = 还没有任何已发布内容）、
 * `list()` 的 hash 是 sha256(字节) 十六进制小写、`outOfScope` 是**远端根相对**路径、
 * `publish` 用 `base.revision` 做乐观并发（空串不算非快进）。
 */
function createFakeRemote(): FakeRemote {
	const scopes = new Map<string, Map<string, string>>();
	/** 远端根下、不属于任何前缀的路径（手工推上来的索引、别的项目之外的东西）。 */
	const loose = new Map<string, string>();
	let counter = 0;

	const remote: FakeRemote = {
		failNext: null,
		nonFastForward: 0,
		initialized: true,
		initCalls: 0,
		fetches: 0,
		publishAttempts: 0,
		publishes: [],
		revision: "",
		hooks: {},

		async ready() {
			return remote.initialized;
		},
		async init() {
			remote.initCalls += 1;
			remote.initialized = true;
		},

		async fetch(scope: SyncScope): Promise<RemoteView> {
			remote.fetches += 1;
			remote.hooks.onFetch?.();
			if (remote.failNext === "fetch") {
				remote.failNext = null;
				throw new Error("fetch failed: simulated transport error");
			}
			// 快照语义：fetch 那一刻的内容被固定下来，之后的 write 不影响这一份视图
			const contents = new Map<string, string>();
			const outOfScope: string[] = [];
			for (const [path, content] of scopes.get(scope.prefix) ?? []) {
				if (path.includes("/")) outOfScope.push(`${scope.prefix}/${path}`);
				else contents.set(path, content);
			}
			for (const [other, files] of scopes) {
				if (other === scope.prefix) continue;
				for (const path of files.keys()) outOfScope.push(`${other}/${path}`);
			}
			for (const path of loose.keys()) outOfScope.push(path);
			const revision = remote.revision;
			const paths = [...contents.keys()].sort();
			return {
				revision,
				outOfScope: outOfScope.sort(),
				async list() {
					return paths.map((path) => ({ path, hash: sha256Hex(contents.get(path) as string) }));
				},
				async read(path: string) {
					const content = contents.get(path);
					if (content === undefined) throw new Error(`not in the fetched remote snapshot: "${path}"`);
					return content;
				},
			};
		},

		async publish(scope: SyncScope, changes: SyncPublishChanges, base: { revision: string }): Promise<string> {
			remote.publishAttempts += 1;
			remote.hooks.onPublish?.();
			if (remote.failNext === "publish") {
				remote.failNext = null;
				throw new Error("publish failed: simulated transport error");
			}
			if (remote.nonFastForward > 0) {
				remote.nonFastForward -= 1;
				throw new NonFastForwardError(
					`the remote moved on while publishing: base ${base.revision}, now ${remote.revision}`,
				);
			}
			if (base.revision !== "" && base.revision !== remote.revision) {
				throw new NonFastForwardError(
					`the remote moved on before publishing: base ${base.revision}, now ${remote.revision}`,
				);
			}
			const own = scopes.get(scope.prefix) ?? new Map<string, string>();
			let changed = false;
			for (const { path, content } of changes.writes) {
				if (own.get(path) !== content) {
					own.set(path, content);
					changed = true;
				}
			}
			for (const path of changes.deletions) if (own.delete(path)) changed = true;
			scopes.set(scope.prefix, own);
			remote.publishes.push({
				writes: changes.writes.map((item) => ({ ...item })),
				deletions: [...changes.deletions],
			});
			if (changed) remote.revision = `rev-${(counter += 1)}`;
			return remote.revision;
		},

		async write(prefix: string, path: string, content: string) {
			const own = scopes.get(prefix) ?? new Map<string, string>();
			own.set(path, content);
			scopes.set(prefix, own);
			remote.revision = `rev-${(counter += 1)}`;
		},
		async writeRaw(path: string, content: string) {
			loose.set(path, content);
			remote.revision = `rev-${(counter += 1)}`;
		},
		async remove(prefix: string, path: string) {
			const own = scopes.get(prefix) ?? new Map<string, string>();
			own.delete(path);
			scopes.set(prefix, own);
			remote.revision = `rev-${(counter += 1)}`;
		},
		async read(prefix: string, path: string) {
			const content = scopes.get(prefix)?.get(path);
			if (content === undefined) throw new Error(`no such remote file: ${prefix}/${path}`);
			return content;
		},
		async names(prefix: string) {
			return [...(scopes.get(prefix) ?? new Map()).keys()].sort();
		},
	};
	return remote;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Device {
	root: string;
	syncRoot: string;
	projectDir: string;
	projectKey: string;
	prefix: string;
	store: MemoryStore;
	engine: SyncEngine;
}

let dir: string;
let remote: FakeRemote;
let device: Device;
let store: MemoryStore;
let engine: SyncEngine;
let syncRoot: string;
let projectDir: string;
let projectKey: string;
let prefix: string;

/** 一台设备 = 一个记忆根（自己的 .sync 与项目目录）+ 一个引擎，全部指向同一个假远端。 */
async function makeDevice(name: string, identityKey = "example.com/org/proj"): Promise<Device> {
	const root = join(dir, name);
	const sync = join(root, ".sync");
	const project = join(root, "git", "proj");
	await mkdir(sync, { recursive: true });
	await mkdir(project, { recursive: true });
	const memoryStore = new MemoryStore(CFG(project));
	const key = remoteProjectKey(identityKey);
	return {
		root,
		syncRoot: sync,
		projectDir: project,
		projectKey: key,
		prefix: `git/${key}`,
		store: memoryStore,
		engine: createSyncEngine({
			syncRoot: sync,
			projectDir: project,
			projectKey: key,
			store: memoryStore,
			backend: remote,
			device: DEVICE,
			config: SYNC_CONFIG,
			now: NOW,
		}),
	};
}

/** 目录的「名字 + mtime」指纹：用来断言「一个字都没动」。 */
async function fingerprint(target: string): Promise<Array<[string, number]>> {
	const out: Array<[string, number]> = [];
	for (const name of (await readdir(target)).sort()) {
		out.push([name, (await stat(join(target, name))).mtimeMs]);
	}
	return out;
}

async function backupNames(target: string, label: string): Promise<string[]> {
	const names = await readdir(join(target, BACKUP_DIR)).catch(() => [] as string[]);
	return names.filter((name) => name.endsWith(`-${label}`)).sort();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-sync-engine-"));
	remote = createFakeRemote();
	device = await makeDevice("primary");
	store = device.store;
	engine = device.engine;
	syncRoot = device.syncRoot;
	projectDir = device.projectDir;
	projectKey = device.projectKey;
	prefix = device.prefix;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("sync engine（假 backend）", () => {
	it("pull：远端新增的 entry 落到本地并进索引", async () => {
		await remote.write(prefix, "a.md", raw("A"));
		const res = await engine.pull();
		expect(res).toMatchObject({ ok: true, pulled: ["a.md"] });
		expect(await readFile(join(projectDir, "a.md"), "utf8")).toBe(raw("A"));
		expect(await store.readIndex()).toContain("- [A](a.md) — d");
		expect(res.revision).toBe(remote.revision);
		const manifest = await readManifest(manifestPath(syncRoot, projectKey));
		expect(manifest?.base.revision).toBe(remote.revision);
		expect(manifest?.files["a.md"].hash).toBe(sha256Hex(raw("A")));
	});

	it("pull：本地删除传播到远端（下一次 publish 的 deletions 里有它）", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		expect(await remote.names(prefix)).toEqual(["A.md"]);

		await store.removeEntry("A");
		const pulled = await engine.pull();
		// pull 轮不发布：这里报的是「已判定、随下一次发布生效」的删除
		expect(pulled.deletedRemote).toEqual(["A.md"]);
		expect(await remote.names(prefix)).toEqual(["A.md"]);

		const pushed = await engine.push();
		expect(pushed.deletedRemote).toEqual(["A.md"]);
		expect(remote.publishes.at(-1)?.deletions).toEqual(["A.md"]);
		expect(await remote.names(prefix)).toEqual([]);
		expect(await readdir(projectDir)).not.toContain("A.md");
	});

	it("push：远端未动时零本地写入、不产生 sync 快照", async () => {
		await engine.push(); // 先对齐
		await store.addEntry({ name: "B", body: "b" }); // 这一步自己会拍一份 -write 快照，别拿它当基线
		const before = await fingerprint(projectDir);

		const res = await engine.push();
		expect(res.pushed).toEqual(["B.md"]);
		// 名字与 mtime 都没变 = 本轮真的一个字都没写（含 MEMORY.md 没被重写）
		expect(await fingerprint(projectDir)).toEqual(before);
		expect(await backupNames(projectDir, "sync")).toEqual([]); // 没有收敛动作 → 不快照
	});

	it("push：远端已动时先收敛再发布，且会快照 .backups/<ts>-sync/", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		await remote.write(prefix, "b.md", raw("B")); // 另一台设备推了一条
		await store.addEntry({ name: "C", body: "c" });

		const res = await engine.push();
		expect(res).toMatchObject({ ok: true, pulled: ["b.md"], pushed: ["C.md"] });
		expect(await readFile(join(projectDir, "b.md"), "utf8")).toBe(raw("B"));
		expect(await store.readIndex()).toContain("- [B](b.md) — d");

		const snapshots = await backupNames(projectDir, "sync");
		expect(snapshots).toHaveLength(1);
		// 整目录快照：既有索引也有条目文件
		const files = await readdir(join(projectDir, BACKUP_DIR, snapshots[0]));
		expect(files).toContain(INDEX_FILE);
		expect(files).toContain("A.md");
	});

	it("发布的增量是「合并结果相对远端」，不是全量文件集", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await store.addEntry({ name: "B", body: "b" });
		await engine.push();
		expect(remote.publishes.at(-1)?.writes.map((w) => w.path).sort()).toEqual(["A.md", "B.md"]);

		await store.replaceEntry("B", { body: "b2" });
		await engine.push();
		expect(remote.publishes.at(-1)?.writes.map((w) => w.path)).toEqual(["B.md"]);
		expect(remote.publishes.at(-1)?.deletions).toEqual([]);

		await store.removeEntry("A");
		await engine.push();
		expect(remote.publishes.at(-1)?.writes).toEqual([]);
		expect(remote.publishes.at(-1)?.deletions).toEqual(["A.md"]);
		expect(await remote.names(prefix)).toEqual(["B.md"]);
	});

	it("冲突：两份都留，被挤出来的那份成为一条新 entry 并进索引", async () => {
		await store.addEntry({ name: "发布状态", body: "最早的版本" });
		await engine.push(); // 基线与远端都停在「最早的版本」
		// 两侧都相对基线改过，才是冲突（只有一侧改是干净的拉取/推送）
		await store.replaceEntry("发布状态", { body: "台式机的版本" });
		await remote.write(
			prefix,
			"发布状态.md",
			serializeEntryFile(
				{ name: "发布状态", description: "d", type: "feedback", created: "2026-11-09", modified: "2099-01-01T00:00:00.000Z" },
				"笔记本的版本",
			),
		);

		const res = await engine.pull();
		expect(res.conflicts).toHaveLength(1);
		expect(res.conflicts[0].file).toBe("发布状态.md");
		expect(res.conflicts[0].keptAsNew).toMatch(/^发布状态-\(冲突-\d{4}-\d{2}-\d{2}\)-[0-9a-f]{6}\.md$/);

		const names = (await store.listEntries()).map((e) => e.name);
		expect(names).toContain("发布状态");
		expect(names.some((n) => n.startsWith("发布状态 (冲突 "))).toBe(true);
		// modified 新的一方（远端）留在原路径，逐字过去
		expect(await store.readEntry("发布状态")).toMatchObject({ body: "笔记本的版本" });
		expect(await readFile(join(projectDir, "发布状态.md"), "utf8")).toContain("2099-01-01T00:00:00.000Z");
		// 被挤出来的那份进了索引
		expect(await store.readIndex()).toContain(res.conflicts[0].keptAsNew);
		expect(await readFile(join(projectDir, res.conflicts[0].keptAsNew), "utf8")).toContain("台式机的版本");
	});

	it("★冲突确定性：两台设备各自解同一次冲突，产出同一个新文件名与同一份字节", async () => {
		const first = await makeDevice("dev-one");
		const second = await makeDevice("dev-two");
		const original = raw("发布状态", "2026-11-01T00:00:00.000Z", "最早的版本");
		const desktop = raw("发布状态", "2026-11-05T00:00:00.000Z", "台式机的版本");
		const laptop = raw("发布状态", "2026-11-09T00:00:00.000Z", "笔记本的版本");

		// 同一个远端（笔记本的版本），同一份本地内容（台式机的版本），同一份基线（最早的版本）
		await remote.write(first.prefix, "发布状态.md", laptop);
		for (const one of [first, second]) {
			await one.store.applyEntryFiles({ writes: [{ file: "发布状态.md", raw: desktop }], deletes: [] });
			await writeManifest(manifestPath(one.syncRoot, one.projectKey), {
				version: MANIFEST_VERSION,
				base: { revision: remote.revision, syncedAt: "" },
				files: {
					"发布状态.md": {
						hash: sha256Hex(original),
						modified: "2026-11-01T00:00:00.000Z",
						bytes: Buffer.byteLength(original, "utf8"),
					},
				},
			});
		}

		const [resOne, resTwo] = [await first.engine.pull(), await second.engine.pull()];
		expect(resOne.conflicts).toHaveLength(1);
		expect(resTwo.conflicts).toHaveLength(1);
		// 载重不变量：新文件名只是冲突内容的函数，两台设备必须算出同一个
		expect(resOne.conflicts[0].keptAsNew).toBe(resTwo.conflicts[0].keptAsNew);

		const copiesOne = (await first.store.listEntries()).filter((e) => e.name.includes("(冲突 "));
		const copiesTwo = (await second.store.listEntries()).filter((e) => e.name.includes("(冲突 "));
		expect(copiesOne).toHaveLength(1);
		expect(copiesTwo).toHaveLength(1);
		expect(copiesOne[0].file).toBe(copiesTwo[0].file);
		expect(copiesOne[0].name).toBe(copiesTwo[0].name);
		expect(await readFile(join(first.projectDir, copiesOne[0].file), "utf8")).toBe(
			await readFile(join(second.projectDir, copiesTwo[0].file), "utf8"),
		);
		// 后缀取自**败者**（台式机那份）的 modified 与指纹
		expect(copiesOne[0].file).toMatch(/^发布状态-\(冲突-2026-11-05\)-[0-9a-f]{6}\.md$/);
	});

	it("删除 vs 修改：删除照办，被修改的那份作为新 entry 留下", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		await store.removeEntry("A"); // 本地删了
		await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "远端改过的版本")); // 远端改了

		const res = await engine.pull();
		expect(res.conflicts).toHaveLength(1);
		expect(res.deletedLocal).toEqual(["A.md"]); // 删除照办
		expect(await readdir(projectDir)).not.toContain("A.md");

		const kept = (await store.listEntries()).find((e) => e.name.startsWith("A (冲突 "));
		expect(kept).toBeDefined();
		expect(res.conflicts[0].keptAsNew).toBe(kept?.file);
		// 被修改的那份内容一点没丢
		expect(await store.readEntry(kept?.name as string)).toMatchObject({ body: "远端改过的版本" });

		// 「删除照办」必须兼得下去：下一轮不得把远端那份重新拉回来（那等于自己撤销删除），
		// 而真的发布时要把这次删除推出去
		const again = await engine.pull();
		expect(await readdir(projectDir)).not.toContain("A.md");
		expect(again.deletedRemote).toEqual(["A.md"]);
		const pushed = await engine.push();
		expect(pushed.deletedRemote).toEqual(["A.md"]);
		expect(await remote.names(prefix)).toEqual([res.conflicts[0].keptAsNew]);
	});

	it("删除 vs 修改之后连着两轮 pull：第二轮不再造副本，删除一轮就收敛", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		await store.removeEntry("A"); // 本地删了
		await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "远端改过的版本")); // 远端改了
		const copies = async () => (await readdir(projectDir)).filter((name) => name.includes("冲突")).sort();

		const first = await engine.pull();
		expect(first.conflicts).toHaveLength(1);
		expect(await copies()).toHaveLength(1);
		// 载重：收敛之后基线记的是「远端此刻那份」（= 两侧上一次达成一致的状态），而不是沿用
		// 冲突前的旧条目。沿用旧条目会让第二轮再判成同一场删改冲突 —— 每拉一次就多一份副本，
		// 而删除永远推不出去。
		const manifest = await readManifest(manifestPath(syncRoot, projectKey));
		expect(manifest?.files["A.md"].hash).toBe(sha256Hex(await remote.read(prefix, "A.md")));

		const second = await engine.pull();
		expect(second.conflicts).toEqual([]); // 同一场冲突不会重演
		expect(await copies()).toHaveLength(1); // 副本数不增长
		// 基线里它就是远端那份 → 「base 有 / ours 无 / theirs 未动」= 本地删了 → 删除待发布
		expect(second.deletedRemote).toEqual(["A.md"]);
		expect(await readdir(projectDir)).not.toContain("A.md");

		const third = await engine.push();
		expect(third.deletedRemote).toEqual(["A.md"]);
		// 删除真的到了远端，幸存的那份内容也推上去了，两份都在
		expect(await remote.names(prefix)).toEqual([first.conflicts[0].keptAsNew]);
		expect(await remote.read(prefix, first.conflicts[0].keptAsNew)).toContain("远端改过的版本");
	});

	it("远端范围外路径被忽略并记进 outOfScopeRemote", async () => {
		await remote.writeRaw("MEMORY.md", "# 手推的索引");
		await remote.writeRaw("local/x.md", raw("X"));
		await remote.write(prefix, "sub/nested.md", raw("N"));

		const res = await engine.pull();
		expect(res.pulled).toEqual([]);
		expect(res.outOfScopeRemote.sort()).toEqual(["MEMORY.md", "local/x.md", `${prefix}/sub/nested.md`].sort());
		expect(await readdir(projectDir)).not.toContain("MEMORY.md");
		expect(await readdir(projectDir)).not.toContain("sub");
		// 范围外的东西也绝不会被发布段碰
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		expect(await remote.read(prefix, "sub/nested.md")).toBe(raw("N"));
		expect(remote.publishes.at(-1)?.deletions).toEqual([]);
		expect(remote.publishes.at(-1)?.writes.map((w) => w.path)).toEqual(["A.md"]);
	});

	it("远端前缀里的 MEMORY.md / 点开头的文件不算条目：报成范围外，不让整轮失败", async () => {
		await remote.write(prefix, "MEMORY.md", "# 手推的索引");
		await remote.write(prefix, ".hidden.md", raw("H"));
		const res = await engine.pull();
		expect(res.ok).toBe(true);
		expect(res.pulled).toEqual([]);
		expect(res.outOfScopeRemote.sort()).toEqual([`${prefix}/.hidden.md`, `${prefix}/MEMORY.md`]);
		expect(await readdir(projectDir)).not.toContain("MEMORY.md");
		expect(await store.readIndex()).not.toContain("手推的索引");
	});

	it("pull 在 backend.fetch 抛错时返回 skipped 而不抛", async () => {
		remote.failNext = "fetch";
		await expect(engine.pull()).resolves.toMatchObject({
			ok: false,
			skipped: { reason: expect.stringMatching(/fetch/i) },
		});
		// 失败的一轮什么都不改
		expect(await readdir(projectDir)).toEqual([]);
		expect(await readManifest(manifestPath(syncRoot, projectKey))).toBeNull();
	});

	it("publish 失败：base 不前进、脏状态留着，下一次 push 重试成功", async () => {
		await store.addEntry({ name: "A", body: "a" });
		remote.failNext = "publish";
		const failed = await engine.push();
		expect(failed.ok).toBe(false);
		expect(failed.skipped?.reason).toMatch(/publish failed/i);
		expect(failed.pushed).toEqual([]);

		const manifest = await readManifest(manifestPath(syncRoot, projectKey));
		expect(manifest?.base.revision).toBe("");
		// 载重：**没发布成功的本地新增绝不能被记进基线**。记进去之后下一轮的差集就是
		// 「base 有 / ours 有 / theirs 无」= 远端删了它 → 本地文件被删掉。
		expect(manifest?.files["A.md"]).toBeUndefined();

		remote.failNext = "publish";
		expect((await engine.push()).ok).toBe(false);
		// 两轮发布都失败，本地那条记忆必须还在盘上
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toContain("name: A");

		expect((await engine.push()).ok).toBe(true);
		expect(await remote.read(prefix, "A.md")).toContain("name: A");
		const after = await readManifest(manifestPath(syncRoot, projectKey));
		expect(after?.base.revision).toBe(remote.revision);
		expect(after?.files["A.md"].hash).toBe(sha256Hex(await readFile(join(projectDir, "A.md"), "utf8")));
	});

	it("pull 轮绝不把本地未发布的内容记进基线：下一轮仍判成本地领先，而不是把它删掉", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push(); // 先对齐
		await store.addEntry({ name: "B", body: "b" }); // 本地领先，还没推出去
		await remote.write(prefix, "c.md", raw("C")); // 远端也领先

		const pulled = await engine.pull();
		expect(pulled.pulled).toEqual(["c.md"]);
		expect(pulled.pushed).toEqual([]);
		// 载重：基线只记「两侧达成一致的状态」。pull 轮不发布，所以本轮产生的本地内容
		// （B.md）绝不能进基线 —— 否则下一轮就是「base 有 / ours 有 / theirs 无」= 远端删了它
		// → deleteLocal → 用户自己还没推出去的记忆被从本地删掉。
		const manifest = await readManifest(manifestPath(syncRoot, projectKey));
		expect(manifest?.files["B.md"]).toBeUndefined();
		expect(manifest?.files["c.md"].hash).toBe(sha256Hex(raw("C")));

		// 下一轮：它仍然是「待发布」，文件也还在盘上
		const report = await engine.status();
		expect(report.ahead).toEqual(["B.md"]);
		expect(report.behind).toEqual([]);
		expect(await readFile(join(projectDir, "B.md"), "utf8")).toContain("name: B");

		const pushed = await engine.push();
		expect(pushed.pushed).toEqual(["B.md"]);
		expect(await remote.read(prefix, "B.md")).toContain("name: B");
	});

	it("NonFastForward：整轮重跑一次后成功；两次都失败则 ok:false", async () => {
		await store.addEntry({ name: "A", body: "a" });
		remote.nonFastForward = 1;
		const res = await engine.push();
		expect(res).toMatchObject({ ok: true, pushed: ["A.md"] });
		// 重跑的是**整轮**（重新取远端 + 重算差集），不是只重试一次 publish
		expect(remote.fetches).toBe(2);
		expect(remote.publishAttempts).toBe(2);
		expect(await remote.read(prefix, "A.md")).toContain("name: A");

		await store.addEntry({ name: "B", body: "b" });
		const fetchesBefore = remote.fetches;
		remote.nonFastForward = 2;
		const failed = await engine.push();
		expect(failed.ok).toBe(false);
		expect(failed.skipped?.reason).toMatch(/moved on/i);
		expect(remote.fetches).toBe(fetchesBefore + 2); // 上限就是一次重跑
		expect(await readdir(projectDir)).toContain("B.md"); // 本地内容不动，留到下次
	});

	it("backend 未初始化（ready()=false）→ skipped，且绝不偷偷 init", async () => {
		remote.initialized = false;
		const spy = vi.spyOn(remote, "init");
		expect(await engine.pull()).toMatchObject({
			ok: false,
			skipped: { reason: expect.stringMatching(/not initialized/i) },
		});
		expect(spy).not.toHaveBeenCalled();
		expect(remote.fetches).toBe(0);
	});

	it("未配置（enabled 为假 / remote 为空）→ skipped，且不碰远端", async () => {
		const off = createSyncEngine({
			syncRoot,
			projectDir,
			projectKey,
			store,
			backend: remote,
			device: DEVICE,
			config: { ...SYNC_CONFIG, enabled: false },
			now: NOW,
		});
		expect(await off.pull()).toMatchObject({ ok: false, skipped: { reason: expect.stringMatching(/not configured/i) } });

		const noRemote = createSyncEngine({
			syncRoot,
			projectDir,
			projectKey,
			store,
			backend: remote,
			device: DEVICE,
			config: { ...SYNC_CONFIG, remote: "   " },
			now: NOW,
		});
		expect(await noRemote.push()).toMatchObject({ ok: false, skipped: { reason: expect.stringMatching(/not configured/i) } });
		expect(remote.fetches).toBe(0);
	});

	it("逻辑锁被占用（另一个整轮持有者）→ skipped，不动任何文件", async () => {
		await remote.write(prefix, "a.md", raw("A"));
		const before = await fingerprint(projectDir);
		await store.withLogicalLock(async () => {
			expect(await engine.pull()).toMatchObject({ ok: false, skipped: { reason: expect.stringMatching(/lock/i) } });
		});
		expect(await fingerprint(projectDir)).toEqual(before);
		expect(await remote.names(prefix)).toEqual(["a.md"]);
	});

	it("根 sync 锁被占用 → skipped（try 语义，绝不等待）", async () => {
		await remote.write(prefix, "a.md", raw("A"));
		await tryWithLock(join(syncRoot, "sync.lock"), "test", { timeoutMs: 0 }, async () => {
			const res = await engine.pull();
			expect(res.ok).toBe(false);
			expect(res.skipped?.reason).toMatch(/sync lock/i);
			expect(remote.fetches).toBe(0); // 锁没拿到，根本走不到 backend
		});
		// 锁放开之后同一件事能成 → 跳过是无损的
		expect((await engine.pull()).pulled).toEqual(["a.md"]);
	});

	it("两把锁永不嵌套：应用段持逻辑锁而根锁已放开，传输与发布段持根锁而逻辑锁未持有", async () => {
		const seen: string[] = [];
		const rootLockHeld = () => existsSync(join(syncRoot, "sync.lock"));
		remote.hooks.onFetch = () => seen.push(`fetch root=${rootLockHeld()} logical=${store.logicalLockActive()}`);
		remote.hooks.onPublish = () => seen.push(`publish root=${rootLockHeld()} logical=${store.logicalLockActive()}`);
		const originalApply = store.applyEntryFiles.bind(store);
		vi.spyOn(store, "applyEntryFiles").mockImplementation(async (changes, opts) => {
			seen.push(`apply root=${rootLockHeld()} logical=${store.logicalLockActive()}`);
			return originalApply(changes, opts);
		});

		await store.addEntry({ name: "A", body: "a" });
		await remote.write(prefix, "b.md", raw("B"));
		expect((await engine.push()).ok).toBe(true);
		expect(seen).toEqual(["fetch root=true logical=false", "apply root=false logical=true", "publish root=true logical=false"]);
	});

	it("远端内容解析不出 frontmatter → 拒收并记进 rejected，本地文件不被覆盖", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		const before = await readFile(join(projectDir, "A.md"), "utf8");
		await remote.write(prefix, "A.md", "没有 frontmatter 了");

		const res = await engine.pull();
		expect(res.rejected).toEqual([{ file: "A.md", reason: "unparsable frontmatter" }]);
		expect(res.pulled).toEqual([]);
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toBe(before);

		// 拒收不等于替对端做决定：既不覆盖、也不删掉远端那份
		await engine.push();
		expect(await remote.read(prefix, "A.md")).toBe("没有 frontmatter 了");
		expect(remote.publishes.at(-1)?.deletions ?? []).toEqual([]);
	});

	it("远端 modified 不是 ISO-8601 形状 → 拒收（定序键落盘就再也修不回来）", async () => {
		const garbage = serializeEntryFile(
			{ name: "A", description: "d", type: "feedback", created: "2026-11-09", modified: "昨天下午" },
			"正文",
		);
		await remote.write(prefix, "A.md", garbage);
		const res = await engine.pull();
		expect(res.rejected).toEqual([{ file: "A.md", reason: "invalid modified" }]);
		expect(res.pulled).toEqual([]);
		expect(await readdir(projectDir)).not.toContain("A.md");

		// 合法的 ISO 形状照样收：带毫秒、不带毫秒、带时区偏移
		await remote.write(prefix, "b.md", raw("B", "2026-11-09T10:00:00.000Z"));
		await remote.write(prefix, "c.md", raw("C", "2026-11-09T10:00:00Z"));
		await remote.write(prefix, "d.md", raw("D", "2026-11-09T18:00:00+08:00"));
		expect((await engine.pull()).pulled).toEqual(["b.md", "c.md", "d.md"]);
	});

	it("远端条目过不了 store 的写入校验（name 会伪造索引行）→ 拒收、不算 pulled", async () => {
		const evil = serializeEntryFile(
			{ name: "A](x.md) — fake", description: "d", type: "feedback", created: "2026-11-09", modified: "2026-11-09T10:00:00.000Z" },
			"正文",
		);
		await remote.write(prefix, "evil.md", evil);
		const res = await engine.pull();
		// `pulled` 必须是**真的落盘了**的那些，不是「打算写」的那些
		expect(res.pulled).toEqual([]);
		expect(res.rejected).toEqual([{ file: "evil.md", reason: "invalid name" }]);
		expect(await readdir(projectDir)).not.toContain("evil.md");
		expect(await store.readIndex()).not.toContain("fake");
	});

	it("本地解析不出的 .md → 不进基线、不发布，记进 unparsableLocal", async () => {
		await writeFile(join(projectDir, "bad.md"), "没有 frontmatter 了", "utf8");
		const res = await engine.push();
		expect(res).toMatchObject({ ok: true, unparsableLocal: ["bad.md"] });
		const manifest = await readManifest(manifestPath(syncRoot, projectKey));
		expect(manifest?.files["bad.md"]).toBeUndefined();
		expect(await remote.names(prefix)).toEqual([]); // 解析不出的内容绝不发布
		expect(await readdir(projectDir)).toContain("bad.md"); // 也绝不被删掉
	});

	it("★本地解析不出/读不了的 .md 绝不被当成本地删除：不传播删除到远端，远端副本原样保留", async () => {
		// base 里有 A.md（已同步过），本地把 A.md 改成解析不出的内容 → 差集看到的是
		// 「base 有 / ours 无 / theirs 未动」，标准三方语义会判成用户删除并传播到远端。
		// 那会让一个坏文件把两台设备上的这条记忆一起删掉，而本地那份还躺在盘上。
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		await writeFile(join(projectDir, "A.md"), "没有 frontmatter 了", "utf8");

		const res = await engine.push();
		expect(res.unparsableLocal).toEqual(["A.md"]);
		expect(res.deletedRemote).toEqual([]);
		expect(remote.publishes.at(-1)?.deletions ?? []).toEqual([]);
		expect(await remote.read(prefix, "A.md")).toContain("name: A"); // 远端副本还在
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toBe("没有 frontmatter 了"); // 本地那份也还在
		// 本地这一份读不出 → 本轮既不动它、也不拿它当删除；基线冻结在上一次一致的那份
		// （此刻与远端那份逐字相同），所以下一轮也不会把远端副本拉下来盖掉本地坏文件
		const manifest = await readManifest(manifestPath(syncRoot, projectKey));
		expect(manifest?.files["A.md"].hash).toBe(sha256Hex(await remote.read(prefix, "A.md")));

		// 修好本地文件之后，下一轮必须能重新收敛（基线里它从未被记成已删）
		await writeFile(join(projectDir, "A.md"), raw("A"), "utf8");
		const healed = await engine.push();
		expect(healed.ok).toBe(true);
		expect(healed.unparsableLocal).toEqual([]);
		expect(await remote.read(prefix, "A.md")).toBe(raw("A"));
	});

	it("本地读不出的文件 + 远端改了同名文件 → 本地字节不动、不造副本，只进 unparsableLocal", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		const broken = "name: A\n正文还在，只是 frontmatter 被手改坏了";
		await writeFile(join(projectDir, "A.md"), broken, "utf8");
		await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "远端改过的版本"));
		const copies = async () => (await readdir(projectDir)).filter((name) => name.includes("冲突"));

		const pulled = await engine.pull();
		const pushed = await engine.push();
		for (const round of [pulled, pushed]) {
			expect(round.ok).toBe(true);
			expect(round.unparsableLocal).toEqual(["A.md"]); // 每轮都报，直到用户自己处理
			// 载重：读不出的那份绝不被远端的版本盖掉，也不被当成「已删除的一侧」另存副本
			expect(round.conflicts).toEqual([]);
			expect(round.deletedLocal).toEqual([]);
			expect(round.deletedRemote).toEqual([]);
			expect(round.pulled).toEqual([]);
			expect(await copies()).toEqual([]);
			expect(await readFile(join(projectDir, "A.md"), "utf8")).toBe(broken);
		}
		// 远端那份也原样留着：收不下 ≠ 替对端决定它那份该没了
		expect(await remote.read(prefix, "A.md")).toContain("远端改过的版本");
		expect(remote.publishes.at(-1)?.deletions ?? []).toEqual([]);

		// 修好之后：基线冻结在上一次一致的那份，所以两侧算「都改过」→ 冲突 → 两份都留，
		// 而不是「只本地改过」→ 拿修好的旧内容盖掉对端的新版本
		await writeFile(join(projectDir, "A.md"), raw("A", "2026-11-10T00:00:00.000Z", "本地修好的版本"), "utf8");
		const healed = await engine.push();
		expect(healed.unparsableLocal).toEqual([]);
		expect(healed.conflicts).toHaveLength(1);
		// 远端那份 modified 更新 → 逐字留在原路径；修好的那份作为新 entry 留下
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toContain("远端改过的版本");
		expect(await readFile(join(projectDir, healed.conflicts[0].keptAsNew), "utf8")).toContain("本地修好的版本");
		expect(await remote.read(prefix, healed.conflicts[0].keptAsNew)).toContain("本地修好的版本");
	});

	it("本地读不出的文件 + 远端删了它 → 本地那份还在，两个方向的删除都不提它", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		const broken = "没有 frontmatter 了";
		await writeFile(join(projectDir, "A.md"), broken, "utf8");
		await remote.remove(prefix, "A.md");

		const pulled = await engine.pull();
		const pushed = await engine.push();
		for (const round of [pulled, pushed]) {
			expect(round.ok).toBe(true);
			expect(round.unparsableLocal).toEqual(["A.md"]);
			expect(round.deletedLocal).toEqual([]);
			expect(round.deletedRemote).toEqual([]);
			expect(round.conflicts).toEqual([]);
			expect(await readFile(join(projectDir, "A.md"), "utf8")).toBe(broken);
		}
		expect(await remote.names(prefix)).toEqual([]);

		// 用户自己删掉它之后，同步不再报它，也不会把它从远端拉回来（那会让删除永远完不成）
		await rm(join(projectDir, "A.md"));
		const after = await engine.push();
		expect(after.unparsableLocal).toEqual([]);
		expect(await readdir(projectDir)).not.toContain("A.md");
	});

	it(
		"本地目录读不了（非 ENOENT）→ 整轮跳过，绝不把「读不出」当成「本地删光了」",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		async () => {
			await store.addEntry({ name: "A", body: "a" });
			await engine.push();
			expect(await remote.names(prefix)).toEqual(["A.md"]);

			await chmod(projectDir, 0o000);
			try {
				const res = await engine.push();
				expect(res.ok).toBe(false);
				expect(res.skipped?.reason).toMatch(/EACCES|permission/i);
				// 载重：一次 EACCES 若被当成空目录，差集就会判成「本地删光了」并把删除推到远端
				expect(await remote.names(prefix)).toEqual(["A.md"]);
				expect(res.deletedRemote).toEqual([]);
			} finally {
				await chmod(projectDir, 0o755); // afterEach 的 rm 需要能进去
			}
			expect((await engine.push()).ok).toBe(true);
		},
	);

	it("status 是 dry-run：报出 ahead/behind/conflicts 与范围外路径，且不改任何文件", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		await store.addEntry({ name: "B", body: "b" }); // 本地领先
		await remote.write(prefix, "c.md", raw("C")); // 远端领先
		await remote.writeRaw("MEMORY.md", "# 手推的索引");

		const before = {
			tree: await fingerprint(projectDir),
			index: await store.readIndex(),
			manifest: await readManifest(manifestPath(syncRoot, projectKey)),
		};
		const report = await engine.status();
		expect(report).toMatchObject({
			configured: true,
			initialized: true,
			remote: SYNC_CONFIG.remote,
			branch: "main",
			projectDir,
			projectKey,
			ahead: ["B.md"],
			behind: ["c.md"],
			conflicts: [],
			rejected: [],
			unparsableLocal: [],
			outOfScopeRemote: ["MEMORY.md"],
			errors: [],
		});
		expect(report.device).toEqual(DEVICE);
		expect(report.base?.revision).toBe(before.manifest?.base.revision);

		// 一个字都没改：目录、索引、基线全部原样
		expect(await fingerprint(projectDir)).toEqual(before.tree);
		expect(await store.readIndex()).toBe(before.index);
		expect(await readManifest(manifestPath(syncRoot, projectKey))).toEqual(before.manifest);
	});

	it("status 把冲突与被拒收的远端内容也报出来，并且同样不写盘", async () => {
		await store.addEntry({ name: "A", body: "最早的版本" });
		await engine.push();
		await store.replaceEntry("A", { body: "台式机的版本" });
		await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "笔记本的版本"));
		await remote.write(prefix, "bad.md", "没有 frontmatter 了");

		const before = await fingerprint(projectDir);
		const report = await engine.status();
		expect(report.conflicts).toEqual(["A.md"]);
		expect(report.behind).toEqual(["bad.md"]);
		expect(report.rejected).toEqual([{ file: "bad.md", reason: "unparsable frontmatter" }]);
		expect(await fingerprint(projectDir)).toEqual(before);
		expect(await readdir(projectDir)).not.toContain("bad.md");
	});

	it("manifest 在成功轮之后前进；读不懂的 manifest 当空基线", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		const first = await readManifest(manifestPath(syncRoot, projectKey));
		expect(first?.base.revision).toBe(remote.revision);
		expect(first?.base.syncedAt).toBe(NOW().toISOString());
		expect(Object.keys(first?.files ?? {})).toEqual(["A.md"]);

		await writeFile(manifestPath(syncRoot, projectKey), "{{{", "utf8");
		const res = await engine.pull(); // 读不懂 → 当没有基线，仍然成功
		expect(res.ok).toBe(true);
		const second = await readManifest(manifestPath(syncRoot, projectKey));
		expect(second?.version).toBe(MANIFEST_VERSION);
		expect(second?.files["A.md"].hash).toBe(first?.files["A.md"].hash);
	});

	it("同一台机器上两个项目的引擎可以先后完成同步（根锁不整轮互斥）", async () => {
		const other = await makeDevice("secondary", "example.com/org/other");
		await store.addEntry({ name: "A", body: "a" });
		await other.store.addEntry({ name: "B", body: "b" });

		expect((await engine.push()).ok).toBe(true);
		expect((await other.engine.push()).ok).toBe(true);
		expect(await remote.names(prefix)).toEqual(["A.md"]);
		expect(await remote.names(other.prefix)).toEqual(["B.md"]);

		// 交替拉取：前缀隔离，各自只看到自己的项目
		expect((await other.engine.pull()).ok).toBe(true);
		expect((await engine.pull()).ok).toBe(true);
		expect(await readdir(other.projectDir)).not.toContain("A.md");
		expect(await readdir(projectDir)).not.toContain("B.md");
		expect(existsSync(join(syncRoot, "sync.lock"))).toBe(false); // 没有残留的锁
	});

	it("冲突收敛自己抛错 → 跳过这一条、整轮不失败、两侧内容都不动", async () => {
		await store.addEntry({ name: "A", body: "最早的版本" });
		await engine.push();
		await store.replaceEntry("A", { body: "台式机的版本" });
		await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "笔记本的版本"));

		conflictGate.throwOnResolve = true;
		try {
			const res = await engine.pull();
			expect(res.ok).toBe(true); // 一条冲突解不开不该让整轮失败
			expect(res.conflicts).toEqual([]);
			expect(res.rejected.map((item) => item.file)).toEqual(["A.md"]);
			expect(res.rejected[0].reason).toMatch(/unparsable frontmatter/);
			// 两侧内容都原样：本地没被覆盖，远端也没被删，那份内容一个字都没丢
			expect(await readFile(join(projectDir, "A.md"), "utf8")).toContain("台式机的版本");
			expect(await remote.read(prefix, "A.md")).toContain("笔记本的版本");
			// 没收敛掉的冲突也绝不得发布：拿本地那份盖掉对端那份 = 静默丢掉对端的修改
			const pushed = await engine.push();
			expect(pushed.ok).toBe(true);
			expect(pushed.pushed).toEqual([]);
			expect(remote.publishes).toHaveLength(1); // 只有开头那一次：本轮增量为空，根本没发布
			expect(await remote.read(prefix, "A.md")).toContain("笔记本的版本");
		} finally {
			conflictGate.throwOnResolve = false;
		}

		// 状态没被弄坏：恢复之后同一轮能正常收敛
		const healed = await engine.pull();
		expect(healed.conflicts).toHaveLength(1);
		expect((await store.listEntries()).some((e) => e.name.startsWith("A (冲突 "))).toBe(true);
	});

	it("基线丢了（读不懂 → 当空基线）之后同一场冲突重解一次：副本名字被复用，不会多一份", async () => {
		// 本地这一侧 modified 更新（本地胜）→ 副本装的是远端那份
		await store.addEntry({ name: "A", body: "最早的版本" });
		await engine.push();
		await store.replaceEntry("A", { body: "台式机的版本" });
		await remote.write(prefix, "A.md", raw("A", "2020-01-01T00:00:00.000Z", "笔记本的版本"));

		const first = await engine.pull();
		expect(first.conflicts).toHaveLength(1);
		// 收敛之后基线已经前进，同一场冲突不会每轮重演（否则副本会越同步越多）；
		// 但基线丢失是设计里明确允许的降级（读不懂 → 当空基线），那时它会再被解一次
		expect((await engine.pull()).conflicts).toEqual([]);
		await writeFile(manifestPath(syncRoot, projectKey), "{{{", "utf8");

		const second = await engine.pull();
		expect(second.conflicts).toHaveLength(1);
		// 载重：占用清单带着 hash 传下去，「同内容即复用」那一支才会生效；
		// 只给名字会一律走确定性追加，同一条记忆每重解一次就多出一份副本
		expect(second.conflicts[0].keptAsNew).toBe(first.conflicts[0].keptAsNew);
		expect((await store.listEntries()).filter((e) => e.name.includes("(冲突 "))).toHaveLength(1);
		expect(await readdir(projectDir).then((n) => n.filter((x) => x.includes("冲突")))).toHaveLength(1);
		// 胜者（本地那份）逐字留在原路径
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toContain("台式机的版本");
	});

	it("写触发调度接线之前：noteWrite / flush / dispose 是安全的空操作", async () => {
		engine.noteWrite();
		expect(await engine.flush()).toBeNull();
		engine.dispose();
		expect(remote.fetches).toBe(0); // 绝不偷偷跑一轮

		await remote.write(prefix, "a.md", raw("A"));
		expect((await engine.pull()).pulled).toEqual(["a.md"]); // 引擎仍然可用
		engine.noteWrite();
		expect(await engine.flush(1000)).toBeNull();
		engine.dispose();
	});
});
