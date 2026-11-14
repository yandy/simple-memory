import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeEntryFile } from "../src/store/entry-file.js";
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
			// 摘要钉死成常量而不是用同一函数对同一份现场重算：重算是同义反复，测不出「hash 打错了内容」。
			// 若 serializeEntryFile 的序列化形状变化，这个常量必须被刻意更新（夹具：raw("A", "2026-11-09T10:00:00.000Z")）。
			hash: "224c3830cee72a0c23c41035e979c4e8db58f8a63586598c6444c23cd3de2e28",
			modified: "2026-11-09T10:00:00.000Z",
			// bytes 保持现算：夹具正文是 CJK，字节数 ≠ 字符数，足以抓住「用了 raw.length」。
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

	it(
		"单个文件读不了（权限）→ 该文件进 unparsable，其余文件照常扫描",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		async () => {
			// 与「目录读不了」同理：win32 上 chmod 造不出「存在但读不了」，root 下 chmod 不拦自己。
			// 单个坏文件可报告可跳过，与整目录读不了必须中止是两条不同分支，都要有测试压住。
			await writeFile(join(dir, "locked.md"), raw("L"));
			await writeFile(join(dir, "ok.md"), raw("O"));
			await chmod(join(dir, "locked.md"), 0o000);
			try {
				const scan = await scanLocalEntries(dir);
				expect([...scan.files.keys()]).toEqual(["ok.md"]);
				expect(scan.unparsable).toEqual(["locked.md"]);
			} finally {
				await chmod(join(dir, "locked.md"), 0o644);
			}
		},
	);

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

	it("目录不存在（ENOENT）→ 空结果，不抛", async () => {
		expect(await scanLocalEntries(join(dir, "nope"))).toEqual({ files: new Map(), unparsable: [] });
	});

	it(
		"目录读不了（非 ENOENT）→ 抛错，绝不当成空目录",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		async () => {
			// 数据安全线：一次 EACCES 被当成「目录是空的」，会让三方合并把「用户删光了记忆」
			// 传播到远端。win32 上 chmod 无效、root 下 chmod 不拦自己，所以这两种情形跳过。
			await writeFile(join(dir, "a.md"), raw("A"));
			await chmod(dir, 0o000);
			try {
				await expect(scanLocalEntries(dir)).rejects.toThrow();
			} finally {
				await chmod(dir, 0o755); // afterEach 的 rm 需要能进去
			}
		},
	);

	it("目录 / FIFO 这类非普通文件既不进 files 也不进 unparsable（与 listEntries 同口径，且不会被 FIFO 阻塞）", async () => {
		await mkdir(join(dir, "dir.md"));
		await writeFile(join(dir, "a.md"), raw("A"));
		const scan = await scanLocalEntries(dir);
		expect([...scan.files.keys()]).toEqual(["a.md"]);
		expect(scan.unparsable).toEqual([]);
	});

	it(
		"指向 entry 文件的符号链接仍然可见（store 的 stat 跟随链接，扫描必须同口径）",
		{ skip: process.platform === "win32" },
		async () => {
			await writeFile(join(dir, "real.md"), raw("R"));
			await symlink(join(dir, "real.md"), join(dir, "link.md"));
			const scan = await scanLocalEntries(dir);
			expect([...scan.files.keys()].sort()).toEqual(["link.md", "real.md"]);
			expect(scan.files.get("link.md")?.hash).toBe(scan.files.get("real.md")?.hash);
		},
	);

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
