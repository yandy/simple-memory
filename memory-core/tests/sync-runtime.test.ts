import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FLUSH_ROUND,
	HARNESS_MESSAGES,
	PULL_ROUND,
	PUSH_ROUND,
	STATUS_REPORT,
	createSyncRuntimeHarness,
	deferred,
	mustRuntime,
	type HarnessOptions,
	type HarnessResult,
	type SyncRuntimeHarness,
} from "./helpers/sync-runtime.js";
import { emptyManifest, manifestPath, sameSyncRemote, syncTransport, writeManifest } from "../src/index.js";
import type { SyncEngine, SyncPrepareResult, SyncRuntime } from "../src/index.js";

/**
 * SyncRuntime 的装配、prepare 与基本轮次。
 *
 * 夹具是真盘 + 真 store + 真 device/manifest，只把 backend / engine 两个协调端口换成可记录、
 * 可挂屏障的假实现 —— 被测的 runtime 一行都没有被替换。
 *
 * 每条用例都能说出它抓的 bug：门禁顺序错、device 早建、基线绑了配置 remote 而不是实际 origin、
 * prepare 没 single-flight、dispose 之后还晚写、启动预算没共享、手动轮次被扣预算、
 * status 偷偷 prepare、flush 在没 engine 时去建 engine。
 */

const harnesses: SyncRuntimeHarness[] = [];

/** 装配一份 harness 并跑一次工厂；`runtime` 走 `mustRuntime` 收窄（门禁用例直接调 `create()`）。 */
async function harnessFor(over?: HarnessOptions): Promise<{ h: SyncRuntimeHarness; result: HarnessResult; runtime: SyncRuntime }> {
	const h = await createSyncRuntimeHarness();
	harnesses.push(h);
	const result = await h.create(over);
	return { h, result, runtime: mustRuntime(result) };
}

function mustEngine(prepared: SyncPrepareResult): SyncEngine {
	if (!prepared.ok) throw new Error(`expected a prepared engine, got: ${prepared.reason}`);
	return prepared.engine;
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.cleanup();
});

describe("装配与门禁", () => {
	it("disabled：不装配 backend，也不创建 .sync", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		const result = await h.create({ config: { enabled: false } });

		expect(result.runtime).toBeNull();
		expect(result.errors).toEqual([]);
		expect(result.notices).toEqual([]);
		// createBackend 都没被调用：关掉的同步连「本机有没有 .sync」都不该去看
		expect(h.backendContexts).toEqual([]);
		expect(h.backend.readyCalls).toBe(0);
		expect(existsSync(h.syncRoot)).toBe(false);
	});

	it("非 git 项目：降级成预告，不装配 backend、不创建 .sync", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		const result = await h.create({ identity: { kind: "local", key: "/tmp/some-project" } });

		expect(result.runtime).toBeNull();
		expect(result.notices).toEqual(["Memory sync v1 only supports git projects; sync is disabled for this session."]);
		// 降级不是故障：走预告通道，error 通道空着（宿主不该把它渲染成红色）
		expect(result.errors).toEqual([]);
		expect(h.backendContexts).toEqual([]);
		expect(existsSync(h.syncRoot)).toBe(false);
	});

	it("非法配置：返回配置错误，且不 init、不建 device、不写 manifest", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		const result = await h.create({ config: { enabled: true, remote: "" } });

		expect(result.runtime).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('"sync.remote"');
		expect(h.events).not.toContain("backend:init");
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestExists()).toBe(false);
	});

	it("已初始化 + 配置 remote 为空是合法状态", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		h.backend.initialized = true;
		h.backend.origin = "https://origin.example/org/proj.git";

		const result = await h.create({ config: { remote: "" } });

		// 初始化之后 origin 是真相来源，配置里留空不该被当成「没配置」
		expect(result.runtime).not.toBeNull();
		expect(result.errors).toEqual([]);
		expect(result.notices).toEqual([]);
	});

	it("origin 漂移用宿主注入的 messages.originDrift，而不是 core 自带的文案", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		h.backend.initialized = true;
		h.backend.origin = "https://origin.example/org/proj.git";
		const driftHint = "SYNC_DRIFT_HINT_FROM_THE_HOST";

		const result = await h.create({
			messages: { ...HARNESS_MESSAGES, originDrift: driftHint },
			config: { remote: "https://configured.example/org/proj.git" },
		});

		expect(result.runtime).not.toBeNull();
		expect(result.errors).toEqual([driftHint]);
		// 前提：这两者确实不同（否则上面那条断言会因为「没有漂移」而空转）
		expect(
			sameSyncRemote("https://configured.example/org/proj.git", "https://origin.example/org/proj.git"),
		).toBe(false);
	});

	it("createBackend 收到派生出的 syncRoot 与配置里的 remote/branch", async () => {
		const { h } = await harnessFor();
		expect(h.backendContexts).toEqual([
			{
				syncRoot: h.syncRoot,
				memoryRoot: h.memoryRoot,
				remote: "https://git.example.invalid/org/proj.git",
				branch: "main",
			},
		]);
	});
});

