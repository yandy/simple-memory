#!/usr/bin/env node
/**
 * 断言 LICENSE 只有仓库根那一份：任何 `<pkg>/LICENSE` 被提交进来都算错。
 *
 * 各包目录里的 LICENSE 由 `scripts/sync-license.mjs` 在 `prepack` 时从根 LICENSE 生成、`postpack`
 * 时删除，并且被 .gitignore 忽略（见 docs/guides/architecture.md「LICENSE 只有根目录一份」）。
 * 有人重新提交一份副本时，改动会从根 LICENSE 分叉，而 root LICENSE 的署名/年份才是唯一的真相。
 *
 * 用法：npm run check:license
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

if (!existsSync(join(repoRoot, "LICENSE"))) {
	throw new Error("仓库根的 LICENSE 不存在：所有包都靠它，缺了发布的 tarball 就没有许可证文本");
}

// pathspec 里的 `*` 跨 `/` 匹配，所以 `*/LICENSE` 覆盖任意深度的包目录。
const tracked = execFileSync("git", ["ls-files", "-z", "LICENSE", "*/LICENSE"], {
	cwd: repoRoot,
	encoding: "utf8",
})
	.split("\0")
	.filter((path) => path !== "");

const offenders = tracked.filter((path) => path !== "LICENSE");
if (offenders.length > 0) {
	throw new Error(
		`LICENSE 只允许存在于仓库根，但这些副本被提交了：${offenders.join(", ")}\n` +
			"删掉它们（git rm），打包时 scripts/sync-license.mjs 会自动从根 LICENSE 生成。",
	);
}

console.log(`LICENSE 只有根目录一份（tracked: ${tracked.length}），OK`);
