import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/sync/hash.js";
import {
	emptyManifest,
	MANIFEST_VERSION,
	manifestPath,
	readManifest,
	type SyncManifest,
	writeManifest,
} from "../src/sync/manifest.js";

describe("sha256Hex", () => {
	it("输出 64 位小写十六进制，且与 createHash 同值", () => {
		expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc", "utf8").digest("hex"));
		expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("readManifest / writeManifest", () => {
	let dir: string;
	const transport = { remoteHash: "a".repeat(64), branch: "main" };

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-sync-manifest-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("往返：写进去再读出来逐字段相等", async () => {
		const path = join(dir, "state/project.json");
		const manifest: SyncManifest = {
			version: MANIFEST_VERSION,
			transport,
			base: { revision: "abc123", syncedAt: "2026-11-14T00:00:00.000Z" },
			files: {
				"A.md": { hash: sha256Hex("a"), modified: "2026-11-13T01:02:03.000Z", bytes: 42 },
				"B.md": { hash: sha256Hex("b"), modified: "2026-11-12T04:05:06.000Z", bytes: 7 },
			},
		};

		await writeManifest(path, manifest);

		expect(await readManifest(path)).toEqual(manifest);
	});

	it("文件不存在 → null", async () => {
		expect(await readManifest(join(dir, "state/nope.json"))).toBeNull();
	});

	it("JSON 坏掉 → null（不抛）", async () => {
		const path = join(dir, "broken.json");
		await writeFile(path, "{{{", "utf8");

		expect(await readManifest(path)).toBeNull();
	});

	it("version 不认识 → null", async () => {
		const path = join(dir, "future.json");
		await writeFile(
			path,
			JSON.stringify({ version: 99, transport, base: { revision: "r", syncedAt: "now" }, files: {} }),
			"utf8",
		);

		expect(await readManifest(path)).toBeNull();
	});

	it("v1 与缺 transport 的清单一律按无 base 处理", async () => {
		const old = join(dir, "v1.json");
		await writeFile(old, JSON.stringify({ version: 1, base: { revision: "old", syncedAt: "then" }, files: {} }), "utf8");
		expect(await readManifest(old)).toBeNull();

		const noTransport = join(dir, "no-transport.json");
		await writeFile(
			noTransport,
			JSON.stringify({ version: 2, base: { revision: "old", syncedAt: "then" }, files: {} }),
			"utf8",
		);
		expect(await readManifest(noTransport)).toBeNull();
	});

	it("缺 base 或 files → null", async () => {
		const noBase = join(dir, "no-base.json");
		await writeFile(noBase, JSON.stringify({ version: MANIFEST_VERSION, transport, files: {} }), "utf8");
		expect(await readManifest(noBase)).toBeNull();

		const noFiles = join(dir, "no-files.json");
		await writeFile(
			noFiles,
			JSON.stringify({ version: MANIFEST_VERSION, transport, base: { revision: "", syncedAt: "" } }),
			"utf8",
		);
		expect(await readManifest(noFiles)).toBeNull();
	});

	it("base 或 files 形状不对 → null（不抛）", async () => {
		const badRevision = join(dir, "bad-revision.json");
		await writeFile(
			badRevision,
			JSON.stringify({ version: MANIFEST_VERSION, transport, base: { revision: 7, syncedAt: "" }, files: {} }),
			"utf8",
		);
		expect(await readManifest(badRevision)).toBeNull();

		const arrayFiles = join(dir, "array-files.json");
		await writeFile(
			arrayFiles,
			JSON.stringify({ version: MANIFEST_VERSION, transport, base: { revision: "", syncedAt: "" }, files: [] }),
			"utf8",
		);
		expect(await readManifest(arrayFiles)).toBeNull();

		const badEntry = join(dir, "bad-entry.json");
		await writeFile(
			badEntry,
			JSON.stringify({
				version: MANIFEST_VERSION,
				transport,
				base: { revision: "", syncedAt: "" },
				files: { "A.md": { hash: "x", modified: "y" }, "B.md": { hash: 1, modified: "y", bytes: 1 } },
			}),
			"utf8",
		);
		expect(await readManifest(badEntry)).toBeNull();
	});

	it("writeManifest 自动建父目录，且不留临时文件", async () => {
		await writeManifest(join(dir, "state/deep/x.json"), emptyManifest(transport));

		expect(await readdir(join(dir, "state/deep"))).toEqual(["x.json"]);
	});

	it("emptyManifest 必须显式绑定 transport，syncTransport 只存 origin 的 sha256", async () => {
		expect(emptyManifest(transport)).toEqual({
			version: 2,
			transport,
			base: { revision: "", syncedAt: "" },
			files: {},
		});
		const { syncTransport } = await import("../src/sync/manifest.js");
		expect(syncTransport("https://token@example.invalid/o/r.git", "main")).toEqual({
			remoteHash: createHash("sha256").update("https://token@example.invalid/o/r.git", "utf8").digest("hex"),
			branch: "main",
		});
	});

	it("manifestPath 用 projectKey 做文件名", () => {
		expect(manifestPath("/root/.sync", "github.com__o__r")).toBe(join("/root/.sync", "state", "github.com__o__r.json"));
	});
});
