import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type SyncConfig, syncConfigErrors } from "../src/config.js";
import {
	NonFastForwardError,
	type RemoteView,
	type SyncBackend,
	type SyncPublishChanges,
	type SyncRunOptions,
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
	/** 探针：在假远端真开始一次 `fetch` / `publish` 之前跑（可以是异步的：模拟对端同时推东西）。 */
	hooks: { onFetch?: () => void | Promise<void>; onPublish?: () => void | Promise<void> };
	/** 模拟另一台设备往某个前缀推了一个文件。 */
	write(prefix: string, path: string, content: string): Promise<void>;
	/** 模拟有人手工往远端根推了一个范围外路径。 */
	writeRaw(path: string, content: string): Promise<void>;
	/** 模拟另一台设备删掉了某个前缀下的文件（远端删除，revision 同样要前进）。 */
	remove(prefix: string, path: string): Promise<void>;
	read(prefix: string, path: string): Promise<string>;
	names(prefix: string): Promise<string[]>;
}

/** 远端布局里「另一个项目的记忆文件」：`git/<项目 key>/<单层 .md>`（与 git backend 的判据同一份形状）。 */
const OTHER_PROJECT_ENTRY_RE = /^git\/[^/]+\/[^/]+\.md$/;

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
			await remote.hooks.onFetch?.();
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
				for (const path of files.keys()) {
					// 别的项目的**扁平 entry** 是设计规定的正常布局，不算异常（口径同 git backend 的
					// classify）：报出来就等于每一轮都随项目数 × 记忆数线性增长地刷噪声。
					if (!OTHER_PROJECT_ENTRY_RE.test(`${other}/${path}`)) outOfScope.push(`${other}/${path}`);
				}
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
			await remote.hooks.onPublish?.();
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
async function makeDevice(
	name: string,
	identityKey = "example.com/org/proj",
	storeOver: Partial<StoreConfig> = {},
): Promise<Device> {
	const root = join(dir, name);
	const sync = join(root, ".sync");
	const project = join(root, "git", "proj");
	await mkdir(sync, { recursive: true });
	await mkdir(project, { recursive: true });
	const memoryStore = new MemoryStore(CFG(project, storeOver));
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
	vi.useRealTimers(); // 某条用例中途失败时也别把假定时器留给后面的文件
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
		// 后缀取自**败者**（台式机那份）的 modified 与指纹。指纹钉成字面量而不是一段形状正则：
		// 它必须取自败者的**原始字节**，而不是加后缀重序列化之后的那一份 —— 两种取法都满足
		// `[0-9a-f]{6}`，只有字面量能钉住「指纹取自哪一份字节」（与用户在 name 后缀里看到的同源）。
		expect(copiesOne[0].file).toBe("发布状态-(冲突-2026-11-05)-656074.md");
		expect(copiesOne[0].name).toBe("发布状态 (冲突 2026-11-05 656074)");
	});

	it("删除 vs 修改：删除照办，被修改的那份作为新 entry 留下", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push();
		await store.removeEntry("A"); // 本地删了
		await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "远端改过的版本")); // 远端改了

		const res = await engine.pull();
		expect(res.conflicts).toHaveLength(1);
		expect(res.deletedLocal).toEqual(["A.md"]); // 删除照办
		// 「删除照办」是这一轮就判定并落盘的（收敛把原路径放进了发布增量），所以当轮就要报：
		// 等到下一轮才报，用户会以为自己的删除还没被同步接受
		expect(res.deletedRemote).toEqual(["A.md"]);
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

	it("★远端有 win32 保留名 + 一条合法记忆：合法的落地，保留名报成范围外，整轮不失败", async () => {
		// 平台固定成 linux：保留名的**读**口径在 Linux 上是宽松的（`con.md` 是一条合法记忆），
		// 所以这里能钉住「远端名字走的是写口径」—— 若跟着本机平台走，win32 runner 上这条会恒真。
		const dev = await makeDevice("reserved", "example.com/org/reserved", { platform: "linux" });
		await remote.write(dev.prefix, "con.md", raw("CON 设备名"));
		await remote.write(dev.prefix, "a.md", raw("A"));

		const res = await dev.engine.pull();
		// 载重：整轮不得失败。保留名若进了差集，`applyEntryFiles` 会在落盘前为它整批抛错 ——
		// 合法那条也一起不落盘，而且下一轮一模一样：同步彻底停摆。
		expect(res).toMatchObject({ ok: true, pulled: ["a.md"] });
		expect(res.skipped).toBeUndefined();
		expect(res.outOfScopeRemote).toEqual([`${dev.prefix}/con.md`]);
		expect(await readFile(join(dev.projectDir, "a.md"), "utf8")).toBe(raw("A"));
		expect(await readdir(dev.projectDir)).not.toContain("con.md");
		expect(await dev.store.readIndex()).toContain("- [A](a.md)");

		// 快照只为**真落盘的那一批**拍一份；下一轮什么都没改，不得再白拍（否则用户用于崩溃
		// 恢复的 keep 名额会被一个永远修不好的名字每轮挤掉一个）。
		const snapshots = await backupNames(dev.projectDir, "sync");
		expect(snapshots).toHaveLength(1);
		const again = await dev.engine.pull();
		expect(again).toMatchObject({ ok: true, pulled: [], outOfScopeRemote: [`${dev.prefix}/con.md`] });
		expect(await backupNames(dev.projectDir, "sync")).toEqual(snapshots);

		// status 也得报它：用户要能看见「远端有东西没被同步」，而不是只看到每轮都少一条
		const report = await dev.engine.status();
		expect(report.outOfScopeRemote).toEqual([`${dev.prefix}/con.md`]);
		expect(report.errors).toEqual([]);
		expect(report.behind).toEqual([]);
	});

	it("★本地有在任何设备上都写不下去的名字：不发布，只报一行（不得把它埋进远端）", async () => {
		const dev = await makeDevice("reserved-local", "example.com/org/reserved-local", { platform: "linux" });
		// store 自己永远造不出这个名字（`entryFileName` 会给保留名加 `_` 前缀），只能手工落一个：
		// 读口径在 Linux 上看得见它，所以它会进扫描、进差集的 pushLocal。
		await writeFile(join(dev.projectDir, "con.md"), raw("CON 设备名"), "utf8");
		await dev.store.addEntry({ name: "A", body: "a" });

		const res = await dev.engine.push();
		expect(res.ok).toBe(true);
		// 合法那条照常发布，那个名字只报一行（原因词是稳定词汇）
		expect(res.pushed).toEqual(["A.md"]);
		expect(res.rejected).toEqual([{ file: "con.md", reason: "unpublishable file name" }]);
		expect(await remote.names(dev.prefix)).toEqual(["A.md"]);
		// 本地那份原样留着（只是不同步），并且每轮都报：用户改名字之前不会静默消失
		expect(await readFile(join(dev.projectDir, "con.md"), "utf8")).toBe(raw("CON 设备名"));
		expect((await dev.engine.push()).rejected).toEqual([{ file: "con.md", reason: "unpublishable file name" }]);

		// status 同一口径：`ahead` 里列着它，就得同时说清楚它为什么永远推不上去
		const report = await dev.engine.status();
		expect(report.ahead).toEqual(["con.md"]);
		expect(report.rejected).toEqual([{ file: "con.md", reason: "unpublishable file name" }]);
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

	it("★远端有 3 个项目：每个项目的 outOfScopeRemote 只含异常路径，兄弟项目的记忆一条都不报", async () => {
		// 设计规定的部署形态：一个远端仓库镜像整个记忆根，一次会话只同步当前项目。
		// 若把「整棵树减去本前缀」当成范围外，这里的报告会是 3 × 2 条噪声，而真信号只有 2 条 ——
		// 换成用户真实的规模（20 个项目 × 100 条记忆）就是每轮约 2000 条。
		const keys = ["example.com/org/a", "example.com/org/b", "example.com/org/c"];
		const devices: Device[] = [];
		for (const [index, key] of keys.entries()) devices.push(await makeDevice(`proj-${index}`, key));

		for (const dev of devices) {
			await dev.store.addEntry({ name: "记忆", body: dev.projectKey });
			expect((await dev.engine.push()).ok).toBe(true);
		}
		// 两条真异常：仓库根手推上来的索引、以及某个前缀底下的嵌套目录
		await remote.writeRaw("MEMORY.md", "# 手推的索引");
		await remote.write(devices[1].prefix, "sub/nested.md", raw("N"));
		const anomalies = ["MEMORY.md", `${devices[1].prefix}/sub/nested.md`].sort();

		for (const dev of devices) {
			const res = await dev.engine.pull();
			expect(res.ok).toBe(true);
			// 兄弟项目那 6 条记忆一条都不报，两条真异常一个都不漏
			expect(res.outOfScopeRemote.sort(), dev.projectKey).toEqual(anomalies);
			// status 是同一份口径（用户平时看的是它）
			expect((await dev.engine.status()).outOfScopeRemote.sort(), dev.projectKey).toEqual(anomalies);
			// 自己的那条记忆照常同步，没有被兄弟项目的存在挤掉
			expect(await readdir(dev.projectDir)).toContain("记忆.md");
		}
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

	it("发布时的传输错误（不重跑）：本轮已经拉到本地的内容仍在失败结果里", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push(); // 先对齐
		await store.addEntry({ name: "B", body: "b" }); // 本轮要推的本地新增
		await remote.write(prefix, "c.md", raw("C")); // 对端领先一条 → 应用段会先把它拉下来
		remote.failNext = "publish"; // 发布段炸掉（不是非快进，所以不重跑）

		const res = await engine.push();
		expect(res.ok).toBe(false);
		expect(res.skipped?.reason).toMatch(/publish failed/i);
		// 载重：失败发生在应用段**之后** —— c.md 已经落到本地并进了索引，报告不能声称什么都没发生
		expect(res.pulled).toEqual(["c.md"]);
		expect(res.pushed).toEqual([]);
		expect(await readFile(join(projectDir, "c.md"), "utf8")).toBe(raw("C"));
		expect(await store.readIndex()).toContain("- [C](c.md)");
		expect(await backupNames(projectDir, "sync")).not.toEqual([]);
		// 基线只写到 fetch 到的那个版本（没发布成功，绝不前进），报出去的 revision 与它一致
		expect(res.revision).toBe(remote.revision);
		expect((await readManifest(manifestPath(syncRoot, projectKey)))?.base.revision).toBe(remote.revision);
		// 脏状态原样留着：下一次 push 把本地那条推出去
		expect((await engine.push()).pushed).toEqual(["B.md"]);
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

	it("非快进重跑之间对端又推了新内容：失败的那一轮必须报出它已经拉到本地的东西", async () => {
		await store.addEntry({ name: "A", body: "a" });
		await engine.push(); // 基线与远端对齐
		await store.addEntry({ name: "B", body: "b" }); // 本轮要推的本地新增
		await remote.write(prefix, "c.md", raw("C")); // 对端领先一条：第一次尝试会把它拉下来
		// 两次 publish 都撞非快进；第一次失败的**同时**对端又推了一条（d.md），
		// 于是重跑的那一轮真的会改本地（拉下 d.md、拍 `-sync` 快照、写基线），然后才在发布段再次失败
		remote.nonFastForward = 2;
		let peerPushed = false;
		remote.hooks.onPublish = async () => {
			if (peerPushed) return;
			peerPushed = true;
			await remote.write(prefix, "d.md", raw("D"));
		};

		const fetchesBefore = remote.fetches;
		const res = await engine.push();
		expect(res.ok).toBe(false);
		expect(res.skipped?.reason).toMatch(/moved on/i);
		expect(res.skipped?.reason).toMatch(/gave up after 2 attempts/i);
		// 措辞只说真话：本轮确实已经改过本地，所以绝不能声称「本地没动过」
		expect(res.skipped?.reason).not.toMatch(/untouched/i);
		expect(remote.fetches).toBe(fetchesBefore + 2); // 上限就是一次重跑
		// 载重：两次尝试各自拉下来的都得报 —— 重跑不撤销上一次的落盘，而上一轮拉的东西
		// 在新基线里已经是「两侧一致」的，只报后一次的话用户仍然会看到「本轮什么都没拉」
		expect([...res.pulled].sort()).toEqual(["c.md", "d.md"]);
		expect(res.pushed).toEqual([]); // 什么都没发布出去
		expect(await readFile(join(projectDir, "c.md"), "utf8")).toBe(raw("C"));
		expect(await readFile(join(projectDir, "d.md"), "utf8")).toBe(raw("D"));
		expect(await readFile(join(projectDir, "B.md"), "utf8")).toContain("name: B"); // 本地那份也还在
		expect(await store.readIndex()).toContain("- [D](d.md)");
		expect(await backupNames(projectDir, "sync")).not.toEqual([]); // 真的改过本地 → 真的有快照
	});

	it("重跑那一轮造出的冲突副本：失败结果里看得见，副本也真的在盘上", async () => {
		await store.addEntry({ name: "A", body: "最早的版本" });
		await engine.push(); // 基线与远端都停在「最早的版本」
		await store.replaceEntry("A", { body: "台式机的版本" }); // 本地改了，还没推出去
		remote.nonFastForward = 2;
		let peerPushed = false;
		// 第一次发布失败的同时对端改了同一个文件：重跑的那一轮就是「两侧都改过」→ 冲突
		remote.hooks.onPublish = async () => {
			if (peerPushed) return;
			peerPushed = true;
			await remote.write(prefix, "A.md", raw("A", "2099-01-01T00:00:00.000Z", "笔记本的版本"));
		};

		const res = await engine.push();
		expect(res.ok).toBe(false);
		expect(res.skipped?.reason).toMatch(/moved on/i);
		// 载重：这一轮**已经**把冲突收敛完了（副本落盘、索引重建、基线写好），然后才在发布段失败。
		// 报告里必须看得见 —— 否则用户拿到的是一份「什么都没发生」的结果，而盘上多了一条记忆
		expect(res.conflicts).toHaveLength(1);
		const keptAsNew = res.conflicts[0].keptAsNew;
		expect(keptAsNew).toMatch(/^A-\(冲突-\d{4}-\d{2}-\d{2}\)-[0-9a-f]{6}\.md$/);
		expect(await readFile(join(projectDir, keptAsNew), "utf8")).toContain("台式机的版本");
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toContain("笔记本的版本");
		expect(await store.readIndex()).toContain(keptAsNew);
		expect(res.pulled).toEqual([]); // 它是冲突，不是干净的拉取
		expect(res.pushed).toEqual([]); // 什么都没发布出去
		expect(await remote.names(prefix)).toEqual(["A.md"]); // 远端只有对端自己推的那份
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

	it("★\"enabled\": \"false\" 是字符串真值 → 仍按未启用处理，一个字节都不推", async () => {
		// 宿主把 JSON.parse 的结果直接喂给配置合并，所以这种手误真会发生；而 `"false"` 在 JS 里是
		// 真值 —— 按真值判定就会把用户明写的「关」读成「开」，记忆继续往远端推。这是同意边界。
		const off = engineWith(remote, { enabled: "false" as unknown as boolean });
		await store.addEntry({ name: "A", body: "a" });

		expect(await off.pull()).toMatchObject({ ok: false, skipped: { reason: expect.stringMatching(/not configured/i) } });
		expect(await off.push()).toMatchObject({ ok: false, skipped: { reason: expect.stringMatching(/not configured/i) } });
		expect(remote.fetches).toBe(0);
		expect(remote.publishAttempts).toBe(0);

		const report = await off.status();
		expect(report.configured).toBe(false);
		expect(report.errors).toEqual([expect.stringMatching(/not configured/i)]);
		// 校验出口也不再谎报「配置没问题」：两处必须同一个口径，否则用户得不到任何提示
		expect(
			syncConfigErrors({ ...DEFAULT_CONFIG, sync: { ...SYNC_CONFIG, enabled: "false" as unknown as boolean } }),
		).toHaveLength(1);
		off.dispose();
	});

	it("★\"pushOnWrite\": \"false\" → 写入不排自动推送（走空转调度器）", async () => {
		const eng = engineWith(remote, { pushOnWrite: "false" as unknown as boolean });
		vi.useFakeTimers();
		try {
			eng.noteWrite();
			await vi.advanceTimersByTimeAsync(SYNC_CONFIG.pushDebounceMs * 3);
			// 载重：一次远端往返都没发生（真调度器会在静默期到点时跑一轮 push）
			expect(remote.fetches).toBe(0);
			expect(remote.publishAttempts).toBe(0);
			expect(eng.inFlight).toBeNull();
			expect(await eng.flush()).toBeNull();
		} finally {
			eng.dispose();
			vi.useRealTimers();
		}
	});

	it("逻辑锁被占用（另一个整轮持有者）→ skipped，不动任何文件", async () => {
		await remote.write(prefix, "a.md", raw("A"));
		const before = await fingerprint(projectDir);
		await store.withLogicalLock(async () => {
			const res = await engine.pull();
			expect(res).toMatchObject({ ok: false, skipped: { reason: expect.stringMatching(/lock/i) } });
			// 本轮一个字都没落盘、基线也没写过，就不报 revision：失败的那一份结果同样会交到用户手上
			expect(res.revision).toBeUndefined();
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
		remote.hooks.onFetch = () => {
			seen.push(`fetch root=${rootLockHeld()} logical=${store.logicalLockActive()}`);
		};
		remote.hooks.onPublish = () => {
			seen.push(`publish root=${rootLockHeld()} logical=${store.logicalLockActive()}`);
		};
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

		// 被拒收的名字在基线里退回上一次**真的一致过**的那份，所以后续每一轮仍然判成
		// 「远端改了 → 拒收」，而不是退化成「两侧各新增了一份」→ 冲突：
		// 否则 status 会在拒收旁边永久多报一条并不存在的冲突
		const report = await engine.status();
		expect(report.conflicts).toEqual([]);
		expect(report.behind).toEqual(["A.md"]);
		expect(report.rejected).toEqual([{ file: "A.md", reason: "unparsable frontmatter" }]);
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

	it("status 在未配置时也给出字段齐全的报告（不碰远端）", async () => {
		const off = createSyncEngine({
			syncRoot,
			projectDir,
			projectKey,
			store,
			backend: remote,
			device: DEVICE,
			config: { ...SYNC_CONFIG, remote: "   " },
			now: NOW,
		});
		const report = await off.status();
		// 字段齐全且取的是装配参数：早退路径与正常路径共用同一份初值，加字段时不会漏掉一边
		expect(report).toMatchObject({
			configured: false,
			initialized: false,
			remote: "   ",
			branch: "main",
			projectDir,
			projectKey,
			base: null,
			ahead: [],
			behind: [],
			conflicts: [],
			rejected: [],
			unparsableLocal: [],
			outOfScopeRemote: [],
		});
		expect(report.device).toEqual(DEVICE);
		expect(report.errors).toEqual([expect.stringMatching(/not configured/i)]);
		expect(remote.fetches).toBe(0);
	});

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

	it("写触发推送关闭（pushOnWrite: false）时，noteWrite 一个字节都不推", async () => {
		const quiet = createSyncEngine({
			syncRoot,
			projectDir,
			projectKey,
			store,
			backend: remote,
			device: DEVICE,
			config: { ...SYNC_CONFIG, pushOnWrite: false },
			now: NOW,
		});
		// 先把条目写好，再换假定时器：store 的写入要拿进程内锁，那里重试会睡真实时间，
		// 只为被测的推送开假定时器就够了
		await store.addEntry({ name: "B", body: "b" });
		vi.useFakeTimers();
		try {
			quiet.noteWrite();
			await vi.advanceTimersByTimeAsync(3 * SYNC_CONFIG.pushDebounceMs);

			expect(quiet.inFlight).toBeNull();
			expect(await quiet.flush()).toBeNull(); // 空转版本连 flush 都不跑一轮
			expect(remote.fetches).toBe(0);
			expect(await remote.names(prefix)).toEqual([]); // 一条都没推出去
		} finally {
			quiet.dispose();
			vi.useRealTimers();
		}
	});

	it("noteWrite 之后经过 pushDebounceMs 会自动推一次（在途的那一份对宿主可见）", async () => {
		// 同上：条目先落地，假定时器只覆盖推送本身
		await store.addEntry({ name: "A", body: "a" });
		vi.useFakeTimers();
		let pushing: Promise<unknown> | null = null;
		try {
			// 探针：传输段真的开始了 → 这一刻这一推一定还在途，inFlight 断言因此是确定的
			const started = new Promise<void>((resolve) => {
				remote.hooks.onFetch = () => resolve();
			});
			engine.noteWrite();
			expect(remote.fetches).toBe(0); // 静默期没到，一轮都不跑
			await vi.advanceTimersByTimeAsync(SYNC_CONFIG.pushDebounceMs - 1);
			expect(remote.fetches).toBe(0);

			await vi.advanceTimersByTimeAsync(1);
			await started;
			pushing = engine.inFlight;
			expect(pushing).not.toBeNull(); // 宿主退出前等的就是这一份
			await pushing; // 推送里有真 I/O，假定时器不等它，得自己等

			expect(await remote.names(prefix)).toEqual(["A.md"]);
			expect(engine.inFlight).toBeNull();
			// 推完之后静下来：不会自己再推第二次（脏标记只由写入置位）
			await vi.advanceTimersByTimeAsync(5 * SYNC_CONFIG.pushDebounceMs);
			expect(remote.fetches).toBe(1);

			// flush 转发给调度器：立刻推一次，不等去抖（退出兜底 / 手动补推走的就是这条路）
			await store.addEntry({ name: "B", body: "b" });
			engine.noteWrite(); // 写入之后由宿主通知引擎（引擎不自己去挂 store）
			expect(await engine.flush()).toMatchObject({ ok: true, pushed: ["B.md"] });
			expect(await remote.names(prefix)).toEqual(["A.md", "B.md"]);
			expect(remote.fetches).toBe(2);
			expect(await engine.flush()).toBeNull(); // 没脏的东西了 → 不再跑一轮
			expect(remote.fetches).toBe(2);

			// dispose 转发给调度器：收摊之后的写入不再自动推
			engine.dispose();
			engine.noteWrite();
			await vi.advanceTimersByTimeAsync(5 * SYNC_CONFIG.pushDebounceMs);
			expect(remote.fetches).toBe(2);
		} finally {
			remote.hooks.onFetch = undefined;
			await pushing?.catch(() => null);
			engine.dispose();
			vi.useRealTimers();
		}
	});

	it("自动推送撞上锁被跳过 → 引擎不谎报干净，flush 把这一推补上", async () => {
		// 用户写了几条记忆就退出，而这一刻整理轮正持着项目的逻辑锁（或另一个项目持着根锁）：
		// 到点的那一推被跳过，一个字节都没发出去。少了「跳过 → 仍未发布」这一层，宿主退出前问
		// flush 会得到「没有待发布内容」，那几条记忆就只能等下一次写入或下一次会话的补推
		await store.addEntry({ name: "A", body: "a" });
		vi.useFakeTimers();
		try {
			await tryWithLock(join(syncRoot, "sync.lock"), "test", { timeoutMs: 0 }, async () => {
				engine.noteWrite();
				await vi.advanceTimersByTimeAsync(SYNC_CONFIG.pushDebounceMs);
				const skipped = engine.inFlight;
				expect(skipped).not.toBeNull();
				await skipped; // 轮里有真 I/O，假定时器不等它
				expect(await remote.names(prefix)).toEqual([]); // 锁没拿到 → 什么都没推出去
				expect(remote.fetches).toBe(0); // 跳过的那一轮根本走不到 backend
			});
			expect(engine.inFlight).toBeNull();

			// 锁放开之后由 flush 补推：这正是宿主退出兜底走的那条路
			expect(await engine.flush()).toMatchObject({ ok: true, pushed: ["A.md"] });
			expect(await remote.names(prefix)).toEqual(["A.md"]);
			expect(remote.fetches).toBe(1);
			expect(await engine.flush()).toBeNull(); // 补推成功之后才真的干净
			expect(remote.fetches).toBe(1);
		} finally {
			engine.dispose();
			vi.useRealTimers();
		}
	});

	// ---------------------------------------------------------------------
	// 一轮的时间预算与中止信号
	// ---------------------------------------------------------------------

	/** 每次调用收到的运行参数：预算递减与「同一轮同一个 signal」都靠它断言。 */
	type SeenCall = { call: "fetch" | "publish"; timeoutMs: number; signal?: AbortSignal };

	/**
	 * 把真 backend 包一层：记下运行参数，并让 `fetch` 花掉一点真时间 ——
	 * 预算是「剩下的毫秒」，只有真花了时间才看得出来它在递减。
	 */
	function instrumented(seen: SeenCall[], fetchDelayMs = 0): SyncBackend {
		const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
		return {
			async ready() {
				return remote.ready();
			},
			async init(opts: SyncRunOptions) {
				return remote.init(opts);
			},
			async fetch(scope: SyncScope, opts: SyncRunOptions): Promise<RemoteView> {
				seen.push({ call: "fetch", timeoutMs: opts.timeoutMs, signal: opts.signal });
				if (fetchDelayMs > 0) await sleep(fetchDelayMs);
				return remote.fetch(scope, opts);
			},
			async publish(
				scope: SyncScope,
				changes: SyncPublishChanges,
				base: { revision: string },
				opts: SyncRunOptions & { message: string; author: { name: string; email: string } },
			): Promise<string> {
				seen.push({ call: "publish", timeoutMs: opts.timeoutMs, signal: opts.signal });
				return remote.publish(scope, changes, base, opts);
			},
		};
	}

	function engineWith(backend: SyncBackend, over: Partial<SyncConfig> = {}): SyncEngine {
		return createSyncEngine({
			syncRoot,
			projectDir,
			projectKey,
			store,
			backend,
			device: DEVICE,
			config: { ...SYNC_CONFIG, ...over },
			now: NOW,
		});
	}

	it("★一轮一份预算与一个 signal：publish 拿到的是 fetch 花剩的毫秒，不是又一份满额", async () => {
		const seen: SeenCall[] = [];
		const eng = engineWith(instrumented(seen, 40), { autoTimeoutMs: 5_000 });
		await store.addEntry({ name: "A", body: "a" }); // 有东西要发布，才会走到 publish

		expect((await eng.push()).ok).toBe(true);
		expect(seen.map((item) => item.call)).toEqual(["fetch", "publish"]);
		// 同一轮共用一个 signal：dispose() 一次就能把整轮（含重跑）收掉
		expect(seen[0].signal).toBeInstanceOf(AbortSignal);
		expect(seen[1].signal).toBe(seen[0].signal);
		expect(seen[0].signal?.aborted).toBe(false);
		// 预算递减：配置那一档（自动档 5s）说的是「一轮」，不是「每个子进程各一份」
		expect(seen[0].timeoutMs).toBeLessThanOrEqual(5_000);
		expect(seen[0].timeoutMs).toBeGreaterThan(4_000);
		expect(seen[1].timeoutMs).toBeLessThan(seen[0].timeoutMs);
		expect(seen[1].timeoutMs).toBeGreaterThan(0);
		eng.dispose();
	});

	it("★预算耗尽时给出去的也不是 0：子进程的 `timeout: 0` 是「不限时」，必须是「立刻超时」", async () => {
		const seen: SeenCall[] = [];
		// fetch 花掉的时间超过整轮预算（离线路径上真会发生：每个子进程各挂满一次）
		const eng = engineWith(instrumented(seen, 80), { autoTimeoutMs: 20 });
		await store.addEntry({ name: "A", body: "a" });

		await eng.push();
		expect(seen.map((item) => item.call)).toEqual(["fetch", "publish"]);
		expect(seen[0].timeoutMs).toBeGreaterThanOrEqual(1);
		expect(seen[1].timeoutMs).toBeGreaterThanOrEqual(1); // 不是 0，也不是负数
		eng.dispose();
	});

	it("非快进的重跑与第一次尝试共用一份预算：耗尽就不再起重跑，并把原因报出来", async () => {
		const seen: SeenCall[] = [];
		remote.nonFastForward = 1; // 第一次 publish 撞非快进 → 本该整轮重跑
		const eng = engineWith(instrumented(seen, 60), { autoTimeoutMs: 50 });
		await store.addEntry({ name: "A", body: "a" });

		const res = await eng.push();
		expect(res.ok).toBe(false);
		expect(res.skipped?.reason).toMatch(/round budget of 50ms ran out/);
		// 载重：没有第二次 fetch —— 拿零头去跑重跑等于让它系统性地饿死，看起来还像一次传输失败
		expect(seen.filter((item) => item.call === "fetch")).toHaveLength(1);
		// 本地那条记忆还在，脏状态也留着（下一次触发接着推）
		expect(await readFile(join(projectDir, "A.md"), "utf8")).toContain("name: A");
		expect(await remote.names(prefix)).toEqual([]);
		eng.dispose();
	});

	it("★dispose() 中止在途那一轮：signal 已交给 backend，abort 之后本轮以失败收尾", async () => {
		const seen: SeenCall[] = [];
		// fetch 挂住，直到它拿到的 signal 被中止 —— 与真 backend 的行为一致（signal 直接交给子进程）
		const hanging: SyncBackend = {
			async ready() {
				return true;
			},
			async init() {},
			async fetch(_scope: SyncScope, opts: SyncRunOptions): Promise<RemoteView> {
				seen.push({ call: "fetch", timeoutMs: opts.timeoutMs, signal: opts.signal });
				await new Promise<void>((_resolve, reject) => {
					const onAbort = (): void => reject(new Error("This operation was aborted"));
					if (opts.signal?.aborted) return onAbort();
					opts.signal?.addEventListener("abort", onAbort, { once: true });
				});
				throw new Error("unreachable: fetch 要么被中止、要么返回快照");
			},
			async publish(): Promise<string> {
				throw new Error("unreachable: 这一轮走不到发布段");
			},
		};
		const eng = engineWith(hanging, { autoTimeoutMs: 60_000 });
		const round = eng.push();
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].signal?.aborted).toBe(false); // 在途时还没中止

		eng.dispose();
		expect(seen[0].signal?.aborted).toBe(true);
		// 一轮同步永远不抛：中止也变成 ok:false + 一句可读的原因（宿主退出路径上不能再抛一次）
		await expect(round).resolves.toMatchObject({
			ok: false,
			skipped: { reason: expect.stringMatching(/abort/i) },
		});
		expect(eng.inFlight).toBeNull();
	});
});
