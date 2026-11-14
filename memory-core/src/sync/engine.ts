import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncConfig } from "../config.js";
import { type ParsedEntryFile, parseEntryFile } from "../store/entry-file.js";
import { isEntryFileName } from "../store/filename.js";
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
import { diffThreeWay, type SyncConflict } from "./diff.js";
import { sha256Hex } from "./hash.js";
import { emptyManifest, MANIFEST_VERSION, manifestPath, readManifest, writeManifest } from "./manifest.js";
import { type LocalScan, scanLocalEntries } from "./scan.js";
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
 * 四条数据安全线（`unparsable` 不是删除、远端 `modified` 必须先验形状、冲突收敛抛错只跳过该条、
 * 根级 sync 锁真的存在）各自在实现处写了「为什么不能删掉这段」。
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
	 * （`unparsable frontmatter` / `invalid modified`），异常路径（读不到字节、冲突没收敛掉）
	 * 则直接把底层错误拼进去 —— 那些不是词汇，是诊断信息。 */
	rejected: Array<{ file: string; reason: string }>;
	/** 本地解析不出/读不了的 `.md`：本轮不参与判定，但必须让用户知道它没同步。 */
	unparsableLocal: string[];
	/** 远端存在、但不属于本 scope 的路径（远端根相对）。 */
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
	/** 立刻跑一次去抖中的推送；没有在途/待推的工作则返回 `null`。 */
	flush(timeoutMs?: number): Promise<SyncRoundResult | null>;
	/** 释放调度器持有的资源。绝不抛错。 */
	dispose(): void;
}

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
 * 这个项目的远端前缀。
 *
 * `projectKey` 已经是 `remoteProjectKey` 的输出，所以这里只补远端布局的那一段目录，
 * 而不能再走一次 `remotePrefix`（它的入参是**身份 key**，再派生一次等于二次转义）。
 */
function syncPrefix(projectKey: string): string {
	return `git/${projectKey}`;
}

function asFileSet(files: Record<string, SyncFileInfo>): SyncFileSet {
	return new Map(Object.entries(files));
}

function asFileRecord(files: SyncFileSet): Record<string, SyncFileInfo> {
	return Object.fromEntries(files);
}

/**
 * 算出这一轮之后该记进基线的文件集。
 *
 * 基线是三方合并里的「共同祖先」，所以它只能记**两边真的一致**的那些名字。把「只有本地有」
 * 的内容记进基线是本功能最危险的一个错误：下一轮的差集会读成「base 有 / ours 有 / theirs 无」
 * = 远端删了它 → 引擎把用户自己的记忆从本地删掉。而「发布失败」与「pull 轮不发布」两种情况
 * 恰恰都会留下只有一边有的内容，所以这里逐名字判一致，不一致的一律沿用上一次基线。
 *
 * @param local 应用之后重新扫出来的本地文件集
 * @param remote 这一刻远端持有的文件集（发布段成功之后传「发布后的远端」）
 * @param previous 上一次的基线
 * @param deletedLocally 本轮在本地删掉、但远端还留着的名字（删除还没发布出去）
 */
function nextBaseFiles(
	local: SyncFileSet,
	remote: SyncFileSet,
	previous: SyncFileSet,
	deletedLocally: ReadonlySet<string>,
): Record<string, SyncFileInfo> {
	const agreed = new Map<string, SyncFileInfo>();

	for (const [file, info] of local) {
		const there = remote.get(file);
		if (there !== undefined && there.hash === info.hash) agreed.set(file, info);
		else {
			// 还没达成一致（本轮没发布、发布失败、或被拒收）：沿用上一次基线，
			// 于是下一轮仍然判得出「本地改了、远端没改」→ 继续推。
			const carried = previous.get(file);
			if (carried !== undefined) agreed.set(file, carried);
		}
	}
	// 本地已经没有、远端还留着的名字：只有「远端那份与基线一致」时才保留基线条目 ——
	// 那说明本地删除还没发布成功，下一轮要接着推这次删除。发布成功之后远端也没有它了，
	// 这里自然就把它丢掉，基线不会留一条永远不会兑现的账。
	for (const [file, info] of previous) {
		if (agreed.has(file) || local.has(file)) continue;
		const there = remote.get(file);
		if (there !== undefined && there.hash === info.hash) agreed.set(file, info);
	}
	// 「删除 vs 修改」的冲突里原路径被删掉，而远端那一份与基线并不相同（对端改过）：
	// 按远端此刻的指纹记进基线，下一轮才会仍然判成「本地删了、远端没动」→ 把删除推出去，
	// 而不是把远端那份重新拉回来（那会让「删除照办」在下一轮被自己撤销）。
	for (const file of deletedLocally) {
		if (agreed.has(file) || local.has(file)) continue;
		const there = remote.get(file);
		if (there !== undefined) agreed.set(file, there);
	}
	return asFileRecord(agreed);
}

