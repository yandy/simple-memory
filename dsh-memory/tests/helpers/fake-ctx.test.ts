import { describe, expect, it } from "vitest";
import { createFakeCtx, createSyntheticMsg, createUserMsg } from "./fake-ctx.js";

function validTool(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "memory",
		description: "memory tool",
		parameters: {},
		output: { schema: { type: "object" }, render: () => [{ type: "text", text: "" }] },
		execute: async () => ({}),
		...over,
	};
}

describe("fake cordis ctx", () => {
	it("section() 记录进 sections 并返回可调用的 disposer", () => {
		const { ctx, sections } = createFakeCtx();
		const disposer = ctx.systemPrompt.section({ name: "memory:index", order: 4000, text: "index" });
		expect(sections).toHaveLength(1);
		expect(sections[0].name).toBe("memory:index");
		expect(sections[0].order).toBe(4000);
		expect(typeof disposer).toBe("function");
		disposer();
		expect(sections).toHaveLength(0);
	});

	it("agent.ctx.tools.register 落到 agentTools，不进全局 tools", async () => {
		const { agentTools, emitter, makeAgent, tools } = createFakeCtx();
		const a = makeAgent({ id: "agent-1" });
		await emitter.agentCreated(a);
		(a as any).ctx.tools.register(validTool());
		expect(agentTools.get("agent-1")).toHaveLength(1);
		expect(agentTools.get("agent-1")![0].name).toBe("memory");
		expect(tools.has("memory")).toBe(false);
	});

	it("根 ctx.tools.register 落到全局 tools", () => {
		const { ctx, tools } = createFakeCtx();
		ctx.tools.register(validTool());
		expect(tools.get("memory")?.name).toBe("memory");
	});

	it("preStep 无监听器时原样返回 { kind: 'enter', messages }", async () => {
		const { emitter, makeAgent } = createFakeCtx();
		const agent = makeAgent();
		const messages = [createUserMsg("hi")];
		const decision = await emitter.preStep({
			agent,
			messages,
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});
		expect(decision).toEqual({ kind: "enter", messages });
	});

	it("pre-step waterfall：第二个 { prepend: true } 先跑且其返回值胜出", async () => {
		const { ctx, emitter, makeAgent } = createFakeCtx();
		const agent = makeAgent();
		const callOrder: string[] = [];

		ctx.on("agent/pre-step", async (_p: any, next: () => Promise<any>) => {
			callOrder.push("first");
			const d = await next();
			return { ...d, messages: [...d.messages, createUserMsg("from-first")] };
		});
		ctx.on(
			"agent/pre-step",
			async (_p: any, next: () => Promise<any>) => {
				callOrder.push("second");
				const d = await next();
				return { ...d, messages: [...d.messages, createUserMsg("from-second")] };
			},
			{ prepend: true },
		);

		const decision = await emitter.preStep({
			agent,
			messages: [createUserMsg("base")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(callOrder).toEqual(["second", "first"]);
		// prepend（second）在最外层：先进入，最后看到 decision，其返回值胜出 → 它追加的消息在最后。
		const last = decision.messages[decision.messages.length - 1];
		expect(last.content[0].text).toBe("from-second");
	});

	it("waterfall：next() 调用两次抛 'next() called multiple times'", async () => {
		const { ctx, emitter, makeAgent } = createFakeCtx();
		const agent = makeAgent();
		ctx.on("agent/pre-step", async (_p: any, next: () => Promise<any>) => {
			await next();
			await next();
		});
		await expect(
			emitter.preStep({ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }),
		).rejects.toThrow("next() called multiple times");
	});

	it("llmError 让 llm.stream 抛带 code 的错（middleware/consumer 失败通道）", () => {
		const { ctx } = createFakeCtx({ llmError: { code: "NO_ADAPTER", message: "no adapter" } });
		let thrown: any;
		try {
			ctx.llm.stream({ provider: "x", model: "y", messages: [] });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeTruthy();
		expect(thrown.code).toBe("NO_ADAPTER");
		expect(thrown.message).toBe("no adapter");
	});

	it("llmStreamFailure 让 llm.stream yield 终止 error finish chunk（adapter 失败通道）", async () => {
		const { ctx } = createFakeCtx({ llmStreamFailure: { code: "NO_ADAPTER", message: "no adapter" } });
		const chunks: unknown[] = [];
		for await (const c of ctx.llm.stream({})) chunks.push(c);
		expect(chunks).toEqual([
			{ type: "finish", reason: { kind: "error", failure: { code: "NO_ADAPTER", message: "no adapter" } } },
		]);
	});

	it("llmStreamAborted 让 llm.stream yield 终止 aborted finish chunk", async () => {
		const { ctx } = createFakeCtx({ llmStreamAborted: true });
		const chunks: unknown[] = [];
		for await (const c of ctx.llm.stream({})) chunks.push(c);
		expect(chunks).toEqual([{ type: "finish", reason: { kind: "aborted" } }]);
	});

	it("llmStream 可产出文本块 + 成功 stop finish", async () => {
		const { ctx } = createFakeCtx({
			llmStream: async function* () {
				yield { type: "text-delta", index: 0, text: "hi" };
				yield { type: "finish", reason: { kind: "stop" } };
			},
		});
		const chunks: unknown[] = [];
		for await (const c of ctx.llm.stream({})) chunks.push(c);
		expect(chunks).toHaveLength(2);
		expect((chunks[0] as any).text).toBe("hi");
		expect((chunks[1] as any).reason.kind).toBe("stop");
	});

	it("createSyntheticMsg / createUserMsg 设置 source.kind", () => {
		expect(createSyntheticMsg("agent-instructions", "x").source.kind).toBe("agent-instructions");
		expect(createUserMsg("x").source.kind).toBe("user");
	});

	it("makeAgent：root / subagent / fork 三种 header（R2 + R10）", () => {
		const { makeAgent } = createFakeCtx();

		const root = makeAgent();
		expect((root.session.header as any).parentSession).toBeUndefined();
		expect((root.session.header as any).origin).toBeUndefined();
		expect((root.session.header as any).delegationDepth).toBeUndefined();
		expect(root.subagent).toBe(false);

		const sub = makeAgent({ subagent: true });
		expect((sub.session.header as any).parentSession).toBe("session-parent-fake");
		expect((sub.session.header as any).origin).toBe("subagent");
		expect((sub.session.header as any).delegationDepth).toBe(1);
		expect(sub.subagent).toBe(true);

		// 普通 fork：只带 parentSession，不带 origin/delegationDepth —— Task 9 必须判为根 agent。
		const fork = makeAgent({ fork: true });
		expect((fork.session.header as any).parentSession).toBe("session-parent-fake");
		expect((fork.session.header as any).origin).toBeUndefined();
		expect((fork.session.header as any).delegationDepth).toBeUndefined();
		expect(fork.subagent).toBe(false);
	});

	it("tools.register 拒绝缺 output / output.schema / output.render 的定义", () => {
		const { ctx } = createFakeCtx();
		const base = { name: "memory", description: "d", parameters: {}, execute: async () => ({}) };
		expect(() => ctx.tools.register({ ...base })).toThrow(TypeError);
		expect(() => ctx.tools.register({ ...base, output: {} })).toThrow(TypeError);
		expect(() => ctx.tools.register({ ...base, output: { schema: { type: "object" } } })).toThrow(TypeError);
		expect(() => ctx.tools.register({ ...base, output: { schema: { type: "object" }, render: "not-a-fn" } })).toThrow(
			TypeError,
		);
		expect(() => ctx.tools.register({ ...base, output: { schema: { type: "object" }, render: () => [] } })).not.toThrow();
	});

	it("同层重名注册抛错；agent 作用域可合法遮蔽全局", async () => {
		const { ctx, emitter, makeAgent } = createFakeCtx();

		ctx.systemPrompt.section({ name: "s", order: 1, text: "a" });
		expect(() => ctx.systemPrompt.section({ name: "s", order: 2, text: "b" })).toThrow(/already registered/);

		ctx.systemPrompt.context({ name: "c", order: 1, text: "a" });
		expect(() => ctx.systemPrompt.context({ name: "c", order: 2, text: "b" })).toThrow(/already registered/);

		ctx.tools.register(validTool());
		expect(() => ctx.tools.register(validTool())).toThrow(/already registered/);

		ctx.commands.register({ name: "memory", description: "d", handler: async () => ({ kind: "success" }) });
		expect(() =>
			ctx.commands.register({ name: "memory", description: "d2", handler: async () => ({ kind: "success" }) }),
		).toThrow(/already registered/);

		// agent 作用域与全局分层：全局已注册 "memory"，agent 作用域仍可注册同名词。
		const a = makeAgent({ id: "agent-1" });
		await emitter.agentCreated(a);
		expect(() => (a as any).ctx.tools.register(validTool())).not.toThrow();
		// 但 agent 作用域内重名仍然抛错。
		expect(() => (a as any).ctx.tools.register(validTool())).toThrow(/already registered/);
	});

	it("disposeAll 逆序撤销 section→tool→effect→command，且幂等", () => {
		const callOrder: string[] = [];
		const { ctx, commands, disposeAll, sections, tools } = createFakeCtx({
			onDispose: (kind) => callOrder.push(kind),
		});

		ctx.systemPrompt.section({ name: "s1", order: 1, text: "a" });
		ctx.tools.register(validTool({ name: "tool-1" }));
		ctx.effect(() => () => callOrder.push("effect"), "memory.init");
		ctx.commands.register({ name: "memory", description: "d", handler: async () => ({ kind: "success" }) });

		expect(sections).toHaveLength(1);
		expect(tools.size).toBe(1);
		expect(commands).toHaveLength(1);

		disposeAll();
		expect(callOrder).toEqual(["command", "effect", "tool", "section"]);
		expect(sections).toHaveLength(0);
		expect(tools.size).toBe(0);
		expect(commands).toHaveLength(0);

		// 幂等：第二次 disposeAll 不改变 callOrder（每个 disposer 只跑一次）。
		disposeAll();
		expect(callOrder).toEqual(["command", "effect", "tool", "section"]);
	});

	it("disposeAll 撤销 agent.ctx.tools 的注册", async () => {
		const { agentTools, disposeAll, emitter, makeAgent } = createFakeCtx();
		const a = makeAgent({ id: "agent-1" });
		await emitter.agentCreated(a);
		(a as any).ctx.tools.register(validTool());
		expect(agentTools.get("agent-1")).toHaveLength(1);
		disposeAll();
		expect(agentTools.get("agent-1")).toHaveLength(0);
	});

	it("ctx.effect 立即执行回调并记录 label", () => {
		const { ctx, effects } = createFakeCtx();
		let ran = false;
		ctx.effect(() => {
			ran = true;
			return () => {};
		}, "memory.init");
		expect(ran).toBe(true);
		expect(effects).toEqual([{ label: "memory.init" }]);
	});

	it("llm.resolveCallConfig 默认 resolve，llmError 时 reject 带 code", async () => {
		const ok = createFakeCtx();
		await expect(ok.ctx.llm.resolveCallConfig({ provider: "x", model: "y" })).resolves.toEqual({
			provider: "x",
			model: "y",
		});

		const bad = createFakeCtx({ llmError: { code: "AUTH", message: "bad" } });
		await expect(bad.ctx.llm.resolveCallConfig({ provider: "x", model: "y" })).rejects.toMatchObject({ code: "AUTH" });
	});

	it("sessionQuery.listSessions 返回裸数组 newest-first，filterSessions 按 cwd 过滤", async () => {
		const sessions = [
			{ id: "old", cwd: "/a", events: [], createdAt: 1000 },
			{ id: "new", cwd: "/b", events: [], createdAt: 3000 },
			{ id: "mid", cwd: "/a", events: [], createdAt: 2000 },
		];
		const { ctx } = createFakeCtx({ sessions });

		const all = await ctx.sessionQuery.listSessions();
		expect(Array.isArray(all)).toBe(true);
		expect(all.map((r: any) => r.header.id)).toEqual(["new", "mid", "old"]);
		expect(all[0].live).toBe(true);
		expect(all[0].persisted).toBe(true);
		expect(typeof all[0].header.createdAt).toBe("number");

		// 只接受 AbortSignal；传入后仍返回裸数组。
		const withSignal = await ctx.sessionQuery.listSessions(new AbortController().signal);
		expect(withSignal.map((r: any) => r.header.id)).toEqual(["new", "mid", "old"]);

		const aOnly = await ctx.sessionQuery.filterSessions([{ kind: "cwd", values: ["/a"] }]);
		expect(aOnly.map((r: any) => r.header.id)).toEqual(["mid", "old"]);
	});

	it("sessionQuery.listSessions 无 createdAt 时保持 fixture 顺序", async () => {
		const { ctx } = createFakeCtx({
			sessions: [
				{ id: "s1", cwd: "/a", events: [] },
				{ id: "s2", cwd: "/b", events: [] },
				{ id: "s3", cwd: "/a", events: [] },
			],
		});
		const all = await ctx.sessionQuery.listSessions();
		expect(all.map((r: any) => r.header.id)).toEqual(["s1", "s2", "s3"]);
	});

	it("sessionQuery.readSession 返回 session / inheritedEventCount / events", async () => {
		const { ctx } = createFakeCtx({
			sessions: [{ id: "s1", cwd: "/a", events: [{ type: "user/message", data: { text: "hi" } }] }],
		});
		const snap = await ctx.sessionQuery.readSession("s1");
		expect(snap.session.id).toBe("s1");
		expect(snap.inheritedEventCount).toBe(0);
		expect(snap.events).toHaveLength(1);
		expect(snap.events[0].type).toBe("user/message");
	});

	it("agent/created 串行 await，监听器抛出则创建失败", async () => {
		const { ctx, emitter, makeAgent } = createFakeCtx();
		const order: string[] = [];
		ctx.on("agent/created", async () => {
			order.push("a");
		});
		ctx.on("agent/created", async () => {
			order.push("b");
			throw new Error("boom");
		});
		const a = makeAgent();
		await expect(emitter.agentCreated(a)).rejects.toThrow("boom");
		expect(order).toEqual(["a", "b"]);
	});

	it("agent/disposed 监听器收到 { agent } 负载", () => {
		const { ctx, emitter, makeAgent } = createFakeCtx();
		const agent = makeAgent({ id: "agent-x" });
		let payload: any;
		ctx.on("agent/disposed", (p: any) => {
			payload = p;
		});
		emitter.agentDisposed(agent);
		expect(payload).toEqual({ agent });
	});
});
