import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, MemoryStore, mergeConfig } from "@yandy0725/memory-core";
import type { HeadlessOutcome, HeadlessRunRequest, MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreStepListener, createRecallMessage, humanPromptText } from "../src/surfacing.js";
import type { PendingRecall, SurfacingDeps } from "../src/surfacing.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";
import { createFakeCtx, createSyntheticMsg, createUserMsg } from "./helpers/fake-ctx.js";

/**
 * 召回的本体语义（prefetch）：`agent/pre-step` 的 step 1 只**启动**侧查询并立即返回原 decision，
 * 同一轮后续的 step ≥ 2 才消费已就绪的结果（splice + 标记去重）。所以这里每个「注入」断言都必需
 * 两步：step 1 启动、step 2 消费；只有一步的测试只配断「没注入」。
 *
 * `vi.waitFor` 一律显式给 15s 上限：默认 1s 在 windows-latest 的 CI 上会因为文件系统抖动假红。
 */
const WAIT = { timeout: 15_000 } as const;

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
		headless: { run: vi.fn(async (): Promise<HeadlessOutcome> => ({ status: "not-run", cause: "host-refused" })) },
		warn: vi.fn(),
		injected: new Map<string, Set<string>>(),
		pendingRecalls: new Map<string, PendingRecall>(),
		...over,
	};
}

/** 端口成功返回的形状；`text` 是 core 的 `parseSelectedFiles` 期望的含 `selected_files` 的 JSON 对象。 */
function selectOutcome(files: string[]): HeadlessOutcome {
	return { status: "completed", text: JSON.stringify({ selected_files: files }) };
}

type SideQuery = (req: HeadlessRunRequest) => Promise<HeadlessOutcome>;

/** 手动控制 settle 时机的侧查询端口：第 N 次调用对应第 N 个 deferred。 */
function deferredSideQuery(): {
	run: SideQuery;
	resolve(index: number, files: string[]): void;
	reject(index: number, error: unknown): void;
	calls(): number;
} {
	const settles: Array<{ resolve: (value: HeadlessOutcome) => void; reject: (e: unknown) => void }> = [];
	const run: SideQuery = () =>
		new Promise<HeadlessOutcome>((resolve, reject) => {
			settles.push({ resolve, reject });
		});
	return {
		run,
		resolve(index, files) {
			settles[index].resolve(selectOutcome(files));
		},
		reject(index, error) {
			settles[index].reject(error);
		},
		calls: () => settles.length,
	};
}

/** 等 prefetch 就绪；返回那条 pending（未出现或未 settle 就让 waitFor 抛）。 */
async function waitSettled(pendingRecalls: Map<string, PendingRecall>, sessionId = "s1"): Promise<PendingRecall> {
	await vi.waitFor(() => expect(pendingRecalls.get(sessionId)?.settled).toBe(true), WAIT);
	return pendingRecalls.get(sessionId) as PendingRecall;
}

interface RigOptions {
	/** 写进 store 的 entry（默认一条 Alpha）。 */
	entries?: Array<[name: string, body: string]>;
	sideQuery?: SideQuery;
	/** 替身索引刷新（默认立即 resolve）；用于把 abort 卡在 `indexCache.refresh` 这个 await 点上。 */
	refresh?: () => Promise<void>;
	config?: MemoryConfig;
	runtime?: Partial<SessionMemoryRuntime>;
	/** 用替身 store（错误态 / 扫描失败用例）：给了就跳过 entries 写入。 */
	store?: MemoryStore | null;
}

/** 手动控制 settle 时机的索引刷新：把调用次数当探针，避免固定等待造成的假绿。 */
function deferredRefresh(): { refresh: () => Promise<void>; release(index: number): void; calls(): number } {
	const gates: Array<() => void> = [];
	return {
		refresh() {
			return new Promise<void>((resolve) => {
				gates.push(resolve);
			});
		},
		release(index) {
			gates[index]();
		},
		calls: () => gates.length,
	};
}

