import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeEntryFile } from "../src/store/entry-file.js";
import { MemoryStore, type StoreConfig } from "../src/store/memory-store.js";

let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
	...over,
});

const raw = (name: string, modified = "2026-11-09T10:00:00.000Z", body = "正文") =>
	serializeEntryFile({ name, description: "d", type: "feedback", created: "2026-11-09", modified }, body);

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-store-apply-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("applyEntryFiles", () => {
	it("逐字落盘：created / modified / description 一个都不改", async () => {
		const res = await store.applyEntryFiles({
			writes: [{ file: "a.md", raw: raw("A", "2020-01-02T03:04:05.678Z") }],
			deletes: [],
		});
		expect(res).toEqual({ written: ["a.md"], deleted: [], rejected: [] });
		expect(await readFile(join(dir, "a.md"), "utf8")).toBe(raw("A", "2020-01-02T03:04:05.678Z"));
		const [entry] = await store.listEntries();
		expect(entry.modified).toBe("2020-01-02T03:04:05.678Z"); // 关键：没有被重打成 now
	});

	it("不碰 MEMORY.md（调用方之后自己 rebuildIndex）", async () => {
		await store.applyEntryFiles({ writes: [{ file: "a.md", raw: raw("A") }], deletes: [] });
		expect(await store.readIndex()).toBe("");
	});

	it("删除：unlink 目标文件并记进 deleted；不存在的文件算已删、不报错", async () => {
		await store.applyEntryFiles({ writes: [{ file: "a.md", raw: raw("A") }], deletes: [] });
		const res = await store.applyEntryFiles({ writes: [], deletes: ["a.md", "nope.md"] });
		expect(res.deleted).toEqual(["a.md", "nope.md"]);
		expect(await readdir(dir)).not.toContain("a.md");
	});

	it("坏 frontmatter 被拒收，不落盘", async () => {
		const res = await store.applyEntryFiles({ writes: [{ file: "a.md", raw: "没有 frontmatter" }], deletes: [] });
		expect(res.written).toEqual([]);
		expect(res.rejected).toEqual([{ file: "a.md", reason: "unparsable frontmatter" }]);
	});

	it("name 含 ]( 的远端文件被拒收", async () => {
		const res = await store.applyEntryFiles({ writes: [{ file: "a.md", raw: raw("A](x.md) — fake") }], deletes: [] });
		expect(res.rejected[0]).toMatchObject({ file: "a.md", reason: "invalid name" });
		expect(await readdir(dir)).not.toContain("a.md");
	});

	it("非法 created / 未知 type 被拒收", async () => {
		const badCreated = serializeEntryFile(
			{ name: "A", description: "d", type: "feedback", created: "11-09-2026", modified: "2026-11-09T00:00:00.000Z" },
			"x",
		);
		const badType = serializeEntryFile(
			{ name: "A", description: "d", type: "nope" as never, created: "2026-11-09", modified: "2026-11-09T00:00:00.000Z" },
			"x",
		);
		const res = await store.applyEntryFiles({
			writes: [
				{ file: "a.md", raw: badCreated },
				{ file: "b.md", raw: badType },
			],
			deletes: [],
		});
		// 未知 type 的原因是 "unparsable frontmatter" 而不是 "invalid type"：`parseEntryFile` 自己就要求
		// type ∈ ENTRY_TYPES，认不出来直接返回 null（这样的文件落盘后对 store 静默不可见，正是拒收的理由）。
		// "invalid type" 是解析之后的纵深防御，无法经公开 API 触发。
		expect(res.rejected.map((r) => r.reason)).toEqual(["invalid created", "unparsable frontmatter"]);
		expect(res.written).toEqual([]);
	});

	it("路径 fail-closed：整批抛错，一个文件都不写", async () => {
		for (const file of ["MEMORY.md", ".lock", "sub/a.md", "../a.md", "con.md"]) {
			await expect(store.applyEntryFiles({ writes: [{ file, raw: raw("A") }], deletes: [] })).rejects.toThrow(
				/refusing/i,
			);
		}
		const left = await readdir(dir).catch(() => []);
		expect(left.filter((n) => n.endsWith(".md"))).toEqual([]); // 路径校验在快照与写入之前，不得留下任何 entry
	});

	// 下面两条钉的是「本机是 mac / Windows」这一侧：那里的文件系统把 `Foo.md` 与 `foo.md` 当同一个名字。
	// `cfg.platform` 是仓库既有的测试注入缝（生产不传），因此在 ubuntu / windows 的 CI 上都能确定地跑到，
	// 而不是靠宿主文件系统的大小写语义决定这条用例是否成立。
	it("批内大小写碰撞只落一份并把另一份记进 rejected", async () => {
		const mac = new MemoryStore(CFG(dir, { platform: "darwin" }));
		const res = await mac.applyEntryFiles({
			writes: [
				{ file: "Foo.md", raw: raw("Foo") },
				{ file: "foo.md", raw: raw("foo") },
			],
			deletes: [],
		});
		expect(res.written.length).toBe(1);
		expect(res.rejected.length).toBe(1);
		expect(res.rejected[0].reason).toBe("filename collision");
		expect((await readdir(dir)).filter((n) => n.toLowerCase() === "foo.md")).toHaveLength(1);
	});

	it("与既有文件的大小写碰撞同样跳过（磁盘探测，不靠字符串）", async () => {
		const mac = new MemoryStore(CFG(dir, { platform: "darwin" }));
		await mac.applyEntryFiles({ writes: [{ file: "Foo.md", raw: raw("Foo") }], deletes: [] });
		const res = await mac.applyEntryFiles({ writes: [{ file: "foo.md", raw: raw("foo") }], deletes: [] });
		expect(res.rejected).toEqual([{ file: "foo.md", reason: "filename collision" }]);
		expect(await readFile(join(dir, "Foo.md"), "utf8")).toBe(raw("Foo")); // 没有被写穿
	});

	// 上一条在 darwin 口径下由折叠 key 判定；这一条钉的是**只有磁盘能判**的那一半：
	// 字符串折叠认为两个名字不同（linux 口径），但它们在盘上是同一个 inode（这里用硬链接构造，
	// 真实世界里是 casefold 挂载 / 会做规范化的文件系统）。win32 平台门与既有 `sameFile` 用例同理
	// （`link` 只在支持硬链接的卷上可用）。
	it.skipIf(process.platform === "win32")("与既有文件同 inode 的写入被磁盘探测拦下，不写穿别人", async () => {
		await writeFile(join(dir, "Foo.md"), raw("Foo"), "utf8");
		await link(join(dir, "Foo.md"), join(dir, "foo.md"));
		const res = await store.applyEntryFiles({ writes: [{ file: "foo.md", raw: raw("foo") }], deletes: [] });
		expect(res.rejected).toEqual([{ file: "foo.md", reason: "filename collision" }]);
		expect(await readFile(join(dir, "foo.md"), "utf8")).toBe(raw("Foo"));
	});

	// 折叠**跟平台**的反面：Linux 上 `Foo.md` 与 `foo.md` 是两条合法记忆，同步不得把其中一条当碰撞丢掉。
	it.skipIf(process.platform !== "linux")("linux 口径下大小写不同的两份都落盘（两条合法记忆）", async () => {
		const res = await store.applyEntryFiles({
			writes: [
				{ file: "Foo.md", raw: raw("Foo") },
				{ file: "foo.md", raw: raw("foo") },
			],
			deletes: [],
		});
		expect(res).toEqual({ written: ["Foo.md", "foo.md"], deleted: [], rejected: [] });
		expect((await store.listEntries()).map((e) => e.name).sort()).toEqual(["Foo", "foo"]);
	});

	it("写与删都会让 mtime 缓存失效（下一轮 listEntries 读到新内容）", async () => {
		await store.applyEntryFiles({ writes: [{ file: "a.md", raw: raw("A", "2020-01-01T00:00:00.000Z", "旧") }], deletes: [] });
		expect((await store.listEntries())[0].modified).toBe("2020-01-01T00:00:00.000Z");
		await store.applyEntryFiles({ writes: [{ file: "a.md", raw: raw("A", "2021-01-01T00:00:00.000Z", "新") }], deletes: [] });
		expect((await store.listEntries())[0].modified).toBe("2021-01-01T00:00:00.000Z");
	});

	it("默认拍一份 .backups/<ts>-apply/；传 skipSnapshot 则不拍", async () => {
		await store.applyEntryFiles({ writes: [{ file: "a.md", raw: raw("A") }], deletes: [] });
		expect((await readdir(join(dir, ".backups"))).some((n) => n.endsWith("-apply"))).toBe(true);
		await store.applyEntryFiles({ writes: [{ file: "b.md", raw: raw("B") }], deletes: [] }, { skipSnapshot: true });
		expect((await readdir(join(dir, ".backups"))).filter((n) => n.endsWith("-apply"))).toHaveLength(1);
	});

	it("skipLogicalLock: true 时在已持有逻辑锁的整轮里可用（不自锁到超时）", async () => {
		await store.withLogicalLock(async () => {
			const res = await store.applyEntryFiles(
				{ writes: [{ file: "a.md", raw: raw("A") }], deletes: [] },
				{ skipLogicalLock: true },
			);
			expect(res.written).toEqual(["a.md"]);
		});
	});
});
