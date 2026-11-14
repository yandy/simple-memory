import { type ExecFileOptionsWithBufferEncoding, execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	NonFastForwardError,
	type RemoteView,
	type SyncBackend,
	type SyncPublishChanges,
	type SyncRunOptions,
	type SyncScope,
} from "./backend.js";
import { sha256Hex } from "./hash.js";

/**
 * 端口的 git 实现：一个**暂存 clone** 当传输通道。
 *
 * 全部状态都在 `<syncRoot>/repo` 底下，那是只有本模块会碰的工作树 —— **用户的记忆目录里永远
 * 不会出现 `.git`**，也不会多出任何文件。这是整个设计的前提：记忆目录是用户的数据，
 * 把它变成仓库就等于让两个写入者（用户/宿主与本功能）共用一棵工作树。
 *
 * git 在这里**纯粹是传输**。三方合并由引擎自己算完，交下来的是已经决定的增量，所以本模块：
 * - 从不 `git merge`、从不解决冲突、从不让 git 决定任何一个字节的内容；
 * - 发布前把暂存工作树**重置到远端那一个提交**，再把增量应用上去 —— 于是我们的提交是它的
 *   子提交，push 天然是快进；
 * - 只在一个前缀内活动（`add` / `clean` 都限定路径），远端别的项目与用户随手丢进暂存目录的
 *   东西一概不碰。
 *
 * 命令一律走 `execFile`（不经 shell），口径沿用 `store/paths.ts`：`promisify(execFile)` + 超时 +
 * 失败给出中立结果或抛错。
 */

const execFileP = promisify(execFile);

/** 批量读内容的输出随记忆总量线性增长，一次给足，别让它半路 ENOBUFS。 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** 探测 git 在不在 PATH 上的超时（与 `store/paths.ts` 驱动 git 的口径一致）。 */
const GIT_PROBE_TIMEOUT_MS = 3000;

/** `cat-file --batch` 的分帧字节：`\n`。 */
const LINE_FEED = 0x0a;

/**
 * 引导提交（远端还没有这个分支时那一次空提交）的作者。
 *
 * 它**不代表任何设备**：`init` 的入参里没有作者（端口只给 `publish` 传），而这里也不能依赖
 * 环境里的 git 配置 —— CI runner 与全新机器上常常一个都没有，那样提交会直接失败。
 * 固定身份既让提交过得去，也让 `git log` 里一眼看得出哪个提交是引导用的。
 */
const BOOTSTRAP_AUTHOR = { name: "memory sync", email: "sync@localhost" };
const BOOTSTRAP_MESSAGE = "chore: create the sync branch";

/** git 子进程失败。带退出码是因为有一处要靠它区分语义（`diff --cached --quiet` 用 0/1 说话）。 */
class GitCommandError extends Error {
	readonly exitCode: number | undefined;

	constructor(message: string, exitCode: number | undefined, cause: unknown) {
		super(message, { cause });
		this.name = "GitCommandError";
		this.exitCode = exitCode;
	}
}

interface RunOptions {
	timeoutMs: number;
	cwd?: string;
	signal?: AbortSignal;
	/** 要喂给 git stdin 的内容（只有 `cat-file --batch` 用）。 */
	input?: string;
}

/** 把子进程失败拼成一条能读的错误：带上命令与 git 自己的 stderr（远端路径、拒绝原因都在里面）。 */
function asGitError(args: string[], timeoutMs: number, err: unknown): GitCommandError {
	const e = err as { code?: number | string; killed?: boolean; stderr?: unknown; message?: string };
	const raw = e?.stderr;
	const stderr = (Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "").trim();
	const exitCode = typeof e?.code === "number" ? e.code : undefined;
	// 被超时杀掉时 stderr 是空的，只剩一句 “Command failed”，说明不了任何事
	const detail = stderr || (e?.killed ? `timed out after ${timeoutMs}ms` : (e?.message ?? "unknown error"));
	return new GitCommandError(`git ${args.join(" ")} failed: ${detail}`, exitCode, err);
}