describe("runtime 逃逸的错误文本", () => {
	it("prepare 失败 reason 经 core 脱敏：URL 里的 token 不会进宿主日志", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		const runtime = mustRuntime(await h.create());
		h.backend.initFailure = new Error("clone failed for https://s3cr3t-token@example.invalid/org/proj.git");

		const prepared = await runtime.prepare(1000);

		expect(prepared).toEqual({
			ok: false,
			reason: "clone failed for https://***@example.invalid/org/proj.git",
		});
		expect(JSON.stringify(prepared)).not.toContain("s3cr3t-token");
	});

	it("engine.push 拒绝：startup 返回脱敏的失败 outcome，不 reject 调用方", async () => {
		const { h, runtime } = await harnessFor({
			config: { autoTimeoutMs: 2000, pullOnStart: true },
			engineSetup: (engine) => {
				engine.pushFailure = new Error("push failed for https://s3cr3t-token@example.invalid/org/proj.git");
			},
		});

		const outcome = await runtime.startup();

		// 引擎/后端的异常是 runtime 的出口责任：必须变成失败 outcome，而不是把裸 rejection 抛给宿主
		expect(outcome).toEqual({
			ok: false,
			reason: "push failed for https://***@example.invalid/org/proj.git",
		});
		expect(JSON.stringify(outcome)).not.toContain("s3cr3t-token");
		expect(h.engines[0].pushTimeouts).toHaveLength(1);
	});

	it("engine.pull 拒绝：手动 run 返回脱敏的失败 outcome", async () => {
		const { runtime } = await harnessFor({
			config: { timeoutMs: 1000 },
			engineSetup: (engine) => {
				engine.pullFailure = new Error("fetch failed for https://s3cr3t-token@example.invalid/org/proj.git");
			},
		});

		const outcome = await runtime.run("pull", 1000);

		expect(outcome).toEqual({ ok: false, reason: "fetch failed for https://***@example.invalid/org/proj.git" });
		expect(JSON.stringify(outcome)).not.toContain("s3cr3t-token");
	});

	it("engine.push 拒绝：手动 run 返回脱敏的失败 outcome", async () => {
		const { runtime } = await harnessFor({
			config: { timeoutMs: 1000 },
			engineSetup: (engine) => {
				engine.pushFailure = new Error("publish failed for https://s3cr3t-token@example.invalid/org/proj.git");
			},
		});

		const outcome = await runtime.run("push", 1000);

		expect(outcome).toEqual({ ok: false, reason: "publish failed for https://***@example.invalid/org/proj.git" });
		expect(JSON.stringify(outcome)).not.toContain("s3cr3t-token");
	});
});

