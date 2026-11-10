#!/usr/bin/env node
/**
 * 校验适配层（`pi-memory` / `dsh-memory`）对 `@yandy0725/memory-core` 的两种解析路径
 * 没有互相串线（规范：docs/guides/dependencies.md「memory-core：开发走仓内源码，运行走 registry」）：
 *
 * 1. **运行时**（用户机器）：`dependencies` 里一个指向 registry 的 caret 范围，且
 *    `devDependencies` 里没有同名条目 —— 有的话安装时可能出现第二份副本，并在
 *    「dev 期解析到源码」与「运行时解析到 registry」之间悄悄漂移。
 * 2. **开发时**（本仓）：`vitest.config.ts` 的 alias 与 `tsconfig.json` 的 `paths` 都指向
 *    `../memory-core/src/index.ts`，所以 `npm test` / `npm run typecheck` 不需要先 build，
 *    也不会去读 registry 上那个版本。
 * 3. **构建时**：`tsconfig.build.json` 不得再带这条 `paths` —— 产物必须经包 `exports` 解析到
 *    `memory-core/dist`，否则 `dist/` 可能是对着比已发布版本更新的源码编出来的。
 *
 * 三条各自挡一种会静默通过的改法，所以都写成硬失败；错误文案里带上怎么改。
 *
 * 用法：npm run check:memory-core-deps
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 适配层依赖的中立包。 */
const CORE = "@yandy0725/memory-core";

/** 开发期指向仓内源码的落点（相对 workspace 目录）。 */
const SOURCE_ENTRY = "../memory-core/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 去掉 JSONC 的行注释与尾逗号，让手写注释的 tsconfig 也能被解析。 */
function parseJsonc(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			out += "\n";
			continue;
		}
		out += char;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readJsonc(path) {
	try {
		return parseJsonc(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`无法解析 ${path}：${error.message}`);
	}
}

const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const workspaces = (rootPkg.workspaces ?? []).filter((name) => name !== "memory-core");
const problems = [];
let checked = 0;

for (const workspace of workspaces) {
	const dir = join(repoRoot, workspace);
	if (!existsSync(dir)) continue;
	const label = readJsonc(join(dir, "package.json")).name ?? workspace;

	const pkg = readJsonc(join(dir, "package.json"));
	const range = pkg.dependencies?.[CORE];
	const devRange = pkg.devDependencies?.[CORE];
	checked += 1;

	// 1. 运行时：registry。
	if (range === undefined) {
		problems.push(
			`${label}: dependencies 里没有 "${CORE}"。运行时依赖必须在这里声明（指向 registry），` +
				`开发期由 vitest alias / tsconfig paths 指向仓内源码，不要因此把它挪到 devDependencies。`,
		);
	} else if (!/^\^\d+\.\d+\.\d+$/.test(range)) {
		problems.push(
			`${label}: dependencies["${CORE}"] = "${range}"，应是 registry 上的 caret 范围（如 "^1.1.0"）。` +
				`"file:" / "workspace:" / "*" / "latest" 会让发布出去的包在用户机器上解析不到。`,
		);
	}
	if (devRange !== undefined) {
		problems.push(
			`${label}: devDependencies 里出现了 "${CORE}" = "${devRange}"。` +
				`它在 dependencies 里已经够用（npm 会把 workspace 链接进 node_modules），重复声明只会` +
				`制造第二份副本，让「dev 期解析到源码」与「运行时解析到 registry」漂移。`,
		);
	}

	// 2. 开发期：仓内源码。
	const vitestConfig = join(dir, "vitest.config.ts");
	if (!existsSync(vitestConfig)) {
		problems.push(`${label}: 没有 vitest.config.ts，无法把 "${CORE}" 指向仓内源码`);
	} else {
		const text = readFileSync(vitestConfig, "utf8");
		if (!text.includes(SOURCE_ENTRY)) {
			problems.push(
				`${label}: vitest.config.ts 的 resolve.alias 没有把 "${CORE}" 指到 "${SOURCE_ENTRY}"，` +
					`测试会打到 registry 上的版本，而不是仓内源码。`,
			);
		}
		if (!text.includes("MEMORY_CORE_FROM_DIST")) {
			problems.push(
				`${label}: vitest.config.ts 缺少 MEMORY_CORE_FROM_DIST 开关。` +
					`CI 的 test-dist job 靠它关掉 alias，让同一套测试打到包 exports → memory-core/dist。`,
			);
		}
	}

	const tsconfig = join(dir, "tsconfig.json");
	if (!existsSync(tsconfig)) {
		problems.push(`${label}: 没有 tsconfig.json，无法把 "${CORE}" 指到仓内源码`);
	} else if (readJsonc(tsconfig)?.compilerOptions?.paths?.[CORE]?.[0] !== SOURCE_ENTRY) {
		problems.push(
			`${label}: tsconfig.json 的 compilerOptions.paths["${CORE}"] 不是 ["${SOURCE_ENTRY}"]，` +
				`typecheck 会去读 node_modules 里的 memory-core/dist（可能没 build、也可能是旧版本）。`,
		);
	}

	// 3. 构建期：包 exports（对齐已发布的 dist），不跟源码。
	const buildConfig = join(dir, "tsconfig.build.json");
	if (existsSync(buildConfig) && readJsonc(buildConfig)?.compilerOptions?.paths?.[CORE] !== undefined) {
		problems.push(
			`${label}: tsconfig.build.json 继承来的 paths 把 "${CORE}" 指向了 "${SOURCE_ENTRY}"。` +
				`构建必须经包 exports 解析 dist（写成 "paths": {}），否则产物可能对着比 registry 上更新的源码编出来。`,
		);
	}
}

if (problems.length > 0) {
	console.error("memory-core 依赖声明检查失败（规范：docs/guides/dependencies.md）：");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error(`\n共 ${problems.length} 项问题。`);
	process.exit(1);
}

console.log(
	`memory-core 依赖声明检查通过：${checked} 个适配层 workspace 都是「开发走仓内源码、运行时走 registry」。`,
);
