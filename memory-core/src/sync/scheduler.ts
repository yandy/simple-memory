/**
 * 写触发的去抖调度器：把「本地刚写过」收敛成「一轮推送」。
 *
 * **为什么触发源是写入，不是时钟。** 按固定间隔盲推，一个「写一条、14 分钟后结束」的会话
 * 可能一条都没推出去；而每次写入都推，则一轮整理记忆的任务重写了十几个条目，就会变成十几次
 * 提交与十几个网络往返。所以：任何一次成功的记忆写入都标脏，再用一段静默期把这一串合并成一次。
 * 逻辑锁还免费帮了一手 —— 整理记忆的那一轮全程持着项目的进程内锁，期间到点的推送会在应用段
 * 直接跳过，而定时器到点的时间在那一轮结束之后：一轮整理，一次推送。
 *
 * 这里只有三样东西：一个脏标记、一个待跑的去抖定时器、一个在途的 promise 串行闸。
 *
 * 两条宿主侧的硬要求在实现处各写了一段「为什么不能改」（`schedule` 里的 `unref`
 * 与 `noteWrite` 里的「已有定时器不重置」）；它们看起来都像可以顺手「优化」掉的多余代码。
 */

export interface SyncSchedulerOptions {
	/** 静默期：从**第一次**标脏起算。`0` 表示「下一个 tick 就推」。 */
	debounceMs: number;
	/** 一次推送的时限，原样交给 `run`。 */
	timeoutMs: number;
	/** 真正干活的一次推送。返回 `null` 表示本轮被跳过（锁忙、未配置……）。 */
	run: (timeoutMs: number) => Promise<unknown>;
	/**
	 * 调用方的时钟（毫秒）。
	 *
	 * 去抖只看定时器、不读时钟，所以它目前不参与任何决策；留着这个注入位是为了与引擎其它
	 * 可注入的时钟同形，将来要记「上一次推送的时间」时不必改签名。
	 */
	now?: () => number;
}

export interface SyncScheduler {
	/** 记下「本地刚写过」：置脏并排一次去抖推送。 */
	noteWrite(): void;
	/**
	 * 立刻执行一次（不等去抖），供退出兜底与补推用；没有在途/待推的工作则返回 `null`。
	 * `timeoutMs` 显式给出时覆盖配置的自动档时限。
	 */
	flush(timeoutMs?: number): Promise<unknown | null>;
	/** 取消定时器并丢弃脏标记。绝不抛错。 */
	dispose(): void;
	/** 在途的那一次推送（没有则 `null`）—— 宿主把它挂进自己的「退出前等在途写」账本。 */
	readonly inFlight: Promise<unknown> | null;
	/** 有尚未推送出去的写入。 */
	readonly dirty: boolean;
}

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
	const { debounceMs, timeoutMs, run } = options;

	/** 待跑的那一次（去抖定时器）。 */
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** 有尚未推送出去的写入。 */
	let dirty = false;
	/** 在途的那一次推送：既是串行闸，也是暴露给宿主的账本条目。 */
	let inFlight: Promise<unknown> | null = null;
	/** 收摊之后不再接新写入、也不再排定时器。 */
	let disposed = false;

	function cancelTimer(): void {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	}

	function schedule(): void {
		// 已有定时器就不重建：静默期从第一次写入起算，见 noteWrite
		if (disposed || timer !== null) return;
		timer = setTimeout(onTimer, debounceMs);
		/*
		 * 定时器必须 unref。ref 着的定时器会**吊住事件循环**：一个写完一条就关掉的进程，
		 * 退出会被硬拖到静默期到点为止（窗口里什么都没发生，就是退不掉）。宿主侧那个
		 * 「退出前等在途写」的兜底定时器出于同样的理由也做了这一步。
		 * 可选调用：宿主若把 core 打进非 Node 的运行时，那边的定时器没有 unref。
		 */
		timer.unref?.();
	}

	function onTimer(): void {
		timer = null;
		// 已有推送在跑：绝不起第二次。同一份远端暂存 clone 上两个并发 push 会互相
		// `reset --hard` 掉对方刚铺好的内容。脏标记留着，在途那一次收尾时重排（见 runNow）。
		if (inFlight !== null || !dirty) return;
		void runNow(timeoutMs);
	}

	/** 跑一次。调用方负责串行（本函数不做并发检查），成功后由收尾负责补排。 */
	function runNow(runTimeoutMs: number): Promise<unknown> {
		cancelTimer(); // 无论是定时器到点还是 flush 抢先，都不留待跑的那一个
		dirty = false;
		const started = (async () => {
			try {
				return await run(runTimeoutMs);
			} catch {
				/*
				 * 就地吞掉。后台推送的失败一旦冒泡成未处理拒绝，掀掉的是**宿主进程**，
				 * 而失败本身引擎已经处理了：基线不前进、脏状态留着、下一轮重试。
				 * 所以这里连一条日志都不打 —— 用户该看到的是状态报告，不是一行栈。
				 */
				return null;
			}
		})();
		inFlight = started;
		const settle = (): void => {
			if (inFlight === started) inFlight = null;
			// 跑的过程中又被标脏（比如整理记忆那一轮还在继续写）→ 收尾后再去抖一次
			if (dirty) schedule();
		};
		// 两个回调都给 settle：started 自己已经吞掉全部错误，派生出的 promise 也就不会拒
		void started.then(settle, settle);
		return started;
	}

	async function flush(runTimeoutMs?: number): Promise<unknown | null> {
		const budget = runTimeoutMs ?? timeoutMs;
		// flush 跑的是「此刻该跑的那一次」：先取消待跑的去抖定时器，别让它在同一份工作上空转
		cancelTimer();
		const running = inFlight;
		// 已有推送在跑时绝不并发起第二次，等它收尾
		if (running !== null) await running;
		// 等的时候另一个 flush 已经接手了一次（正常路径上不会发生，发生时不插一脚）
		if (inFlight !== null) return inFlight;
		if (!dirty) return running; // running 为 null 时就是「没活可干」
		return runNow(budget);
	}

	return {
		noteWrite(): void {
			if (disposed) return;
			dirty = true;
			/*
			 * 已有定时器就**不重置**。静默期要按第一次写入起算：若每次写入都刷新定时器，
			 * 一段持续的写入流（整理记忆、批量导入）会把推送无限延后 —— 那不去抖，是饿死。
			 * 反过来，用「最近一次写入 + 静默期」在当前实现里得不到任何好处：写入结束时
			 * 要么已经没有新写入（不重置也照样到点），要么还在写（重置只会更晚）。
			 */
			schedule();
		},
		flush,
		dispose(): void {
			// 绝不抛错：宿主在退出路径上调用它，那里再抛一次就是「退不掉」。
			// 在途的那一次不取消（也没有办法取消）：宿主的账本负责先等它。
			disposed = true;
			cancelTimer();
			dirty = false;
		},
		get inFlight(): Promise<unknown> | null {
			return inFlight;
		},
		get dirty(): boolean {
			return dirty;
		},
	};
}
