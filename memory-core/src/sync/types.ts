/**
 * 同步的共享词汇：单个 entry 文件的内容指纹，以及「文件名 → 指纹」的集合。
 *
 * 刻意只有类型、没有运行时代码：这些名字被扫描、diff、冲突解决与同步引擎共同引用，
 * 任一环引入运行时依赖都会把整条链绑死。
 */

/** 某个 entry 文件在某一时刻的样子（manifest 与远端清单比对的就是这三个字段）。 */
export interface SyncFileInfo {
	/** 内容哈希（`sha256Hex` 的输出）。 */
	hash: string;
	/** 文件 frontmatter 里的 `modified`，即语义上的「何时被改」，不是文件系统 mtime。 */
	modified: string;
	/** 内容字节数（UTF-8），用于在哈希偶然相同时仍能看出体积异常。 */
	bytes: number;
}

/**
 * 一组 entry 文件。key 是**单层** entry 文件名（如 `Use-real-DB-in-tests.md`），不含目录 ——
 * 记忆目录是扁平的，key 带路径会让两侧（本地扫描与远端清单）拿不同形态的 key 互相找不到。
 */
export type SyncFileSet = Map<string, SyncFileInfo>;
