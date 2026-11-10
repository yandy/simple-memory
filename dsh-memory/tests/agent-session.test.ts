import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HeadlessRunRequest } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_IO_TOOL_NAMES, allowedGlobalTools, createSessionWorker } from "../src/agent-session.js";
import type { NestedMemoryToolOptions } from "../src/agent-session.js";

/**
 * worker 端口的两件事：**建会话时**把能力面收窄（setup 只做得到这件事），**每轮**只 followup
 * 并取本次 run 的事件窗口。
 *
 * 「每轮窗口」是这里最重要的回归：worker 的会话日志跨多轮，整段读会把上一轮的回答当成这一轮的。
 */

interface TurnScript {
	steps?: number;
	events?: Array<{ type: string; data?: unknown }>;
	hang?: boolean;
	errorEvent?: boolean;
	idleThrows?: string;
}

interface Script {
	createThrows?: string;
	setupThrows?: string;
	/** 第 N 次 followup 用第 N 项（用完后重复最后一项）。 */
	turns?: TurnScript[];
	globalTools?: string[];
	/** 每次 whenIdle 都立刻 resolve（宿主在驱动登记活动前就会这样，实测 status 也可能是 idle）。 */
	earlyIdle?: boolean;
}

function makeRequest(over: Partial<HeadlessRunRequest> = {}): HeadlessRunRequest {
	return {
		task: "do the thing",
		cwd: "/mem",
		model: "prov/model",
		timeoutMs: 5_000,
		builtinTools: "none",
		memoryTool: { actions: ["add", "replace", "remove", "list", "search"] },
		...over,
	};
}

const assistantText = (text: string) => ({
	type: "assistant/message",
	data: { message: { content: [{ type: "text", text }] } },
});
const turnEnd = (kind = "completed") => ({ type: "turn/end", data: { reason: { kind } } });

function makeAgents(script: Script = {}) {
	const creates: any[] = [];
	const registered: unknown[] = [];
	const restrictions: Array<{ allow?: readonly string[]; deny?: readonly string[] }> = [];
	const cancels: unknown[] = [];
	const messages: unknown[] = [];
	const events: Array<{ type: string; data?: unknown; seq: number }> = [];
	const state = { disposed: 0, stepsRun: 0 };
	const globalTools = script.globalTools ?? [];

	function waterfall(
		entries: Array<(payload: any, next?: () => Promise<any>) => unknown>,
		payload: unknown,
	): Promise<any> {
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
			let turnIndex = 0;

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
					const current = script.turns?.[Math.min(turnIndex, (script.turns?.length ?? 1) - 1)] ?? {};
					turnIndex += 1;
					pending = new Promise<void>((resolve, reject) => {
						setTimeout(() => {
							void runTurn(current).then(resolve, reject);
						}, 0);
					});
				},
				get status(): string {
					return "idle";
				},
				whenIdle(): Promise<void> {
					if (script.earlyIdle === true) return Promise.resolve();
					return pending ?? Promise.resolve();
				},
				cancel(cause: unknown): void {
					cancels.push(cause);
				},
			};

			async function runTurn(turn: TurnScript): Promise<void> {
				for (let step = 1; step <= (turn.steps ?? 1); step++) {
					const decision = await waterfall(preStep, {
						agent: child,
						turn: turnIndex,
						step,
						signal: new AbortController().signal,
					});
					if (decision?.kind === "reject") break;
					state.stepsRun += 1;
				}
				const scripted = turn.events ?? [];
				const closes = scripted.some((event) => event.type === "turn/end");
				const toAppend: Array<{ type: string; data?: unknown }> =
					turn.hang === true || closes || turn.errorEvent === true
						? scripted
						: [...scripted, turnEnd()];
				for (const event of toAppend) {
					const appended = { ...event, seq: events.length };
					events.push(appended);
					for (const listener of sessionListeners) await listener(child.session, appended);
				}
				if (turn.errorEvent === true) {
					for (const listener of errorListeners) await listener({ agent: child, error: new Error("host blew up") });
				}
				if (turn.hang === true) await new Promise<void>(() => {});
				if (turn.idleThrows !== undefined) throw new Error(turn.idleThrows);
			}

			const scope = {
				tools: {
					register(tool: unknown): () => void {
						registered.push(tool);
						return () => {};
					},
					restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void {
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
					if (event === "session/event") {
						sessionListeners.push(handler);
						return () => {};
					}
					if (event === "agent/error") {
						errorListeners.push(handler);
						return () => {};
					}
					throw new Error(`unexpected event "${event}"`);
				},
			};

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

function makeSpec(agents: { create(options: any): Promise<any> }, built: NestedMemoryToolOptions[] = []) {
	return {
		agents,
		cwd: process.env.TEST_MEMORY_DIR as string,
		model: "prov/model",
		effort: "high",
		actions: ["add", "replace", "remove", "list", "search"] as const,
		skipLogicalLock: true,
		skipSnapshot: false,
		maxTurns: 2,
		buildMemoryTool(options: NestedMemoryToolOptions): unknown {
			built.push(options);
			return { name: "memory", marker: "built" };
		},
		warn: () => {},
	};
}

let testDir: string;
beforeEach(async () => {
	testDir = await mkdtemp(join(tmpdir(), "am-worker-"));
	process.env.TEST_MEMORY_DIR = testDir;
});
afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
	delete process.env.TEST_MEMORY_DIR;
});

