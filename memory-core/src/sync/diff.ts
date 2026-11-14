import type { SyncFileInfo, SyncFileSet } from "./types.js";

/**
 * 一条冲突：同一个 entry 文件名在两侧都「有话说」且内容不同。
 *
 * `null` = 这一侧已经删除（删除 vs 修改的冲突）。两侧不可能同时为 null —— 那是「两边都删」，
 * 属于无动作行，不进 conflicts。
 * **不要用哨兵值**（例如 `hash: ""`）表示删除：冲突收敛与同步引擎都要判这一侧，
 * 显式 null 让 TypeScript 强制每个消费者处理它，哨兵值只靠约定 —— 约定错一次就会静默吞掉用户的删除，
 * 让那条记忆在两台设备上一起复活。
 */
export interface SyncConflict {
	/** entry 文件名（单层，与 `SyncFileSet` 的 key 同口径）。 */
	file: string;
	/** `null` = 本地这一侧已删除。 */
	ours: SyncFileInfo | null;
	/** `null` = 远端这一侧已删除。 */
	theirs: SyncFileInfo | null;
}

/** 一次三方合并的完整结论：四张单侧动作清单，外加要交给冲突收敛的那些路径。 */
export interface SyncDiff {
	/** 远端胜：要用远端内容写入本地。 */
	pullFromRemote: string[];
	/** 本地胜：要发布到远端。 */
	pushLocal: string[];
	/** 本地要删。 */
	deleteLocal: string[];
	/** 远端要删。 */
	deleteRemote: string[];
	/** 交给冲突收敛。 */
	conflicts: SyncConflict[];
}

/** 「内容相同」的唯一判据。`modified` / `bytes` 是载荷，不是比较条件。 */
function same(left: SyncFileInfo | undefined, right: SyncFileInfo | undefined): boolean {
	return left?.hash === right?.hash;
}

/**
 * 码点序，不是 locale 序。
 *
 * 排序是为了确定性（便于断言、快照与"两台设备排出同一个顺序"），locale 序会随语言环境漂移，
 * 那正好破坏了它存在的理由。
 */
function compareNames(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/**
 * 三方差集：同步的合并语义全部集中在这一个函数里。
 *
 * 三路输入：`base` 是上一次成功同步时记下的清单（首次同步为空集），`ours` 是本地此刻的扫描结果，
 * `theirs` 是远端此刻的状态。输出的是**动作**而不是结果：谁来写盘、谁来发布由调用方决定。
 *
 * 判据只有 `hash`。`modified` 与 `bytes` 在这里不参与比较 —— 它们是载荷，留给冲突收敛去决定
 * 「谁留在原路径」；把时间戳拉进比较会让同一份内容因读取时刻不同而永远判不出「没变」。
 *
 * 逐路径的完整规则（「同」= hash 与 `base` 相等，「改」= 不相等）：
 * - 两侧当前内容一致 → 无动作。包括两侧都删了、两侧都改成了同一份内容：后者让「两台设备各自跑了
 *   同一次整理」成为无动作，而不是凭空生出两份互相冲突的副本。
 * - `base` 里没有、只有一侧有 → 那一侧是新增：本地有就推，远端有就拉。
 * - `base` 里有、一侧删了、另一侧没动 → 删除传播过去：本地删了删远端，远端删了删本地。
 * - `base` 里有、一侧删了、另一侧改了 → 冲突：删除照办，被改的那份由冲突收敛按新 entry 留下，
 *   没有任何一方丢内容。这条的删除半边不在这四张清单里 —— 原路径的删与留由冲突收敛一并决定，
 *   在这里先删一次会让原路径被「删掉又写回」。
 * - 两侧都在：只有一侧相对 `base` 变了 → 变了的那侧胜（本地变则推，远端变则拉）；两侧都变了 → 冲突。
 *
 * 纯函数：零 IO、不读文件、不认识锁与 backend、不改动任何入参（连返回的数组都是新建的）。
 * 所有「磁盘上到底能不能读」的问题都在调用方解决：例如本地某个文件这一轮解析不出，调用方必须按
 * `base` 的指纹把它补回 `ours`，否则这里只能读到「这一侧没有它」，从而把一次解析失败读成用户删除，
 * 并把删除传播到远端。这个函数没有、也不该有判断这件事的信息。
 *
 * 四张清单都按文件名码点序排序；`conflicts` 同样按文件名排，让调用方的落盘与上报顺序也确定。
 */
export function diffThreeWay(base: SyncFileSet, ours: SyncFileSet, theirs: SyncFileSet): SyncDiff {
	const diff: SyncDiff = {
		pullFromRemote: [],
		pushLocal: [],
		deleteLocal: [],
		deleteRemote: [],
		conflicts: [],
	};

	for (const file of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
		const inBase = base.get(file);
		const inOurs = ours.get(file);
		const inTheirs = theirs.get(file);

		// 一、两侧当前一致（含两侧都不存在）→ 收敛情形，无动作。
		if (same(inOurs, inTheirs)) continue;

		// 二、只剩一侧有：新增、单侧删除的传播，或者「删 vs 改」。
		if (!inOurs || !inTheirs) {
			const oursSurvives = inOurs !== undefined;
			const survivor = oursSurvives ? inOurs : inTheirs;
			if (!inBase) {
				// base 里没有过 = 纯新增：本地有就推，远端有就拉。
				(oursSurvives ? diff.pushLocal : diff.pullFromRemote).push(file);
			} else if (same(inBase, survivor)) {
				// 活着的那侧没动过它，这边的删除就是唯一的变更 → 把删除传播到对侧。
				(oursSurvives ? diff.deleteLocal : diff.deleteRemote).push(file);
			} else {
				// 一侧删、另一侧改：谁都不许丢内容，交给冲突收敛。被删的那侧是 null。
				diff.conflicts.push({ file, ours: inOurs ?? null, theirs: inTheirs ?? null });
			}
			continue;
		}

		// 三、两侧都有且内容不同：只有一侧变了就那侧胜，两侧都变才是冲突。
		if (same(inBase, inOurs)) diff.pullFromRemote.push(file);
		else if (same(inBase, inTheirs)) diff.pushLocal.push(file);
		else diff.conflicts.push({ file, ours: inOurs, theirs: inTheirs });
	}

	diff.pullFromRemote.sort(compareNames);
	diff.pushLocal.sort(compareNames);
	diff.deleteLocal.sort(compareNames);
	diff.deleteRemote.sort(compareNames);
	diff.conflicts.sort((left, right) => compareNames(left.file, right.file));

	return diff;
}

/**
 * 本轮是否无事可做。
 *
 * 冲突也算「有事」：它要么产出磁盘写入（新 entry + 原路径的内容变更），要么至少要报给用户，
 * 所以空差集必须是五个字段全空 —— 只看四张清单会让「只剩冲突」的一轮被当成无事发生，
 * 静默吞掉冲突。
 */
export function isEmptyDiff(diff: SyncDiff): boolean {
	return (
		diff.pullFromRemote.length === 0 &&
		diff.pushLocal.length === 0 &&
		diff.deleteLocal.length === 0 &&
		diff.deleteRemote.length === 0 &&
		diff.conflicts.length === 0
	);
}
