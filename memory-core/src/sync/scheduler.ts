/**
 * 写触发的去抖调度器：把「本地刚写过」收敛成「一轮推送」。
 *
 * **为什么触发源是写入，不是时钟。** 按固定间隔盲推，一个「写一条、14 分钟后结束」的会话
 * 可能一条都没推出去；而每次写入都推，则一轮整理记忆的任务重写了十几个条目，就会变成十几次
 * 提交与十几个网络往返。所以：任何一次成功的记忆写入都标脏，再用一段静默期把这一串合并成一次。
 * 逻辑锁还免费帮了一手 —— 整理记忆的那一轮全程持着项目的进程内锁，期间到点的推送会在应用段
 * 直接跳过，而定时器到点的时间在那一轮结束之后：一轮整理，一次推送。
 *
 * 这里只有四样东西：一个脏标记、一个「上一轮没发布成功」的标记、一个待跑的去抖定时器、
 * 一个在途的 promise 串行闸。
 *
 * **对外的 `dirty` 读数是「有内容尚未成功发布」，不是「定时器还没到点」。** 一轮推送完全可能白跑
 * （撞上锁被跳过、远端不可达、传输失败），那种情况下内容仍然只在本地；若把它算成干净，宿主退出前
 * 问一句「还有没有没推出去的」会得到「没有」，那几条记忆就再也没有自动补推的机会 —— 内容没丢，
 * 但触发器丢了，只能等下一次写入或下一次会话的补推。
 *
 * 四条宿主侧的硬要求在实现处各写了一段「为什么不能改」（`schedule` 里的 `unref`、`noteWrite` 里的
 * 「已有定时器不重置」、`settle` 里的「不因未发布而自动重排」与「整个收尾包在 try 里」）；
 * 它们看起来都像可以顺手「优化」掉的多余代码。
 */

export interface SyncSchedulerOptions<T = unknown> {
	/** 静默期：从**第一次**标脏起算。`0` 表示「下一个 tick 就推」。 */
	debounceMs: number;
	/** 一次推送的时限，原样交给 `run`。 */
	timeoutMs: number;
	/**
	 * 真正干活的一次推送。**返回 `null` 或 reject 都表示「这一次没有发布成功」**（被锁跳过、传输失败、
	 * 未配置……），调度器据此保留「有内容待发布」的读数。
	 *
	 * 所以调用方必须自己把「跳过或失败的一轮」映射成 `null`：引擎那边一轮同步永远 resolve 出一个结果
	 * 对象（失败也写在 `skipped.reason` 里，从不 reject），原样交过来的话调度器看到的就是「永远成功」，
	 * 于是退出兜底会谎报干净。
	 */
	run: (timeoutMs: number) => Promise<T | null>;
	/*
	 * 这里刻意**没有**时钟注入位。去抖只靠定时器，没有任何一处决策要读时间；留一个没人读的
	 * `now?` 只会让调用方以为时间语义可注入（进而以为可以在测试里拨快静默期）。
	 */
}

/**
 * 泛型 `T` 是「一轮推送的结果」，由调用方定义。带上它是为了让引擎那一侧不必写
 * `scheduler.flush(t) as Promise<SyncRoundResult | null>` —— 那个向下转型是这道接缝上唯一
 * 一处「编译器不再帮忙」的地方。
 */
