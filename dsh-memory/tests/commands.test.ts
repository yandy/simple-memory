import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, LOCK_FILE, MemoryStore, mergeConfig } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCommand, describeHolder, renderStatus } from "../src/commands.js";
import type { CommandDeps } from "../src/commands.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";

/** 测试级临时目录总根：所有记忆目录都建在它下面，`afterEach` 一次 `rm -rf` 全清。 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-cmd-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 从不污染 DEFAULT_CONFIG 的副本派生一份合法的 MemoryConfig，只覆盖 memoryDir。 */
function makeConfig(memoryDir: string, over: unknown = {}): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir, ...(over as object) });
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

function makeRuntime(
	memoryDir: string,
	store: MemoryStore | null,
	over: Partial<SessionMemoryRuntime> = {},
): SessionMemoryRuntime {
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

function makeDeps(rt: SessionMemoryRuntime | undefined, warnings: string[] = [], over: Partial<CommandDeps> = {}): CommandDeps {
	return {
		registry: { get: () => rt },
		indexCache: { refresh: async () => {} },
		warnings,
		...over,
	};
}

function handlerFor(rt: SessionMemoryRuntime | undefined, warnings: string[] = [], over: Partial<CommandDeps> = {}) {
	return createMemoryCommand(makeDeps(rt, warnings, over)).handler;
}

const HELD_LOCK = { op: "add", pid: 4242, hostname: "somehost", startedAt: "2026-11-09T12:00:00.000Z" };

/**
 * `describeHolder(HELD_LOCK)` 的**字面量**期望值，从 `src/commands.ts` 的格式
 * `` `${op} (pid ${pid} on ${hostname}, started ${startedAt})` `` 逐字抄来 —— 刻意写死，
 * 不用 `describeHolder(HELD_LOCK)` 自证：那样把 hostname 从格式里删掉时两边同时变，测试仍然绿。
 * hostname 是硬要求：`.lock` 是记忆目录里的普通文件，同一目录可能被挂载到多台机器，
 * 只看 pid 无法区分「本机已死的进程」与「别的机器正在跑」。
 */
const HELD_LOCK_DESCRIPTION = "add (pid 4242 on somehost, started 2026-11-09T12:00:00.000Z)";

describe("describeHolder", () => {
	it("pins the literal format, hostname included", () => {
		expect(describeHolder(HELD_LOCK)).toBe(HELD_LOCK_DESCRIPTION);
	});
});

describe("createMemoryCommand definition", () => {
	it("exposes a host-valid command definition", () => {
		const cmd = createMemoryCommand(makeDeps(undefined));
		expect(cmd.name).toBe("memory");
		expect(cmd.name).toMatch(/^[a-z][a-z0-9_-]*$/);
		expect(typeof cmd.description).toBe("string");
		expect(cmd.description.length).toBeGreaterThan(0);
		expect(typeof cmd.input.hint).toBe("string");
		expect(cmd.input.hint.length).toBeGreaterThan(0);
		expect(typeof cmd.handler).toBe("function");
	});
});

describe("renderStatus", () => {
	it("renders all six status lines with the resolved directory", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		const text = await renderStatus(rt, []);

		expect(text).toContain(`Dir: ${memoryDir}`);
		expect(text).toMatch(/^Index: /m);
		expect(text).toMatch(/^Inject: /m);
		expect(text).toMatch(/^Entries: /m);
		expect(text).toMatch(/^Modules: /m);
		expect(text).toMatch(/^Lock: /m);
	});

	it("reports Index from write capacity and Inject from injection capacity", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);

		for (let i = 0; i < 60; i++) {
			await store.addEntry({ name: `Entry ${i}`, description: `note ${i}`, body: `body ${i}` });
		}

		const text = await renderStatus(rt, []);
		// 写入口径不截断（60 行全在索引里），注入口径只取最新 50 行 —— 两个数若对调，这里就红。
		expect(text).toContain(`Index: 60/${rt.config.memIndexMaxLines} lines`);
		expect(text).toContain(`Inject: 50/${rt.config.memIndexInjectMaxLines} lines`);
	});

	it("shows autoSurfacing on(model) or off(reason) in the Modules line", async () => {
		const memoryDir = join(dir, "mem");
		const on = makeRuntime(memoryDir, makeStore(memoryDir), {
			config: makeConfig(memoryDir, { autoSurfacing: { model: "deepseek-official/deepseek-flash" } }),
			surfacing: { available: true, reason: null },
		});
		expect(await renderStatus(on, [])).toContain("Modules: autoSurfacing=on(deepseek-official/deepseek-flash)");

		const reason = "no model configured — set autoSurfacing.model or defaults.model in the plugin row config";
		const off = makeRuntime(memoryDir, makeStore(memoryDir), {
			surfacing: { available: false, reason },
		});
		expect(await renderStatus(off, [])).toContain(`Modules: autoSurfacing=off(${reason})`);
	});

	it("renders the Lock line as held by <literal holder>, hostname included", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		await mkdir(memoryDir, { recursive: true });
		await writeFile(join(memoryDir, LOCK_FILE), JSON.stringify(HELD_LOCK), "utf8");

		const text = await renderStatus(rt, []);
		expect(text).toContain(`Lock: held by ${HELD_LOCK_DESCRIPTION}`);
	});

	it("renders an unreadable lock as unreadable with the --force hint", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		await mkdir(memoryDir, { recursive: true });
		// 不可解析的锁体 —— core 的 readLockStatus 正是这样判 `unreadable`（不 stub core）。
		await writeFile(join(memoryDir, LOCK_FILE), "{not a lock record", "utf8");

		const text = await renderStatus(rt, []);
		expect(text).toContain("Lock: unreadable — run /memory unlock --force");
		expect(text).not.toContain("Lock: held by");
	});

	it("prints the Config line only when there are warnings, each verbatim", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));

		expect(await renderStatus(rt, [])).not.toContain("Config:");

		const warnings = ['unknown config key "memroyDir" — ignored', 'config key "memoryDir" must be string, got number — ignored'];
		const text = await renderStatus(rt, warnings);
		expect(text).toContain("Config: 2 warning(s)");
		for (const w of warnings) expect(text).toContain(w);
	});
});

