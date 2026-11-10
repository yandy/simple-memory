import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildIndexSection,
	DEFAULT_CONFIG,
	MEMORY_TOOL_GUIDELINES,
	MEMORY_TOOL_SNIPPET,
	MemoryStore,
	mergeConfig,
	projectDirName,
} from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply, inject, name } from "../src/index.js";
import { createFakeCtx, createUserMsg } from "./helpers/fake-ctx.js";
import type { FakeCtxOptions } from "./helpers/fake-ctx.js";

/** 测试级临时目录总根：记忆根与项目目录都建在它下面，`afterEach` 一次 `rm -rf` 全清。 */
let dir: string;
/** 行 config 里的记忆总根（**绝不**用 `defaultMemoryRoot()`：那会写进用户家目录）。 */
let root: string;
/** 会话的项目目录：普通非 git 临时目录，`resolveMemoryDir` 会落到 `<root>/local/<escaped>`。 */
let cwd: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-asm-"));
	// 与 store-registry.test.ts 同一套 hermetic git 手法：绝不读机器的 global/system config。
	const emptyGitConfig = join(dir, "gitconfig-empty");
	await writeFile(emptyGitConfig, "", "utf8");
	vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	root = join(dir, "mem-root");
	cwd = join(dir, "proj");
	await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

type Fake = ReturnType<typeof createFakeCtx>;

/** `resolveMemoryDir` 对普通目录的结果：`<root>/local/<escaped cwd>`（与 store-registry 测试同式）。 */
function memoryDirFor(projectDir: string): string {
	return join(resolve(root), "local", projectDirName(resolve(projectDir)));
}

/** 行 config：只覆盖 `memoryDir`，其余走 core 默认值。 */
function rowConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { memoryDir: root, ...over };
}

/** 先在磁盘上放一条 entry：新目录的 `MEMORY.md` 不存在，索引快照会是空串。 */
async function seedEntry(memoryDir: string, entryName: string, description: string, body?: string): Promise<void> {
	await mkdir(memoryDir, { recursive: true });
	const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir });
	const store = new MemoryStore({
		memoryDir,
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	});
	await store.addEntry({ name: entryName, description, body: body ?? `body of ${entryName}` });
}

/** core 对同一份 memoryDir 会注入的索引正文（与 registry 的 store 同一套配置窗口，字节逐字一致）。 */
async function expectedIndexBody(memoryDir: string): Promise<string> {
	const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir });
	const store = new MemoryStore({
		memoryDir,
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	});
	return buildIndexSection(store, cfg.memIndexInjectMaxLines, cfg.memIndexInjectMaxBytes);
}

/**
 * `memory_index` section 的静态前缀期望值：snippet → guidelines，空行分隔。
 *
 * 刻意在测试里重新拼一遍（而不是从 src 导入一个现成常量）：两边同时变就丢了钉子的意义。
 * guidelines 是字符串数组，渲染成 `- <rule>` 逐行 —— 与 pi 宿主对 `promptGuidelines` 的渲染同式。
 */
const EXPECTED_PREAMBLE = `${MEMORY_TOOL_SNIPPET}\n\n${MEMORY_TOOL_GUIDELINES.map((rule) => `- ${rule}`).join("\n")}`;

/** 跑一次 `apply`：宿主的一次插件激活。 */
async function setup(
	opts: FakeCtxOptions = {},
	config: unknown = rowConfig(),
): Promise<{ fake: Fake; dispose: () => void }> {
	const fake = createFakeCtx(opts);
	const dispose = await apply(fake.ctx, config);
	return { fake, dispose };
}

function sectionText(fake: Fake): (context: unknown) => string {
	expect(fake.sections).toHaveLength(1);
	return fake.sections[0].text as (context: unknown) => string;
}

function memoryToolOf(fake: Fake, agentId: string) {
	return (fake.agentTools.get(agentId) ?? []).find((tool) => tool.name === "memory");
}

function runMemoryCommand(fake: Fake, agent: unknown, rawInput = "") {
	expect(fake.commands).toHaveLength(2);
	// 按名字取：`apply` 现在同时注册 `/memory` 与 `/dream`，顺序不是契约。
	const command = fake.commands.find((candidate) => candidate.name === "memory");
	expect(command).toBeDefined();
	return command?.handler({ agent, rawInput, signal: new AbortController().signal });
}

