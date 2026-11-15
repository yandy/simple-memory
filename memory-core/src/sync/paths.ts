import { join } from "node:path";
import { projectDirName } from "../store/paths.js";

/**
 * 远端的项目布局恒用 POSIX 命名规则，与宿主平台无关。
 *
 * 远端布局是用户自己仓库里的**数据格式**：写下去之后每台设备都按它找文件，迁移代价极高。
 * 若跟随宿主平台，win32 上的 `windowsSafeName`（会把结尾的 `.`、空格改写成 `_2e`、`_20`）
 * 与 cygwin git 打印的 POSIX 形态路径会让同一个仓库在两台设备上算出两个远端目录 ——
 * 不报错，只静默分叉成两份记忆。见设计文档。
 *
 * 因此这里不含 `platform` 参数：平台无关是它存在的全部理由。
 */
export function remoteProjectKey(identityKey: string): string {
	// `NodeJS.Platform` 没有 `posix` 这个值，而 `projectDirName` 只在 win32 上分支 ——
	// 取任一非 win32 值（与 `store/paths.ts` 的测试同用 `linux`）得到的就是 POSIX 规则。
	return projectDirName(identityKey, { platform: "linux" });
}

/** 单个项目在远端的前缀：`git/<远端 key>`。 */
export function remotePrefix(identityKey: string): string {
	return `git/${remoteProjectKey(identityKey)}`;
}

/**
 * 同步状态目录在记忆根下的名字：`<记忆根>/.sync`。
 *
 * 这个字面值是**用户可见的布局契约**：它出现在文档、备份排除清单与用户自己的脚本里，而引擎、git
 * backend、设备身份与 manifest 都把它当入参 `syncRoot` 收发。适配层若各自写一遍 `join(memoryDir, ".sync")`，
 * 布局一改就要同步改若干处 —— 所以派生只留在这里一份，适配层一律调 `syncRootPath`。
 */
export const SYNC_DIR_NAME = ".sync";

/** 记忆根 → 同步状态目录（`syncRoot`）。所有同步入口的 `syncRoot` 入参都由它派生，不要就地拼字符串。 */
export function syncRootPath(memoryDir: string): string {
	return join(memoryDir, SYNC_DIR_NAME);
}

/** 项目内某个文件在远端的路径。 */
export function remoteEntryPath(prefix: string, file: string): string {
	return `${prefix}/${file}`;
}
