import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type SyncConfig } from "../config.js";
import { type ParsedEntryFile, parseEntryFile } from "../store/entry-file.js";
import { isEntryFileNameForWrite } from "../store/filename.js";
import { tryWithLock } from "../store/fs-lock.js";
import { type ApplyChange, type ApplyResult, BACKUP_DIR, INDEX_FILE, type MemoryStore } from "../store/memory-store.js";
import { createSnapshot } from "../store/snapshot.js";
import {
	NonFastForwardError,
	type RemoteView,
	type SyncBackend,
	type SyncPublishChanges,
	type SyncScope,
} from "./backend.js";
import { type ConflictOutcome, type ConflictSide, resolveConflict } from "./conflict.js";
import type { DeviceIdentity } from "./device.js";
import { type SyncConflict, diffThreeWay, type SyncDiff } from "./diff.js";
import { sha256Hex } from "./hash.js";
import { emptyManifest, MANIFEST_VERSION, manifestPath, readManifest, writeManifest } from "./manifest.js";
import { type LocalScan, scanLocalEntries } from "./scan.js";
import { remotePrefixFromKey } from "./paths.js";
import { createSyncScheduler, type SyncScheduler } from "./scheduler.js";
import type { SyncFileInfo, SyncFileSet } from "./types.js";

/**
 * 同步引擎：把「远端快照 + 本地扫描 + 上一次的基线」收敛成一次可解释的动作，并把它报出来。
 *
 * 一轮严格分三段，两把锁都是 **try 语义**（忙即跳过，绝不等待），而且**永不嵌套**：
 *
 * ```
 * ① 传输段   根级 sync 锁（<syncRoot>/sync.lock）→ backend.fetch() → 出段即释放
 * ② 应用段   项目的进程内逻辑锁 → 扫描 / 三方差集 / 快照 / 落盘 / 重建索引 / 写基线 → 释放
 * ③ 发布段   再取一次根级 sync 锁 → backend.publish(增量) → 释放
 * ```
 *
 * 根锁不跨网络持有是刻意的：整轮持一把根锁会把远端往返的时间算进去，同一台机器上开着两个项目
 * 会话时后启动的那个会整轮被跳过，而一次会话里拉取只有一次机会。因为两把锁从不嵌套，
 * 也就不存在锁序成环的问题。
 *
 * pull 轮 = ①②；push 轮 = ①②③（先收敛再发布，所以 push 轮也可能改本地、也要快照）。
 *
 * **铁律：任何同步失败都不得阻塞会话、不得损坏本地记忆，最坏结果永远是「退回手动」。**
 * 因此这里没有一处会把异常抛给调用方：所有失败都变成 `ok: false` + 一句可读的原因。
 * 五条数据安全线（基线只记「两侧达成一致的状态」、读不出的本地文件既不是删除也不是可覆盖的
 * 旧版本、远端 `modified` 必须先验形状、冲突收敛抛错只跳过该条、根级 sync 锁真的存在）
 * 各自在实现处写了「为什么不能删掉这段」。
 */

/** 引擎的装配参数。全部由适配层算好交进来：core 不读配置文件，也不猜项目身份。 */
export interface SyncEngineOptions {
	/** 本功能自己的状态目录（记忆根下的那个隐藏目录）：基线、设备身份、根级锁都在里面。 */
	syncRoot: string;
	/** 这个项目同步的目录（记忆根下的 `git/<project>`）。报告用；落盘一律以 `store.cfg.memoryDir` 为准。 */
	projectDir: string;
	/** 远端布局里这个项目的 key（`remoteProjectKey` 的输出）。 */
	projectKey: string;
	store: MemoryStore;
	backend: SyncBackend;
	device: DeviceIdentity;
	config: SyncConfig;
	/** 只为测试可固定：基线的 `syncedAt` 与快照目录名都用它。 */
	now?: () => Date;
}

/** 一轮同步的结果。`ok: false` 时 `skipped.reason` 一定有一句人话。 */
export interface SyncRoundResult {
	ok: boolean;
	/** 本轮为什么没做完（配置未开、锁忙、远端不可达……）。只在 `ok: false` 时出现。 */
	skipped?: { reason: string };
	/** 本轮从远端落到本地的 entry 文件名。 */
	pulled: string[];
	/** 本轮发布到远端的 entry 文件名（pull 轮不发布，恒为空）。 */
	pushed: string[];
	/** 本轮在本地删掉的文件名（含「删除 vs 修改」里照办的那次删除）。 */
	deletedLocal: string[];
	/**
	 * 本轮从远端删掉的文件名。pull 轮不发布，那里报的是**本轮判定、随下一次发布生效**的删除 ——
	 * 判定了却没报出来，用户就无从知道自己的删除还没生效。
	 */
	deletedRemote: string[];
	/** 收敛掉的冲突：`file` 是原路径，`keptAsNew` 是被挤出来那一份的新文件名。 */
	conflicts: Array<{ file: string; keptAsNew: string }>;
	/** 被拒收的内容（远端那份解析不出、`modified` 形状不对、文件名碰撞……），带原因。
	 *  原因词与 `applyEntryFiles` 同一口径：引擎自己判定的那几种是**稳定词汇**
	 * （`unparsable frontmatter` / `invalid modified` / `unpublishable file name`），异常路径（读不到字节、
	 * 冲突没收敛掉）则直接把底层错误拼进去 —— 那些不是词汇，是诊断信息。 */
	rejected: Array<{ file: string; reason: string }>;
	/** 本地解析不出/读不了的 `.md`：本轮不参与判定，但必须让用户知道它没同步。 */
	unparsableLocal: string[];
	/**
	 * 远端有、但本轮不会同步的路径（远端根相对）：传输端口报上来的**异常**路径（手工推上来的
	 * 索引、本前缀底下的嵌套目录……），加上引擎自己判定的「这个名字在任何设备上都写不下去」。
	 * 别的项目的记忆**不在这里** —— 那是设计规定的常态，报出来就等于每轮上千条噪声。
	 */
	outOfScopeRemote: string[];
	/** 本轮结束时基线指向的远端版本（发布成功则是发布后的那一个）。 */
	revision?: string;
}

/** `status` 的报告。**dry-run**：算得出一切，但盘上一个字都不改。 */
export interface SyncStatusReport {
	configured: boolean;
	initialized: boolean;
	remote: string;
	branch: string;
	device: DeviceIdentity;
	/** 本地目录（可能与远端 key 不同名：报出两者，映射关系才看得见）。 */
	projectDir: string;
	projectKey: string;
	base: { revision: string; syncedAt: string } | null;
	/** 本地领先远端的那些文件名（待发布的新增/修改，以及待发布的本地删除）。 */
	ahead: string[];
	/** 远端领先本地的那些文件名（待拉取的内容，以及待执行的远端删除）。 */
	behind: string[];
	conflicts: string[];
	rejected: Array<{ file: string; reason: string }>;
	unparsableLocal: string[];
	/** 同一轮结果里那个字段的口径（异常路径，不含别的项目的记忆）。 */
	outOfScopeRemote: string[];
	/** 每一步失败的可读原因（未配置、未初始化、锁忙、远端不可达、目录读不了……）。 */
	errors: string[];
}

export interface SyncEngine {
	pull(timeoutMs?: number): Promise<SyncRoundResult>;
	push(timeoutMs?: number): Promise<SyncRoundResult>;
	status(timeoutMs?: number): Promise<SyncStatusReport>;
	/** 记下「本地刚写过」，由写触发调度器接线（去抖之后调 `flush`）。 */
	noteWrite(): void;
	/**
	 * 立刻跑一次去抖中的推送；没有尚未发布的内容则返回 `null`。
	 * 「尚未发布」包括上一次自动推送被跳过/失败的那一份：撞上锁而白跑的一轮不算干净，
	 * 宿主退出前调它就能把那一推补上。
	 */
	flush(timeoutMs?: number): Promise<SyncRoundResult | null>;
	/** 释放调度器持有的资源。绝不抛错。 */
	dispose(): void;
	/**
	 * 在途的那一次自动推送（没有则 `null`）。宿主把它挂进自己的「退出前等在途写」账本：
	 * 看不到它，退出时正好跑着的一次推送就会被静默截断。
	 */
	readonly inFlight: Promise<unknown> | null;
}

