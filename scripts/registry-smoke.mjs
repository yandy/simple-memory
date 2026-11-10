#!/usr/bin/env node
/**
 * 运行时解析闸门：适配层在**用户机器上**拿到的 `@yandy0725/memory-core` 来自 registry，
 * 而不是本仓的 workspace 符号链接（规范：docs/guides/dependencies.md
 * 「memory-core：开发走仓内源码，运行走 registry」）。
 *
 * 做法：把适配层打成 tarball，装进一个干净目录（依赖只从 registry 拉），然后断言
 * 解析到的 memory-core 落在该目录内、版本满足适配层声明的范围，并真跑一次 store 读写。
 * 仓内的 `npm test` 永远走 alias → 源码，这条路径只有真装一次才看得见。
 *
 * 用法：node scripts/registry-smoke.mjs [pi-memory|dsh-memory ...]
 *       （默认两个适配层都跑；需要先 `npm run build -w memory-core -w dsh-memory`）
 *
 * 未发布的适配层（`private: true`），或「核心无可用版本且适配层自己也没发布」的发布进行中状态，只打
 * notice 跳过 —— 那时这条路径客观上无法验证。但适配层已发布、而声明的范围在 registry 上不存在，仍然
 * 硬失败（那是真的装不起来）。发布 core 之后 rerun 本 job，它会真的跑一遍。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = "@yandy0725/memory-core";
const REGISTRY = "https://registry.npmjs.org";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapters = process.argv.slice(2);
const targets = adapters.length > 0 ? adapters : ["pi-memory", "dsh-memory"];

const run = (command, args, options = {}) =>
	execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

/** `npm view <spec> version --json` 的返回值：单个版本是字符串，多个是数组。 */
function publishedVersions(spec) {
	try {
		const out = run("npm", ["view", spec, "version", "--json", `--registry=${REGISTRY}`]).trim();
		if (out === "") return [];
		const parsed = JSON.parse(out);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return [];
	}
}

/**
 * `npm pack --json` 的形状随 npm 版本变：单个包是数组（`[manifest]`），带 `-w` 时也可能是
 * 以包名为键的对象。两种都接受。
 */
function unpackOne(stdout) {
	const parsed = JSON.parse(stdout);
	const manifest = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (manifest?.files === undefined) throw new Error(`npm pack --json 的输出里没有文件清单：${stdout.slice(0, 200)}`);
	return manifest;
}

/** 适配层对核心包的运行时依赖范围；缺失或不指向 registry 都是硬错误（由静态闸门先一步拦住）。 */
function coreRange(manifest, label) {
	const range = manifest.dependencies?.[CORE];
	if (range === undefined) {
		throw new Error(`${label}: dependencies 里没有 "${CORE}"，没有可验证的运行时依赖`);
	}
	return range;
}

let skipped = 0;

/** `npm view <spec> version` 有结果 = 已发布。只用来区分「发布进行中」与「真的配错了」。 */
function isPublished(spec) {
	try {
		return run("npm", ["view", spec, "version", `--registry=${REGISTRY}`]).trim() !== "";
	} catch {
		return false;
	}
}

for (const target of targets) {
	const dir = join(repoRoot, target);
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const label = manifest.name ?? target;
	const range = coreRange(manifest, label);
	const versions = publishedVersions(`${CORE}@${range}`);

	if (versions.length === 0) {
		if (manifest.private === true) {
			skipped += 1;
			console.log(
				`::notice::${label}: registry 上还没有满足 "${CORE}@${range}" 的版本，跳过运行时冒烟` +
					`（本包 private: true，尚未发布；发布前这个条件会变成失败）`,
			);
			continue;
		}
		// 适配层自己也没发布 = 发布进行中：这条路径此刻**无法**验证（核心还没上 registry），
		// 报失败只会让人把「还没发」当成「代码错」。发布 core 之后 rerun 本 job，它会真的跑一遍。
		// 但适配层已发布、而声明的范围在 registry 上不存在，那是真错（例如改了范围忘了发 core）——
		// 下面仍然硬失败。
		const ownSpec = `${manifest.name}@${manifest.version}`;
		if (!isPublished(ownSpec)) {
			skipped += 1;
			console.log(
				`::notice::${label}: registry 上还没有满足 "${CORE}@${range}" 的版本，且 ${ownSpec} 也未发布` +
					" —— 发布进行中，无法验证运行时路径。先发 memory-core，再 rerun 本 job（docs/guides/release.md）",
			);
			continue;
		}
		throw new Error(
			`${label}: registry 上查不到满足 "${CORE}@${range}" 的版本，而 ${ownSpec} 已发布 —— 这份声明装不起来。` +
				"先按 docs/guides/release.md 发布 memory-core。",
		);
	}

	const work = await mkdtemp(join(tmpdir(), `registry-smoke-${target}-`));
	const packDir = join(work, "pack");
	const installDir = join(work, "install");
	mkdirSync(packDir, { recursive: true });
	mkdirSync(installDir, { recursive: true });

	const packed = unpackOne(
		run("npm", ["pack", "-w", target, "--pack-destination", packDir, "--json"], { cwd: repoRoot }),
	);
	// 入口取宿主的加载点：pi 走 `pi.extensions[0]`，dsh 走 `main` / `exports["."]`。
	const entry = manifest.pi?.extensions?.[0] ?? manifest.main ?? manifest.exports?.["."]?.default;
	if (entry === undefined) throw new Error(`${label}: package.json 没有 pi.extensions / main / exports["."]，无法验证运行时入口`);
	if (!packed.files.some((file) => file.path === entry.replace(/^\.\//, ""))) {
		throw new Error(
			`${label}: tarball 里没有入口 ${entry}（先跑 npm run build -w memory-core -w ${target}，` +
				`构建产物不入库，dist/ 不会自己出现）`,
		);
	}

	writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "registry-smoke", private: true, type: "module" }, null, "\t")}\n`);
	// --legacy-peer-deps：宿主包由宿主提供，冒烟只需要 memory-core 这条运行时依赖（装上
	// @earendil-works/* 会拉进几百 MB，且与本次验证无关）。
	run(
		"npm",
		[
			"install",
			join(packDir, packed.filename),
			`--registry=${REGISTRY}`,
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
			"--ignore-scripts",
		],
		{ cwd: installDir },
	);

	// Node 的 ESM 解析跟随**脚本自身位置**，所以断言脚本必须拷进干净目录再跑（同 scripts/pack-smoke.mjs）。
	const probe = join(installDir, "registry-smoke-runtime.mjs");
	copyFileSync(join(repoRoot, "scripts", "registry-smoke-runtime.mjs"), probe);
	const reported = run(
		"node",
		[probe, JSON.stringify(versions), label, entry],
		// XDG_DATA_HOME 指向临时目录：core 的默认数据根在模块加载时求值，不设就会碰真实数据根。
		{ cwd: installDir, env: { ...process.env, XDG_DATA_HOME: join(work, "xdg") } },
	);
	for (const line of reported.trim().split("\n")) console.log(line);
}

console.log(
	skipped === 0
		? `registry 运行时冒烟通过：${targets.join(", ")} 都能从 registry 解析到 ${CORE}`
		: `registry 运行时冒烟结束：${targets.length - skipped} 个适配层通过，${skipped} 个因未发布跳过`,
);
