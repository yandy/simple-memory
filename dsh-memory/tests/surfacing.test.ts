import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, MemoryStore, mergeConfig } from "@yandy0725/memory-core";
import type { HeadlessRunRequest, MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreStepListener, createRecallMessage, humanPromptText } from "../src/surfacing.js";
import type { SurfacingDeps } from "../src/surfacing.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";
import { createFakeCtx, createSyntheticMsg, createUserMsg } from "./helpers/fake-ctx.js";

/** 测试级临时目录总根：所有记忆目录都建在它下面，`afterEach` 一次 `rm -rf` 全清。 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-sf-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * 从不污染 DEFAULT_CONFIG 的副本派生一份合法的 MemoryConfig，只覆盖 memoryDir 与侧查询模型。
 *
 * `requiredModel` 只会返回字符串、不校验格式（格式校验在启动期的 `resolveSurfacingAvailability`），
 * 所以任何非空字符串都够用；但召回路径（test 5/6/9）会真的走到它，缺模型会抛错被吞成「无召回」。
 */
function makeConfig(memoryDir: string): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir, autoSurfacing: { model: "test/model" } });
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

function makeDeps(over: Partial<SurfacingDeps> = {}): SurfacingDeps {
	return {
		registry: { get: vi.fn(() => undefined) },
		indexCache: { refresh: vi.fn(async () => {}) },
		headless: { run: vi.fn(async () => null) },
		warn: vi.fn(),
		injected: new Map<string, Set<string>>(),
		...over,
	};
}

/** core 的 `parseSelectedFiles` 期望的回复格式：一个含 `selected_files` 数组的 JSON 对象。 */
function selectJson(files: string[]): string {
	return JSON.stringify({ selected_files: files });
}

describe("humanPromptText", () => {
	it("extracts text only from source.kind === \"user\" messages, returning \"\" when all are synthetic", () => {
		const user = createUserMsg("what did I say about alpha?");
		const synthetic = createSyntheticMsg("time-context", "now: 2026-11-09T00:00:00Z");
		const futureKind = createSyntheticMsg("some-future-plugin-kind", "future noise");

		expect(humanPromptText([synthetic, user, futureKind])).toBe("what did I say about alpha?");
		expect(humanPromptText([synthetic, futureKind])).toBe("");
		expect(humanPromptText([])).toBe("");
	});
});

