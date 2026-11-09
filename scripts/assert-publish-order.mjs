// 发布顺序闸门：`pi-memory` 的 dependencies 指向 `@yandy0725/memory-core@^1.0.0`，
// core 不在 registry 上就发 pi-memory，用户装到的是一个 `No matching version found` 的包。
//
// 用法: node scripts/assert-publish-order.mjs <memory-core|pi-memory>
// 只对 pi-memory 生效；其余 workspace 直接放行。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/assert-publish-order.mjs <workspace-dir>");

if (dir !== "pi-memory") {
	console.log(`${dir}: 无跨包依赖，跳过发布顺序检查`);
	process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(repoRoot, "pi-memory", "package.json"), "utf8"));
const range = manifest.dependencies?.["@yandy0725/memory-core"];
if (!range) {
	console.error("pi-memory 不再依赖 @yandy0725/memory-core；若这是有意的，请一并删掉 scripts/assert-publish-order.mjs");
	process.exit(1);
}

let published = "";
try {
	published = execFileSync("npm", ["view", `@yandy0725/memory-core@${range}`, "version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
} catch {
	published = "";
}

if (!published) {
	console.error(
		[
			`拒绝发布 pi-memory：@yandy0725/memory-core@${range} 在 registry 上查不到。`,
			"先发 memory-core（tag memory-core-v*），确认 registry 上能查到，再发 pi-memory。",
			"详见 docs/guides/release.md。",
		].join("\n"),
	);
	process.exit(1);
}

console.log(`pi-memory 的依赖已在 registry 上：@yandy0725/memory-core@${published}`);
