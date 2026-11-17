/**
 * index wiring — successful memory writes notify the current sync engine
 *
 * harness 必须先于 ../index 与 ../src/sync：backend/engine 保持真实，只在观察带上 spy。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gitAvailable, MemoryStore } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakePi,
	enableTestSync,
	gitIdentity,
	resetWiringMocks,
	setupSession,
	syncEngines,
	syncEvents,
	syncRuntimes,
} from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { loadConfig } from "../src/config";
import { createPiSyncRuntime } from "../src/sync";

const GIT = await gitAvailable();

describe.skipIf(!GIT)("index wiring — sync write triggers", { timeout: 60_000 }, () => {
	let s: Awaited<ReturnType<typeof setupSession>>;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
	});

	afterEach(async () => {
		for (const engine of syncEngines) engine.dispose();
		vi.restoreAllMocks();
		await s.cleanup();
	});

	function currentEngine() {
		const engine = syncEngines.at(-1);
		if (!engine) throw new Error("sync engine was not prepared");
		return engine;
	}

	async function start() {
		const { pi, handlers, tools } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "startup" }, s.uiCtx());
		return { handlers, tools, engine: currentEngine() };
	}

	async function run(tool: any, params: Record<string, unknown>) {
		return tool.execute("sync-write", params, undefined, undefined, undefined);
	}

	async function seedRemoteEntry(remote: string): Promise<void> {
		const { config } = await loadConfig({ cwd: s.cwd, isProjectTrusted: () => true });
		const memoryDir = join(s.cwd, "seed-memory-root");
		const projectDir = join(memoryDir, "seed-project");
		await mkdir(projectDir, { recursive: true });
		const seedConfig = { ...config, memoryDir, sync: { ...config.sync, remote } };
		const store = new MemoryStore({
			memoryDir: projectDir,
			indexMaxLines: seedConfig.memIndexMaxLines,
			indexMaxBytes: seedConfig.memIndexMaxBytes,
			lock: seedConfig.lock,
		});
		await store.addEntry({ name: "Remote note", description: "from another device", body: "remote body" });
		const { runtime, errors } = await createPiSyncRuntime({
			config: seedConfig,
			store,
			projectDir,
			identity: gitIdentity(s.cwd),
		});
		expect(errors).toEqual([]);
		if (!runtime) throw new Error("seed runtime was not created");
		try {
			const prepared = await runtime.prepare(10_000);
			if (!prepared.ok) throw new Error(`seed prepare failed: ${prepared.reason}`);
			expect((await prepared.engine.push(10_000)).ok).toBe(true);
		} finally {
			runtime.dispose();
		}
		syncEvents.length = 0;
	}

	it("main add/replace/remove each notify once; reads, failures and sync apply stay quiet", async () => {
		const remote = await enableTestSync(s);
		await seedRemoteEntry(remote);
		const { tools, engine } = await start();
		const noteWrite = vi.spyOn(engine, "noteWrite");
		const tool = tools[0];

		await run(tool, { action: "add", name: "A", description: "d", content: "one" });
		expect(noteWrite).toHaveBeenCalledTimes(1);
		await run(tool, { action: "replace", name: "A", content: "two" });
		expect(noteWrite).toHaveBeenCalledTimes(2);
		await run(tool, { action: "remove", name: "A" });
		expect(noteWrite).toHaveBeenCalledTimes(3);

		await run(tool, { action: "list" });
		await run(tool, { action: "search", query: "two" });
		await expect(run(tool, { action: "add", name: "broken", content: "" })).rejects.toThrow(
			"content is required for add",
		);
		expect(noteWrite).toHaveBeenCalledTimes(3);

		// pull 的真实 applyEntryFiles 落盘不经过 memory 工具回调，不能形成写放大回路。
		const pulled = await engine.pull(10_000);
		expect(pulled).toMatchObject({ ok: true, pulled: ["Remote-note.md"] });
		expect(noteWrite).toHaveBeenCalledTimes(3);
	});

	it("routes every successful write through the runtime trigger instead of the engine handle", async () => {
		await enableTestSync(s);
		const { tools } = await start();
		const runtime = syncRuntimes.at(-1);
		if (!runtime) throw new Error("sync runtime was not created");
		// 宿主必须交给 core 的入口：直接摸 engine.noteWrite 会绕过收摊与换远端关闸。
		const runtimeTrigger = vi.spyOn(runtime, "noteWrite");
		const engineTrigger = vi.spyOn(currentEngine(), "noteWrite");

		await run(tools[0], { action: "add", name: "A", description: "d", content: "one" });
		await run(tools[0], { action: "list" });

		expect(runtimeTrigger).toHaveBeenCalledTimes(1);
		expect(engineTrigger).toHaveBeenCalledTimes(1);
	});

	it("forwards every write even when pushOnWrite is false, leaving the switch and debounce to core", async () => {
		await enableTestSync(s, { pushOnWrite: false });
		const { tools, engine } = await start();
		const noteWrite = vi.spyOn(engine, "noteWrite");

		await run(tools[0], { action: "add", name: "A", content: "one" });
		await run(tools[0], { action: "add", name: "B", content: "two" });

		// pi 不复制 pushOnWrite 分支，也不把一轮多次写合并成一次回调。
		expect(noteWrite).toHaveBeenCalledTimes(2);
		expect(syncEvents).not.toContain("push:start");
	});
});