export interface SyncScheduler<T = unknown> {
	/** 记下「本地刚写过」：置脏并排一次去抖推送。收摊之后空转。 */
	noteWrite(): void;
	/**
	 * 立刻执行一次（不等去抖），供退出兜底与启动补推用。`timeoutMs` 显式给出时覆盖配置的自动档时限。
	 *
	 * 返回 `null` 的**四种**情形，按控制流顺序：
	 * （1）调度器已经 `dispose()` —— 这一条**立刻**返回，**不等** `inFlight`（收摊之后谁都不等，
	 * 也不启动任何新的推送 I/O）；
	 * （2）调用时有在途的一轮（见下）：等它收尾，而等的过程中**又**起了一轮（另一个 `flush`，或去抖
	 * 定时器到点）→ 返回 `null`，既不插一脚，也**不冒领**那一轮的结果（它成功也照样是 `null`）；
	 * （3）没有在途轮次、或等它收尾之后没有新的在途轮次，且 `dirty` 与 `unpublished` 都为空
	 * → 没有待发布的内容，连 `run` 都不调，返回 `null`；
	 * （4）本次自己跑的那一轮也没发布成功（`run` 返回 `null` 或 reject）。
	 * **`null` 从不表示成功**，只是「本次没有可回报的结果」；成败要看返回值本身。
	 * **绝不把「调用时恰好在途的那一轮」的结果当作本次的返回值**：宿主问的是「我还有没有没推出去的」，
	 * 拿一个它没要求过的轮次的结果回答，等于把「那一轮成功了」冒充成「现在干净了」。情形（2）里
	 * 连「那一轮成功了」都不回报，是同一条理由：它不是本次 flush 发起的那一轮。
	 * 除 `dispose()` 那一情形之外，flush 会等那一轮收尾（绝不并发）；收尾之后若没有新的在途轮次，
	 * 且仍有待发布内容，就接着跑属于自己的那一轮并报它的结果。
	 */
	flush(timeoutMs?: number): Promise<T | null>;
	/**
	 * 取消定时器并丢弃「尚未发布」的两个标记。绝不抛错。可重复调用。
	 *
	 * 在途的那一次不在这里取消（调度器够不到传输层）：取消由调用方做 —— 引擎的 `dispose()`
	 * 会先 abort 那一轮的中止信号，再转发到这里。
	 */
	dispose(): void;
	/**
	 * 在途的那一次推送（没有则 `null`）—— 宿主把它挂进自己的「退出前等在途写」账本。
	 * 值类型里带 `null` 是必须的：一轮推送可能没发布成功，而那个结果正是经由这份 promise 流出去的
	 * （写成 `Promise<T>` 就得在赋值处撒谎）。宿主用它来**等**，不用它来判断成败。
	 */
	readonly inFlight: Promise<T | null> | null;
	/** 有内容尚未成功发布：要么还没推过，要么上一次推送被跳过/失败了。 */
	readonly dirty: boolean;
}

