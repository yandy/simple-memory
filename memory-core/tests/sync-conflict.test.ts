import { hostname, tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { conflictSuffix, resolveConflict } from "../src/sync/conflict.js";
import type { ConflictSide } from "../src/sync/conflict.js";
import { sha256Hex } from "../src/sync/hash.js";
import { parseEntryFile, serializeEntryFile } from "../src/store/entry-file.js";
import { ENTRY_EXT, isEntryFileNameForWrite } from "../src/store/filename.js";

/**
 * 冲突收敛的判据只许来自**冲突双方的内容**：两台设备各自解同一次冲突，必须算出逐字节相同的
 * 新文件名与字节。所以这里的用例反复在做同一件事 —— 换一个本地上下文（占用清单、两侧的摆放顺序），
 * 断言产物一模一样。任何一处泄漏了 hostname、当天日期或目录里恰好有什么，这些用例就会红。
 */

const side = (name: string, modified: string, body = "正文"): ConflictSide => {
	const raw = serializeEntryFile({ name, description: "d", type: "feedback", created: "2026-11-09", modified }, body);
	return { raw, info: { hash: sha256Hex(raw), modified, bytes: Buffer.byteLength(raw, "utf8") } };
};

/** 一份解析不出 frontmatter 的字节：败者是它时无法作者化新 entry，胜者是它时逐字落盘无所谓。 */
const BROKEN_RAW = "没有 frontmatter 的正文";
const brokenSide = (modified: string): ConflictSide => ({
	raw: BROKEN_RAW,
	info: { hash: sha256Hex(BROKEN_RAW), modified, bytes: Buffer.byteLength(BROKEN_RAW, "utf8") },
});

const fpOf = (raw: string) => sha256Hex(raw).slice(0, 6);

describe("conflictSuffix", () => {
	it("= ' (冲突 <该份内容 modified 的日期> <该份内容 sha256 前 6 位>)'", () => {
		const s = side("发布状态", "2026-11-09T10:00:00.000Z");
		expect(conflictSuffix(s.raw)).toBe(` (冲突 2026-11-09 ${sha256Hex(s.raw).slice(0, 6)})`);
	});

	it("modified 非法或缺失时退回 1970-01-01 之类的稳定值，不抛", () => {
		// 规定的稳定值是常量 "unknown-date"（同样是「不随环境漂移的固定值」）。要点是它**绝不可能**
		// 是今天：一旦 fallback 到今天，两台设备在不同日子解同一次冲突就会写出两个文件名。
		const today = new Date().toISOString().slice(0, 10);
		const badModified = serializeEntryFile(
			{ name: "A", description: "d", type: "feedback", created: "2026-11-09", modified: "昨天下午" },
			"正文",
		);
		const halfDate = serializeEntryFile(
			{ name: "A", description: "d", type: "feedback", created: "2026-11-09", modified: "2026-11" },
			"正文",
		);
		const emptyModified = "---\nname: A\ndescription: d\ntype: feedback\ncreated: 2026-11-09\n---\n";
		for (const raw of [badModified, halfDate, emptyModified, BROKEN_RAW, ""]) {
			const suffix = conflictSuffix(raw);
			expect(suffix).toBe(` (冲突 unknown-date ${fpOf(raw)})`);
			expect(suffix).not.toContain(today);
			expect(conflictSuffix(raw)).toBe(suffix); // 同一份内容问两次，答案一样
		}
	});

	it("后缀只随内容变：正文改一个字，指纹跟着变；同一份内容问几次都一样", () => {
		const a = side("A", "2026-11-09T10:00:00.000Z", "正文一");
		const b = side("A", "2026-11-09T10:00:00.000Z", "正文二");
		expect(conflictSuffix(a.raw)).not.toBe(conflictSuffix(b.raw));
		expect(conflictSuffix(a.raw)).toMatch(/^ \(冲突 \d{4}-\d{2}-\d{2} [0-9a-f]{6}\)$/);
	});
});

describe("resolveConflict", () => {
	it("modified 新的一方留在原路径，且字节逐字不变", () => {
		const ours = side("A", "2026-11-09T10:00:00.000Z");
		const theirs = side("A", "2026-11-10T15:30:00.000Z", "改写过的正文");
		const out = resolveConflict({ file: "a.md", ours, theirs }, []);
		expect(out?.winnerRaw).toBe(theirs.raw);
		expect(out!.loserEntry!.raw).not.toBe(ours.raw); // name 改了，字节必然不同
		// 败者是「重新序列化」出来的：只改 name，其余 frontmatter 与正文原样带过去。
		// （胜者那一份的「逐字」由上一条 winnerRaw === theirs.raw 钉住。）
		expect(out!.loserEntry!.raw).toBe(
			serializeEntryFile(
				{ ...parseEntryFile(ours.raw)!.meta, name: `A${conflictSuffix(ours.raw)}` },
				parseEntryFile(ours.raw)!.body,
			),
		);
	});

	it("modified 相同 → 按 sha256 字典序取大的一方（两台设备独立算出同一个胜者）", () => {
		const a = side("A", "2026-11-09T10:00:00.000Z", "aaa");
		const b = side("A", "2026-11-09T10:00:00.000Z", "bbb");
		const r1 = resolveConflict({ file: "a.md", ours: a, theirs: b }, []);
		const r2 = resolveConflict({ file: "a.md", ours: b, theirs: a }, []); // 交换两侧
		expect(r1?.winnerRaw).toBe(r2?.winnerRaw);
		// 非空洞：胜者确实是 hash 字典序大的那一份（两个都是 undefined 时上一条也会过）
		expect(r1?.winnerRaw).toBe(a.info.hash > b.info.hash ? a.raw : b.raw);
	});

	it("交换两侧不改变产物：胜者与败者都只由内容决定", () => {
		const ours = side("A", "2026-11-09T10:00:00.000Z");
		const theirs = side("A", "2026-11-10T15:30:00.000Z");
		const r1 = resolveConflict({ file: "a.md", ours, theirs }, []);
		const r2 = resolveConflict({ file: "a.md", ours: theirs, theirs: ours }, []);
		expect(r1).not.toBeNull();
		expect(r2).toEqual(r1);
	});

	it("败者新 name = 原 name + 后缀；created/modified/type/description 原样保留", () => {
		const ours = side("发布状态", "2026-11-09T10:00:00.000Z");
		const theirs = side("发布状态", "2026-11-10T15:30:00.000Z");
		const out = resolveConflict({ file: "发布状态.md", ours, theirs }, []);
		const parsed = parseEntryFile(out!.loserEntry!.raw)!;
		const meta = parsed.meta;
		expect(meta.name).toBe(`发布状态${conflictSuffix(ours.raw)}`);
		expect(meta).toMatchObject({
			created: "2026-11-09",
			modified: "2026-11-09T10:00:00.000Z",
			type: "feedback",
			description: "d",
		});
		expect(parsed.body).toBe("正文"); // 只有 name 变，正文原样
		expect(out!.loserEntry!.name).toBe(meta.name);
	});

	it("★确定性：同一份败者内容从不同本地上下文各解一次，name/file/raw 逐字节相同", () => {
		// 这条钉死一个真 bug：后缀不得含本地 hostname 或当天日期，否则两台设备各造一份、永不收敛
		const ours = side("A", "2026-11-09T10:00:00.000Z");
		const theirs = side("A", "2026-11-10T15:30:00.000Z");
		const a = resolveConflict({ file: "a.md", ours, theirs }, []);
		const b = resolveConflict({ file: "a.md", ours, theirs }, ["无关.md"]);
		expect(a?.loserEntry).toEqual(b?.loserEntry);

		// 上面两次解跑在同一进程、同一时刻、同一台机器上，所以它**抓不住**「后缀吸收了 hostname 或今天」
		// —— 而那正是它要钉死的 bug。补三层，让本地状态一旦掺进产物就必然红：

		// 一、时钟：把系统时间调到两个相差几十年的日子再各解一次（= 另一台设备在另一天解同一次冲突）。
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2030-01-02T03:04:05.000Z"));
			const late = resolveConflict({ file: "a.md", ours, theirs }, []);
			vi.setSystemTime(new Date("2001-06-07T08:09:10.000Z"));
			const early = resolveConflict({ file: "a.md", ours, theirs }, ["无关.md"]);
			expect(late!.loserEntry).toEqual(a!.loserEntry);
			expect(early!.loserEntry).toEqual(a!.loserEntry);

			// 上面那一份的 modified 是合法的，走不到日期兜底 —— 所以再解一份 modified 是垃圾值的：
			// 兜底值必须是常量，一旦退回「今天」，这两个相差几十年的系统时间就会算出两个名字。
			// （用删除 vs 修改来摆位：幸存的那一份必然是败者，不受 modified 字典序影响。）
			const garbage = side("A", "昨天下午");
			vi.setSystemTime(new Date("2030-01-02T03:04:05.000Z"));
			const lateBad = resolveConflict({ file: "a.md", ours: null, theirs: garbage }, []);
			vi.setSystemTime(new Date("2001-06-07T08:09:10.000Z"));
			const earlyBad = resolveConflict({ file: "a.md", ours: null, theirs: garbage }, ["无关.md"]);
			expect(lateBad!.loserEntry).toEqual(earlyBad!.loserEntry);
			expect(lateBad!.loserEntry!.name).toBe(`A (冲突 unknown-date ${fpOf(garbage.raw)})`);
		} finally {
			vi.useRealTimers();
		}

		// 二、主机与进程环境：产物里不得出现本机 hostname、临时目录、当前工作目录、平台名或用户名。
		const kept = a!.loserEntry!;
		const asText = JSON.stringify(kept);
		const leaked = [hostname(), tmpdir(), process.cwd(), process.platform, process.env.USER ?? ""]
			.filter((value) => value.length >= 4)
			.filter((value) => asText.includes(value));
		expect(leaked, `冲突副本里出现了本地状态：${JSON.stringify(leaked)}`).toEqual([]);

		// 三、名字的来源只有一个：原 name + 由这份内容算出的后缀。
		expect(kept.name).toBe(`A${conflictSuffix(ours.raw)}`);
		expect(kept.file.endsWith(`${fpOf(ours.raw)}${ENTRY_EXT}`)).toBe(true);
		// 完整字面值也钉死：只断言「以指纹结尾」抓不住指纹泄漏到 stem 中段、
		// 或用原路径名（`a.md`）而不是 entry 的 name 造 stem。指纹取自**败者原始字节**
		//（ours），不是重序列化之后的那一份 —— 与用户在 name 后缀里看到的指纹同源。
		expect(kept.file).toBe("A-(冲突-2026-11-09)-224c38.md");
		expect(kept.name).toBe("A (冲突 2026-11-09 224c38)");
	});

	it("★确定性（续）：占用清单里带 hash 的无关条目、原路径名本身，都不得影响产物", () => {
		const ours = side("A", "2026-11-09T10:00:00.000Z");
		const theirs = side("A", "2026-11-10T15:30:00.000Z");
		const plain = resolveConflict({ file: "a.md", ours, theirs }, []);
		const noisy = resolveConflict(
			// 原路径 `a.md` 自己就在占用清单里（它当然在）：这不是「派生名被占用」，产物不得因此改变
			{ file: "a.md", ours, theirs },
			["无关.md", "a.md", { file: "另一个.md", hash: "0".repeat(64) }, { file: "还一个.md" }],
		);
		expect(plain!.loserEntry).not.toBeNull();
		expect(noisy!.loserEntry).toEqual(plain!.loserEntry);
		expect(noisy!.winnerRaw).toBe(plain!.winnerRaw);
	});

	it("派生文件名已被同内容占用 → 复用（幂等，不加 -2）", () => {
		const input = () => ({
			file: "a.md",
			ours: side("A", "2026-11-09T10:00:00.000Z"),
			theirs: side("A", "2026-11-10T15:30:00.000Z"),
		});
		const out = resolveConflict(input(), []);
		const kept = out!.loserEntry!;
		// 占用者要带上 hash 才**证明**是同一份内容（接口规定：只给名字 = hash 未知 = 不做复用判断）。
		// 比的是「即将写下去的那份字节」的 hash —— name 已加后缀，与败者的原字节不同源。
		const again = resolveConflict(input(), [{ file: kept.file, hash: sha256Hex(kept.raw) }]);
		expect(again!.loserEntry!.file).toBe(kept.file);
		expect(again!.loserEntry!.raw).toBe(kept.raw);
		expect(kept.file).not.toMatch(/-2\.md$/);
	});

	it("占用者只给名字（hash 未知）→ 不做复用判断，一律走确定性追加", () => {
		const input = () => ({
			file: "a.md",
			ours: side("A", "2026-11-09T10:00:00.000Z"),
			theirs: side("A", "2026-11-10T15:30:00.000Z"),
		});
		const out = resolveConflict(input(), []);
		const again = resolveConflict(input(), [out!.loserEntry!.file]);
		// 证明不了「占用者就是同一份内容」时宁可多一个确定性名字，也不写穿别人的文件
		expect(again!.loserEntry!.file).not.toBe(out!.loserEntry!.file);
		expect(again!.loserEntry!.file).toMatch(/[0-9a-f]{6}\.md$/);
		expect(again!.loserEntry!.file).not.toMatch(/-2\.md$/);
	});

	it("派生文件名被不同内容占用 → 追加 sha256 前 6 位（确定性），不用 -2", () => {
		// -2 依赖本地目录状态，会让两台设备算出不同文件名
		const out = resolveConflict(
			{
				file: "a.md",
				ours: side("A", "2026-11-09T10:00:00.000Z"),
				theirs: side("A", "2026-11-10T15:30:00.000Z"),
			},
			[],
		);
		expect(out!.loserEntry!.file).toMatch(/[0-9a-f]{6}\.md$/);
		expect(out!.loserEntry!.file).not.toMatch(/-2\.md$/);
	});

	it("占用者是别的字节 → 在派生名后再追加一次败者自己的指纹（仍不用 -2）", () => {
		const input = () => ({
			file: "a.md",
			ours: side("A", "2026-11-09T10:00:00.000Z"),
			theirs: side("A", "2026-11-10T15:30:00.000Z"),
		});
		const base = resolveConflict(input(), [])!.loserEntry!;
		const again = resolveConflict(input(), [{ file: base.file, hash: sha256Hex("别的字节") }])!.loserEntry!;
		const fp = fpOf(input().ours.raw);
		expect(again.file).not.toBe(base.file);
		expect(again.file.startsWith(base.file.slice(0, -ENTRY_EXT.length))).toBe(true);
		expect(again.file.endsWith(`-${fp}${ENTRY_EXT}`)).toBe(true);
		expect(again.file).not.toMatch(/-2\.md$/);
		// 派生名的归宿是文件系统，所以问**写方向**谓词（全平台口径）
		expect(isEntryFileNameForWrite(again.file)).toBe(true);
		// name 与字节不随占用情况改变：变的只有落到哪个文件名
		expect(again.name).toBe(base.name);
		expect(again.raw).toBe(base.raw);
	});

	it("两边字节相同 → null（调用方不该送来，但不得抛）", () => {
		const ours = side("A", "2026-11-09T10:00:00.000Z");
		expect(resolveConflict({ file: "a.md", ours, theirs: ours }, [])).toBeNull();
		// 判据与差集同源（hash），所以「同内容的另一份对象」同样不算冲突
		expect(resolveConflict({ file: "a.md", ours, theirs: side("A", "2026-11-09T10:00:00.000Z") }, [])).toBeNull();
	});

	it("败者的 name 加后缀后撞长度上限 → 截断但仍保留 6 位指纹", () => {
		for (const longName of ["字".repeat(200), "n".repeat(200)]) {
			const ours = side(longName, "2026-11-09T10:00:00.000Z");
			const theirs = side(longName, "2026-11-10T15:30:00.000Z");
			const out = resolveConflict({ file: "a.md", ours, theirs }, []);
			const file = out!.loserEntry!.file;
			// 指纹在最后：截断只保留前缀，指纹留在中间就会被整段切掉
			expect(file.endsWith(`${fpOf(ours.raw)}${ENTRY_EXT}`)).toBe(true);
			expect(isEntryFileNameForWrite(file)).toBe(true);
			// entryFileName 的 stem 上限是 100 字节：截断确实发生了
			expect(Buffer.byteLength(file.slice(0, -ENTRY_EXT.length), "utf8")).toBeLessThanOrEqual(100);
			// 长度只约束**文件名**；entry 自己的 name 仍带完整后缀
			expect(parseEntryFile(out!.loserEntry!.raw)!.meta.name).toBe(`${longName}${conflictSuffix(ours.raw)}`);
			// 截断也是确定性的：再解一次，逐字节相同
			expect(resolveConflict({ file: "a.md", ours, theirs }, ["无关.md"])!.loserEntry).toEqual(
				out!.loserEntry,
			);
		}
	});

	it("删除 vs 修改：删除照办（winnerRaw = null），幸存的那份另存为新 entry", () => {
		const survivor = side("发布状态", "2026-11-10T15:30:00.000Z", "改写过的正文");
		const out = resolveConflict({ file: "发布状态.md", ours: null, theirs: survivor }, []);
		expect(out!.winnerRaw).toBeNull(); // 引擎据此把原路径放进 deletes
		const kept = out!.loserEntry!;
		expect(kept.name).toBe(`发布状态${conflictSuffix(survivor.raw)}`);
		expect(kept.raw).not.toBe(survivor.raw); // name 改了 → 字节必然不同
		const parsed = parseEntryFile(kept.raw)!;
		expect(parsed.meta).toMatchObject({
			created: "2026-11-09",
			modified: "2026-11-10T15:30:00.000Z",
			type: "feedback",
			description: "d",
		});
		expect(parsed.body).toBe("改写过的正文");
		expect(kept.file.endsWith(`${fpOf(survivor.raw)}${ENTRY_EXT}`)).toBe(true);
	});

	it("删除 vs 修改（镜像）：本地删、远端改 → 同样删除照办 + 幸存那份另存", () => {
		const survivor = side("A", "2026-11-10T15:30:00.000Z");
		const out = resolveConflict({ file: "a.md", ours: survivor, theirs: null }, []);
		expect(out!.winnerRaw).toBeNull();
		expect(out!.loserEntry!.name).toBe(`A${conflictSuffix(survivor.raw)}`);
		// 与「远端删、本地改」逐字节相同：产物只由幸存的那份内容决定，与它摆在哪一侧无关
		expect(resolveConflict({ file: "a.md", ours: null, theirs: survivor }, [])).toEqual(out);
	});

	it("删除 vs 修改的产物同样与本地上下文无关", () => {
		const survivor = side("A", "2026-11-10T15:30:00.000Z");
		const a = resolveConflict({ file: "a.md", ours: null, theirs: survivor }, []);
		const b = resolveConflict(
			{ file: "a.md", ours: null, theirs: survivor },
			["无关.md", { file: "另一个.md", hash: "f".repeat(64) }],
		);
		expect(a!.loserEntry).not.toBeNull();
		expect(b!.loserEntry).toEqual(a!.loserEntry);
	});

	it("两侧都为 null → null（差集不会送来，但不得抛）", () => {
		expect(resolveConflict({ file: "a.md", ours: null, theirs: null }, [])).toBeNull();
	});

	it("败者的字节解析不出 frontmatter → 抛错，而不是静默丢掉那份内容", () => {
		const good = side("A", "2026-11-10T15:30:00.000Z");
		// 新 entry 要靠 frontmatter 作者化（name/created/type 都得有）。做不到时返回 null 会把
		// 「无事可做」和「做不到」混成同一个信号 → 静默丢记忆，所以这里 fail-closed 抛出去。
		expect(() =>
			resolveConflict({ file: "a.md", ours: brokenSide("2026-11-09T10:00:00.000Z"), theirs: good }, []),
		).toThrow(/frontmatter/);
		expect(() => resolveConflict({ file: "a.md", ours: null, theirs: brokenSide("2026-11-09T10:00:00.000Z") }, []))
			.toThrow(/frontmatter/);
		// 胜者解析不出没关系：原路径是逐字写入，不需要 frontmatter
		const out = resolveConflict({ file: "a.md", ours: brokenSide("2026-11-11T00:00:00.000Z"), theirs: good }, []);
		expect(out!.winnerRaw).toBe(BROKEN_RAW);
		expect(out!.loserEntry!.name).toBe(`A${conflictSuffix(good.raw)}`);
	});

	it("纯函数：入参一个字段都没被改", () => {
		const ours = side("A", "2026-11-09T10:00:00.000Z");
		const theirs = side("A", "2026-11-10T15:30:00.000Z");
		const taken = ["无关.md", { file: "另一个.md", hash: "0".repeat(64) }];
		const beforeInput = JSON.stringify({ ours, theirs });
		const beforeTaken = JSON.stringify(taken);
		resolveConflict({ file: "a.md", ours, theirs }, taken);
		expect(JSON.stringify({ ours, theirs })).toBe(beforeInput);
		expect(JSON.stringify(taken)).toBe(beforeTaken);
	});
});
