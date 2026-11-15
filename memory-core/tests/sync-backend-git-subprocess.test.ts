import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	const fakeError = (args: string[]): Error =>
		Object.assign(new Error(`Command failed: git ${args.join(" ")}`), {
			code: 128,
			killed: false,
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
				await sleep(harness.delayMs);
				if (harness.fail.has(args[0])) throw fakeError(args);
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
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	const backend = (): ReturnType<typeof createGitSyncBackend> =>
		createGitSyncBackend({ syncRoot: join(dir, "sync"), remote: "https://git.example.invalid/o/r.git", branch: "main" });

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

	it("预算耗尽时给出去的也不是 0：`timeout: 0` 在子进程上是「不限时」", async () => {
		harness.fail.add("fetch");
		harness.delayMs = 40; // 第一个子进程就花掉整份预算
		await mkdir(join(dir, "sync", "repo", ".git"), { recursive: true });

		await expect(backend().fetch(scope, { timeoutMs: 10 })).rejects.toThrow();
		expect(harness.calls.length).toBeGreaterThan(1);
		for (const call of harness.calls) expect(call.options.timeout as number).toBeGreaterThanOrEqual(1);
	});
});