describe("misconfigured states", () => {
	it("returns a success result naming each config error line", async () => {
		const error = "dsh-memory row config must be an object\nsecond line of the error";
		const rt = makeRuntime(join(dir, "unused"), null, { error, memoryDir: null });
		const result = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "" });

		expect(result.kind).toBe("success");
		expect(result.text).toContain("misconfigured");
		for (const line of error.split("\n")) expect(result.text).toContain(line);
	});

	it("returns a success result when the session has no runtime at all", async () => {
		const result = await handlerFor(undefined)({ agent: { session: { id: "ghost" } }, rawInput: "" });
		expect(result.kind).toBe("success");
		expect(result.text).toContain("not initialized");
	});

	it("refreshes the index cache before reporting status", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		const refresh = vi.fn(async () => {});
		const cmd = createMemoryCommand({ registry: { get: () => rt }, indexCache: { refresh }, warnings: [] });

		const result = await cmd.handler({ agent: { session: { id: "s1" } }, rawInput: "" });

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(result.kind).toBe("success");
	});
});

describe("unlock", () => {
	it("describes the holder and deletes nothing without --force", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		const lockPath = join(memoryDir, LOCK_FILE);
		await mkdir(memoryDir, { recursive: true });
		await writeFile(lockPath, JSON.stringify(HELD_LOCK), "utf8");

		const result = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "unlock" });

		expect(existsSync(lockPath)).toBe(true);
		expect(result.kind).toBe("success");
		expect(result.text).toContain(`Lock is held by ${HELD_LOCK_DESCRIPTION}`);
		expect(result.text).toContain("--force");
	});

	it("describes an unreadable lock and deletes nothing without --force", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		const lockPath = join(memoryDir, LOCK_FILE);
		await mkdir(memoryDir, { recursive: true });
		await writeFile(lockPath, "{not a lock record", "utf8");

		const result = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "unlock" });

		expect(result.kind).toBe("success");
		expect(result.text).toContain("Lock is unreadable — re-run /memory unlock --force to remove it.");
		expect(existsSync(lockPath)).toBe(true);
	});

	it("returns an error and touches nothing when the session has no runtime", async () => {
		const memoryDir = join(dir, "mem");
		const lockPath = join(memoryDir, LOCK_FILE);
		await mkdir(memoryDir, { recursive: true });
		await writeFile(lockPath, JSON.stringify(HELD_LOCK), "utf8");

		const result = await handlerFor(undefined)({ agent: { session: { id: "ghost" } }, rawInput: "unlock --force" });

		expect(result.kind).toBe("error");
		expect(result.text).toContain("Cannot unlock");
		expect(existsSync(lockPath)).toBe(true);
	});

	it("returns an error and touches nothing when the memory directory is unresolved", async () => {
		const memoryDir = join(dir, "mem");
		const lockPath = join(memoryDir, LOCK_FILE);
		await mkdir(memoryDir, { recursive: true });
		await writeFile(lockPath, JSON.stringify(HELD_LOCK), "utf8");
		// runtime 存在但目录没解析出来（store-registry 的失败态）：没有可以清的目录。
		const rt = makeRuntime(memoryDir, null, { memoryDir: null, error: "resolve failed" });

		const result = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "unlock --force" });

		expect(result.kind).toBe("error");
		expect(result.text).toContain("Cannot unlock");
		expect(existsSync(lockPath)).toBe(true);
	});

	it("removes the lock with --force and treats absence as success", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		const lockPath = join(memoryDir, LOCK_FILE);
		await mkdir(memoryDir, { recursive: true });

		const absent = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "  unlock --force" });
		expect(absent.kind).toBe("success");
		expect(absent.text).toContain("No lock present");

		await writeFile(lockPath, JSON.stringify(HELD_LOCK), "utf8");
		// 「只删 .lock」的另一半：目录里其它文件必须原样存在。
		const entryPath = join(memoryDir, "deadbeef.md");
		const indexPath = join(memoryDir, "MEMORY.md");
		await writeFile(entryPath, "sibling entry body\n", "utf8");
		await writeFile(indexPath, "- [Sibling](deadbeef.md) — a note\n", "utf8");

		const removed = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "unlock --force" });
		expect(removed.kind).toBe("success");
		expect(removed.text).toContain("removed");
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(entryPath)).toBe(true);
		expect(await readFile(entryPath, "utf8")).toBe("sibling entry body\n");
		expect(existsSync(indexPath)).toBe(true);
	});

	it("returns an error result instead of throwing when the unlink fails", async () => {
		const memoryDir = join(dir, "mem");
		const rt = makeRuntime(memoryDir, makeStore(memoryDir));
		const lockPath = join(memoryDir, LOCK_FILE);
		// 一个目录会让 readLockStatus 读成 unreadable，也让 unlink 抛非 ENOENT（EISDIR/EPERM）。
		await mkdir(memoryDir, { recursive: true });
		await writeFile(lockPath, JSON.stringify(HELD_LOCK), "utf8");
		await rm(lockPath, { force: true });
		await mkdir(lockPath);

		const result = await handlerFor(rt)({ agent: { session: { id: "s1" } }, rawInput: "unlock --force" });

		expect(result.kind).toBe("error");
		expect(result.text).toContain("Failed to remove memory lock");
	});
});
