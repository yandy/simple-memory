// 用法: node scripts/assert-pack-manifest.mjs <npm-pack-json> <memory-core|pi-memory>
//
// `npm pack --json` 的输出断言。两个包各有自己的契约，所以按包给期望：
// - memory-core：发布的是编译产物，必须有 dist/index.js 与 dist/index.d.ts；
// - pi-memory：以 TS 源码发布（pi 的扩展加载器剥类型），必须有 `pi.extensions` 指向的 index.ts
//   与至少一个 src/*.ts —— 少任何一个，装上就是个加载不了的包；
// - 两个包都不得把 tests/ 或 docs/ 打进 tarball（它们的内容与体积都不该进用户机器）。
import { readFileSync } from "node:fs";

const [file, pkg] = process.argv.slice(2);
if (!file || !pkg) {
	throw new Error("usage: node scripts/assert-pack-manifest.mjs <npm-pack-json> <memory-core|pi-memory>");
}

const [manifest] = (() => {
	// `npm pack --json` 的形状随 npm 版本变：单个包是数组（`[manifest]`），带 `-w` 时也可能是以包名为键的
	// 对象（同 scripts/registry-smoke.mjs 的 unpackOne）。
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	return Array.isArray(parsed) ? parsed : Object.values(parsed);
})();
if (!manifest?.files) throw new Error(`${file}: not an npm pack --json payload`);

const files = manifest.files.map((entry) => entry.path);
const has = (path) => files.includes(path);

const CONTRACTS = {
	"memory-core": {
		required: ["dist/index.js", "dist/index.d.ts", "src/index.ts", "README.md", "LICENSE"],
		forbiddenPrefixes: ["tests/", "docs/"],
	},
	"pi-memory": {
		// LICENSE 也在这里：它在 prepack 时由 scripts/sync-license.mjs 从仓库根生成，不是提交的文件，
		// 所以只有打一次 tarball 才能发现「脚本没跑 / 生成到别处」。
		required: ["index.ts", "README.md", "package.json", "LICENSE"],
		forbiddenPrefixes: ["tests/", "docs/"],
		/** `pi.extensions` 指向 index.ts，src/ 里是它的实现；两者少一个都装不起来。 */
		atLeastOne: ["src/"],
	},
};

const contract = CONTRACTS[pkg];
if (!contract) throw new Error(`unknown package: ${pkg}`);

for (const path of contract.required) {
	if (!has(path)) throw new Error(`${pkg}: missing ${path} in ${manifest.filename}`);
}
for (const prefix of contract.atLeastOne ?? []) {
	if (!files.some((path) => path.startsWith(prefix))) {
		throw new Error(`${pkg}: no ${prefix}* in ${manifest.filename}`);
	}
}
for (const prefix of contract.forbiddenPrefixes) {
	if (files.some((path) => path.startsWith(prefix))) {
		throw new Error(`${pkg}: ${prefix} leaked into ${manifest.filename}`);
	}
}
if (pkg === "pi-memory") {
	// 以 TS 源码发布就必须真带 .ts：编译产物不存在于这个包里。
	if (!files.some((path) => path.endsWith(".ts"))) {
		throw new Error(`pi-memory: no .ts sources in ${manifest.filename}`);
	}
}

console.log(`${manifest.filename}: ${files.length} files OK (${pkg})`);
