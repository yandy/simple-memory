// 由 scripts/registry-smoke.mjs 拷进「只装了适配层 tarball」的干净目录后执行，因此
// import 到的 @yandy0725/memory-core 只可能来自 registry（仓库自己的 node_modules 不在解析路径上）。
//
// 用法: node registry-smoke-runtime.mjs <expected-versions-json> <package-label> <entry>
//   expected-versions-json: `npm view <core>@<range> version --json` 的原始结果（数组）
//   entry: 适配层的 main 或 exports["."].default
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, MemoryStore, loadConfigFrom } from "@yandy0725/memory-core";

const [versionsJson, label, entry] = process.argv.slice(2);
assert.ok(versionsJson && label && entry, "usage: node registry-smoke-runtime.mjs <versions-json> <label> <entry>");
/** 适配层声明的范围在 registry 上命中的那些版本（由驱动脚本查好传进来，避免在这里再写一个 semver）。 */
const expected = JSON.parse(versionsJson);

// 1. 解析路径：必须落在干净目录内的 node_modules，而不是本仓的 workspace 符号链接。
const installer = process.cwd();
const coreEntry = import.meta.resolve("@yandy0725/memory-core");
assert.ok(coreEntry.startsWith("file:"), `解析结果不是文件 URL：${coreEntry}`);
const corePath = resolve(new URL(coreEntry).pathname);
assert.ok(
	corePath.startsWith(installer + sep),
	`@yandy0725/memory-core 解析到了 ${relative(installer, corePath) || corePath}，不在干净目录 ${installer} 内`,
);

// 2. 版本：装上的必须就是适配层声明的范围命中的那个，不能是本仓的 workspace 版本。
const installed = JSON.parse(
	await readFile(join(installer, "node_modules", "@yandy0725", "memory-core", "package.json"), "utf8"),
).version;
assert.ok(
	expected.includes(installed),
	`装上的 @yandy0725/memory-core@${installed} 不在 registry 上满足 ${label} 范围的版本列表里：${expected.join(", ")}`,
);

// 3. 真跑一次读写：解析成功不等于产物可用（漏带 dist、或发布的是空包，都在这一步暴露）。
const cfg = await loadConfigFrom([]);
assert.equal(cfg.memoryDir, join(process.env.XDG_DATA_HOME, "simple-memory"), "默认数据根必须跟随 XDG_DATA_HOME");

const memoryDir = await mkdtemp(join(tmpdir(), "registry-smoke-memory-"));
const store = new MemoryStore({
	memoryDir,
	indexMaxLines: DEFAULT_CONFIG.memIndexMaxLines,
	indexMaxBytes: DEFAULT_CONFIG.memIndexMaxBytes,
	lock: DEFAULT_CONFIG.lock,
});
await store.addEntry({ name: "registry-smoke", description: "registry smoke", body: "written by registry-smoke-runtime.mjs" });
assert.equal((await store.readEntry("registry-smoke"))?.body.trim(), "written by registry-smoke-runtime.mjs");
assert.match(await store.readIndex(), /^- \[registry-smoke\]\(.+\.md\) — registry smoke$/m);

// 4. 适配层入口：产物形态的包（dsh-memory）可以直接 import —— 它的 dist 就是用户加载的那份代码，
//    所以这一步同时证明「dist 里的 import 能在运行时按 registry 解析」。以 TS 源码发布的包
//    （pi-memory）由宿主加载器剥类型，node 这里只验证入口文件真的在 tarball 里。
//    入口相对**包目录**（node_modules/<label>/），不是安装根目录。
const packageDir = join(installer, "node_modules", ...label.split("/"));
const entryPath = join(packageDir, entry);
assert.ok(existsSync(entryPath), `${label}: tarball 里没有入口 ${entry}`);
let entryNote = "TS 入口（由宿主加载器编译）";
if (entry.endsWith(".js")) {
	const mod = await import(pathToFileURL(entryPath).href);
	const exported = Object.keys(mod);
	assert.ok(exported.length > 0, `${label}: 入口 ${entry} 没有任何导出`);
	entryNote = `入口导出 ${exported.join(", ")}`;
}

console.log(
	`${label}: registry 上的 ${installed} OK（${entryNote}；解析到 ${relative(installer, corePath) || corePath}）`,
);
