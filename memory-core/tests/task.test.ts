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
	type ExtractMessage,
	type HeadlessRunRequest,
	type HostTranscriptPort,
	type MemoryTask,
	type StoreConfig,
	type SurfacingInput,
	type SurfacingResult,
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

/** 透传的假 transcript：core 测试直接给中立的 `ExtractMessage`。 */
function transcript(mapping: (raw: unknown[]) => ExtractMessage[]): HostTranscriptPort {
	return { toExtractMessages: mapping, searchSessions: async () => "" };
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

	it("swallows a transport throw when errorPolicy is swallow and returns an empty result", async () => {
		const out = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [entry("a.md")] },
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
	});

	it("rejects a parse failure instead of disguising it as host-refused", async () => {
		const task: MemoryTask<SurfacingInput, SurfacingResult> = {
			id: "autoSurfacing",
			plan: { maxTurns: 1, timeoutMs: 30_000, memoryTool: null, lock: "none", errorPolicy: "swallow" },
			buildPrompt: () => "q",
			parse: async () => {
				throw new Error("parse boom");
			},
			notCompleted: () => ({ files: [], content: "" }),
		};
		await expect(
			runTask(task, { userPrompt: "q", injectedFiles: new Set<string>(), manifest: [entry("a.md")] }, ctx()),
		).rejects.toThrow("parse boom");
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

describe("runTask(TASKS.extractMemories)", () => {
	const cfg = () => mergeConfig(DEFAULT_CONFIG, { defaults: { model: "provider/base" } });
	const extractPorts = (headless: TaskContext["ports"]["headless"]): TaskContext["ports"] => ({
		headless,
		transcript: transcript((raw) => raw as ExtractMessage[]),
	});

	it("checks for an empty transcript before taking the logical lock", async () => {
		const order: string[] = [];
		const fake = {
			tryWithLogicalLock: async () => {
				order.push("lock");
				return {};
			},
		} as unknown as MemoryStore;
		const out = await runTask(
			TASKS.extractMemories,
			{ messages: [], agentsMdBlocks: [] },
			{
				cfg: cfg(),
				cwd: "/mem",
				store: fake,
				ports: extractPorts({ run: async () => ({ status: "completed", text: "" }) }),
			},
		);
		expect(order).toEqual([]);
		expect(out).toEqual({ skipped: true });
	});

	it("reports a lock-busy round as skipped", async () => {
		const out = await runTask(
			TASKS.extractMemories,
			{ messages: [{ role: "user", text: "hi" }], agentsMdBlocks: [] },
			{
				cfg: cfg(),
				cwd: "/mem",
				store: { tryWithLogicalLock: async () => null } as unknown as MemoryStore,
				ports: extractPorts({ run: async () => ({ status: "completed", text: "" }) }),
			},
		);
		expect(out).toEqual({ skipped: true });
	});

	it("treats max-tokens as ran-with-partial-result, never as skipped", async () => {
		const out = await runTask(
			TASKS.extractMemories,
			{ messages: [{ role: "user", text: "hi" }], agentsMdBlocks: [] },
			{
				cfg: cfg(),
				cwd: "/mem",
				store,
				ports: extractPorts({ run: async () => ({ status: "incomplete", cause: "max-tokens" }) }),
			},
		);
		expect(out.skipped).toBe(false);
	});

	it("returns an empty result, never skipped, for a completed-but-empty reply", async () => {
		const out = await runTask(
			TASKS.extractMemories,
			{ messages: [{ role: "user", text: "hi" }], agentsMdBlocks: [] },
			{
				cfg: cfg(),
				cwd: "/mem",
				store,
				ports: extractPorts({ run: async () => ({ status: "no-output" }) }),
			},
		);
		expect(out).toEqual({ skipped: false, result: "" });
	});

	it("treats a not-run outcome as skipped", async () => {
		const out = await runTask(
			TASKS.extractMemories,
			{ messages: [{ role: "user", text: "hi" }], agentsMdBlocks: [] },
			{
				cfg: cfg(),
				cwd: "/mem",
				store,
				ports: extractPorts({ run: async () => ({ status: "not-run", cause: "host-refused" }) }),
			},
		);
		expect(out).toEqual({ skipped: true });
	});

	it("rethrows a transport failure (errorPolicy rethrow)", async () => {
		await expect(
			runTask(
				TASKS.extractMemories,
				{ messages: [{ role: "user", text: "hi" }], agentsMdBlocks: [] },
				{
					cfg: cfg(),
					cwd: "/mem",
					store,
					ports: extractPorts({
						run: async () => {
							throw new Error("boom");
						},
					}),
				},
			),
		).rejects.toThrow("boom");
	});
});