/**
 * 关闭写触发推送时装上的空转调度器：同一个接口，`noteWrite` 静默空转。
 *
 * 这样调用点（每次写入之后那一行）不必到处判 `config.pushOnWrite` —— 分支只在这里出现一次。
 */
const NOOP_SCHEDULER: SyncScheduler<SyncRoundResult> = {
	noteWrite(): void {},
	flush(): Promise<null> {
		return Promise.resolve(null);
	},
	dispose(): void {},
	inFlight: null,
	dirty: false,
};

/** 「本轮跳过」内部控制流：与真异常走同一条出口（都变成 `ok: false` + 可读原因）。 */
class SyncSkip extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "SyncSkip";
	}
}

/** 发布段撞上非快进：要求整轮重跑（重新取远端、重算差集），不是只重试一次 publish。 */
interface RetryRound {
	retry: string;
	/**
	 * 这一次尝试**已经落到本地**的那部分结果。
	 *
	 * 非快进是在发布段抛的，而应用段早就跑完了：拉下来的内容、冲突副本、`-sync` 快照、写好的
	 * 基线都已经在盘上。重跑不会撤销它们，所以这份部分结果必须跟着带出去（见 `runRound`）。
	 */
	partial: SyncRoundResult;
}

type RoundOutcome = SyncRoundResult | RetryRound;

type Mode = "pull" | "push";

/** 非快进最多重跑一次：再失败就把本轮交回给下一次触发（基线不前进，脏状态原样留着）。 */
const MAX_ROUND_ATTEMPTS = 2;

/**
 * `modified` 的 ISO-8601 形状：完整时刻（可无毫秒、可带时区偏移），或纯日期。
 *
 * 只认形状，不用 `Date.parse` 单独判：`Date.parse` 会接受一堆本地化写法（`"Nov 9 2026"`），
 * 而 `modified` 是跨设备**唯一**的定序与冲突判据，两台设备必须对同一串字节得出同一个先后。
 * 形状过了再用 `Date.parse` 复核一次，挡掉 `2026-13-45` 这种字段越界。
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoModified(value: string): boolean {
	if (!ISO_INSTANT_RE.test(value) && !ISO_DATE_RE.test(value)) return false;
	return !Number.isNaN(Date.parse(value));
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 时间预算的入口兵底：只认「有限的正数」，其余一律退回 `fallback`。
 *
 * 配置合并那一层不校验类型，`deepMerge` 还会把用户写的 `null` 原样带进来；而 `null` / `NaN` / `0`
 * 一路走到子进程的 `timeout` 上等于**无限等** —— 一次远端挂死就把「任何同步失败都不得阻塞会话」
 * 这条铁律桶穿（自动拉取是被 await 在会话启动路径上的）。所以预算只在入口这里认一次，
 * 里面每一层拿到的都已经是个能用的数。
 */
function positiveMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 一份预算还剩下多少毫秒。**下限是 1 而不是 0**：子进程的 `timeout: 0` 是「不限时」，
 * 预算耗尽时给出去的必须是「立刻超时」，而不是把无限等当成兜底。
 */
function remainingMs(deadline: number): number {
	return Math.max(1, deadline - Date.now());
}

/**
 * 「这个名字在哪台设备上都写不下去」的稳定原因词（同 `unparsable frontmatter` / `invalid modified`）。
 *
 * 不把具体理由（哪个保留名、哪一类字符）拼进去：适配层要拿它分类，而拼进去的文案会把一个
 * 本属于用户记忆名字的字串变成只能靠子串匹配的变量。
 */
const UNPUBLISHABLE_NAME = "unpublishable file name";

/** 两份清单按 key 去重合并（同一个 key 保留后出现的那一份），顺序 = 出现顺序。 */
function unionBy<T>(left: T[], right: T[], key: (item: T) => string): T[] {
	const seen = new Map<string, T>();
	for (const item of [...left, ...right]) seen.set(key(item), item);
	return [...seen.values()];
}

/**
 * 把两次尝试各自**已经落到本地**的那部分合成一份报告。
 *
 * 重跑不会撤销上一次的落盘，而上一次拉下来的内容在新基线里已经是「两侧一致」的了 ——
 * 第二次尝试的报告里不会再提它。只报后一次，用户看到的仍然是「本轮什么都没拉」，
 * 而盘上明明多了文件 —— 正是这一版失败报告要修掉的那句假话。
 */
function mergePartials(previous: SyncRoundResult | undefined, latest: SyncRoundResult): SyncRoundResult {
	if (previous === undefined) return latest;
	const byName = (file: string): string => file;
	return {
		...latest,
		pulled: unionBy(previous.pulled, latest.pulled, byName),
		pushed: unionBy(previous.pushed, latest.pushed, byName),
		deletedLocal: unionBy(previous.deletedLocal, latest.deletedLocal, byName),
		deletedRemote: unionBy(previous.deletedRemote, latest.deletedRemote, byName),
		unparsableLocal: unionBy(previous.unparsableLocal, latest.unparsableLocal, byName),
		outOfScopeRemote: unionBy(previous.outOfScopeRemote, latest.outOfScopeRemote, byName),
		conflicts: unionBy(previous.conflicts, latest.conflicts, (item) => item.file),
		// 同一个文件因为同一个原因被拒收两次只报一次；原因不同则两条都留着（那是两次不同的拒收）
		rejected: unionBy(previous.rejected, latest.rejected, (item) => `${item.file}\n${item.reason}`),
	};
}

function asFileSet(files: Record<string, SyncFileInfo>): SyncFileSet {
	return new Map(Object.entries(files));
}

function asFileRecord(files: SyncFileSet): Record<string, SyncFileInfo> {
	return Object.fromEntries(files);
}

/**
 * 算出这一轮之后该记进基线的文件集：**这一轮的 `theirs`**，再按两类例外修正（本轮没收下的
 * 名字剔掉，本地读不出的名字冻结在上一次一致的那份）。
 *
 * 基线是三方合并里的「共同祖先」，它的语义是「两侧上一次真正达成一致的状态」，
 * **不是**「我盘上现在有什么」。所以它的形状只能从远端这一侧长出来：远端此刻持有的就是
 * 两侧都看得见的那份状态，而本地独有的内容要等**发布成功**之后才算达成一致（见 `publishPhase`，
 * 那里用发布出去的增量覆盖/删除对应条目）。
 *
 * `unagreed` 是本轮**没能收下**远端那份内容的名字（解析不出、`modified` 形状不对、store 拒收、
 * 冲突没收敛掉）。把它们记进基线等于宣布「我们已经接受了这份内容」，而下一轮的差集会照这句话办事：
 * - 本地没有它 → 「base 有 / ours 无 / theirs 未动」= 用户删了 → 把对端那份删掉；
 * - 本地有自己的版本 → 「base 有（= 对端那份）/ ours 改了 / theirs 未动」= 本地胜 →
 *   拿本地那份盖掉对端那份，静默丢掉我们明确拒收过的内容。
 * 两种都是替对端做决定。所以这类名字**不跟着 `theirs` 前进**，而是退回上一次真正达成一致的
 * 那一份（`previousBase`，没有就不记），下一轮才会照旧判成「远端改了 / 我们收不下」→ 再报一次。
 * 干脆从基线里剔掉也保得住数据，但报告会变脏：基线里没有它，下一轮就把这件事读成
 * 「两侧各新增了一份」→ 冲突，于是 `status` 在拒收旁边永久多出一条并不存在的冲突。
 *
 * 注意本地读不出的文件（`unparsable`）**不在** `unagreed` 里，它们走另一条路：基线**冻结**在
 * 上一次一致的那份（`untouched`）。因为本地这一份本轮根本不参与判定，也就无从达成一致，
 * 此时跟着 `theirs` 前进会把「对端的新版本」误记成「我们已经接受过的共同祖先」：
 * 用户把本地文件修好之后（修好的往往是自己那份旧内容），下一轮就成了「只本地改过」→
 * 拿修好的那份盖掉对端的新版本，对端的内容两边一起丢。冻结在上一次一致的那份，
 * 修好之后就是「两侧都改过」→ 冲突 → 两份都留；用户自己删掉它之后，删除也能正常传到对端。
 *
 * @param theirs 这一轮取到的远端文件集
 * @param localAfter 应用之后重新扫出来的本地文件集
 * @param previousBase 上一次的基线（只用于冻结 `untouched` 里的名字）
 * @param untouched 本地读不出的名字：本轮一律不动，基线也不得前进
 * @param unagreed 本轮没收下远端那份内容的名字
 */
