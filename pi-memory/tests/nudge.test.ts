import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: {
		list: async (cwd: string) => {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			try {
				return (await fs.readdir(join(cwd, "__sessions__"))).map((f) => ({ path: f }));
			} catch {
				return [];
			}
		},
	},
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/tmp/agent",
}));

import { readDreamMeta, shouldNudge, formatNudge } from "../src/nudge";
import { PI_HOST_DEFAULTS, readPiHostConfig } from "../src/config";

describe("formatNudge", () => {
	it("formats session + new-entry counts", () => {
		expect(formatNudge(8, 3)).toContain("8 sessions");
		expect(formatNudge(8, 3)).toContain("3 new entries");
		expect(formatNudge(8, 3)).toContain("/dream");
	});
});

describe("readDreamMeta", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mem-nudge-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("returns null when no meta file", async () => {
		expect(await readDreamMeta(dir)).toBeNull();
	});
	it("reads meta json", async () => {
		await writeFile(join(dir, ".dream-meta.json"), JSON.stringify({ lastDreamAt: "2026-07-01T00:00:00.000Z", sessionCountAtDream: 3 }));
		const m = await readDreamMeta(dir);
		expect(m?.lastDreamAt).toBe("2026-07-01T00:00:00.000Z");
		expect(m?.sessionCountAtDream).toBe(3);
	});
});

// 默认值住在 pi（core 的 `DEFAULT_CONFIG.dream` 不再有这两个键）：5 / 24 是用户契约，值原样搬。
describe("PI_HOST_DEFAULTS", () => {
	it("keeps the 5 / 24 defaults when memory.json says nothing", () => {
		expect(PI_HOST_DEFAULTS).toEqual({ nudgeAfterSessions: 5, nudgeAfterHours: 24 });
	});
});

describe("readPiHostConfig", () => {
	it("reads the two keys from the same overlay object and ignores everything else", () => {
		expect(readPiHostConfig({ dream: { nudgeAfterSessions: 2, nudgeAfterHours: 6, model: "x" } })).toEqual({
			nudgeAfterSessions: 2,
			nudgeAfterHours: 6,
		});
	});

	it("falls back to defaults on a wrong type instead of throwing", () => {
		expect(readPiHostConfig({ dream: { nudgeAfterSessions: "2" } }).nudgeAfterSessions).toBe(5);
	});

	// 配置文件的任何形态都可能出现：空、不是对象、dream 不是对象、数值是 NaN/Infinity。全部落回默认值。
	it("never throws and always yields a complete config on garbage input", () => {
		for (const garbage of [undefined, null, 0, "", "x", [], [1, 2], { dream: null }, { dream: 5 }, { dream: [] }]) {
			expect(readPiHostConfig(garbage), JSON.stringify(garbage)).toEqual(PI_HOST_DEFAULTS);
		}
		expect(readPiHostConfig({ dream: { nudgeAfterSessions: Number.NaN } }).nudgeAfterSessions).toBe(5);
		expect(readPiHostConfig({ dream: { nudgeAfterHours: Number.POSITIVE_INFINITY } }).nudgeAfterHours).toBe(24);
	});

	it("accepts 0 as a configured value (it is a finite number, not a missing key)", () => {
		expect(readPiHostConfig({ dream: { nudgeAfterSessions: 0 } })).toEqual({
			nudgeAfterSessions: 0,
			nudgeAfterHours: 24,
		});
	});
});

describe("shouldNudge", () => {
	let dir: string;
	let cwd: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "mem-nudge-"));
		cwd = await mkdtemp(join(tmpdir(), "mem-nudge-cwd-"));
		await mkdir(join(cwd, "__sessions__"), { recursive: true });
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	});

	it("nudges when enough sessions passed since last dream", async () => {
		await writeFile(join(dir, ".dream-meta.json"), JSON.stringify({ lastDreamAt: new Date(Date.now() - 48 * 3600_000).toISOString(), sessionCountAtDream: 2 }));
		// create 8 fake session files
		for (let i = 0; i < 8; i++) await writeFile(join(cwd, "__sessions__", `s${i}.jsonl`), "{}");
		const r = await shouldNudge(dir, PI_HOST_DEFAULTS, cwd);
		expect(r.nudge).toBe(true);
		expect(r.sessions).toBe(8);
		expect(r.newEntries).toBe(6); // 8 sessions - 2 at last dream
	});
	it("does not nudge when recent dream", async () => {
		await writeFile(join(dir, ".dream-meta.json"), JSON.stringify({ lastDreamAt: new Date().toISOString(), sessionCountAtDream: 0 }));
		const r = await shouldNudge(dir, PI_HOST_DEFAULTS, cwd);
		expect(r.nudge).toBe(false);
	});

	// 「阈值来自 host，而不是 core 的 config」：3 个会话就提醒，而默认值是 5。
	it("nudges after the configured number of sessions when no dream has run", async () => {
		const host = { nudgeAfterSessions: 3, nudgeAfterHours: 24 };
		for (let i = 0; i < 2; i++) await writeFile(join(cwd, "__sessions__", `s${i}.jsonl`), "{}");
		expect((await shouldNudge(dir, host, cwd)).nudge).toBe(false);
		// 3 个会话后
		await writeFile(join(cwd, "__sessions__", "s2.jsonl"), "{}");
		expect((await shouldNudge(dir, host, cwd)).nudge).toBe(true);
	});
});
