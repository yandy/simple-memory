/**
 * index wiring — /memory
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, DISK_INDEX, detectLegacyMemoryDirMock, fakeRegistry, LEGACY_TOPIC, readDreamMetaMock, resetWiringMocks, resolveMemoryDirMock, setupSession, uiCtx, uiWith } from "./helpers/wiring-harness";
import memoryFactory from "../index";


describe("index wiring — /memory", () => {
	let s: Awaited<ReturnType<typeof setupSession>>;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
	});

	afterEach(async () => {
		await s.cleanup();
	});

	it("/memory appends the 2.x migration hint when the detector finds old data", async () => {
		detectLegacyMemoryDirMock.mockResolvedValueOnce(
			"Note: found pre-3.0 memories at /home/u/.pi/memory/local/x. Move them with:\n  mkdir -p /home/u/.local/share && mv /home/u/.pi/memory /home/u/.local/share/simple-memory",
		);
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		const lines = notify.mock.calls[0][0].split("\n");
		// 状态块 7 行 + 一个空行 + 提示两行
		expect(lines).toHaveLength(10);
		expect(lines[7]).toBe("");
		expect(lines[8]).toMatch(/^Note: found pre-3\.0 memories at /);
		expect(lines[9]).toMatch(/^ {2}mkdir -p .*&& mv /);
		// 提示必须带上解析出的新目录与两个根，否则用户照着抄会搬错地方
		expect(detectLegacyMemoryDirMock).toHaveBeenCalledWith(
			expect.objectContaining({ newDir: s.dir, cwd: expect.any(String) }),
		);
		expect(detectLegacyMemoryDirMock.mock.calls[0][0].legacyRoot).toMatch(/[./\\]\.pi[./\\]memory$/);
		// newRoot 是**配置里的** memoryDir 根（`resolve(config.memoryDir)`），不是按 cwd 派生的
		// 项目目录 —— 用户照着搬的时候必须搬到 agent 真正会去读的那个根。
		expect(detectLegacyMemoryDirMock.mock.calls[0][0].newRoot).toBe(s.memoryDirRoot);
	});

	it("/memory prints the 7-line status block with no hint when the detector finds nothing or throws", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		// 阶段一：探测器报告「没有旧数据」
		detectLegacyMemoryDirMock.mockResolvedValueOnce(null);
		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0].split("\n")).toHaveLength(7);
		expect(notify.mock.calls[0][0]).not.toContain("pre-3.0");

		// 阶段二：探测本身抛错 —— 提示不可用，但状态块（这个命令的交付物）必须照出
		detectLegacyMemoryDirMock.mockRejectedValueOnce(new Error("git exploded"));
		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[1][0].split("\n")).toHaveLength(7);
		expect(notify.mock.calls[1][0]).toMatch(/^Dir: /);
	});

	it("/memory prints the whole status block", async () => {
		readDreamMetaMock.mockResolvedValue({ lastDreamAt: "2026-10-01T00:00:00.000Z", sessionCountAtDream: 3 });
		const notify = vi.fn();
		const confirm = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		await tools[0].execute(
			"c1",
			{ action: "add", name: "DB rules", description: "d", content: "正文" },
			undefined,
			undefined,
			undefined,
		);
		const index = await readFile(join(s.dir, "MEMORY.md"), "utf8");
		const statusIndex = `# Memory Index\n\n${index}手写的一行\n`;
		await writeFile(join(s.dir, "MEMORY.md"), statusIndex, "utf8");
		await writeFile(
			join(s.dir, ".lock"),
			JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "2026-10-02T01:02:03.000Z", op: "dream" }),
			"utf8",
		);

		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][1]).toBe("info");
		const lines = notify.mock.calls[0][0].split("\n");
		expect(lines).toHaveLength(7);
		expect(lines[0]).toBe(`Dir: ${s.dir}`);
		expect(lines[1]).toMatch(/^Index: 4\/200 lines, \d+\/25600 bytes, 2 unrecognized lines$/);
		// 注入口径：`Inject:` 与真正注入共用同一个窗口核心（`indexInjectionCapacity`），
		// 这里给精确值而不是 `\d+` —— 口径漂移（例如误用写入口径）必须在这里红。
		expect(lines[2]).toBe(`Inject: 5/50 lines, ${Buffer.byteLength(statusIndex, "utf8")}/16384 bytes`);
		expect(lines[3]).toBe("Entries: 1");
		expect(lines[4]).toBe("Modules: dream=on(test/model) extractMemories=off autoSurfacing=on(test/model)");
		expect(lines[5]).toBe("Last dream: 2026-10-01T00:00:00.000Z");
		expect(lines[6]).toBe(`Lock: held by dream (pid ${process.pid} on h, started 2026-10-02T01:02:03.000Z)`);
	});

	// 本次移除的回归钉子（spec §5「新增」）：memory.json 里残留的 `enabled: false` 只是被忽略 ——
	// 会话照常初始化、零通知（决策：不做运行时迁移提示），`/memory` 照常报 7 行健康态。
	it("ignores a leftover enabled key instead of treating it as disabled", async () => {
		// `enabled: false` 是 3.x 移除的键：写进 memory.json 只被忽略（不做运行时迁移提示）。
		// 每个用例有自己的临时配置目录，所以不再需要 finally 里手工复原全局 fixture。
		await s.writeConfig({ enabled: false });
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, s.uiCtx(uiWith(notify)));

		expect(notify).not.toHaveBeenCalled();
		expect(tools).toHaveLength(1);

		// 只钉这个用例真正要钉的事（残留的 `enabled` 键不被当成开关）；状态块本身由
		// `/memory prints the whole status block` 逐行钉住，这里不重复。
		await commands["memory"].handler("", s.uiCtx(uiWith(notify)));
		const lines = notify.mock.calls[0][0].split("\n");
		expect(lines[0]).toBe(`Dir: ${s.dir}`);
	});

	it("/memory reports a fresh directory as free / never / not needed", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		const lines = notify.mock.calls[0][0].split("\n");
		expect(lines[1]).toBe(
			`Index: 1/200 lines, ${Buffer.byteLength(DISK_INDEX, "utf8")}/25600 bytes, 0 unrecognized lines`,
		);
		// 未超预算时 Inject 的字节数与 Index 对同一份文件报的值相同（口径一致）。
		expect(lines[2]).toBe(`Inject: 1/50 lines, ${Buffer.byteLength(DISK_INDEX, "utf8")}/16384 bytes`);
		expect(lines[3]).toBe("Entries: 0");
		expect(lines[4]).toBe("Modules: dream=on(test/model) extractMemories=off autoSurfacing=on(test/model)");
		expect(lines[5]).toBe("Last dream: never");
		expect(lines[6]).toBe("Lock: free");
	});

	it("/memory reports the enabled modules with their effective models", async () => {
		await s.writeConfig({
			extractMemories: { enabled: true, model: "extract/model" },
			autoSurfacing: { enabled: false },
		});
		// per-task 模型必须在 registry 里可解析，否则 session_start 直接进 misconfigured 态，
		// `/memory` 报的是错误块而不是状态块。
		const registry = fakeRegistry(["test/model", "extract/model"]);
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx({ modelRegistry: registry }));

		await commands["memory"].handler(
			"",
			s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() }, modelRegistry: registry }),
		);

		const lines = notify.mock.calls[0][0].split("\n");
		// per-task model 优先，其余回落到 defaults.model；关闭的模块不显示模型。
		expect(lines[4]).toBe("Modules: dream=on(test/model) extractMemories=on(extract/model) autoSurfacing=off");
	});

	it("leaves legacy 1.x topic files untouched and reports no migration", async () => {
		await writeFile(join(s.dir, "debugging.md"), LEGACY_TOPIC, "utf8");
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({}, s.uiCtx(uiWith(notify)));

		expect(notify).not.toHaveBeenCalled();
		expect(await readdir(s.dir)).toContain("debugging.md");
		expect(await readdir(s.dir)).not.toContain(".migrated");

		await commands["memory"].handler("", s.uiCtx(uiWith(notify)));
		expect(notify.mock.calls[0][0].split("\n")).toHaveLength(7);

		// legacy 文件对记忆视图不可见：list 返回空清单文案（src/memory-tool.ts:262）
		const listed = await tools[0].execute("c1", { action: "list" }, undefined, undefined, undefined);
		expect(listed.content[0].text).toBe("No memories yet.");
	});

	it("keeps a valid v2 entry with several ## sections visible", async () => {
		await writeFile(
			join(s.dir, "v2.md"),
			[
				"---",
				"name: v2",
				"description: v2 entry",
				"type: project",
				"created: 2026-01-01",
				"modified: 2026-01-02T00:00:00.000Z",
				"---",
				"",
				"## 小节一",
				"",
				"正文一",
				"",
				"## 小节二",
				"",
				"正文二",
			].join("\n"),
			"utf8",
		);
		const { pi, tools, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const listed = await tools[0].execute("c1", { action: "list" }, undefined, undefined, undefined);
		expect(listed.content[0].text).toBe("- v2 (project, modified 2026-01-02T00:00:00.000Z) — v2 entry [v2.md]");
	});

	it("/memory points at /memory unlock when the lock record is unreadable", async () => {
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		await writeFile(join(s.dir, ".lock"), "not json", "utf8");

		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify.mock.calls[0][0].split("\n")[6]).toBe("Lock: unreadable — run /memory unlock");
	});

	it("/memory on and /memory off are no longer subcommands", async () => {
		const notify = vi.fn();
		const { pi, tools, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		const ctx = () => s.uiCtx(uiWith(notify));
		const registered = tools.length;

		await commands["memory"].handler("off", ctx());
		await commands["memory"].handler("on", ctx());

		// 两者都落到状态分支：不发开关通知、不改变初始化状态
		expect(notify).toHaveBeenCalledTimes(2);
		for (const call of notify.mock.calls) {
			expect(call[1]).toBe("info");
			expect(call[0].split("\n")[0]).toBe(`Dir: ${s.dir}`);
		}
		expect(tools).toHaveLength(registered);
	});

	it("/memory says it is not initialized before session_start", async () => {
		const notify = vi.fn();
		const { pi, commands } = createFakePi();
		memoryFactory(pi as any);

		await commands["memory"].handler("", s.uiCtx({ hasUI: true, ui: { notify, confirm: vi.fn(), setStatus: vi.fn() } }));

		expect(notify).toHaveBeenCalledWith("Memory not initialized.", "info");
	});

	// Review Focus #5：删锁必须显式确认，而且只删 `.lock`。
	it("/memory unlock removes only the lock file, after an explicit confirm", async () => {
		// 配置错误启动的会话也必须能清锁：`unlock` 只需要目录、不需要 store（spec §19 / R50）。
		for (const boot of ["healthy", "misconfigured"] as const) {
			if (boot === "misconfigured") await s.writeConfig({ defaults: { sessionPersistence: { enabled: false } } });
			else await s.writeConfig({ defaults: { model: "test/model", sessionPersistence: { enabled: false } } });
			const notify = vi.fn();
			const confirm = vi.fn().mockResolvedValue(true);
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, s.uiCtx());
			await writeFile(
				join(s.dir, ".lock"),
				JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "2026-10-02T01:02:03.000Z", op: "dream" }),
				"utf8",
			);
			await writeFile(join(s.dir, "keep.md"), "not a lock", "utf8");

			await commands["memory"].handler("unlock", s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

			// held 的锁：confirm 正文必须点名持有者（op / pid / hostname / startedAt）
			expect(confirm, boot).toHaveBeenCalledWith(
				"Memory lock",
				`Remove the memory lock file? It is held by dream (pid ${process.pid} on h, started 2026-10-02T01:02:03.000Z). Only do this if no memory operation is running.`,
			);
			expect(await readdir(s.dir), boot).not.toContain(".lock");
			expect(await readdir(s.dir), boot).toContain("keep.md");
			expect(notify, boot).toHaveBeenCalledWith("Memory lock removed.", "info");
		}
		await s.writeConfig({ defaults: { model: "test/model", sessionPersistence: { enabled: false } } });
	});

	// Plan E/next #1：`unlock` 不需要 store，但**解析目录本身**也可能失败（HOME 不可写、
	// git 探测炸了）。失败必须变成一条 error 通知与干净返回，不能冒泡成 handler 抛错。
	it("/memory unlock reports an unresolvable memory dir instead of throwing", async () => {
		await s.writeConfig({ defaults: { sessionPersistence: { enabled: false } } });
		const notify = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx()); // 配置错误：memoryDir 为 null
		// 目录解析本身炸了（HOME 不可写 / git 探测抛错）：§7.4 允许的一次性失败注入
		resolveMemoryDirMock.mockRejectedValueOnce(new Error("no writable home"));

		await expect(commands["memory"].handler("unlock", s.uiCtx(uiWith(notify)))).resolves.toBeUndefined();

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]).toEqual(["Failed to resolve memory dir: no writable home", "error"]);
	});

	it("/memory unlock leaves the lock alone when the user declines", async () => {
		for (const boot of ["healthy", "misconfigured"] as const) {
			if (boot === "misconfigured") await s.writeConfig({ defaults: { sessionPersistence: { enabled: false } } });
			else await s.writeConfig({ defaults: { model: "test/model", sessionPersistence: { enabled: false } } });
			const notify = vi.fn();
			const confirm = vi.fn().mockResolvedValue(false);
			const { pi, commands, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0]({}, s.uiCtx());
			await writeFile(
				join(s.dir, ".lock"),
				JSON.stringify({ pid: process.pid, hostname: "h", startedAt: "x", op: "dream" }),
				"utf8",
			);

			await commands["memory"].handler("unlock", s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

			// 取消路径也必须先把持有者摆到用户面前（否则“要不要删”无从判断）
			expect(confirm, boot).toHaveBeenCalledTimes(1);
			expect(confirm.mock.calls[0][0], boot).toBe("Memory lock");
			expect(confirm.mock.calls[0][1], boot).toContain(`held by dream (pid ${process.pid} on h, started x)`);
			expect(await readdir(s.dir), boot).toContain(".lock");
			expect(notify, boot).not.toHaveBeenCalled();
		}
		await s.writeConfig({ defaults: { model: "test/model", sessionPersistence: { enabled: false } } });
	});

	it("/memory unlock does not even ask when there is no lock", async () => {
		const notify = vi.fn();
		const confirm = vi.fn();
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		await commands["memory"].handler("unlock", s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(confirm).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("No lock present.", "info");
	});

	it("/memory unlock reports a failure instead of pretending the lock is gone", async () => {
		const notify = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const { pi, commands, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		// `.lock` 是一个非空目录：readLockStatus 报 unreadable，unlink 会失败
		await mkdir(join(s.dir, ".lock"), { recursive: true });
		await writeFile(join(s.dir, ".lock", "inner"), "x", "utf8");

		await commands["memory"].handler("unlock", s.uiCtx({ hasUI: true, ui: { notify, confirm, setStatus: vi.fn() } }));

		expect(confirm).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatch(/^Failed to remove memory lock: /);
		expect(notify.mock.calls[0][1]).toBe("error");
		expect(await readdir(join(s.dir, ".lock"))).toContain("inner");
	});

	// ── Plan D（D1）：配置错误启动的会话状态（unlock / 状态行）与跨 session 复位 ──────
	// Review Focus #5 / spec §19：`unlock` 只需要目录、不需要 store —— 以**配置错误**启动的
	// 会话也必须能清掉崩溃遗留的 `.lock`（R50：否则唯一的人工恢复入口本 session 不可达）。
});