export function createSyncScheduler<T = unknown>(options: SyncSchedulerOptions<T>): SyncScheduler<T> {
	const { debounceMs, timeoutMs, run } = options;

	/** 待跑的那一次（去抖定时器）。 */
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** 静默期里攒下、还没开始推的写入。 */
	let dirty = false;
	/**
	 * 上一次推送**没发布成功**（`run` 返回 `null` 或 reject）。与 `dirty` 分开存，因为两者要的行为不同：
	 * `dirty` 是「有新内容」，到点就该推；它是「旧内容还压在本地」，**不许**触发自动重排（见 `settle`）。
	 */
	let unpublished = false;
	/** 在途的那一次推送：既是串行闸，也是暴露给宿主的账本条目。 */
	let inFlight: Promise<T | null> | null = null;
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
	function runNow(runTimeoutMs: number): Promise<T | null> {
		cancelTimer(); // 无论是定时器到点还是 flush 抢先，都不留待跑的那一个
		// 两个标记都先清掉：这一轮就是它们的出口。跑完按结果重新置（见下面的 catch 与 null 分支）。
		// 到点就清 dirty 是必须的，否则收尾会一直重排、永远推不完。
		dirty = false;
		unpublished = false;
		const started: Promise<T | null> = (async () => {
			try {
				const result = await run(runTimeoutMs);
				// 白跑的一轮（被锁跳过、传输失败）不算发布：内容仍然只在本地，得活到 flush 再试一次。
				// **收摊之后不再置起来**：dispose-while-in-flight 是被显式支持的，而这一轮很可能正因为
				// 被中止而失败 —— 那时把标记重新置起，等于在宿主已经明说「不再等了」之后又留了一个
				// 「有东西没推出去」，接着一次 flush() 就会启动全新的推送 I/O（见 flush 的守卫）。
				if (result === null && !disposed) unpublished = true;
				return result;
			} catch {
				/*
				 * 就地吞掉。后台推送的失败一旦冒泡成未处理拒绝，掀掉的是**宿主进程**，
				 * 而失败本身引擎已经处理了：基线不前进、内容还在本地、下一次写入或 flush 再试。
				 * 所以这里连一条日志都不打 —— 用户该看到的是状态报告，不是一行栈。
				 */
				// 同上：收摊之后不再置起来（被 dispose 中止的那一轮正是从这里回来的）
				if (!disposed) unpublished = true;
				return null;
			}
		})();
		inFlight = started;
		const settle = (): void => {
			/*
			 * 整个收尾包在 try 里。settle 挂在 `started.then(settle, settle)` 上，而那个 promise 被
			 * `void` 掉了：收尾里逃出去的任何异常都会变成一个**没人接的拒绝**，正好绕过上面
			 * 「推送失败绝不冒泡」的承诺（`schedule()` 里的 `setTimeout` 在某些运行时是会抛的）。
			 */
			try {
				if (inFlight === started) inFlight = null;
				/*
				 * 跑的过程中又被标脏（比如整理记忆那一轮还在继续写）→ 收尾后再去抖一次。
				 *
				 * **只看 `dirty`，绝不看 `unpublished`。** 少这个条件不是漏写：未发布就自动重排，
				 * 在远端持续不可达时会变成每 `debounceMs` 一次、永不停止的重试风暴（每次都真去连一遍网、
				 * 每次都真去抢一遍锁）。未发布的那份内容只有两个补推入口 —— 下一次写入（`noteWrite`），
				 * 以及宿主显式 `flush()`（退出兜底、下次会话补推）。看到这一行想「顺手修好」之前，
				 * 请先想清楚谁负责停下来。
				 */
				if (dirty) schedule();
			} catch {
				// 收尾失败最多是少排一次定时器：下一次写入照样会排。它绝不能变成未处理拒绝。
			}
		};
		// 两个回调都给 settle：started 自己已经吞掉全部错误，派生出的 promise 也就不会拒
		void started.then(settle, settle);
		return started;
	}

	async function flush(runTimeoutMs?: number): Promise<T | null> {
		// 收摊之后的 flush 一律是「没有待发布的内容」（返回 null）：宿主退出路径上问的就是这一句，
		// 而 dispose 已经明说不再等了。少了这道守卫，在途那一轮收尾时重新置起的 `unpublished`
		// 会让这里启动一次**全新的**推送 I/O —— 拆除之后又开始联网，正是宿主最不能接受的那件事。
		if (disposed) return null;
		const budget = runTimeoutMs ?? timeoutMs;
		// flush 跑的是「此刻该跑的那一次」：先取消待跑的去抖定时器，别让它在同一份工作上空转
		cancelTimer();
		const foreign = inFlight;
		if (foreign !== null) {
			// 已有推送在跑时绝不并发起第二次：等它收尾（started 自己吞掉全部错误，不会拒）
			await foreign;
			// 等的过程中又有一轮起来了（另一个 flush，或去抖定时器到点）→ 不插一脚，也不冒领它的结果
			if (inFlight !== null) return null;
		}
		// 没有待发布的内容：连 run 都不调。宿主正是靠这个 null 判断「可以退了」
		if (!dirty && !unpublished) return null;
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
			// 在途的那一次**调度器自己**取消不了：它手上只有一个 `run` 回调，够不到传输层。
			// 取消是调用方的事 —— 引擎的 `dispose()` 会 abort 那一轮交给 backend 的中止信号。
			// 宿主的账本仍要先等它（`await inFlight`）：中止是「尽快收尾」，不是「立刻就不在了」。
			disposed = true;
			cancelTimer();
			dirty = false;
			// 「没发布成功」这个标记一起丢：收摊就是宿主明说「不再等了」，
			// 留着它只会让 `dirty` 在收摊之后继续报「有东西没推出去」。
			// 在途那一轮收尾时会试图把它置回来（它多半正是被这次中止弄失败的），
			// 所以那两处都带 `!disposed` 守卫、flush 也有一道 —— 三者是同一条不变量的三个面。
			unpublished = false;
		},
		get inFlight(): Promise<T | null> | null {
			return inFlight;
		},
		get dirty(): boolean {
			// 对外语义是「有内容尚未成功发布」：还没推的、以及推了但没发出去的，都算
			return dirty || unpublished;
		},
	};
}
