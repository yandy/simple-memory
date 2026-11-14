import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeEntryFile } from "../src/store/entry-file.js";
import { sha256Hex } from "../src/sync/hash.js";
import { scanLocalEntries } from "../src/sync/scan.js";
import { createReservedNameFixture, removeReservedNameFixture } from "./helpers/reserved-name.js";

const raw = (name: string, modified = "2026-11-09T10:00:00.000Z", body = "正文") =>
	serializeEntryFile({ name, description: "d", type: "feedback", created: "2026-11-09", modified }, body);

describe("scanLocalEntries", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-sync-scan-"));
	});
	afterEach(async () => {
		// 与 dream / memory-store-read 同契约：先经 helper 摘除保留名文件，
		// 否则 win32 上 rm(dir, { recursive: true }) 删不掉 con.md
		await removeReservedNameFixture(dir, "con.md");
		await rm(dir, { recursive: true, force: true });
	});

	it("给出每个 entry 的 sha256、frontmatter modified 与字节数", async () => {
		await writeFile(join(dir, "a.md"), raw("A", "2026-11-09T10:00:00.000Z"));
		const scan = await scanLocalEntries(dir);
		expect(scan.files.get("a.md")).toEqual({
			hash: sha256Hex(await readFile(join(dir, "a.md"), "utf8")),
			modified: "2026-11-09T10:00:00.000Z",
			bytes: Buffer.byteLength(raw("A", "2026-11-09T10:00:00.000Z"), "utf8"),
		});
		expect(scan.unparsable).toEqual([]);
	});

	it("解析不出的 .md 进 unparsable、不进 files（不同步但可报告）", async () => {
		await writeFile(join(dir, "bad.md"), "没有 frontmatter");
		const scan = await scanLocalEntries(dir);
		expect(scan.files.size).toBe(0);
		expect(scan.unparsable).toEqual(["bad.md"]);
	});

	it("忽略 MEMORY.md、.backups/、sessions/、.lock 与子目录", async () => {
		await writeFile(join(dir, "a.md"), raw("A"));
		await writeFile(join(dir, "b.md"), raw("B"));
		await writeFile(join(dir, "MEMORY.md"), "# Memory Index\n");
		await writeFile(join(dir, ".lock"), "");
		await mkdir(join(dir, ".backups"));
		await writeFile(join(dir, ".backups", "x.md"), raw("X"));
		await mkdir(join(dir, "sessions"));
		await writeFile(join(dir, "sessions", "s.md"), raw("S"));
		await mkdir(join(dir, "sub"));
		await writeFile(join(dir, "sub", "nested.md"), raw("N"));

		const scan = await scanLocalEntries(dir);
		// key 只有单层文件名，顺序稳定（排序后），两侧比对才拿得到同一形态的 key
		expect([...scan.files.keys()]).toEqual(["a.md", "b.md"]);
		expect(scan.unparsable).toEqual([]);
	});

	it("目录不存在 → 空结果，不抛", async () => {
		expect(await scanLocalEntries(join(dir, "nope"))).toEqual({ files: new Map(), unparsable: [] });
	});

	it(
		"win32 保留名文件在 win32 宿主上不被读内容（沿用 #entryFiles 的剔除理由）",
		{ skip: process.platform !== "win32" },
		async () => {
			await writeFile(join(dir, "a.md"), raw("A"));
			// 内容本身是合法的 frontmatter：若扫描去读了 con.md，它就会出现在 files 里。
			// 在 win32 上这一步恰好是「按名打开命中控制台」的现场，所以断言的是「没读」而不是「读出错」。
			await createReservedNameFixture(dir, "con.md", raw("CON"));
			const scan = await scanLocalEntries(dir);
			expect([...scan.files.keys()]).toEqual(["a.md"]);
			expect(scan.unparsable).toEqual([]);
		},
	);
});
