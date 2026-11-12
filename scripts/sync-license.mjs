#!/usr/bin/env node
/**
 * 把仓库根的 `LICENSE` 复制进当前 workspace 包目录（`prepack`），打包结束后再删掉（`postpack`）。
 *
 * 仓库只维护根目录这一份 LICENSE：各包提交自己的副本会各自漂移，版权年份 / 署名的改动要改 N 处。
 * 但发布的 tarball 必须**真带**许可证文本（MIT 要求副本随附版权声明与许可声明），所以复制发生在
 * 打包的那一瞬间，产物不提交（见 .gitignore）。
 *
 * 为什么不是符号链接 `ln -s ../LICENSE <pkg>/LICENSE`：`npm pack` 不跟随指向包目录外的符号链接，
 * 打出来的 tarball 里连文件条目都没有 —— 看着有 LICENSE，发出去是空的。（实测 npm 12 / node 24。）
 *
 * 为什么不用 `files` 里写 `../LICENSE`：`files` 只认包目录内的路径，包外内容不进 tarball。
 *
 * 用法（由各包的 lifecycle 调用，cwd 就是包目录）：
 *   node ../scripts/sync-license.mjs            # prepack：写入
 *   node ../scripts/sync-license.mjs --remove   # postpack：清理
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(repoRoot, "LICENSE");
const pkgDir = process.cwd();
const target = join(pkgDir, "LICENSE");
const remove = process.argv.includes("--remove");

// 在仓库根跑会自己覆盖自己（`--remove` 下就是删掉唯一的许可证），所以先拒绝。
if (resolve(pkgDir) === resolve(repoRoot)) {
	throw new Error("sync-license: 请在包目录里运行（这是仓库根的 LICENSE 源文件，不该被覆盖）");
}
if (!existsSync(join(pkgDir, "package.json"))) {
	throw new Error(`sync-license: ${pkgDir} 不是包目录（没有 package.json）`);
}

if (remove) {
	// 只删自己生成的：与根 LICENSE 内容不同就说明有人手写了副本，别替人做决定。
	if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(source, "utf8")) {
		rmSync(target);
	}
	process.exit(0);
}

if (!existsSync(source)) throw new Error(`sync-license: 仓库根的 LICENSE 不存在：${source}`);
copyFileSync(source, target);
