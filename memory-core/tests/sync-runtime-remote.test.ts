import { mkdir, rename } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	FLUSH_ROUND,
	HARNESS_MESSAGES,
	PULL_ROUND,
	PUSH_ROUND,
	STATUS_REPORT,
	createSyncRuntimeHarness,
	deferred,
	mustRuntime,
	sleep,
	type FakeEngine,
	type HarnessOptions,
	type HarnessResult,
	type SyncRuntimeHarness,
} from "./helpers/sync-runtime.js";
import {
	manifestPath,
	syncTransport,
	type SyncRuntime,
	type SyncRuntimeOptions,
	type SyncRuntimeOutcome,
} from "../src/index.js";

/**
 * 两种活动协调模式、换远端与完整收摊。
 *
 * 每条用例都抓一个具体的协调 bug：并发入口被额外微任务推迟、serial 插队、关闸过晚、
 * 旧自动轮在 manifest 失效之后才落盘、失败恢复漏掉/重复 noteWrite、dispose 少等一本账，
 * 以及 flush rejection 把 URL userinfo 原样抛给宿主。backend/engine 只是带屏障的协调端口；
 * runtime、store、device 与 manifest 都走真实现和真盘。
 */

const BUSY_REASON = "sync remote change is already in progress; retry the operation afterwards";
const DISPOSED_REASON = "sync runtime is disposed";
const NEXT_REMOTE = "https://next.example/org/proj.git";
const harnesses: SyncRuntimeHarness[] = [];

async function harnessFor(
	over?: HarnessOptions,
): Promise<{ h: SyncRuntimeHarness; result: HarnessResult; runtime: SyncRuntime }> {
	const h = await createSyncRuntimeHarness();
	harnesses.push(h);
	const result = await h.create(over);
	return { h, result, runtime: mustRuntime(result) };
}

async function prepareOldEngine(h: SyncRuntimeHarness, runtime: SyncRuntime): Promise<FakeEngine> {
	h.backend.initRevision = "rev-old";
	const prepared = await runtime.prepare(1000);
	if (!prepared.ok) throw new Error(`expected old engine, got: ${prepared.reason}`);
	expect(h.engines).toHaveLength(1);
	return h.engines[0];
}

function expectBusy<T>(outcome: SyncRuntimeOutcome<T>): void {
	expect(outcome).toEqual({ ok: false, reason: BUSY_REASON });
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.cleanup();
});

describe("活动协调模式", () => {
	it("concurrent 调用返回前同步进入 run prepare，并同步调用 status/flush engine", async () => {
		const { h, runtime } = await harnessFor({ scheduling: "concurrent" });
		const engine = await prepareOldEngine(h, runtime);
		const pushGate = deferred();
		const pushStarted = deferred();
		engine.pushBarrier = pushGate;
		engine.pushStarted = pushStarted;
		h.events.length = 0;

		const running = runtime.run("push", 1000);
		// run 必须先 prepare；这里的同步性是「活动已开始」，不是越过 prepare 直接开轮。
		expect(h.events).toEqual(["backend:ready"]);
		await pushStarted.promise;
		const status = runtime.status(1000);
		expect(h.events.at(-1)).toBe("engine:status");
		const flushing = runtime.flush(700);
		expect(h.events.at(-1)).toBe("engine:flush");

		pushGate.resolve(undefined);
		expect(await running).toEqual({ ok: true, value: PUSH_ROUND });
		expect(await status).toEqual({ ok: true, value: STATUS_REPORT });
		expect(await flushing).toEqual(FLUSH_ROUND);
	});

	it("serial 严格 FIFO：前一个 engine barrier 未放行时后调用者不得开始", async () => {
		const { h, runtime } = await harnessFor({ scheduling: "serial" });
		const engine = await prepareOldEngine(h, runtime);
		const pushGate = deferred();
		const pushStarted = deferred();
		engine.pushBarrier = pushGate;
		engine.pushStarted = pushStarted;
		h.events.length = 0;

		const running = runtime.run("push", 1000);
		await pushStarted.promise;
		const status = runtime.status(1000);
		const flushing = runtime.flush(700);
		const eventsBeforeRelease = [...h.events];
		pushGate.resolve(undefined);

		expect(await running).toEqual({ ok: true, value: PUSH_ROUND });
		expect(await status).toEqual({ ok: true, value: STATUS_REPORT });
		expect(await flushing).toEqual(FLUSH_ROUND);
		expect(eventsBeforeRelease).toEqual(["backend:ready", "backend:getRemote", "engine:push"]);
		expect(h.events).toEqual([
			"backend:ready",
			"backend:getRemote",
			"engine:push",
			"engine:push:done",
			"engine:status",
			"engine:flush",
		]);
	});
});

