import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devicePath, loadOrCreateDevice } from "../src/sync/device.js";

/** 标准 uuid 的形状（小写十六进制、8-4-4-4-12）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 落盘口径：tab 缩进 + 末尾换行（与 manifest 同一种写法）。 */
function serialize(device: unknown): string {
	return `${JSON.stringify(device, null, "\t")}\n`;
}

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

	// 跨进程持久化的真正证明：没有这一条，「id 稳定」只证明了同进程内两次调用一致 ——
	// 一个模块级缓存也能过。而这个 id 的用途是提交作者与 status 报告，跨进程稳定才是它存在的理由。
	it("★读到一份完整合法的 device.json 时原样返回，且一个字节都不重写", async () => {
		const seeded = { id: "device-a", hostname: "old-host", createdAt: "2020-01-01T00:00:00.000Z" };
		await writeFile(devicePath(syncRoot), serialize(seeded), "utf8");
		const before = await readFile(devicePath(syncRoot), "utf8");

		const d = await loadOrCreateDevice(syncRoot);

		// 原样返回：手写过的 id 不被 uuid 形状"修正"，hostname 也不刷新成当前主机名
		//（稳定身份优先于"当前状态"，报告里显示旧名是这条选择的代价）。
		expect(d).toEqual(seeded);
		expect(await readFile(devicePath(syncRoot), "utf8")).toBe(before);
	});

	it("id 是空白、含控制字符或超长 → 视为不合法、重新生成（它会进提交作者与 status 文案）", async () => {
		const createdAt = "2020-01-01T00:00:00.000Z";
		for (const id of ["", " ", "\n", "a\u001b[31mred", "x".repeat(200)]) {
			await writeFile(devicePath(syncRoot), serialize({ id, hostname: "h", createdAt }), "utf8");

			const d = await loadOrCreateDevice(syncRoot);

			expect(d.id).not.toBe(id);
			expect(d.id).toMatch(UUID_RE);
		}
	});

	it("hostname 同一条下限：空白、控制字符、超长都算坏文件", async () => {
		const createdAt = "2020-01-01T00:00:00.000Z";
		for (const host of ["", "  ", "a\u001b[31mred", "h".repeat(200)]) {
			await writeFile(devicePath(syncRoot), serialize({ id: "device-a", hostname: host, createdAt }), "utf8");

			const d = await loadOrCreateDevice(syncRoot);

			expect(d.hostname).not.toBe(host);
			expect(d.hostname.length).toBeGreaterThan(0);
		}
	});

	it(
		"文件存在但读不了（非 ENOENT）→ 抛错，绝不静默重铸身份",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		async () => {
			// 把 EACCES/EIO 当成"没有文件"就会走创建分支并覆盖掉，提交作者身份被静默换掉 ——
			// 正是本模块注释反对的那件事。
			const first = await loadOrCreateDevice(syncRoot);
			await chmod(devicePath(syncRoot), 0o000);

			await expect(loadOrCreateDevice(syncRoot)).rejects.toMatchObject({ code: "EACCES" });

			// 文件一个字节都没变：抛错的那次没有偷偷重写身份。
			await chmod(devicePath(syncRoot), 0o644);
			expect(JSON.parse(await readFile(devicePath(syncRoot), "utf8"))).toEqual(first);
		},
	);

	it("并发首次运行：两个调用方返回的 id 都与盘上一致（不会各自返回一个已被覆盖的 id）", async () => {
		const [a, b] = await Promise.all([loadOrCreateDevice(syncRoot), loadOrCreateDevice(syncRoot)]);

		const onDisk = JSON.parse(await readFile(devicePath(syncRoot), "utf8"));

		expect(a.id).toBe(onDisk.id);
		expect(b.id).toBe(onDisk.id);
		expect(a).toEqual(onDisk);
		expect(b).toEqual(onDisk);
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

	// 只说它能证明的事：写完不留临时文件。rename/link 的原子性从外部看不见，
	// 拿一条「目录里没有残渣」的断言去暗示原子性，是把断言读成了承诺。
	it("写完不留临时文件：目录里只剩 device.json", async () => {
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