/** 一次 surfacing 测试的装配：真 MemoryStore + 假宿主 waterfall + 可控侧查询端口。 */
async function makeRig(options: RigOptions = {}) {
	const memoryDir = join(dir, "mem");
	const config = options.config ?? makeConfig(memoryDir);
	const store = options.store === undefined ? makeStore(memoryDir) : options.store;
	if (options.store === undefined && store !== null) {
		for (const [name, body] of options.entries ?? [["Alpha", "alpha body"]]) {
			await store.addEntry({ name, description: `${name.toLowerCase()} note`, body });
		}
	}
	const headlessRun = vi.fn(options.sideQuery ?? (async () => selectOutcome(["Alpha.md"])));
	const injected = new Map<string, Set<string>>();
	const pendingRecalls = new Map<string, PendingRecall>();
	const refresh = vi.fn(options.refresh ?? (async () => {}));
	const warn = vi.fn();
	const rt = makeRuntime(memoryDir, store, { config, ...options.runtime });
	const deps = makeDeps({
		registry: { get: () => rt },
		indexCache: { refresh },
		headless: { run: headlessRun },
		warn,
		injected,
		pendingRecalls,
	});
	const listener = createPreStepListener(deps);
	const fake = createFakeCtx();
	fake.ctx.on("agent/pre-step", listener, { prepend: true });
	return { ...fake, memoryDir, config, store, rt, deps, listener, headlessRun, injected, pendingRecalls, refresh, warn };
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
	it("returns an inner reject unchanged, never queries, and drops any pending recall", async () => {
		const headlessRun = vi.fn(async () => selectOutcome(["Alpha.md"]));
		const refresh = vi.fn(async () => {});
		const pendingRecalls = new Map<string, PendingRecall>([
			["s1", { turn: 1, settled: true, prompt: "hi", files: ["Alpha.md"], content: "<relevant_memories>stale</relevant_memories>" }],
		]);
		const deps = makeDeps({ indexCache: { refresh }, headless: { run: headlessRun }, pendingRecalls });
		const { ctx, emitter, makeAgent } = createFakeCtx();

		// 内层监听器先返回 reject；我们的监听器以 { prepend: true } 注册在最外层、最后看到 decision。
		ctx.on("agent/pre-step", () => ({ kind: "reject" }));
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const agent = makeAgent({ id: "s1" });
		const decision = await emitter.preStep({
			agent,
			messages: [createUserMsg("hi")],
			turn: 1,
			step: 2,
			signal: new AbortController().signal,
		});

		expect(decision).toEqual({ kind: "reject" });
		expect(refresh).not.toHaveBeenCalled();
		expect(headlessRun).not.toHaveBeenCalled();
		// 被拒的 step 不会跑，这一轮不再有消费点：在途召回随轮作废。
		expect(pendingRecalls.size).toBe(0);
	});

	it("refreshes the index on every step but consumes nothing when no pending exists", async () => {
		// 必须真的写一条 entry：core 的 autoSurfacing 在候选清单为空时短路（memory-core/src/
		// orchestration/surfacing.ts 的 `candidates` 过滤），根本不会调用侧查询
		// 端口 —— 那时 `headlessRun` 恒不被调用，钉不住「step 2 也走消费分支」这件事本身。
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];
		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });

		expect(rig.refresh).toHaveBeenCalledTimes(1);
		expect(rig.headlessRun).not.toHaveBeenCalled();
		expect(decision.messages).toBe(messages);
		expect(rig.pendingRecalls.size).toBe(0);
	});

	it("skips recall when rt.surfacing.available is false", async () => {
		// 同上：没有 entry 时 core 会在调用端口之前短路，这条断言就变成恒真的空转测试。
		const rig = await makeRig({ runtime: { surfacing: { available: false, reason: "no model" } } });
		const agent = rig.makeAgent({ id: "s1" });

		const decision = await rig.emitter.preStep({
			agent,
			messages: [createUserMsg("hi")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(rig.refresh).toHaveBeenCalledTimes(1);
		expect(rig.headlessRun).not.toHaveBeenCalled();
		expect(decision.messages).toHaveLength(1);
		// 没启动 prefetch → 没有 pending 可留给后续 step。
		expect(rig.pendingRecalls.size).toBe(0);
	});

	it("skips recall when the runtime has no store (error state) and returns the decision unchanged", async () => {
		// 错误态运行时：`store === null` 而 memoryDir 非空。这是门禁的第三个条件，与 step / 可用性
		// 两条独立 —— 目录解析失败的会话绝不该把空 cwd 发给侧查询端口。
		const rig = await makeRig({ store: null, runtime: { error: "Failed to resolve memory directory: boom" } });
		const user = createUserMsg("hi");
		const messages = [user];
		const inner = { kind: "enter" as const, messages };

		const decision = await rig.listener(
			{ agent: { session: { id: "s1" } }, messages, turn: 1, step: 1, signal: new AbortController().signal },
			async () => inner,
		);

		expect(decision).toBe(inner);
		if (decision.kind !== "enter") throw new Error("expected an enter decision");
		expect(decision.messages).toBe(messages);
		expect(rig.headlessRun).not.toHaveBeenCalled();
		// 门禁在扫描候选之前就短路了：绝不能走成「把 null store 交给 scanEntries → 抛错 → catch 里记一行
		// warn」，那会在每个错误态会话的每一轮刷一条噪声日志。
		expect(rig.warn).not.toHaveBeenCalled();
		// 索引刷新与召回无关，错误态也照刷（index-cache 对 store === null 记空串）。
		expect(rig.refresh).toHaveBeenCalledTimes(1);
		expect(rig.pendingRecalls.size).toBe(0);
	});

	it("drops the previous turn's pending at step 1 even when the runtime is unavailable", async () => {
		// 回归：新的一轮在可用性门之前就必须作废旧 pending。否则 runtime 不可用 / no prompt / surfacing
		// 关闭的轮会在门里直接 return，旧 content/files 一直留在 Map 里等下一个消费点。
		const stale: PendingRecall = {
			turn: 1,
			settled: true,
			prompt: "old question",
			files: ["Alpha.md"],
			content: "<relevant_memories>stale</relevant_memories>",
		};
		const pendingRecalls = new Map<string, PendingRecall>([["s1", stale]]);
		const headlessRun = vi.fn(async () => selectOutcome(["Alpha.md"]));
		const deps = makeDeps({ headless: { run: headlessRun }, pendingRecalls });
		const { ctx, emitter, makeAgent } = createFakeCtx();
		ctx.on("agent/pre-step", createPreStepListener(deps), { prepend: true });

		const messages = [createUserMsg("new question")];
		const decision = await emitter.preStep({
			agent: makeAgent({ id: "s1" }),
			messages,
			turn: 2,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.messages).toBe(messages);
		expect(headlessRun).not.toHaveBeenCalled();
		// `registry.get` 恒返回 undefined —— 门没通过，但销账已经发生。
		expect(pendingRecalls.size).toBe(0);
	});

	it("drops the previous turn's pending at step 1 when the new turn claims no human prompt", async () => {
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });
		rig.pendingRecalls.set("s1", {
			turn: 1,
			settled: true,
			prompt: "old question",
			files: ["Alpha.md"],
			content: "<relevant_memories>stale</relevant_memories>",
		});

		// 全是合成消息：这一轮没有真人 prompt，不会启动新 prefetch。
		const messages = [createSyntheticMsg("time-context", "now: 2026-11-09T00:00:00Z")];
		const decision = await rig.emitter.preStep({
			agent,
			messages,
			turn: 2,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.messages).toBe(messages);
		expect(rig.headlessRun).not.toHaveBeenCalled();
		expect(rig.pendingRecalls.size).toBe(0);
	});

	it("only starts the prefetch at step 1: the decision messages are untouched and the pending is recorded", async () => {
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("what did I say about alpha?")];

		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });

		// 侧查询不阻塞：decision 原样返回（同一个数组，一条也没多），而 pending 已经记下了
		// turn 归属、真人 prompt（消费点的归属校验用它）、结果尚未就绪。
		expect(decision.messages).toBe(messages);
		const pending = rig.pendingRecalls.get("s1");
		expect(pending).toMatchObject({ turn: 1, prompt: "what did I say about alpha?", files: [], content: "" });
		expect(pending?.settled).toBe(false);

		// 侧查询在后台跑（decision 返回这一刻它可能连端口都没调到：scanEntries 是个 await 点）。
		await vi.waitFor(() => expect(rig.headlessRun).toHaveBeenCalledTimes(1), WAIT);
		await waitSettled(rig.pendingRecalls);
		expect(pending?.files).toEqual(["Alpha.md"]);
		expect(pending?.content.startsWith("<relevant_memories>")).toBe(true);
		// 未消费 → 不标记去重（标记只发生在真的把正文交给模型的那一步）。
		expect(rig.injected.has("s1")).toBe(false);
	});

	it("consumes a settled pending on the same turn's step 2: splices after the last claimed message and marks injected", async () => {
		const rig = await makeRig({
			entries: [
				["Alpha", "alpha body"],
				["Beta", "beta body"],
			],
			sideQuery: async () => selectOutcome(["Alpha.md", "Beta.md"]),
		});
		const agent = rig.makeAgent({ id: "s1" });
		const synthetic = createSyntheticMsg("time-context", "now: 2026-11-09T00:00:00Z");
		const user = createUserMsg("what did I say about alpha?");
		const messages = [synthetic, user];

		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);

		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });

		expect(decision.kind).toBe("enter");
		expect(decision.messages).toHaveLength(3);
		expect(decision.messages[0]).toBe(synthetic);
		expect(decision.messages[1]).toBe(user);

		// 钉住 splice 出去的是 core `renderSurfacedBlock` 的**真实渲染正文**：不做二次包裹、
		// 不再净化、不是空串；summary 是短摘要。
		const recall = decision.messages[2] as {
			role: string;
			content: Array<{ type: string; text: string }>;
			source: { kind: string; form: string; summary: string };
		};
		expect(recall.role).toBe("user");
		expect(recall.content).toHaveLength(1);
		const text = recall.content[0].text;
		expect(text.startsWith("<relevant_memories>")).toBe(true);
		expect(text.match(/<relevant_memories>/g)).toEqual(["<relevant_memories>"]);
		expect(text).toContain("## Alpha");
		expect(text).toContain("alpha body");
		expect(recall.source).toEqual({ kind: "simple-memory", form: "notice", summary: "Recalled 2 memories" });

		// 消费即标记去重，且 pending 只够消费一次。
		expect([...(rig.injected.get("s1") ?? [])].sort()).toEqual(["Alpha.md", "Beta.md"]);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("does not splice while the pending is still in flight, and consumes it on a later step", async () => {
		const deferred = deferredSideQuery();
		const rig = await makeRig({ sideQuery: deferred.run });
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await vi.waitFor(() => expect(deferred.calls()).toBe(1), WAIT);

		const early = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });
		// 未就绪：本轮这个请求不带召回（「永不阻塞」的代价面），pending 留着给后续 step。
		expect(early.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		expect(rig.pendingRecalls.has("s1")).toBe(true);

		deferred.resolve(0, ["Alpha.md"]);
		await waitSettled(rig.pendingRecalls);

		const later = await rig.emitter.preStep({ agent, messages, turn: 1, step: 3, signal: new AbortController().signal });
		expect(later.messages).toHaveLength(2);
		expect(rig.injected.get("s1")?.has("Alpha.md")).toBe(true);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("discards the pending when the step's turn no longer matches", async () => {
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);

		const decision = await rig.emitter.preStep({ agent, messages, turn: 2, step: 2, signal: new AbortController().signal });

		expect(decision.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		// turn 不匹配 → 作废（不留给下一轮的消费点）。
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("replaces the pending when a new turn starts before the previous prefetch settles", async () => {
		const deferred = deferredSideQuery();
		const rig = await makeRig({
			entries: [
				["Alpha", "alpha body"],
				["Beta", "beta body"],
			],
			sideQuery: deferred.run,
		});
		const agent = rig.makeAgent({ id: "s1" });

		await rig.emitter.preStep({
			agent,
			messages: [createUserMsg("first question")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});
		await vi.waitFor(() => expect(deferred.calls()).toBe(1), WAIT);
		await rig.emitter.preStep({
			agent,
			messages: [createUserMsg("second question")],
			turn: 2,
			step: 1,
			signal: new AbortController().signal,
		});
		await vi.waitFor(() => expect(deferred.calls()).toBe(2), WAIT);

		// 旧那一份迟到返回：它已被新 turn 的 pending 取代，结果随轮作废，绝不写回。
		deferred.resolve(0, ["Alpha.md"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const afterStale = rig.pendingRecalls.get("s1") as PendingRecall;
		expect(afterStale.turn).toBe(2);
		expect(afterStale.prompt).toBe("second question");
		expect(afterStale.content).toBe("");

		deferred.resolve(1, ["Beta.md"]);
		const pending = await waitSettled(rig.pendingRecalls);
		expect(pending.content).toContain("## Beta");
		expect(pending.content).not.toContain("## Alpha");
	});

	it("discards the pending when the step claims a new human prompt", async () => {
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });
		const first = createUserMsg("first question");

		await rig.emitter.preStep({ agent, messages: [first], turn: 1, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);

		// 同轮里又进来一条真人输入（steering / 排队的 follow-up 被这一步 claim）：召回属于前一条 prompt。
		const messages = [first, createUserMsg("follow-up while the model was working")];
		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });

		expect(decision.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("consumes when the claimed human text equals the pending prompt, even without shared message identity", async () => {
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });

		await rig.emitter.preStep({
			agent,
			messages: [createUserMsg("hi")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});
		await waitSettled(rig.pendingRecalls);

		// 同文本重复 prompt 视为同一轮（检索 query 相同，召回仍适用）；但这一步 claim 与 decision 里的
		// 消息没有身份交集（宿主 step ≥ 2 的 claim 可能只含这一步收进 inbox 的消息）→ splice 追加到末尾。
		const fresh = createUserMsg("hi");
		const decision = await rig.emitter.preStep({ agent, messages: [fresh], turn: 1, step: 2, signal: new AbortController().signal });

		expect(decision.messages).toHaveLength(2);
		expect(decision.messages[0]).toBe(fresh);
		expect(decision.messages[1]).toMatchObject({ source: { kind: "simple-memory" } });
		expect(rig.injected.get("s1")?.has("Alpha.md")).toBe(true);
	});

	it("consumes and appends at the end when a step >= 2 claims no messages at all", async () => {
		const rig = await makeRig();
		const context = createSyntheticMsg("runtime-context", "some injected context");
		const user = createUserMsg("hi");
		const contextMessages = [context, user];

		await rig.listener(
			{ agent: { session: { id: "s1" } }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: "enter" as const, messages: contextMessages }),
		);
		await waitSettled(rig.pendingRecalls);

		// 宿主常见形状：step >= 2 的 `payload.messages` 是「这一步从 inbox 收走的那些消息」，常为空
		// （只有工具结果、没有新输入）。空 claim 不是「新 prompt」：归属闸不能因此作废，仍要消费。
		const decision = await rig.listener(
			{ agent: { session: { id: "s1" } }, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
			async () => ({ kind: "enter" as const, messages: contextMessages }),
		);

		if (decision.kind !== "enter") throw new Error("expected an enter decision");
		// 空 claim 与 decision 里的消息没有身份交集（findLastIndex = -1）→ 追加到末尾，而不是插到最前。
		expect(decision.messages).toHaveLength(3);
		expect(decision.messages[0]).toBe(context);
		expect(decision.messages[1]).toBe(user);
		expect(decision.messages[2]).toMatchObject({ source: { kind: "simple-memory", form: "notice" } });
		expect(rig.injected.get("s1")?.has("Alpha.md")).toBe(true);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("splices after the last original message when an inner listener appended its own", async () => {
		const rig = await makeRig();
		const appended = createSyntheticMsg("time-context", "the current time is now");
		// 内层监听器在 claim 的消息之后 append 一条自己的消息（time-context 就是这么干的）。
		rig.ctx.on("agent/pre-step", async (_payload: unknown, next: () => Promise<{ kind: string; messages: unknown[] }>) => {
			const d = await next();
			if (d.kind === "reject") return d;
			return { ...d, messages: [...d.messages, appended] };
		});

		const agent = rig.makeAgent({ id: "s1" });
		const synthetic = createSyntheticMsg("runtime-context", "some injected context");
		const user = createUserMsg("hi");
		const messages = [synthetic, user];

		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);

		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });

		expect(decision.kind).toBe("enter");
		expect(decision.messages).toHaveLength(4);
		expect(decision.messages[2]).toEqual(
			expect.objectContaining({ role: "user", source: expect.objectContaining({ kind: "simple-memory" }) }),
		);
		expect(decision.messages[3]).toBe(appended);
	});

	it("preserves startsRequestSeries when consuming the recall message", async () => {
		const rig = await makeRig();
		const user = createUserMsg("hi");
		const messages = [user];

		await rig.listener(
			{ agent: { session: { id: "s1" } }, messages, turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: "enter" as const, messages, startsRequestSeries: true as const }),
		);
		await waitSettled(rig.pendingRecalls);

		const decision = await rig.listener(
			{ agent: { session: { id: "s1" } }, messages, turn: 1, step: 2, signal: new AbortController().signal },
			async () => ({ kind: "enter" as const, messages, startsRequestSeries: true as const }),
		);

		if (decision.kind !== "enter") throw new Error("expected an enter decision");
		expect(decision.startsRequestSeries).toBe(true);
		expect(decision.messages).toHaveLength(2);
	});

	it("returns the decision unchanged and warns once when the prefetch fails", async () => {
		// 触发 scanEntries 失败。注意：真正的 headless 失败会被 core 的 autoSurfacing 吞成 []
		// （memory-core/src/orchestration/surfacing.ts 的 errorPolicy "swallow"），根本到不了 prefetch 的
		// catch；catch 分支只在 manifest 扫描 / 渲染 / 意外形状等前置失败时可达。
		const brokenStore = { listEntries: () => Promise.reject(new Error("disk gone")) } as unknown as MemoryStore;
		const rig = await makeRig({ store: brokenStore });
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		const first = await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		expect(first.messages).toBe(messages);

		await vi.waitFor(() => expect(rig.warn).toHaveBeenCalledTimes(1), WAIT);
		expect(String(rig.warn.mock.calls[0][0])).toContain("auto-surfacing skipped");

		// 失败以空 content 收场：消费点据此丢弃，不 splice、不标记。
		const pending = await waitSettled(rig.pendingRecalls);
		expect(pending.content).toBe("");
		const second = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });
		expect(second.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("treats a headless rejection as no selection (core swallows it) without warning", async () => {
		const rig = await makeRig({
			sideQuery: async () => {
				throw new Error("boom");
			},
		});
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		const first = await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		expect(first.messages).toBe(messages);

		const pending = await waitSettled(rig.pendingRecalls);
		expect(pending.content).toBe("");
		expect(rig.warn).not.toHaveBeenCalled();

		const second = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });
		expect(second.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
	});

	it("dedupes per session: only a consumed selection enters the next turn's candidate list", async () => {
		const headlessRun = vi
			.fn<SideQuery>()
			.mockResolvedValueOnce(selectOutcome(["Alpha.md"]))
			.mockResolvedValueOnce(selectOutcome(["Alpha.md", "Beta.md"]));
		const rig = await makeRig({
			entries: [
				["Alpha", "alpha body"],
				["Beta", "beta body"],
			],
			sideQuery: headlessRun as unknown as SideQuery,
		});
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		// 第一轮：step 1 启动 + step 2 消费，Alpha 才算注入过。
		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);
		const first = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });
		expect(first.messages).toHaveLength(2);

		// 第二轮：launch 时的候选清单里 Alpha 已被过滤 —— 这就是 injectedFiles 生效的证据。
		await rig.emitter.preStep({ agent, messages, turn: 2, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);
		expect(headlessRun).toHaveBeenCalledTimes(2);
		expect(headlessRun.mock.calls[1][0].task).not.toContain("Alpha.md");
		expect(headlessRun.mock.calls[1][0].task).toContain("Beta.md");
	});

	it("forwards the turn's signal and the memoryDir cwd to the side query", async () => {
		const rig = await makeRig();
		const controller = new AbortController();

		await rig.listener(
			{
				agent: { session: { id: "s1" } },
				messages: [createUserMsg("hi")],
				turn: 1,
				step: 1,
				signal: controller.signal,
			},
			async () => ({ kind: "enter" as const, messages: [] }),
		);

		await vi.waitFor(() => expect(rig.headlessRun).toHaveBeenCalledTimes(1), WAIT);
		// 身份相等（不是「存在 signal 字段」）：证明 runTask 透传的是本轮 payload 的同一个 signal。
		expect(rig.headlessRun.mock.calls[0][0].signal).toBe(controller.signal);
		// cwd 就是 memoryDir（不是 `?? ""` 静默出的空串）。
		expect(rig.headlessRun.mock.calls[0][0].cwd).toBe(rig.memoryDir);
	});

	it("does not splice or mark when the turn is aborted while the side query is in flight", async () => {
		const deferred = deferredSideQuery();
		const rig = await makeRig({ sideQuery: deferred.run });
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];
		const controller = new AbortController();

		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: controller.signal });
		await vi.waitFor(() => expect(deferred.calls()).toBe(1), WAIT);

		// 侧查询 in-flight 时取消；随后让被取消的侧查询「迟到」地返回选中结果（模拟 30s 窗口）。
		controller.abort();
		deferred.resolve(0, ["Alpha.md"]);
		await waitSettled(rig.pendingRecalls);

		// 已取消的轮不会有后续 step；即使来了，取消复检也拒绝消费（不标记、不 splice）。
		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: controller.signal });
		expect(decision.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
		expect(rig.warn).not.toHaveBeenCalled();
	});

	it("does not start the prefetch when the turn is aborted during the index refresh", async () => {
		// 回归：refresh 是 abort 前的最后一个 await 点。它期间取消的轮不能再启动侧查询
		// （否则白扫一遍 manifest，runTask 拿到的是已取消的 signal）。
		const gate = deferredRefresh();
		const rig = await makeRig({ refresh: gate.refresh });
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];
		const controller = new AbortController();

		const call = rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: controller.signal });
		await vi.waitFor(() => expect(gate.calls()).toBe(1), WAIT);
		controller.abort();
		gate.release(0);
		const decision = await call;

		expect(decision.messages).toBe(messages);
		// 给 fire-and-forget 的 prefetch 一个落地的机会，再断言它根本没被启动过。
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.headlessRun).not.toHaveBeenCalled();
		expect(rig.pendingRecalls.size).toBe(0);
		expect(rig.warn).not.toHaveBeenCalled();
	});

	it("drops an unsettled pending when the turn is aborted during the index refresh", async () => {
		// 回归：取消复检必须在「未就绪就留给后续 step」之前。否则 abort 卡在 refresh 期间、pending
		// 又还没 settle 时，监听器会空手返回、把 pending 留在 Map 里跨轮驻留。
		const side = deferredSideQuery();
		const gate = deferredRefresh();
		const rig = await makeRig({ sideQuery: side.run, refresh: gate.refresh });
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		const launch = rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await vi.waitFor(() => expect(gate.calls()).toBe(1), WAIT);
		gate.release(0);
		const first = await launch;
		expect(first.messages).toBe(messages);
		await vi.waitFor(() => expect(side.calls()).toBe(1), WAIT);

		const controller = new AbortController();
		const call = rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: controller.signal });
		await vi.waitFor(() => expect(gate.calls()).toBe(2), WAIT);
		// 侧查询还在飞：这正是旧代码 `if (!pending.settled) return` 先于 abort 复检返回的那个窗口。
		expect(rig.pendingRecalls.get("s1")?.settled).toBe(false);
		controller.abort();
		gate.release(1);
		const decision = await call;

		expect(decision.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		// 统一销账：取消的轮没有后续请求，pending 不能靠「未就绪」留下来。
		expect(rig.pendingRecalls.has("s1")).toBe(false);
		// 侧查询的迟到结果也不会把它重新写回（写回前有身份校验）。
		side.resolve(0, ["Alpha.md"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("does not splice a settled pending when the turn is aborted during the index refresh", async () => {
		const gate = deferredRefresh();
		const rig = await makeRig({ refresh: gate.refresh });
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		const launch = rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await vi.waitFor(() => expect(gate.calls()).toBe(1), WAIT);
		gate.release(0);
		await launch;
		await waitSettled(rig.pendingRecalls);

		const controller = new AbortController();
		const call = rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: controller.signal });
		await vi.waitFor(() => expect(gate.calls()).toBe(2), WAIT);
		controller.abort();
		gate.release(1);
		const decision = await call;

		expect(decision.messages).toBe(messages);
		expect(rig.injected.has("s1")).toBe(false);
		expect(rig.pendingRecalls.has("s1")).toBe(false);
	});

	it("returns the decision unchanged when the signal is already aborted", async () => {
		const rig = await makeRig();
		const controller = new AbortController();
		controller.abort();
		const user = createUserMsg("hi");
		const messages = [user];
		const inner = { kind: "enter" as const, messages };

		const decision = await rig.listener(
			{ agent: { session: { id: "s1" } }, messages, turn: 1, step: 1, signal: controller.signal },
			async () => inner,
		);

		expect(decision).toBe(inner);
		expect(rig.headlessRun).not.toHaveBeenCalled();
		expect(rig.refresh).not.toHaveBeenCalled();
		expect(rig.pendingRecalls.size).toBe(0);
	});

	it("runs no side query when every claimed message is synthetic", async () => {
		const rig = await makeRig();
		const agent = rig.makeAgent({ id: "s1" });
		// TEXT 与人类消息测试逐字相同 —— source.kind 是唯一的决定变量。
		const messages = [
			createSyntheticMsg("agent-instructions", "what did I say about alpha?"),
			createSyntheticMsg("some-future-kind", "what did I say about alpha?"),
		];

		const decision = await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });

		expect(rig.headlessRun).not.toHaveBeenCalled();
		expect(rig.refresh).toHaveBeenCalledTimes(1);
		expect(decision.messages).toBe(messages);
		expect(rig.pendingRecalls.size).toBe(0);
	});

	it("does not mark injected when the render is empty, so the next turn still offers the same files", async () => {
		const memoryDir = join(dir, "mem");
		// maxInjectionBytes: 0 让 renderSurfacedBlock 恒返回 ""（core/injection.ts:240,245）。
		const config = mergeConfig(structuredClone(DEFAULT_CONFIG), {
			memoryDir,
			autoSurfacing: { model: "test/model", maxInjectionBytes: 0 },
		});
		const rig = await makeRig({
			config,
			entries: [
				["Alpha", "alpha body"],
				["Beta", "beta body"],
			],
			sideQuery: async () => selectOutcome(["Alpha.md", "Beta.md"]),
		});
		const agent = rig.makeAgent({ id: "s1" });
		const messages = [createUserMsg("hi")];

		await rig.emitter.preStep({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);
		const first = await rig.emitter.preStep({ agent, messages, turn: 1, step: 2, signal: new AbortController().signal });
		expect(first.messages).toBe(messages); // 空渲染 → 不 splice、不标记
		expect(rig.injected.has("s1")).toBe(false);

		await rig.emitter.preStep({ agent, messages, turn: 2, step: 1, signal: new AbortController().signal });
		await waitSettled(rig.pendingRecalls);
		expect(rig.headlessRun).toHaveBeenCalledTimes(2);
		// 关键：第二轮候选里仍含 Alpha —— 空渲染没有把它标记为 injected。
		expect(rig.headlessRun.mock.calls[1][0].task).toContain("Alpha.md");
		expect(rig.headlessRun.mock.calls[1][0].task).toContain("Beta.md");
	});

	it("caps the side-query user prompt at 4000 chars", async () => {
		const rig = await makeRig();
		const user = createUserMsg("a".repeat(4000) + "TAIL_BEYOND_CAP");

		await rig.listener(
			{ agent: { session: { id: "s1" } }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
			async () => ({ kind: "enter" as const, messages: [user] }),
		);

		await vi.waitFor(() => expect(rig.headlessRun).toHaveBeenCalledTimes(1), WAIT);
		const task = rig.headlessRun.mock.calls[0][0].task;
		expect(task).toContain("a".repeat(4000));
		expect(task).not.toContain("TAIL_BEYOND_CAP");
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
