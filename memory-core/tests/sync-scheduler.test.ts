import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncScheduler, type SyncSchedulerOptions } from "../src/sync/scheduler.js";

/**
 * 写触发去抖调度器：只测「什么时候调 run、调几次、会不会并发、错误会不会冒出来」。
 * 真正的推送由引擎负责，这里一律用假的 `run`，时间一律用假定时器。
 */

const DEBOUNCE = 5000;
const TIMEOUT = 1000;

interface Fixture {
	run: ReturnType<typeof vi.fn>;
	scheduler: ReturnType<typeof createSyncScheduler>;
}

function setup(over: Partial<SyncSchedulerOptions> = {}): Fixture {
	const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => "pushed");
	const scheduler = createSyncScheduler({ debounceMs: DEBOUNCE, timeoutMs: TIMEOUT, run, ...over });
	return { run, scheduler };
}

/** 手动闸门：卡住一次 `run`，用来观察「在途期间再写入」的行为。 */
function gate(): { promise: Promise<void>; open(): void } {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = () => resolve();
	});
	return { promise, open };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("createSyncScheduler", () => {
	it("一次写入 → debounceMs 之后跑一次 run", async () => {
		const { run, scheduler } = setup();
		scheduler.noteWrite();
		expect(run).not.toHaveBeenCalled();
		expect(scheduler.dirty).toBe(true);

		await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
		expect(run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith(TIMEOUT); // 时限原样转给 run
		expect(scheduler.dirty).toBe(false); // 跑起来就清脏，等在途的结果说话
		expect(() => scheduler.dispose()).not.toThrow(); // 跑完之后收摊也不抛
	});

	it("静默期内的多次写入合并成一次（一轮 dream 写十几个文件 → 一次推送）", async () => {
		const { run, scheduler } = setup();
		scheduler.noteWrite();
		scheduler.noteWrite();
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);

		// 静默期从**第一次**写入起算：第二批写在静默期中间到达，也不得把推送推到 10s 之后
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(2);

		// 连续写入一路拖下去也不会攒出第二个定时器：停手之后不会再冒出来一次
		await vi.advanceTimersByTimeAsync(4 * DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("写入间隔大于 debounceMs → 各推一次", async () => {
		const { run, scheduler } = setup();
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(6000);
		expect(run).toHaveBeenCalledTimes(1);

		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(6000);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("run 抛错不冒泡、不留脏定时器；下一次 noteWrite 仍能推", async () => {
		let calls = 0;
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			calls += 1;
			if (calls === 1) throw new Error("push failed: simulated transport error");
			return "pushed";
		});
		const { scheduler } = setup({ run });

		scheduler.noteWrite();
		// 这一行能正常返回本身就说明失败没冒泡：后台推送的拒绝一旦逃出去，
		// 就会以未处理拒绝的形式掀掉宿主进程，而不是失败一次推送
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduler.inFlight).toBeNull();

		// 失败之后没有残留的定时器：再等几个静默期也不会自己重跑（重试是下一次写入的事）
		expect(scheduler.dirty).toBe(false);
		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);

		// 脏状态没被卡住：下一次写入照常推，而且推的是新的一次
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(2);

		// flush 走同一条吞错路径：退出兜底时抛错最不可接受（那里没人接得住）
		const alwaysFails = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			throw new Error("publish failed: simulated transport error");
		});
		const { scheduler: failing } = setup({ run: alwaysFails });
		failing.noteWrite();
		expect(await failing.flush()).toBeNull();
		expect(alwaysFails).toHaveBeenCalledTimes(1);
		expect(failing.inFlight).toBeNull();
	});

	it("run 进行中再 noteWrite → 结束后再推一次（不并发跑两个 run）", async () => {
		const held = gate();
		let active = 0;
		let maxActive = 0;
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			// 第一跑卡住，之后的每跑直接返回
			if (active === 1) await held.promise;
			active -= 1;
			return "pushed";
		});
		const { scheduler } = setup({ run });

		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduler.inFlight).not.toBeNull(); // 宿主的「退出前等在途写」账本要能看见它

		// 在途期间又写了一次：定时器到点时不得起第二个 run
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);
		expect(maxActive).toBe(1);

		// 放行在途那一跑 → 收尾时因脏标记重排 → 静默期到点再推一次
		held.open();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(1); // 两跑始终串行
		expect(scheduler.inFlight).toBeNull();
		expect(scheduler.dirty).toBe(false);
	});

	it("flush 立即跑一次并返回结果；不脏时返回 null 且不调 run", async () => {
		const { run, scheduler } = setup();

		expect(await scheduler.flush()).toBeNull(); // 没活可干 → 连 run 都不调
		expect(run).not.toHaveBeenCalled();

		scheduler.noteWrite();
		expect(await scheduler.flush()).toBe("pushed"); // 不等去抖，结果原样透出
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith(TIMEOUT);

		// 待跑的去抖定时器已被 flush 接管：再等一整个静默期也不会重复推一次
		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);

		// 退出兜底时显式给时限，覆盖配置的自动档
		scheduler.noteWrite();
		expect(await scheduler.flush(1234)).toBe("pushed");
		expect(run).toHaveBeenLastCalledWith(1234);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("dispose 取消待跑的推送，且 inFlight 归 null", async () => {
		const { run, scheduler } = setup();
		scheduler.noteWrite();
		expect(scheduler.dirty).toBe(true);

		scheduler.dispose();
		expect(scheduler.dirty).toBe(false);
		expect(scheduler.inFlight).toBeNull();

		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).not.toHaveBeenCalled();

		// 收摊可以重复调用，还可以在「什么都没发生」的状态下调用（退出路径上不能抛）
		expect(() => scheduler.dispose()).not.toThrow();
		expect(() => scheduler.dispose()).not.toThrow();

		// 收摊之后的写入不再排定时器：宿主已经不再等人了
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).not.toHaveBeenCalled();
	});

	it("★ 定时器不吊住进程：debounce 定时器必须 unref", () => {
		// 真句柄才能问出 ref 状态（假定时器给的是 sinon 自己造的对象），所以这一条用真定时器
		vi.useRealTimers();
		const realSetTimeout = globalThis.setTimeout;
		let handle: ReturnType<typeof setTimeout> | null = null;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
			handle = realSetTimeout(fn, ms);
			return handle;
		}) as typeof setTimeout);

		const { run, scheduler } = setup();
		scheduler.noteWrite();
		vi.restoreAllMocks();

		expect(handle).not.toBeNull();
		// unref 过的句柄不参与事件循环的存活判定：少这一行，一个「写一条就关掉」的进程
		// 要白等一整个静默期才退得掉
		expect((handle as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
		expect(scheduler.dirty).toBe(true); // 定时器确实排上了，只是不吊住循环

		scheduler.dispose();
		expect(scheduler.dirty).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("debounceMs 为 0 → 下一个 tick 就推（仍不并发）", async () => {
		const held = gate();
		let active = 0;
		let maxActive = 0;
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			if (active === 1) await held.promise;
			active -= 1;
			return "pushed";
		});
		const { scheduler } = setup({ run, debounceMs: 0 });

		scheduler.noteWrite();
		expect(run).not.toHaveBeenCalled(); // 同步调用里不跑：推到下一个 tick
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);

		// 在途期间连写两次 → 只排一个定时器，到点时在途那跑还没结束 → 不起第二个 run
		scheduler.noteWrite();
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);
		expect(maxActive).toBe(1);

		held.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(2); // 收尾后补推的那一次
		expect(maxActive).toBe(1);
	});
});
