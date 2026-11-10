/**
 * index wiring — session_start
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakModelConfig, createFakePi, DISK_INDEX, dirOverrideRef, dirRef, mockConfigValue, resetWiringMocks, restoreModelConfig, runTaskMock, scanEntriesMock, sectionsEvent, uiCtx, uiWith } from "./helpers/wiring-harness";
import memoryFactory from "../index";

describe("index wiring — session_start", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-wiring-"));
		dirRef.current = dir;
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "MEMORY.md"), DISK_INDEX, "utf8");

		scanEntriesMock.mockReset();
		resetWiringMocks();

		// 模型 fixture：默认走 defaults.model；各用例按需覆盖 mockConfigValue 的 model 段
		mockConfigValue.defaults = { model: "test/model", sessionPersistence: { enabled: false } };
		mockConfigValue.dream.model = undefined;
		mockConfigValue.extractMemories.model = undefined;
		mockConfigValue.autoSurfacing.model = undefined;
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		delete (mockConfigValue.autoSurfacing as any).sessionPersistence;
		mockConfigValue.autoSurfacing.maxFiles = 5;
		mockConfigValue.autoSurfacing.thinkLevel = "off";
		mockConfigValue.extractMemories.enabled = false;
		mockConfigValue.lock = { timeoutMs: 5000, snapshotKeep: 5 };
		dirOverrideRef.current = null;
	});

	it("registers exactly one memory tool with the five main-agent actions, even across sessions", async () => {
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		expect(handlers["session_start"]).toBeDefined();
		expect(handlers["before_agent_start"]).toBeDefined();
		expect(handlers["agent_end"]).toBeDefined();

		await handlers["session_start"][0]({}, uiCtx());

		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("memory");
		// D12：主 agent 的 schema 只有 5 个 action，且不含 dream 专属的 new_name 参数
		expect(tools[0].parameters.properties.action.enum).toEqual([
			"add",
			"replace",
			"remove",
			"list",
			"search",
		]);
		expect(Object.keys(tools[0].parameters.properties)).not.toContain("new_name");
		expect(commands["memory"]).toBeDefined();
		expect(commands["dream"]).toBeDefined();

		// 跨 session 也只注册一次：第二次 session_start 不得再注册
		await handlers["session_start"][0]({}, uiCtx());
		expect(tools).toHaveLength(1);
	});

	it("writes through the store end to end", async () => {
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		const result = await tools[0].execute(
			"call-1",
			{ action: "add", name: "Use real DB in tests", description: "不要 mock", content: "集成测试必须连真实 PostgreSQL。" },
			undefined,
			undefined,
			undefined as any,
		);

		expect(result.content[0].text).toBe('Saved "Use real DB in tests" (Use-real-DB-in-tests.md).');
		const raw = await readFile(join(dir, "Use-real-DB-in-tests.md"), "utf8");
		expect(raw).toContain("name: Use real DB in tests");
		expect(raw).toContain("modified:");
		expect(raw).not.toContain("updated:");
		const index = await readFile(join(dir, "MEMORY.md"), "utf8");
		expect(index).toContain("- [SSH](ssh.md) — staging ssh config");
		expect(index).toContain("- [Use real DB in tests](Use-real-DB-in-tests.md) — 不要 mock");
	});

	// per-session 去重（v3 设计：集合在 session_start 时初始化）：每次 session_start 都必须把
	// 上一 session 的 injectedFiles 清掉，否则新会话里同一条 entry 会因旧集合而被静默压掉。
	// 这一条用 healthy → 配置错误 → healthy 三次启动钉住它（去掉 clear 就会第二次观测到 ssh.md）。
	it("clears the injected-file set on every session_start", async () => {
		const injectedAtCall: Array<Set<string>> = [];
		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		// injectedFiles 是活 Set：必须在调用瞬间深拷贝（见 `does not surface the same entry file twice`）
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: "<relevant_memories>x</relevant_memories>" };
		});

		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), uiCtx());

		// 中途一次「配置错误」启动（session_start 不建 store），再回到 healthy：三条路径都必须从
		// 空集合开始。`resetSessionState()` 在每次 session_start 开头无条件清空它 —— 去掉那次
		// clear，第二次观测就会看到上一轮注入过的 `ssh.md`，用例变红。
		breakModelConfig();
		await handlers["session_start"][0]({}, uiCtx());
		restoreModelConfig();
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["before_agent_start"][0](sectionsEvent("ssh?"), uiCtx());

		expect(injectedAtCall).toHaveLength(2);
		expect(injectedAtCall[0]).toEqual(new Set());
		expect(injectedAtCall[1]).toEqual(new Set());
	});

	it("initialises when only defaults.model is set", async () => {
		mockConfigValue.extractMemories.enabled = true;
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx(uiWith(notify)));

		expect(tools).toHaveLength(1);
		expect(notify).not.toHaveBeenCalled();
	});
});