function agreedBaseFiles(
	theirs: SyncFileSet,
	localAfter: SyncFileSet,
	previousBase: SyncFileSet,
	untouched: ReadonlySet<string>,
	unagreed: ReadonlySet<string>,
): Map<string, SyncFileInfo> {
	const base = new Map<string, SyncFileInfo>();
	for (const file of new Set([...theirs.keys(), ...untouched])) {
		if (unagreed.has(file)) {
			// 退回上一次**真的一致过**的那份（没有就不记）。别干脆剔掉：基线里没有它，
			// 下一轮就把「远端改了、我们收不下」读成「两侧各新增了一份」→ 凭空多出一条冲突。
			const agreed = previousBase.get(file);
			if (agreed !== undefined) base.set(file, agreed);
			continue;
		}
		if (untouched.has(file)) {
			// 从没达成过一致（例如一上来就读不出、远端也从来没推成功过）→ 干脆不记：
			// 记一个假祖先比不记更危险，它会让下一轮把两侧的内容当成「其中一侧改过」。
			const frozen = previousBase.get(file);
			if (frozen !== undefined) base.set(file, frozen);
			continue;
		}
		const remote = theirs.get(file);
		if (remote === undefined) continue;
		const mine = localAfter.get(file);
		// 本地此刻就是同一份字节时用本地扫出的指纹：远端清单只给得出 hash，`modified`/`bytes`
		// 是占位值（见 `readRemoteSnapshot`），能给出真值就不要在基线里留占位。
		base.set(file, mine !== undefined && mine.hash === remote.hash ? mine : remote);
	}
	return base;
}

/**
 * 解析不出/读不了的本地文件本轮**一律不动**：从差集产出的每一张动作清单里剔除。
 *
 * 扫描把这种文件放进 `unparsable` 而不是 `files`，于是差集看到「`ours` 里没有它」，
 * 按标准三方语义会有三种结论，每一种都会动到这份读不出的文件：
 * - `base` 里有、远端未动 → 判成**用户删除** → 删除被推到远端：一个坏文件（手滑编辑、半截写入、
 *   权限抖动）就能把两台设备上的同一条记忆一起删掉，而本地那份还躺在盘上；
 * - `base` 里有、远端改过 → 判成**删除 vs 修改**冲突 → 删除那半边照办：这份读不出的文件从原路径被
 *   删掉，远端那份字节只以一个派生的 `… (冲突 …)` 名字留下（原路径的删与留由冲突收敛一并决定，
 *   见 `convergeConflict`）；
 * - `base` 里没有、远端有 → 判成**远端新增** → 用远端那份盖掉同名的本地文件。
 * （「远端改过而本地按基线算没动 → 远端胜」这种组合在这里**不可达**：`ours` 缺失的名字在差集里
 * 只能读成删除或冲突，不可能同时是「按基线算没动」—— 见 `diffThreeWay` 的 `!inOurs` 分支。）
 *
 * 第三种尤其拦不得：frontmatter 被手改坏的文件，正文往往正是用户最在乎的内容，用远端那份
 * 盖掉它违反本设计的铁律「任何同步失败都不得损坏本地记忆」，而 `.backups/<ts>-sync/` 只保留
 * 5 份快照，不足以当作覆盖的补偿。所以这里连 `conflicts` 一起剔：这份文件既不被覆盖、也不被删除、
 * 更不触发对端删除，只出现在 `unparsableLocal` 报告里，每轮都报，直到用户自己修好或自己删掉它。
 *
 * 剔完之后**不需要**再把这些名字按基线补回 `ours`：补回只能压掉第一种（`deleteRemote`），
 * 压不住第二、第三种；而两套机制并存会让「差集的结论」与「实际执行的动作」长期不一致，
 * 后来人再也看不出哪一套算数。
 */
function withoutUnparsable(diff: SyncDiff, untouched: ReadonlySet<string>): SyncDiff {
	if (untouched.size === 0) return diff;
	return {
		pullFromRemote: diff.pullFromRemote.filter((file) => !untouched.has(file)),
		pushLocal: diff.pushLocal.filter((file) => !untouched.has(file)),
		deleteLocal: diff.deleteLocal.filter((file) => !untouched.has(file)),
		deleteRemote: diff.deleteRemote.filter((file) => !untouched.has(file)),
		conflicts: diff.conflicts.filter((conflict) => !untouched.has(conflict.file)),
	};
}

/** 本轮**没收下**远端这份内容：既不发布（两个方向都不动），也绝不进基线（见 `agreedBaseFiles`）。 */
function markUnagreed(plan: ApplyPlan, file: string): void {
	plan.excluded.add(file);
	plan.unagreed.add(file);
}

/** 一次远端快照里引擎要用的部分：内容按名字取，`theirs` 只有 hash 是真的（见 `readRemoteSnapshot`）。 */
interface RemoteSnapshot {
	view: RemoteView;
	revision: string;
	theirs: SyncFileSet;
	outOfScope: string[];
}

/** 应用段的产物：交给发布段的增量，以及发布成功之后基线该记的那份文件集。 */
interface AppliedRound {
	delta: SyncPublishChanges;
	/** 发布成功之后远端应有的样子（= 本轮基线 + 发布出去的增量）。没发布成功就不许用它前进基线。 */
	remoteAfterPublish: SyncFileSet;
}

/** 一轮里逐步攒出来的落盘计划。 */
interface ApplyPlan {
	writes: ApplyChange[];
	deletes: string[];
	/** 已占用的文件名（能给 hash 就给，冲突副本的「同内容即复用」判断要靠它）。 */
	taken: Array<{ file: string; hash?: string }>;
	/**
	 * 本轮**不得发布**的名字：本地读不出的、远端那份被拒收的、冲突没收敛掉的。
	 *
	 * 两个方向都得跳：把它们算成写入等于把一份我们根本没接受的字节推给对端，
	 * 算成删除更糟 —— 那是「我们收不下对端那份，于是把对端那份删了」。
	 */
	excluded: Set<string>;
	/**
	 * 本轮**没收下远端那份内容**的名字（`excluded` 的子集，见 `markUnagreed`）：不得进基线。
	 *
	 * 与 `excluded` 分开是因为两者不重合：本地读不出的文件在 `excluded` 里（不发布），
	 * 但它不算「没收下」—— 本地这一份本轮压根没参与判定，基线走的是另一条路（冻结在上一次
	 * 一致的那份，见 `agreedBaseFiles` 的 `untouched`）。
	 */
	unagreed: Set<string>;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
	const { syncRoot, projectDir, projectKey, store, backend, device, config } = options;
	const now = options.now ?? ((): Date => new Date());
	const platform = store.cfg.platform ?? process.platform;
	/**
	 * 本地的一切读写都以 store 配置的目录为准，而不是 `options.projectDir`。
	 *
	 * 两者本该是同一个目录；万一是两个，扫描读的是 A、`applyEntryFiles` 写的是 B，
	 * 差集就会把「A 里没有」读成本地删除并推到远端 —— 所以这里只认写入通道认的那个目录。
	 * `projectDir` 仅用于报告（`status` 里那条「本地目录 ↔ 远端 key」的映射）。
	 */
	const memoryDir = store.cfg.memoryDir;
	const rootLockPath = join(syncRoot, "sync.lock");
	const manifestFile = manifestPath(syncRoot, projectKey);
	const scope: SyncScope = { prefix: remotePrefixFromKey(projectKey) };

