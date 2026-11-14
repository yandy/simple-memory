import { describe, expect, it } from "vitest";
import { diffThreeWay, isEmptyDiff } from "../src/sync/diff.js";
import type { SyncDiff } from "../src/sync/diff.js";
import type { SyncFileInfo, SyncFileSet } from "../src/sync/types.js";

/**
 * 三方差集是真值表驱动的纯函数：每个用例对应「base / ours / theirs」里的一行。
 * 名字刻意写成 `base有|ours改|theirs同` 这种形式，好让失败信息直接指向表里的那一行。
 */

const f = (hash: string, modified = "2026-11-09T00:00:00.000Z"): SyncFileInfo => ({ hash, modified, bytes: 1 });

const set = (...pairs: Array<[string, string]>): SyncFileSet => {
	const out: SyncFileSet = new Map();
	for (const [file, hash] of pairs) out.set(file, f(hash));
	return out;
};

const empty = (): SyncFileSet => new Map();

const noopDiff = (): SyncDiff => ({
	pullFromRemote: [],
	pushLocal: [],
	deleteLocal: [],
	deleteRemote: [],
	conflicts: [],
});

/** 深拷贝一份 set，用来证明纯函数没有改写入参。 */
const snapshot = (source: SyncFileSet): SyncFileSet => new Map([...source].map(([file, info]) => [file, { ...info }]));

