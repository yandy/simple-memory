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

		// 失败的那一轮**不算发布**：内容仍然只在本地，对外必须还是「有待发布」，
		// 否则宿主退出前问一句「还有没有没推出去的」会得到「没有」
		expect(scheduler.dirty).toBe(true);
		// 但失败之后没有残留的定时器：再等几个静默期也不会自己重跑
		// （重试只有两个入口：下一次写入、宿主显式 flush）
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
		expect(failing.dirty).toBe(true); // flush 自己那一轮也失败了 → 仍然不算干净
		failing.dispose();
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

	it("★ run 返回 null（本轮被跳过/失败）→ 对外仍算「有待发布」，flush 会再跑一次", async () => {
		// 钉住的是「退出兜底不得谎报干净」：撞上锁而被跳过的一轮，内容一个字节都没出去，
		// 它必须在 flush 时被重试，而不是被算成「已经推过了」
		let publishes = false;
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => (publishes ? "pushed" : null));
		const { scheduler } = setup({ run });

		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduler.dirty).toBe(true); // 白跑一轮 ≠ 干净
		expect(scheduler.inFlight).toBeNull();

		// 但**不因未发布而自动重排**：远端持续不可达时，自动重排就是每 debounceMs 一次的重试风暴
		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);

		// 补推的第一个入口：宿主显式 flush（退出兜底 / 下次会话补推）
		expect(await scheduler.flush()).toBeNull(); // 这一次仍然没发布成功
		expect(run).toHaveBeenCalledTimes(2);
		expect(scheduler.dirty).toBe(true); // 还是没推出去，读数不许变
		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(2); // 依然不自动重排

		// 真发布成功之后才算干净
		publishes = true;
		expect(await scheduler.flush()).toBe("pushed");
		expect(run).toHaveBeenCalledTimes(3);
		expect(scheduler.dirty).toBe(false);
		expect(await scheduler.flush()).toBeNull(); // 干净了 → 连 run 都不调
		expect(run).toHaveBeenCalledTimes(3);

		// 收摊把「没发布成功」这个标记一起丢掉：宿主已经明说不再等了
		publishes = false;
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(scheduler.dirty).toBe(true);
		scheduler.dispose();
		expect(scheduler.dirty).toBe(false);
		expect(await scheduler.flush()).toBeNull();
	});

	it("★ run 失败（reject）与返回 null 同义：置起未发布标记，且不产生未处理拒绝", async () => {
		const onUnhandled = vi.fn();
		process.on("unhandledRejection", onUnhandled);
		try {
			let fails = true;
			const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
				if (fails) throw new Error("publish failed: simulated transport error");
				return "pushed";
			});
			const { scheduler } = setup({ run });

			scheduler.noteWrite();
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(run).toHaveBeenCalledTimes(1);
			expect(scheduler.dirty).toBe(true); // reject 也不算发布
			expect(scheduler.inFlight).toBeNull();
			await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
			expect(run).toHaveBeenCalledTimes(1); // 同样不自动重排

			fails = false;
			expect(await scheduler.flush()).toBe("pushed"); // 退出兜底把它补上
			expect(scheduler.dirty).toBe(false);

			// 未处理拒绝要等一个**真的**事件循环回合才会露出来，假定时器不给这一回合
			vi.useRealTimers();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(onUnhandled).not.toHaveBeenCalled();
			scheduler.dispose();
		} finally {
			process.off("unhandledRejection", onUnhandled);
			vi.useRealTimers();
		}
	});

	it("flush 不把「调用时恰好在途的那一轮」的结果当成自己的返回值", async () => {
		const held = gate();
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			await held.promise;
			return "in-flight-round";
		});
		const { scheduler } = setup({ run });
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(scheduler.inFlight).not.toBeNull();

		// 宿主问的是「我还有没有没推出去的」：拿一个它没要求过的轮次的结果回答，
		// 等于把「那一轮成功了」冒充成「现在干净了」
		const flushed = scheduler.flush();
		held.open();
		expect(await flushed).toBeNull();
		expect(run).toHaveBeenCalledTimes(1); // 等它收尾，但绝不并发起第二轮
		expect(scheduler.dirty).toBe(false); // 那一轮确实发布了，所以现在真干净
	});

	it("flush 等在途那一轮收尾后，若它没发布成功则接着补一轮，并报自己那一轮的结果", async () => {
		const held = gate();
		let skipNext = true;
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			if (skipNext) {
				skipNext = false;
				await held.promise;
				return null; // 撞上锁被跳过
			}
			return "flush-round";
		});
		const { scheduler } = setup({ run });
		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		const flushed = scheduler.flush();
		held.open();
		// 报出去的是 flush 自己那一轮，不是被跳过的那一轮（那一轮的结果是 null）
		expect(await flushed).toBe("flush-round");
		expect(run).toHaveBeenCalledTimes(2);
		expect(scheduler.dirty).toBe(false);
	});

	it("泛型：flush 的返回值就是 run 的结果类型，调用方不必向下转型", async () => {
		interface Round {
			readonly pushed: string[];
		}
		const run = vi.fn(async (_timeoutMs: number): Promise<Round | null> => ({ pushed: ["A.md"] }));
		const scheduler = createSyncScheduler<Round>({ debounceMs: DEBOUNCE, timeoutMs: TIMEOUT, run });
		scheduler.noteWrite();
		// 这两行能编译过就是断言本身：`result` 是 `Round | null`，不是 `unknown`
		const result = await scheduler.flush();
		expect(result?.pushed).toEqual(["A.md"]);
		expect(run).toHaveBeenCalledWith(TIMEOUT);
		// 在途的那一份同样带类型（宿主只等它，不读它）
		expect(scheduler.inFlight satisfies Promise<Round | null> | null).toBeNull();
		scheduler.dispose();
	});

	it("收尾里重排定时器抛错也不产生未处理拒绝（收尾整个包在 try 里）", async () => {
		// 用真定时器：要观察的是「异常从被 void 掉的 promise 里逃出去」这种真事件循环行为
		vi.useRealTimers();
		const realSetTimeout = globalThis.setTimeout;
		const wait = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));
		const onUnhandled = vi.fn();
		process.on("unhandledRejection", onUnhandled);
		/** 只在「放行在途那一轮之后」开闸：那之后的排定时器只可能来自收尾 */
		let boom = false;
		let threw = false;
		try {
			const held = gate();
			const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
				await held.promise;
				return "pushed";
			});
			vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
				if (boom) {
					threw = true;
					throw new Error("setTimeout unavailable: simulated");
				}
				return realSetTimeout(fn, ms);
			}) as typeof setTimeout);

			const { scheduler } = setup({ run, debounceMs: 5 });
			scheduler.noteWrite();
			scheduler.noteWrite(); // 定时器还在 → 不重排
			await wait(20);
			expect(run).toHaveBeenCalledTimes(1);
			scheduler.noteWrite(); // 在途期间又写了一次 → 脏标记留给收尾去重排
			await wait(20); // 让那一次排的定时器到点空转（在途未完 → 不起第二轮，timer 归 null）
			boom = true; // 从此以后任何排定时器都炸：收尾那一次必然撞上
			held.open();
			await wait(20);

			expect(threw).toBe(true); // 变异验证的自检：确实走到了「收尾里排定时器抛错」这条路
			expect(run).toHaveBeenCalledTimes(1); // 重排没成 → 没有第二次推送，但绝不掀掉宿主进程
			await wait(5);
			expect(onUnhandled).not.toHaveBeenCalled();
			scheduler.dispose();
		} finally {
			vi.restoreAllMocks();
			process.off("unhandledRejection", onUnhandled);
			vi.useRealTimers();
		}
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

	it("★dispose 撞在在途那一轮上：它失败也不得把「有待发布」置回来，收摊后的 flush 不启新 I/O", async () => {
		// dispose-while-in-flight 是被显式支持的（宿主退出时正是这个形状：引擎先 abort 那一轮的信号，
		// 再转发 dispose）。那一轮因此多半以「没发布成功」收尾，而收尾会试图把 `unpublished` 置起来 ——
		// 置起来了，收摊之后的 `dirty` 就还报「有东西没推出去」，而一次 `flush()` 会启动**全新的**推送 I/O。
		const g = gate();
		// 这一轮永远失败：被 dispose 中止的那一轮正是以「没发布成功」收尾的
		const run = vi.fn(async (_timeoutMs: number): Promise<unknown> => {
			await g.promise;
			throw new Error("aborted by dispose");
		});
		const scheduler = createSyncScheduler({ debounceMs: DEBOUNCE, timeoutMs: TIMEOUT, run });

		scheduler.noteWrite();
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduler.inFlight).not.toBeNull();

		scheduler.dispose(); // 在途时就收摊
		expect(scheduler.dirty).toBe(false);
		g.open(); // 那一轮此刻才收尾（失败）
		const settled = scheduler.inFlight;
		if (settled !== null) await settled;
		await vi.advanceTimersByTimeAsync(0);

		// 载重：失败的那一轮没有把标记置回来，收摊之后一律报干净
		expect(scheduler.dirty).toBe(false);
		expect(run).toHaveBeenCalledTimes(1); // 收尾也没有重排一次
		// 载重：收摊后的 flush 不启动新的推送（宿主退出路径上问的就是这一句）
		expect(await scheduler.flush()).toBeNull();
		expect(await scheduler.flush(TIMEOUT)).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5 * DEBOUNCE);
		expect(run).toHaveBeenCalledTimes(1);
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