	const NOT_CONFIGURED = "sync is not configured: set sync.enabled and a sync remote first";
	const NOT_INITIALIZED = "the sync backend is not initialized: run the sync init command first";
	const ROOT_LOCK_BUSY = "another sync round holds the root sync lock, so this round was skipped";
	const MEMORY_LOCK_BUSY = "the memory lock for this project is busy, so this round was skipped";

	/**
	 * 三个时间参数只在装配时认一次（`positiveMs`）。
	 *
	 * 为什么要兜：`mergeConfig` 不校验类型，`deepMerge` 还会把用户写的 `null` 原样带进来，而 `null` /
	 * `NaN` / `0` 一路传到子进程的 `timeout` 上等于**无限等**，传到 `setTimeout` 上等于「每次写入都立刻推一次」。
	 * 两者都把「一次同步失败不得阻塞会话」这条铁律变成了靠配置正确才成立的东西。
	 * 退回值是包里的那套默认值，而不是就地造一个魔法数：默认值已经记在设计里（自动档 5s / 手动档 20s）。
	 */
	const autoBudget = positiveMs(config.autoTimeoutMs, DEFAULT_CONFIG.sync.autoTimeoutMs);
	const manualBudget = positiveMs(config.timeoutMs, DEFAULT_CONFIG.sync.timeoutMs);
	const debounce = positiveMs(config.pushDebounceMs, DEFAULT_CONFIG.sync.pushDebounceMs);

	function isConfigured(): boolean {
		// 逐字判类型：配置合并那一层不校验类型，`remote` 可能是任何值。
		// `enabled` 用 `=== true` 而不是真值：这是一道**同意边界** —— 用户写的 `"enabled": "false"`
		// 在 JS 里是真值，按真值判定就会把明写的「关」读成「开」，继续往远端推数据。
		// 「不是明确的 true 一律按关处理」与 `syncConfigErrors` 的布尔校验同一口径。
		return config.enabled === true && typeof config.remote === "string" && config.remote.trim() !== "";
	}

	function emptyResult(): SyncRoundResult {
		return {
			ok: true,
			pulled: [],
			pushed: [],
			deletedLocal: [],
			deletedRemote: [],
			conflicts: [],
			rejected: [],
			unparsableLocal: [],
			outOfScopeRemote: [],
		};
	}

	function failedRound(reason: string, partial?: Partial<SyncRoundResult>): SyncRoundResult {
		return { ...emptyResult(), ...partial, ok: false, skipped: { reason } };
	}

	/**
	 * 根级 sync 锁（`<syncRoot>/sync.lock`），**try 语义**：拿不到就跳过本轮，绝不排队等。
	 *
	 * 这把锁兑现的是传输端口对 backend 的承诺：同一个 `syncRoot` 上的 `fetch`/`publish` 已经被
	 * 串行化，所以以独立包实现的 backend 不必自加内部锁。它保护的是那台机器上共享的传输状态
	 * （git backend 的暂存 clone），因此传输段与发布段各取一次，**中间放开** ——
	 * 跨网络持锁会让同一台机器上另一个项目的同步整轮被跳过。
	 */
	async function withRootLock<T>(fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
		// 锁文件就在 syncRoot 里，而首次同步时这个目录可能还没人建过
		await mkdir(syncRoot, { recursive: true });
		const outcome = await tryWithLock(rootLockPath, "sync", { timeoutMs: 0 }, async () => ({ value: await fn() }));
		return outcome === null ? { acquired: false } : { acquired: true, value: outcome.value };
	}

	/**
	 * 在途那些远端调用的中止控制器账本（一轮一个；`status` 也算一轮）。
	 *
	 * 端口的 `signal` 形参存在的全部理由就是「宿主退出时能把在途的那一次收尾」，而只有这一层知道
	 * 什么时候算收摊：`dispose()` 把它们全部 abort，于是挂在会话启动路径上的拉取、以及退出时正在跑的
	 * 推送都能立刻结束，而不是等子进程自己的超时跑完。用账本而不是单个字段：手动 `pull()` 与自动
	 * 推送可能重叠（两者都允许，根锁会把传输段串起来），一个字段会丢一个。
	 */
	const activeSignals = new Set<AbortController>();