async function makeWorker(script: Script = {}, built: NestedMemoryToolOptions[] = []) {
	const fake = makeAgents(script);
	const made = await createSessionWorker(makeSpec(fake.agents, built));
	if ("error" in made) throw new Error(`worker creation failed: ${made.error}`);
	return { worker: made, ...fake };
}

describe("createSessionWorker — 建会话", () => {
	it("creates a subagent session at the requested cwd with provider/model/effort", async () => {
		const { creates } = await makeWorker();
		const [options] = creates;
		expect(options.sessionId).toMatch(/^session-/);
		expect(options.meta).toEqual({ cwd: testDir, origin: "subagent", delegationDepth: 1 });
		expect(options.agentOptions).toEqual({ provider: "prov", model: "model", reasoningEffort: "high" });
	});

	it("parses only the first slash so a model id may contain slashes", async () => {
		const fake = makeAgents();
		await createSessionWorker({ ...makeSpec(fake.agents), model: "megcore/qwen/qwen3.8-max" });
		expect(fake.creates[0].agentOptions).toEqual({ provider: "megcore", model: "qwen/qwen3.8-max", reasoningEffort: "high" });
	});

	it("rejects a model ref without a provider, without creating anything", async () => {
		const fake = makeAgents();
		const made = await createSessionWorker({ ...makeSpec(fake.agents), model: "deepseek-flash" });
		expect("error" in made && made.error).toContain("<provider>/<model>");
		expect(fake.creates).toEqual([]);
	});

	it("creates the memory directory when it does not exist yet", async () => {
		// 全新项目里第一次抽取时记忆目录还不存在，而宿主会校验子会话的 cwd（真机上表现为
		// `turn/end error: working-directory: directory does not exist`）。
		const missing = join(testDir, "fresh", "local", "proj");
		const fake = makeAgents();
		const made = await createSessionWorker({ ...makeSpec(fake.agents), cwd: missing });
		expect("error" in made).toBe(false);
		await expect(stat(missing)).resolves.toBeTruthy();
	});

	it("reports a creation failure instead of throwing", async () => {
		const made = await createSessionWorker(makeSpec(makeAgents({ createThrows: "no factory registered" }).agents));
		expect("error" in made && made.error).toBe("no factory registered");
	});

	it("registers the memory tool with this task's actions and both skip flags", async () => {
		const built: NestedMemoryToolOptions[] = [];
		const { registered, restrictions } = await makeWorker({}, built);

		expect(registered).toHaveLength(1);
		expect(built[0]).toMatchObject({ actions: ["add", "replace", "remove", "list", "search"], skipLogicalLock: true, skipSnapshot: false });
		// 子会话唯一的工具是作用域里的 memory：全局工具被 restrict 全部关掉。
		expect(restrictions).toEqual([{ allow: [] }]);
	});
});

describe("allowedGlobalTools", () => {
	it("hides every global tool for the builtinTools the three core tasks actually use", () => {
		const scope = { tools: { definitions: () => [{ name: "read" }] } } as never;
		expect(allowedGlobalTools(scope, "none")).toEqual([]);
	});

	it("allows only file tools this deployment registers for file-io, never shell tools", () => {
		const scope = { tools: { definitions: () => [{ name: "read" }, { name: "bash" }, { name: "glob" }] } } as never;
		expect(allowedGlobalTools(scope, "file-io")).toEqual(["read", "glob"]);
		expect(FILE_IO_TOOL_NAMES).not.toContain("bash");
	});
});

