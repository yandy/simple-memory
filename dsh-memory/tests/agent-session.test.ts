import type { HeadlessRunRequest } from "@yandy0725/memory-core";
import { describe, expect, it } from "vitest";
import { FILE_IO_TOOL_NAMES, runNestedSession } from "../src/agent-session.js";
import type { NestedMemoryToolOptions } from "../src/agent-session.js";

/**
 * `agent-session.ts` 的单元测试：全部对着一个**本地**假 `ctx.agents`，不碰 fake-ctx。
 *
 * 这里钉的是 core 的**结果词汇**（`HeadlessOutcome` 的判别规则）与三件宿主事实：
 * 子会话怎么建、能力面怎么收窄、怎么收口。这三件事任何一件错了，extract / dream 都会
 * 静默地「跑了但没写」或「没跑却报成功」。
 */

interface Script {
	createThrows?: string;
	setupThrows?: string;
	/** 这一轮跑多少 step（默认 1）。 */
	steps?: number;
	/** `whenIdle` 永不收敛（模拟卡住的模型调用，只有超时能打断它）。 */
	hang?: boolean;
	/** 只发 `agent/error`、不发 `turn/end`（模型层直接失败的形态）。 */
	errorEvent?: boolean;
	/**
	 * 忠实真宿主的一个怪癖：驱动还没把这一轮登记为「活动」时，`whenIdle()` **立刻 resolve**，
	 * 而此时 `status` 仍是 `running`。只 await 一次 `whenIdle()` 就会在 turn 真正跑起来之前
	 * dispose（真机上表现为子会话只有 `turn/start` → `turn/end(aborted, disposed)`，0 个请求）。
	 */
	earlyIdle?: boolean;
	idleThrows?: string;
	events?: Array<{ type: string; data?: unknown }>;
	/** 部署里注册了哪些全局工具（`restrict` 的已知名字集合）。 */
	globalTools?: string[];
}

function makeRequest(over: Partial<HeadlessRunRequest> = {}): HeadlessRunRequest {
	return {
		task: "do the thing",
		cwd: "/mem",
		model: "prov/model",
		timeoutMs: 5_000,
		builtinTools: "none",
		memoryTool: null,
		...over,
	};
}

