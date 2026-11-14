import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonFastForwardError, type SyncRunOptions, type SyncScope } from "../src/sync/backend.js";
import { createGitSyncBackend, gitAvailable } from "../src/sync/backend-git.js";
import { sha256Hex } from "../src/sync/hash.js";

const execFileP = promisify(execFile);

/**
 * 整组用**真实的** git 跑：bare 仓库当远端，两个 backend 实例（各自的 syncRoot）当两台设备。
 * 不 mock git 本身 —— 这个模块的全部价值就在于它发出的那串 git 命令真的能跑通，
 * 换成假的只会把「命令写错了」这类 bug 挡在测试外面。没有 git 的环境整组 skip（那不算通过）。
 */
const GIT = await gitAvailable();

/**
 * 一条用例最多要跑几十个 git 子进程（init ≈ 6 个、publish ≈ 7 个），windows runner 上
 * spawn 一个 git 的开销是 ubuntu 的好几倍 —— vitest 默认的 5s 会被基建噪声吃掉，
 * 失败形态还是「Test timed out」这种读起来像产品 bug 的东西。显式给足预算：
 * 真挂死仍会失败，只是晚一点。被测语义（timeoutMs 那条用例的 5s 断言）不动。
 */
const TEST_TIMEOUT_MS = 60_000;

/** backend 调用的运行参数：一律给宽松超时，只有验证 timeoutMs 的那条用例例外。 */
const runOpts: SyncRunOptions = { timeoutMs: 30_000 };
const scope: SyncScope = { prefix: "git/x" };
/** 提交作者故意用非 ASCII：顺带证明它经 execFile 的 `-c` 原样传给 git，不经 shell。 */
const author = { name: "设备 甲", email: "dev-a@example.com" };
const publishOpts = { ...runOpts, message: "sync: 一轮同步", author };

/**
 * `"正文"` 的 sha256。钉死成常量而不是用 `sha256Hex` 现场重算：重算是同义反复，
 * 测不出「backend 算的是别的摘要」。下面另有一条把常量与 `sha256Hex` 绑在一起，
 * 两条合起来才证明「list() 的 hash = 端口契约的那个 sha256」。
 */
const HASH_OF_ZHENGWEN = "d661c3d96d53ebc0ca8a55aae24b5df4a4d1bf28d37337b982fe8ebf54846eeb";

