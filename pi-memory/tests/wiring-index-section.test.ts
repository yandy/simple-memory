/**
 * index wiring — memory_index section
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, DISK_INDEX, legacyEvent, readRecordedMemoryIndexMock, resetWiringMocks, runTaskMock, scanEntriesMock, sectionsEvent, setupSession, uiCtx } from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { INDEX_TRUNCATION_MARKER } from "@yandy0725/memory-core";


describe("index wiring — memory_index section", () => {
	let s: Awaited<ReturnType<typeof setupSession>>;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
	});

	afterEach(async () => {
		await s.cleanup();
	});

	it("writes the memory_index section on every turn and freezes it byte-for-byte", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, s.uiCtx());
		expect(first.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);

		// 会话中途磁盘上的索引被改了（另一个 worktree 写入）：注入值必须逐字节不变
		await writeFile(join(s.dir, "MEMORY.md"), "- [SSH](ssh.md) — changed\n", "utf8");
		const second = sectionsEvent();
		const result = await handlers["before_agent_start"][0](second, s.uiCtx());

		expect(second.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
		expect(second.systemPromptOptions.sections["memory_index"]).not.toContain("changed");
		// 走 sections 路径时不再返回 systemPrompt（避免全量替换从 position 0 打断缓存）
		expect(result?.systemPrompt).toBeUndefined();
	});

	// 端到端钉住「session_start 用的是**注入**口径」：一行 swap 就会落在写入口径（200/25600）上，
	// 那时 60 条索引会整份注入，下面的 50 条断言就会红。
	it("injects only the newest 50 lines of a long index at session_start", async () => {
		const entries = Array.from({ length: 60 }, (_, i) => `- [M${i}](m${i}.md) — d${i}`);
		await writeFile(join(s.dir, "MEMORY.md"), `# Memory Index\n\n${entries.join("\n")}\n`, "utf8");
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, s.uiCtx());
		const section = event.systemPromptOptions.sections["memory_index"] as string;

		expect(section.split("\n")[0]).toBe(INDEX_TRUNCATION_MARKER);
		expect((section.match(/^- \[/gm) ?? []).length).toBe(50);
		expect(section).toContain("- [M10](m10.md)");
		expect(section).not.toContain("- [M9](m9.md)");
	});

	// compaction 是会话内唯一的刷新点：那里也必须用注入口径（同一个窗口核心）。
	it("re-reads the same inject window at session_compact", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const entries = Array.from({ length: 60 }, (_, i) => `- [M${i}](m${i}.md) — d${i}`);
		await writeFile(join(s.dir, "MEMORY.md"), `# Memory Index\n\n${entries.join("\n")}\n`, "utf8");
		await handlers["session_compact"][0]({ type: "session_compact", reason: "manual" }, s.uiCtx());

		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, s.uiCtx());
		const section = event.systemPromptOptions.sections["memory_index"] as string;

		expect(section.split("\n")[0]).toBe(INDEX_TRUNCATION_MARKER);
		expect((section.match(/^- \[/gm) ?? []).length).toBe(50);
	});

	// Review Focus #1：省略该键 = pi 生成 { memory_index: null } = 索引被静默删除。
	// 三种「用录制值」的 reason 也必须每轮把键写回去。
	it("sets the section for every session_start reason", async () => {
		for (const reason of ["startup", "new", "resume", "fork", "reload", undefined]) {
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);
			await handlers["session_start"][0](reason ? { reason } : {}, s.uiCtx());

			const first = sectionsEvent();
			await handlers["before_agent_start"][0](first, s.uiCtx());
			const second = sectionsEvent();
			await handlers["before_agent_start"][0](second, s.uiCtx());

			expect(Object.keys(first.systemPromptOptions.sections), reason).toEqual(["memory_index"]);
			expect(Object.keys(second.systemPromptOptions.sections), reason).toEqual(["memory_index"]);
			expect(second.systemPromptOptions.sections["memory_index"], reason).toBe(DISK_INDEX);
		}
	});

	it("uses the recorded index for resume/fork/reload and never reads the disk", async () => {
		for (const reason of ["resume", "fork", "reload"]) {
			await writeFile(join(s.dir, "MEMORY.md"), "- [DISK](disk.md) — from disk\n", "utf8");
			readRecordedMemoryIndexMock.mockReturnValue("- [SSH](ssh.md) — recorded\n");
			const sessionManager = { getEntries: () => [], getLeafId: () => null };
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);

			await handlers["session_start"][0]({ reason }, s.uiCtx({ sessionManager }));
			const event = sectionsEvent();
			await handlers["before_agent_start"][0](event, s.uiCtx({ sessionManager }));

			expect(readRecordedMemoryIndexMock, reason).toHaveBeenCalledWith(sessionManager);
			expect(event.systemPromptOptions.sections["memory_index"], reason).toBe("- [SSH](ssh.md) — recorded\n");
			expect(event.systemPromptOptions.sections["memory_index"], reason).not.toContain("DISK");
			readRecordedMemoryIndexMock.mockReturnValue(null);
		}
	});

	it("reads the disk for startup/new instead of replaying the transcript", async () => {
		for (const reason of ["startup", "new", undefined]) {
			const { pi, handlers } = createFakePi();
			memoryFactory(pi as any);

			await handlers["session_start"][0](reason ? { reason } : {}, s.uiCtx());

			expect(readRecordedMemoryIndexMock, String(reason)).not.toHaveBeenCalled();
		}
	});

	// Finding 1 / R42：0.99.2 宿主把每个 non-preamble section 渲染成
	// `<memory_index>\n<裸值>\n</memory_index>` 后才写进 transcript，重放拿到的是**带标签**的值。
	// 端到端保真 = 冻结值等于原始裸串，且宿主再渲染一次逐字节等于录制值（不产生新 patch）。
	it("freezes the bare recorded index after resume and never produces a new patch", async () => {
		const raw = "- [SSH](ssh.md) — staging ssh config\n";
		const recorded = `<memory_index>\n${raw}\n</memory_index>`;
		const sessionManager = {
			getEntries: () => [
				{ type: "message", message: { role: "system", content: "", sections: { memory_index: recorded } } },
			],
			getLeafId: () => "leaf-1",
		};

		// 本文件把 index-source 整个 mock 了；这里用真实实现（注入 converter 替代 0.80.2 缺失的
		// SDK 导出），走完「重放 → 脱壳 → 冻结 → 回写」全程。
		const actual = await vi.importActual<typeof import("../src/index-source")>("../src/index-source");
		readRecordedMemoryIndexMock.mockImplementation((sm: unknown) =>
			actual.readRecordedMemoryIndex(sm, {
				sessionEntryToContextMessages: (e: unknown) => [(e as { message: unknown }).message],
			}),
		);

		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({ reason: "resume" }, s.uiCtx({ sessionManager }));

		const ctx = s.uiCtx({ sessionManager });
		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, ctx);
		const frozen = first.systemPromptOptions.sections["memory_index"];

		expect(frozen).toBe(raw);
		// 宿主渲染 = 录制值：头部字节恒等，resume 第一轮没有 patch（D13/D14）
		expect(`<memory_index>\n${frozen}\n</memory_index>`).toBe(recorded);

		const second = sectionsEvent();
		await handlers["before_agent_start"][0](second, ctx);
		expect(second.systemPromptOptions.sections["memory_index"]).toBe(frozen);
	});

	// Review Focus #3：重放拿不到录制值 → 回退磁盘，而不是把索引丢掉。
	it("falls back to the disk index when no recorded value is available", async () => {
		readRecordedMemoryIndexMock.mockReturnValue(null);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);

		await handlers["session_start"][0]({ reason: "resume" }, s.uiCtx());
		const event = sectionsEvent();
		await handlers["before_agent_start"][0](event, s.uiCtx());

		expect(readRecordedMemoryIndexMock).toHaveBeenCalledTimes(1);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
	});

	it("falls back to { systemPrompt } when the host SDK exposes no sections", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const event = legacyEvent();
		const result = await handlers["before_agent_start"][0](event, s.uiCtx());

		expect(result?.systemPrompt).toBe(`BASE_PROMPT\n\n${DISK_INDEX}`);
		expect((event.systemPromptOptions as any).sections).toBeUndefined();
	});

	it("injects an empty section value instead of dropping the key", async () => {
		await writeFile(join(s.dir, "MEMORY.md"), "", "utf8");
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const event = sectionsEvent();
		const result = await handlers["before_agent_start"][0](event, s.uiCtx());

		expect(Object.keys(event.systemPromptOptions.sections)).toEqual(["memory_index"]);
		expect(event.systemPromptOptions.sections["memory_index"]).toBe("");
		expect(result?.systemPrompt).toBeUndefined();
	});

	// D14：compaction 是唯一的会话内刷新点，同时清空已注入集合。
	it("session_compact re-reads the index from disk and clears injectedFiles", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		scanEntriesMock.mockResolvedValue([
			{ file: "ssh.md", name: "SSH", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		const injectedAtCall: Array<Set<string>> = [];
		runTaskMock.mockImplementation(async (...args: any[]) => {
			injectedAtCall.push(new Set(args[1].injectedFiles));
			return { files: ["ssh.md"], content: "<relevant_memories>\n## SSH\nx\n</relevant_memories>" };
		});

		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, s.uiCtx());
		expect(injectedAtCall[0]).toEqual(new Set());

		await writeFile(join(s.dir, "MEMORY.md"), "# Memory Index\n\n- [New](new.md) — after compact\n", "utf8");
		await handlers["session_compact"][0]({ type: "session_compact", reason: "manual" }, s.uiCtx());

		const second = sectionsEvent();
		await handlers["before_agent_start"][0](second, s.uiCtx());

		expect(second.systemPromptOptions.sections["memory_index"]).toBe(
			"# Memory Index\n\n- [New](new.md) — after compact\n",
		);
		expect(injectedAtCall[1]).toEqual(new Set());
	});

	it("refreshes the index on session_compact only — no other event may", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		const first = sectionsEvent();
		await handlers["before_agent_start"][0](first, s.uiCtx());

		await writeFile(join(s.dir, "MEMORY.md"), "- [Changed](c.md) — changed\n", "utf8");
		await handlers["agent_end"][0]({ messages: [] }, s.uiCtx());
		await handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, s.uiCtx());
		const second = sectionsEvent();
		await handlers["before_agent_start"][0](second, s.uiCtx());

		expect(second.systemPromptOptions.sections["memory_index"]).toBe(DISK_INDEX);
		expect(Object.keys(handlers).sort()).toEqual([
			"agent_end",
			"before_agent_start",
			"session_compact",
			"session_shutdown",
			"session_start",
		]);
	});
});
