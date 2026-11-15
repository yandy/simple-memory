import { parseEntryFile, serializeEntryFile } from "../store/entry-file.js";
import { ENTRY_EXT, entryFileName } from "../store/filename.js";
import { sha256Hex } from "./hash.js";
import type { SyncFileInfo } from "./types.js";

/**
 * 冲突收敛：同一个 entry 文件在两侧内容不同时，决定「谁留在原路径、谁另存为新 entry」。
 *
 * 策略是**两份都留**：`modified` 新的一方留在原路径（逐字写入），被挤出来的那一份成为一条新记忆，
 * `name` 带上由它自己的内容派生的后缀，后续的合并交给整理流程（它的既有职责就是合并重复、解决矛盾）。
 * 「删除 vs 修改」是同一套规则的另一半：删除照办（原路径要删），幸存的那份内容按新 entry 留下 ——
 * 没有任何一方丢内容，删除的意图也被执行。
 *
 * **载重不变量：产物只能是冲突内容的函数。** 两台设备各自解同一次冲突（一台在拉、另一台也在拉），
 * 必须算出逐字节相同的新文件名与字节。一旦后缀里掺进本地状态 —— hostname、设备 id、当天日期、
 * 或者目录里恰好有什么 —— 两台设备就各造一份副本，下一轮互相把对方的副本拉过来，
 * 用户的同一条记忆变成三份、四份，永不收敛。因此这里：
 * - 不用时钟（`modified` 非法时退回**常量**，不退回今天）；
 * - 不用主机与设备信息；
 * - 不用 `resolveUniqueFileName` —— 它的 `-2`/`-3` 取决于本地目录里恰好有什么，
 *   撞名时改追加**这份内容自己的** sha256 指纹，仍然是内容的函数。
 *
 * 纯函数、零 IO：字节由调用方读、文件由调用方写，这里只决定「写什么、写到哪个名字」。
 */

/** 冲突的一侧：字节 + 它的指纹。`null` = 这一侧已删除（来自 `SyncConflict` 的同一套表示）。两侧不会同时为 null。 */
export interface ConflictSide {
	/** 这一侧此刻的完整字节（逐字：行尾与空白都算内容）。 */
	raw: string;
	/** 同一份内容的指纹（扫描与清单的口径）。 */
	info: SyncFileInfo;
}

/** 一次要收敛的冲突。形状与差集给出的 `SyncConflict` 对齐，只是两侧各自带上了字节。 */
export interface ConflictInput {
	/** 冲突所在的 entry 文件名（原路径）。派生名字**不**来自它 —— 只用于报错时指明是哪一条。 */
	file: string;
	/** `null` = 本地这一侧已删除。 */
	ours: ConflictSide | null;
	/** `null` = 远端这一侧已删除。 */
	theirs: ConflictSide | null;
}

export interface ConflictOutcome {
	/**
	 * 原路径要写的字节（逐字，不重新序列化）；
	 * **`null` = 原路径要被删除** —— 删除 vs 修改时删除照办，幸存的那份内容改由 loserEntry 承接。
	 */
	winnerRaw: string | null;
	/**
	 * 需要另存为新 entry 的那一份（名字已加内容派生的后缀）；
	 * `null` = 没有需要另存的一方（删除 vs 修改时，被删的那一侧没有内容要留）。
	 */
	loserEntry: { name: string; file: string; raw: string } | null;
}

/** 另存为新 entry 的那一份（`ConflictOutcome.loserEntry` 的非 null 形态）。 */
type NewEntry = NonNullable<ConflictOutcome["loserEntry"]>;

/** `modified` 取不出日期时用的**常量**。绝不用今天：今天会让两台设备在不同日子算出不同后缀。 */
const UNKNOWN_DATE = "unknown-date";

/** 后缀与派生文件名里都用 sha256 的前 6 位当内容指纹。 */
const FINGERPRINT_LENGTH = 6;

/** `modified` 的前 10 字符要正好是 `YYYY-MM-DD` 才算日期。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 一份内容的「日期 + 指纹」。后缀与派生文件名都由它拼出来，两处同源、不会漂移。 */
interface ContentStamp {
	/** `YYYY-MM-DD`，或常量 `unknown-date`。 */
	date: string;
	/** 这份内容 sha256 的前 6 位（小写十六进制）。 */
	fingerprint: string;
	/** ` (冲突 <date> <fingerprint>)` —— 逐字，是用户看得见的契约。 */
	suffix: string;
}

function stampOf(raw: string): ContentStamp {
	// 解析不出 frontmatter 也要给出确定答案（常量日期），不抛：后缀是内容的函数，坏内容也有坏内容的后缀。
	const modified = parseEntryFile(raw)?.meta.modified ?? "";
	const head = modified.slice(0, 10);
	const date = DATE_RE.test(head) ? head : UNKNOWN_DATE;
	const fingerprint = sha256Hex(raw).slice(0, FINGERPRINT_LENGTH);
	return { date, fingerprint, suffix: ` (冲突 ${date} ${fingerprint})` };
}

