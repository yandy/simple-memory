import { describe, expect, it } from "vitest";
import { createFakeCtx, createSyntheticMsg, createUserMsg } from "./fake-ctx.js";

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
		(a as any).ctx.tools.register({
			name: "memory",
			description: "memory tool",
			parameters: {},
			output: {},
			execute: async () => ({}),
		});
		expect(agentTools.get("agent-1")).toHaveLength(1);
		expect(agentTools.get("agent-1")![0].name).toBe("memory");
		expect(tools.has("memory")).toBe(false);
	});

	it("根 ctx.tools.register 落到全局 tools", () => {
		const { ctx, tools } = createFakeCtx();
		ctx.tools.register({
			name: "memory",
			description: "memory tool",
			parameters: {},
			output: {},
			execute: async () => ({}),
		});
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

	it("llmError 让 llm.stream 抛带 code 的错", () => {
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

	it("createSyntheticMsg / createUserMsg 设置 source.kind", () => {
		expect(createSyntheticMsg("agent-instructions", "x").source.kind).toBe("agent-instructions");
		expect(createUserMsg("x").source.kind).toBe("user");
	});

	it("makeAgent：subagent 标记同时落在 session.header 上（R2）", () => {
		const { makeAgent } = createFakeCtx();
		const root = makeAgent();
		expect((root.session.header as any).parentSession).toBeUndefined();
		expect((root.session.header as any).delegationDepth).toBeUndefined();
		expect(root.subagent).toBe(false);

		const sub = makeAgent({ subagent: true });
		expect((sub.session.header as any).parentSession).toBe("session-parent-fake");
		expect((sub.session.header as any).delegationDepth).toBe(1);
		expect(sub.subagent).toBe(true);
	});

	it("disposeAll 逆序撤销并清空 sections/tools/agentTools/commands，且幂等", async () => {
		const { agentTools, commands, ctx, disposeAll, emitter, makeAgent, sections, tools } = createFakeCtx();

		ctx.systemPrompt.section({ name: "s1", order: 1, text: "a" });
		ctx.tools.register({ name: "global", description: "d", parameters: {}, output: {}, execute: async () => ({}) });
		ctx.commands.register({ name: "memory", description: "d", handler: async () => ({ kind: "success" }) });

		const a = makeAgent({ id: "agent-1" });
		await emitter.agentCreated(a);
		(a as any).ctx.tools.register({ name: "agent-tool", description: "d", parameters: {}, output: {}, execute: async () => ({}) });

		expect(sections).toHaveLength(1);
		expect(tools.size).toBe(1);
		expect(commands).toHaveLength(1);
		expect(agentTools.get("agent-1")).toHaveLength(1);

		disposeAll();
		expect(sections).toHaveLength(0);
		expect(tools.size).toBe(0);
		expect(commands).toHaveLength(0);
		expect(agentTools.get("agent-1")).toHaveLength(0);

		expect(() => disposeAll()).not.toThrow();
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

	it("sessionQuery.listSessions 支持按 cwd 过滤和 limit", async () => {
		const sessions = [
			{ id: "s1", cwd: "/a", events: [] },
			{ id: "s2", cwd: "/b", events: [] },
			{ id: "s3", cwd: "/a", events: [] },
		];
		const { ctx } = createFakeCtx({ sessions });

		const all = await ctx.sessionQuery.listSessions();
		expect(all.items).toHaveLength(3);

		const aOnly = await ctx.sessionQuery.listSessions({ cwd: "/a" });
		expect(aOnly.items.map((r: any) => r.header.id).sort()).toEqual(["s1", "s3"]);

		const filtered = await ctx.sessionQuery.listSessions({ filters: [{ kind: "cwd", values: ["/a"] }] });
		expect(filtered.items.map((r: any) => r.header.id).sort()).toEqual(["s1", "s3"]);

		const limited = await ctx.sessionQuery.listSessions({ cwd: "/a", limit: 1 });
		expect(limited.items).toHaveLength(1);
		expect(limited.items[0].header.id).toBe("s1");
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
});