/**
 * 跑一次 git 子进程，输出按**字节**收。
 *
 * 底层是 Buffer 而不是字符串：`cat-file --batch` 用**字节长度**分帧，先解码成字符串就切不开了
 *（记忆正文大量是 CJK，一个字符三字节）。其余调用方走下面的 `runGit` 拿 utf8。
 */
async function runGitRaw(args: string[], o: RunOptions): Promise<Buffer> {
	const options: ExecFileOptionsWithBufferEncoding = {
		cwd: o.cwd,
		timeout: o.timeoutMs,
		signal: o.signal,
		maxBuffer: MAX_BUFFER_BYTES,
		encoding: "buffer",
	};
	const promise = execFileP("git", args, options);
	if (o.input !== undefined) {
		// git 可能在读完 stdin 之前就退出（仓库损坏、ref 不存在），这时写入会 EPIPE。
		// 不接住 'error' 它会变成 uncaughtException —— 一次同步失败不该带走宿主进程。
		promise.child.stdin?.on("error", () => {});
		promise.child.stdin?.end(o.input, "utf8");
	}
	try {
		const { stdout } = await promise;
		return stdout;
	} catch (err) {
		throw asGitError(args, o.timeoutMs, err);
	}
}

/** 同一次调用，输出按 utf8 解码（除 `cat-file --batch` 之外的所有命令）。 */
async function runGit(args: string[], o: RunOptions): Promise<string> {
	return (await runGitRaw(args, o)).toString("utf8");
}

function exitCodeOf(err: unknown): number | undefined {
	return err instanceof GitCommandError ? err.exitCode : undefined;
}

/**
 * PATH 上有没有可用的 git。测试与适配层都用它做可用性判断：没有 git 时同步整体降级成
 * 「未启用」+ 一条可读提示，其余记忆功能照常 —— 探测失败给中立结果，口径同 `store/paths.ts`。
 */
export async function gitAvailable(): Promise<boolean> {
	try {
		await execFileP("git", ["--version"], {
			timeout: GIT_PROBE_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER_BYTES,
			encoding: "buffer",
		});
		return true;
	} catch {
		return false;
	}
}

