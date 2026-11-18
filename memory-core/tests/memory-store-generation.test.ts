import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, type StoreConfig } from "../src/store/memory-store.js";

/**
 * `MemoryStore.generation`：每次**成功**的写入 +1，读与失败一律不动。
 *
 * 宿主拿它做 prefetch 的同步门：侧查询在飞期间若 store 变了（主工具、worker、同步写入都算），
 * 那一份结果就作废 —— 否则同一份正文会在工具结果和召回块里各出现一次，或者持久化一条已被
 * 删除 / 改写的正文。所以这里的断言必须钉住「覆盖面」而不只是「有个数字在涨」。
 */
let dir: string;
let store: MemoryStore;

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-store-generation-"));
	store = new MemoryStore(CFG(dir));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("MemoryStore.generation", () => {
	it("starts at 0 and increments on each successful write primitive", async () => {
		expect(store.generation).toBe(0);

		const added = await store.addEntry({ name: "A", description: "a", body: "body a" });
		expect(store.generation).toBe(1);

		await store.replaceEntry("A", { body: "body a2" });
		expect(store.generation).toBe(2);

		await store.renameEntry("A", "B");
		expect(store.generation).toBe(3);

		await store.applyEntryFiles({ writes: [], deletes: [added.file] });
		expect(store.generation).toBe(4);

		await store.rebuildIndex();
		expect(store.generation).toBe(5);
	});

	it("increments for applyEntryFiles even when the sync round writes raw bytes only", async () => {
		// 同步写入不经 add/replace（逐字落盘 + 之后自己 rebuildIndex）：两道写原语都必须被覆盖，
		// 否则「同步在飞」这件事对 prefetch 门不可见。
		const before = store.generation;
		const result = await store.applyEntryFiles({
			writes: [
				{
					file: "raw.md",
					raw: ["---", "name: Raw", "description: d", "type: project", "created: 2026-01-01", "modified: 2026-01-01", "---", "", "body", ""].join("\n"),
				},
			],
			deletes: [],
		});
		expect(result.written).toEqual(["raw.md"]);
		expect(store.generation).toBe(before + 1);

		await store.rebuildIndex();
		expect(store.generation).toBe(before + 2);
	});

	it("does not move on reads or on failed writes", async () => {
		await store.addEntry({ name: "A", description: "a", body: "body a" });
		const before = store.generation;

		await store.listEntries();
		await store.readEntry("A");
		await store.readIndex();
		await store.searchEntries("a");
		expect(store.generation).toBe(before);

		// 失败 = 没写：不存在的条目、非法 name、空 body、非法 created 都不该移动它。
		await expect(store.removeEntry("nope")).rejects.toThrow(/not found/);
		await expect(store.replaceEntry("nope", { body: "x" })).rejects.toThrow(/not found/);
		await expect(store.addEntry({ name: "A", description: "d", body: "" })).rejects.toThrow(/body is required/);
		await expect(store.addEntry({ name: "x](y", description: "d", body: "b" })).rejects.toThrow(/must not contain/);
		await expect(store.addEntry({ name: "C", description: "d", body: "b", created: "2026/01/01" })).rejects.toThrow(
			/created must be/,
		);
		expect(store.generation).toBe(before);
	});

	it("is monotonic within one instance and resets for a new instance", async () => {
		await store.addEntry({ name: "A", description: "a", body: "body a" });
		await store.addEntry({ name: "B", description: "b", body: "body b" });
		const seen = store.generation;
		await store.removeEntry("A");
		expect(store.generation).toBe(seen + 1);
		expect(store.generation).toBeGreaterThan(seen);

		// 每个实例各数各的：门只在「同一份 store 在飞」这一前提下有意义，跨实例的比较没有语义。
		expect(new MemoryStore(CFG(dir)).generation).toBe(0);
	});
});
