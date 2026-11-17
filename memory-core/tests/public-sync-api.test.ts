import { join } from "node:path";
import { describe, expect, it } from "vitest";
// 刻意从**包的公开出口**导入，而不是从 `../src/sync/paths.js` 这类内部模块：
// 这一组要钉的正是「适配层能从出口拿到这些单一来源」这件事本身。
import {
	INDEX_FILE,
	MANIFEST_VERSION,
	NonFastForwardError,
	SYNC_DIR_NAME,
	type SyncBackend,
	type SyncInitResult,
	conflictSuffix,
	createGitSyncBackend,
	createSyncEngine,
	createSyncScheduler,
	devicePath,
	diffThreeWay,
	gitAvailable,
	isEntryFileNameForRead,
	isEntryFileNameForWrite,
	loadOrCreateDevice,
	manifestPath,
	remoteEntryPath,
	remotePrefix,
	remotePrefixFromKey,
	remoteProjectKey,
	renderSyncRound,
	renderSyncStatus,
	resolveConflict,
	scanLocalEntries,
	sha256Hex,
	sameSyncRemote,
	syncErrorMessage,
	syncLockPath,
	syncRootPath,
	writeManifest,
} from "../src/index.js";

/**
 * 公开出口上的同步符号。
 *
 * 这些派生函数是**专为适配层立的单一来源**：`syncRootPath` / `SYNC_DIR_NAME`（`.sync` 在哪）、
 * `manifestPath` / `devicePath`（状态文件在哪）、`remoteProjectKey` / `remotePrefix` /
 * `remotePrefixFromKey` / `remoteEntryPath`（远端布局长什么样）。适配层就地拼字符串的话，
 * 布局一改就会静默分叉成两份状态 / 两个远端目录 —— 而分叉是不报错的。
 *
 * 所以这里逐个断言**行为**而不只是「导出了个东西」：`toBeDefined` 抓不住「导出的是另一个同名符号」
 * 或「派生规则被改了一半」，而那正是这组符号唯一会出错的方式。
 */
