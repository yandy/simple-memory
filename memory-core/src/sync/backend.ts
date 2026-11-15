/**
 * 同步的**传输端口**：引擎只认这个接口，不认任何具体存储。
 *
 * 端口形状由「以后还要有别的 backend（对象存储之类）」倒推：**不得**出现「本地工作树」
 * 「clone」「commit」「ref」这类 git 专属概念。原因不是洁癖 —— 第三方 SDK 进不了 core
 * （core 的源码只许 import 标准库与相对路径，这是一道测试门），所以将来那些 backend 只能是
 * **独立的包**实现这里导出的端口，再由适配层装配。端口里漏进一个 git 概念，那个包就实现不出来。
 *
 * 两条最容易踩的口径：
 * - `revision` 是**不透明字符串**。引擎把它写回基线、下次原样交回来，从不解析它。
 * - `list()` 的 hash 恒为 **sha256(文件字节) 的十六进制小写**。这是端口契约的一部分，
 *   不是实现细节：基线与三方差集都直接与它比较。backend 若原生只有别的标识（git 的 blob
 *   sha1 掺了 `blob <长度>\0` 头，对象存储的 ETag 掺了分片规则），换算责任在 backend 自己
 *   身上 —— 换算错了不会报错，只会让「没变」被判成「变了」，每轮同步凭空生出冲突副本。
 *
 * 本文件只有类型与一个错误类，**没有运行时代码**：任何逻辑都会把整条同步链绑到某个具体存储上。
 */

/** 每次 backend 调用的运行参数。`timeoutMs` 由调用方按「自动路径 / 用户显式在等」两档给。 */
export interface SyncRunOptions {
	/** 单次远端往返的上限。超时按失败处理，绝不无限等（自动路径是挂在会话启动上的）。 */
	timeoutMs: number;
	/** 可选的中止信号：宿主退出/切会话时让在途的远端操作尽快收尾。 */
	signal?: AbortSignal;
}

/**
 * 远端内的一个前缀。backend 只在该前缀内活动，因此引擎不必知道远端还放着别的项目。
 * 前缀恒为 POSIX 形态（`/` 分隔），与宿主平台无关 —— 它是远端仓库里的数据布局，
 * 跟着平台走会让同一个仓库在两台设备上算出两个目录、各同步各的。
 */
export interface SyncScope {
	readonly prefix: string;
}

/** 远端一次快照的只读视图。 */
export interface RemoteView {
	/**
	 * 这次快照的**不透明**标识，会被写回基线的 `revision`。空串表示远端还没有任何已同步的
	 * 内容（第一次同步之前），即「没有基线可比」。
	 */
	readonly revision: string;

	/**
	 * 远端在 `scope.prefix` 下的全部路径 + 内容 hash。
	 *
	 * **路径相对于 `scope.prefix`**（因此就是单层文件名），与引擎差集用的 key 同域。
	 * **hash 恒为 sha256(字节) 的十六进制小写** —— 换算责任在 backend，见文件头。
	 */
	list(): Promise<Array<{ path: string; hash: string }>>;

	/**
	 * 取内容。只会被 `list()` 报出的路径调用。
	 *
	 * **可能在根锁释放之后才被调用**：引擎只在真要落到本地时才读内容，那时这一轮已经不在
	 * `fetch`/`publish` 的串行段里了（下面 `SyncBackend` 那条并发假设只盖住这两个调用）。
	 * 所以这里读的必须是 `fetch` 那一刻就已经固定下来的快照（内容已缓存，或按当时那个
	 * revision 取对象），**不能**对着共享的传输状态现取 —— 另一个项目的 `fetch`/`publish`
	 * 会同时跑：前者会移动引用（`git fetch` 改掉 `FETCH_HEAD` 与远程跟踪分支），后者会把
	 * 工作树 `reset --hard` + `clean -fd`。把 `read()` 写成对着共享暂存 clone 现跑一次
	 * `git show`、或直接读暂存工作树，读到的就可能是别的项目的内容、更旧的内容，或直接报错。
	 */
	read(path: string): Promise<string>;

	/**
	 * 远端存在、但**不该在那儿**的路径（**远端根相对**，原样保留）。纯报告用：引擎把它抄进
	 * 同步结果与状态报告，让人知道远端有内容没被同步 —— 有人手工推上来的索引文件、
	 * 同步范围之外的目录（例如那些永不参与同步的本地状态）、或本前缀底下的嵌套目录都算。
	 *
	 * **判据是「异常」，不是「不在本 scope 内」**：远端仓库按设计镜像整个记忆根，而一次会话只
	 * 同步当前那一个项目，所以**别的项目的记忆是常态**，不属于这里。把它们报出来，条数就随
	 * 项目数 × 记忆数线性增长，而异常报告一旦和正常数据同量级就等于没有报告 —— 真正那一条信号
	 * 会被永久埋掉。
	 *
	 * **不得静默丢弃异常路径**：丢了用户就永远无从得知远端有内容没进同步。
	 * 无法廉价判断的 backend 返回 `[]`。
	 */
	readonly outOfScope: string[];
}