describe("worker.run — 结果词汇", () => {
	it("returns the last non-empty assistant message of this turn", async () => {
		const { worker } = await makeWorker({ turns: [{ events: [assistantText("first"), assistantText("second"), assistantText(""), turnEnd()] }] });
		expect(await worker.run(makeRequest())).toEqual({ status: "completed", text: "second" });
	});

	it("聚焦本次 run 的事件窗口，上一轮的回答不会漏进这一轮", async () => {
		// worker 的会话日志跨多轮：整段读会把第 1 轮的回答当成第 2 轮的结果。
		const { worker } = await makeWorker({
			turns: [
				{ events: [assistantText("turn one"), turnEnd()] },
				{ events: [assistantText("turn two"), turnEnd()] },
			],
		});
		expect(await worker.run(makeRequest())).toEqual({ status: "completed", text: "turn one" });
		expect(await worker.run(makeRequest())).toEqual({ status: "completed", text: "turn two" });
	});

	it("joins text blocks and drops reasoning", async () => {
		const { worker } = await makeWorker({
			turns: [
				{
					events: [
						{
							type: "assistant/message",
							data: { message: { content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "a" }, { type: "text", text: "b" }] } },
						},
						turnEnd(),
					],
				},
			],
		});
		expect(await worker.run(makeRequest())).toEqual({ status: "completed", text: "ab" });
	});

	it("reports no-output when the turn produced no assistant text", async () => {
		const { worker } = await makeWorker({ turns: [{ events: [turnEnd()] }] });
		expect(await worker.run(makeRequest())).toEqual({ status: "no-output" });
	});

	it("maps turn/end error to not-run/host-refused with code and message", async () => {
		const { worker } = await makeWorker({
			turns: [{ events: [{ type: "turn/end", data: { reason: { kind: "error", error: { code: "MODEL_UNAVAILABLE", message: "no such model" } } } }] }],
		});
		expect(await worker.run(makeRequest())).toEqual({ status: "not-run", cause: "host-refused", detail: "MODEL_UNAVAILABLE: no such model" });
	});

	it("maps turn/end aborted and max-tokens to incomplete", async () => {
		const aborted = await makeWorker({ turns: [{ events: [turnEnd("aborted")] }] });
		expect(await aborted.worker.run(makeRequest())).toEqual({ status: "incomplete", cause: "aborted" });

		const maxTokens = await makeWorker({ turns: [{ events: [turnEnd("max-tokens")] }] });
		expect(await maxTokens.worker.run(makeRequest())).toEqual({ status: "incomplete", cause: "max-tokens" });
	});

	it("reports host-refused when the host emits agent/error without a turn/end", async () => {
		const { worker } = await makeWorker({ turns: [{ errorEvent: true }] });
		expect(await worker.run(makeRequest({ timeoutMs: 50 }))).toEqual({ status: "not-run", cause: "host-refused", detail: "host blew up" });
	});

	it("reports host-refused when the driver throws, and does not dispose the worker", async () => {
		const { worker, state } = await makeWorker({ turns: [{ idleThrows: "adapter exploded" }] });
		expect(await worker.run(makeRequest())).toEqual({ status: "not-run", cause: "host-refused", detail: "adapter exploded" });
		// worker 是常驻的：一次失败不该把它拆掉（下一轮还要用）。
		expect(state.disposed).toBe(0);
	});

	it("returns aborted without touching the session when the caller already cancelled", async () => {
		const { worker, messages } = await makeWorker();
		const controller = new AbortController();
		controller.abort();
		expect(await worker.run(makeRequest({ signal: controller.signal }))).toEqual({ status: "not-run", cause: "aborted" });
		expect(messages).toEqual([]);
	});

	it("enforces maxTurns as a best-effort step cap", async () => {
		const { worker, state } = await makeWorker({ turns: [{ steps: 4, events: [assistantText("partial")] }] });
		expect(await worker.run(makeRequest())).toEqual({ status: "incomplete", cause: "turn-limit" });
		expect(state.stepsRun).toBe(2);
	});

	it("interrupts a hanging turn on timeout, cancels it, and reports incomplete", async () => {
		const { worker, cancels } = await makeWorker({ turns: [{ hang: true, events: [assistantText("half")] }] });
		expect(await worker.run(makeRequest({ timeoutMs: 20 }))).toEqual({ status: "incomplete", cause: "aborted" });
		expect(cancels).toHaveLength(1);
	});

	it("disposes the worker on demand", async () => {
		const { worker, state } = await makeWorker();
		await worker.dispose();
		expect(state.disposed).toBe(1);
	});
});
