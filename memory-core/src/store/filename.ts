import { createHash } from "node:crypto";
import { isReservedWindowsName } from "./windows-names.js";

/** 文件系统不安全字符与控制字符。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符是故意列入的（Global Constraints 要求剥离 U+0000–U+001F 与 U+007F）
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
/** 首尾空白与句点（句点会让 "." / ".." 变成非法文件名）。 */
const EDGE = /^[\s.]+|[\s.]+$/g;
const WHITESPACE_RUN = /\s+/g;

const STEM_MAX_BYTES = 100;

export const ENTRY_EXT = ".md";

/**
 * 索引文件的文件名。定义在这里而不是 `memory-store.ts`：`isEntryFileName` 要排除它，
 * 而从 store 那边 import 会造成循环依赖。`memory-store.ts` 的公开出口 `INDEX_FILE` 是它的别名，
 * 名字/类型/值都不变。
 */
export const ENTRY_INDEX_FILE = "MEMORY.md";

/**
 * 把文件名折叠成本地文件系统眼里的「同一个名字」：先 NFC 归一，再在 win32 / darwin 上去掉大小写。
 *
 * 为什么需要：`Foo.md` 与 `foo.md` 在 Linux 上是两条合法记忆，在 APFS / NTFS 上是同一个 inode ——
 * 按名逐字直写会静默写穿一条（后写的那份盖掉先写的那份，两边都不报错）。NFC 归一同理：
 * APFS / HFS+ 对 NFD 与 NFC 的两个名字做同一次查找。
 *
 * **跟平台**是它的核心语义，不是可选修饰：Linux 上把大小写也折叠掉，会让两条本来合法的
 * 记忆被当成碰撞而丢掉一条。折叠只用于「是否同一个名字」的比较，绝不用于生成落盘的文件名。
 */
export function foldFileName(name: string, platform: NodeJS.Platform = process.platform): string {
	const normalized = name.normalize("NFC");
	return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * 是不是一个「条目文件」的名字。`MemoryStore.#entryFiles()`（读路径）与同步的目录扫描共用这一份：
 * 两处口径一旦漂移，就会出现「store 看得到、同步看不到」（或反过来）的记忆 —— 那是静默丢记忆。
 *
 * 判据：单层（不含路径分隔符）、`.md` 结尾、不是索引文件本身、不以 `.` 开头（`.lock`、`.backups`、
 * 以及用户自己藏的临时文件都不是记忆）。
 *
 * 保留设备名**只在 win32 上**剔除：按名打开 `con.md` 在 win32 上会命中控制台（`readFile` 阻塞而不是
 * 返回内容），把它从清单里剔除的最坏表现是「该条记忆在本机不可见」；而在 Linux / macOS 上 `con.md`
 * 是一个普通文件、一条合法记忆，全平台剔除等于把它从 `listEntries()` 里静默抹掉。
 * 写路径的口径刻意更严（全平台拒绝保留名）—— 见 `MemoryStore.applyEntryFiles`。
 */
export function isEntryFileName(name: string, platform: NodeJS.Platform = process.platform): boolean {
	if (!name.endsWith(ENTRY_EXT)) return false;
	if (name === ENTRY_INDEX_FILE) return false;
	if (name.startsWith(".")) return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (platform === "win32" && isReservedWindowsName(name)) return false;
	return true;
}

function shortHash(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 8);
}

function truncateBytes(input: string, maxBytes: number): string {
	let out = "";
	let bytes = 0;
	for (const ch of input) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > maxBytes) break;
		out += ch;
		bytes += size;
	}
	return out;
}

/** 由 entry 的 name 派生确定性的文件名（含扩展名）。同一 name 在同一输入下总得到同一结果。 */
export function entryFileName(name: string): string {
	const cleaned = name.replace(UNSAFE, "_").replace(EDGE, "");
	const stem = cleaned.length === 0 ? "" : truncateBytes(cleaned.replace(WHITESPACE_RUN, "-"), STEM_MAX_BYTES);
	// 保留设备名（`con`、`nul`、`com1`…）在 Windows 上会命中设备而不是文件：`memory add name="CON"`
	// 的内容会写进控制台，而索引里已经多了一行 —— 静默丢记忆。**全平台**加前缀：git 类记忆目录
	// 跨机共享，名字必须在两边都安全。既有文件不受影响：addEntry 按 frontmatter
	// 的 name 复用已有文件，这里只影响**新建**文件的派生名。
	const finalStem = stem.length === 0 ? `entry-${shortHash(name)}` : isReservedWindowsName(stem) ? `_${stem}` : stem;
	return `${finalStem}${ENTRY_EXT}`;
}

/** 在已占用的文件名集合中为 base 找一个空闲名字（追加 -2、-3……）。 */
export function resolveUniqueFileName(used: Iterable<string>, base: string): string {
	const taken = used instanceof Set ? used : new Set(used);
	if (!taken.has(base)) return base;
	const hasExt = base.endsWith(ENTRY_EXT);
	const stem = hasExt ? base.slice(0, -ENTRY_EXT.length) : base;
	const ext = hasExt ? ENTRY_EXT : "";
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
}