/** 宿主 `agent/pre-step` waterfall 的裁决（fake ctx 里的形状）。 */
type Decision = { kind: "reject" } | { kind: "enter"; messages: any[] };

/** 侧查询回复：宿主 chunk 词汇里的一条纯文本流（block-start → text-delta → block-end → finish）。 */
function llmStreamReplying(text: string): FakeCtxOptions["llmStream"] {
	return () => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "block-start", index: 0, blockType: "text" };
			yield { type: "text-delta", index: 0, text };
			yield { type: "block-end", index: 0, block: { type: "text", text } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	});
}

/**
 * 索引快照的刷新是 fire-and-forget（core 的 `onWrite` 是同步回调，宿主的 section `text` 必须同步），
 * 所以「写入后 section 里出现新索引行」只能轮询等待，不能同步断言。
 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the index snapshot to refresh");
		await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
	}
}

describe("apply — 全局注册（每进程一次）", () => {
	it("registers the memory_index section at order 4000 with interpolation off", async () => {
		const { fake } = await setup();

		expect(fake.sections).toHaveLength(1);
		const [section] = fake.sections;
		expect(section.name).toBe("memory_index");
		// 宿主 SECTION_ORDERS 里 4000 未被占用（TOOL_COMPUTER_USE 3000 / MCP_SERVERS 3100 … TOOLS_SDK 5000）。
		expect(section.order).toBe(4000);
		// 硬要求：记忆正文是用户/模型写的，可能含 `{{`，宿主渲染器遇到它会抛错。
		expect(section.interpolate).toBe(false);
		expect(typeof section.text).toBe("function");
	});

	it("registers the /memory and /dream commands once", async () => {
		const { fake } = await setup();

		expect(fake.commands.map((command) => command.name)).toEqual(["memory", "dream"]);
		for (const command of fake.commands) expect(command.description.length).toBeGreaterThan(0);
	});

	it("returns \"\" from the section text for an agent that was never prepared, and for no agent at all", async () => {
		const { fake } = await setup();
		const text = sectionText(fake);
		const stranger = fake.makeAgent({ id: "never-prepared", cwd });

		// 不许抛错、不许返回 undefined：一次读盘失败绝不能让整个 system prompt 装配失败。
		expect(text({ agent: stranger })).toBe("");
		// 宿主 `assemble(context = {})` 的诊断路径没有 agent。
		expect(text({})).toBe("");

		// 子 agent 也不该拿到索引（它根本没被 prepare）。
		const sub = fake.makeAgent({ id: "sub-1", subagent: true, cwd });
		await fake.emitter.agentCreated(sub);
		expect(text({ agent: sub })).toBe("");
	});

	it("declares inject verbatim, listing every service the bundle uses", () => {
		// 逐个列全是刻意的：缺任一服务的 profile 里插件保持 inactive（fiber pending）而不是激活时抛错。
		expect([...inject]).toEqual([
			"tools",
			"systemPrompt",
			"llm",
			"agents",
			"commands",
			"workingDirectory",
			"sessionQuery",
			"logger",
		]);
		expect(name).toBe("simple-memory");
	});
});

describe("apply — per-agent 生命周期", () => {
	it("registers the memory tool on the agent context, not globally, inside its own effect", async () => {
		const { fake } = await setup();
		const agent = fake.makeAgent({ id: "s1", cwd });

		await fake.emitter.agentCreated(agent);

		expect((fake.agentTools.get("s1") ?? []).map((tool) => tool.name)).toEqual(["memory"]);
		// 全局层绝不该有它：全局工具对子 agent 也可见，那正是门禁要挡的。
		expect(fake.tools.has("memory")).toBe(false);
		// practices.md 规则 2 的双 owner：agent.ctx 上的注册也要挂进我们自己的 effect。
		expect(fake.effects.some((effect) => effect.label === "memory/agent")).toBe(true);
	});

	it("skips subagents entirely: no tool registration and no workingDirectory.ensure call", async () => {
		const fake = createFakeCtx();
		const ensure = vi.spyOn(fake.ctx.workingDirectory, "ensure");
		await apply(fake.ctx, rowConfig());

		const sub = fake.makeAgent({ id: "sub-1", subagent: true, cwd });
		await fake.emitter.agentCreated(sub);

		expect(fake.agentTools.get("sub-1") ?? []).toEqual([]);
		// 不只是「没挂工具」：连目录解析（= 一次 git 探测 + 建 store）都不该发生。
		expect(ensure).not.toHaveBeenCalled();

		// 根 agent 照常解析：门禁只挡子 agent。
		const rootAgent = fake.makeAgent({ id: "root-1", cwd });
		await fake.emitter.agentCreated(rootAgent);
		expect(ensure).toHaveBeenCalledTimes(1);
		expect((fake.agentTools.get("root-1") ?? []).map((tool) => tool.name)).toEqual(["memory"]);

		// 普通 fork 带 parentSession 但不是子 agent（宿主明文：parentSession 不足以判定）。
		const forked = fake.makeAgent({ id: "fork-1", fork: true, cwd });
		await fake.emitter.agentCreated(forked);
		expect((fake.agentTools.get("fork-1") ?? []).map((tool) => tool.name)).toEqual(["memory"]);
		expect(ensure).toHaveBeenCalledTimes(2);
	});

	it("wires the whole chain: agent/created → section text → tool write → refreshed index", async () => {
		const memoryDir = memoryDirFor(cwd);
		await seedEntry(memoryDir, "Alpha", "first note");
		const { fake } = await setup();
		const agent = fake.makeAgent({ id: "s1", cwd });

		await fake.emitter.agentCreated(agent);

		const text = sectionText(fake);
		// agent/created 是唯一的异步窗口：目录解析与首次索引快照都在那里 await 完。
		expect(text({ agent })).not.toBe("");
		expect(text({ agent })).toContain("Alpha");

		const tool = memoryToolOf(fake, "s1");
		expect(tool).toBeDefined();
		const result = await tool?.execute(
			{ action: "add", name: "N", content: "C" },
			{ signal: new AbortController().signal },
		);
		expect(result).toEqual({ content: 'Saved "N" (N.md).' });
		expect(existsSync(join(memoryDir, "N.md"))).toBe(true);

		// 写入后的索引刷新走 core 的 onWrite 回调（fire-and-forget），所以轮询等待。
		await waitFor(() => text({ agent }).includes("[N](N.md)"));
		expect(text({ agent })).toContain("Alpha");
		expect(text({ agent })).toContain("[N](N.md)");
	});

	it("reads each agent's own index snapshot in the section text", async () => {
		const otherCwd = join(dir, "other-proj");
		await mkdir(otherCwd, { recursive: true });
		await seedEntry(memoryDirFor(cwd), "Alpha", "in the first project");
		await seedEntry(memoryDirFor(otherCwd), "Beta", "in the second project");
		const { fake } = await setup();
		const first = fake.makeAgent({ id: "s1", cwd });
		const second = fake.makeAgent({ id: "s2", cwd: otherCwd });

		await fake.emitter.agentCreated(first);
		await fake.emitter.agentCreated(second);

		// text 回调按 context.agent 的会话查快照：搞成一份全局快照的话两个会话会互相污染。
		const text = sectionText(fake);
		expect(text({ agent: first })).toContain("Alpha");
		expect(text({ agent: first })).not.toContain("Beta");
		expect(text({ agent: second })).toContain("Beta");
		expect(text({ agent: second })).not.toContain("Alpha");
	});

	it("surfaces row-config warnings through /memory", async () => {
		const { fake } = await setup({}, rowConfig({ bogus: 1 }));
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const result = await runMemoryCommand(fake, agent);

		expect(result.kind).toBe("success");
		expect(result.text).toContain(`Dir: ${memoryDirFor(cwd)}`);
		// Task 15 的状态块与装配串起来：行 config 的警告只有这一条出口。
		expect(result.text).toContain("Config: 1 warning(s)");
		expect(result.text).toContain('unknown config key "bogus" — ignored');
	});

	it("reports dream and extractMemories as implemented modules in /memory", async () => {
		// 本轮三个任务全部实现：配了 `dream` / `extractMemories` 的用户看到的应该是真实开关与
		// 生效模型，而不是（旧行为的）「配了但本适配层不跑」。
		const { fake } = await setup(
			{},
			rowConfig({ dream: { model: "prov/dream" }, extractMemories: { enabled: true } }),
		);
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const result = await runMemoryCommand(fake, agent);

		expect(result.kind).toBe("success");
		expect(result.text).toContain("dream=on(prov/dream)");
		// `extractMemories` 没配 model，也没配 `defaults.model`：开着的模块必须把这件事说出来。
		expect(result.text).toContain("extractMemories=on(no model)");
		expect(result.text).not.toContain("not implemented");
		// 它们没配错，所以不该额外产生告警。
		expect(result.text).not.toContain("Config:");

		// 没写它们的用户也看得到模块行（三个任务都实现了，不再是噪声）：默认 extractMemories 关着。
		const quiet = createFakeCtx();
		await apply(quiet.ctx, rowConfig());
		const quietAgent = quiet.makeAgent({ id: "s2", cwd });
		await quiet.emitter.agentCreated(quietAgent);
		const quietResult = await runMemoryCommand(quiet, quietAgent);
		expect(quietResult.text).toContain("dream=on(no model), extractMemories=off");
		expect(quietResult.text).not.toContain("not implemented in this adapter");
	});

	it("degrades instead of failing when the row config is not an object (D13)", async () => {
		const { fake } = await setup({}, "nope");

		// 配置坏了不等于插件坏了：section 与命令照常注册，用户才看得见原因。
		expect(fake.sections.map((section) => section.name)).toEqual(["memory_index"]);
		expect(fake.commands.map((command) => command.name)).toEqual(["memory", "dream"]);

		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const tool = memoryToolOf(fake, "s1");
		expect(tool).toBeDefined();
		await expect(tool?.execute({ action: "list" }, {})).rejects.toThrowError(/must be an object/);

		const text = sectionText(fake);
		// 错误态（store === null）仍要有工具文案：降级而不失败，工具仍然注册。
		// 索引正文为空，所以 section 只有 snippet + guidelines。
		expect(text({ agent })).toBe(EXPECTED_PREAMBLE);

		const status = await runMemoryCommand(fake, agent);
		expect(status.text).toContain("Memory: misconfigured");
		expect(status.text).toContain("must be an object");

		// 错误态也要进日志：宿主 UI 里 /memory 之外的唯一线索。
		expect(fake.logs.some((log) => log.level === "warn" && log.message.includes("must be an object"))).toBe(true);
	});

	it("unwinds registrations through the fiber and forgets per-session state on agent/disposed", async () => {
		const memoryDir = memoryDirFor(cwd);
		await seedEntry(memoryDir, "Alpha", "first note");
		const { fake, dispose } = await setup();
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);
		const text = sectionText(fake);
		expect(text({ agent })).toContain("Alpha");

		// agent/disposed：工具撤下 + registry / indexCache / injected 里的该 session 全部忘掉。
		fake.emitter.agentDisposed(agent);
		expect(fake.agentTools.get("s1") ?? []).toEqual([]);
		expect(text({ agent })).toBe("");
		// registry.get(sessionId) 是内部状态，可观察的证据是 /memory 报「没有运行时」。
		const afterDispose = await runMemoryCommand(fake, agent);
		expect(afterDispose.text).toContain("not initialized");

		// R7：`apply` 返回的 disposer 只拥有 apply 自己创建的东西（per-session 状态）；
		// 宿主注册归 fiber（宿主的 register() 内部就是 ctx.fiber.effect(...)），随 fiber 撤销。
		expect(typeof dispose).toBe("function");
		dispose();
		expect(fake.sections).toHaveLength(1);
		expect(fake.commands).toHaveLength(2);

		fake.disposeAll();
		expect(fake.sections).toEqual([]);
		expect(fake.commands).toEqual([]);
		expect(fake.agentTools.get("s1") ?? []).toEqual([]);

		// 监听器也随 fiber 撤销了：新 agent 不再挂工具，pre-step 不再被我们改写。
		const later = fake.makeAgent({ id: "s2", cwd });
		await fake.emitter.agentCreated(later);
		expect(fake.agentTools.get("s2") ?? []).toEqual([]);
		const messages = [createUserMsg("hi")];
		const decision = await fake.emitter.preStep({
			agent: later,
			messages,
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});
		expect(decision).toEqual({ kind: "enter", messages });
	});
});

describe("apply — 三通道文案在 memory_index section 的落点", () => {
	it("shows the snippet and every guideline for a healthy session with zero memories", async () => {
		const { fake } = await setup();
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		// 新项目：索引为空，section 就只剩工具文案 —— 这正是第一次该告诉模型「工具有、怎么写」的时机。
		const text = sectionText(fake)({ agent });
		expect(text).toBe(EXPECTED_PREAMBLE);
		// 顺序固定：snippet → guidelines（空行分隔，每条一行 `- ` 前缀）。
		expect(text.startsWith(`${MEMORY_TOOL_SNIPPET}\n\n- `)).toBe(true);
		// 7 条 guidelines 逐字落地：core 的提示词文本一个字都不改。
		for (const rule of MEMORY_TOOL_GUIDELINES) expect(text).toContain(`- ${rule}`);
		expect(text.match(/^- /gm)).toHaveLength(MEMORY_TOOL_GUIDELINES.length);
	});

	it("prepends snippet + guidelines to a byte-identical core index body", async () => {
		const memoryDir = memoryDirFor(cwd);
		await seedEntry(memoryDir, "Alpha", "first note");
		const { fake } = await setup();
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const body = await expectedIndexBody(memoryDir);
		const text = sectionText(fake)({ agent });
		// 只 prepend：索引正文逐字不动（跨宿主字节恒等是硬要求）—— 不二次净化、不二次截断。
		expect(text).toBe(`${EXPECTED_PREAMBLE}\n\n${body}`);
		expect(text.endsWith(body)).toBe(true);
	});

	it("keeps the tool text for a directory-failure session and still registers the degraded tool", async () => {
		// 降级而不失败的另一分支：dirs.ensure 拒绝且 session.header.cwd 为空 → prepare 产出 store=null + error。
		const fake = createFakeCtx();
		const ensure = vi.spyOn(fake.ctx.workingDirectory, "ensure").mockRejectedValue(new Error("ensure boom"));
		await apply(fake.ctx, rowConfig());
		const agent = fake.makeAgent({
			id: "s1",
			session: { id: "s1", header: { cwd: "" }, seq: 0, snapshotEvents: () => [] },
		});
		await fake.emitter.agentCreated(agent);

		// 错误态也要有工具文案（工具仍然注册，只是降级），索引正文为空。
		const text = sectionText(fake);
		expect(text({ agent })).toBe(EXPECTED_PREAMBLE);

		// 工具仍在、execute 拒绝并带上目录失败原因；/memory 报告 misconfigured。
		const tool = memoryToolOf(fake, "s1");
		expect(tool).toBeDefined();
		await expect(tool?.execute({ action: "list" }, {})).rejects.toThrowError(/ensure boom/);

		const status = await runMemoryCommand(fake, agent);
		expect(status.text).toContain("Memory: misconfigured");
		expect(status.text).toContain("ensure boom");

		// 门禁只挡子 agent：它从没进 runtime，所以三通道文案一样都不该有。
		const sub = fake.makeAgent({ id: "sub-1", subagent: true, cwd });
		await fake.emitter.agentCreated(sub);
		expect(text({ agent: sub })).toBe("");
	});
});

describe("apply — 启动期降级与每轮召回", () => {
	it("resolves auto-surfacing availability against the host llm once at startup", async () => {
		const fake = createFakeCtx();
		const resolveCallConfig = vi.spyOn(fake.ctx.llm, "resolveCallConfig");

		await apply(fake.ctx, rowConfig({ autoSurfacing: { enabled: true, model: "prov/mod" } }));

		expect(resolveCallConfig).toHaveBeenCalledTimes(1);
		// `"<provider>/<model>"` 按第一个斜杠拆成宿主的两段；thinkLevel 透传成 reasoningEffort。
		expect(resolveCallConfig.mock.calls[0][0]).toEqual({ provider: "prov", model: "mod", reasoningEffort: "off" });
	});

	it("degrades to autoSurfacing=off when the host rejects the model, without failing activation", async () => {
		const { fake, dispose } = await setup(
			{ llmError: { code: "NO_ADAPTER", message: "no adapter for provider" } },
			rowConfig({ autoSurfacing: { model: "prov/mod" } }),
		);
		expect(typeof dispose).toBe("function");

		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const status = await runMemoryCommand(fake, agent);
		expect(status.text).toContain("autoSurfacing=off(");
		expect(status.text).toContain("NO_ADAPTER");
	});

	it("bounds the startup model-resolution await and degrades instead of hanging when the host never answers", async () => {
		// R27：截获 AbortSignal.timeout 而不是 fake timers —— Node 用 setWeakAbortSignalTimeout 实现它，
		// fake timers 驱动不了。这里记录实参、再交给真实实现生成一个 50ms 的短 bound，既钉住 10_000 上界，
		// 又让 abort 路径真的在 ~50ms 内走完。
		const originalTimeout = AbortSignal.timeout;
		const timeoutArgs: number[] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
			timeoutArgs.push(ms);
			return originalTimeout(50);
		});

		const fake = createFakeCtx();
		// 替身必须 abort-aware：宿主查找永不 settle 时，signal abort 才能把 pending 的 await 变成 rejection，
		// model.ts 既有的 try 才能把它降级成 { available: false, reason }。
		const resolveCallConfig = vi.spyOn(fake.ctx.llm, "resolveCallConfig").mockImplementation(
			(...args: unknown[]) =>
				new Promise<unknown>((_resolve, reject) => {
					const signal = args[1] as AbortSignal | undefined;
					signal?.addEventListener("abort", () => {
						const err = new Error("The operation was aborted due to timeout");
						(err as { code?: string }).code = "ABORT_ERR";
						reject(err);
					});
				}),
		);

		// apply 在第一个 await 之前同步调用 AbortSignal.timeout(10_000)，所以不等它 settle 就能钉住上界。
		const activation = apply(fake.ctx, rowConfig({ autoSurfacing: { enabled: true, model: "prov/mod" } }));
		expect(timeoutArgs).toEqual([10_000]);

		const dispose = await activation;
		expect(typeof dispose).toBe("function");

		expect(fake.sections.map((section) => section.name)).toEqual(["memory_index"]);
		expect(fake.commands.map((command) => command.name)).toEqual(["memory", "dream"]);
		expect(resolveCallConfig).toHaveBeenCalledTimes(1);

		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const status = await runMemoryCommand(fake, agent);
		expect(status.text).toContain("autoSurfacing=off(");
	});

	it("recalls relevant memories on the agent/pre-step waterfall", async () => {
		const memoryDir = memoryDirFor(cwd);
		await seedEntry(memoryDir, "Alpha", "everything about alpha", "the codeword is lantern");
		const { fake } = await setup(
			{ llmStream: llmStreamReplying(JSON.stringify({ selected_files: ["Alpha.md"] })) },
			rowConfig({ autoSurfacing: { model: "prov/mod" } }),
		);
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const messages = [createUserMsg("tell me about alpha")];
		const decision = await fake.emitter.preStep({
			agent,
			messages,
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.kind).toBe("enter");
		expect(decision.messages).toHaveLength(2);
		expect(decision.messages[0]).toBe(messages[0]);
		const recalled = decision.messages[1];
		expect(recalled.role).toBe("user");
		expect(recalled.source.kind).toBe("simple-memory");
		expect(recalled.content[0].text).toContain("<relevant_memories>");
		// 注入的是 entry 的**正文**（core 的 renderSurfacedBlock），frontmatter 不进上下文。
		expect(recalled.content[0].text).toContain("the codeword is lantern");

		// 同一会话里同一份文件不重复注入：injected 由装配层持有并交给 surfacing。
		const second = await fake.emitter.preStep({
			agent,
			messages: [createUserMsg("tell me about alpha again")],
			turn: 2,
			step: 1,
			signal: new AbortController().signal,
		});
		expect(second.messages).toHaveLength(1);

		// 会话结束就销账（injected.delete）：宿主的 clear / compact 会用同一 sessionId 重建 agent，
		// 新会话应该重新有召回机会。
		fake.emitter.agentDisposed(agent);
		const reborn = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(reborn);
		const third = await fake.emitter.preStep({
			agent: reborn,
			messages: [createUserMsg("tell me about alpha")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});
		expect(third.messages).toHaveLength(2);
	});

	it("registers the recall listener outermost so an inner rewrite cannot drop the recalled block", async () => {
		const memoryDir = memoryDirFor(cwd);
		await seedEntry(memoryDir, "Alpha", "about alpha", "the codeword is lantern");
		const fake = createFakeCtx({ llmStream: llmStreamReplying(JSON.stringify({ selected_files: ["Alpha.md"] })) });

		// 先注册一个「内层」监听器（compaction / instructions 就是这种）：它把进入该 step 的消息
		// 整个换成自己的一份。我们的监听器必须用 { prepend: true } 跑在它**外层**（先进入、最后看到
		// decision），否则这一整份召回会被内层监听器抹掉。
		fake.ctx.on("agent/pre-step", async (_payload: unknown, next: () => Promise<Decision>): Promise<Decision> => {
			const decision = await next();
			return decision.kind === "reject" ? decision : { ...decision, messages: [createUserMsg("compacted")] };
		});

		await apply(fake.ctx, rowConfig({ autoSurfacing: { model: "prov/mod" } }));
		const agent = fake.makeAgent({ id: "s1", cwd });
		await fake.emitter.agentCreated(agent);

		const decision = await fake.emitter.preStep({
			agent,
			messages: [createUserMsg("tell me about alpha")],
			turn: 1,
			step: 1,
			signal: new AbortController().signal,
		});

		expect(decision.kind).toBe("enter");
		// 内层监听器抹掉了原始 claim 消息，所以 `findLastIndex` 返回 -1，召回块落在最前（surfacing.ts
		// 里记过的 first-party 同款行为）。关键是：它**还在**。
		expect(decision.messages).toHaveLength(2);
		expect(decision.messages[0].source.kind).toBe("simple-memory");
		expect(decision.messages[0].content[0].text).toContain("the codeword is lantern");
		expect(decision.messages[1].content[0].text).toBe("compacted");
	});
});

describe("apply — extract 触发点（agent/turn-stopping）", () => {
	const ONE_USER_TURN = [
		{ type: "user/message", data: { content: [{ type: "text", text: "remember X" }], source: { kind: "user" } } },
	];

	it("runs an extract sub-session when extractMemories is enabled", async () => {
		const { fake } = await setup(
			{
				childRun: () => ({
					events: [
						{
							type: "assistant/message",
							data: { message: { content: [{ type: "text", text: "nothing worth saving" }] } },
						},
					],
				}),
			},
			rowConfig({ defaults: { model: "prov/extract" }, extractMemories: { enabled: true } }),
		);
		const agent = fake.makeAgent({ id: "s1", cwd, events: ONE_USER_TURN });
		await fake.emitter.agentCreated(agent);

		await fake.emitter.turnStopping({ agent });
		await vi.waitFor(() => expect(fake.childSessions).toHaveLength(1));

		const [options] = fake.childCreateOptions;
		// 子会话是 subagent（`isRootAgent` 因此不再给它挂记忆层），cwd 是这条会话的记忆目录。
		expect(options.meta).toMatchObject({ origin: "subagent", cwd: memoryDirFor(cwd) });
		// 模型与思考档位都由 core 从 cfg 读出来（`extractMemories.thinkLevel` 默认 high），
		// 装配层只负责把 `<provider>/<model>` 拆开交给宿主的 agentOptions。
		expect(options.agentOptions).toEqual({ provider: "prov", model: "extract", reasoningEffort: "high" });

		// 子会话唯一的工具是作用域里的 `memory`：全局工具被 restrict 全部关掉。
		const childRestriction = fake.restrictions.find((entry) => entry.agentId.endsWith(":child"));
		expect(childRestriction?.filter).toEqual({ allow: [] });

		// 跑完一定 dispose（否则长寿命宿主进程里会积一堆子会话）。
		await vi.waitFor(() => expect(fake.childSessions[0].disposed).toBe(true));
	});

	it("starts nothing when extractMemories is off", async () => {
		const { fake } = await setup({}, rowConfig({ defaults: { model: "prov/extract" } }));
		const agent = fake.makeAgent({ id: "s1", cwd, events: ONE_USER_TURN });
		await fake.emitter.agentCreated(agent);

		await fake.emitter.turnStopping({ agent });

		expect(fake.childCreateOptions).toEqual([]);
		expect(fake.childSessions).toEqual([]);
	});
});
