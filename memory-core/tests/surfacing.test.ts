import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	TASKS,
	mergeConfig,
	runTask,
	type EntryManifest,
	type HeadlessRunRequest,
	type StoreConfig,
	type SurfacingInput,
	type TaskContext,
} from "../src/index.js";

/**
 * autoSurfacing 描述符的编排。
 *
 * 被测的是 core 的决策：候选过滤、prompt 构造、请求字段、以及对宿主回复的解析与失败兜底。
 * 宿主怎么跑那一轮（pi 的 `createAgentSession`、别家的 subagent）由适配层的假端口代替。
 */
const headlessRun = vi.fn();
const ports = { headless: { run: headlessRun } };

const CFG = (memoryDir: string): StoreConfig => ({
	memoryDir,
	indexMaxLines: 200,
	indexMaxBytes: 25600,
	lock: { timeoutMs: 5000, snapshotKeep: 5 },
});

function manifest(file: string, over: Partial<EntryManifest> = {}): EntryManifest {
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
	dir = await mkdtemp(join(tmpdir(), "mem-surfacing-"));
	store = new MemoryStore(CFG(dir));
	headlessRun.mockReset();
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function seed(...names: string[]): Promise<void> {
	for (const name of names) await store.addEntry({ name, body: `body of ${name}` });
}

function ctx(over: Partial<TaskContext> = {}): TaskContext {
	return {
		cfg: mergeConfig(DEFAULT_CONFIG, { defaults: { model: "deepseek/deepseek-v4-flash" } }),
		cwd: "/mem",
		store,
		ports,
		...over,
	};
}

function input(over: Partial<SurfacingInput> = {}): SurfacingInput {
	return { userPrompt: "q", injectedFiles: new Set<string>(), manifest: [manifest("a.md")], ...over };
}

describe("TASKS.autoSurfacing via runTask", () => {
	it("asks the host for one turn, no tools, a 30s timeout, and parses selected_files", async () => {
		await seed("a");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: '{"selected_files":["a.md"]}' });

		const result = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "how do I debug?", injectedFiles: new Set<string>(), manifest: [manifest("a.md")] },
			ctx(),
		);

		expect(headlessRun).toHaveBeenCalledTimes(1);
		const req: HeadlessRunRequest = headlessRun.mock.calls[0][0];
		expect(req).toMatchObject({
			cwd: "/mem",
			effort: "off",
			maxTurns: 1,
			timeoutMs: 30_000,
			builtinTools: "none",
			memoryTool: null,
			signal: undefined,
		});
		expect(result.files).toEqual(["a.md"]);
		expect(result.content).toContain("## a");
	});

	// 取消信号必须原样落到端口的请求上：适配层在宿主会 await 的钩子里调用本函数，
	// 信号到不了端口，用户取消后就要等满 timeoutMs 才拿得到一个没人要的结果。
	it("forwards the abort signal to the port verbatim", async () => {
		await seed("a");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: '{"selected_files":[]}' });
		const controller = new AbortController();

		await runTask(TASKS.autoSurfacing, input(), ctx({ signal: controller.signal }));

		const captured: HeadlessRunRequest = headlessRun.mock.calls[0][0];
		expect(captured.signal).toBe(controller.signal);
	});

	// 不传 signal 仍必须是合法调用：适配层可以不管取消，行为与加这个字段前完全一致。
	it("still runs the round when no signal is given", async () => {
		await seed("a");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: '{"selected_files":["a.md"]}' });
		const result = await runTask(TASKS.autoSurfacing, input(), ctx());
		expect(headlessRun).toHaveBeenCalledTimes(1);
		const captured: HeadlessRunRequest = headlessRun.mock.calls[0][0];
		expect(captured.signal).toBeUndefined();
		expect(result.files).toEqual(["a.md"]);
	});

	it("forwards the configured model string", async () => {
		await seed("a");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: '{"selected_files":[]}' });
		await runTask(TASKS.autoSurfacing, input({ userPrompt: "some query" }), ctx());
		expect(headlessRun.mock.calls[0][0]).toMatchObject({ model: "deepseek/deepseek-v4-flash" });
	});

	it("drops files that are not in the manifest", async () => {
		await seed("a");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: '{"selected_files":["a.md","evil.md"]}' });
		const result = await runTask(TASKS.autoSurfacing, input(), ctx());
		expect(result.files).toEqual(["a.md"]);
	});

	it("returns an empty result on timeout/failure (no fallback)", async () => {
		headlessRun.mockRejectedValueOnce(new Error("timed out"));
		const result = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "I need to debug SSH", injectedFiles: new Set<string>(), manifest: [manifest("debugging.md")] },
			ctx(),
		);
		expect(result).toEqual({ files: [], content: "" });
	});

	// 端口的 `not-run` 语义是「宿主没跑这一轮」，与「跑了但没选出来」必须一样安全：
	// auto-surfacing 是纯增益，任何一条路径都不得打断用户这一轮。
	it("returns an empty result when the host declines to run the round", async () => {
		headlessRun.mockResolvedValueOnce({ status: "not-run", cause: "host-refused" });
		const result = await runTask(TASKS.autoSurfacing, input(), ctx());
		expect(result).toEqual({ files: [], content: "" });
	});

	it("returns empty content when the response has no valid JSON", async () => {
		await seed("a");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: "not json at all" });
		const result = await runTask(TASKS.autoSurfacing, input({ userPrompt: "some query" }), ctx());
		expect(result).toEqual({ files: [], content: "" });
	});

	it("returns an empty result when no candidates remain", async () => {
		const result = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "some prompt", injectedFiles: new Set<string>(), manifest: [] },
			ctx(),
		);
		expect(result).toEqual({ files: [], content: "" });
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("filters out already-injected entry files", async () => {
		await seed("a", "b");
		headlessRun.mockResolvedValueOnce({ status: "completed", text: '{"selected_files":["a.md"]}' });
		const result = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set(["b.md"]), manifest: [manifest("a.md"), manifest("b.md")] },
			ctx(),
		);
		// 候选清单里不含 b.md，所以宿主即使选了它也会被丢掉
		expect(headlessRun.mock.calls[0][0].task).toContain("a.md");
		expect(headlessRun.mock.calls[0][0].task).not.toContain("b.md");
		expect(result.files).toEqual(["a.md"]);
	});

	it("never asks the host when every candidate was already injected", async () => {
		const result = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set(["a.md"]), manifest: [manifest("a.md")] },
			ctx(),
		);
		expect(result).toEqual({ files: [], content: "" });
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("truncates the selection to cfg.autoSurfacing.maxFiles", async () => {
		await seed("a", "b", "c");
		headlessRun.mockResolvedValueOnce({
			status: "completed",
			text: '{"selected_files":["a.md","b.md","c.md"]}',
		});
		const result = await runTask(
			TASKS.autoSurfacing,
			{ userPrompt: "q", injectedFiles: new Set<string>(), manifest: [manifest("a.md"), manifest("b.md"), manifest("c.md")] },
			ctx({
				cfg: mergeConfig(DEFAULT_CONFIG, {
					defaults: { model: "deepseek/deepseek-v4-flash" },
					autoSurfacing: { maxFiles: 2 },
				}),
			}),
		);
		expect(result.files).toEqual(["a.md", "b.md"]);
	});
});