/**
 * 要发布的**增量**：从 `base`（= 本轮取到的远端那一侧）到合并结果的差异。
 *
 * 用增量而不是完整文件集：对象存储这类 backend 只需 PUT/DELETE 变化的对象，不必重传全量。
 * 增量由引擎算好再交下来 —— backend 不判断该写什么，只负责把这份差异变成远端的新状态。
 *
 * `path` 与 `list()` 报出的同域：相对于 `scope.prefix` 的**单层**文件名（不含目录）。
 * 记忆目录是扁平的，嵌套路径写上去就再也读不回来（下一轮会被归成范围外）。
 */
export interface SyncPublishChanges {
	writes: Array<{ path: string; content: string }>;
	deletions: string[];
}

/**
 * 远端已经不在 `base` 上了（另一台设备在这轮之间推过）。
 *
 * 这是**预期内**的失败，不是故障：引擎拿到它就把整轮重跑一次（重新取远端、重算差集），
 * 仍失败则本轮放弃、基线不前进，留到下次。所以它必须是一个可识别的类型，
 * 而不是一条只能靠读文案区分的普通错误。
 */
export class NonFastForwardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NonFastForwardError";
	}
}

/**
 * 一个传输后端。实现方只需满足本接口的方法语义，不必也不得假定调用方认识具体存储。
 *
 * **并发假设**：backend 可以假定调用方已经把同一份本地状态（同一个 `syncRoot`）上的调用
 * **串行化**了，但**不是**「一轮从头到尾持有一把锁」。真实形状是引擎把一轮切成三段，每段的锁不同（见设计文档）：
 *
 * 1. `ready()`：在根级 sync 锁**之外**被调用（引擎每轮进门先问一次）。`init()` 更是根本不在
 *    引擎的自动路径上 —— 自动路径绝不偷偷做首次初始化，那可能是一次几十秒的远端往返，
 *    把它罩在根锁里就等于让期间每一次 `MemoryStore.save` 排队。
 * 2. `fetch()`：**在根级 sync 锁内**跑（try 语义：拿不到就本轮直接跳过，绝不把传输放进锁外）。
 *    这一段要读本地文件算基线，而「一次 save 期间没有别的 save」这条不变量正是那把根锁守的。
 * 3. 落盘合并：**根锁已经放开**，只由本 scope 的逻辑锁（`sync:<scope>`）守着。
 * 4. `publish()`：**重新抢一次根级 sync 锁**（同样抢不到就本轮报「忙」）。
 *
 * 于是 `fetch` 返回的远端视图与落盘之间，本地磁盘**可能被别的写入者改过**：backend 不得跨这道
 * 边界缓存本地状态；引擎这边则会在发布前重新核对基线，远端已经前进了就抛
 * {@link NonFastForwardError} 让整轮重跑，而不是硬推。
 *
 * 同一次调用内部（一次 `fetch` 或一次 `publish`）是顺序的、且共享那一份 `timeoutMs` 预算。
 * 因此以独立包实现的 backend **不必**自己再加内部锁；反过来，端口也不承诺任何并发安全，
 * 直接并行调用同一个实例属于误用。
 */
export interface SyncBackend {
	/**
	 * 是否已初始化（本地那点状态在不在）。false 时自动路径直接跳过 ——
	 * **自动路径绝不偷偷做首次初始化**：那可能是一次几十秒的远端往返，而它挂在会话启动上。
	 */
	ready(): Promise<boolean>;

	/** 首次初始化。只由显式命令触发；失败要抛错让人看见，不静默降级。 */
	init(opts: SyncRunOptions): Promise<void>;

	/** 取远端最新状态。 */
	fetch(scope: SyncScope, opts: SyncRunOptions): Promise<RemoteView>;

	/**
	 * 把「从 `base` 到合并结果」的增量发布到远端，返回新的 revision。
	 *
	 * 端口不承诺原子，但要求 backend **要么整体成功、要么抛错且不留下半推状态**：
	 * 抛错之后远端内容与本地状态都原样可解释，引擎才敢下一轮重来。
	 * `base.revision` 用于乐观并发：远端已经不在 base 上时抛 {@link NonFastForwardError}。
	 * 空串的 base 表示「没有基线」（首次发布），**不算**非快进。
	 *
	 * 返回的 revision **必须是远端真的有的那一个**：引擎会原样写进基线，下一轮拿它当 base 比对。
	 * 返回一个只存在于本地状态的标识（例如「本轮无变化，就把本地 head 交上去」而远端根本没这个分支），
	 * 会让下一轮的 base 永远对不上远端 —— 看起来只是多一次重跑，实际上是每轮都白跑。
	 */
	publish(
		scope: SyncScope,
		changes: SyncPublishChanges,
		base: { revision: string },
		opts: SyncRunOptions & { message: string; author: { name: string; email: string } },
	): Promise<string>;
}