	/** 跑一段会碰远端的工作：给它一个 signal，结束时从账本里摘掉（无论成败失败）。 */
	async function withAbortSignal<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		activeSignals.add(controller);
		try {
			return await work(controller.signal);
		} finally {
			activeSignals.delete(controller);
		}
	}

	/**
	 * ① 传输段：取一份远端快照，出段即释放根锁。
	 *
	 * `list()` 的 hash 是差集唯一的判据，但 `modified` / `bytes` 不在端口里 —— 它们要从内容里解析，
	 * 而内容只在真要落到本地时才读（`view.read`）。所以 `theirs` 里只有 hash 是真的，
	 * `modified`/`bytes` 是占位值：**任何消费者都不得读它们**，需要时按读到的字节重算
	 * （见 `remoteSide`）。远端可能上千条记忆，为一轮里通常一两条变更把全部内容读一遍不值得。
	 *
	 * 也就是说 `view.read()` 会在根锁**释放之后**（应用段里）才被调用：`RemoteView` 必须是一份
	 * 自足的快照，读内容不能推迟到共享的传输状态上。同一句话也写在端口注释里（backend 实现方
	 * 看的是那一份）：两边都得说，否则独立包实现的 backend 会把 `read()` 写成对着共享状态现取。
	 */
	async function readRemoteSnapshot(timeoutMs: number, signal: AbortSignal): Promise<RemoteSnapshot> {
		const locked = await withRootLock(async () => {
			const view = await backend.fetch(scope, { timeoutMs, signal });
			return { view, listed: await view.list() };
		});
		if (!locked.acquired) throw new SyncSkip(ROOT_LOCK_BUSY);

		const theirs: SyncFileSet = new Map();
		// 范围外的路径原样报出去（远端根相对）：静默丢掉的话，用户永远不知道远端有内容没进同步
		const outOfScope = [...locked.value.view.outOfScope];
		for (const { path, hash } of locked.value.listed) {
			// 从网络进来的名字一律走**写方向**谓词（全平台最严的那一套），不是本地扫描那一套读方向：
			// 这个名字的归宿是本地文件系统，而落盘前的整批断言（`applyEntryFiles`）问的正是写方向。
			// 两边口径不一致的后果不是「少同步一条」：一个在 Linux 上合法、在 Windows 上开不了的
			// 名字（例如 `con.md`）会先通过这里的过滤、再在落盘前让**整批**抛错 —— 应用段一个文件都
			// 没写就失败，`-sync` 快照却已经拍了一份，而且下一轮一模一样：同步彻底停摆、status 不报错、
			// 崩溃恢复用的快照名额每轮被白拍一份挤掉。
			// 报成范围外而不是交给 `applyEntryFiles`：远端前缀里被人手工推上来的索引文件、点开头的
			// 文件、嵌套目录同样走这一条（它们都不是记忆，也不得让整轮失败）。
			if (!isEntryFileNameForWrite(path)) {
				outOfScope.push(`${scope.prefix}/${path}`);
				continue;
			}
			theirs.set(path, { hash, modified: "", bytes: 0 });
		}
		outOfScope.sort();
		return { view: locked.value.view, revision: locked.value.view.revision, theirs, outOfScope };
	}

	/**
	 * 远端这份字节能不能落到本地。返回 `null` = 拒收（原因已记进 `rejected`）。
	 *
	 * `modified` 的形状校验必须在**这里**做，不能指望 `applyEntryFiles`：那条原语校验
	 * name / created / type，唯独不校验 `modified`，而 `modified` 是跨设备定序与冲突判定的
	 * 唯一依据，并且按设计永远不会被重新盖章 —— 一份 `modified: 昨天下午` 落了盘就再也修不回来，
	 * 它会让这条记忆在之后每一轮排序里都站在错误的一侧。挡在门外、报出来，是唯一能修的时机。
	 */
	async function acceptRemote(
		view: RemoteView,
		file: string,
		rejected: Array<{ file: string; reason: string }>,
	): Promise<{ raw: string; parsed: ParsedEntryFile } | null> {
		const raw = await view.read(file).catch((err: unknown) => {
			rejected.push({ file, reason: describeError(err) });
			return null;
		});
		if (raw === null) return null;
		const parsed = parseEntryFile(raw);
		if (parsed === null) {
			rejected.push({ file, reason: "unparsable frontmatter" });
			return null;
		}
		if (!isIsoModified(parsed.meta.modified)) {
			// 原因词保持稳定（同 `applyEntryFiles` 的 rejected 口径），不把值拼进去：
			// 适配层要拿它分类，而那个值可能包含用户不想在状态行里看到的任意字节
			rejected.push({ file, reason: "invalid modified" });
			return null;
		}
		return { raw, parsed };
	}

	/** 冲突里「本地这一侧」的字节与指纹（读不出或解析不出 → 拒收并跳过这一条）。 */
	async function localSide(
		file: string,
		plan: ApplyPlan,
		rejected: Array<{ file: string; reason: string }>,
	): Promise<ConflictSide | null> {
		const raw = await readFile(join(memoryDir, file), "utf8").catch((err: unknown) => {
			rejected.push({ file, reason: describeError(err) });
			return null;
		});
		if (raw === null) {
			markUnagreed(plan, file);
			return null;
		}
		const parsed = parseEntryFile(raw);
		if (parsed === null) {
			// 正常走不到这里：解析不出的本地文件会被扫描归进 `unparsable`，而那一类名字本轮
			// 已从差集的每一张清单里剔除（见 `withoutUnparsable`），根本不会被当成冲突送进来。
			// 真撞上只可能是它在扫描之后才坏掉，处置与上面一致：这一条不动，两侧内容都原样留着。
			rejected.push({ file, reason: "unparsable frontmatter" });
			markUnagreed(plan, file);
			return null;
		}
		// 指纹按**这一刻读到的字节**重算：`ConflictSide` 的 raw 与 info 必须描述同一份内容
		return { raw, info: { hash: sha256Hex(raw), modified: parsed.meta.modified, bytes: Buffer.byteLength(raw, "utf8") } };
	}

	/** 冲突里「远端这一侧」的字节与指纹（过不了 `acceptRemote` → 拒收并跳过这一条）。 */
	async function remoteSide(
		view: RemoteView,
		file: string,
		plan: ApplyPlan,
		rejected: Array<{ file: string; reason: string }>,
	): Promise<ConflictSide | null> {
		const accepted = await acceptRemote(view, file, rejected);
		if (accepted === null) {
			markUnagreed(plan, file);
			return null;
		}
		return {
			raw: accepted.raw,
			info: {
				hash: sha256Hex(accepted.raw),
				modified: accepted.parsed.meta.modified,
				bytes: Buffer.byteLength(accepted.raw, "utf8"),
			},
		};
	}

	/**
	 * 收敛一条冲突：原路径写胜者（或删掉），败者另存为一条新 entry。
	 *
	 * `resolveConflict` 在败者字节解析不出 frontmatter 时**抛错**（它不借用 `null` 返回值，
	 * 那已经表示「两侧相同、无事可做」）。这里必须接住：跳过这一条、记一条可读的 `rejected`，
	 * **不要让整轮失败，更不要静默丢掉那份内容** —— 两侧的文件因此都原样留在盘上，
	 * 下一轮还会再判成同一个冲突，直到有人处理。
	 */
	async function convergeConflict(
		conflict: SyncConflict,
		view: RemoteView,
		plan: ApplyPlan,
		result: SyncRoundResult,
	): Promise<void> {
		const { file } = conflict;
		// 为 null 的一侧是「已删除」：不去取内容（远端那份可能根本读不出来）
		const ours = conflict.ours === null ? null : await localSide(file, plan, result.rejected);
		if (conflict.ours !== null && ours === null) return;
		const theirs = conflict.theirs === null ? null : await remoteSide(view, file, plan, result.rejected);
		if (conflict.theirs !== null && theirs === null) return;

		let outcome: ConflictOutcome | null;
		try {
			outcome = resolveConflict({ file, ours, theirs }, plan.taken);
		} catch (err) {
			result.rejected.push({ file, reason: `conflict not resolved: ${describeError(err)}` });
			markUnagreed(plan, file);
			return;
		}
		// null = 两侧字节其实相同：差集按 hash 判定，正常走不到这里
		if (outcome === null) return;

		if (outcome.winnerRaw === null) {
			// 删除 vs 修改：删除照办，幸存的那份内容由 loserEntry 承接
			plan.deletes.push(file);
		} else {
			plan.writes.push({ file, raw: outcome.winnerRaw });
			plan.taken.push({ file, hash: sha256Hex(outcome.winnerRaw) });
		}
		const loser = outcome.loserEntry;
		if (loser === null) {
			result.conflicts.push({ file, keptAsNew: "" });
			return;
		}
		// 冲突副本走**同一次** `applyEntryFiles`：它的文件名已由内容派生好，
		// 一起落盘才能保证「原路径的删/写」与「副本的写」在同一份快照与同一次索引重建之间完成
		plan.writes.push({ file: loser.file, raw: loser.raw });
		// hash 一并给出去：`resolveConflict` 靠它认出「这个名字已经被同一份内容占着」并复用，
		// 只给名字会一律走确定性追加，同一条记忆每轮多出一份副本
		plan.taken.push({ file: loser.file, hash: sha256Hex(loser.raw) });
		result.conflicts.push({ file, keptAsNew: loser.file });
	}

	/**
	 * ② 应用段：整轮持有项目的进程内逻辑锁，所以每一次 store 调用都传
	 * `{ skipLogicalLock: true, skipSnapshot: true }`，而整段只拍**一份** `-sync` 快照。
	 */
	async function applyPhase(snapshot: RemoteSnapshot, result: SyncRoundResult): Promise<AppliedRound> {
		const applied = await store.tryWithLogicalLock((): Promise<AppliedRound> => converge(snapshot, result));
		if (applied === null) throw new SyncSkip(MEMORY_LOCK_BUSY);
		return applied;
	}

	async function converge(snapshot: RemoteSnapshot, result: SyncRoundResult): Promise<AppliedRound> {
		const { view, theirs } = snapshot;
		// 扫描抛错（非 ENOENT 的 readdir 失败）= 整轮跳过：绝不带着「读不出来」的 ours 去算差集，
		// 那等于宣布本机删光了全部记忆，并把删除传播到远端。
		const scan: LocalScan = await scanLocalEntries(memoryDir, platform);
		const manifest = (await readManifest(manifestFile)) ?? emptyManifest();
		const previousBase = asFileSet(manifest.files);

		// 解析不出/读不了的本地文件不进 `ours`，也不按基线补回：它们本轮一律不动，
		// 由下面的 `withoutUnparsable` 从每一张动作清单里剔除（理由写在那里）。
		const ours: SyncFileSet = new Map(scan.files);
		const untouched = new Set(scan.unparsable);
		result.unparsableLocal = [...scan.unparsable];

		const plan: ApplyPlan = {
			writes: [],
			deletes: [],
			// 已占用的名字：盘上的条目 + 索引文件本身（它永不能被条目名写穿）+ 本轮即将写下去的
			taken: [
				{ file: INDEX_FILE },
				...[...scan.files].map(([file, info]) => ({ file, hash: info.hash })),
				...scan.unparsable.map((file) => ({ file })),
			],
			// 读不出的本地文件两个方向都不发布（发布删除 = 一个坏文件删掉两台设备上的同一条记忆），
			// 但它不算 `unagreed`：本轮根本没读到它，谈不上「收不收得下远端那份」，
			// 基线因此冻结在上一次一致的那份（见 `agreedBaseFiles`）。
			excluded: new Set(scan.unparsable),
			unagreed: new Set(),
		};
		const diff = withoutUnparsable(diffThreeWay(previousBase, ours, theirs), untouched);

		for (const file of diff.pullFromRemote) {
			const accepted = await acceptRemote(view, file, result.rejected);
			if (accepted === null) {
				// 拒收的内容既不落盘、也绝不发布出去（发布 = 替对端决定它那份该没了），
				// 更不进基线（进了基线 = 下一轮拿它当「已达成一致」，见 `agreedBaseFiles`）
				markUnagreed(plan, file);
				continue;
			}
			plan.writes.push({ file, raw: accepted.raw });
			plan.taken.push({ file, hash: sha256Hex(accepted.raw) });
		}
		for (const file of diff.deleteLocal) plan.deletes.push(file);
		for (const conflict of diff.conflicts) await convergeConflict(conflict, view, plan, result);

		// 只在**真要改本地文件**时快照 + 落盘 + 重建索引：远端没动的一轮（最常见）必须零本地写入，
		// 否则每次自动拉取都会往 `.backups` 里塞一份快照，把用户还想留着做崩溃恢复的名额挤光。
		const changesLocal = plan.writes.length > 0 || plan.deletes.length > 0;
		let applied: ApplyResult | null = null;
		if (changesLocal) {
			await createSnapshot(
				join(memoryDir, BACKUP_DIR),
				"sync",
				[...scan.files.keys(), ...scan.unparsable, INDEX_FILE],
				memoryDir,
				{ keep: store.cfg.lock.snapshotKeep, now, platform },
			);
			applied = await store.applyEntryFiles(
				{ writes: plan.writes, deletes: plan.deletes },
				{ skipLogicalLock: true, skipSnapshot: true },
			);
			for (const item of applied.rejected) {
				result.rejected.push(item);
				// store 收不下的字节（名字会伪造索引行、碰撞、类型不认识）同样算「没收下」：
				// 进基线就会在下一轮变成「本地删了它」或「本地要盖掉对端」
				markUnagreed(plan, item.file);
			}
			await store.rebuildIndex({ skipLogicalLock: true, skipSnapshot: true });
		}

		const written = new Set(applied?.written ?? []);
		result.pulled = diff.pullFromRemote.filter((file) => written.has(file));
		result.deletedLocal = [...(applied?.deleted ?? [])];

		// 基线里的本地一侧**重新扫一遍**而不是推算：推算会把「被拒收的」「碰撞跳过的」也算成已落盘
		const localAfter: SyncFileSet = changesLocal ? (await scanLocalEntries(memoryDir, platform)).files : scan.files;
		const delta = await publishDelta(localAfter, theirs, plan, result.rejected);
		// pull 轮不发布，但「远端那份要被删掉」这个判定必须报出来，否则用户无从知道自己的删除还没生效。
		// 发布增量里的删除要并进来：「删除 vs 修改」里照办的那次删除是冲突收敛判的，差集只把那个
		// 名字报成冲突（不在 `deleteRemote` 里），漏掉它用户要等到下一轮才看见自己刚删掉的那条。
		result.deletedRemote = [...new Set([...diff.deleteRemote, ...delta.deletions])].sort();
		/**
		 * 基线 = 「两侧上一次真正达成一致的状态」，**不是**「我盘上现在有什么」。
		 *
		 * 所以 `base.revision` 是本轮合并所依据的那个远端版本（发布成功之后才前进到发布返回的新版本，
		 * 见 `publishPhase`），而 `base.files` 是**这一轮的 theirs**（去掉本轮没收下的那些名字）。
		 * 发布成功时 merged == theirs'，此时它恰好等于应用后的扫描结果 —— 那只是推论，不是定义。
		 *
		 * 写成「应用后的扫描结果」会丢用户数据：pull 轮与发布失败都会留下本轮产生、却根本没发布
		 * 出去的本地内容（新写的记忆、冲突副本），一旦进了基线，下一轮的差集就是「base 有 / ours 有 /
		 * theirs 无」= 远端删了它 → `deleteLocal` → 用户自己还没推出去的记忆被从本地删掉。
		 *
		 * 写成「逐名字判一致，不一致就沿用**上一次**的基线条目」也不对：「删除 vs 修改」收敛之后，
		 * 原路径在本地已经没了、而远端那份是被改过的内容，沿用旧条目会让下一轮（只拉取时）再判成
		 * 同一场删改冲突 —— 每拉一次就多出一份副本，永不收敛；按 theirs 此刻的指纹记，下一轮就是
		 * 「base 有 / ours 无 / theirs 未动」→ 把删除推出去，一轮收敛。
		 */
		const baseFiles = agreedBaseFiles(theirs, localAfter, previousBase, untouched, plan.unagreed);
		await writeManifest(manifestFile, {
			version: MANIFEST_VERSION,
			base: { revision: snapshot.revision, syncedAt: now().toISOString() },
			files: asFileRecord(baseFiles),
		});

		// 发布成功之后远端应有的样子 = 本轮基线 + 发布出去的增量。只在发布真成功之后用它前进基线：
		// 没发布出去的本地内容一律不在里面，所以下一轮仍然判得出「本地领先」→ 接着推。
		const remoteAfterPublish: SyncFileSet = new Map(baseFiles);
		for (const { path } of delta.writes) {
			const info = localAfter.get(path);
			if (info !== undefined) remoteAfterPublish.set(path, info);
		}
		for (const path of delta.deletions) remoteAfterPublish.delete(path);

		return { delta, remoteAfterPublish };
	}

	/**
	 * 要发布的增量 = **合并结果相对 theirs 的差异**，不是全量文件集。
	 *
	 * 两边的 hash 都在手上，直接算：远端已经有同一份字节的不发，本地已经没有了的才发删除。
	 * `excluded` 里的名字（读不出的、被拒收的、冲突没收敛掉的）两个方向都跳过 ——
	 * 把它们算成删除等于「我们收不下对端那份，于是把对端那份删了」，那是替用户做决定。
	 */
	async function publishDelta(
		local: SyncFileSet,
		theirs: SyncFileSet,
		plan: ApplyPlan,
		rejected: Array<{ file: string; reason: string }>,
	): Promise<SyncPublishChanges> {
		const writes: Array<{ path: string; content: string }> = [];
		const deletions: string[] = [];
		for (const [file, info] of local) {
			if (plan.excluded.has(file)) continue;
			// 发布方向也要过一遍**写方向**谓词：本地扫描用的是读口径（Linux 上 `con.md` 是一条合法记忆），
			// 而远端是全平台共享的。把一个在任何一台设备上都落不了地的名字推上去，等于往远端埋一条
			// 永远同步不了的记录：它会在每一台的每一轮里被归成范围外，而新设备 onboarding 的第一轮就
			// 撞上它。所以这里不发布、只报一行（原因词是稳定词汇，适配层可以据此分类）。
			if (!isEntryFileNameForWrite(file)) {
				rejected.push({ file, reason: UNPUBLISHABLE_NAME });
				continue;
			}
			if (theirs.get(file)?.hash === info.hash) continue;
			const raw = await readFile(join(memoryDir, file), "utf8").catch((err: unknown) => {
				rejected.push({ file, reason: describeError(err) });
				return null;
			});
			if (raw === null) {
				// 只是这一刻读不到字节（内容本身是收下了的）：不算 `unagreed`，基线照 theirs 记，
				// 下一轮仍然判得出「本地领先」→ 重试发布。算成 unagreed 反而会把这个名字剔出基线，
				// 下一轮就成了「两侧各有一份新增」→ 凭空多出一份冲突副本。
				plan.excluded.add(file);
				continue;
			}
			writes.push({ path: file, content: raw });
		}
		for (const file of theirs.keys()) {
			if (plan.excluded.has(file) || local.has(file)) continue;
			deletions.push(file);
		}
		writes.sort((left, right) => (left.path === right.path ? 0 : left.path < right.path ? -1 : 1));
		deletions.sort();
		return { writes, deletions };
	}

	/**
	 * ③ 发布段（只有 push 轮）：再取一次根锁，把增量推上去，成功之后才把基线推到新的 revision。
	 *
	 * 基线**只在成功之后**前进：发布失败时应用段那次写入记下的仍然是「本轮合并所依据的那个远端
	 * 版本 + 它的文件集」，本轮产生而没发布出去的内容一律没进基线，所以下一轮仍然判得出
	 * 「本地领先」→ 接着推，而不是读成「远端删了它」。
	 */
	async function publishPhase(
		snapshot: RemoteSnapshot,
		applied: AppliedRound,
		result: SyncRoundResult,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<RoundOutcome> {
		const { delta } = applied;
		// 增量为空 = 远端已经有我们全部的字节：不取锁、不做一次注定「无变化」的远端往返
		if (delta.writes.length === 0 && delta.deletions.length === 0) return result;

		const locked = await withRootLock(() =>
			backend.publish(
				scope,
				delta,
				{ revision: snapshot.revision },
				{ timeoutMs, signal, message: publishMessage(delta), author: commitAuthor(device) },
			),
		);
		if (!locked.acquired) {
			// 本轮不发布：本地已经收敛好了，脏状态原样留着，下一次触发接着推
			return failedRound(`${ROOT_LOCK_BUSY}; local changes converged and will be published next time`, result);
		}

		const revision = locked.value;
		result.pushed = delta.writes.map((item) => item.path);
		result.deletedRemote = [...delta.deletions];
		result.revision = revision;
		// 发布成功：两侧真达成一致了，基线才前进到新的 revision，并把发布出去的增量记进去。
		await writeManifest(manifestFile, {
			version: MANIFEST_VERSION,
			base: { revision, syncedAt: now().toISOString() },
			files: asFileRecord(applied.remoteAfterPublish),
		});
		return result;
	}

	/** 提交作者 = 设备身份：`git log` 里看得出哪台机器写了什么（设备归属绝不进文件名）。 */
	function commitAuthor(identity: DeviceIdentity): { name: string; email: string } {
		// 邮箱里放设备 id：hostname 可能重名，id 才是唯一归属。`.invalid` 是保留的永不解析域名 ——
		// 我们从不发信，只是需要一个稳定且唯一的标识。
		return { name: identity.hostname, email: `${identity.id}@sync.invalid` };
	}

	function publishMessage(changes: SyncPublishChanges): string {
		const parts: string[] = [];
		if (changes.writes.length > 0) parts.push(`${changes.writes.length} written`);
		if (changes.deletions.length > 0) parts.push(`${changes.deletions.length} deleted`);
		return `memory sync: ${parts.length > 0 ? parts.join(", ") : "no changes"}`;
	}

	/**
	 * 跑一次尝试。**收的是截止时刻而不是一个毫秒数**：预算要在每一次远端调用之前重新问一次，
	 * 否则传输段花掉的时间不会从发布段的预算里扣（那就又变回「每段各一份满额」）。
	 */
	async function runOnce(mode: Mode, deadline: number, signal: AbortSignal): Promise<RoundOutcome> {
		if (!isConfigured()) throw new SyncSkip(NOT_CONFIGURED);
		// 自动路径绝不偷偷做首次初始化：那可能是一次几十秒的远端往返
		if (!(await backend.ready())) throw new SyncSkip(NOT_INITIALIZED);

		const snapshot = await readRemoteSnapshot(remainingMs(deadline), signal); // ① 出段即释放根锁
		const result = emptyResult();
		result.outOfScopeRemote = [...snapshot.outOfScope];

		try {
			const applied = await applyPhase(snapshot, result); // ② 逻辑锁之内
			// 基线是应用段写下的，所以 `revision` 也只能在那之后报：失败的那一份部分结果同样会交到
			// 用户手上，报一个根本没写进基线的 revision，等于让他们对着一个不存在的状态去排查
			result.revision = snapshot.revision;
			if (mode === "pull") return result;
			return await publishPhase(snapshot, applied, result, remainingMs(deadline), signal); // ③ 再取一次根锁
		} catch (err) {
			// 远端在这轮之间又前进了：整轮重跑一次（重新取远端、重算差集），而不是原地重试一次 publish。
			// 这一次尝试已经落盘的改动不会被重跑撤销，所以连同部分结果一起交出去。
			if (err instanceof NonFastForwardError) return { retry: describeError(err), partial: result };
			// 到了这里，本地很可能**已经改过了**：拉下来的内容、冲突副本、`-sync` 快照、写好的基线，
			// 以及「盘上已落盘、只差记账」的写基线失败。只回一句原因的话，用户看到的 `pulled` /
			// `conflicts` 全是空的，而盘上明明多了文件 —— 所以失败原因必须与部分结果一起出去。
			return failedRound(describeError(err), result);
		}
	}

	/**
	 * 一轮同步：一份**总预算** + 一个**中止信号**，两者都在这一层生成、往下传给每一次 backend 调用。
	 *
	 * 预算为什么是「一轮」而不是「一次调用」：配置里那两档时限的推理是按一轮算的（自动档被
	 * await 在会话启动路径上，所以只给 5s），而一轮至少是 `fetch` + `publish` 两次调用、每次调用里
	 * 又是好几个子进程（离线路径上 `fetch` 失败后还要再探一次远端）。每个子进程各拿一份满额预算，
	 * 最坏情况就是配置值的好几倍 —— 正是那两档时限要避免的事。所以这里只传**剩下的毫秒**。
	 */
	function runRound(mode: Mode, timeoutMs: number): Promise<SyncRoundResult> {
		return withAbortSignal((signal) => attemptRound(mode, timeoutMs, signal));
	}

	async function attemptRound(mode: Mode, timeoutMs: number, signal: AbortSignal): Promise<SyncRoundResult> {
		const deadline = Date.now() + timeoutMs;
		let lastRetry = "";
		// 到目前为止本轮**已经落到本地**的那部分。失败报告必须带着它：失败可能发生在应用段之后
		// （非快进重跑、发布时的传输错误、写基线失败），那时本地早就改过了，而「同步到底动没动
		// 我的记忆」正是这个功能被评判的那个问题。
		let lastPartial: SyncRoundResult | undefined;
		// 重跑的是**整轮**（重新取远端 → 重算差集 → 重新应用 → 重新发布）：非快进意味着远端变了，
		// 上一轮算出来的差集已经作废，原地重试 publish 只会再撞一次。落盘与副本命名都是幂等的
		// （同一份内容派生同一个名字），代价只是可能多拍一份 `-sync` 快照。
		for (let attempt = 1; attempt <= MAX_ROUND_ATTEMPTS; attempt += 1) {
			// 预算耗尽就不再起重跑，而是给一句说得清的原因。拿零头去跑第二次等于让重跑系统性地
			// 饿死（看起来像一次传输失败），而给每次尝试一份满额预算又把一轮变成 2×。
			// 基线不前进、脏标记留着，下一次触发接着来 —— 与「重试用尽」同一个出口。
			if (attempt > 1 && deadline - Date.now() <= 0) {
				return failedRound(
					`${lastRetry} — the round budget of ${timeoutMs}ms ran out before a retry could start; ` +
						"nothing was published this round, but it may already have changed local memory " +
						"(see pulled/conflicts in this result); the next round will retry",
					lastPartial,
				);
			}
			try {
				const outcome = await runOnce(mode, deadline, signal);
				if (!("retry" in outcome)) return outcome;
				lastRetry = outcome.retry;
				// 合并而不是覆盖：重跑不撤销上一次的落盘（理由写在 `mergePartials`）
				lastPartial = mergePartials(lastPartial, outcome.partial);
			} catch (err) {
				// 一次同步失败绝不允许打断会话：所有异常都在这里变成一句可读的原因。
				// 走到这里的只剩下传输段（及它之前）的失败：本轮一个字都没动时 `lastPartial` 为空，
				// 重跑那一轮的 fetch 失败时它带着上一次尝试已经落盘的那部分。
				return failedRound(describeError(err), lastPartial);
			}
		}
		return failedRound(
			`${lastRetry} — gave up after ${MAX_ROUND_ATTEMPTS} attempts; nothing was published this round, ` +
				"but it may already have changed local memory (see pulled/conflicts in this result); the next round will retry",
			lastPartial,
		);
	}

	/** `status` 自己出意外时的兜底报告：字段齐全、只有 `errors` 里有话。 */
	function emptyStatusReport(): SyncStatusReport {
		return {
			configured: isConfigured(),
			initialized: false,
			remote: typeof config.remote === "string" ? config.remote : "",
			branch: config.branch,
			device,
			projectDir,
			projectKey,
			base: null,
			ahead: [],
			behind: [],
			conflicts: [],
			rejected: [],
			unparsableLocal: [],
			outOfScopeRemote: [],
			errors: [],
		};
	}

	/** 算一份报告。**dry-run**：全程只读，盘上一个字都不改。 */
	function computeStatus(timeoutMs: number): Promise<SyncStatusReport> {
		// status 也要挂上中止信号：它同样会碰远端（一次 fetch），而宿主退出时该收尾的不只是同步轮。
		return withAbortSignal((signal) => buildStatusReport(timeoutMs, signal));
	}

	async function buildStatusReport(timeoutMs: number, signal: AbortSignal): Promise<SyncStatusReport> {
		const manifest = await readManifest(manifestFile);
		// 初值只有一份（`emptyStatusReport`）：字段清单写两遍，加字段时必然漏掉一边
		const report = emptyStatusReport();
		report.base = manifest?.base ?? null;
		if (!report.configured) {
			report.errors.push(NOT_CONFIGURED);
			return report;
		}
		try {
			report.initialized = await backend.ready();
		} catch (err) {
			report.errors.push(describeError(err));
			return report;
		}
		if (!report.initialized) {
			report.errors.push(NOT_INITIALIZED);
			return report;
		}

		// dry-run：下面全程只读 —— 不快照、不落盘、不重建索引、不写基线
		let snapshot: RemoteSnapshot;
		try {
			snapshot = await readRemoteSnapshot(timeoutMs, signal);
		} catch (err) {
			report.errors.push(describeError(err));
			return report;
		}
		report.outOfScopeRemote = [...snapshot.outOfScope];

		let scan: LocalScan;
		try {
			scan = await scanLocalEntries(memoryDir, platform);
		} catch (err) {
			report.errors.push(describeError(err));
			return report;
		}
		report.unparsableLocal = [...scan.unparsable];

		const previousBase = asFileSet(manifest?.files ?? {});
		const ours: SyncFileSet = new Map(scan.files);
		// 与真跑的同步轮同一套口径：读不出的本地文件本轮一律不动，所以既不会出现在
		// ahead/behind，也不会出现在 conflicts 里 —— 否则报告会把一个永远不会执行的动作说给用户听。
		const diff = withoutUnparsable(diffThreeWay(previousBase, ours, snapshot.theirs), new Set(scan.unparsable));
		report.ahead = [...diff.pushLocal, ...diff.deleteRemote].sort();
		report.behind = [...diff.pullFromRemote, ...diff.deleteLocal].sort();
		report.conflicts = diff.conflicts.map((conflict) => conflict.file);

		// 与真跑的发布段同一口径：本地有、但在任何一台设备上都写不下去的名字永远发不出去。
		// 不报的话 `ahead` 每轮都列着它、却永远推不上去，用户只看到「本地领先 1 条」而不知道原因。
		for (const file of diff.pushLocal) {
			if (!isEntryFileNameForWrite(file)) report.rejected.push({ file, reason: UNPUBLISHABLE_NAME });
		}

		// 会被拒收的远端内容也要报出来：用户看到的应该是「这条同步不了，因为……」，
		// 而不是每轮拉取都静默失败。只读这一轮真要动的那些名字，不为报告把远端全读一遍。
		const candidates = [
			...diff.pullFromRemote,
			...diff.conflicts.filter((conflict) => conflict.theirs !== null).map((conflict) => conflict.file),
		];
		for (const file of candidates) await acceptRemote(snapshot.view, file, report.rejected);
		return report;
	}

	/**
	 * 写触发推送：去抖之后跑一次 push 轮。`pushOnWrite` 关闭时用空转版本。
	 *
	 * 推送与手动 `push()` 走同一条 `runRound`：锁、快照、冲突收敛、基线全都不变，
	 * 唯一区别是它由写入触发而不是用户敲命令。
	 */
	// `=== true`：同 `isConfigured`，一个字符串 `"false"` 不得被读成「开着自动推送」
	const scheduler: SyncScheduler<SyncRoundResult> =
		config.pushOnWrite === true
			? createSyncScheduler<SyncRoundResult>({
					debounceMs: debounce,
					timeoutMs: autoBudget,
					/*
					 * 「没发布成功的一轮」必须映射成 `null`。`runRound` 永远 resolve 出一个结果对象 ——
					 * 锁忙是 `SyncSkip`、传输失败是 `failedRound`，都包在 `ok: false` 里，从不 reject ——
					 * 原样交过去的话调度器看到的是「永远成功」，退出兜底就会谎报干净。
					 */
					run: async (timeoutMs) => {
						const result = await runRound("push", timeoutMs);
						return result.ok ? result : null;
					},
				})
			: NOOP_SCHEDULER;

	return {
		pull: (timeoutMs?: number) => runRound("pull", positiveMs(timeoutMs, autoBudget)),
		push: (timeoutMs?: number) => runRound("push", positiveMs(timeoutMs, autoBudget)),
		status: (timeoutMs?: number) =>
			computeStatus(positiveMs(timeoutMs, manualBudget)).catch((err: unknown) => {
				// 报告本身也绝不抛：状态命令失败时至少给出一份带错误的报告
				const fallback = emptyStatusReport();
				fallback.errors.push(describeError(err));
				return fallback;
			}),
		// 写触发推送的三个出口：记下写入、退出/补推时立刻跑一次、收摊。全部转发给调度器。
		noteWrite: () => scheduler.noteWrite(),
		flush: (timeoutMs?: number) => scheduler.flush(positiveMs(timeoutMs, autoBudget)),
		dispose: () => {
			// 先中止在途那一轮的远端调用，再收摊调度器：宿主的退出路径是「`dispose()` → `await inFlight`」，
			// 少了这一步，一次挂死的 fetch/publish 会把退出拖到子进程自己的超时跑完为止。
			for (const controller of activeSignals) controller.abort();
			activeSignals.clear();
			scheduler.dispose();
		},
		get inFlight(): Promise<unknown> | null {
			return scheduler.inFlight;
		},
	};
}
