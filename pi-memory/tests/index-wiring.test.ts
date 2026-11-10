import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	breakModelConfig,
	captureUnhandledRejections,
	createFakePi,
	createMemoryToolSpy,
	DISK_INDEX,
	detectLegacyMemoryDirMock,
	dirOverrideRef,
	dirRef,
	disposableCtx,
	fakeRegistry,
	flush,
	legacyEvent,
	LEGACY_TOPIC,
	mockConfigValue,
	readDreamMetaMock,
	readRecordedMemoryIndexMock,
	resetWiringMocks,
	restoreModelConfig,
	runTaskMock,
	scanEntriesMock,
	sectionsEvent,
	shouldNudgeMock,
	uiCtx,
	uiWith,
	waitFor,
	writeDreamMetaMock,
} from "./helpers/wiring-harness";
import memoryFactory, { moduleStatusLine } from "../index";
import { DEFAULT_CONFIG, loadConfig, PI_HOST_DEFAULTS, type MemoryConfig } from "../src/config";
import { DREAM_ACTIONS, INDEX_TRUNCATION_MARKER, MAIN_AGENT_ACTIONS, TASKS } from "@yandy0725/memory-core";

describe("index wiring (integration)", () => {
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

	// 端到端钉住「session_start 用的是**注入**口径」：一行 swap 就会落在写入口径（200/25600）上，
	// 那时 60 条索引会整份注入，下面的 50 条断言就会红。
	// compaction 是会话内唯一的刷新点：那里也必须用注入口径（同一个窗口核心）。
	// Review Focus #1：省略该键 = pi 生成 { memory_index: null } = 索引被静默删除。
	// 三种「用录制值」的 reason 也必须每轮把键写回去。
	// Finding 1 / R42：0.99.2 宿主把每个 non-preamble section 渲染成
	// `<memory_index>\n<裸值>\n</memory_index>` 后才写进 transcript，重放拿到的是**带标签**的值。
	// 端到端保真 = 冻结值等于原始裸串，且宿主再渲染一次逐字节等于录制值（不产生新 patch）。
	// Review Focus #3：重放拿不到录制值 → 回退磁盘，而不是把索引丢掉。
	// D14：compaction 是唯一的会话内刷新点，同时清空已注入集合。
	// ── Plan C（spec §14 通知）────────────────────────────────────────────
	/**
	 * 排空待处理的微任务（extract / dream 的 `.then` 链是异步的）。
	 * **只覆盖一层宏任务**：链上每个 `await` 都要再 flush 一次，别指望一次 flush 跑完整条链。
	 */

	/**
	 * 等条件成立（默认 2s，每 10ms 轮询一次）。完成回调在 notify 之前会做真实磁盘 I/O
	 * （`SessionManager.list`），单个 `setTimeout(0)` tick 覆盖不到它——实测空闲机器上仍有
	 * 约 2% 的概率输给这段 I/O，并行跑整仓时更容易翻车。所以这里等条件，不猜时间。
	 */


	// Review Focus #4：没写东西就不该弹通知；被锁跳过也不该弹。
	// ── Review 修复轮（R44）：session dispose 之后 ctx 不可再访问 ─────────────
	/**
	 * pi 的 `ExtensionContext` 是代理：`hasUI` / `ui` 的 getter 会先 `runner.assertActive()`，
	 * session dispose（/new、switch、fork、reload、退出宽限超时）之后调用即抛错。
	 * 这里造一个同形状的 fake：`dispose()` 之后读取这两个字段直接抛错。
	 */

	/**
	 * 收集进程级未处理 rejection。extract 的通知挂在 `void` 链上，没人接住的 rejection 在 pi
	 * 里没有全局 handler（Node 默认打印并退出）—— 这里显式抓住它们。
	 */

	// ── Review 修复轮（R47/R48/R49）：dream 两条链的 ctx 快照 / 定时器 / section 时机 ──
	// Plan E/next #11：nudge 链的失败分支也要盖到 —— rejected 的值不一定是 Error
	//（pi 的模型层可能抛字符串），`dreamFailureMessage` 必须用 `String(e)` 渲染。
	// Plan E/next #11：success 分支里的 `writeDreamMeta` 自己抛错时，不能只走成功通知，
	// 也不能变成无人接管的 rejection（它已被 `track` 登记，但 `.finally` 不会接住）。
	// `runTask` 是 async：缺模型不会在调用点同步抛，而是作为 rejection 走 `/dream` 的两参
	// `.then` 失败分支（报「Dream failed」），状态行由 `.finally` 兜底清除 —— 处理器本身照常 resolve。
	// ── Plan C（spec §14 `/memory` 状态与 `/memory unlock`）─────────────────
	// D12 的注册范围是硬约束：dream 必须拿到 7 个 action（含 rename / rebuild_index），extract
	// 必须只拿到 5 个。core 钉「它请求了哪些 action」，pi 钉「toHeadlessToolOptions 会调
	// buildMemoryTool(spec)」—— 中间这条 `buildMemoryTool: (spec) => createMemoryTool(toolDeps, spec)`
	// 的闭包以前没人钉：把 spec 参数丢掉，全部套件照样绿，而 dream 会静默失去重构索引的能力。
	// 探测失败不得吃掉状态块：`/memory` 的交付物是状态，提示只是附加。
	// 本次移除的回归钉子（spec §5「新增」）：memory.json 里残留的 `enabled: false` 只是被忽略 ——
	// 会话照常初始化、零通知（决策：不做运行时迁移提示），`/memory` 照常报 7 行健康态。
	// Review Focus #5：删锁必须显式确认，而且只删 `.lock`。
	// Plan E/next #1：`unlock` 不需要 store，但**解析目录本身**也可能失败（HOME 不可写、
	// git 探测炸了）。失败必须变成一条 error 通知与干净返回，不能冒泡成 handler 抛错。
	// ── Plan D（D1）：配置错误启动的会话状态（unlock / 状态行）与跨 session 复位 ──────

	// Review Focus #5 / spec §19：`unlock` 只需要目录、不需要 store —— 以**配置错误**启动的
	// 会话也必须能清掉崩溃遗留的 `.lock`（R50：否则唯一的人工恢复入口本 session 不可达）。
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

	// per-session 去重（v3 设计：集合在 session_start 时初始化）：每次 session_start 都必须把
	// 上一 session 的 injectedFiles 清掉，否则新会话里同一条 entry 会因旧集合而被静默压掉。
	// 这一条用 healthy → 配置错误 → healthy 三次启动钉住它（去掉 clear 就会第二次观测到 ssh.md）。
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

	it("reports a configured but unresolvable model", async () => {
		mockConfigValue.dream.model = "nope/nope";
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, uiCtx(uiWith(notify)));

		expect(tools).toHaveLength(0);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toBe(
			'pi-memory config error:\n- model "nope/nope" for dream is not resolvable (unknown id or missing credentials)',
		);
	});

	it("reports a configured model that the registry cannot see (no credentials)", async () => {
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		// getAll 认得 test/model，getAvailable 里没有它 = 模型存在但没凭据
		await handlers["session_start"][0](
			{},
			uiCtx({ ...uiWith(notify), modelRegistry: fakeRegistry(["test/model"], []) }),
		);

		expect(tools).toHaveLength(0);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toContain('model "test/model" for dream is not resolvable');
	});

	// 上一条走的是 resolveModel 的「一个可用模型都没有」早退；这一条让 getAvailable 非空，
	// 真正走到「精确匹配只认 available 集合 → 模糊匹配也匹不上」那条路径（同样是 missing credentials）。
	it("reports a model that is in getAll but not in getAvailable while other models are available", async () => {
		const notify = vi.fn();
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0](
			{},
			uiCtx({ ...uiWith(notify), modelRegistry: fakeRegistry(["test/model", "other/thing"], ["other/thing"]) }),
		);

		expect(tools).toHaveLength(0);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(notify.mock.calls[0][0]).toContain(
			'model "test/model" for dream is not resolvable (unknown id or missing credentials)',
		);
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
		expect(notify.mock.calls[0][0]).toContain(`Dir: ${dir}`);
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

// `/memory` 的模块状态行是纯函数，直接单测：走 wiring 只能盖到「正常配置」那一种。
describe("moduleStatusLine", () => {
	const cfg = (over: Partial<MemoryConfig> = {}): MemoryConfig => ({ ...DEFAULT_CONFIG, ...over });

	it("reports each module with its effective model", () => {
		const config = cfg({
			defaults: { model: "shared/model" },
			extractMemories: { ...DEFAULT_CONFIG.extractMemories, enabled: true, model: "extract/model" },
			autoSurfacing: { ...DEFAULT_CONFIG.autoSurfacing, enabled: false },
		});

		expect(moduleStatusLine(config)).toBe(
			"dream=on(shared/model) extractMemories=on(extract/model) autoSurfacing=off",
		);
	});

	// 正常会话跑不到这里（模型缺失会在 session_start 被拦成 misconfigured），
	// 但状态行绝不能印出 `on(undefined)` —— 防御性回落要有测试钉住。
	it("prints no model instead of on(undefined) when nothing resolves", () => {
		expect(moduleStatusLine(cfg({ defaults: undefined }))).toBe(
			"dream=on(no model) extractMemories=off autoSurfacing=on(no model)",
		);
	});

	// `deepMerge` 对 `"extractMemories": null` 会真的写入 null：状态行不能因此抛错。
	it("treats a null module config as off instead of throwing", () => {
		const config = cfg({
			defaults: { model: "shared/model" },
			extractMemories: null as unknown as MemoryConfig["extractMemories"],
		});

		expect(moduleStatusLine(config)).toBe(
			"dream=on(shared/model) extractMemories=off autoSurfacing=on(shared/model)",
		);
	});

});
