// 用法: node scripts/assert-pack-manifest.mjs <npm-pack-json>
//
// `npm pack --json` 的输出断言：发布出去的那包必须带 dist/ 与类型声明、带 README/LICENSE，
// 且绝不能把 tests/ 打进去。CI 的 pack-smoke job 调它，本地也能直接跑。
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/assert-pack-manifest.mjs <npm-pack-json>");

const [manifest] = JSON.parse(readFileSync(file, "utf8"));
if (!manifest?.files) throw new Error(`${file}: not an npm pack --json payload`);

const files = manifest.files.map((entry) => entry.path);
const required = ["dist/index.js", "dist/index.d.ts", "src/index.ts", "README.md", "LICENSE"];
for (const path of required) {
	if (!files.includes(path)) throw new Error(`missing ${path} in ${manifest.filename}`);
}
if (files.some((path) => path.startsWith("tests/"))) {
	throw new Error(`tests/ leaked into ${manifest.filename}`);
}

console.log(`${manifest.filename}: ${files.length} files OK`);