function makeAgents(script: Script = {}) {
	const creates: any[] = [];
	const registered: unknown[] = [];
	const restrictions: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = [];
	const cancels: unknown[] = [];
	const messages: unknown[] = [];
	const events: Array<{ type: string; data?: unknown; seq: number }> = [];
	const state = { disposed: 0, stepsRun: 0 };
	const globalTools = script.globalTools ?? [];

	/** 顺序执行的 cordis waterfall：entries[0] 最外层，`next()` 只能调一次。 */
	function waterfall(entries: Array<(payload: any, next?: () => Promise<any>) => unknown>, payload: unknown): Promise<any> {
		const dispatch = (index: number): Promise<any> => {
			if (index >= entries.length) return Promise.resolve({ kind: "enter", messages: [] });
			let called = false;
			const next = () => {
				if (called) throw new Error("next() called multiple times");
				called = true;
				return dispatch(index + 1);
			};
			return Promise.resolve(entries[index](payload, next));
		};
		return dispatch(0);
	}

	const agents = {
		async create(options: any): Promise<any> {
			creates.push(options);
			if (script.createThrows !== undefined) throw new Error(script.createThrows);

			const preStep: Array<(payload: any, next?: () => Promise<any>) => unknown> = [];
			const sessionListeners: Array<(session: unknown, event: unknown) => unknown> = [];
			const errorListeners: Array<(payload: unknown) => unknown> = [];
			let pending: Promise<void> | undefined;
			let idleWaiters = 0;
			const runState = { settled: false };

			const child: any = {
				session: {
					id: options.sessionId,
					get seq(): number {
						return events.length;
					},
					snapshotEvents(from = 0, to = events.length): unknown[] {
						return events.slice(from, to);
					},
				},
				followup(message: unknown): void {
					messages.push(message);
					// 忠实真宿主：`followup` 只把消息入队，驱动在**下一个宏任务**才启动这一轮
					// （微任务启动不足以复现「whenIdle 先 resolve」那个时序 —— 那正是漏掉这条 bug 的原因）。
					pending = new Promise<void>((resolve, reject) => {
						setTimeout(() => {
							// 拒绝必须传出去：`whenIdle()` 的失败是适配层「这一轮没跑成」的唯一信号。
							void runTurn().then(resolve, reject);
						}, 0);
					});
				},
				get status(): string {
					return runState.settled ? "idle" : "running";
				},
				whenIdle(): Promise<void> {
					// `earlyIdle`：第一次调用直接 resolve（status 仍 running），之后才等真正的收敛。
					idleWaiters += 1;
					if (script.earlyIdle === true && idleWaiters === 1) return Promise.resolve();
					return (pending ?? Promise.resolve()).then(() => {
						runState.settled = true;
					});
				},
				cancel(cause: unknown): void {
					cancels.push(cause);
				},
			};

			async function runTurn(): Promise<void> {
				for (let step = 1; step <= (script.steps ?? 1); step++) {
					const decision = await waterfall(preStep, {
						agent: child,
						turn: 1,
						step,
						signal: new AbortController().signal,
					});
					if (decision?.kind === "reject") break;
					state.stepsRun += 1;
				}
				// 忠实效地：一轮对话**总会**以 `turn/end` 收口（除了「卡住」这种病态剧本）。
				const scripted = script.events ?? [];
				const closesTurn = scripted.some((event) => event.type === "turn/end");
				const toAppend =
					script.hang === true
						? scripted
						: closesTurn || script.errorEvent === true
							? scripted
							: [...scripted, { type: "turn/end", data: { reason: { kind: "completed" } } }];
				for (const event of toAppend) {
					const appended = { ...event, seq: events.length };
					events.push(appended);
					for (const listener of sessionListeners) await listener(child.session, appended);
				}
				if (script.errorEvent === true) {
					for (const listener of errorListeners) await listener({ agent: child, turn: 1, step: 1, error: new Error("x") });
				}
				if (script.hang === true) await new Promise<void>(() => {});
				if (script.idleThrows !== undefined) throw new Error(script.idleThrows);
			}

			const scope = {
				tools: {
					register(tool: unknown): () => void {
						registered.push(tool);
						return () => {};
					},
					restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void {
						// 忠实宿主：空过滤器抛错、未知名字抛错（`dsh-tools/lib/index.js:453-468`）。
						if (filter.allow === undefined && filter.deny === undefined) {
							throw new Error("tools.restrict({}) is a no-op");
						}
						const named = [...(filter.allow ?? []), ...(filter.deny ?? [])];
						const unknown = named.filter((name) => !globalTools.includes(name));
						if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`);
						restrictions.push(filter);
						return () => {};
					},
					definitions(): readonly { name: string }[] {
						return globalTools.map((name) => ({ name }));
					},
				},
				on(event: string, handler: (...args: any[]) => unknown): () => void {
					if (event === "agent/pre-step") {
						preStep.push(handler);
						return () => {};
					}
					// 适配层的收敛判据是 `turn/end`（以及 `agent/error`）这两个事件。
					if (event === "session/event" || event === "agent/error") {
						const arr = event === "session/event" ? sessionListeners : errorListeners;
						arr.push(handler);
						return () => {};
					}
					throw new Error(`unexpected event "${event}"`);
				},
			};

			// `setup` 同步抛错 = 创建失败（宿主同语义）。
			options.setup?.(scope, child);
			if (script.setupThrows !== undefined) throw new Error(script.setupThrows);

			return {
				agent: child,
				dispose: async (): Promise<void> => {
					state.disposed += 1;
				},
			};
		},
	};

	return { agents, creates, registered, restrictions, cancels, messages, events, state };
}

function makeDeps(agents: { create(options: any): Promise<any> }, built: NestedMemoryToolOptions[] = []) {
	return {
		agents,
		buildMemoryTool(options: NestedMemoryToolOptions): unknown {
			built.push(options);
			return { name: "memory", marker: "built" };
		},
		warn(): void {},
	};
}

const assistantText = (text: string) => ({
	type: "assistant/message",
	data: { message: { content: [{ type: "text", text }] } },
});

describe("runNestedSession — 子会话的建立", () => {
	it("creates a subagent session at the requested cwd with the parsed provider/model/effort", async () => {
		const { agents, creates } = makeAgents();
		const outcome = await runNestedSession(makeRequest({ model: "prov/x", effort: "high" }), makeDeps(agents));

		expect(outcome).toEqual({ status: "no-output" });
		expect(creates).toHaveLength(1);
		const [options] = creates;
		expect(options.sessionId).toMatch(/^session-/);
		// `origin: "subagent"` 是本插件自己的子 agent 门禁判据（`isRootAgent`）：没有它，子会话会
		// 再挂一层记忆层（索引 section + 工具 + 召回）。
		expect(options.meta).toEqual({ cwd: "/mem", origin: "subagent", delegationDepth: 1 });
		expect(options.agentOptions).toEqual({ provider: "prov", model: "x", reasoningEffort: "high" });
	});

	it("parses only the first slash, so a model id may contain slashes", async () => {
		const { agents, creates } = makeAgents();
		await runNestedSession(makeRequest({ model: "megcore/qwen/qwen3.8-max" }), makeDeps(agents));
		expect(creates[0].agentOptions).toEqual({ provider: "megcore", model: "qwen/qwen3.8-max" });
	});

	it("never sends reasoningEffort when the request has none", async () => {
		const { agents, creates } = makeAgents();
		await runNestedSession(makeRequest({ effort: undefined }), makeDeps(agents));
		expect("reasoningEffort" in creates[0].agentOptions).toBe(false);
	});

	it("returns unavailable for a model ref without a slash, and creates nothing", async () => {
		const { agents, creates } = makeAgents();
		const outcome = await runNestedSession(makeRequest({ model: "deepseek-flash" }), makeDeps(agents));
		expect(outcome).toEqual({ status: "not-run", cause: "unavailable" });
		expect(creates).toEqual([]);
	});

	it("returns aborted (and creates nothing) when the caller cancelled before dispatch", async () => {
		const { agents, creates } = makeAgents();
		const controller = new AbortController();
		controller.abort();
		const outcome = await runNestedSession(makeRequest({ signal: controller.signal }), makeDeps(agents));
		expect(outcome).toEqual({ status: "not-run", cause: "aborted" });
		expect(creates).toEqual([]);
	});

	it("maps a creation failure to not-run/host-refused with the host's message", async () => {
		const { agents } = makeAgents({ createThrows: "no factory registered" });
		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));
		expect(outcome).toEqual({ status: "not-run", cause: "host-refused", detail: "no factory registered" });
	});
});

describe("runNestedSession — 能力面收窄", () => {
	it("registers the memory tool with the requested actions and both skip flags", async () => {
		const { agents, registered, restrictions } = makeAgents();
		const built: NestedMemoryToolOptions[] = [];
		const onWrite = () => {};

		await runNestedSession(
			makeRequest({
				memoryTool: {
					actions: ["add", "replace", "remove", "list", "search"],
					skipLogicalLock: true,
					skipSnapshot: false,
					onWrite,
				},
			}),
			makeDeps(agents, built),
		);

		expect(registered).toEqual([{ name: "memory", marker: "built" }]);
		expect(built).toEqual([
			{ actions: ["add", "replace", "remove", "list", "search"], skipLogicalLock: true, skipSnapshot: false, onWrite },
		]);
		// 三个任务的 `builtinTools` 恒为 "none"：全局工具全部关掉，子会话只剩作用域里的 memory 工具。
		expect(restrictions).toEqual([{ allow: [] }]);
	});

	it("keeps every global tool out when builtinTools is explicitly file-io but nothing file-like is registered", async () => {
		// 失败模式必须是**少给**能力：交集为空 = 没有文件工具，而不是「放行全部」。
		const { agents, restrictions } = makeAgents({ globalTools: ["bash", "subagent"] });
		await runNestedSession(makeRequest({ builtinTools: "file-io" }), makeDeps(agents));
		expect(restrictions).toEqual([{ allow: [] }]);
	});

	it("allows only the file tools that this deployment actually registers", async () => {
		const { agents, restrictions } = makeAgents({
			globalTools: ["read", "write", "bash", "glob", "str_replace_editor", "web_fetch"],
		});
		await runNestedSession(
			makeRequest({ builtinTools: "file-io", memoryTool: { actions: ["add"] } }),
			makeDeps(agents),
		);
		// 只留 file-io 子集（候选表 ∩ 已注册），`bash` / `web_fetch` 这类非文件工具被挡在外面。
		expect(restrictions).toEqual([{ allow: ["read", "glob", "write", "str_replace_editor"] }]);
		// 候选表本身不允许出现 shell 类工具 —— 名单改成含 `bash` 时这条会红。
		expect(FILE_IO_TOOL_NAMES).not.toContain("bash");
	});

	it("fails the creation (not-run) when the tool list cannot be restricted", async () => {
		const { agents } = makeAgents({ setupThrows: "tools.restrict() names unknown global tool \"read\"" });
		const outcome = await runNestedSession(
			makeRequest({ builtinTools: "file-io" }),
			makeDeps(agents),
		);
		// 建不起来就一个模型 token 都不该烧：装配失败 = 没跑。
		expect(outcome.status).toBe("not-run");
		expect(outcome).toMatchObject({ cause: "host-refused" });
	});
});

describe("runNestedSession — 结果词汇", () => {
	it("returns the last non-empty assistant message", async () => {
		const { agents } = makeAgents({
			events: [assistantText("first"), assistantText("second"), assistantText(""), { type: "turn/end", data: { reason: { kind: "completed" } } }],
		});
		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));
		// 空回复不覆盖上一条：宿主规则是「最后一条**非空**」（`dsh-subagent/assistant-output`）。
		expect(outcome).toEqual({ status: "completed", text: "second" });
	});

	it("joins text blocks and ignores reasoning blocks", async () => {
		const { agents } = makeAgents({
			events: [
				{
					type: "assistant/message",
					data: {
						message: {
							content: [
								{ type: "reasoning", text: "thinking hard" },
								{ type: "text", text: "answer " },
								{ type: "text", text: "text" },
							],
						},
					},
				},
			],
		});
		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));
		expect(outcome).toEqual({ status: "completed", text: "answer text" });
	});

	it("reports no-output when the turn produced no assistant text", async () => {
		const { agents } = makeAgents({ events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }] });
		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));
		expect(outcome).toEqual({ status: "no-output" });
	});

	it("permanently disposes the sub-session", async () => {
		const { agents, state } = makeAgents({ events: [assistantText("ok")] });
		await runNestedSession(makeRequest(), makeDeps(agents));
		expect(state.disposed).toBe(1);
	});

	it("disposes even when the driver throws, and reports host-refused with the message", async () => {
		const { agents, state } = makeAgents({ idleThrows: "adapter exploded" });
		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));
		expect(outcome).toEqual({ status: "not-run", cause: "host-refused", detail: "adapter exploded" });
		expect(state.disposed).toBe(1);
	});

	it("maps turn/end error to not-run/host-refused carrying code and message", async () => {
		const { agents } = makeAgents({
			events: [{ type: "turn/end", data: { reason: { kind: "error", error: { code: "MODEL_UNAVAILABLE", message: "no such model" } } } }],
		});
		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));
		expect(outcome).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: "MODEL_UNAVAILABLE: no such model",
		});
	});

	it("maps turn/end aborted and max-tokens to incomplete", async () => {
		const aborted = makeAgents({ events: [{ type: "turn/end", data: { reason: { kind: "aborted" } } }] });
		expect(await runNestedSession(makeRequest(), makeDeps(aborted.agents))).toEqual({
			status: "incomplete",
			cause: "aborted",
		});

		const maxTokens = makeAgents({ events: [{ type: "turn/end", data: { reason: { kind: "max-tokens" } } }] });
		expect(await runNestedSession(makeRequest(), makeDeps(maxTokens.agents))).toEqual({
			status: "incomplete",
			cause: "max-tokens",
		});
	});

	it("treats any aborted turn as an interruption, even if a later turn ended cleanly", async () => {
		const { agents } = makeAgents({
			events: [
				{ type: "turn/end", data: { reason: { kind: "aborted" } } },
				assistantText("recovered"),
				{ type: "turn/end", data: { reason: { kind: "completed" } } },
			],
		});
		// 保守判定：只要出现过 aborted 的 turn 就报 `incomplete`。单 followup = 单个 turn（真实情况只有
		// 一个 turn/end），所以这条只在宿主将来出现多 turn 子会话时生效 —— 宁可报「跑了但可能不完整」，
		// 也不要报「完成」而让 extract 把一次被打断的写入当成正常轮次。
		expect(await runNestedSession(makeRequest(), makeDeps(agents))).toEqual({
			status: "incomplete",
			cause: "aborted",
		});
	});

	it("enforces maxTurns as a best-effort step cap and reports turn-limit", async () => {
		const { agents, state } = makeAgents({ steps: 4, events: [assistantText("partial")] });
		const outcome = await runNestedSession(makeRequest({ maxTurns: 2 }), makeDeps(agents));
		expect(outcome).toEqual({ status: "incomplete", cause: "turn-limit" });
		// 第 3 个 step 被拒：只跑了 2 个。
		expect(state.stepsRun).toBe(2);
	});

	it("does not cap steps when the request has no maxTurns", async () => {
		const { agents, state } = makeAgents({ steps: 4, events: [assistantText("done")] });
		const outcome = await runNestedSession(makeRequest({ maxTurns: undefined }), makeDeps(agents));
		expect(outcome).toEqual({ status: "completed", text: "done" });
		expect(state.stepsRun).toBe(4);
	});
});

describe("runNestedSession — 超时与取消", () => {
	it("interrupts a hanging turn on timeout, cancels it, and reports incomplete (writes may have happened)", async () => {
		const { agents, cancels, state } = makeAgents({ hang: true, events: [assistantText("half")] });
		const outcome = await runNestedSession(makeRequest({ timeoutMs: 20 }), makeDeps(agents));

		// 超时发生在**请求发出之后**：按 core 的判别规则是 `incomplete`（写入可能已发生），
		// 绝不能报 `not-run` —— 那会让 extract 把一轮真实写入当成「没跑」。
		expect(outcome).toEqual({ status: "incomplete", cause: "aborted" });
		// 超时必须真的打断子会话，否则 `whenIdle()` 会挂到模型自然结束，`timeoutMs` 形同虚设。
		expect(cancels).toHaveLength(1);
		expect(state.disposed).toBe(1);
	});

	it("returns not-run/timeout when the creation itself times out", async () => {
		// `create` 永不 settle（宿主在建会话时就挂住）：请求从未发出，所以是 `not-run`。
		const agents = {
			create: () => new Promise<never>(() => {}),
		};
		const outcome = await runNestedSession(makeRequest({ timeoutMs: 20 }), makeDeps(agents));
		expect(outcome).toEqual({ status: "not-run", cause: "timeout" });
	});
});

describe("runNestedSession — 收敛判定（真机回归）", () => {
	it("waits for the real turn even when the host resolves whenIdle() early", async () => {
		// 真机上的现象：子会话日志里只有 `turn/start` → `turn/end(aborted, disposed)`、0 个请求、
		// 什么也没写。原因是我们只 await 了一次 `whenIdle()`，而驱动还没把这一轮登记为活动时它会
		// 立刻 resolve，于是 dispose 把刚开的一轮打断。这里让假宿主复现那个时序。
		const { agents, state } = makeAgents({ earlyIdle: true, events: [assistantText("extracted")] });

		const outcome = await runNestedSession(makeRequest(), makeDeps(agents));

		// 只 await 一次的实现会返回 no-output（读到的是空日志）—— 这条就是钉那个 bug。
		expect(outcome).toEqual({ status: "completed", text: "extracted" });
		expect(state.disposed).toBe(1);
	});
});

describe("runNestedSession — 只有 agent/error、没有 turn/end", () => {
	it("carries the host error out as not-run/host-refused instead of waiting for a turn that never ends", async () => {
		// 模型层在发出请求之前就失败（provider 挂了 / 路由不可用）时，宿主发的是 `agent/error`，
		// 不会有 `turn/end`。只等 `turn/end` 会一直等到 timeoutMs（extract 120s）—— 那是最糟的
		// 形态：看起来像挂死。所以 `agent/error` 也当收口，并把原因带出去。
		const { agents } = makeAgents({ errorEvent: true });

		const outcome = await runNestedSession(makeRequest({ timeoutMs: 5 }), makeDeps(agents));

		expect(outcome).toEqual({ status: "not-run", cause: "host-refused", detail: "x" });
	});
});