describe("公开出口上的同步符号", () => {
	it("本地状态布局：`.sync` 目录、设备身份、每项目一份基线", () => {
		// 字面值是用户可见的契约（备份/清理脚本会撞上它们），改了必须在这里先红
		expect(SYNC_DIR_NAME).toBe(".sync");
		expect(INDEX_FILE).toBe("MEMORY.md");

		const memoryRoot = join("/tmp", "memory-root");
		const syncRoot = syncRootPath(memoryRoot);
		// 断言 join 而不是字面量：win32 上分隔符不同，硬编码 `/` 会让这条只在 POSIX 上过
		expect(syncRoot).toBe(join(memoryRoot, ".sync"));
		expect(devicePath(syncRoot)).toBe(join(syncRoot, "device.json"));
		expect(manifestPath(syncRoot, "github.com__o__r")).toBe(
			join(syncRoot, "state", "github.com__o__r.json"),
		);
		// 根锁的路径也只有一份：引擎与适配层的「清除遗弃根锁」入口必须算出同一个文件，
		// 否则那条命令删的是一个没人用的文件，而真正卡住的锁永远在那里。
		expect(syncLockPath(syncRoot)).toBe(join(syncRoot, "sync.lock"));
		expect(typeof MANIFEST_VERSION).toBe("number");
	});

	it("远端布局：项目 key 与平台无关，前缀只有一份 `git/` 字面量", () => {
		const identityKey = "github.com/org/repo";
		const projectKey = remoteProjectKey(identityKey);
		// 远端布局恒用 POSIX 规则：同一台机器上问两次、以及从两个入口问，答案必须一致
		expect(projectKey).toBe(remoteProjectKey(identityKey));
		expect(projectKey).not.toContain("/");
		expect(projectKey).not.toContain("\\");

		// 两个前缀入口的关系就是「派生一次 vs 已经派生好」——这条等式是它们不会二次转义的唯一守卫
		expect(remotePrefix(identityKey)).toBe(remotePrefixFromKey(projectKey));
		expect(remotePrefix(identityKey)).toBe(`git/${projectKey}`);
		// 拿错入口（把身份 key 当项目 key 传）会得到二次转义，那正是上面这条等式要拦住的
		expect(remotePrefixFromKey(identityKey)).not.toBe(remotePrefix(identityKey));

		expect(remoteEntryPath(remotePrefix(identityKey), "记忆.md")).toBe(`git/${projectKey}/记忆.md`);
	});

	it("文件名口径：读方向按平台分支，写方向恒为全平台最严（两个谓词都在出口上）", () => {
		// 适配层要用读方向扫本地目录、用写方向校验从远端进来的名字；两个都必须能从出口拿到，
		// 否则适配层只能自己写一份正则，而那一份很快就会与 core 分叉
		expect(isEntryFileNameForRead("con.md", "linux")).toBe(true);
		expect(isEntryFileNameForRead("con.md", "win32")).toBe(false);
		expect(isEntryFileNameForWrite("con.md")).toBe(false);
		expect(isEntryFileNameForWrite("记忆.md")).toBe(true);
		expect(isEntryFileNameForRead("记忆.md", "win32")).toBe(true);
	});

	it("装配入口与端口实现都在出口上（适配层不必深入内部模块）", () => {
		for (const fn of [
			createSyncEngine,
			createSyncScheduler,
			createGitSyncBackend,
			loadOrCreateDevice,
			scanLocalEntries,
			diffThreeWay,
			resolveConflict,
			conflictSuffix,
			sha256Hex,
			writeManifest,
			gitAvailable,
			// 共同报告格式化与错误脱敏也是装配入口的一部分：宿主不该各写一份（两份正则必然分叉）
			syncErrorMessage,
			renderSyncRound,
			renderSyncStatus,
		]) {
			expect(typeof fn).toBe("function");
		}
		// 非快进是一个**可识别的类型**（引擎靠 `instanceof` 决定重跑整轮），所以它必须是类而不是文案
		expect(new NonFastForwardError("x")).toBeInstanceOf(Error);
		expect(new NonFastForwardError("x").name).toBe("NonFastForwardError");
	});

	it("远端等价比较只有一份公开实现，覆盖 URL、scp 与本地路径", () => {
		expect(sameSyncRemote("https://github.com/o/r.git", "git@github.com:o/r.git")).toBe(true);
		expect(sameSyncRemote("https://github.com/o/r", "git@github.com:o/r.git")).toBe(true);
		expect(sameSyncRemote("file:///tmp/memory-remote.git", "/tmp/memory-remote.git")).toBe(true);
		expect(sameSyncRemote("https://github.com/o/r.git", "https://github.com/o/other.git")).toBe(false);
	});

	it("manifest transport 的构造与匹配也从公开出口提供", async () => {
		const api = await import("../src/index.js");
		const transport = api.syncTransport("https://token@example.invalid/o/r.git", "main");
		const manifest = api.emptyManifest(transport);
		expect(api.manifestMatchesTransport(manifest, transport)).toBe(true);
		expect(api.manifestMatchesTransport(manifest, api.syncTransport("https://other.invalid/o/r.git", "main"))).toBe(false);
		expect(api.manifestMatchesTransport(manifest, { ...transport, branch: "next" })).toBe(false);
		expect(JSON.stringify(manifest)).not.toContain("token@example.invalid");
	});

	it("端口的自省面也在出口上：init 的结果形状、getRemote / setRemote", () => {
		// 构造不碰盘：这里只看装配出来的对象上有没有那几个方法
		const backend = createGitSyncBackend({
			syncRoot: join("/tmp", "memory-root", ".sync"),
			memoryRoot: join("/tmp", "memory-root"),
			remote: "https://git.example.invalid/o/r.git",
			branch: "main",
		});
		for (const member of ["ready", "init", "getRemote", "setRemote", "fetch", "publish"] as const) {
			expect(typeof backend[member], member).toBe("function");
		}
		// 类型层面的钉子：端口少了成员、或 init 不再交回 `SyncInitResult`，下面两行就编译不过
		const asPort: SyncBackend = backend;
		expect(asPort.getRemote).toBe(backend.getRemote);
		const initResult: SyncInitResult = { revision: "", warnings: [] };
		expect(initResult).toEqual({ revision: "", warnings: [] });
	});
});
