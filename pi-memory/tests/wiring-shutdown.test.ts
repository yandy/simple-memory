/**
 * index wiring — session_shutdown
 *
 * harness 必须排在本文件其他 import 之前：它注册了 `vi.mock`，顺序错了 mock 不生效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePi, resetWiringMocks, runTaskMock, setupSession, uiCtx } from "./helpers/wiring-harness";
import memoryFactory from "../index";
import { loadConfig } from "../src/config";


describe("index wiring — session_shutdown", () => {
	let s: Awaited<ReturnType<typeof setupSession>>;

	beforeEach(async () => {
		s = await setupSession();
		resetWiringMocks();
	});

	afterEach(async () => {
		await s.cleanup();
	});

	it("setupSession writes a memory.json that the real loadConfig reads", async () => {
		// 这条钉住 C 阶段的核心机制：配置来自磁盘上真实的 memory.json（经 PI_CODING_AGENT_DIR），
		// 不是另一个手写对象。它同时是 harness 的分派开关自检（setupSession 之后 loadConfig 走真实实现）。
		const s = await setupSession();
		try {
			const { loadConfig } = await import("../src/config");
			const loaded = await loadConfig({ cwd: s.cwd, isProjectTrusted: () => true });
			expect(loaded.config.memoryDir).toBe(s.memoryDirRoot);
			expect(loaded.config.defaults?.model).toBe("test/model");
		} finally {
			await s.cleanup();
		}
	});

	it("session_shutdown waits for an in-flight extract", async () => {
		await s.writeConfig({ extractMemories: { enabled: true } });
		let release: (() => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ skipped: false, result: "ok" });
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, s.uiCtx());

		let settled = false;
		const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, s.uiCtx()).then(
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
		await s.writeConfig({ extractMemories: { enabled: true } });
		await s.writeConfig({ lock: { timeoutMs: 30, snapshotKeep: 5 } });
		runTaskMock.mockImplementationOnce(() => new Promise(() => {}));
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, s.uiCtx());

		const started = Date.now();
		await handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, s.uiCtx());

		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("session_shutdown resolves immediately when nothing is in flight", async () => {
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());

		// 空闲路径的契约是「根本不创建 give-up 定时器」（index.ts：`inFlight.size === 0` 直接 return）。
		// fake timers 下：若回归成「先挂定时器再 race」，调用一返回 getTimerCount 就 > 0，且
		// `await` 会悬死在不会推进的 fake 定时器上；`getTimerCount() === 0` 直接钉住「不挂 timer」。
		vi.useFakeTimers();
		try {
			const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, s.uiCtx());
			expect(vi.getTimerCount()).toBe(0);
			await shutdown;
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the shutdown give-up timer when the in-flight write finishes first", async () => {
		await s.writeConfig({ extractMemories: { enabled: true } });
		await s.writeConfig({ lock: { timeoutMs: 30, snapshotKeep: 5 } });
		let release: (() => void) | undefined;
		runTaskMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ skipped: true });
				}),
		);
		const { pi, handlers } = createFakePi();
		memoryFactory(pi as any);
		await handlers["session_start"][0]({}, s.uiCtx());
		await handlers["agent_end"][0]({ messages: [{ role: "user", content: "hi" }] }, s.uiCtx());

		vi.useFakeTimers();
		try {
			const shutdown = handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" }, s.uiCtx());
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
