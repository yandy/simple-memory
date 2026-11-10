import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG, mergeConfig, projectDirName } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../src/row-config.js";
import type { ModuleAvailability } from "../src/model.js";
import { createStoreRegistry, isRootAgent } from "../src/store-registry.js";
import type { AgentLike, HostDirLike } from "../src/store-registry.js";
import { createFakeCtx } from "./helpers/fake-ctx.js";

const execFileP = promisify(execFile);

/** 测试级的临时目录总根：所有子目录都建在它下面，`afterEach` 一次 `rm -rf` 全清。 */
let dir: string;
let emptyGitConfig: string;

beforeEach(async () => {
	// 与 memory-core/tests/paths.test.ts 同一套 hermetic git 手法：绝不读机器的 global/system config。
	dir = await mkdtemp(join(tmpdir(), "am-sr-"));
	emptyGitConfig = join(dir, "gitconfig-empty");
	await writeFile(emptyGitConfig, "", "utf8");
	vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
	await execFileP("git", args, { cwd });
}

async function initRepo(cwd: string, remote?: string): Promise<void> {
	await git(["init", "-q"], cwd);
	if (remote) await git(["remote", "add", "origin", remote], cwd);
}

/** 从不污染 DEFAULT_CONFIG 的副本派生一份合法的 MemoryConfig，只覆盖 memoryDir。 */
function makeConfig(memoryDir: string): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir });
}

function makeResolved(memoryDir: string): ResolvedConfig {
	return { config: makeConfig(memoryDir), warnings: [], error: null };
}

const SURFACING: ModuleAvailability = { available: true, reason: null };

/** 用 fake ctx 的 workingDirectory 当 HostDirLike：走真实 seam（ensure/get 都按 agent 解析 cwd）。 */
function registryWithFakeDirs() {
	const { ctx, makeAgent } = createFakeCtx();
	const registry = createStoreRegistry(ctx.workingDirectory);
	return { registry, makeAgent };
}

