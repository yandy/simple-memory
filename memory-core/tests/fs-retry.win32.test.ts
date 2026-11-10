import { execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFsRetry } from "../src/store/fs-retry.js";

/**
 * 真机用例：用 .NET 的 `FileShare.None` 造出**真实的**共享冲突（杀软/编辑器打断写入时
 * Windows 给的就是这一类错误），验证 ① 短冲突会被重试跨过去 ② 长冲突仍按 fail-closed 报错。
 */
describe.skipIf(process.platform !== "win32")("withFsRetry against a real Windows sharing violation", () => {
	let dir: string;
	let target: string;
	let ready: string;
	const holders: ChildProcess[] = [];
	/** 子进程启动失败（比如没有 powershell.exe）：记下来，由 waitForReady 报出真实原因。 */
	const holderFailures: Error[] = [];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-retry-win-"));
		target = join(dir, "target.txt");
		ready = join(dir, "ready.txt");
		holderFailures.length = 0;
		await writeFile(target, "initial", "utf8");
	});
	afterEach(async () => {
		// `kill()` 只发信号、**不等待**进程退出：Windows 上独占句柄要到进程拆除时才释放，
		// 若不等 `exit` 就 rm，第二个用例（持有 8s）会让 rm 撞上共享冲突而抛 EPERM/EBUSY。
		// 先挂 exit 监听再 kill，避免退出事件早于监听注册的竞态；已退出的子进程直接视为完成。
		await Promise.all(
			holders.splice(0).map((holder) => {
				const exited = new Promise<void>((resolve) => {
					if (holder.exitCode !== null || holder.signalCode !== null) resolve();
					else holder.once("exit", () => resolve());
				});
				holder.kill();
				return exited;
			}),
		);
		// 第二道防线：进程退出与句柄真正可删除之间仍可能被杀软/索引器拖住，用 Node 自带的
		// 退避重试兜住（与 snapshot.ts 的 pruneSnapshots 同一组参数）。
		await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
	});

	/** 后台独占 target `holdMs` 毫秒后释放；取得独占后写 ready 标记。 */
	function startExclusiveHold(holdMs: number): void {
		// 路径要插进 PowerShell 的单引号字符串：单引号按 PowerShell 规则写成两个。不转义的话，
		// `C:\Users\O'Brien\…` 这种临时目录会把脚本截断，最后只表现成误导性的
		// 「the exclusive holder never became ready」。
		const psq = (p: string) => `'${p.replace(/'/g, "''")}'`;
		const script = [
			`$fs = [IO.File]::Open(${psq(target)}, 'Open', 'Read', 'None')`,
			`[IO.File]::WriteAllText(${psq(ready)}, 'ready')`,
			`Start-Sleep -Milliseconds ${holdMs}`,
			"$fs.Close()",
		].join("; ");
		const holder = execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
		// 没有 `error` 监听时，「根本没有 powershell.exe」会变成一个未处理的 'error' 事件。
		holder.once("error", (e) => holderFailures.push(e));
		holders.push(holder);
	}

	async function waitForReady(): Promise<void> {
		for (let i = 0; i < 100; i++) {
			if (holderFailures.length > 0) {
				throw new Error(`the exclusive holder never started: ${holderFailures[0].message}`);
			}
			const up = await readFile(ready, "utf8").then(
				() => true,
				() => false,
			);
			if (up) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error("the exclusive holder never became ready");
	}

	// 这两个用例都要先 spawn 一个 PowerShell 持锁进程、再等它就绪，最后才是重试本身。
	// vitest 的 5s 默认值刚好压在 runner 的噪声边缘（实测 5024ms 超时过一次），而且失败的
	// 样子是「Test timed out in 5000ms」—— 看上去像产品 bug，实际只是预算太紧。给它一个
	// 宽到不可能被吃掉的预算；真挂死时它仍然会失败，只是晚 30s。
	const WIN32_TIMEOUT_MS = 30_000;

	it("crosses a short exclusive hold", async () => {
		// ready 是在取得独占**之后**写的，所以紧跟其后的第一次尝试必然撞上冲突；跨过 300ms 的
		// 持锁原本只需默认预算（900ms）的前几次重试。这里仍显式放宽到 ~2.7s：runner 上杀软/
		// 索引器会在 `$fs.Close()` 之后继续压着文件，真机已复现一次 EBUSY 落在默认预算之外。
		// 默认阶梯本身由 tests/fs-retry.test.ts 用注入的 sleep 锁死（20/40/80/160/300/300），
		// 这条用例只负责证明「真实的 Windows 共享冲突被当成瞬时错误并跨过去」。
		startExclusiveHold(300);
		await waitForReady();
		await expect(
			withFsRetry(() => writeFile(target, "written", "utf8"), { retries: 12 }),
		).resolves.toBeUndefined();
		expect(await readFile(target, "utf8")).toBe("written");
	}, WIN32_TIMEOUT_MS);

	it("fails closed after the budget when the hold outlasts it", async () => {
		startExclusiveHold(8000); // 远超重试预算
		await waitForReady();
		const started = Date.now();
		const err = await withFsRetry(() => writeFile(target, "written", "utf8")).catch((e: unknown) => e);
		expect((err as NodeJS.ErrnoException).code).toMatch(/^(EPERM|EACCES|EBUSY)$/);
		expect(Date.now() - started).toBeLessThan(2000); // 重试预算 ≈900ms，远低于这个上限
	}, WIN32_TIMEOUT_MS);
});
