import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devicePath, loadOrCreateDevice } from "../src/sync/device.js";

/** 标准 uuid 的形状（小写十六进制、8-4-4-4-12）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("loadOrCreateDevice", () => {
	let syncRoot: string;

	beforeEach(async () => {
		syncRoot = await mkdtemp(join(tmpdir(), "mem-sync-device-"));
	});
	afterEach(async () => {
		await rm(syncRoot, { recursive: true, force: true });
	});

	it("首次创建并落盘：id 是 uuid、hostname 非空、createdAt 是 ISO", async () => {
		const d = await loadOrCreateDevice(syncRoot);
		expect(d.id).toMatch(UUID_RE);
		expect(d.hostname.length).toBeGreaterThan(0);
		expect(new Date(d.createdAt).toISOString()).toBe(d.createdAt);
		expect(JSON.parse(await readFile(devicePath(syncRoot), "utf8"))).toEqual(d);
	});

	it("第二次读到同一份（id 稳定，否则提交作者与 status 报告每次都变）", async () => {
		expect(await loadOrCreateDevice(syncRoot)).toEqual(await loadOrCreateDevice(syncRoot));
	});

	it("文件坏掉 → 重新生成一份，不抛", async () => {
		await writeFile(devicePath(syncRoot), "{{{", "utf8");

		const d = await loadOrCreateDevice(syncRoot);

		expect(d.id).toMatch(UUID_RE);
		expect(JSON.parse(await readFile(devicePath(syncRoot), "utf8"))).toEqual(d);
	});

	it("缺字段 → 重新生成一份", async () => {
		await writeFile(devicePath(syncRoot), JSON.stringify({ id: "x" }), "utf8");

		const d = await loadOrCreateDevice(syncRoot);

		expect(d.id).toMatch(UUID_RE);
		expect(d.id).not.toBe("x");
		expect(JSON.parse(await readFile(devicePath(syncRoot), "utf8"))).toEqual(d);
	});

	it("字段类型不对也算坏文件（不把垃圾当身份）", async () => {
		await writeFile(
			devicePath(syncRoot),
			JSON.stringify({ id: 42, hostname: "h", createdAt: "2026-11-14T00:00:00.000Z" }),
			"utf8",
		);

		const d = await loadOrCreateDevice(syncRoot);

		expect(d.id).toMatch(UUID_RE);
	});

	it("createdAt 来自注入的时钟（默认取当前时间）", async () => {
		const fixed = new Date("2026-11-14T00:00:00.000Z");

		const d = await loadOrCreateDevice(syncRoot, () => fixed);

		expect(d.createdAt).toBe(fixed.toISOString());
	});

	it("落盘是原子的：目录里只剩 device.json，没有临时文件", async () => {
		await loadOrCreateDevice(syncRoot);

		expect(await readdir(syncRoot)).toEqual(["device.json"]);
	});

	it("syncRoot 还不存在时自己建（首次同步时 .sync 可能还没人建过）", async () => {
		const nested = join(syncRoot, "a", "b");

		const d = await loadOrCreateDevice(nested);

		expect(JSON.parse(await readFile(devicePath(nested), "utf8"))).toEqual(d);
	});

	it("devicePath 指向 <syncRoot>/device.json", () => {
		expect(devicePath(join("/root", ".sync"))).toBe(join("/root", ".sync", "device.json"));
	});
});