describe("changeRemote 关闸与持久顺序", () => {
	it("公开调用即关闸：活动、prepare、flush 与第二次 changeRemote 都 busy，写入不触旧 engine", async () => {
		const { h, runtime } = await harnessFor();
		const oldEngine = await prepareOldEngine(h, runtime);
		const pushGate = deferred();
		const pushStarted = deferred();
		oldEngine.pushBarrier = pushGate;
		oldEngine.pushStarted = pushStarted;
		const manual = runtime.run("push", 1000);
		await pushStarted.promise;

		const changing = runtime.changeRemote(NEXT_REMOTE, 1000);
		const gatedRun = runtime.run("pull", 1000);
		const gatedStartup = runtime.startup();
		const gatedStatus = runtime.status(1000);
		const gatedPrepare = runtime.prepare(1000);
		const gatedFlush = runtime.flush(1000).then(
			(value) => value,
			(error: unknown) => error,
		);
		const second = runtime.changeRemote("https://second.example/org/proj.git", 1000);
		runtime.noteWrite();
		const oldNoteWrites = oldEngine.noteWrites;

		pushGate.resolve(undefined);
		const [manualResult, changed, runResult, startupResult, statusResult, prepareResult, flushResult, secondResult] =
			await Promise.all([manual, changing, gatedRun, gatedStartup, gatedStatus, gatedPrepare, gatedFlush, second]);

		expect(manualResult).toEqual({ ok: true, value: PUSH_ROUND });
		expect(changed).toEqual({ ok: true, value: null });
		expectBusy(runResult);
		expectBusy(startupResult);
		expectBusy(statusResult);
		expect(prepareResult).toEqual({ ok: false, reason: BUSY_REASON });
		expect(flushResult).toBeInstanceOf(Error);
		expect((flushResult as Error).message).toBe(BUSY_REASON);
		expectBusy(secondResult);
		expect(oldNoteWrites).toBe(0);
		expect(h.backend.setRemoteCalls).toEqual([NEXT_REMOTE]);
	});

	it("serial changeRemote 等待前序 tail，关闸后的活动不得排到它后面", async () => {
		const { h, runtime } = await harnessFor({ scheduling: "serial" });
		const oldEngine = await prepareOldEngine(h, runtime);
		const pushGate = deferred();
		const pushStarted = deferred();
		oldEngine.pushBarrier = pushGate;
		oldEngine.pushStarted = pushStarted;
		h.events.length = 0;
		const first = runtime.run("push", 1000);
		await pushStarted.promise;
		const queued = runtime.run("pull", 1000);

		const changing = runtime.changeRemote(NEXT_REMOTE, 1000);
		const gatedStatus = runtime.status(1000);
		const eventsBeforeRelease = [...h.events];
		pushGate.resolve(undefined);
		const [firstResult, queuedResult, changed, statusResult] = await Promise.all([
			first,
			queued,
			changing,
			gatedStatus,
		]);

		expect(eventsBeforeRelease).toEqual(["backend:ready", "backend:getRemote", "engine:push"]);
		expect(firstResult).toEqual({ ok: true, value: PUSH_ROUND });
		expect(queuedResult).toEqual({ ok: true, value: PULL_ROUND });
		expect(changed).toEqual({ ok: true, value: null });
		expectBusy(statusResult);
		expect(h.events.indexOf("engine:pull")).toBeLessThan(h.events.indexOf("engine:dispose"));
		expect(h.events.indexOf("engine:dispose")).toBeLessThan(h.events.indexOf("backend:setRemote"));
		expect(h.engines[1].noteWrites).toBe(1);
	});

	it("先 drain 活动与旧 inFlight，再失效 manifest、setRemote、写空基线并恢复一次 noteWrite", async () => {
		const { h, runtime } = await harnessFor();
		const oldEngine = await prepareOldEngine(h, runtime);
		const pushGate = deferred();
		const pushStarted = deferred();
		const oldDisposed = deferred();
		const automaticGate = deferred();
		const setRemoteGate = deferred();
		const setRemoteStarted = deferred();
		oldEngine.pushBarrier = pushGate;
		oldEngine.pushStarted = pushStarted;
		oldEngine.disposeStarted = oldDisposed;
		oldEngine.inFlight = automaticGate.promise.then(() => {
			h.events.push("old:inFlight:settled");
		});
		h.backend.setRemoteBarrier = setRemoteGate;
		h.backend.setRemoteStarted = setRemoteStarted;
		h.backend.initRevision = "rev-new";
		h.events.length = 0;

		const manual = runtime.run("push", 1000);
		await pushStarted.promise;
		const changing = runtime.changeRemote(NEXT_REMOTE, 1200);
		const beforeManualRelease = {
			disposeCalls: oldEngine.disposeCalls,
			engine: runtime.engine,
			manifestExists: h.manifestExists(),
			setRemoteCalls: h.backend.setRemoteCalls.length,
		};
		pushGate.resolve(undefined);
		expect(await manual).toEqual({ ok: true, value: PUSH_ROUND });

		const reachedDispose = await Promise.race([
			oldDisposed.promise.then(() => true),
			changing.then(() => false),
		]);
		const beforeAutomaticRelease = {
			disposeCalls: oldEngine.disposeCalls,
			engine: runtime.engine,
			manifestExists: h.manifestExists(),
			setRemoteCalls: h.backend.setRemoteCalls.length,
		};
		automaticGate.resolve(undefined);
		const reachedSetRemote = await Promise.race([
			setRemoteStarted.promise.then(() => true),
			changing.then(() => false),
		]);
		const atSetRemote = { engine: runtime.engine, manifestExists: h.manifestExists() };
		setRemoteGate.resolve(undefined);
		const changed = await changing;

		expect(beforeManualRelease).toEqual({
			disposeCalls: 0,
			engine: oldEngine,
			manifestExists: true,
			setRemoteCalls: 0,
		});
		expect(reachedDispose).toBe(true);
		expect(beforeAutomaticRelease).toEqual({
			disposeCalls: 1,
			engine: null,
			manifestExists: true,
			setRemoteCalls: 0,
		});
		expect(reachedSetRemote).toBe(true);
		expect(atSetRemote).toEqual({ engine: null, manifestExists: false });
		expect(changed).toEqual({ ok: true, value: null });
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(h.engines[1].noteWrites).toBe(1);
		expect(h.backend.initTimeouts).toEqual([1000, 1200]);
		expect(await h.manifest()).toEqual({
			version: 2,
			transport: syncTransport(NEXT_REMOTE, "main"),
			base: { revision: "rev-new", syncedAt: "2026-11-15T08:00:00.000Z" },
			files: {},
		});
		for (const [earlier, later] of [
			["engine:push:done", "engine:dispose"],
			["engine:dispose", "old:inFlight:settled"],
			["old:inFlight:settled", "backend:setRemote"],
			["backend:setRemote", "backend:init"],
			["backend:init:done", "engine:noteWrite"],
		] as const) {
			expect(h.events.indexOf(earlier), `${earlier} precedes ${later}`).toBeGreaterThanOrEqual(0);
			expect(h.events.indexOf(earlier)).toBeLessThan(h.events.indexOf(later));
		}
	});

	it("直接 prepare 也属于换远端要 drain 的账本", async () => {
		const { h, runtime } = await harnessFor();
		const initGate = deferred();
		const initStarted = deferred();
		h.backend.initBarrier = initGate;
		h.backend.initStarted = initStarted;
		h.backend.initRevision = "rev-old";
		const preparing = runtime.prepare(1000);
		await initStarted.promise;

		const changing = runtime.changeRemote(NEXT_REMOTE, 1000);
		await sleep(0);
		const setRemoteBeforePrepare = h.backend.setRemoteCalls.length;
		initGate.resolve(undefined);
		const [initial, changed] = await Promise.all([preparing, changing]);

		expect(initial.ok).toBe(true);
		expect(setRemoteBeforePrepare).toBe(0);
		expect(changed).toEqual({ ok: true, value: null });
		expect(h.events.indexOf("backend:init:done")).toBeLessThan(h.events.indexOf("backend:setRemote"));
		expect(h.engines).toHaveLength(2);
		expect(h.engines[0].disposeCalls).toBe(1);
	});

	it("manifest 失效失败时 origin 不动，仍恢复恰好一个 replacement noteWrite", async () => {
		const { h, runtime } = await harnessFor();
		h.backend.origin = "https://old.example/org/proj.git";
		const oldEngine = await prepareOldEngine(h, runtime);
		const path = manifestPath(h.syncRoot, h.projectKey);
		await rename(path, `${path}.backup`);
		await mkdir(path);

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000);

		expect(changed.ok).toBe(false);
		expect(h.backend.setRemoteCalls).toEqual([]);
		expect(h.backend.origin).toBe("https://old.example/org/proj.git");
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(h.engines[1].noteWrites).toBe(1);
		expect(runtime.engine).toBe(h.engines[1]);
	});

	it("未初始化时只返回注入指引，不借恢复流程初始化或写 device", async () => {
		const { h, runtime } = await harnessFor();

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000);

		expect(changed).toEqual({ ok: false, reason: HARNESS_MESSAGES.uninitializedRemoteChange });
		expect(h.backend.setRemoteCalls).toEqual([]);
		expect(h.backend.initTimeouts).toEqual([]);
		expect(h.engines).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
	});

	it("ready 期间 dispose 优先于未初始化指引，且不恢复 engine 或写盘", async () => {
		const { h, runtime } = await harnessFor();
		const readyGate = deferred();
		const readyStarted = deferred();
		h.backend.readyBarrier = readyGate;
		h.backend.readyStarted = readyStarted;
		const changing = runtime.changeRemote(NEXT_REMOTE, 1000);
		await readyStarted.promise;

		const draining = runtime.dispose();
		readyGate.resolve(undefined);

		expect(await changing).toEqual({ ok: false, reason: DISPOSED_REASON });
		await draining;
		expect(h.backend.setRemoteCalls).toEqual([]);
		expect(h.engines).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestExists()).toBe(false);
	});
});