describe("prepare 与懒 engine", () => {
	it("装配完成但未准备：engine 为 null、device 与 manifest 都还不存在", async () => {
		const { h, runtime } = await harnessFor();

		expect(runtime.engine).toBeNull();
		expect(h.engineOptions).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestExists()).toBe(false);
	});

	it("非有限正预算：直接拒绝，不 init、不建 device", async () => {
		const { h, runtime } = await harnessFor();

		expect(await runtime.prepare(0)).toEqual({
			ok: false,
			reason: "sync initialization requires a finite positive timeout budget",
		});
		expect(await runtime.prepare(Number.POSITIVE_INFINITY)).toEqual({
			ok: false,
			reason: "sync initialization requires a finite positive timeout budget",
		});
		// 0 与 Infinity 传到子进程 timeout / 定时器上都是「无限等」，必须在发 I/O 之前拦掉
		expect(h.backend.initTimeouts).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestWrites).toEqual([]);
	});

	it("首次 prepare：一次 init、v2 空基线绑定实际 origin 与 init revision", async () => {
		const { h, runtime } = await harnessFor();
		h.backend.initRevision = "rev-initial";
		// 实际 origin 与配置里的 remote 不同：基线必须绑实际那一个
		h.backend.origin = "https://actual.example/org/proj.git";

		const prepared = await runtime.prepare(1500);

		expect(prepared).toMatchObject({ ok: true });
		expect(h.backend.initTimeouts).toEqual([1500]);
		expect(h.manifestWrites).toHaveLength(1);
		expect(h.manifestWrites[0].path).toBe(manifestPath(h.syncRoot, h.projectKey));
		expect(await h.manifest()).toEqual({
			version: 2,
			transport: syncTransport("https://actual.example/org/proj.git", "main"),
			base: { revision: "rev-initial", syncedAt: "2026-11-15T08:00:00.000Z" },
			files: {},
		});
		// 绑的是实际 origin，不是配置值：拿配置值写进去的基线下一次就会被判成 transport mismatch
		expect((await h.manifest())?.transport).not.toEqual(
			syncTransport("https://git.example.invalid/org/proj.git", "main"),
		);
		expect(h.deviceCreated()).toBe(true);
		expect(runtime.engine).toBe(mustEngine(prepared));
	});

	it("第二次 prepare 走快路径：不重复 init、engine 同一实例、不重写基线", async () => {
		const { h, runtime } = await harnessFor();
		h.backend.initRevision = "rev-initial";
		h.backend.origin = "https://actual.example/org/proj.git";

		const first = await runtime.prepare(1500);
		const second = await runtime.prepare(1500);

		expect(h.backend.initTimeouts).toHaveLength(1);
		expect(h.manifestWrites).toHaveLength(1);
		expect(h.engines).toHaveLength(1);
		expect(mustEngine(second)).toBe(mustEngine(first));
	});

	it("transport mismatch：重新 init 并重建空基线，engine 仍复用", async () => {
		const { h, runtime } = await harnessFor();
		h.backend.initRevision = "rev-first";
		h.backend.origin = "https://first.example/org/proj.git";
		const first = await runtime.prepare(1000);

		// 本地 origin 被换到了别处（配置没变，manifest 的 transport 因此不再匹配）
		h.backend.origin = "https://second.example/org/proj.git";
		h.backend.initRevision = "rev-second";
		const second = await runtime.prepare(1000);

		expect(second).toMatchObject({ ok: true });
		expect(h.backend.initTimeouts).toEqual([1000, 1000]);
		expect(h.manifestWrites).toHaveLength(2);
		expect(await h.manifest()).toEqual({
			version: 2,
			transport: syncTransport("https://second.example/org/proj.git", "main"),
			base: { revision: "rev-second", syncedAt: "2026-11-15T08:00:00.000Z" },
			files: {},
		});
		expect(mustEngine(second)).toBe(mustEngine(first));
	});

	it("并发 prepare 共用一个 init flight", async () => {
		const { h, runtime } = await harnessFor();
		const gate = deferred();
		h.backend.initBarrier = gate;
		h.backend.initRevision = "rev-initial";

		const first = runtime.prepare(1200);
		const second = runtime.prepare(1200);
		gate.resolve(undefined);
		const [a, b] = await Promise.all([first, second]);

		expect(h.backend.initTimeouts).toEqual([1200]);
		expect(h.manifestWrites).toHaveLength(1);
		expect(h.engines).toHaveLength(1);
		expect(mustEngine(a)).toBe(mustEngine(b));
	});

	it("基线写入前 dispose：真实 origin 已读到也不写 manifest", async () => {
		const { h, runtime } = await harnessFor();
		const started = deferred();
		const gate = deferred();
		h.backend.getRemoteStarted = started;
		h.backend.getRemoteBarrier = gate;

		const preparing = runtime.prepare(5000);
		// init 之后的这次 origin 读取正是写基线前的最后一个 await
		await started.promise;
		const draining = runtime.dispose();
		gate.resolve(undefined);
		expect(await preparing).toEqual({ ok: false, reason: "sync runtime is disposed" });
		await draining;

		expect(h.manifestWrites).toEqual([]);
		expect(h.manifestExists()).toBe(false);
		expect(runtime.engine).toBeNull();
	});

	it("ready+manifest 路径的 getRemote 期间 dispose：不建 device、不交付 engine", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		const origin = "https://origin.example/org/proj.git";
		h.backend.initialized = true;
		h.backend.origin = origin;
		// 配置 remote 留空：装配期的 origin 自省因此不发生，屏障留给 prepare 那次读取。
		const runtime = mustRuntime(await h.create({ config: { remote: "" } }));
		// 已有完整且 transport 匹配的基线：prepare 会走「快路径之前」的那次 getRemote。
		const existing = emptyManifest(syncTransport(origin, "main"));
		existing.base = { revision: "rev-existing", syncedAt: "2026-11-15T07:00:00.000Z" };
		await writeManifest(manifestPath(h.syncRoot, h.projectKey), existing);
		const started = deferred();
		const gate = deferred();
		h.backend.getRemoteStarted = started;
		h.backend.getRemoteBarrier = gate;

		const preparing = runtime.prepare(1200);
		await started.promise;
		const draining = runtime.dispose();
		gate.resolve(undefined);
		expect(await preparing).toEqual({ ok: false, reason: "sync runtime is disposed" });
		await draining;

		// 收摊之后就不得再走到 buildEngine：迟到的 device.json 比一次失败更难收拾
		expect(h.deviceCreated()).toBe(false);
		expect(h.engineOptions).toEqual([]);
		expect(h.engines).toEqual([]);
		expect(runtime.engine).toBeNull();
		expect(h.backend.initTimeouts).toEqual([]);
	});

	it("init 途中 dispose：abort、放行后不建 device、不写 manifest、不交付 engine", async () => {
		const { h, runtime } = await harnessFor();
		const started = deferred();
		const gate = deferred();
		h.backend.initStarted = started;
		h.backend.initBarrier = gate;

		const preparing = runtime.prepare(5000);
		await started.promise;
		expect(h.backend.initSignals).toHaveLength(1);
		const signal = h.backend.initSignals[0];
		expect(signal?.aborted).toBe(false);

		const draining = runtime.dispose();
		// dispose 的同步部分立刻关入口并 abort init；drain 才是 promise
		expect(signal?.aborted).toBe(true);

		gate.resolve(undefined);
		expect(await preparing).toEqual({ ok: false, reason: "sync runtime is disposed" });
		await draining;

		expect(runtime.engine).toBeNull();
		expect(h.engineOptions).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestExists()).toBe(false);
		expect(h.manifestWrites).toEqual([]);
		// prepare 用的仍是调用方给的那一份预算，不会被 abort 改写成默认值
		expect(h.backend.initTimeouts).toEqual([5000]);
	});
});

