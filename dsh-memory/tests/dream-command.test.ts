import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, DREAM_ACTIONS, MemoryStore, mergeConfig } from "@yandy0725/memory-core";
import type { HeadlessAgentPort, HeadlessRunRequest, MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDreamCommand } from "../src/commands.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";

/**
 * `/dream` 的测试：命令是「用户显式触发」的入口，所以它的失败**必须**说得出原因
 *（core 的 dream 描述符对任何非 completed 结果都抛错 —— 静默成功等于骗人）。
 *
 * 与 pi 的两处刻意差异（没有确认框、不 await 整轮）也在这里钉住。
 */

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-dream-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeConfig(over: unknown = {}): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), {
		memoryDir: join(dir, "mem"),
		...(over as object),
	});
}

function makeRuntime(cfg: MemoryConfig, over: Partial<SessionMemoryRuntime> = {}): SessionMemoryRuntime {
	return {
		sessionId: "s1",
		cwd: dir,
		config: cfg,
		store: new MemoryStore({
			memoryDir: cfg.memoryDir,
			indexMaxLines: cfg.memIndexMaxLines,
			indexMaxBytes: cfg.memIndexMaxBytes,
			lock: cfg.lock,
		}),
		memoryDir: cfg.memoryDir,
		error: null,
		surfacing: { available: false, reason: "off" },
		...over,
	};
}

function makeDeps(rt: SessionMemoryRuntime | undefined) {
	const requests: HeadlessRunRequest[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	let outcome: Awaited<ReturnType<HeadlessAgentPort["run"]>> = { status: "completed", text: "merged 2, removed 1" };
	const headless: HeadlessAgentPort = {
		async run(req) {
			requests.push(req);
			return outcome;
		},
	};
	return {
		requests,
		warnings,
		infos,
		setOutcome(next: typeof outcome) {
			outcome = next;
		},
		deps: {
			registry: { get: (sessionId: string) => (rt !== undefined && rt.sessionId === sessionId ? rt : undefined) },
			headlessFor: () => headless,
			warn: (message: string, ...params: unknown[]) => warnings.push([message, ...params].join(" ")),
			info: (message: string, ...params: unknown[]) => infos.push([message, ...params].join(" ")),
		},
	};
}

const inv = () => ({ agent: { session: { id: "s1" } }, rawInput: "", signal: new AbortController().signal });

describe("/dream — 发起前的门禁", () => {
	it("reports the missing runtime instead of pretending to start", async () => {
		const { requests, deps } = makeDeps(undefined);
		const result = await createDreamCommand(deps).handler(inv());

		expect(result.kind).toBe("error");
		expect(result.text).toContain("no memory runtime");
		expect(requests).toEqual([]);
	});

	it("reports a broken memory layer", async () => {
		const rt = makeRuntime(makeConfig(), { store: null, memoryDir: null, error: "no writable dir" });
		const { requests, deps } = makeDeps(rt);
		const result = await createDreamCommand(deps).handler(inv());

		expect(result.kind).toBe("error");
		expect(result.text).toContain("no writable dir");
		expect(requests).toEqual([]);
	});

	it("names the config key when dream has no model", async () => {
		// core 的 `requiredModel` 用的是 pi 词汇（"set dream.model … in memory.json"），所以 dsh 自己
		// 报这条错：提到 memory.json 会把用户引到一个 dsh 根本不读的文件上。
		const rt = makeRuntime(makeConfig());
		const { requests, deps } = makeDeps(rt);
		const result = await createDreamCommand(deps).handler(inv());

		expect(result.kind).toBe("error");
		expect(result.text).toContain("dream.model");
		expect(result.text).not.toContain("memory.json");
		expect(requests).toEqual([]);
	});

	it("rejects a model ref that is not provider/model", async () => {
		const rt = makeRuntime(makeConfig({ dream: { model: "deepseek-flash" } }));
		const { requests, deps } = makeDeps(rt);
		const result = await createDreamCommand(deps).handler(inv());

		expect(result.kind).toBe("error");
		expect(result.text).toContain("<provider>/<model>");
		expect(requests).toEqual([]);
	});
});

describe("/dream — 发起之后", () => {
	it("returns immediately with a start message and runs the 7-action tool set in the background", async () => {
		const rt = makeRuntime(makeConfig({ dream: { model: "prov/dream", thinkLevel: "high" } }));
		const { requests, infos, deps } = makeDeps(rt);

		const result = await createDreamCommand(deps).handler(inv());

		// dsh 的命令没有确认通道，也没有状态行：立刻返回「已开始」，摘要在宿主日志里。
		expect(result.kind).toBe("success");
		expect(result.text).toContain("Dream started");
		// 命令自身不 await 整轮（dream 的 timeout 是 600s）。
		expect(infos).toEqual([]);

		// dream 拿到逻辑锁后还要拍一次全目录快照（fs 工作），所以用 waitFor 等它真的进到端口。
		await vi.waitFor(() => expect(requests).toHaveLength(1));

		const [request] = requests;
		expect(request.model).toBe("prov/dream");
		expect(request.effort).toBe("high");
		expect(request.cwd).toBe(rt.memoryDir);
		// dream 持有逻辑锁且进入时已拍过整目录快照，所以内部原语两个 skip 都开（由 core 计划决定）。
		expect(request.memoryTool?.actions).toEqual(DREAM_ACTIONS);
		expect(request.memoryTool?.skipLogicalLock).toBe(true);
		expect(request.memoryTool?.skipSnapshot).toBe(true);
		// 摘要在完成时写进宿主日志。
		await vi.waitFor(() => expect(infos.join("\n")).toContain("merged 2, removed 1"));
	});

	it("logs a readable failure when the round did not complete", async () => {
		const rt = makeRuntime(makeConfig({ dream: { model: "prov/dream" } }));
		const { warnings, infos, deps, setOutcome } = makeDeps(rt);
		setOutcome({ status: "not-run", cause: "host-refused", detail: "MODEL_UNAVAILABLE: no such model" });

		await createDreamCommand(deps).handler(inv());

		await vi.waitFor(() => expect(warnings.join("\n")).toContain("dream failed"));

		expect(infos).toEqual([]);
		const logged = warnings.join("\n");
		expect(logged).toContain("dream failed");
		// core 的 dream 描述符把 `not-run` 的 cause/detail 变成错误文案：用户能看到真实原因。
		expect(logged).toContain("MODEL_UNAVAILABLE: no such model");
	});
});

describe("/dream — 命令元数据", () => {
	it("omits `input` entirely, because the host rejects an empty hint", () => {
		// 这是一条**真机回归**：曾经写成 `input: { hint: "" }`，宿主的 `normalizeDefinition` 直接抛错，
		// 于是 `apply` 抛错 → cordis 回滚整个 bundle（索引段、/memory、memory 工具全消失，模型只能
		// 去写 AGENTS.md）。`/dream` 不收参数，就不该给 `input`。
		const command = createDreamCommand(makeDeps(undefined).deps);
		expect(command.name).toBe("dream");
		expect(command.input).toBeUndefined();
		expect(command.description.length).toBeGreaterThan(0);
		expect(typeof command.handler).toBe("function");
	});
});
