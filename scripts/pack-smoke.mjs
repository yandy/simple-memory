// 在「只装了 @yandy0725/memory-core tarball」的干净目录里执行（脚本必须在该目录内运行）。
//
// Node 的 ESM 解析跟随**脚本自身位置**，不是 cwd。从仓库根执行 `<repo>/scripts/pack-smoke.mjs`
// 会命中仓库自己的 `node_modules`（workspace 符号链接 → `memory-core/dist`），于是 tarball
// 哪怕是空包也照样绿。CI 因此把本文件拷进干净目录再跑。
//
// 必须带 `XDG_DATA_HOME`（指向临时目录）运行：`defaultMemoryRoot()` 在模块加载时求值，
// `loadConfigFrom([])` 因此拿到的是真实数据根 —— 不带这个变量就会往用户自己的记忆库写。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	MemoryStore,
	defaultMemoryRoot,
	loadConfigFrom,
	resolveMemoryDir,
} from "@yandy0725/memory-core";

const installer = process.cwd();
for (const hostPkg of ["@earendil-works", "typebox"]) {
	assert.equal(existsSync(join(installer, "node_modules", hostPkg)), false, `安装树里不该有 ${hostPkg}`);
}

assert.equal(defaultMemoryRoot({ XDG_DATA_HOME: "/data" }, "/home/u"), join("/data", "simple-memory"));
assert.equal(defaultMemoryRoot({}, "/home/u"), join("/home/u", ".local", "share", "simple-memory"));

const xdg = process.env.XDG_DATA_HOME;
assert.ok(xdg?.startsWith(tmpdir()), "run with XDG_DATA_HOME pointing inside the temp dir");
const expectedRoot = join(xdg, "simple-memory");

const project = await mkdtemp(join(tmpdir(), "smoke-project-"));
execFileSync("git", ["init", "--quiet", project]);
execFileSync("git", ["-C", project, "remote", "add", "origin", "https://github.com/yandy/simple-memory.git"]);

const cfg = await loadConfigFrom([]);
assert.equal(cfg.memoryDir, expectedRoot, "loadConfigFrom([]) must take the XDG default root");

const memoryDir = await resolveMemoryDir(cfg, project);
assert.match(memoryDir.replaceAll("\\", "/"), /\/simple-memory\/git\/github\.com__yandy__simple-memory$/);

await mkdir(memoryDir, { recursive: true });
const store = new MemoryStore({
	memoryDir,
	indexMaxLines: DEFAULT_CONFIG.memIndexMaxLines,
	indexMaxBytes: DEFAULT_CONFIG.memIndexMaxBytes,
	lock: DEFAULT_CONFIG.lock,
});

await store.addEntry({ name: "smoke", description: "pack smoke", body: "written by scripts/pack-smoke.mjs" });
assert.equal((await store.listEntries()).length, 1);
assert.equal((await store.readEntry("smoke"))?.body.trim(), "written by scripts/pack-smoke.mjs");
assert.match(await store.readIndex(), /^- \[smoke\]\(.+\.md\) — pack smoke$/m);
console.log(`pack-smoke OK: ${memoryDir}`);
