import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, MAIN_AGENT_ACTIONS, MemoryStore, mergeConfig } from "@yandy0725/memory-core";
import type { HeadlessAgentPort, HeadlessRunRequest, MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnStoppingListener } from "../src/extract.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";
import { createDshTranscript } from "../src/transcript.js";

/**
 * extract 触发点的测试：什么情况下**不**跑，以及跑的时候交给 core 的是什么东西。
 *
 * 跑不跑的判断错了不会报错，只会在用户的每一轮里偷偷多一次模型调用（或静默永不抽取），
 * 所以这里把三道门禁（未开启 / 子 agent / 无运行时）逐条钉死。
 */

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-extract-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeConfig(over: unknown = {}): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), {
		memoryDir: join(dir, "mem"),
		defaults: { model: "prov/extract" },
		extractMemories: { enabled: true },
		...(over as object),
	});
}

function makeStore(cfg: MemoryConfig): MemoryStore {
	return new MemoryStore({
		memoryDir: cfg.memoryDir,
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	});
}

function makeRuntime(cfg: MemoryConfig, over: Partial<SessionMemoryRuntime> = {}): SessionMemoryRuntime {
	return {
		sessionId: "s1",
		cwd: dir,
		config: cfg,
		store: makeStore(cfg),
		memoryDir: cfg.memoryDir,
		error: null,
		surfacing: { available: false, reason: "off" },
		...over,
	};
}

/** 一条会话事件的最小集合：一条真人发言 + 一条 assistant 回复。 */
const TRANSCRIPT = [
	{ type: "user/message", data: { content: [{ type: "text", text: "remember the lock file is permanent" }], source: { kind: "user" } } },
	{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "Noted." }] } } },
];

function sessionLike(
	events: readonly { type: string; data?: unknown }[] = TRANSCRIPT,
	header: { cwd?: string; origin?: string; delegationDepth?: number; parentSession?: string } = {},
) {
	return {
		id: "s1",
		header,
		seq: events.length,
		snapshotEvents: () => events,
	};
}

function makeDeps(options: {
	rt?: SessionMemoryRuntime;
	headless?: HeadlessAgentPort;
	warn?: (message: string, ...params: unknown[]) => void;
	info?: (message: string, ...params: unknown[]) => void;
} = {}) {
	const requests: HeadlessRunRequest[] = [];
	const headless: HeadlessAgentPort =
		options.headless ??
		({
			async run(req) {
				requests.push(req);
				return { status: "completed", text: "nothing worth saving" };
			},
		} satisfies HeadlessAgentPort);
	const rt = options.rt;
	return {
		requests,
		deps: {
			registry: { get: (sessionId: string) => (rt !== undefined && rt.sessionId === sessionId ? rt : undefined) },
			headlessFor: () => headless,
			transcript: createDshTranscript(async () => ""),
			warn: options.warn ?? (() => {}),
			info: options.info ?? (() => {}),
		},
	};
}