describe("createPreStepListener", () => {
	it("returns an inner reject unchanged and never runs the side query", async () => {
		const headlessRun = vi.fn(async () => null);
		const refresh = vi.fn(async () => {});
		const deps = makeDeps({ indexCache: { refresh }, headless: { run: headlessRun } });
		const { ctx, emitter, makeAgent } = createFakeCtx();

		// 内层监听器先返回 reject；我们的监听器以 { prepend: true } 注册在最外层、最后看到 decision。
		ctx.on("agent/pre-step", () => ({ kind: "reject" }));
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const decision = await emitter.preStep({
			agent,
			messages: [createUserMsg("hi")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision).toEqual({ kind: "reject" });
		expect(refresh).not.toHaveBeenCalled();
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("skips recall on step > 1 but still refreshes the index cache", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const headlessRun = vi.fn(async () => selectJson(["Alpha.md"]));
		const refresh = vi.fn(async () => {});
		const deps = makeDeps({ registry: { get: () => rt }, indexCache: { refresh }, headless: { run: headlessRun } });
		const { ctx, emitter, makeAgent } = createFakeCtx();
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];
		const decision = await emitter.preStep({
			agent,
			messages,
			turn: 1,
			step: 2,
			signal: new AbortController().signal,
		});

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(headlessRun).not.toHaveBeenCalled();
		expect(decision.messages).toBe(messages);
	});

	it("skips recall when rt.surfacing.available is false", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store, { surfacing: { available: false, reason: "no model" } });
		const headlessRun = vi.fn(async () => selectJson(["Alpha.md"]));
		const refresh = vi.fn(async () => {});
		const deps = makeDeps({ registry: { get: () => rt }, indexCache: { refresh }, headless: { run: headlessRun } });
		const { ctx, emitter, makeAgent } = createFakeCtx();
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const decision = await emitter.preStep({
			agent,
			messages: [createUserMsg("hi")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(headlessRun).not.toHaveBeenCalled();
	});

	it("inserts the recall message after the last claimed user message", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		await store.addEntry({ name: "Alpha", description: "alpha note", body: "alpha body" });
		await store.addEntry({ name: "Beta", description: "beta note", body: "beta body" });
		const rt = makeRuntime(memoryDir, store);
		const headlessRun = vi.fn(async () => selectJson(["Alpha.md", "Beta.md"]));
		const deps = makeDeps({ registry: { get: () => rt }, headless: { run: headlessRun } });
		const { ctx, emitter, makeAgent } = createFakeCtx();
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const synthetic = createSyntheticMsg("time-context", "now: 2026-11-09T00:00:00Z");
		const user = createUserMsg("what did I say about alpha?");
		const messages = [synthetic, user];
		const decision = await emitter.preStep({
			agent,
			messages,
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.kind).toBe("enter");
		expect(decision.messages).toHaveLength(3);
		expect(decision.messages[0]).toBe(synthetic);
		expect(decision.messages[1]).toBe(user);
		expect(decision.messages[2]).toEqual(
			expect.objectContaining({ role: "user", source: expect.objectContaining({ kind: "simple-memory" }) }),
		);
	});

	it("splices after the last original message when an inner listener appended its own", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		await store.addEntry({ name: "Alpha", description: "alpha note", body: "alpha body" });
		const rt = makeRuntime(memoryDir, store);
		const headlessRun = vi.fn(async () => selectJson(["Alpha.md"]));
		const deps = makeDeps({ registry: { get: () => rt }, headless: { run: headlessRun } });
		const { ctx, emitter, makeAgent } = createFakeCtx();

		const appended = createSyntheticMsg("time-context", "the current time is now");
		// 内层监听器在 claim 的消息之后 append 一条自己的消息（time-context 就是这么干的）。
		ctx.on(
			"agent/pre-step",
			async (_payload: unknown, next: () => Promise<{ kind: string; messages: unknown[] }>) => {
				const d = await next();
				if (d.kind === "reject") return d;
				return { ...d, messages: [...d.messages, appended] };
			},
		);
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const synthetic = createSyntheticMsg("runtime-context", "some injected context");
		const user = createUserMsg("hi");
		const decision = await emitter.preStep({
			agent,
			messages: [synthetic, user],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.kind).toBe("enter");
		expect(decision.messages).toHaveLength(4);
		expect(decision.messages[2]).toEqual(
			expect.objectContaining({ role: "user", source: expect.objectContaining({ kind: "simple-memory" }) }),
		);
		expect(decision.messages[3]).toBe(appended);
	});

	it("preserves startsRequestSeries when splicing the recall message", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		await store.addEntry({ name: "Alpha", description: "alpha note", body: "alpha body" });
		const rt = makeRuntime(memoryDir, store);
		const headlessRun = vi.fn(async () => selectJson(["Alpha.md"]));
		const deps = makeDeps({ registry: { get: () => rt }, headless: { run: headlessRun } });
		const listener = createPreStepListener(deps);

		const user = createUserMsg("hi");
		const decision = await listener(
			{ agent: { session: { id: "s1" } }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: "enter" as const, messages: [user], startsRequestSeries: true as const }),
		);

		if (decision.kind !== "enter") throw new Error("expected an enter decision");
		expect(decision.startsRequestSeries).toBe(true);
		expect(decision.messages).toHaveLength(2);
	});

	it("returns the original decision and warns once when recall fails", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		// 触发 scanEntries 失败。注意：真正的 headless 失败会被 core 的 runSideQuery 吞成 []
		// （memory-core/src/orchestration/surfacing.ts 的 try/catch），根本到不了监听器的 catch；
		// 监听器自己的 catch 分支只在 manifest 扫描 / 渲染 / 意外形状等前置失败时可达。
		rt.store = { listEntries: () => Promise.reject(new Error("disk gone")) } as unknown as MemoryStore;
		const warn = vi.fn();
		const deps = makeDeps({ registry: { get: () => rt }, warn });
		const listener = createPreStepListener(deps);

		const user = createUserMsg("hi");
		const inner = { kind: "enter" as const, messages: [user] };
		const decision = await listener(
			{ agent: { session: { id: "s1" } }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
			async () => inner,
		);

		expect(decision).toBe(inner);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("auto-surfacing skipped");
	});

	it("treats a headless rejection as no selection (core swallows it) without warning", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		await store.addEntry({ name: "Alpha", description: "alpha note", body: "alpha body" });
		const rt = makeRuntime(memoryDir, store);
		const headlessRun = vi.fn(async () => {
			throw new Error("boom");
		});
		const warn = vi.fn();
		const deps = makeDeps({ registry: { get: () => rt }, headless: { run: headlessRun }, warn });
		const { ctx, emitter, makeAgent } = createFakeCtx();
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];
		const decision = await emitter.preStep({
			agent,
			messages,
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.messages).toBe(messages);
		expect(warn).not.toHaveBeenCalled();
	});

	it("dedupes per session: the second turn's side query sees injectedFiles with the first turn's selection", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		await store.addEntry({ name: "Alpha", description: "alpha note", body: "alpha body" });
		await store.addEntry({ name: "Beta", description: "beta note", body: "beta body" });
		const rt = makeRuntime(memoryDir, store);
		// 第一轮选 Alpha；第二轮「想再选 Alpha + Beta」，但 Alpha 已被 injectedFiles 过滤。
		const headlessRun = vi
			.fn<(req: HeadlessRunRequest) => Promise<string>>()
			.mockResolvedValueOnce(selectJson(["Alpha.md"]))
			.mockResolvedValueOnce(selectJson(["Alpha.md", "Beta.md"]));
		const deps = makeDeps({ registry: { get: () => rt }, headless: { run: headlessRun } });
		const { ctx, emitter, makeAgent } = createFakeCtx();
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		const first = await emitter.preStep({
			agent,
			messages,
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});
		expect(first.messages).toHaveLength(2);

		const second = await emitter.preStep({
			agent,
			messages,
			turn: 2,
			step: 1,
			signal: new AbortController().signal,
		});
		expect(second.messages).toHaveLength(2);

		expect(headlessRun).toHaveBeenCalledTimes(2);
		// 第一轮候选包含两条；第二轮 Alpha 已被注入，候选里只剩 Beta —— 这就是 injectedFiles 生效的证据。
		expect(headlessRun.mock.calls[0][0].task).toContain("Alpha.md");
		expect(headlessRun.mock.calls[0][0].task).toContain("Beta.md");
		expect(headlessRun.mock.calls[1][0].task).not.toContain("Alpha.md");
		expect(headlessRun.mock.calls[1][0].task).toContain("Beta.md");
	});
});

describe("createRecallMessage", () => {
	it("wraps the full <relevant_memories> body in a notice UserMessage with a short summary", () => {
		const body = "<relevant_memories>\n## Alpha\nalpha body\n</relevant_memories>";
		const msg = createRecallMessage(body, 2);

		expect(msg.role).toBe("user");
		expect(msg.id).not.toBe("");
		expect(msg.content).toEqual([{ type: "text", text: body }]);
		expect(msg.content[0].text).toBe(body);
		expect(msg.source).toEqual({ kind: "simple-memory", form: "notice", summary: "Recalled 2 memories" });
		expect(msg.source.summary.length).toBeLessThanOrEqual(120);

		expect(createRecallMessage(body, 1).source.summary).toBe("Recalled 1 memory");
	});
});