/**
 * 冲突副本 `name` 的后缀：`" (冲突 " + 该份内容 modified 的日期 + " " + 该份内容 sha256 前 6 位 + ")"`。
 *
 * 两个成分都只来自**这一份字节**，所以两台设备各自解同一次冲突会得到同一个后缀、同一个派生文件名，
 * 下一轮就是「两边都新增了同一个路径、内容相同」→ 收敛成一份，而不是越同步越多。
 */
export function conflictSuffix(raw: string): string {
	return stampOf(raw).suffix;
}

/** 派生出的文件名是否仍以指纹结尾（= 指纹没被 `entryFileName` 的 stem 截断吃掉）。 */
function keepsFingerprint(file: string, fingerprint: string): boolean {
	return file.endsWith(ENTRY_EXT) && file.slice(0, -ENTRY_EXT.length).endsWith(fingerprint);
}

/**
 * 由「主干 + 指纹」派生 entry 文件名，并保证**指纹留在末尾**。
 *
 * `entryFileName` 的截断只保留前缀（100 字节上限），所以指纹若留在主干中间，长名字会把它整段切掉 ——
 * 而指纹正是「同名不同内容」时唯一的区分位，切掉它等于让两份不同的记忆抢同一个文件名。
 * 做法：指纹永远拼在主干之后，主干被截断时就从末尾逐个码点回退，直到派生结果重新以指纹结尾。
 *
 * 回退用二分找起点（超长 name 上逐码点回退会退化成平方级）。二分的前提是 `fits` 对 `keep` 单调
 * （能放下的前缀越短越宽松），而它确实单调：**`build(keep)` 的字节长度对 `keep` 单调不减** ——
 * 多保留一个码点只可能让它更长（空白连写归一会让长度不变，绝不会变短），而 `entryFileName` 截断时
 * 保留的是**前缀**，所以「截断完还是不是以指纹结尾」只取决于 `build(keep)` 有没有超过上限。
 * 二分只依赖入参，因此是确定性的。
 */
function fileNameEndingWith(head: string, fingerprint: string): string {
	const points = Array.from(head);
	const build = (keep: number): string => entryFileName(`${points.slice(0, keep).join("")}-${fingerprint}`);
	const fits = (keep: number): boolean => keepsFingerprint(build(keep), fingerprint);

	if (fits(points.length)) return build(points.length); // 常见路径：没被截断，一次就够

	let low = 0; // 空主干必然放得下 `-<指纹>`（7 字节）
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	// `low` 就是「仍能放下指纹」的最长前缀：它只在 `fits(mid)` 为真时前移，起点 0 恒真
	// （空主干派生成 `-<指纹>`，7 字节，不可能被截断）。
	return build(low);
}

/** 已占用文件名的索引：名字 → 该文件内容的 hash（`undefined` = 调用方不知道 hash）。 */
function indexOfTaken(
	takenFileNames: Iterable<string | { file: string; hash?: string }>,
): Map<string, { hash?: string }> {
	const index = new Map<string, { hash?: string }>();
	for (const item of takenFileNames) {
		const file = typeof item === "string" ? item : item.file;
		const hash = typeof item === "string" ? undefined : item.hash;
		const known = index.get(file);
		// 同名重复时留下「知道 hash」的那条：hash 未知的条目给不出任何判断力。
		if (known === undefined || (known.hash === undefined && hash !== undefined)) index.set(file, { hash });
	}
	return index;
}

/**
 * 派生冲突副本的文件名。
 *
 * 与 `name` 同源，但把后缀里的指纹**挪到末尾**（右括号提前）：`A (冲突 2026-11-09 abc123)` 派生出
 * `A-(冲突-2026-11-09)-abc123.md`。这样既保住了「文件名以指纹结尾」（截断时指纹才活得下来），
 * 也让「这个名字被别的字节占用了」有一个确定性的退路：再追加一次同一份内容的指纹。
 *
 * 占用判断只按**逐字文件名**，刻意不做大小写/规范化折叠：折叠要跟 `platform`（本地配置），
 * 引进来就等于让派生名字依赖本地状态。折叠碰撞由写入口的碰撞跳过兜底。
 */