describe("changeRemote 诊断与恢复", () => {
	it("origin 已切换而 prepare 失败时，默认 outcome 只保留脱敏后的原 reason", async () => {
		const { h, runtime } = await harnessFor();
		const oldEngine = await prepareOldEngine(h, runtime);
		h.backend.initFailure = new Error("prepare failed for https://s3cr3t-token@example.invalid/new.git");

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000);

		expect(changed).toEqual({
			ok: false,
			reason: "prepare failed for https://***@example.invalid/new.git",
		});
		expect(JSON.stringify(changed)).not.toContain("s3cr3t-token");
		expect(h.backend.origin).toBe(NEXT_REMOTE);
		expect(h.manifestExists()).toBe(false);
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(h.engines[1].noteWrites).toBe(1);
	});

	it("宿主 formatter 收到 originChanged 与 prepare stage，且只改变诊断", async () => {
		const failures: unknown[] = [];
		const messages: SyncRuntimeOptions["messages"] = {
			...HARNESS_MESSAGES,
			formatRemoteChangeFailure(failure) {
				failures.push(failure);
				return `formatted ${failure.stage} (${failure.originChanged}): ${failure.reason}`;
			},
		};
		const { h, runtime } = await harnessFor({ messages });
		await prepareOldEngine(h, runtime);
		h.backend.initFailure = new Error("controlled prepare failure");

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000);

		expect(failures).toEqual([
			{ remote: NEXT_REMOTE, originChanged: true, stage: "prepare", reason: "controlled prepare failure" },
		]);
		expect(changed).toEqual({ ok: false, reason: "formatted prepare (true): controlled prepare failure" });
		expect(h.backend.origin).toBe(NEXT_REMOTE);
		expect(h.manifestExists()).toBe(false);
		expect(h.engines[1].noteWrites).toBe(1);
	});

	it("origin 切换后的非 prepare 异常走 operation stage，恢复触发不被跳过", async () => {
		const failures: unknown[] = [];
		const messages: SyncRuntimeOptions["messages"] = {
			...HARNESS_MESSAGES,
			formatRemoteChangeFailure(failure) {
				failures.push(failure);
				return `formatted ${failure.stage} (${failure.originChanged}): ${failure.reason}`;
			},
		};
		const { h, runtime } = await harnessFor({ messages });
		await prepareOldEngine(h, runtime);
		h.backend.initWarnings = ["baseline warning"];

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000, () => {
			throw new Error("warning callback failed");
		});

		expect(failures).toEqual([
			{ remote: NEXT_REMOTE, originChanged: true, stage: "operation", reason: "warning callback failed" },
		]);
		expect(changed).toEqual({ ok: false, reason: "formatted operation (true): warning callback failed" });
		expect(h.engines).toHaveLength(2);
		expect(h.engines[1].noteWrites).toBe(1);
	});

	it("prepare 失败且 formatter 抛错时仍恢复一次，公开 outcome 不泄露原始 rejection", async () => {
		const messages: SyncRuntimeOptions["messages"] = {
			...HARNESS_MESSAGES,
			formatRemoteChangeFailure() {
				throw new Error("formatter failed for https://formatter-token@example.invalid/diagnostic.git");
			},
		};
		const { h, runtime } = await harnessFor({ messages });
		const oldEngine = await prepareOldEngine(h, runtime);
		h.backend.initFailure = new Error("prepare failed for https://prepare-token@example.invalid/new.git");

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000);

		expect(changed).toEqual({
			ok: false,
			reason: "prepare failed for https://***@example.invalid/new.git",
		});
		expect(JSON.stringify(changed)).not.toContain("prepare-token");
		expect(JSON.stringify(changed)).not.toContain("formatter-token");
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(h.engines[1].noteWrites).toBe(1);
		expect(runtime.engine).toBe(h.engines[1]);
	});

	it("operation 失败且 formatter 抛错时仍恢复一次，公开 outcome 不泄露原始 rejection", async () => {
		const messages: SyncRuntimeOptions["messages"] = {
			...HARNESS_MESSAGES,
			formatRemoteChangeFailure() {
				throw new Error("formatter failed for https://formatter-token@example.invalid/diagnostic.git");
			},
		};
		const { h, runtime } = await harnessFor({ messages });
		const oldEngine = await prepareOldEngine(h, runtime);
		h.backend.initWarnings = ["baseline warning"];

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000, () => {
			throw new Error("warning callback failed for https://operation-token@example.invalid/new.git");
		});

		expect(changed).toEqual({
			ok: false,
			reason: "warning callback failed for https://***@example.invalid/new.git",
		});
		expect(JSON.stringify(changed)).not.toContain("operation-token");
		expect(JSON.stringify(changed)).not.toContain("formatter-token");
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(h.engines[1].noteWrites).toBe(1);
		expect(runtime.engine).toBe(h.engines[1]);
	});

	it("恢复 noteWrite 自身失败时，错误追加到原失败 reason 且只尝试一次", async () => {
		let created = 0;
		const { h, runtime } = await harnessFor({
			engineSetup(engine) {
				created += 1;
				if (created === 2) {
					engine.noteWriteFailure = new Error("trigger failed for https://s3cr3t-token@example.invalid/x.git");
				}
			},
		});
		await prepareOldEngine(h, runtime);
		h.backend.initFailure = new Error("prepare broke");

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000);

		expect(changed).toEqual({
			ok: false,
			reason:
				"prepare broke\nfailed to restore the sync write trigger: " +
				"trigger failed for https://***@example.invalid/x.git",
		});
		expect(JSON.stringify(changed)).not.toContain("s3cr3t-token");
		expect(h.engines[1].noteWrites).toBe(1);
		expect(runtime.engine).toBe(h.engines[1]);
	});

	it("首次基线 warning 先于 replacement noteWrite", async () => {
		const { h, runtime } = await harnessFor();
		await prepareOldEngine(h, runtime);
		await h.writeEntry("Local.md");
		h.events.length = 0;
		let engineAtWarning: SyncRuntime["engine"] = null;

		const changed = await runtime.changeRemote(NEXT_REMOTE, 1000, (warning) => {
			expect(warning).toContain("1 local entry");
			engineAtWarning = runtime.engine;
			h.events.push("warning");
		});

		expect(changed.ok).toBe(true);
		expect(engineAtWarning).toBe(h.engines[1]);
		expect(h.events.indexOf("warning")).toBeGreaterThanOrEqual(0);
		expect(h.events.indexOf("warning")).toBeLessThan(h.events.indexOf("engine:noteWrite"));
		expect(h.engines[1].noteWrites).toBe(1);
	});
});

