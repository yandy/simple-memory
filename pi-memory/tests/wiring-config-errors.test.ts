/**
 * index wiring — config errors
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakModelConfig, createFakePi, DISK_INDEX, dirOverrideRef, dirRef, fakeRegistry, mockConfigValue, resetWiringMocks, restoreModelConfig, runTaskMock, scanEntriesMock, uiCtx, uiWith } from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { loadConfig } from "../src/config";

describe("index wiring — config errors", () => {
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



	// Plan E/next #2(a)：配置错误的重启必须把上一 session 的 memoryDir 清掉 —— 光靠状态块只能
	// 证明「memoryDir 与 store 至少有一个被清了」（`/memory` 的守卫是 `||`），所以这里再用
	// `/memory unlock` 钉一次 memoryDir 本身：它拿到的必须是**本 cwd** 的目录，而不是上一
	// session 的 dirA（否则会去删错项目的锁，真事故）。
	it("/memory after a misconfigured restart never reports or unlocks the previous session's dir", async () => {
		const dirB = await mkdtemp(join(tmpdir(), "mem-wiring-b-"));
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const ctxB = () => uiCtx({ cwd: dirB, hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } });
		const lock = JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "x", op: "dream" });
		try {
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, uiCtx()); // healthy @ dirA

			dirOverrideRef.current = (cwd) => join(cwd, ".memory");
			breakModelConfig();
			await handlers["session_start"][0]({}, uiCtx({ cwd: dirB }));

			await commands["memory"].handler("", ctxB());

			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][1]).toBe("info");
			expect(notify.mock.calls[0][0].split("\n")).toEqual([
				"Memory: misconfigured",
				"Dir: not initialized",
				'- no model for dream — set "dream.model" or "defaults.model" in memory.json',
				'- no model for autoSurfacing — set "autoSurfacing.model" or "defaults.model" in memory.json',
			]);
			expect(notify.mock.calls[0][0]).not.toContain(dir);

			// 两个目录各放一把锁：unlock 只能动本 cwd（dirB/.memory）的那把
			await writeFile(join(dir, ".lock"), lock, "utf8");
			await mkdir(join(dirB, ".memory"), { recursive: true });
			await writeFile(join(dirB, ".memory", ".lock"), lock, "utf8");
			notify.mockClear();

			await commands["memory"].handler("unlock", ctxB());

			expect(notify.mock.calls[0]).toEqual(["Memory lock removed.", "info"]);
			expect(await readdir(join(dirB, ".memory"))).not.toContain(".lock");
			expect(await readdir(dir)).toContain(".lock");
		} finally {
			restoreModelConfig();
			await rm(dirB, { recursive: true, force: true });
		}
	});


	// Plan E/next #2(b)：`/dream` 的守卫是 `!config || !memoryDir || !activeStore`。store 残留
	// 会真的对 dirA 起一轮 dream（而不只是打错一行状态）。
	it("/dream refuses right after a misconfigured restart instead of dreaming the old dir", async () => {
		const dirB = await mkdtemp(join(tmpdir(), "mem-wiring-b-"));
		const notify = vi.fn();
		// confirm 必须返回 true：它若为假值，即使没复位 store、守卫放行，`/dream` 也会先在
		// `!ok` 处 return —— `runTaskMock` 的断言就成了假承重（review Minor #2/#3）。
		const confirm = vi.fn().mockResolvedValue(true);
		const ctxB = () => uiCtx({ cwd: dirB, hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } });
		try {
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, uiCtx()); // healthy @ dirA

			dirOverrideRef.current = (cwd) => join(cwd, ".memory");
			breakModelConfig();
			await handlers["session_start"][0]({}, uiCtx({ cwd: dirB }));

			await commands["dream"].handler("", ctxB());

			expect(notify).toHaveBeenCalledWith("Memory not initialized.", "info");
			expect(runTaskMock).not.toHaveBeenCalled();
		} finally {
			restoreModelConfig();
			await rm(dirB, { recursive: true, force: true });
		}
	});


	// ── 模型校验（设计 §2）─────────────────────────────────────────────
	it("reports missing models and does not initialise anything", async () => {
		mockConfigValue.defaults = { sessionPersistence: { enabled: false } };
		mockConfigValue.autoSurfacing.enabled = true;
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx(uiWith(notify)));

		expect(tools).toHaveLength(0);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0].split("\n")).toEqual([
			"pi-memory config error:",
			'- no model for dream — set "dream.model" or "defaults.model" in memory.json',
			'- no model for autoSurfacing — set "autoSurfacing.model" or "defaults.model" in memory.json',
		]);

		// `Memory: misconfigured` + 同样的错误行，且不解析目录
		await commands["memory"].handler("", uiCtx(uiWith(notify)));
		const status = notify.mock.calls[1][0].split("\n");
		expect(status.slice(0, 2)).toEqual(["Memory: misconfigured", "Dir: not initialized"]);
		expect(status.slice(2)).toEqual([
			'- no model for dream — set "dream.model" or "defaults.model" in memory.json',
			'- no model for autoSurfacing — set "autoSurfacing.model" or "defaults.model" in memory.json',
		]);
	});


	it("reports a configured model that cannot be resolved", async () => {
		// 三种形状都必须落进同一个配置错误态：未知 id、模型存在但没凭据、有别的可用模型时精确匹配失败。
		const rows = [
			{
				name: "unknown id",
				dreamModel: "nope/nope" as string | undefined,
				registry: fakeRegistry(["test/model"]),
				check: (text: string, row: string) =>
					expect(text, row).toBe(
						'pi-memory config error:\n- model "nope/nope" for dream is not resolvable (unknown id or missing credentials)',
					),
			},
			{
				name: "no credentials (nothing available)",
				dreamModel: undefined,
				// getAll 认得 test/model，getAvailable 里没有它 = 模型存在但没凭据
				registry: fakeRegistry(["test/model"], []),
				check: (text: string, row: string) =>
					expect(text, row).toContain('model "test/model" for dream is not resolvable'),
			},
			{
				name: "getAll but not getAvailable while other models are available",
				dreamModel: undefined,
				registry: fakeRegistry(["test/model", "other/thing"], ["other/thing"]),
				check: (text: string, row: string) =>
					expect(text, row).toContain(
						'model "test/model" for dream is not resolvable (unknown id or missing credentials)',
					),
			},
		];

		for (const row of rows) {
			mockConfigValue.dream.model = row.dreamModel;
			const notify = vi.fn();
			const { pi, tools, handlers } = createFakePi();
			memoryFactory(pi as any);

			await handlers["session_start"][0]({}, uiCtx({ ...uiWith(notify), modelRegistry: row.registry }));

			expect(tools, row.name).toHaveLength(0);
			expect(notify.mock.calls[0][1], row.name).toBe("error");
			row.check(notify.mock.calls[0][0], row.name);
		}
	});


	it("turns an initialisation failure into the config error state", async () => {
		dirOverrideRef.current = () => {
			throw new Error("no writable home");
		};
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await expect(handlers["session_start"][0]({}, uiCtx(uiWith(notify)))).resolves.toBeUndefined();

		expect(tools).toHaveLength(0);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toBe(
			"pi-memory config error:\n- Failed to initialize memory: no writable home",
		);
		await commands["memory"].handler("", uiCtx(uiWith(notify)));
		expect(notify.mock.calls[1][0].split("\n")[0]).toBe("Memory: misconfigured");
	});


	// 宿主契约之外的抛错（registry 既没有 getAvailable 也没有 getAll，或 loadConfig 里的
	// getAgentDir 炸了）必须在**复位之后**才发生：否则 session_start 一抛出，三条复位路径一条都
	// 不会跑，上一 session 的 store / memoryDir 就留在**已注册**的 `memory` 工具背后 ——
	// 项目 B 的 agent 能写进项目 A 的目录（Plan C ledger R51）。
	it("clears the previous session's state when the model registry violates the contract", async () => {
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const ctxUI = () => uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } });
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		// ① 健康会话：工具已注册、store 已建
		await handlers["session_start"][0]({}, ctxUI());
		expect(tools).toHaveLength(1);
		notify.mockClear();

		// ② 换一个既没有 getAvailable 也没有 getAll 的 registry：resolveModel 里 `registry.getAll()`
		//    直接 TypeError。session_start 不得 reject，而是落到同一个配置错误态。
		await expect(
			handlers["session_start"][0]({}, { ...ctxUI(), modelRegistry: { find: () => undefined } as any }),
		).resolves.toBeUndefined();
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toContain("pi-memory config error:\n- Failed to initialize memory:");

		// ③ 上一 session 的目录 / store 必须已经清空：工具虽然还注册着（只注册一次），现在也必须
		//    拒绝，而不是写进上一个 session 的目录；`/memory` 说 misconfigured；`/dream` 拒绝。
		await expect(
			tools[0].execute("c1", { action: "list" }, undefined, undefined, undefined),
		).rejects.toThrow(/Memory not initialized/);
		await commands["memory"].handler("", ctxUI());
		expect(notify.mock.calls[1][0].split("\n").slice(0, 2)).toEqual([
			"Memory: misconfigured",
			"Dir: not initialized",
		]);
		expect(notify.mock.calls[1][0]).not.toContain(dir);
		await commands["dream"].handler("", ctxUI());
		expect(notify.mock.calls[2]).toEqual(["Memory not initialized.", "info"]);
		expect(runTaskMock).not.toHaveBeenCalled();
		expect(tools).toHaveLength(1);
	});


	// loadConfig 本身抛错时也不再冒给宿主（spec §2.4）：转成配置错误态。复位由两处共同保证 ——
	// `session_start` 开头（在任何可抛调用之前）与 `failConfig` 自身；本用例钉的是**可观测结果**：
	// 工具与 /memory 都报真实原因，且不再显示上一会话的 dir。
	it("turns a loadConfig failure into the config error state without rejecting", async () => {
		const notify = vi.fn();
		const ctxUI = () => uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } });
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, ctxUI());
		expect(tools).toHaveLength(1);
		notify.mockClear();

		vi.mocked(loadConfig).mockImplementationOnce(async () => {
			throw new Error("getAgentDir failed");
		});
		// 不再把裸 reject 冒给宿主（spec §2.4）：转成配置错误态
		await expect(handlers["session_start"][0]({}, ctxUI())).resolves.toBeUndefined();
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toBe(
			"pi-memory config error:\n- Failed to load memory config: getAgentDir failed",
		);

		// 已注册的工具报真实原因，而不是笼统的「未初始化」
		await expect(
			tools[0].execute("c1", { action: "list" }, undefined, undefined, undefined),
		).rejects.toThrow(
			"Memory not initialized — Failed to load memory config: getAgentDir failed; run /memory for details",
		);

		// 复位仍然生效：/memory 不显示上一会话的 dir
		await commands["memory"].handler("", ctxUI());
		const lines = notify.mock.calls[1][0].split("\n");
		expect(lines.slice(0, 2)).toEqual(["Memory: misconfigured", "Dir: not initialized"]);
		expect(lines[2]).toBe("- Failed to load memory config: getAgentDir failed");
		expect(notify.mock.calls[1][0]).not.toContain(dir);
	});


	it("reports the config error on /memory even when the very first loadConfig fails", async () => {
		vi.mocked(loadConfig).mockImplementationOnce(async () => {
			throw new Error("no agent dir");
		});
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx());

		await commands["memory"].handler("", uiCtx(uiWith(notify)));
		expect(notify.mock.calls[0][0].split("\n")).toEqual([
			"Memory: misconfigured",
			"Dir: not initialized",
			"- Failed to load memory config: no agent dir",
		]);
	});


	it("tells the tool caller the real reason when a later session is misconfigured", async () => {
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx()); // healthy：工具已注册
		expect(tools).toHaveLength(1);

		// 同一个工厂再来一个配置错误的会话：模型一个都不配（extract 默认 disabled，故错误行是 dream + autoSurfacing）
		mockConfigValue.defaults = { sessionPersistence: { enabled: false } };
		await handlers["session_start"][0]({}, uiCtx(uiWith(notify)));

		await expect(
			tools[0].execute("c1", { action: "list" }, undefined, undefined, undefined),
		).rejects.toThrow(
			'Memory not initialized — no model for dream — set "dream.model" or "defaults.model" in memory.json; run /memory for details',
		);
	});


	// ── 错误态的跨 session 生命周期（design §2.5）──────────────────────────
	// 同一个工厂（= 同一个常驻进程）里 healthy → misconfigured → healthy：
	// · misconfigured 那次重启必须**不沿用**上一 session 的目录（`/memory` 只能说 not initialized，
	//   `/dream` 必须拒绝，否则会对上一个项目的目录起一轮 dream）；
	// · 改好配置再重启必须回到 `Memory: enabled` —— `session_start` 里的 `configError = null`
	//   是这一行为的唯一实现（少了它，错误态会一直粘在工厂作用域里）；
	// · 工具只在第一次健康会话注册一次（`tools` 恒为 1，钉住不重复注册）。
	it("/memory reports the healthy status block again after a misconfigured session is fixed and restarted", async () => {
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const ctxUI = () => uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } });
		const errorLines = [
			'- no model for dream — set "dream.model" or "defaults.model" in memory.json',
			'- no model for autoSurfacing — set "autoSurfacing.model" or "defaults.model" in memory.json',
		];
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		// ① 健康会话：状态块直接以目录起头
		await handlers["session_start"][0]({}, ctxUI());
		expect(tools).toHaveLength(1);
		await commands["memory"].handler("", ctxUI());
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("info");
		expect(notify.mock.calls[0][0].split("\n")[0]).toBe(`Dir: ${dir}`);
		notify.mockClear();

		// ② 用户删掉模型配置后重启：misconfigured，且不得沿用上一 session 的目录
		mockConfigValue.defaults = { sessionPersistence: { enabled: false } };
		await handlers["session_start"][0]({}, ctxUI());
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0].split("\n")).toEqual(["pi-memory config error:", ...errorLines]);

		await commands["memory"].handler("", ctxUI());
		expect(notify.mock.calls[1][0].split("\n")).toEqual([
			"Memory: misconfigured",
			"Dir: not initialized",
			...errorLines,
		]);
		expect(notify.mock.calls[1][0]).not.toContain(dir);

		// confirm 返回 true：守卫若失效，`/dream` 就会真的对上一 session 的目录跑一轮
		await commands["dream"].handler("", ctxUI());
		expect(notify.mock.calls[2]).toEqual(["Memory not initialized.", "info"]);
		expect(runTaskMock).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		// 已注册的工具不会因为错误态再注册一次
		expect(tools).toHaveLength(1);
		notify.mockClear();

		// ③ 改好配置再重启：错误态被清掉，状态块回到健康态
		mockConfigValue.defaults = { model: "test/model", sessionPersistence: { enabled: false } };
		await handlers["session_start"][0]({}, ctxUI());
		expect(notify).not.toHaveBeenCalled();
		await commands["memory"].handler("", ctxUI());
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0].split("\n")[0]).toBe(`Dir: ${dir}`);
		expect(notify.mock.calls[0][0]).not.toContain("misconfigured");
		expect(tools).toHaveLength(1);
	});
});