function pickFileName(
	name: string,
	stamp: ContentStamp,
	newRaw: string,
	taken: Map<string, { hash?: string }>,
): string {
	const head = `${name} (冲突 ${stamp.date})`;
	const base = fileNameEndingWith(head, stamp.fingerprint);
	const occupant = taken.get(base);
	// 没被占用 → 直接用。
	if (occupant === undefined) return base;
	// 被占用，且占用者的字节与「我们即将写下去的那份」逐字相同 → 复用（幂等）。
	// 比的是新 entry 的字节而不是败者的原字节：副本的 name 已加后缀，两者 hash 必然不同，
	// 拿原字节去比会让每一轮重解都再追加一次指纹 —— 副本越同步越多，正是不收敛的那个形状。
	if (occupant.hash !== undefined && occupant.hash === sha256Hex(newRaw)) return base;
	// 被不同内容占用，或 hash 未知（证明不了是同一份）→ 追加指纹，绝不写穿别人的文件。
	// 这里不用 `resolveUniqueFileName`：`-2`/`-3` 取决于本地目录里恰好有什么，两台设备会算出不同名字。
	return fileNameEndingWith(`${head}-${stamp.fingerprint}`, stamp.fingerprint);
}

/**
 * 把一份内容另存为新 entry：`name` 加内容派生的后缀，其余 frontmatter 与正文原样保留。
 *
 * 新 entry 由我们**作者化**（重新序列化），所以字节是规范化的；胜者那一份仍然逐字过去 —— 它是别人
 * 写的文件，重新序列化等于把行尾与空白按我们的口味改掉，会让对端下一轮又判成「变了」。
 *
 * 解析不出 frontmatter 时抛错而不是返回 null：null 在这套接口里的意思是「无事可做」，
 * 用它表示「做不到」会让调用方静默丢掉这一份内容 —— 那是本设计明令要防的丢记忆形状。
 * 抛出去之后由调用方把本轮变成失败/跳过（fail-closed），内容一份都不少。
 */
function keepAsNewEntry(side: ConflictSide, file: string, taken: Map<string, { hash?: string }>): NewEntry {
	const parsed = parseEntryFile(side.raw);
	if (!parsed) {
		throw new Error(`Cannot keep "${file}" as a new entry: unparsable frontmatter in the losing side`);
	}
	const stamp = stampOf(side.raw);
	const name = `${parsed.meta.name}${stamp.suffix}`;
	const raw = serializeEntryFile({ ...parsed.meta, name }, parsed.body);
	return { name, file: pickFileName(parsed.meta.name, stamp, raw, taken), raw };
}

/**
 * 谁留在原路径：`modified` 新的一方胜；`modified` 相同则 sha256 字典序大的一方胜。
 *
 * 两个判据都只依赖内容（字符串比较，不是 locale 序、不是解析成日期再比），所以两台设备独立算出
 * 同一个胜者 —— 幂等，与谁先推、谁在拉无关。`modified` 是垃圾值时同样确定：比较退化成码点序，
 * 仍然是「同一份输入 → 同一个胜者」。
 */
function pickWinner(ours: ConflictSide, theirs: ConflictSide): ConflictSide {
	if (ours.info.modified === theirs.info.modified) return ours.info.hash > theirs.info.hash ? ours : theirs;
	return ours.info.modified > theirs.info.modified ? ours : theirs;
}

/**
 * 收敛一次冲突，得到「原路径写什么」与「哪一份另存为新 entry」。
 *
 * 返回 `null` 只有一个意思：**无事可做**（两侧字节相同，或两侧都已删除 —— 差集不会送来这两种，
 * 但调用方送来了也不该抛）。做不到（败者的字节解析不出）时抛错，不借用 null。
 *
 * `takenFileNames` 是调用方已知的占用清单，只用于「派生名是否已被同一份内容占用」这一个判断：
 * 带 hash 才可能复用，只给名字视为 hash 未知、一律走确定性追加。传空数组即可得到「与本地状态完全无关」
 * 的产物 —— 两台设备各自算出的名字之所以能相同，靠的正是这一点。
 */
export function resolveConflict(
	input: ConflictInput,
	takenFileNames: Iterable<string | { file: string; hash?: string }>,
): ConflictOutcome | null {
	const { ours, theirs } = input;

	const taken = indexOfTaken(takenFileNames);

	// 一、至少一侧已删除。两侧都删 = 无事可做（差集不会送来，但送来也不该抛）；
	//     一侧删 = 删除照办（原路径要删 → winnerRaw = null），幸存的那份内容另存为新 entry。
	//     被删的那一侧没有内容可留，所以这里不会出现「两份都留」。
	if (!ours || !theirs) {
		const survivor = ours ?? theirs;
		if (!survivor) return null;
		return { winnerRaw: null, loserEntry: keepAsNewEntry(survivor, input.file, taken) };
	}

	// 二、两侧内容相同：不是冲突。判据与差集同源（hash）；raw 逐字相同是它的充分条件，一并认下来。
	if (ours.info.hash === theirs.info.hash || ours.raw === theirs.raw) return null;

	// 三、改 vs 改：胜者逐字留在原路径，败者另存为新 entry。
	const winner = pickWinner(ours, theirs);
	const loser = winner === ours ? theirs : ours;
	return { winnerRaw: winner.raw, loserEntry: keepAsNewEntry(loser, input.file, taken) };
}