describe("startup 与手动轮次", () => {
	it("startup：prepare 与启动 push 共用一份自动预算，warning 先于 push", async () => {
		const { h, runtime } = await harnessFor({ config: { autoTimeoutMs: 2000, pullOnStart: true } });
		h.backend.readyDelayMs = 60;
		h.backend.initRevision = "rev-initial";
		h.backend.initWarnings = ["remote already had a baseline at https://s3cr3t-token@example.invalid/x.git"];
		await h.writeEntry("Kept-as-new.md");

		const warnings: string[] = [];
		const outcome = await runtime.startup((warning) => {
			warnings.push(warning);
			h.events.push("warning");
		});

		expect(outcome.ok).toBe(true);
		expect(h.backend.initTimeouts).toEqual([2000]);
		const engine = h.engines[0];
		expect(engine.pushTimeouts).toHaveLength(1);
		// 启动 push 拿的是 prepare 之后剩下的那一份预算，不是重新满格的自动档
		expect(engine.pushTimeouts[0]).toBeGreaterThan(0);
		expect(engine.pushTimeouts[0]).toBeLessThanOrEqual(2000 - 60);
		expect(engine.pushTimeouts[0]).toBeLessThan(2000);

		// 首次基线的冲突副本预告必须先到宿主，再跑会产生/发布副本的那一轮
		expect(h.events.indexOf("warning")).toBeGreaterThan(-1);
		expect(h.events.indexOf("warning")).toBeLessThan(h.events.indexOf("engine:push"));
		expect(warnings).toHaveLength(1);
		// backend 交回的 warning 同样要过脱敏：它会原样进宿主的提示通道
		expect(warnings[0]).toContain("remote already had a baseline at https://***@example.invalid/x.git");
		expect(warnings[0]).not.toContain("s3cr3t-token");
		expect(warnings[0]).toContain("1 local entry");
		expect(warnings[0].indexOf("remote already had a baseline")).toBeLessThan(
			warnings[0].indexOf("1 local entry"),
		);
		expect(outcome).toMatchObject({ ok: true, value: PUSH_ROUND, warning: warnings[0] });
	});

	it("pullOnStart:false 的 startup 只 prepare，不跑任何轮次", async () => {
		const { h, runtime } = await harnessFor({ config: { pullOnStart: false, autoTimeoutMs: 1200 } });

		const outcome = await runtime.startup();

		expect(outcome).toEqual({ ok: true, value: null });
		expect(h.backend.initTimeouts).toEqual([1200]);
		expect(h.engines).toHaveLength(1);
		expect(h.engines[0].pushTimeouts).toEqual([]);
		expect(h.engines[0].pullTimeouts).toEqual([]);
	});

	it("启动预算耗尽：成功 + null + 「下一轮再推」warning，不发 1ms 网络轮", async () => {
		const { h, runtime } = await harnessFor({ config: { autoTimeoutMs: 5, pullOnStart: true } });
		h.backend.readyDelayMs = 40;
		h.backend.initRevision = "rev-initial";

		const warnings: string[] = [];
		const outcome = await runtime.startup((warning) => warnings.push(warning));

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.value).toBeNull();
		expect(outcome.warning).toContain("5ms was exhausted during preparation");
		expect(outcome.warning).toContain("startup push was skipped");
		// prepare 没有 warning 时也不该凭空叫一次回调
		expect(warnings).toEqual([]);
		expect(h.engines[0].pushTimeouts).toEqual([]);
	});

	it("手动 run：prepare 与 engine 各自拿完整的手动预算，不套启动 deadline", async () => {
		const { h, runtime } = await harnessFor({ config: { autoTimeoutMs: 200, timeoutMs: 20_000 } });
		h.backend.readyDelayMs = 40;
		h.backend.initRevision = "rev-manual";

		const pushed = await runtime.run("push", 20_000);
		const pulled = await runtime.run("pull", 15_000);

		expect(pushed).toEqual({ ok: true, value: PUSH_ROUND });
		expect(pulled).toEqual({ ok: true, value: PULL_ROUND });
		// prepare 拿的是手动档（不是自己的 autoTimeoutMs）
		expect(h.backend.initTimeouts).toEqual([20_000]);
		// 引擎那一轮拿的是调用方给的上限全款：prepare 用掉的 40ms 不从里面扣
		expect(h.engines[0].pushTimeouts).toEqual([20_000]);
		expect(h.engines[0].pullTimeouts).toEqual([15_000]);
	});

	it("手动 run 的 warning 也先于轮次", async () => {
		const { h, runtime } = await harnessFor({ config: { timeoutMs: 1000 } });
		await h.writeEntry("Kept-as-new.md");

		const warnings: string[] = [];
		const outcome = await runtime.run("push", 1000, (warning) => {
			warnings.push(warning);
			h.events.push("warning");
		});

		expect(outcome).toMatchObject({ ok: true, value: PUSH_ROUND, warning: warnings[0] });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("1 local entry");
		expect(h.events.indexOf("warning")).toBeLessThan(h.events.indexOf("engine:push"));
	});

	it("warning 回调里同步 dispose：startup 不启动轮次，返回 disposed", async () => {
		const { h, runtime } = await harnessFor({ config: { autoTimeoutMs: 2000, pullOnStart: true } });
		h.backend.initWarnings = ["remote already had a baseline"];

		const outcome = await runtime.startup(() => {
			// 宿主在提示回调里收摊是合法时序：此后绝不能再碰那台已 dispose 的引擎
			void runtime.dispose();
		});

		expect(outcome).toEqual({ ok: false, reason: "sync runtime is disposed" });
		expect(h.engines[0].pushTimeouts).toEqual([]);
		expect(h.engines[0].pullTimeouts).toEqual([]);
		expect(h.engines[0].disposeCalls).toBe(1);
	});

	it("warning 回调里同步 dispose：手动 run 不启动轮次，返回 disposed", async () => {
		const { h, runtime } = await harnessFor({ config: { timeoutMs: 1000 } });
		h.backend.initWarnings = ["remote already had a baseline"];

		const outcome = await runtime.run("push", 1000, () => {
			void runtime.dispose();
		});

		expect(outcome).toEqual({ ok: false, reason: "sync runtime is disposed" });
		expect(h.engines[0].pushTimeouts).toEqual([]);
		expect(h.engines[0].disposeCalls).toBe(1);
	});

	it("并发 startup 共享 prepare：先到的那台在 warning 里 dispose，后到的也不开轮", async () => {
		const { h, runtime } = await harnessFor({ config: { autoTimeoutMs: 2000, pullOnStart: true } });
		h.backend.initWarnings = ["remote already had a baseline"];

		// 后到的调用在 prepare 已 settle、自己还没恢复执行时被关闸：这是 await 之后那道守卫的地盘。
		const first = runtime.startup(() => {
			void runtime.dispose();
		});
		const secondWarnings: string[] = [];
		const second = runtime.startup((warning) => secondWarnings.push(warning));

		expect(await first).toEqual({ ok: false, reason: "sync runtime is disposed" });
		expect(await second).toEqual({ ok: false, reason: "sync runtime is disposed" });
		// 后到那台连预告回调都不该再收到，更不能在已收摊的引擎上 push
		expect(secondWarnings).toEqual([]);
		expect(h.engines[0].pushTimeouts).toEqual([]);
		expect(h.engines[0].disposeCalls).toBe(1);
	});

	it("并发 run 共享 prepare：先到的那台在 warning 里 dispose，后到的也不开轮", async () => {
		const { h, runtime } = await harnessFor({ config: { timeoutMs: 1000 } });
		h.backend.initWarnings = ["remote already had a baseline"];

		const first = runtime.run("push", 1000, () => {
			void runtime.dispose();
		});
		const secondWarnings: string[] = [];
		const second = runtime.run("pull", 1000, (warning) => secondWarnings.push(warning));

		expect(await first).toEqual({ ok: false, reason: "sync runtime is disposed" });
		expect(await second).toEqual({ ok: false, reason: "sync runtime is disposed" });
		// 后到那台连预告回调都不该再收到，更不能在已收摊的引擎上 pull
		expect(secondWarnings).toEqual([]);
		expect(h.engines[0].pushTimeouts).toEqual([]);
		expect(h.engines[0].pullTimeouts).toEqual([]);
	});

	it("serial startup：排队等待不计入自动预算，出队之后才起算 deadline", async () => {
		const pushGate = deferred();
		const pushStarted = deferred();
		const { h, runtime } = await harnessFor({
			scheduling: "serial",
			config: { autoTimeoutMs: 2000, pullOnStart: true },
			engineSetup: (engine) => {
				engine.pushStarted = pushStarted;
				engine.pushBarrier = pushGate;
			},
		});
		h.backend.initRevision = "rev-initial";

		// 前序 serial 活动占住 FIFO：startup 只能在 tail 上排队。
		const manual = runtime.run("push", 5000);
		await pushStarted.promise;

		// 只在 Date.now 上做时钟平移：真盘与真定时器都不受影响。
		let clockOffsetMs = 0;
		const realNow = Date.now;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
		try {
			const warnings: string[] = [];
			const startup = runtime.startup((warning) => warnings.push(warning));
			// 排队期间墙上时钟越过 autoTimeoutMs —— 按「公开调用时定 deadline」，出队时预算已是负数。
			clockOffsetMs = 10_000;

			// 出队之前放开前序活动，startup 自己的 push 不再被同一道闸卡住。
			h.engines[0].pushBarrier = null;
			pushGate.resolve(undefined);

			expect(await manual).toEqual({ ok: true, value: PUSH_ROUND });
			const outcome = await startup;

			// 预算在出队时起算：startup 必须真的推送，而不是被判「等待把预算耗尽」。
			expect(warnings).toEqual([]);
			expect(outcome).toEqual({ ok: true, value: PUSH_ROUND });
			expect(h.engines[0].pushTimeouts).toHaveLength(2);
			expect(h.engines[0].pushTimeouts[1]).toBeGreaterThan(0);
			expect(h.engines[0].pushTimeouts[1]).toBeLessThanOrEqual(2000);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("status 与 flush", () => {
	it("未初始化时 status 只读 ready：不 init、不建 device、不写 manifest", async () => {
		const { h, runtime } = await harnessFor();

		const outcome = await runtime.status(900);

		expect(outcome).toEqual({ ok: true, value: { initialized: false, origin: null } });
		expect(h.backend.initTimeouts).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestExists()).toBe(false);
		expect(h.engines).toEqual([]);
	});

	it("已初始化但 engine 未准备时 status 只读 origin", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		h.backend.initialized = true;
		h.backend.origin = "https://origin.example/org/proj.git";
		const runtime = mustRuntime(await h.create());
		h.events.length = 0;

		const outcome = await runtime.status(900);

		expect(outcome).toEqual({
			ok: true,
			value: { initialized: true, origin: "https://origin.example/org/proj.git" },
		});
		// 严格 dry-run：只问 ready 与 origin，绝不 prepare/init/创建设备或写基线
		expect(h.events).toEqual(["backend:ready", "backend:getRemote"]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.manifestExists()).toBe(false);
		expect(h.engines).toEqual([]);
	});

	it("已准备时 status 交给 engine，自己不再读 backend", async () => {
		const { h, runtime } = await harnessFor({ config: { timeoutMs: 1000 } });
		await runtime.prepare(1000);
		const readyCallsBefore = h.backend.readyCalls;

		const outcome = await runtime.status(4321);

		expect(outcome).toEqual({ ok: true, value: STATUS_REPORT });
		expect(h.engines[0].statusTimeouts).toEqual([4321]);
		expect(h.backend.readyCalls).toBe(readyCallsBefore);
	});

	it("ready 之后 dispose：status 不再继续读 origin", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		h.backend.initialized = true;
		h.backend.origin = "https://origin.example/org/proj.git";
		// 配置 remote 留空：装配期不读 origin，事件日志只反映 status 自己的 I/O
		const runtime = mustRuntime(await h.create({ config: { remote: "" } }));
		h.events.length = 0;
		// 让 status 卡在 ready() 里，好在中途收摊
		h.backend.readyDelayMs = 20;

		const pending = runtime.status(900);
		expect(h.events).toEqual(["backend:ready"]);
		const draining = runtime.dispose();

		expect(await pending).toEqual({ ok: false, reason: "sync runtime is disposed" });
		await draining;
		// 关闸之后连一次只读 origin 都不该发生
		expect(h.events).toEqual(["backend:ready"]);
	});

	it("getRemote 期间 dispose：status 返回 disposed，不把迟到 origin 当成功", async () => {
		const h = await createSyncRuntimeHarness();
		harnesses.push(h);
		h.backend.initialized = true;
		h.backend.origin = "https://origin.example/org/proj.git";
		const runtime = mustRuntime(await h.create({ config: { remote: "" } }));
		const started = deferred();
		const gate = deferred();
		h.backend.getRemoteStarted = started;
		h.backend.getRemoteBarrier = gate;

		const pending = runtime.status(900);
		await started.promise;
		const draining = runtime.dispose();
		gate.resolve(undefined);

		expect(await pending).toEqual({ ok: false, reason: "sync runtime is disposed" });
		await draining;
	});

	it("没有 engine 的 flush 返回 null，不建 engine、不联网", async () => {
		const { h, runtime } = await harnessFor();

		expect(await runtime.flush(700)).toBeNull();

		expect(h.engines).toEqual([]);
		expect(h.deviceCreated()).toBe(false);
		expect(h.events.filter((event) => event.startsWith("engine:"))).toEqual([]);
	});

	it("有 engine 的 flush 把 round 原样透传", async () => {
		const { h, runtime } = await harnessFor({ config: { timeoutMs: 1000 } });
		await runtime.prepare(1000);

		expect(await runtime.flush(700)).toEqual(FLUSH_ROUND);
		expect(h.engines[0].flushTimeouts).toEqual([700]);
	});

	it("noteWrite 转发当前 engine；收摊之后不再触碰它", async () => {
		const { h, runtime } = await harnessFor({ config: { timeoutMs: 1000 } });
		// 还没有 engine：静默空转，不装配也不抛错
		runtime.noteWrite();
		expect(h.engines).toEqual([]);

		await runtime.prepare(1000);
		runtime.noteWrite();
		expect(h.engines[0].noteWrites).toBe(1);

		await runtime.dispose();
		// 收摊同步清空公开的 engine，之后任何触发都不再有一台活着的引擎可碰
		expect(runtime.engine).toBeNull();
		runtime.noteWrite();
		expect(h.engines[0].noteWrites).toBe(1);
		expect(h.engines[0].disposeCalls).toBe(1);
	});
});