describe("flush 与 dispose 边界", () => {
	it("changeRemote 已启动的新基线 writer 会在 dispose drain 内完成，且不恢复 replacement", async () => {
		const writerStarted = deferred();
		const writerGate = deferred();
		const { h, runtime } = await harnessFor({
			manifestWriteHook: async (write, invocation) => {
				if (invocation === 2) {
					writerStarted.resolve(undefined);
					await writerGate.promise;
				}
				await write();
			},
		});
		h.backend.origin = "https://old.example/org/proj.git";
		const oldEngine = await prepareOldEngine(h, runtime);
		h.backend.initRevision = "rev-new-in-flight";

		const changing = runtime.changeRemote(NEXT_REMOTE, 1000);
		void changing.then(() => h.events.push("change:done"));
		await writerStarted.promise;
		// 第二次写入属于 changeRemote 的新空基线，并且在 dispose 之前已经启动。
		expect(h.manifestWrites).toHaveLength(2);
		expect(h.engines).toHaveLength(2);
		const pendingReplacement = h.engines[1];
		expect(runtime.engine).toBeNull();

		let drainSettled = false;
		const draining = runtime.dispose();
		void draining.then(() => {
			drainSettled = true;
			h.events.push("dispose:done");
		});
		expect(runtime.engine).toBeNull();
		expect(pendingReplacement.disposeCalls).toBe(1);
		await sleep(0);
		expect(drainSettled).toBe(false);

		writerGate.resolve(undefined);
		expect(await changing).toEqual({ ok: false, reason: DISPOSED_REASON });
		await draining;

		expect(await h.manifest()).toEqual({
			version: 2,
			transport: syncTransport(NEXT_REMOTE, "main"),
			base: { revision: "rev-new-in-flight", syncedAt: "2026-11-15T08:00:00.000Z" },
			files: {},
		});
		const secondWriteDone = h.events.indexOf("manifest:write:done", h.events.indexOf("manifest:write:done") + 1);
		expect(secondWriteDone).toBeGreaterThanOrEqual(0);
		expect(secondWriteDone).toBeLessThan(h.events.indexOf("dispose:done"));
		expect(h.events.indexOf("change:done")).toBeLessThan(h.events.indexOf("dispose:done"));
		expect(runtime.engine).toBeNull();
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(pendingReplacement.noteWrites).toBe(0);

		// changeRemote 与 prepare 都已排空；后续公开调用和写触发不会再启动 writer/backend/engine I/O。
		const eventsAfterDrain = [...h.events];
		runtime.noteWrite();
		expect(await runtime.prepare(1000)).toEqual({ ok: false, reason: DISPOSED_REASON });
		expect(await runtime.changeRemote("https://after-dispose.example/org/proj.git", 1000)).toEqual({
			ok: false,
			reason: DISPOSED_REASON,
		});
		await sleep(0);
		expect(h.events).toEqual(eventsAfterDrain);
		expect(h.manifestWrites).toHaveLength(2);
		expect(h.engines).toHaveLength(2);
		expect(oldEngine.noteWrites).toBe(0);
		expect(pendingReplacement.noteWrites).toBe(0);
	});

	it("engine.flush rejection 保持 rejection 形状，但重新抛出的文本不泄露 URL 凭据", async () => {
		const { runtime } = await harnessFor({
			engineSetup(engine) {
				engine.flushFailure = new Error("flush failed for https://s3cr3t-token@example.invalid/org/proj.git");
			},
		});
		const prepared = await runtime.prepare(1000);
		expect(prepared.ok).toBe(true);

		const rejection = await runtime.flush(700).then(
			() => null,
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("flush failed for https://***@example.invalid/org/proj.git");
		expect(String(rejection)).not.toContain("s3cr3t-token");
	});

	it.each(["concurrent", "serial"] as const)(
		"%s dispose 幂等并 drain 活动/prepare/tail/旧自动轮，且从不 flush",
		async (scheduling) => {
			const { h, runtime } = await harnessFor({ scheduling });
			const oldEngine = await prepareOldEngine(h, runtime);
			const statusGate = deferred();
			const statusStarted = deferred();
			const automaticGate = deferred();
			const remoteGate = deferred();
			const remoteStarted = deferred();
			oldEngine.statusBarrier = statusGate;
			oldEngine.statusStarted = statusStarted;
			oldEngine.inFlight = automaticGate.promise;
			h.backend.getRemoteBarrier = remoteGate;
			h.backend.getRemoteStarted = remoteStarted;

			const activeStatus = runtime.status(1000);
			await statusStarted.promise;
			const pendingRun = runtime.run("push", 1000);
			const preparing = runtime.prepare(1000);
			await remoteStarted.promise;
			let drainSettled = false;
			const draining = runtime.dispose();
			void draining.then(() => {
				drainSettled = true;
			});
			const sameFlight = runtime.dispose() === draining;
			const immediate = {
				engine: runtime.engine,
				disposeCalls: oldEngine.disposeCalls,
				flushCalls: oldEngine.flushTimeouts.length,
			};
			await sleep(0);
			const settledBeforeRelease = drainSettled;

			remoteGate.resolve(undefined);
			statusGate.resolve(undefined);
			automaticGate.resolve(undefined);
			const [statusResult, runResult, prepareResult] = await Promise.all([activeStatus, pendingRun, preparing]);
			await draining;

			expect(sameFlight).toBe(true);
			expect(immediate).toEqual({ engine: null, disposeCalls: 1, flushCalls: 0 });
			expect(settledBeforeRelease).toBe(false);
			expect(statusResult).toEqual({ ok: false, reason: DISPOSED_REASON });
			expect(runResult).toEqual({ ok: false, reason: DISPOSED_REASON });
			expect(prepareResult).toEqual({ ok: false, reason: DISPOSED_REASON });
			expect(oldEngine.pushTimeouts).toEqual([]);
			expect(oldEngine.flushTimeouts).toEqual([]);
			expect(oldEngine.disposeCalls).toBe(1);
			expect(h.manifestWrites).toHaveLength(1);
		},
	);
});
