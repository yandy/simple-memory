import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncScope } from "../src/sync/backend.js";

/**
 * git 子进程的**启动参数**：环境变量与超时预算。
 *
 * 这里刻意不跑真 git，而是把 `node:child_process` 换成一层记录用的委托缝：要钉住的两件事
 * （「绝不向用户要凭据」与「一次调用共享一份预算」）都只体现在**传给子进程的那个 options 对象**上，
 * 真 git 反而看不见它们。真命令能不能跑通由 `sync-backend-git.test.ts` 那一组负责。
 */
const harness = vi.hoisted(() => ({
	calls: [] as Array<{ args: string[]; options: Record<string, unknown> }>,
	/** 这些子命令一律按失败处理（用来逼出「fetch 失败 → ls-remote 复核」那第二个子进程）。 */
	fail: new Set<string>(),
	/** 每个子进程花掉的真时间：预算是「剩下的毫秒」，不花点时间就看不出它在递减。 */
	delayMs: 5,
	/** 并发用例在真实文件系统边界上控制一个命令；其余命令仍按默认成功/失败分派。 */
	onCall: null as null | ((args: string[], options: Record<string, unknown>) => void | Promise<void>),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	// 照 `execFile` 的形状造错误：`message` 与 `cmd` 里都带着**完整命令行**（凭据就在里面）
	const fakeError = (args: string[]): Error =>
		Object.assign(new Error(`Command failed: git ${args.join(" ")}`), {
			code: 128,
			killed: false,
			cmd: `git ${args.join(" ")}`,
			stderr: `fatal: unable to access '${args.at(-1)}': could not resolve host`,
		});

	// `promisify(execFile)` 走的是 custom 符号，所以假的实现也得带上它；返回值要能被
	// `const { stdout } = await promise` 与 `promise.child.stdin?.…` 两处消费。
	const execFile = Object.assign(
		(..._args: unknown[]) => {
			throw new Error("callback form is not used by the sync backend");
		},
		{
			[promisify.custom]: async (
				_file: string,
				args: string[],
				options: Record<string, unknown>,
			): Promise<{ stdout: Buffer; stderr: string; child: { stdin?: unknown } }> => {
				harness.calls.push({ args: [...args], options: { ...options } });
				await harness.onCall?.(args, options);
				await sleep(harness.delayMs);
				if (harness.fail.has(args[0])) throw fakeError(args);
				// git 的真实副作用只模拟本测试依赖的「clone/init 建出 .git」；其余命令保持可观察委托。
				if (args[0] === "clone" || args[0] === "init") {
					await mkdir(join(args.at(-1) as string, ".git"), { recursive: true });
				}
				return { stdout: Buffer.from(""), stderr: "", child: { stdin: undefined } };
			},
		},
	);
	return { ...actual, execFile };
});

// 委托缝必须在 import 被测模块之前生效，所以这里是动态 import（`vi.mock` 已被 hoist）
const { createGitSyncBackend } = await import("../src/sync/backend-git.js");

const scope: SyncScope = { prefix: "git/x" };

describe("git backend 的子进程启动参数", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-sync-subprocess-"));
		harness.calls.length = 0;
		harness.fail.clear();
		harness.delayMs = 5;
		harness.onCall = null;
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	const backend = (): ReturnType<typeof createGitSyncBackend> =>
		createGitSyncBackend({
			syncRoot: join(dir, "sync"),
			// 记忆根显式给（共存检查的入参）；它不存在，所以 init 不会多跑一个读用户仓库的子进程
			memoryRoot: join(dir, "memory"),
			remote: "https://git.example.invalid/o/r.git",
			branch: "main",
		});

	const envOf = (index: number): Record<string, unknown> => harness.calls[index].options.env as Record<string, unknown>;

	it("每个 git 子进程都带上「不许提示」的环境：GIT_TERMINAL_PROMPT=0 + ssh BatchMode", async () => {
		await backend().init({ timeoutMs: 30_000 });
		// 自检：真的跑到了子进程（init 至少 clone 一次），否则下面的断言全是恒真
		expect(harness.calls.length).toBeGreaterThan(0);
		for (const index of harness.calls.keys()) {
			expect(envOf(index).GIT_TERMINAL_PROMPT).toBe("0");
			expect(envOf(index).GIT_SSH_COMMAND).toBe("ssh -oBatchMode=yes");
		}
		// 是「叠加在 process.env 上」，不是替换掉它：PATH / HOME / 代理设置一个都不能少
		expect(envOf(0).PATH).toBe(process.env.PATH);
		expect(Object.keys(envOf(0)).length).toBeGreaterThan(2);
	});

	it("用户自己设过的 GIT_SSH_COMMAND 原样保留（那通常带着他的 IdentityFile）", async () => {
		vi.stubEnv("GIT_SSH_COMMAND", "ssh -i /home/u/.ssh/work_key");
		await backend().init({ timeoutMs: 30_000 });
		expect(harness.calls.length).toBeGreaterThan(0);
		for (const index of harness.calls.keys()) {
			expect(envOf(index).GIT_SSH_COMMAND).toBe("ssh -i /home/u/.ssh/work_key");
			// git 自己的提示仍然关掉：这一条与 ssh 无关，覆盖它没有任何用户语义可保护
			expect(envOf(index).GIT_TERMINAL_PROMPT).toBe("0");
		}
	});

	it("一次调用共享一份预算：失败复核的那个子进程拿到的是**剩下的**毫秒", async () => {
		// 让 fetch 失败，逼出 remoteHead 的 ls-remote 复核 —— 那正是「离线路径上花掉 2×」的第二步
		harness.fail.add("fetch");
		harness.delayMs = 20;
		await mkdir(join(dir, "sync", "repo", ".git"), { recursive: true }); // ready() 只看这个目录在不在

		await expect(backend().fetch(scope, { timeoutMs: 1_000 })).rejects.toThrow();

		const names = harness.calls.map((call) => call.args[0]);
		expect(names).toContain("fetch");
		const fetchAt = names.indexOf("fetch");
		const probeAt = names.indexOf("ls-remote", fetchAt);
		expect(probeAt).toBeGreaterThan(fetchAt);
		const first = harness.calls[fetchAt].options.timeout as number;
		const second = harness.calls[probeAt].options.timeout as number;
		expect(first).toBeLessThanOrEqual(1_000);
		// 载重：第二个子进程不得又拿一份满额预算（那样子进程一多，一次调用就是配置值的好几倍）
		expect(second).toBeLessThan(first);
		expect(second).toBeGreaterThanOrEqual(1);
	});

	it("★逃逸错误的整条 cause 链都不带凭据，且仍是 GitCommandError（类型与退出码没被包丢）", async () => {
		// 远端 URL 里带 token（`https://user:token@host` 是 git 官方写法，也是 CI 免交互推送的常规做法）。
		// 让 `clone` 与退回路径上的 `remote add origin <url>` 都失败：这两条命令的 args 里都有那份 URL，
		// 于是逃逸出去的错误链上会同时出现「前一步的 clone」与「本次 remote add 的原始子进程错误」。
		const token = "s3cr3t-token";
		const bad = createGitSyncBackend({
			syncRoot: join(dir, "creds"),
			memoryRoot: join(dir, "creds-memory"),
			remote: `https://sync-user:${token}@127.0.0.1:1/o/r.git`,
			branch: "main",
		});
		harness.fail.add("clone");
		harness.fail.add("remote");

		const err = await bad.init({ timeoutMs: 30_000 }).then(
			() => null,
			(e: unknown) => e as Error & { exitCode?: number },
		);
		expect(err).toBeInstanceOf(Error);

		// 载重一：宿主一句 `console.error(err)` 走的就是 `util.inspect`，它会**递归打印整条 cause 链**
		// （`execFile` 的原始错误在 `message` 与 `cmd` 两个字段上都带着完整命令行）。
		// 只 redact 我们自己拼的那条 message，token 会从 cause 这条路照样进日志与 issue。
		const printed = inspect(err, { depth: 8 });
		expect(printed).toContain("[cause]"); // 自检：链确实被打出来了，否则下面那条是恒真
		expect(printed).not.toContain(token);
		expect(printed).toContain("sync-user:***@"); // 远端仍然认得出是哪个，只是口令没了

		// 载重二：拼进「前一步也失败了」时不得换对象 —— 调用方靠最外面这个对象认类型与退出码
		//（认 AbortError、区分 `diff --cached --quiet` 的 0/1），包一层普通 Error 就等于把这些判定废掉。
		expect(err?.name).toBe("GitCommandError");
		expect(err?.exitCode).toBe(128);
		expect(err?.message).toMatch(/git remote add/);
		expect(err?.message).toMatch(/git clone had already failed/);
	});

	it("旧 init 的失败清理不能删掉另一实例已经发布的 clone，临时目录也不被 ready 误认", async () => {
		const syncRoot = join(dir, "shared");
		const memoryRoot = join(dir, "shared-memory");
		const remote = "https://git.example.invalid/o/r.git";
		const make = () => createGitSyncBackend({ syncRoot, memoryRoot, remote, branch: "main" });
		const older = make();
		const newer = make();
		const controller = new AbortController();
		let releaseOlder!: () => void;
		const olderGate = new Promise<void>((resolve) => {
			releaseOlder = resolve;
		});
		let markOlderPush!: () => void;
		const olderPush = new Promise<void>((resolve) => {
			markOlderPush = resolve;
		});
		harness.onCall = async (args, options) => {
			if (args[0] === "push" && options.signal === controller.signal) {
				markOlderPush();
				await olderGate;
				const aborted = new Error("older init aborted after the newer instance finished");
				aborted.name = "AbortError";
				throw aborted;
			}
		};

		const oldFlight = older.init({ timeoutMs: 30_000, signal: controller.signal });
		await olderPush;
		const newFlight = newer.init({ timeoutMs: 30_000 });
		// 旧实现里 newer 会直接看见 older 的半成品 repo 并成功；新实现则被管理锁串行，
		// 等 older 清理自己的 staging 后才建最终 repo。两种顺序都由后面的所有 Promise 收束。
		await Promise.race([newFlight, new Promise((resolve) => setTimeout(resolve, 50))]);
		releaseOlder();
		const outcomes = await Promise.allSettled([oldFlight, newFlight]);

		expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
		expect(await newer.ready()).toBe(true);
		expect((await readdir(syncRoot)).filter((name) => name.startsWith("repo.init-"))).toEqual([]);
	});

	it.each(["https", "git+https"])("%s 的 token-only userinfo 也会从整条错误链脱敏", async (scheme) => {
		const token = "s3cr3t-token-only";
		const bad = createGitSyncBackend({
			syncRoot: join(dir, `creds-${scheme}`),
			memoryRoot: join(dir, "creds-memory"),
			remote: `${scheme}://${token}@127.0.0.1:1/o/r.git`,
			branch: "main",
		});
		harness.fail.add("clone");
		harness.fail.add("remote");

		const err = await bad.init({ timeoutMs: 30_000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);
		const printed = inspect(err, { depth: 8 });
		expect(printed).not.toContain(token);
		expect(printed).toContain(`${scheme}://***@127.0.0.1:1/o/r.git`);
	});

	it("没有 userinfo 的 HTTP URL 原样保留，不被误当凭据", async () => {
		const plain = "https://127.0.0.1:1/o/r.git";
		const bad = createGitSyncBackend({
			syncRoot: join(dir, "plain"),
			memoryRoot: join(dir, "plain-memory"),
			remote: plain,
			branch: "main",
		});
		harness.fail.add("clone");
		harness.fail.add("remote");
		const err = await bad.init({ timeoutMs: 30_000 }).catch((error: unknown) => error as Error);
		expect(inspect(err, { depth: 8 })).toContain(plain);
	});

	it("预算耗尽时给出去的也不是 0：`timeout: 0` 在子进程上是「不限时」", async () => {
		harness.fail.add("fetch");
		harness.delayMs = 40; // 第一个子进程就花掉整份预算
		await mkdir(join(dir, "sync", "repo", ".git"), { recursive: true });

		await expect(backend().fetch(scope, { timeoutMs: 10 })).rejects.toThrow();
		expect(harness.calls.length).toBeGreaterThan(1);
		for (const call of harness.calls) expect(call.options.timeout as number).toBeGreaterThanOrEqual(1);
	});
});