describe("createStoreRegistry", () => {
	it("resolves a git checkout to <root>/git/<project> and a plain dir to <root>/local/<escaped>", async () => {
		const root = join(dir, "mem-root");
		const { registry, makeAgent } = registryWithFakeDirs();

		const repo = join(dir, "repo");
		await mkdir(repo);
		await initRepo(repo, "https://github.com/yandy/pi-packages.git");
		const gitRt = await registry.prepare(makeAgent({ cwd: repo }), makeResolved(root), SURFACING);
		expect(gitRt.error).toBeNull();
		expect(gitRt.store).not.toBeNull();
		expect(gitRt.memoryDir).toBe(join(resolve(root), "git", "github.com__yandy__pi-packages"));

		const plain = join(dir, "plain");
		await mkdir(plain);
		const plainRt = await registry.prepare(makeAgent({ cwd: plain }), makeResolved(root), SURFACING);
		expect(plainRt.error).toBeNull();
		expect(plainRt.memoryDir).toBe(join(resolve(root), "local", projectDirName(resolve(plain))));
	});

	it("writes two agents in different cwds into separate memory directories", async () => {
		const root = join(dir, "mem-root");
		const { registry, makeAgent } = registryWithFakeDirs();
		const a = join(dir, "proj-a");
		const b = join(dir, "proj-b");
		await mkdir(a);
		await mkdir(b);

		const rtA = await registry.prepare(makeAgent({ cwd: a }), makeResolved(root), SURFACING);
		const rtB = await registry.prepare(makeAgent({ cwd: b }), makeResolved(root), SURFACING);

		expect(rtA.memoryDir).not.toBe(rtB.memoryDir);
		expect(registry.storeCount()).toBe(2);

		const storeA = rtA.store;
		const storeB = rtB.store;
		expect(storeA).not.toBeNull();
		expect(storeB).not.toBeNull();
		if (!storeA || !storeB) return;

		await storeA.addEntry({ name: "alpha", body: "from A" });
		expect((await storeA.listEntries()).map((e) => e.name)).toEqual(["alpha"]);
		expect(await storeB.listEntries()).toEqual([]);
	});

	it("shares one store instance across two sessions in the same cwd", async () => {
		const root = join(dir, "mem-root");
		const { registry, makeAgent } = registryWithFakeDirs();
		const cwd = join(dir, "shared");
		await mkdir(cwd);

		const rt1 = await registry.prepare(makeAgent({ cwd, id: "s1" }), makeResolved(root), SURFACING);
		const rt2 = await registry.prepare(makeAgent({ cwd, id: "s2" }), makeResolved(root), SURFACING);

		expect(rt1.memoryDir).toBe(rt2.memoryDir);
		expect(registry.storeCount()).toBe(1);
		expect(rt1.store).toBe(rt2.store);
		expect(rt1.store).not.toBeNull();

		// 索引是模块存在的理由：消费方同步读 get(sessionId)，而不是拿 prepare 返回的对象。
		expect(registry.get("s1")).toBe(rt1);
		expect(registry.get("s2")?.store).toBe(rt1.store);
		expect(registry.get("nope")).toBeUndefined();
	});

	it("returns a null-store runtime and never calls dirs.ensure when the config is already in error", async () => {
		const ensure = vi.fn<HostDirLike["ensure"]>();
		const dirs: HostDirLike = { ensure, get: () => "/unused" };
		const registry = createStoreRegistry(dirs);

		const resolved: ResolvedConfig = {
			config: makeConfig("/tmp/unused-root"),
			warnings: [],
			error: "row config is broken",
		};
		const agent: AgentLike = { session: { id: "s1", header: { cwd: "/tmp/x" } } };

		const rt = await registry.prepare(agent, resolved, SURFACING);

		expect(ensure).not.toHaveBeenCalled();
		expect(rt.store).toBeNull();
		expect(rt.memoryDir).toBeNull();
		expect(rt.error).toContain("row config is broken");
	});

	it("falls back to agent.session.header.cwd when dirs.ensure rejects", async () => {
		const root = join(dir, "mem-root");
		const cwd = join(dir, "fallback");
		await mkdir(cwd);

		const ensure = vi.fn<HostDirLike["ensure"]>().mockRejectedValue(new Error("ensure boom"));
		const dirs: HostDirLike = { ensure, get: () => "/unused" };
		const registry = createStoreRegistry(dirs);

		const agent: AgentLike = { session: { id: "s1", header: { cwd } } };
		const rt = await registry.prepare(agent, makeResolved(root), SURFACING);

		expect(rt.error).toBeNull();
		expect(rt.cwd).toBe(cwd);
		expect(rt.memoryDir).toBe(join(resolve(root), "local", projectDirName(resolve(cwd))));
		expect(rt.store).not.toBeNull();
	});

	it("returns a null-store runtime without throwing when neither cwd source is available", async () => {
		const ensure = vi.fn<HostDirLike["ensure"]>().mockRejectedValue(new Error("ensure boom"));
		const dirs: HostDirLike = { ensure, get: () => "/unused" };
		const registry = createStoreRegistry(dirs);

		const agent: AgentLike = { session: { id: "s1", header: {} } };
		const rt = await registry.prepare(agent, makeResolved("/tmp/unused-root"), SURFACING);

		expect(rt.store).toBeNull();
		expect(rt.memoryDir).toBeNull();
		expect(rt.error).not.toBeNull();
		expect(rt.error).toContain("Failed to resolve the working directory for session s1: ");
		expect(rt.error).toContain("ensure boom");

		// 失败路径也必须进索引：消费方拿到的是这个 failed runtime，而不是 undefined。
		expect(registry.get("s1")).toBe(rt);
		expect(registry.get("s1")?.store).toBeNull();
	});

	it("returns a null-store runtime when resolveMemoryDir rejects on a non-string memoryDir", async () => {
		const root = join(dir, "mem-root");
		const { registry, makeAgent } = registryWithFakeDirs();
		const cwd = join(dir, "plain");
		await mkdir(cwd);

		// node:path resolve() 对非字符串 memoryDir 抛 ERR_INVALID_ARG_TYPE，真实触发 resolveMemoryDir
		// 的 reject 分支（不 mock core）。git probe 对普通临时目录先返回 { kind: "local" }，不会吞掉它。
		const resolved: ResolvedConfig = {
			config: { ...makeConfig(root), memoryDir: 123 as unknown as string },
			warnings: [],
			error: null,
		};

		const rt = await registry.prepare(makeAgent({ cwd, id: "s1" }), resolved, SURFACING);

		expect(rt.store).toBeNull();
		expect(rt.memoryDir).toBeNull();
		expect(rt.error).not.toBeNull();
		expect(rt.error).toContain("Failed to resolve memory directory: ");
	});

	it("treats a blank ensure rejection message as no cwd, yielding a non-empty error", async () => {
		const ensure = vi.fn<HostDirLike["ensure"]>().mockRejectedValue(new Error(""));
		const dirs: HostDirLike = { ensure, get: () => "/unused" };
		const registry = createStoreRegistry(dirs);

		const agent: AgentLike = { session: { id: "s1", header: {} } };
		const rt = await registry.prepare(agent, makeResolved("/tmp/unused-root"), SURFACING);

		expect(rt.store).toBeNull();
		expect(rt.memoryDir).toBeNull();
		expect(rt.error).not.toBeNull();
		expect(rt.error).not.toBe("");
		expect(rt.error).toContain("no working directory available");
	});

	it("treats a blank resolved.error as no error and proceeds to resolve the directory", async () => {
		const root = join(dir, "mem-root");
		const { registry, makeAgent } = registryWithFakeDirs();
		const cwd = join(dir, "plain");
		await mkdir(cwd);

		const resolved: ResolvedConfig = { config: makeConfig(root), warnings: [], error: "" };

		const rt = await registry.prepare(makeAgent({ cwd, id: "s1" }), resolved, SURFACING);

		expect(rt.error).toBeNull();
		expect(rt.store).not.toBeNull();
		expect(rt.memoryDir).toBe(join(resolve(root), "local", projectDirName(resolve(cwd))));
	});

	it("forgets per-session and drops the shared store only when the last reference goes away", async () => {
		const root = join(dir, "mem-root");
		const { registry, makeAgent } = registryWithFakeDirs();
		const cwd = join(dir, "shared");
		await mkdir(cwd);

		await registry.prepare(makeAgent({ cwd, id: "s1" }), makeResolved(root), SURFACING);
		await registry.prepare(makeAgent({ cwd, id: "s2" }), makeResolved(root), SURFACING);
		expect(registry.storeCount()).toBe(1);

		registry.forget("s1");
		expect(registry.get("s1")).toBeUndefined();
		expect(registry.storeCount()).toBe(1);

		// 幂等：忘记一个未知/已忘记的 session 不得腐蚀引用计数。
		registry.forget("s1");
		expect(registry.storeCount()).toBe(1);

		registry.forget("s2");
		expect(registry.get("s2")).toBeUndefined();
		expect(registry.storeCount()).toBe(0);

		registry.forget("s2");
		expect(registry.storeCount()).toBe(0);
	});
});

describe("isRootAgent", () => {
	it("treats a header with no delegation fields as root", () => {
		expect(isRootAgent({ session: { header: {} } })).toBe(true);
	});

	it("classifies origin: subagent as not root", () => {
		expect(isRootAgent({ session: { header: { origin: "subagent" } } })).toBe(false);
	});

	it("classifies a positive delegationDepth without origin as not root", () => {
		expect(isRootAgent({ session: { header: { delegationDepth: 1 } } })).toBe(false);
	});

	it("keeps a fork with parentSession but no origin as root", () => {
		// 宿主文档明文：parentSession 的存在本身不能用来判定子 agent，普通 fork 也可能带它。
		expect(isRootAgent({ session: { header: { parentSession: "session-parent" } } })).toBe(true);
	});
});
