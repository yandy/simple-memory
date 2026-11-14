import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseEntryFile } from "../store/entry-file.js";
import { isEntryFileName } from "../store/filename.js";
import { sha256Hex } from "./hash.js";
import type { SyncFileInfo, SyncFileSet } from "./types.js";

/**
 * 本地扫描的结果。`files` 是三方合并里「ours」这一侧；`unparsable` 是「看得见但同步不了」的清单，
 * 单独列出来是刻意的：它们必须能被报给用户（「本地有 N 个 .md 解析不出，未同步」），
 * 而不是既不在 `files` 里、也不在任何地方出现 —— 那就成了静默丢记忆。
 */
export interface LocalScan {
	files: SyncFileSet;
	unparsable: string[];
}

/**
 * 扫描 memory 目录，产出每个 entry 的内容指纹、语义修改时间与字节数。
 *
 * 文件名过滤**只用** `isEntryFileName`，不在这里另抄一份判据：读路径（`MemoryStore` 的目录扫描）
 * 与同步扫描口径一旦漂移，就会出现「store 看得到、同步看不到」（或反过来）的记忆 —— 静默丢记忆。
 * **调用方必须传 store 配置里的 platform（`store.cfg.platform`），不是宿主平台**：`MemoryStore` 按
 * `cfg.platform ?? process.platform` 解析，配置值没被透传时，保留设备名的口径会在两条路径上分叉。
 * 保留设备名在 win32 上必须剔除（按名打开会命中控制台），而在 Linux / macOS 上 `con.md` 是
 * 一条合法记忆，全平台剔除等于把它抹掉。
 *
 * 目录级失败**只有 `ENOENT` 降级成空结果**（首次同步前目录可能还没建，「目录不存在」正是「本机什么
 * 都没有」的正确语义）；其余 errno（`EACCES`/`EIO`/`EMFILE`/网络盘…）**必须抛出去**。这是数据安全线，
 * 不是风格问题：扫描结果是三方合并的「ours」一侧，而「base 里有、ours 里没有、theirs 没动」在合并
 * 语义里等于**用户在本地删了它**，引擎会把该删除传播到远端。一次瞬时或权限性的 readdir 失败若被
 * 当成「目录是空的」，等于宣布「本机删光了全部记忆」，会把对端设备上的记忆全部删除 —— 而端口没有
 * 别的通道能表达「扫描失败」，调用方无从分辨。抛出去之后由引擎捕获、把本轮变成跳过（fail-closed）。
 *
 * 文件级的两件「不抛」，是为了让一轮同步不因为一个文件而整体失败：
 * - **单个文件读失败**（权限、刚被删掉）→ 该文件进 `unparsable`，其余照常扫描。
 * - **`parseEntryFile` 返回 null** → 同样进 `unparsable`：解析不出 `modified` 就没法定序，也就无法安全参与合并。
 * 单个坏文件与整个目录读不了是两件事：前者可报告可跳过，后者必须中止。
 *
 * 行尾算内容的一部分：`parseEntryFile` 解析前会归一 CRLF，但 hash 打的是**原始字节** —— 这是有意的，
 * 归一再 hash 等于把归一化义务悄悄推给每个 backend 的字节契约。
 *
 * `bytes` 是 UTF-8 字节数而不是 JS 字符串长度：同一份记忆在不同设备上字符数必然相同，字节数才反映落盘体积。
 * `modified` 取 frontmatter 里的值而不是文件系统 mtime —— mtime 会随复制、检出、`touch` 一起漂移。
 */
export async function scanLocalEntries(
	memoryDir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<LocalScan> {
	const files: SyncFileSet = new Map();
	const unparsable: string[] = [];

	// 只有 ENOENT 降级成空结果，其余 errno 原样抛出 —— 三方合并 ours 侧的数据安全线，见 doc comment。
	const dirents = await readdir(memoryDir, { withFileTypes: true }).catch((err: unknown) => {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	});

	const entries: string[] = [];
	for (const dirent of dirents) {
		if (!isEntryFileName(dirent.name, platform)) continue;
		if (dirent.isSymbolicLink()) {
			// store 的 stat 跟随链接：指向普通文件的符号链接在 store 眼里是合法 entry，扫描也必须看得见，
			// 且只对符号链接多付一次 stat。断链（stat 抛错）跳过，与 listEntries() 的 !info?.isFile() 同口径。
			const target = await stat(join(memoryDir, dirent.name)).catch(() => null);
			if (!target?.isFile()) continue;
		} else if (!dirent.isFile()) {
			// 目录、FIFO、socket 一律跳过：与 listEntries() 的 stat + isFile() 同口径；也是安全要求 ——
			// 对 FIFO 调 readFile 会永久阻塞，而扫描挂在会话启动路径上。
			continue;
		}
		entries.push(dirent.name);
	}
	// 排序只为稳定：同一目录两次扫描、两台设备之间，`unparsable` 的报告顺序都不该随机跳动。
	entries.sort();

	for (const name of entries) {
		const raw = await readFile(join(memoryDir, name), "utf8").catch(() => null);
		if (raw === null) {
			unparsable.push(name);
			continue;
		}
		const parsed = parseEntryFile(raw);
		if (!parsed) {
			unparsable.push(name);
			continue;
		}
		const info: SyncFileInfo = {
			hash: sha256Hex(raw),
			modified: parsed.meta.modified,
			bytes: Buffer.byteLength(raw, "utf8"),
		};
		files.set(name, info);
	}

	return { files, unparsable };
}