/** 让 fire-and-forget 链跑完（监听器同步返回，抽取在后面继续）。 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createTurnStoppingListener — 门禁", () => {
	it("does nothing when extractMemories is disabled", async () => {
		const rt = makeRuntime(makeConfig({ extractMemories: { enabled: false } }));
		const { requests, deps } = makeDeps({ rt });

		createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
		await flush();

		// 触发点决策属于适配层：关闭时连 `runTask` 都不该调（也就不会碰模型与锁）。
		expect(requests).toEqual([]);
	});

	it("does nothing for a subagent session", async () => {
		const rt = makeRuntime(makeConfig());
		const { requests, deps } = makeDeps({ rt });

		createTurnStoppingListener(deps)({
			agent: { session: sessionLike(TRANSCRIPT, { origin: "subagent", delegationDepth: 1 }) },
		});
		await flush();

		// 子会话（我们自己的 extract / dream 子会话、宿主的 subagent）不该按自己的对话写记忆。
		expect(requests).toEqual([]);
	});

	it("does nothing when the session has no memory runtime", async () => {
		const { requests, deps } = makeDeps();
		createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
		await flush();
		expect(requests).toEqual([]);
	});

	it("does nothing when the runtime failed to initialize", async () => {
		const rt = makeRuntime(makeConfig(), { store: null, memoryDir: null, error: "no dir" });
		const { requests, deps } = makeDeps({ rt });
		createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
		await flush();
		expect(requests).toEqual([]);
	});

	it("does nothing when the transcript is empty", async () => {
		const rt = makeRuntime(makeConfig());
		const { requests, deps } = makeDeps({ rt });
		createTurnStoppingListener(deps)({ agent: { session: sessionLike([]) } });
		await flush();
		expect(requests).toEqual([]);
	});
});

describe("createTurnStoppingListener — 交给 core 的东西", () => {
	it("renders the session events into the extract prompt", async () => {
		const rt = makeRuntime(makeConfig());
		const { requests, deps } = makeDeps({ rt });

		createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
		await flush();

		expect(requests).toHaveLength(1);
		const [request] = requests;
		// 三个任务的 `builtinTools` 恒为 "none"；extract 的 5 个 action 与逻辑锁都来自 core 的 plan。
		expect(request.builtinTools).toBe("none");
		expect(request.memoryTool?.actions).toEqual(MAIN_AGENT_ACTIONS);
		expect(request.memoryTool?.skipLogicalLock).toBe(true);
		expect(request.memoryTool?.skipSnapshot).toBe(false);
		// 模型与 cwd 由 core 从 cfg 读出来：适配层一个 config 值都不传。
		expect(request.model).toBe("prov/extract");
		expect(request.cwd).toBe(rt.memoryDir);
		// 对话是**会话事件**渲染出来的（这一句来自那条真人发言）。
		expect(request.task).toContain("remember the lock file is permanent");
		expect(request.task).toContain("Noted.");
	});

	it("stays silent when the round was skipped (nothing written)", async () => {
		const rt = makeRuntime(makeConfig());
		const info = vi.fn();
		const { deps } = makeDeps({
			rt,
			info,
			headless: { run: async () => ({ status: "not-run", cause: "host-refused" }) },
		});

		createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
		await flush();

		// `not-run` → core 把这一轮记成 skipped：不该弹「extracted N memories」。
		expect(info).not.toHaveBeenCalled();
	});

	it("logs a readable line when the round fails, instead of an unhandled rejection", async () => {
		const rt = makeRuntime(makeConfig());
		const warn = vi.fn();
		const { deps } = makeDeps({
			rt,
			warn,
			headless: {
				run: async () => {
					throw new Error("model unavailable");
				},
			},
		});

		createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
		await flush();

		expect(warn).toHaveBeenCalled();
		expect(String(warn.mock.calls[0][1])).toContain("model unavailable");
	});

	it("never throws into the host's serial turn-stopping dispatch", () => {
		const rt = makeRuntime(makeConfig());
		const warn = vi.fn();
		const { deps } = makeDeps({ rt, warn });
		const broken = {
			id: "s1",
			header: {},
			seq: 1,
			snapshotEvents: (): readonly { type: string; data?: unknown }[] => {
				throw new Error("session disposed");
			},
		};

		// 宿主 await 这个监听器：抛错会变成「这一轮收口失败」，而抽取只是增强。
		expect(() => createTurnStoppingListener(deps)({ agent: { session: broken } })).not.toThrow();
		expect(warn).toHaveBeenCalled();
	});
});

describe("createTurnStoppingListener — 不许留下未处理拒绝（CI 回归）", () => {
	it("leaves no unhandled rejection when a round rejects", async () => {
		// extract 的 `errorPolicy` 是 `rethrow`：一轮失败会以 rejection 结束。触发点必须自己接管它
		// （包括为 `drain()` 记账用的那个派生 promise），否则 Node 会把它当成未处理拒绝 ——
		// CI 上就是这么红的（本地 vitest 不一定暴露）。
		const seen: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			seen.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const rt = makeRuntime(makeConfig());
			const { deps } = makeDeps({
				rt,
				headless: {
					run: async () => {
						throw new Error("model unavailable");
					},
				},
			});

			createTurnStoppingListener(deps)({ agent: { session: sessionLike() } });
			await flush();
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(seen).toEqual([]);
	});
});
