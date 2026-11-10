/**
 * index wiring — session_shutdown
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, DISK_INDEX, dirOverrideRef, dirRef, mockConfigValue, resetWiringMocks, runTaskMock, scanEntriesMock, uiCtx } from "./helpers/wiring-harness";
import memoryFactory from "../index";

describe("index wiring — session_shutdown", () => {
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

	it("session_shutdown waits for an in-flight extract", async () => {
		mockConfigValue.extractMemories.enabled = true;
		let release: (() => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ skipped: false, result: "ok" });
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		let settled = false;
		const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx()).then(
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);

		release?.();
		await shutdown;
		expect(settled).toBe(true);
	});

	it("session_shutdown gives up after lock.timeoutMs rather than hanging", async () => {
		mockConfigValue.extractMemories.enabled = true;
		mockConfigValue.lock = { timeoutMs: 30, snapshotKeep: 5 };
		runTaskMock.mockImplementationOnce(() => new Promise(() => {}));
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		const started = Date.now();
		await handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());

		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("session_shutdown resolves immediately when nothing is in flight", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());

		// 空闲路径的契约是「根本不创建 give-up 定时器」（index.ts：`inFlight.size === 0` 直接 return）。
		// fake timers 下：若回归成「先挂定时器再 race」，调用一返回 getTimerCount 就 > 0，且
		// `await` 会悬死在不会推进的 fake 定时器上；`getTimerCount() === 0` 直接钉住「不挂 timer」。
		vi.useFakeTimers();
		try {
			const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());
			expect(vi.getTimerCount()).toBe(0);
			await shutdown;
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the shutdown give-up timer when the in-flight write finishes first", async () => {
		mockConfigValue.extractMemories.enabled = true;
		mockConfigValue.lock = { timeoutMs: 30, snapshotKeep: 5 };
		let release: (() => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ skipped: true });
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, uiCtx());

		vi.useFakeTimers();
		try {
			const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, uiCtx());
			// 兜底定时器已挂上（在途任务还没收尾）
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			release?.();
			await shutdown;
			// race 由 in-flight 胜出：定时器不能继续挂在事件循环上（会拖长进程退出）
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
