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

/**
 * 远端布局里「全部记忆都放在这个目录下」的那一段：`git/`。
 *
 * 字面值只存这一份：引擎算 scope、适配层渲染远端路径、以及将来可能的「列出远端有哪些项目」
 * 都靠它。多一处硬编码就多一处布局改动时会静默分叉的地方（与 `SYNC_DIR_NAME` 同一个理由）。
 */
const REMOTE_ROOT_DIR = "git";

/**
 * 已经是 `remoteProjectKey` 输出的 key → 它在远端的前缀。
 *
 * 与 `remotePrefix` 的区别就在入参：那边收的是**身份 key**（会再派生一次），这边收的是
 * 已经派生好的项目 key。拿错一个就是二次转义（`github.com__o__r` 变成 `github.com____o____r`），
 * 而这个错不报错：只是远端从此多出一个谁也不认的目录，同步看起来正常但两边各存一份。
 */
export function remotePrefixFromKey(projectKey: string): string {
	return `${REMOTE_ROOT_DIR}/${projectKey}`;
}

/** 单个项目在远端的前缀：`git/<远端 key>`。入参是**身份 key**，在这里派生成项目 key。 */
export function remotePrefix(identityKey: string): string {
	return remotePrefixFromKey(remoteProjectKey(identityKey));
}

/**
 * 同步状态目录在记忆根下的名字：`<记忆根>/.sync`。
 *
 * 这个字面值是**用户可见的布局契约**：它出现在记忆根下（用户自己的备份与清理脚本会撞上它），
 * 而引擎、git backend、设备身份与 manifest 都把它当入参 `syncRoot` 收发。
 * 它**不是**记忆内容：`createSnapshot` 收的是显式文件清单，扫的是项目记忆目录那一层，
 * 所以快照里本来就不会有它 —— 不要为了「排除」而在哪里再加一条规则。适配层若各自写一遍
 * `join(memoryRoot, ".sync")`，布局一改就要同步改若干处 —— 所以派生只留在这里一份，
 * 适配层一律调 `syncRootPath`。
 */
export const SYNC_DIR_NAME = ".sync";

/**
 * 记忆根 → 同步状态目录（`syncRoot`）。所有同步入口的 `syncRoot` 入参都由它派生，不要就地拼字符串。
 *
 * **入参是记忆根，不是某个项目的记忆目录**，也就是 `config.memoryDir` / {@link defaultMemoryRoot}
 * 那一个（`resolveMemoryDir` 在它下面再派生出 `<kind>/<项目>` 两层）。这两者在代码里都叫过
 * 「memoryDir」，传错**不会报错**，只会静默降级，而且**没有任何测试会红**（这正是它危险的地方）：
 *
 * - `.sync` 是**整棵树共享一份**的状态：设备身份（`<hostname>-<id>`）、基线 manifest、以及那一个
 *   git 克隆（远端按 `git/<项目 key>/` 前缀区分项目）。传项目目录的话，每个项目各自克隆一遍整个
 *   远端、各自生成一份设备身份、各自持一把根锁 —— 同一台机器在 `git log` 里变成好几台设备，
 *   磁盘上多出 N 份整棵树大小的副本，而「一份 clone 服务全部项目」这个前提也没了。
 * - 扫描器**看不见**它：`.sync` 以点开头，而 `#entryFiles` / `scanLocalEntries` / `snapshotFiles`
 *   全都按「非点开头」过滤，所以没有任何扫描会把这份误放的状态报出来。别指望「跑一次测试或
 *   看一次备份清单就能发现」。
 *
 * 所以参数名刻意不叫 `memoryDir`：调用点写出来必须看得出传的是根。
 */
export function syncRootPath(memoryRoot: string): string {
	return join(memoryRoot, SYNC_DIR_NAME);
}

/** 项目内某个文件在远端的路径。 */
export function remoteEntryPath(prefix: string, file: string): string {
	return `${prefix}/${file}`;
}
