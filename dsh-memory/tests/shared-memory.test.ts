import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	mergeConfig,
	parseEntryFile,
	projectDirName,
	resolveMemoryDir,
} from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/index.js";
import { createFakeCtx } from "./helpers/fake-ctx.js";

const execFileP = promisify(execFile);

/**
 * 测试级临时目录总根。记忆根（`root`）、git 项目目录、hermetic git 配置都建在它下面，
 * `afterEach` 一次 `rm -rf` 全清 —— 中途断言失败也不会在机器上留下记忆目录或 git 配置。
 */
let dir: string;
/** 两边的 memoryDir 根（**绝不**用 `defaultMemoryRoot()`：那会写进用户家目录）。 */
let root: string;
/** hermetic git 配置：指向空文件 + 关掉 system 配置，绝不读开发者机器的 git config。 */
let emptyGitConfig: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-shared-"));
	emptyGitConfig = join(dir, "gitconfig-empty");
	await writeFile(emptyGitConfig, "", "utf8");
	vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGitConfig);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	root = join(dir, "mem-root");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
	await execFileP("git", args, { cwd });
}

/** 在 `dir` 下建一个带 origin remote 的 git 目录，让 `resolveMemoryDir` 走 `git/` 分支。 */
async function makeGitRepo(remote: string): Promise<string> {
	const repo = join(dir, "repo");
	await mkdir(repo, { recursive: true });
	await git(["init", "-q"], repo);
	await git(["remote", "add", "origin", remote], repo);
	return repo;
}

/** dsh 的行 config：只覆盖 `memoryDir`，其余走 core 默认值（与 store-registry/assembly 同式）。 */
function rowConfig(): Record<string, unknown> {
	return { memoryDir: root };
}

/** core 对一份目录会用到的 MemoryStore 构造参数（与 dsh 的 store-registry 同一套默认值窗口）。 */
function storeConfig(memoryDir: string) {
	const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir: root });
	return {
		memoryDir,
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	};
}

type Fake = ReturnType<typeof createFakeCtx>;

function sectionText(fake: Fake): (context: unknown) => string {
	expect(fake.sections).toHaveLength(1);
	return fake.sections[0].text as (context: unknown) => string;
}

function memoryToolOf(fake: Fake, agentId: string) {
	return (fake.agentTools.get(agentId) ?? []).find((tool) => tool.name === "memory");
}

describe("shared-memory — 跨宿主共享验证", () => {
	it("pi → dsh: core 写入的 entry，装配后的 dsh 插件在同一个 git 记忆目录里读得到", async () => {
		const repo = await makeGitRepo("https://github.com/example/repo.git");

		// pi 侧：照 pi-memory 的方式解析 memoryDir，再用 core 直接写一条 entry。
		const piDir = await resolveMemoryDir({ memoryDir: root }, repo);
		expect(piDir).toBe(join(resolve(root), "git", "github.com__example__repo"));
		const piStore = new MemoryStore(storeConfig(piDir));
		await piStore.addEntry({ name: "PiNote", description: "written by pi", body: "body of PiNote" });

		// dsh 侧：同样的根装配插件，`agentCreated` 一个 cwd 相同的 agent。
		const fake = createFakeCtx();
		await apply(fake.ctx, rowConfig());
		const agent = fake.makeAgent({ id: "dsh-session", cwd: repo });
		await fake.emitter.agentCreated(agent);

		// dsh 解析出的 memoryDir 与 pi 相同（通过 /memory 的 Dir 行观察）。
		const status = await fake.commands[0].handler({
			agent,
			rawInput: "",
			signal: new AbortController().signal,
		});
		expect(status.text).toContain(`Dir: ${piDir}`);

		// 索引 section 含那条 entry 的索引行（snippet 前置，所以用 toContain 而不是相等）。
		expect(sectionText(fake)({ agent })).toContain("[PiNote](PiNote.md)");
		expect(sectionText(fake)({ agent })).toContain("written by pi");

		// per-agent 注册的 memory 工具能 list 出 pi 写的那条。
		const tool = memoryToolOf(fake, "dsh-session");
		expect(tool).toBeDefined();
		const result = await tool!.execute({ action: "list" }, {});
		expect(result.content).toContain("PiNote");
	});

	it("dsh → pi: 插件工具写入的 entry，用全新的 core MemoryStore 在同一个目录读得到", async () => {
		const repo = await makeGitRepo("https://github.com/example/repo.git");

		// dsh 侧：装配并 agentCreated，然后走工具的 add action 写一条。
		const fake = createFakeCtx();
		await apply(fake.ctx, rowConfig());
		const agent = fake.makeAgent({ id: "dsh-session", cwd: repo });
		await fake.emitter.agentCreated(agent);

		const tool = memoryToolOf(fake, "dsh-session");
		expect(tool).toBeDefined();
		const result = await tool!.execute(
			{ action: "add", name: "DshNote", description: "written by dsh", content: "body of DshNote", type: "project" },
			{},
		);
		expect(result.content).toContain('Saved "DshNote"');

		// pi 侧：同一根、同一 git cwd，用**全新**的 MemoryStore 读（不经过 dsh 的任何对象）。
		const piDir = await resolveMemoryDir({ memoryDir: root }, repo);
		expect(piDir).toBe(join(resolve(root), "git", "github.com__example__repo"));

		const fresh = new MemoryStore(storeConfig(piDir));
		const entries = await fresh.listEntries();
		expect(entries.map((entry) => entry.name)).toContain("DshNote");
		expect(await fresh.readIndex()).toContain("[DshNote](DshNote.md)");

		// entry 文件在磁盘上有齐全的五个 frontmatter 字段（用 core 的 parseEntryFile，不手撕 YAML）。
		const written = entries.find((entry) => entry.name === "DshNote");
		expect(written).toBeDefined();
		const parsed = parseEntryFile(await readFile(join(piDir, written!.file), "utf8"));
		expect(parsed).not.toBeNull();
		expect(parsed!.meta.name).toBe("DshNote");
		expect(parsed!.meta.description).toBe("written by dsh");
		expect(parsed!.meta.type).toBe("project");
		expect(parsed!.meta.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(parsed!.meta.modified).not.toBe("");
	});

	it("非 git 目录走 local/<escaped-path> 分支，两边解析到同一目录", async () => {
		const plain = join(dir, "proj");
		await mkdir(plain, { recursive: true });

		const expected = join(resolve(root), "local", projectDirName(resolve(plain)));
		const piDir = await resolveMemoryDir({ memoryDir: root }, plain);
		expect(piDir).toBe(expected);

		const fake = createFakeCtx();
		await apply(fake.ctx, rowConfig());
		const agent = fake.makeAgent({ id: "dsh-session", cwd: plain });
		await fake.emitter.agentCreated(agent);

		const status = await fake.commands[0].handler({
			agent,
			rawInput: "",
			signal: new AbortController().signal,
		});
		expect(status.text).toContain(`Dir: ${piDir}`);

		const tool = memoryToolOf(fake, "dsh-session");
		expect(tool).toBeDefined();
		await tool!.execute({ action: "add", name: "LocalNote", content: "local branch" }, {});

		const fresh = new MemoryStore(storeConfig(piDir));
		expect((await fresh.listEntries()).map((entry) => entry.name)).toContain("LocalNote");
	});
});