describe("diffThreeWay", () => {
	it("三方全同 → 空差集", () => {
		expect(diffThreeWay(set(["a", "1"]), set(["a", "1"]), set(["a", "1"]))).toEqual(noopDiff());
	});

	it("base有|ours改|theirs同 → pushLocal", () => {
		expect(diffThreeWay(set(["a", "1"]), set(["a", "2"]), set(["a", "1"]))).toEqual({
			...noopDiff(),
			pushLocal: ["a"],
		});
	});

	it("base有|ours同|theirs改 → pullFromRemote", () => {
		expect(diffThreeWay(set(["a", "1"]), set(["a", "1"]), set(["a", "2"]))).toEqual({
			...noopDiff(),
			pullFromRemote: ["a"],
		});
	});

	it("base有|ours改|theirs改 → conflicts（两边内容相同时不算冲突，视为无变化）", () => {
		const d = diffThreeWay(set(["a", "1"]), set(["a", "2"]), set(["a", "3"]));
		expect(d.conflicts).toEqual([{ file: "a", ours: f("2"), theirs: f("3") }]);
		// 冲突不改变"别处没有动作"这条：四个清单必须都是空的
		expect({ ...d, conflicts: [] }).toEqual(noopDiff());
		// 两侧改成了同一份内容：不是冲突，是"没有变更"
		expect(diffThreeWay(set(["a", "1"]), set(["a", "2"]), set(["a", "2"]))).toEqual(noopDiff());
	});

	it("base有|ours删|theirs同 → deleteRemote", () => {
		expect(diffThreeWay(set(["a", "1"]), empty(), set(["a", "1"]))).toEqual({
			...noopDiff(),
			deleteRemote: ["a"],
		});
	});

	it("base有|ours同|theirs删 → deleteLocal", () => {
		expect(diffThreeWay(set(["a", "1"]), set(["a", "1"]), empty())).toEqual({
			...noopDiff(),
			deleteLocal: ["a"],
		});
	});

	it("base有|ours删|theirs改 → conflicts，被删的一侧是 null", () => {
		// 删除 vs 修改：删除照办、被改的那份由冲突收敛留下。
		// 原路径的删除归冲突收敛所有，所以这里绝不同时出现在 deleteLocal / deleteRemote 里 ——
		// 否则引擎会先删原路径、再被冲突收敛写回，同一轮里对同一个路径既删又写。
		const d = diffThreeWay(set(["a", "1"]), new Map(), set(["a", "2"]));
		expect(d.conflicts).toEqual([{ file: "a", ours: null, theirs: f("2") }]);
		expect(d.deleteLocal).toEqual([]);
		expect(d.deleteRemote).toEqual([]);
	});

	it("base有|ours改|theirs删 → conflicts（镜像，theirs 侧是 null）", () => {
		const d = diffThreeWay(set(["a", "1"]), set(["a", "2"]), new Map());
		expect(d.conflicts).toEqual([{ file: "a", ours: f("2"), theirs: null }]);
		expect(d.deleteLocal).toEqual([]);
		expect(d.deleteRemote).toEqual([]);
	});

	it("两边都删 → 空差集", () => {
		expect(diffThreeWay(set(["a", "1"]), empty(), empty())).toEqual(noopDiff());
	});

	it("base无|ours加|theirs无 → pushLocal", () => {
		expect(diffThreeWay(empty(), set(["a", "1"]), empty())).toEqual({ ...noopDiff(), pushLocal: ["a"] });
	});

	it("base无|ours无|theirs加 → pullFromRemote", () => {
		expect(diffThreeWay(empty(), empty(), set(["a", "1"]))).toEqual({ ...noopDiff(), pullFromRemote: ["a"] });
	});

	it("base无|两边都加：内容相同 → 无冲突；内容不同 → conflicts", () => {
		expect(diffThreeWay(empty(), set(["a", "1"]), set(["a", "1"]))).toEqual(noopDiff());
		expect(diffThreeWay(empty(), set(["a", "2"]), set(["a", "3"])).conflicts).toEqual([
			{ file: "a", ours: f("2"), theirs: f("3") },
		]);
	});

	it("首次同步（base 为空）：空本地 + 满远端 → 全部 pull、零冲突", () => {
		const d = diffThreeWay(empty(), empty(), set(["a", "1"], ["b", "2"]));
		expect(d.pullFromRemote).toEqual(["a", "b"]);
		expect(d.conflicts).toEqual([]);
		expect(d.pushLocal).toEqual([]);
		expect(d.deleteLocal).toEqual([]);
		expect(d.deleteRemote).toEqual([]);
	});

	it("四个数组都按字典序排序", () => {
		// 推：base 里两个都改过，名字逆序给出
		const pushBase = set(["b", "1"], ["A", "1"]);
		const pushOurs = set(["b", "2"], ["A", "2"]);
		const pushTheirs = set(["b", "1"], ["A", "1"]);
		// 拉：远端改了、本地没动
		const pullBase = set(["d", "1"], ["C", "1"]);
		const pullOurs = set(["d", "1"], ["C", "1"]);
		const pullTheirs = set(["d", "2"], ["C", "2"]);
		// 本地删：删除传播到本地
		const delLocalBase = set(["f", "1"], ["E", "1"]);
		const delLocalOurs = set(["f", "1"], ["E", "1"]);
		// 远端删：本地删除传播到远端
		const delRemoteBase = set(["h", "1"], ["G", "1"]);
		const delRemoteTheirs = set(["h", "1"], ["G", "1"]);
		// 冲突：两侧都改
		const conflictBase = set(["j", "1"], ["I", "1"]);
		const conflictOurs = set(["j", "2"], ["I", "2"]);
		const conflictTheirs = set(["j", "3"], ["I", "3"]);

		const sets = [
			pushBase,
			pushOurs,
			pushTheirs,
			pullBase,
			pullOurs,
			pullTheirs,
			delLocalBase,
			delLocalOurs,
			delRemoteBase,
			delRemoteTheirs,
			conflictBase,
			conflictOurs,
			conflictTheirs,
		];
		const before = sets.map(snapshot);

		const merged = new Map([...pushBase, ...pullBase, ...delLocalBase, ...delRemoteBase, ...conflictBase]);
		const ours = new Map([...pushOurs, ...pullOurs, ...delLocalOurs, ...conflictOurs]);
		const theirs = new Map([...pushTheirs, ...pullTheirs, ...delRemoteTheirs, ...conflictTheirs]);

		const d = diffThreeWay(merged, ours, theirs);

		// 码点序（不是 locale 序）：大写先于小写，与设备/平台的语言环境无关 —— 两台设备必须排出同一个顺序
		expect(d.pushLocal).toEqual(["A", "b"]);
		expect(d.pullFromRemote).toEqual(["C", "d"]);
		expect(d.deleteLocal).toEqual(["E", "f"]);
		expect(d.deleteRemote).toEqual(["G", "h"]);
		expect(d.conflicts.map((c) => c.file)).toEqual(["I", "j"]);

		// 纯函数：入参一个字段都没被改（顺序、内容、字节数都原样）
		expect(sets).toEqual(before);
	});

	it("isEmptyDiff", () => {
		const withPatch = (patch: Partial<SyncDiff>): SyncDiff => ({ ...noopDiff(), ...patch });

		expect(isEmptyDiff(noopDiff())).toBe(true);
		expect(isEmptyDiff(withPatch({ pullFromRemote: ["a"] }))).toBe(false);
		expect(isEmptyDiff(withPatch({ pushLocal: ["a"] }))).toBe(false);
		expect(isEmptyDiff(withPatch({ deleteLocal: ["a"] }))).toBe(false);
		expect(isEmptyDiff(withPatch({ deleteRemote: ["a"] }))).toBe(false);
		expect(isEmptyDiff(withPatch({ conflicts: [{ file: "a", ours: f("1"), theirs: f("2") }] }))).toBe(false);
	});
});