/** 只有这两种 errno 意味着「不在」。其余（权限、IO）是真的出事了，不能压成中立结果。 */
function isNotFound(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 把前缀包成字面 pathspec。
 *
 * git 的 pathspec 默认按 shell glob 解释，而远端前缀里可能出现 `[`：`projectDirName` 会转义
 * `<>:"|?*` 与控制字符，**但不转义方括号**，于是 `ssh://git@[::1]/o/r` 这类远端算出来的 key
 * 就带着一个方括号对 —— 看上去就是个字符类。实测 git 2.56 在字面目录存在时仍按字面匹配
 *（目录前缀走的是字面比较），但那是匹配器的行为细节、不是承诺；`:(literal)` 把「按字面」
 * 写成显式契约，代价是零。万一哪个版本真的按 glob 解释：`add` 匹配不到东西直接 fatal，
 * `clean` 则静默什么都不清 —— 后者正是最难查的失败形态（同步看起来成功了，其实一个字没推）。
 */
function pathspec(prefix: string): string {
	return `:(literal)${prefix}`;
}

/**
 * 把整棵远端树分成「本 scope 内」与「范围外」。
 *
 * 范围外不只是别的项目的目录：本前缀底下**还有一层**的路径（`<prefix>/sub/x.md`）同样算范围外 ——
 * 记忆目录是扁平的，嵌套目录不是本功能写出来的东西。两者都必须原样报出去（仓库根相对路径），
 * 静默丢掉的话用户永远不知道远端有内容没被同步。
 */
function classify(tree: string[], prefix: string): { inScope: string[]; outOfScope: string[] } {
	const head = `${prefix}/`;
	const inScope: string[] = [];
	const outOfScope: string[] = [];
	for (const path of tree) {
		const rest = path.startsWith(head) ? path.slice(head.length) : "";
		if (rest !== "" && !rest.includes("/")) inScope.push(rest);
		else outOfScope.push(path);
	}
	return { inScope, outOfScope };
}

export interface GitSyncBackendOptions {
	/** 本功能自己的状态目录（记忆根下的那个隐藏目录）。用户的记忆目录不在这里，也永远不会被碰。 */
	syncRoot: string;
	/** 远端仓库地址。只在 init 时用：之后的真相来源是暂存 clone 自己的 origin。 */
	remote: string;
	/** 远端分支名。 */
	branch: string;
}

export function createGitSyncBackend(options: GitSyncBackendOptions): SyncBackend {
	// syncRoot 固化成绝对路径：`git init` 那一步要在它里面跑，而进程 cwd 未必还在
	//（remote **不能** resolve —— 它可能是 URL 或 scp 形态的 host:path）。
	const syncRoot = resolve(options.syncRoot);
	const { remote, branch } = options;
	const repoDir = join(syncRoot, "repo");

	/** 在暂存仓库里跑 git。 */
	const inRepo = (o: SyncRunOptions): RunOptions => ({ ...o, cwd: repoDir });

	/** 断言 child 严格在 parent 之内（相等不算）。口径同 `store/paths.ts` 的 assertInsideRoot。 */
	function assertWithin(parent: string, child: string, what: string): void {
		const rel = relative(parent, child);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`Refusing to use ${what}: it escapes ${parent}`);
		}
	}

	/** 前缀在暂存仓库里的绝对路径。 */
	function scopeDir(prefix: string): string {
		const root = resolve(repoDir);
		const base = resolve(root, prefix);
		assertWithin(root, base, `sync scope "${prefix}"`);
		return base;
	}

	/**
	 * 把端口给的相对路径落进暂存仓库，并断言它没有逃出 `<repoDir>/<prefix>`。
	 *
	 * 端口是公开的，传进来的 path 理论上可以是 `../../..`，而这里是**覆盖与删除**盘上文件的
	 * 地方 —— 越界即抛，绝不静默写到别处。
	 */
	function scopedPath(prefix: string, path: string): string {
		const base = scopeDir(prefix);
		const target = resolve(base, path);
		assertWithin(base, target, `remote path "${path}"`);
		return target;
	}

	async function ready(): Promise<boolean> {
		try {
			await stat(join(repoDir, ".git"));
			return true;
		} catch (err) {
			// 只有「不存在」才是「还没初始化」。读不到（权限、坏盘）必须抛：静默 false 会让同步
			// 无声停摆，而用户以为它开着。
			if (isNotFound(err)) return false;
			throw err;
		}
	}

	/**
	 * fetch/publish 的前置。给一条能读的错误，而不是 git 那句 spawn ENOENT ——
	 * cwd 不存在时 Node 报的是「找不到 git」，会把人往完全错误的方向引。
	 */
	async function requireRepo(): Promise<void> {
		if (!(await ready())) {
			throw new Error(`The sync staging repository is missing (initialise sync first): ${repoDir}`);
		}
	}

	/** 本地 ref 的 sha；不存在时 null（`--verify --quiet` 就是为这个组合准备的，退出码 1）。 */
	async function localRef(ref: string, o: SyncRunOptions): Promise<string | null> {
		try {
			const out = (await runGit(["rev-parse", "--verify", "--quiet", ref], inRepo(o))).trim();
			return out === "" ? null : out;
		} catch (err) {
			if (exitCodeOf(err) === 1) return null;
			throw err;
		}
	}

	/** 暂存仓库当前 HEAD 的 sha（init 之后一定有一个提交）。 */
	async function localHead(o: SyncRunOptions): Promise<string> {
		return (await runGit(["rev-parse", "HEAD"], inRepo(o))).trim();
	}

	/**
	 * 远端 `<branch>` 当前的 head；远端还没有这个分支时返回 null（首次同步之前的正常状态，
	 * 不是错误 —— 端口用空 revision 表示「没有基线」）。
	 *
	 * `fetch` 失败分不清「没这个 ref」与「连不上」：两者都退出 128，而 git 的文案会被 locale
	 * 改写，不能靠匹配字符串。所以失败时用 `ls-remote --exit-code --heads` 复核一次 ——
	 * 它对「没有匹配的 ref」退出 2、对「连不上」退出 128，与语言无关。这次额外往返只发生在
	 * 失败路径上；抛出去的仍是 fetch 的原始错误（信息里带着远端）。
	 */
	async function remoteHead(o: SyncRunOptions): Promise<string | null> {
		try {
			await runGit(["fetch", "--quiet", "origin", branch], inRepo(o));
		} catch (fetchErr) {
			try {
				await runGit(["ls-remote", "--exit-code", "--heads", "origin", branch], inRepo(o));
			} catch (probeErr) {
				if (exitCodeOf(probeErr) === 2) return null;
			}
			throw fetchErr;
		}
		return (await runGit(["rev-parse", "FETCH_HEAD"], inRepo(o))).trim();
	}

	/**
	 * 远端整棵树的路径（仓库根相对）。**必须带 `-z`**：默认的 `ls-tree` 会把非 ASCII 路径
	 * C-quote 成 `"git/x/\346\226\207.md"`（`core.quotePath` 默认开），而记忆文件名大量是中文 ——
	 * 不解引号就会把每一条都判成范围外。`-z` 输出 NUL 分隔的原始字节，永不转义。
	 */
	async function listTree(revision: string, o: SyncRunOptions): Promise<string[]> {
		const out = await runGit(["ls-tree", "-r", "--name-only", "-z", revision], inRepo(o));
		return out.split("\0").filter((path) => path !== "");
	}

	/**
	 * **一次** `cat-file --batch` 读出范围内全部 blob，逐个算 sha256 并把内容缓存下来。
	 *
	 * 为什么必须读内容：`ls-tree` 给的是 blob sha1（掺了 `blob <长度>\0` 头），与端口契约的
	 * sha256 不同源。记忆文本量小，一次批量读比维护两套 hash 语义简单得多；缓存之后
	 * `list()` 与 `read()` 都不再 spawn。
	 */
	async function readBlobs(
		revision: string,
		prefix: string,
		names: string[],
		o: SyncRunOptions,
	): Promise<Array<{ path: string; hash: string; content: string }>> {
		const entries: Array<{ path: string; hash: string; content: string }> = [];
		if (names.length === 0) return entries;

		const input = names.map((path) => `${revision}:${prefix}/${path}\n`).join("");
		const out = await runGitRaw(["cat-file", "--batch"], { ...inRepo(o), input });

		// 输出按字节分帧：`<oid> SP <type> SP <size> LF <content> LF`。
		// 对象不存在时是一行 `<输入原样> missing`，而**退出码仍是 0** —— 只能按行判。
		let offset = 0;
		for (const path of names) {
			const lineFeed = out.indexOf(LINE_FEED, offset);
			if (lineFeed === -1) {
				throw new Error(`git cat-file --batch returned a truncated header for "${prefix}/${path}"`);
			}
			const header = out.subarray(offset, lineFeed).toString("utf8");
			const fields = header.split(" ");
			const size = fields.length === 3 && fields[1] === "blob" ? Number(fields[2]) : Number.NaN;
			if (!Number.isInteger(size) || size < 0) {
				throw new Error(`Remote object is not a readable blob: ${revision}:${prefix}/${path} (${header})`);
			}
			const start = lineFeed + 1;
			const content = out.subarray(start, start + size).toString("utf8");
			entries.push({ path, hash: sha256Hex(content), content });
			offset = start + size + 1; // 内容后面那个换行
		}
		return entries;
	}

	/** 远端还没有这个分支时的视图：revision 为空串（= 没有基线），什么都不列。 */
	function emptyView(): RemoteView {
		return {
			revision: "",
			outOfScope: [],
			async list() {
				return [];
			},
			async read(path: string): Promise<string> {
				throw new Error(`The remote has no synced content yet: cannot read "${path}"`);
			},
		};
	}

	async function fetch(scope: SyncScope, o: SyncRunOptions): Promise<RemoteView> {
		await requireRepo();
		const revision = await remoteHead(o);
		if (revision === null) return emptyView();

		const { inScope, outOfScope } = classify(await listTree(revision, o), scope.prefix);
		const entries = await readBlobs(revision, scope.prefix, inScope, o);
		const contents = new Map(entries.map((entry) => [entry.path, entry.content]));
		return {
			revision,
			outOfScope,
			async list() {
				return entries.map((entry) => ({ path: entry.path, hash: entry.hash }));
			},
			async read(path: string) {
				const content = contents.get(path);
				// 只服务 list() 报出的路径：范围外的路径宁可抛错，也不能让人以为它被同步了
				if (content === undefined) throw new Error(`Not in the fetched remote snapshot: "${path}"`);
				return content;
			},
		};
	}

	/** 远端还没有这个分支：建出来并推上去（一次空提交，只在远端留下一个分支起点）。 */
	async function bootstrapBranch(o: SyncRunOptions): Promise<void> {
		await runGit(["checkout", "--quiet", "-B", branch], inRepo(o));
		await runGit(
			[
				"-c",
				`user.name=${BOOTSTRAP_AUTHOR.name}`,
				"-c",
				`user.email=${BOOTSTRAP_AUTHOR.email}`,
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				BOOTSTRAP_MESSAGE,
			],
			inRepo(o),
		);
		await runGit(["push", "--quiet", "-u", "origin", branch], inRepo(o));
	}

	async function init(o: SyncRunOptions): Promise<void> {
		// 幂等：已经初始化过就什么都不做。换远端是另一条路径的职责 —— 这里悄悄改掉 origin，
		// 用户会以为同步去了他刚配的地方。
		if (await ready()) return;
		await mkdir(syncRoot, { recursive: true });

		try {
			try {
				// 空仓库在现代 git 上是 clone **成功**的（只留一句 warning，本地分支 unborn），
				// 所以 clone 失败基本等于「远端不可达 / 没有权限」。仍然退回本地 init：
				// 紧跟其后的 push 会把不可达如实报出来，符合「init 只由显式命令触发，失败要让人看见」。
				await runGit(["clone", "--quiet", remote, repoDir], o);
			} catch {
				// clone 的原始错误在这里被有意丢掉：不可达时紧随其后的 push 会以同一个远端为对象
				// 再报一次（同样带着远端地址，那才是用户能行动的信息）。若是别的原因让 clone 失败
				//（超时、盘满）而远端其实有内容，那次 push 会被当成非快进拒掉 —— 初始化失败，
				// 但远端一个字不会被改。
				await rm(repoDir, { recursive: true, force: true }); // clone 失败可能留下半个目录
				await runGit(["init", "--quiet", repoDir], { ...o, cwd: syncRoot });
				await runGit(["remote", "add", "origin", remote], inRepo(o));
				await bootstrapBranch(o);
				return;
			}

			// clone 成功：远端有没有这个分支，用 clone 下来的 refs 就能判断，不必再联网一次。
			const head = await localRef(`refs/remotes/origin/${branch}`, o);
			if (head === null) {
				await bootstrapBranch(o);
				return;
			}
			// bare 远端的 HEAD 常常还指着它自己 init 时的默认分支（例如 master），clone 出来的
			// 本地分支因此是 unborn 的。不对齐到远端分支的话，下一次提交会变成第二个根提交、
			// push 永远非快进 —— 初始化「成功」了，同步却从此推不上去。
			await runGit(["checkout", "--quiet", "-B", branch, head], inRepo(o));
		} catch (err) {
			// 失败的 init 不留半个暂存仓库：留下了 ready() 就是 true，而 origin 指着错的地址，
			// 用户改对之后再 init 会因为幂等直接返回 —— 同步会永远去错的地方。
			await rm(repoDir, { recursive: true, force: true }).catch(() => {});
			throw err;
		}
	}

	/** 索引里有没有待提交的改动。`--quiet` 用退出码说话：0 = 无变化，1 = 有变化，其余是真出错。 */
	async function hasStagedChanges(o: RunOptions): Promise<boolean> {
		try {
			await runGit(["diff", "--cached", "--quiet"], o);
			return false;
		} catch (err) {
			if (exitCodeOf(err) === 1) return true;
			throw err;
		}
	}

	async function publish(
		scope: SyncScope,
		changes: SyncPublishChanges,
		base: { revision: string },
		o: SyncRunOptions & { message: string; author: { name: string; email: string } },
	): Promise<string> {
		await requireRepo();
		const head = await remoteHead(o);

		// base 为空串 = 没有基线（首次发布）：不算非快进，直接以远端当前状态为准 ——
		// 那一轮的差集是引擎按「远端全是新的」算出来的，backend 不替它做决定。
		// 反过来，远端连分支都没有（head === null）而基线却记着一个 revision，说明远端被人动过，
		// 同样按非快进报，绝不猜。
		if (base.revision !== "" && head !== base.revision) {
			throw new NonFastForwardError(
				`The remote moved on before publishing: base ${base.revision}, remote ${head ?? "(no such branch)"}`,
			);
		}
		// 我们的提交要挂上去的那一个：远端的 head，或（远端还没这个分支时）本地已有的提交
		const start = head ?? (await localHead(o));

		// 把暂存工作树对齐到 start。`reset --hard` 顺带修掉烂状态：改坏的已跟踪文件、
		// 以及卡住的 merge 中间态（残留的 MERGE_HEAD 会让 commit 直接 fatal，
		// 内容是个不存在的对象时 git 报的是 “Corrupt MERGE_HEAD file”）。
		await runGit(["reset", "--hard", "--quiet", start], inRepo(o));
		// `clean` 只清**本前缀**下的未跟踪垃圾（上一轮失败留下的）；范围外一律不碰，
		// 用户随手丢进暂存目录的东西也不会被删。
		await runGit(["clean", "--quiet", "-fd", "--", pathspec(scope.prefix)], inRepo(o));

		// 先建出前缀目录：增量可能整个是空的（或删除的文件对端早已删掉），而 git add 对
		// 「匹配不到任何文件」的 pathspec 是 fatal 退出 —— 那种情况的正确答案是「无变化」，不是报错。
		// 空目录 git 不跟踪，因此它进不了提交，下一轮的 clean 会把它收掉。
		await mkdir(scopeDir(scope.prefix), { recursive: true });
		for (const { path, content } of changes.writes) {
			const target = scopedPath(scope.prefix, path);
			// 先删再写：远端可能被人手工推了个同名**符号链接**，直接 writeFile 会顺着链接
			// 写穿到暂存仓库外面去（rm 删的是链接本身，不是它的目标）。
			await rm(target, { force: true });
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
		}
		for (const path of changes.deletions) {
			await rm(scopedPath(scope.prefix, path), { force: true });
		}

		await runGit(["add", "-A", "--", pathspec(scope.prefix)], inRepo(o));
		// 没有变化就不提交、不推送：空提交会让 git log 里全是噪声，也白耗一次远端往返
		if (!(await hasStagedChanges(inRepo(o)))) return start;

		// 作者从入参传，不读环境里的 git 配置：设备归属靠 git log 查（而不是塞进文件名 ——
		// 文件名必须由内容派生，两台设备才能收敛到同一个名字）。
		await runGit(
			["-c", `user.name=${o.author.name}`, "-c", `user.email=${o.author.email}`, "commit", "--quiet", "-m", o.message],
			inRepo(o),
		);

		try {
			await runGit(["push", "--quiet", "origin", `HEAD:${branch}`], inRepo(o));
		} catch (err) {
			// push 被拒可能是「fetch 之后另一台设备又推了」= 非快进（引擎整轮重跑），也可能是
			// 认证 / 网络 / hook。不解析 git 的文案（会被 locale 改写）：再问一次远端的 head ——
			// 它不再等于我们提交所挂的那一个，就是非快进。
			// 本地那个没推上去的提交不算半推状态：下一轮的 reset --hard 会把它丢掉，远端一个字没动。
			const now = await remoteHead(o).catch(() => null);
			if (now !== null && now !== start) {
				throw new NonFastForwardError(`The remote moved on while publishing: based on ${start}, now ${now}`);
			}
			throw err;
		}
		return await localHead(o);
	}

	return { ready, init, fetch, publish };
}