describe.skipIf(!GIT)(
	"git backend",
	{ timeout: TEST_TIMEOUT_MS },
	() => {
		let dir: string;
		let remote: string;

		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "mem-sync-backend-"));
			// git 保持密闭：绝不读机器上的全局/系统配置。否则 user.name、init.defaultBranch、
			// commit.gpgsign 都会渗进来，症状是「本机绿、CI 红」。用临时空文件而不是 /dev/null
			//（windows 上它会变成 C:\dev\null）。
			const emptyConfig = join(dir, "gitconfig-empty");
			await writeFile(emptyConfig, "", "utf8");
			vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
			vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

			remote = join(dir, "remote.git");
			await fixtureGit(["init", "--bare", "--quiet", remote], dir);
		});

		afterEach(async () => {
			vi.unstubAllEnvs();
			await rm(dir, { recursive: true, force: true });
		});

		/** 夹具自己的 git：模拟「有人绕过本功能往远端手工推了东西」与「读一眼仓库状态」。 */
		async function fixtureGit(args: string[], cwd: string): Promise<string> {
			const { stdout } = await execFileP("git", args, {
				cwd,
				timeout: 30_000,
				maxBuffer: 8 * 1024 * 1024,
				encoding: "utf8",
			});
			return stdout.trim();
		}

		/** 一台设备 = 一个 backend 实例 + 自己的 syncRoot，两台设备指向同一个 bare 远端。 */
		function device(name: string) {
			return createGitSyncBackend({ syncRoot: join(dir, name), remote, branch: "main" });
		}

		async function onlineDevice(name: string) {
			const backend = device(name);
			await backend.init(runOpts);
			return backend;
		}

		/** 某台设备的暂存仓库（脏状态那条用例要直接往里塞垃圾）。 */
		function repoDir(name: string): string {
			return join(dir, name, "repo");
		}

		/** 往远端直接推一批文件（仓库根相对路径），绕过任何 backend。links 的值是链接目标。 */
		async function handPush(files: Record<string, string>, links: Record<string, string> = {}): Promise<void> {
			const work = join(dir, "handpush");
			await rm(work, { recursive: true, force: true });
			await fixtureGit(["clone", "--quiet", remote, work], dir);
			// bare 远端的 HEAD 常常还指着它自己 init 时的默认分支，clone 出来的本地分支是 unborn 的
			await fixtureGit(["checkout", "--quiet", "-B", "main", "origin/main"], work);
			for (const [path, content] of Object.entries(files)) {
				const full = join(work, path);
				await mkdir(dirname(full), { recursive: true });
				await writeFile(full, content, "utf8");
			}
			for (const [path, target] of Object.entries(links)) {
				const full = join(work, path);
				await mkdir(dirname(full), { recursive: true });
				await symlink(target, full);
			}
			await fixtureGit(["add", "-A"], work);
			await fixtureGit(
				["-c", "user.name=手工推送", "-c", "user.email=hand@example.com", "commit", "--quiet", "-m", "hand push"],
				work,
			);
			await fixtureGit(["push", "--quiet", "origin", "HEAD:main"], work);
		}

		it("ready(): 未 init 为 false，init 后为 true", async () => {
			const a = device("a");
			expect(await a.ready()).toBe(false);
			await a.init(runOpts);
			expect(await a.ready()).toBe(true);
			// 全部状态都在 syncRoot 底下：用户的记忆目录里永远不会出现 .git
			expect(await readdir(join(dir, "a"))).toEqual(["repo"]);

			// 幂等：再 init 一次既不报错，也不动已经建好的仓库（换远端是另一条命令的职责）
			const head = await fixtureGit(["rev-parse", "HEAD"], repoDir("a"));
			await a.init(runOpts);
			expect(await fixtureGit(["rev-parse", "HEAD"], repoDir("a"))).toBe(head);
		});

		it("未 init 就 fetch / publish → 抛一条能读的错误（不是 git 的 spawn ENOENT）", async () => {
			// 自动路径靠 ready() 跳过，但手动命令与适配层的接线错误都可能走到这里。
			// cwd 不存在时 Node 报的是「找不到 git」，会把人往完全错误的方向引。
			const a = device("a");
			await expect(a.fetch(scope, runOpts)).rejects.toThrow(/staging repository is missing/);
			await expect(
				a.publish(scope, { writes: [{ path: "foo.md", content: "正文" }], deletions: [] }, { revision: "" }, publishOpts),
			).rejects.toThrow(/staging repository is missing/);
		});

		it(
			"暂存仓库读不了（权限）→ ready() 抛错，而不是静默当成「还没初始化」",
			// win32 上 chmod 造不出「存在但读不了」，root 下 chmod 不拦自己（口径同本地扫描那两条用例）
			{ skip: process.platform === "win32" || process.getuid?.() === 0 },
			async () => {
				const a = await onlineDevice("a");
				const repo = repoDir("a");
				await chmod(repo, 0o000);
				try {
					// 只有 ENOENT/ENOTDIR 才是「还没初始化」。静默返回 false 会让同步无声停摆，
					// 而用户以为它开着 —— 权限/IO 错误必须报上来。
					await expect(a.ready()).rejects.toThrow();
					await expect(a.fetch(scope, runOpts)).rejects.toThrow();
				} finally {
					// 改回去，否则 afterEach 的 rm(recursive) 也进不了这个目录
					await chmod(repo, 0o755);
				}
			},
		);

		it("init 在远端是空仓库时也能建出 branch", async () => {
			const a = device("a");
			await a.init(runOpts);

			// 远端真的有这个分支了，不是只在本地建了个没人推的 branch
			expect(await fixtureGit(["ls-remote", "--heads", remote], dir)).toMatch(/refs\/heads\/main$/);
			// 分支上有且只有一个引导提交：后续的 publish 因此有父提交可挂（不会造出第二个根）
			expect(await fixtureGit(["rev-list", "--count", "main"], repoDir("a"))).toBe("1");
			// 引导提交不代表任何设备，用的是模块内部的固定身份（init 的入参里根本没有 author）。
			// 这条能过本身就说明身份是代码给的：夹具里的 git 全局配置是个空文件，
			// 没有 user.name/user.email 时 commit 会直接失败。
			const bootstrapAuthor = await fixtureGit(["log", "-1", "--format=%an <%ae>", "main"], repoDir("a"));
			expect(bootstrapAuthor).toMatch(/^.+ <.+@.+>$/);
			expect(bootstrapAuthor).not.toBe(`${author.name} <${author.email}>`);
			// 引导提交是空的：它不该在远端留下任何文件
			expect(await fixtureGit(["ls-tree", "-r", "--name-only", "main"], repoDir("a"))).toBe("");
		});

		it("publish → fetch 往返：写入的文件出现在 list()，hash 是 sha256", async () => {
			const a = await onlineDevice("a");
			const rev = await a.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "正文" }], deletions: [] },
				{ revision: "" },
				publishOpts,
			);
			expect(rev).toMatch(/^[0-9a-f]{40}$/);

			// 第二台设备在 a 推完之后才 init：顺带压住「clone 一个非空远端」这条路径
			//（远端 HEAD 指向别的分支时，clone 出来的本地分支是 unborn 的，必须对齐到 origin/main）
			const b = await onlineDevice("b");
			const view = await b.fetch(scope, runOpts);
			expect(await view.list()).toEqual([{ path: "foo.md", hash: HASH_OF_ZHENGWEN }]);
			expect(sha256Hex("正文")).toBe(HASH_OF_ZHENGWEN);
			expect(await view.read("foo.md")).toBe("正文");
			expect(view.revision).toBe(rev);
			expect(view.outOfScope).toEqual([]);
			// b 的暂存工作树里也 checkout 出了这个文件，内容逐字节相同
			//（init 已把本地分支对齐到远端：bare 远端的 HEAD 指的是另一个分支时 clone 不会 checkout）
			expect(await fixtureGit(["ls-tree", "-r", "--name-only", "HEAD"], repoDir("b"))).toBe(`${scope.prefix}/foo.md`);
			expect(await readFile(join(repoDir("b"), scope.prefix, "foo.md"), "utf8")).toBe("正文");
		});

		it("list/read 只看到 prefix 内的路径；范围外的路径进 outOfScope（不是静默丢掉）", async () => {
			const a = await onlineDevice("a");
			await handPush({
				"git/other__p/x.md": "别的项目的记忆",
				"MEMORY.md": "有人手工推上来的索引",
				[`${scope.prefix}/sub/nested.md`]: "前缀底下的嵌套目录",
			});

			const view = await a.fetch(scope, runOpts);
			expect(await view.list()).toEqual([]);
			expect([...view.outOfScope].sort()).toEqual(
				["MEMORY.md", "git/other__p/x.md", `${scope.prefix}/sub/nested.md`].sort(),
			);
			// 范围外的东西既不列也读不到（read 只服务 list() 报出的路径）
			await expect(view.read("MEMORY.md")).rejects.toThrow();
		});

		it("非 ASCII 的文件名原样往返（ls-tree 默认的 C-quoting 会把它整条判成范围外）", async () => {
			// 记忆文件名大量是中文（名字来自 frontmatter 的 name），而 git 默认会把非 ASCII
			// 路径转义成 `"git/x/\346\226\207.md"` 这种八进制形式。不处理的话，每一条记忆都会
			// 被当成「范围外的路径」，而同步看起来完全正常 —— 只是什么都拉不下来。
			const a = await onlineDevice("a");
			const b = await onlineDevice("b");
			const name = "中文 文件名.md";
			const content = "正文：带换行\n与多字节字符——字节数 ≠ 字符数";
			const rev = await a.publish(scope, { writes: [{ path: name, content }], deletions: [] }, { revision: "" }, publishOpts);

			const view = await b.fetch(scope, runOpts);
			expect(view.revision).toBe(rev);
			expect(await view.list()).toEqual([{ path: name, hash: sha256Hex(content) }]);
			expect(await view.read(name)).toBe(content);
			expect(view.outOfScope).toEqual([]);

			// 删除也要按原样的名字生效
			await b.publish(scope, { writes: [], deletions: [name] }, { revision: rev }, publishOpts);
			const after = await a.fetch(scope, runOpts);
			expect(await after.list()).toEqual([]);
			expect(after.outOfScope).toEqual([]);
		});

		it("publish 的 deletions 真的删掉远端文件", async () => {
			const a = await onlineDevice("a");
			const b = await onlineDevice("b");
			await a.publish(
				scope,
				{
					writes: [
						{ path: "keep.md", content: "留" },
						{ path: "gone.md", content: "删" },
					],
					deletions: [],
				},
				{ revision: "" },
				publishOpts,
			);

			const view = await b.fetch(scope, runOpts);
			expect((await view.list()).map((entry) => entry.path).sort()).toEqual(["gone.md", "keep.md"]);

			const rev = await b.publish(
				scope,
				{ writes: [], deletions: ["gone.md"] },
				{ revision: view.revision },
				{ ...publishOpts, message: "sync: 删除一条" },
			);
			expect(rev).toMatch(/^[0-9a-f]{40}$/);

			// 第一台设备下一轮看到的就是删除后的样子
			const after = await a.fetch(scope, runOpts);
			expect(await after.list()).toEqual([{ path: "keep.md", hash: sha256Hex("留") }]);
			await expect(after.read("gone.md")).rejects.toThrow();
			expect(after.revision).toBe(rev);
		});

		it("增量为空时不造空提交，直接返回当前 revision", async () => {
			const a = await onlineDevice("a");
			const rev = await a.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "正文" }], deletions: [] },
				{ revision: "" },
				publishOpts,
			);
			const commits = await fixtureGit(["rev-list", "--count", "HEAD"], repoDir("a"));

			// 同样的内容再发一次：无变化 → 不提交、不推送，revision 原地不动
			expect(
				await a.publish(scope, { writes: [{ path: "foo.md", content: "正文" }], deletions: [] }, { revision: rev }, publishOpts),
			).toBe(rev);
			expect(await fixtureGit(["rev-list", "--count", "HEAD"], repoDir("a"))).toBe(commits);

			// 完全空的增量、而且远端还没有这个前缀：git add 对「匹配不到任何文件」的 pathspec
			// 是 fatal 退出，正确答案仍然是「无变化」而不是报错。
			const unused: SyncScope = { prefix: "git/never__synced" };
			expect(await a.publish(unused, { writes: [], deletions: [] }, { revision: rev }, publishOpts)).toBe(rev);
			expect(await fixtureGit(["rev-list", "--count", "HEAD"], repoDir("a"))).toBe(commits);
			// 为这个前缀建的空目录也没进提交（git 不跟踪空目录）
			expect(await fixtureGit(["ls-tree", "-r", "--name-only", "HEAD"], repoDir("a"))).toBe(`${scope.prefix}/foo.md`);
		});

		it("publish 的 base 落后于远端 → NonFastForwardError，且远端内容不被覆盖", async () => {
			const a = await onlineDevice("a");
			const b = await onlineDevice("b");
			await a.publish(scope, { writes: [{ path: "foo.md", content: "A" }], deletions: [] }, { revision: "" }, publishOpts);

			// b 看到的这一版就是它的基线；随后 a 又推了一版，b 的基线因此落后
			const view = await b.fetch(scope, runOpts);
			await a.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "B" }], deletions: [] },
				{ revision: view.revision },
				publishOpts,
			);

			await expect(
				b.publish(scope, { writes: [{ path: "foo.md", content: "C" }], deletions: [] }, { revision: view.revision }, publishOpts),
			).rejects.toBeInstanceOf(NonFastForwardError);

			// 远端一个字都没被改掉：非快进必须在**推之前**就被挡下
			const after = await a.fetch(scope, runOpts);
			expect(await after.read("foo.md")).toBe("B");
			expect(after.revision).not.toBe(view.revision);

			// base 为空串 = 没有基线（首次发布），即使远端已经前进也不算非快进：
			// 那一轮的差集是引擎按「远端全是新的」算的，backend 不该替它做决定。
			const rev = await b.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "C" }], deletions: [] },
				{ revision: "" },
				publishOpts,
			);
			expect(rev).toMatch(/^[0-9a-f]{40}$/);
			expect(await (await a.fetch(scope, runOpts)).read("foo.md")).toBe("C");
		});

		it("暂存仓库卡在脏状态时先 reset 再发布，垃圾不进提交", async () => {
			const a = await onlineDevice("a");
			const rev = await a.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "A" }], deletions: [] },
				{ revision: "" },
				publishOpts,
			);

			// 三种烂状态：改坏的已跟踪文件、上次失败留下的未跟踪垃圾、卡住的 merge 中间态。
			// 最后一种尤其致命 —— 残留的 MERGE_HEAD 会让 commit 直接 fatal，
			// 而且内容是个不存在的对象时 git 报的是「Corrupt MERGE_HEAD file」。
			const repo = repoDir("a");
			await writeFile(join(repo, scope.prefix, "foo.md"), "被手工改坏", "utf8");
			await writeFile(join(repo, scope.prefix, "junk.md"), "垃圾", "utf8");
			await writeFile(join(repo, ".git", "MERGE_HEAD"), `${"0".repeat(40)}\n`, "utf8");

			const healed = await a.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "正文" }], deletions: [] },
				{ revision: rev },
				{ ...publishOpts, message: "sync: 自愈" },
			);
			expect(healed).toMatch(/^[0-9a-f]{40}$/);

			// 暂存工作树里只剩这一轮该有的东西
			expect((await readdir(join(repo, scope.prefix))).sort()).toEqual(["foo.md"]);
			// 推上去的正是这一轮的增量：改坏的内容与垃圾都没进提交
			const view = await a.fetch(scope, runOpts);
			expect(await view.list()).toEqual([{ path: "foo.md", hash: HASH_OF_ZHENGWEN }]);
			expect(view.outOfScope).toEqual([]);
			expect(view.revision).toBe(healed);
		});

		it(
			"远端留了个同名符号链接时，写入不穿到暂存仓库外面",
			// win32 上建符号链接需要特权，git 也默认把它 checkout 成普通文件（core.symlinks=false）
			{ skip: process.platform === "win32" },
			async () => {
				const a = await onlineDevice("a");
				// 链接目标相对于它在**暂存仓库**里的位置（<dir>/a/repo/git/x/），四级上就是 <dir>
				const outside = join(dir, "outside.md");
				await writeFile(outside, "用户自己的文件", "utf8");
				await handPush({}, { [`${scope.prefix}/evil.md`]: "../../../../outside.md" });

				const view = await a.fetch(scope, runOpts);
				// 同名写入是合法增量（本地真的有一条叫 evil.md 的记忆时会走到这里）：
				// 直接 writeFile 会顺着链接把用户盘上的文件改掉，删掉链接再写才不会。
				await a.publish(
					scope,
					{ writes: [{ path: "evil.md", content: "正文" }], deletions: [] },
					{ revision: view.revision },
					publishOpts,
				);

				expect(await readFile(outside, "utf8")).toBe("用户自己的文件");
				const written = join(repoDir("a"), scope.prefix, "evil.md");
				expect(await readFile(written, "utf8")).toBe("正文");
				// 推上去的是真文件（链接被换掉了），远端不再是那个坑
				expect(await fixtureGit(["ls-tree", "-r", "HEAD", "--", "git/x/evil.md"], repoDir("a"))).toMatch(
					/^100644 blob [0-9a-f]{40}\t/,
				);
			},
		);

		it("远端不可达 → 抛错（不静默成功），错误信息里带 remote", async () => {
			// 从没初始化过：远端不存在 → init 必须抛，而且不留半个暂存仓库
			//（留下了 ready() 就是 true，而 origin 指着错的 URL；用户改对配置后 init 会因幂等直接返回，
			// 于是同步永远去错的地方）。
			const bad = createGitSyncBackend({
				syncRoot: join(dir, "bad"),
				remote: join(dir, "不存在的.git"),
				branch: "main",
			});
			await expect(bad.init(runOpts)).rejects.toThrow(/不存在的\.git/);
			expect(await bad.ready()).toBe(false);

			// 初始化过、之后远端消失（离线 / 认证失败 / 仓库被删是同一条路径）：fetch 也要抛，
			// 而且错误信息里带得上远端，用户才知道该看哪儿。
			const a = await onlineDevice("a");
			await rm(remote, { recursive: true, force: true });
			await expect(a.fetch(scope, runOpts)).rejects.toThrow(/remote\.git/);
			await expect(
				a.publish(scope, { writes: [{ path: "foo.md", content: "正文" }], deletions: [] }, { revision: "" }, publishOpts),
			).rejects.toThrow(/remote\.git/);
		});

		it("timeoutMs 生效：给 1ms 的超时会让 fetch 失败而不是挂住", async () => {
			const a = await onlineDevice("a");
			const started = Date.now();
			await expect(a.fetch(scope, { timeoutMs: 1 })).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(5000);

			// 超时不留后遗症：被 SIGTERM 打断的 fetch 不会留下锁文件，下一次照常工作
			expect((await a.fetch(scope, runOpts)).revision).toMatch(/^[0-9a-f]{40}$/);
		});

		it("signal 已中止 → 立刻抛错，不会真的去连远端", async () => {
			const a = await onlineDevice("a");
			const controller = new AbortController();
			controller.abort();
			const started = Date.now();
			await expect(a.fetch(scope, { timeoutMs: 30_000, signal: controller.signal })).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(5000);
		});

		it("publish 的 author 出现在提交里（设备归属靠 git log 查，不进文件名）", async () => {
			const a = await onlineDevice("a");
			await a.publish(
				scope,
				{ writes: [{ path: "foo.md", content: "正文" }], deletions: [] },
				{ revision: "" },
				{ ...publishOpts, author: { name: "笔记本", email: "laptop@example.com" } },
			);
			// 作者与提交者都要是传进来的那个身份：两者任一漏掉，CI 上就会因为环境里没有
			// user.name 而 commit 失败（或者更糟：用上机器上某个不相干的身份）。
			expect(await fixtureGit(["log", "-1", "--format=%an <%ae> | %cn <%ce>"], repoDir("a"))).toBe(
				"笔记本 <laptop@example.com> | 笔记本 <laptop@example.com>",
			);
			// 归属信息只进 git 历史，绝不进文件名（文件名必须由内容派生，两台设备才能收敛到同一个名字）
			expect(await fixtureGit(["ls-tree", "-r", "--name-only", "HEAD"], repoDir("a"))).toBe(`${scope.prefix}/foo.md`);
		});

		it("prefix 里含 [ ] 时按字面匹配（远端 key 可能来自 IPv6 主机名）", async () => {
			// projectDirName 会把 `:` 转义成 `_3a`，但**不**转义方括号 ——
			// `ssh://git@[::1]/o/r` 这类远端算出来的 key 就带着方括号，而它在 git 的 pathspec 里
			// 长得就是个字符类。不管匹配靠的是 git 的字面前缀回退还是显式的 `:(literal)`，
			// 行为必须是「只动这个前缀」：add 匹配不到会 fatal，clean 则静默什么都不清。
			const bracketScope: SyncScope = { prefix: "git/[_3a_3a1]__o__r" };
			const a = await onlineDevice("a");

			const rev = await a.publish(
				bracketScope,
				{ writes: [{ path: "foo.md", content: "正文" }], deletions: [] },
				{ revision: "" },
				publishOpts,
			);
			expect(rev).toMatch(/^[0-9a-f]{40}$/);

			const view = await a.fetch(bracketScope, runOpts);
			expect(await view.list()).toEqual([{ path: "foo.md", hash: HASH_OF_ZHENGWEN }]);
			expect(view.outOfScope).toEqual([]);

			// 删掉再发一次：删除同样要按字面路径生效
			await a.publish(bracketScope, { writes: [], deletions: ["foo.md"] }, { revision: rev }, publishOpts);
			expect(await (await a.fetch(bracketScope, runOpts)).list()).toEqual([]);
		});
	},
);
