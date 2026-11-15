import { describe, expect, it } from "vitest";
import {
	entryFileName,
	foldFileName,
	isEntryFileNameForRead,
	isEntryFileNameForWrite,
	resolveUniqueFileName,
} from "../src/store/filename.js";

describe("entryFileName", () => {
	it("keeps ASCII words and collapses whitespace to dashes", () => {
		expect(entryFileName("  Use real DB in tests  ")).toBe("Use-real-DB-in-tests.md");
	});

	it("preserves non-ASCII characters", () => {
		expect(entryFileName("集成测试必须连真实 PostgreSQL")).toBe("集成测试必须连真实-PostgreSQL.md");
	});

	it("preserves combining-emoji code points", () => {
		expect(entryFileName("部署 🔥 检查")).toBe("部署-🔥-检查.md");
	});

	it("replaces filesystem-unsafe characters", () => {
		expect(entryFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j.md");
	});

	it("strips control characters", () => {
		expect(entryFileName("a\u0000b\u001fc\u007f")).toBe("a_b_c_.md");
	});

	it("falls back to a hash when nothing usable remains", () => {
		expect(entryFileName("")).toMatch(/^entry-[0-9a-f]{8}\.md$/);
		expect(entryFileName("...")).toMatch(/^entry-[0-9a-f]{8}\.md$/);
		expect(entryFileName("..")).toMatch(/^entry-[0-9a-f]{8}\.md$/);
	});

	it("truncates to 100 bytes on a code-point boundary", () => {
		const stem = entryFileName("汉".repeat(80)).slice(0, -3);
		expect(Buffer.byteLength(stem, "utf8")).toBe(99);
		expect([...stem].every((ch) => ch === "汉")).toBe(true);
	});

	it("prefixes reserved Windows device names", () => {
		expect(entryFileName("CON")).toBe("_CON.md");
		expect(entryFileName("con")).toBe("_con.md");
		expect(entryFileName("nul")).toBe("_nul.md");
		expect(entryFileName("com1")).toBe("_com1.md");
		expect(entryFileName("lpt9")).toBe("_lpt9.md");
		expect(entryFileName("nul.tar.gz")).toBe("_nul.tar.gz.md");
	});

	it("leaves lookalike names alone", () => {
		expect(entryFileName("CONSOLE")).toBe("CONSOLE.md");
		expect(entryFileName("nul2")).toBe("nul2.md");
		expect(entryFileName("com10")).toBe("com10.md");
	});
});

describe("resolveUniqueFileName", () => {
	it("returns the base name when free", () => {
		expect(resolveUniqueFileName(["other.md"], "a.md")).toBe("a.md");
	});

	it("appends -2 when the base is taken", () => {
		expect(resolveUniqueFileName(["a.md"], "a.md")).toBe("a-2.md");
	});

	it("skips taken suffixes", () => {
		expect(resolveUniqueFileName(["a.md", "a-2.md", "a-3.md"], "a.md")).toBe("a-4.md");
	});
});

describe("foldFileName", () => {
	it("win32 与 darwin 折叠大小写，linux 不折叠", () => {
		expect(foldFileName("Foo.md", "win32")).toBe("foo.md");
		expect(foldFileName("Foo.md", "darwin")).toBe("foo.md");
		expect(foldFileName("Foo.md", "linux")).toBe("Foo.md");
	});
	it("先做 NFC 归一：NFD 的 é 与 NFC 的 é 折叠成同一个 key", () => {
		expect(foldFileName("e\u0301.md", "darwin")).toBe(foldFileName("\u00e9.md", "darwin"));
	});
});

describe("isEntryFileNameForRead / isEntryFileNameForWrite", () => {
	it("两个方向都只认单层 .md、排除索引与点开头", () => {
		for (const isEntry of [isEntryFileNameForRead, isEntryFileNameForWrite]) {
			expect(isEntry("foo.md")).toBe(true);
			expect(isEntry("中文 文件名.md")).toBe(true);
			for (const n of ["MEMORY.md", ".lock", ".hidden.md", "foo.txt", "foo", ""]) expect(isEntry(n)).toBe(false);
			// 含路径分隔符的一律排除
			expect(isEntry("sub/a.md")).toBe(false);
			expect(isEntry("a\\b.md")).toBe(false);
		}
	});

	it("读方向：保留设备名**只在 win32 上**排除 —— Linux 上 con.md 是一条合法记忆，不得消失", () => {
		expect(isEntryFileNameForRead("con.md", "win32")).toBe(false);
		expect(isEntryFileNameForRead("con.md", "linux")).toBe(true);
		expect(isEntryFileNameForRead("con.md", "darwin")).toBe(true);
	});

	it("写方向：保留设备名**全平台**排除，而且没有 platform 形参可以把口径放宽", () => {
		for (const n of ["con.md", "CON.md", "nul.md", "com1.md", "lpt9.md"]) expect(isEntryFileNameForWrite(n)).toBe(false);
		// 只有一个形参：调用方拿不到「按本机平台放宽」的逗口，而写下去的名字要在**每台**设备上能读
		expect(isEntryFileNameForWrite.length).toBe(1);
	});

	it("写方向恒不宽于读方向：读口径认不下的名字，写口径也一定认不下", () => {
		const names = ["foo.md", "con.md", "nul.md", "com1.md", "MEMORY.md", ".hidden.md", "sub/a.md", "a\\b.md", "foo"];
		for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
			for (const name of names) {
				if (!isEntryFileNameForRead(name, platform)) expect(isEntryFileNameForWrite(name)).toBe(false);
			}
		}
		// 反过来不成立（这正是两个谓词必须分开的原因）：Linux 上 `con.md` 读得到、写不得
		expect(isEntryFileNameForRead("con.md", "linux")).toBe(true);
		expect(isEntryFileNameForWrite("con.md")).toBe(false);
	});
});