/** 一次远端快照里引擎要用的部分：内容按名字取，`theirs` 只有 hash 是真的（见 `readRemoteSnapshot`）。 */
interface RemoteSnapshot {
	view: RemoteView;
	revision: string;
	theirs: SyncFileSet;
	outOfScope: string[];
}

/** 应用段的产物：交给发布段的增量，以及推进基线所需的三份文件集。 */
interface AppliedRound {
	delta: SyncPublishChanges;
	localAfter: SyncFileSet;
	previousBase: SyncFileSet;
	/** 发布成功之后远端应有的样子（用它推进基线，才不会把没发布的内容记成已一致）。 */
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
	const scope: SyncScope = { prefix: syncPrefix(projectKey) };

	const NOT_CONFIGURED = "sync is not configured: set sync.enabled and a sync remote first";
	const NOT_INITIALIZED = "the sync backend is not initialized: run the sync init command first";
	const ROOT_LOCK_BUSY = "another sync round holds the root sync lock, so this round was skipped";
	const MEMORY_LOCK_BUSY = "the memory lock for this project is busy, so this round was skipped";

	function isConfigured(): boolean {
		// 逐字判类型：配置合并那一层不校验类型，`remote` 可能是任何值
		return Boolean(config.enabled) && typeof config.remote === "string" && config.remote.trim() !== "";
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
	 * ① 传输段：取一份远端快照，出段即释放根锁。
	 *
	 * `list()` 的 hash 是差集唯一的判据，但 `modified` / `bytes` 不在端口里 —— 它们要从内容里解析，
	 * 而内容只在真要落到本地时才读（`view.read`）。所以 `theirs` 里只有 hash 是真的，
	 * `modified`/`bytes` 是占位值：**任何消费者都不得读它们**，需要时按读到的字节重算
	 * （见 `remoteSide`）。远端可能上千条记忆，为一轮里通常一两条变更把全部内容读一遍不值得。
	 */
	async function readRemoteSnapshot(timeoutMs: number): Promise<RemoteSnapshot> {
		const locked = await withRootLock(async () => {
			const view = await backend.fetch(scope, { timeoutMs });
			return { view, listed: await view.list() };
		});
		if (!locked.acquired) throw new SyncSkip(ROOT_LOCK_BUSY);

		const theirs: SyncFileSet = new Map();
		// 范围外的路径原样报出去（远端根相对）：静默丢掉的话，用户永远不知道远端有内容没进同步
		const outOfScope = [...locked.value.view.outOfScope];
		for (const { path, hash } of locked.value.listed) {
			// 与本地扫描共用同一份文件名口径（`isEntryFileName`）：口径一旦漂移，两侧就会拿不同
			// 形态的 key 互相找不到。远端前缀里被人手工推上来的索引文件、点开头的文件、嵌套目录
			// 都不是记忆 —— 报成范围外，而不是交给 `applyEntryFiles`（它会为畸形路径让整轮失败）。
			if (!isEntryFileName(path, platform)) {
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
			plan.excluded.add(file);
			return null;
		}
		const parsed = parseEntryFile(raw);
		if (parsed === null) {
			// 正常走不到这里：解析不出的本地文件会被扫描归进 `unparsable`，并按基线的指纹补回
			// `ours`（= 没改过），差集因此不会把它判成冲突。真撞上只可能是它在扫描之后才坏掉，
			// 处置与上面一致：这一条不动，两侧内容都原样留着。
			rejected.push({ file, reason: "unparsable frontmatter" });
			plan.excluded.add(file);
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
			plan.excluded.add(file);
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
			plan.excluded.add(file);
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

		/**
		 * 解析不出/读不了的本地文件**不是删除**。
		 *
		 * 扫描把它放进 `unparsable` 而不是 `files`，于是差集看到「base 有 / ours 无 / theirs 未动」
		 * = 用户删了它 → 删除被推到远端 → 一个坏文件（手滑编辑、半截写入、权限抖动）就能把
		 * 两台设备上的同一条记忆一起删掉，而本地那份还躺在盘上。所以这里按基线的指纹把它补回
		 * `ours`，等于宣告「本地这一份本轮不参与判定」；名字仍然进 `unparsableLocal` 报告。
		 *
		 * 补回之后它仍可能被差集判成「远端胜」（对端改了或删了，而本地这一份按基线算没动），
		 * 那是三方合并的正常结论，不是本段要拦的：字节已经进了本轮的 `-sync` 快照，而拿远端
		 * 一份能读的内容替掉本地一份读不出的内容，正是收敛。真正要拦的是「拿它当本地删除」，
		 * 以及「把它发布出去」（见 `ApplyPlan.excluded`）。
		 */
		const ours: SyncFileSet = new Map(scan.files);
		for (const file of scan.unparsable) {
			const known = previousBase.get(file);
			if (known !== undefined) ours.set(file, known);
		}
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
			excluded: new Set(scan.unparsable),
		};
		const diff = diffThreeWay(previousBase, ours, theirs);
		// pull 轮不发布，但「本地删了、远端还留着」这个判定要报出来，否则用户无从知道删除还没生效
		result.deletedRemote = [...diff.deleteRemote];

		for (const file of diff.pullFromRemote) {
			const accepted = await acceptRemote(view, file, result.rejected);
			if (accepted === null) {
				// 拒收的内容既不落盘、也绝不发布出去（发布 = 替对端决定它那份该没了）
				plan.excluded.add(file);
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
				plan.excluded.add(item.file);
			}
			await store.rebuildIndex({ skipLogicalLock: true, skipSnapshot: true });
		}

		const written = new Set(applied?.written ?? []);
		result.pulled = diff.pullFromRemote.filter((file) => written.has(file));
		result.deletedLocal = [...(applied?.deleted ?? [])];

		// 基线里的文件集**重新扫一遍**而不是推算：推算会把「被拒收的」「碰撞跳过的」也算成已一致
		const localAfter: SyncFileSet = changesLocal ? (await scanLocalEntries(memoryDir, platform)).files : scan.files;
		const delta = await publishDelta(localAfter, theirs, plan, result.rejected);
		await writeManifest(manifestFile, {
			version: MANIFEST_VERSION,
			base: { revision: snapshot.revision, syncedAt: now().toISOString() },
			files: nextBaseFiles(localAfter, theirs, previousBase, new Set(applied?.deleted ?? [])),
		});

		const remoteAfterPublish: SyncFileSet = new Map(theirs);
		for (const { path } of delta.writes) {
			const info = localAfter.get(path);
			if (info !== undefined) remoteAfterPublish.set(path, info);
		}
		for (const path of delta.deletions) remoteAfterPublish.delete(path);

		return { delta, localAfter, previousBase, remoteAfterPublish };
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
			if (theirs.get(file)?.hash === info.hash) continue;
			const raw = await readFile(join(memoryDir, file), "utf8").catch((err: unknown) => {
				rejected.push({ file, reason: describeError(err) });
				return null;
			});
			if (raw === null) {
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
	 * 基线**只在成功之后**前进：发布失败时上面那次写入已经把「两边一致的那些」记进去了，
	 * 而没发布出去的内容一律没进基线，所以下一轮仍然判得出「本地领先」→ 接着推。
	 */
	async function publishPhase(
		snapshot: RemoteSnapshot,
		applied: AppliedRound,
		result: SyncRoundResult,
		timeoutMs: number,
	): Promise<RoundOutcome> {
		const { delta } = applied;
		// 增量为空 = 远端已经有我们全部的字节：不取锁、不做一次注定「无变化」的远端往返
		if (delta.writes.length === 0 && delta.deletions.length === 0) return result;

		const locked = await withRootLock(() =>
			backend.publish(
				scope,
				delta,
				{ revision: snapshot.revision },
				{ timeoutMs, message: publishMessage(delta), author: commitAuthor(device) },
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
		await writeManifest(manifestFile, {
			version: MANIFEST_VERSION,
			base: { revision, syncedAt: now().toISOString() },
			files: nextBaseFiles(applied.localAfter, applied.remoteAfterPublish, applied.previousBase, new Set()),
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

	async function runOnce(mode: Mode, timeoutMs: number): Promise<RoundOutcome> {
		if (!isConfigured()) throw new SyncSkip(NOT_CONFIGURED);
		// 自动路径绝不偷偷做首次初始化：那可能是一次几十秒的远端往返
		if (!(await backend.ready())) throw new SyncSkip(NOT_INITIALIZED);

		const snapshot = await readRemoteSnapshot(timeoutMs); // ① 出段即释放根锁
		const result = emptyResult();
		result.outOfScopeRemote = [...snapshot.outOfScope];
		result.revision = snapshot.revision;

		const applied = await applyPhase(snapshot, result); // ② 逻辑锁之内
		if (mode === "pull") return result;

		try {
			return await publishPhase(snapshot, applied, result, timeoutMs); // ③ 再取一次根锁
		} catch (err) {
			// 远端在这轮之间又前进了：整轮重跑一次（重新取远端、重算差集），而不是原地重试一次 publish
			if (err instanceof NonFastForwardError) return { retry: describeError(err) };
			throw err;
		}
	}

	async function runRound(mode: Mode, timeoutMs: number): Promise<SyncRoundResult> {
		let lastRetry = "";
		// 重跑的是**整轮**（重新取远端 → 重算差集 → 重新应用 → 重新发布）：非快进意味着远端变了，
		// 上一轮算出来的差集已经作废，原地重试 publish 只会再撞一次。落盘与副本命名都是幂等的
		// （同一份内容派生同一个名字），代价只是可能多拍一份 `-sync` 快照。
		for (let attempt = 1; attempt <= MAX_ROUND_ATTEMPTS; attempt += 1) {
			try {
				const outcome = await runOnce(mode, timeoutMs);
				if (!("retry" in outcome)) return outcome;
				lastRetry = outcome.retry;
			} catch (err) {
				// 一次同步失败绝不允许打断会话：所有异常都在这里变成一句可读的原因
				return failedRound(describeError(err));
			}
		}
		return failedRound(
			`${lastRetry} — gave up after ${MAX_ROUND_ATTEMPTS} attempts; local memory is untouched and the next round will retry`,
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
	async function computeStatus(timeoutMs: number): Promise<SyncStatusReport> {
		const manifest = await readManifest(manifestFile);
		const report: SyncStatusReport = {
			configured: isConfigured(),
			initialized: false,
			remote: typeof config.remote === "string" ? config.remote : "",
			branch: config.branch,
			device,
			projectDir,
			projectKey,
			base: manifest?.base ?? null,
			ahead: [],
			behind: [],
			conflicts: [],
			rejected: [],
			unparsableLocal: [],
			outOfScopeRemote: [],
			errors: [],
		};
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
			snapshot = await readRemoteSnapshot(timeoutMs);
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
		for (const file of scan.unparsable) {
			const known = previousBase.get(file);
			if (known !== undefined) ours.set(file, known);
		}
		const diff = diffThreeWay(previousBase, ours, snapshot.theirs);
		report.ahead = [...diff.pushLocal, ...diff.deleteRemote].sort();
		report.behind = [...diff.pullFromRemote, ...diff.deleteLocal].sort();
		report.conflicts = diff.conflicts.map((conflict) => conflict.file);

		// 会被拒收的远端内容也要报出来：用户看到的应该是「这条同步不了，因为……」，
		// 而不是每轮拉取都静默失败。只读这一轮真要动的那些名字，不为报告把远端全读一遍。
		const candidates = [
			...diff.pullFromRemote,
			...diff.conflicts.filter((conflict) => conflict.theirs !== null).map((conflict) => conflict.file),
		];
		for (const file of candidates) await acceptRemote(snapshot.view, file, report.rejected);
		return report;
	}

	return {
		pull: (timeoutMs?: number) => runRound("pull", timeoutMs ?? config.autoTimeoutMs),
		push: (timeoutMs?: number) => runRound("push", timeoutMs ?? config.autoTimeoutMs),
		status: (timeoutMs?: number) =>
			computeStatus(timeoutMs ?? config.timeoutMs).catch((err: unknown) => {
				// 报告本身也绝不抛：状态命令失败时至少给出一份带错误的报告
				const fallback = emptyStatusReport();
				fallback.errors.push(describeError(err));
				return fallback;
			}),
		// 以下三个由写触发调度器接线（去抖、退出兜底、在途账本）；在那之前是安全的空操作。
		noteWrite(): void {},
		flush(): Promise<null> {
			return Promise.resolve(null);
		},
		dispose(): void {},
	};
}
