import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SyncFileInfo } from "./types.js";

/**
 * manifest 的**格式**版本。形状一旦变化就加一 —— 读到不认识的版本按「无 base」处理，
 * 见 `readManifest` 的说明。
 */
export const MANIFEST_VERSION = 1;

/**
 * 上次成功同步留下的基线，即三方合并里「共同祖先」的那一侧。
 *
 * `base.revision` 是那次同步时远端的版本标识（空串表示还没有过基线），`base.syncedAt` 是
 * 记录下来的同步时刻；`files` 是逐文件的指纹，diff 拿本地扫描、远端清单与它三者比对。
 * 它只是**基线**：文件内容永远以 entry 文件本身为准，manifest 丢了不会丢内容。
 */
export interface SyncManifest {
	version: number;
	base: { revision: string; syncedAt: string };
	files: Record<string, SyncFileInfo>;
}

/** 没有基线的 manifest：版本已认、结构完整，但一个文件都不记得（等价首次同步）。 */
export function emptyManifest(): SyncManifest {
	return { version: MANIFEST_VERSION, base: { revision: "", syncedAt: "" }, files: {} };
}

/**
 * 一个项目一份基线，落在 `<syncRoot>/state/<projectKey>.json`：key 里不含分隔符（远端布局
 * 已把它压平），所以这里不会创建子目录，state 目录下永远是一层平铺的文件。
 */
export function manifestPath(syncRoot: string, projectKey: string): string {
	return join(syncRoot, "state", `${projectKey}.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileInfo(value: unknown): value is SyncFileInfo {
	if (!isPlainObject(value)) return false;
	return typeof value.hash === "string" && typeof value.modified === "string" && typeof value.bytes === "number";
}

/**
 * 把解析出来的 JSON 收窄成 `SyncManifest`；任一处不对返回 `null`。
 * 逐个字段查是刻意的：manifest 是上次同步的**推断**，不是内容的权威来源，
 * 半信半疑地用它比不用它危险得多。
 */
function asManifest(value: unknown): SyncManifest | null {
	if (!isPlainObject(value)) return null;
	if (value.version !== MANIFEST_VERSION) return null;

	const base = value.base;
	if (!isPlainObject(base) || typeof base.revision !== "string" || typeof base.syncedAt !== "string") return null;

	const files = value.files;
	if (!isPlainObject(files)) return null;
	for (const info of Object.values(files)) {
		if (!isFileInfo(info)) return null;
	}

	return {
		version: MANIFEST_VERSION,
		base: { revision: base.revision, syncedAt: base.syncedAt },
		files: files as Record<string, SyncFileInfo>,
	};
}

/**
 * 读基线。**任何读不懂的情况一律返回 `null`（= 没有基线体系），从不抛错**：
 * 文件不存在、读不到（权限/损坏的盘）、JSON 坏掉、版本不认识、形状不对。
 *
 * 这不是吞错，是一条裁定：把「版本未知」降级成「首次同步」最坏只是多产生几条冲突副本
 * （两边内容都还在，人可以选择），而报错会让同步彻底停摆，猜一份半可信的基线则可能
 * 静默覆盖掉一端的内容。三者里只有降级是不丢文件的。
 */
export async function readManifest(path: string): Promise<SyncManifest | null> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	return asManifest(parsed);
}

/** 同目录下的临时文件名：`<path>.tmp-<pid>-<随机>`，不带目录层级，`rename` 因此不会跨卷。 */
function tempPath(path: string): string {
	return `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * 写基线，**原子**：先写同目录临时文件、再 `rename` 覆盖目标。
 *
 * 直接写目标文件会留下「写了一半的 JSON」这一窗口，而本地目录就可能是云盘同步目录 /
 * 网络盘：读者（另一次同步、另一个进程）撞上它只会得到「读不懂 → 无 base」，
 * 白白丢掉一次基线并多写出冲突副本。`rename` 在同一目录内是原子的替换，
 * 读者要么看到旧文件、要么看到完整的新文件。
 *
 * **这里刻意不与 `device.ts` 共用一个 `writeJsonAtomic`**（这件事已经被提过两次，所以把决定写下来）：
 * 基线要的就是上面这一句「原子替换」—— 目标名上没有需要保护的东西，盖掉旧的即可；而身份文件要的是
 * **排他创建**（`link` 原子失败于 `EEXIST`）+ 发布后读回 + 无硬链接时退回覆盖，那是三种发布形态。
 * 合成一个函数必然带 flag，而 flag 恰好会把 `device.ts` 里那条论证清楚的排他性边界
 *（何时排他、何时不排他、不排他时靠什么兜）压成一个参数默认值。两处重复的只有「写临时文件」这几行。
 */
export async function writeManifest(path: string, manifest: SyncManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = tempPath(path);
	await writeFile(temp, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	await rename(temp, path);
}
