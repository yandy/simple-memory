import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, MemoryStore, buildIndexSection, mergeConfig } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexCache } from "../src/index-cache.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";

/** 测试级临时目录总根：所有记忆目录都建在它下面，`afterEach` 一次 `rm -rf` 全清。 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-ic-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 从不污染 DEFAULT_CONFIG 的副本派生一份合法的 MemoryConfig，只覆盖 memoryDir。 */
function makeConfig(memoryDir: string): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir });
}

function makeStore(memoryDir: string): MemoryStore {
	const cfg = makeConfig(memoryDir);
	return new MemoryStore({
		memoryDir,
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	});
}

function makeRuntime(memoryDir: string, store: MemoryStore | null, over: Partial<SessionMemoryRuntime> = {}): SessionMemoryRuntime {
	const base: SessionMemoryRuntime = {
		sessionId: "s1",
		cwd: join(dir, "cwd"),
		config: makeConfig(memoryDir),
		store,
		memoryDir,
		error: null,
		surfacing: { available: true, reason: null },
	};
	return { ...base, ...over };
}

describe("createIndexCache", () => {
	it("shows a written entry's index line after refresh", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const cache = createIndexCache();

		const { file } = await store.addEntry({ name: "Alpha", description: "first note", body: "hello" });
		await cache.refresh(rt);

		expect(cache.read("s1")).toContain(`- [Alpha](${file}) — first note`);
	});

	it("treats a null-store runtime as empty without throwing", async () => {
		const cache = createIndexCache();
		const rt = makeRuntime(join(dir, "unused"), null);

		await expect(cache.refresh(rt)).resolves.toBeUndefined();
		expect(cache.read("s1")).toBe("");
		expect(cache.lastError("s1")).toBeNull();
	});

	it("returns \"\" for a session id that was never refreshed", () => {
		const cache = createIndexCache();

		expect(cache.read("nope")).toBe("");
		expect(cache.lastError("nope")).toBeNull();
	});

	it("passes core's index output through byte-identically, leaving an entry name's {{x}} untouched", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const cache = createIndexCache();

		// `buildIndexSection` 只输出索引行（名字 + description），所以真正走到 `read()` 的 `{{x}}`
		// 是条目的**名字**，不是正文（正文从不进索引）。钉住的属性是：core 输出什么就透传什么，
		// 不做二次转义 —— 宿主渲染器的 `{{...}}` 插值由 section 的 `interpolate: false` 关掉。
		await store.addEntry({ name: "{{x}}", description: "brace template", body: "body {{x}}" });
		await cache.refresh(rt);

		const expected = await buildIndexSection(store, rt.config.memIndexInjectMaxLines, rt.config.memIndexInjectMaxBytes);
		expect(cache.read("s1")).toBe(expected);
		expect(cache.read("s1")).toContain("{{x}}");
		expect(cache.read("s1")).not.toContain("body {{x}}");
	});

	it("keeps the previous value and records the error when a refresh fails", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const cache = createIndexCache();

		await store.addEntry({ name: "Alpha", description: "first note", body: "hello" });
		await cache.refresh(rt);
		const before = cache.read("s1");
		expect(before).toContain("Alpha");
		expect(cache.lastError("s1")).toBeNull();

		rt.store = { readIndex: () => Promise.reject(new Error("disk gone")) } as unknown as MemoryStore;
		await cache.refresh(rt);

		expect(cache.read("s1")).toBe(before);
		expect(cache.lastError("s1")).toContain("disk gone");
	});

	it("forget drops both the text and the recorded error", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const cache = createIndexCache();

		await store.addEntry({ name: "Alpha", body: "hello" });
		await cache.refresh(rt);
		expect(cache.read("s1")).not.toBe("");

		rt.store = { readIndex: () => Promise.reject(new Error("boom")) } as unknown as MemoryStore;
		await cache.refresh(rt);
		expect(cache.lastError("s1")).not.toBeNull();

		cache.forget("s1");
		expect(cache.read("s1")).toBe("");
		expect(cache.lastError("s1")).toBeNull();
	});
});
