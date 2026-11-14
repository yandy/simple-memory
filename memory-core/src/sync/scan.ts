import { readdir, readFile } from "node:fs/promises";
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
 * 平台参数原样透传给它的理由也一样：保留设备名在 win32 上必须剔除（按名打开会命中控制台），
 * 而在 Linux / macOS 上 `con.md` 是一条合法记忆，全平台剔除等于把它抹掉。
 *
 * 三件「不抛」的事，都是为了让一轮同步不因为一个文件而整体失败：
 * - **目录不存在 / 读不了** → 空结果。首次同步前目录可能还没建，而空目录正是「本机什么都没有」的正确语义。
 * - **单个文件读失败**（权限、刚被删掉）→ 该文件进 `unparsable`，其余照常扫描。
 * - **`parseEntryFile` 返回 null** → 同样进 `unparsable`：解析不出 `modified` 就没法定序，也就无法安全参与合并。
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

	const names = await readdir(memoryDir).catch(() => []);
	// 排序只为稳定：同一目录两次扫描、两台设备之间，`unparsable` 的报告顺序都不该随机跳动。
	const entries = names.filter((name) => isEntryFileName(name, platform)).sort();

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
