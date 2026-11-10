import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	TASKS,
	mergeConfig,
	runTask,
	type EntryManifest,
	type HeadlessRunRequest,
	type StoreConfig,
	type TaskContext,
} from "../src/index.js";

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

function entry(file: string, over: Partial<EntryManifest> = {}): EntryManifest {
	return {
		file,
		name: file.replace(/\.md$/, ""),
		description: `description of ${file}`,
		type: "feedback",
		modified: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

let dir: string;
let store: MemoryStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mem-task-"));
	store = new MemoryStore(CFG(dir));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function ctx(over: Partial<TaskContext> = {}): TaskContext {
	return {
		cfg: mergeConfig(DEFAULT_CONFIG, { defaults: { model: "provider/base" } }),
		cwd: "/mem",
		store,
		ports: { headless: { run: async () => ({ status: "completed", text: "" }) } },
		...over,
	};
}

describe("runTask(TASKS.autoSurfacing)", () => {
	it("reads model, effort and sessionPersistence from cfg instead of its arguments", async () => {
		const seen: HeadlessRunRequest[] = [];
		const cfg = mergeConfig(DEFAULT_CONFIG, {
			defaults: { model: "provider/base", sessionPersistence: { enabled: false } },
			autoSurfacing: { thinkLevel: "low", maxFiles: 2 },
		});
		await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [entry("a.md")] },
			{
				cfg,
				cwd: "/mem",
				store,
				ports: {
					headless: {
						run: async (r) => (seen.push(r), { status: "completed", text: '{"selected_files":["a.md"]}' }),
					},
				},
			},
		);
		expect(seen[0]).toMatchObject({
			model: "provider/base",
			effort: "low",
			cwd: "/mem",
			maxTurns: 1,
			timeoutMs: 30_000,
			builtinTools: "none",
			memoryTool: null,
		});
		expect(seen[0].sessionPersistence).toEqual({ enabled: false });
	});

	it("throws a readable error when the task has no model", async () => {
		await expect(
			runTask(
				TASKS.autoSurfacing,
				{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [entry("a.md")] },
				{
					cfg: mergeConfig(DEFAULT_CONFIG, { defaults: { model: undefined } }),
					cwd: "/mem",
					store,
					ports: { headless: { run: async () => ({ status: "completed", text: "" }) } },
				},
			),
		).rejects.toThrow(/no model for autoSurfacing/);
	});

	it("swallows a transport throw when errorPolicy is swallow and marks nothing injected", async () => {
		const injectedFiles = new Set<string>();
		const out = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles, manifest: [entry("a.md")] },
			{
				cfg: mergeConfig(DEFAULT_CONFIG, { defaults: { model: "provider/base" } }),
				cwd: "/mem",
				store,
				ports: {
					headless: {
						run: async () => {
							throw new Error("boom");
						},
					},
				},
			},
		);
		expect(out).toEqual({ files: [], content: "" });
		expect(injectedFiles.size).toBe(0);
	});

	it("skips without calling the port when the candidate list is empty", async () => {
		let called = false;
		const out = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [] },
			{
				cfg: mergeConfig(DEFAULT_CONFIG, { defaults: { model: "provider/base" } }),
				cwd: "/mem",
				store,
				ports: {
					headless: {
						run: async () => {
							called = true;
							return { status: "completed", text: "" };
						},
					},
				},
			},
		);
		expect(called).toBe(false);
		expect(out).toEqual({ files: [], content: "" });
	});

	it("renders the block with cfg budgets and drops files not in the manifest", async () => {
		await store.addEntry({ name: "long", body: "x".repeat(4000) });
		await store.addEntry({ name: "short", body: "short body" });

		const out = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [entry("long.md"), entry("short.md")] },
			{
				cfg: mergeConfig(DEFAULT_CONFIG, {
					defaults: { model: "provider/base" },
					autoSurfacing: { maxEntryBytes: 100 },
				}),
				cwd: "/mem",
				store,
				ports: {
					headless: {
						run: async () => ({
							status: "completed",
							text: '{"selected_files":["long.md","ghost.md","short.md"]}',
						}),
					},
				},
			},
		);
		expect(out.files).toEqual(["long.md", "short.md"]);
		expect(out.content).toContain("## long");
		expect(out.content).toContain("[truncated: memory entry exceeds injection limit]");
	});

	it("returns empty files when the selected entry cannot be rendered", async () => {
		const out = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [entry("missing.md")] },
			ctx({
				ports: {
					headless: { run: async () => ({ status: "completed", text: '{"selected_files":["missing.md"]}' }) },
				},
			}),
		);
		expect(out).toEqual({ files: [], content: "" });
	});
});
