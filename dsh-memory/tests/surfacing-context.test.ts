import { afterEach, describe, expect, it, vi } from "vitest";
import { TASKS } from "@yandy0725/memory-core";
import type { HeadlessOutcome } from "@yandy0725/memory-core";
import { createPreStepListener } from "../src/surfacing.js";
import type { SurfacingDeps } from "../src/surfacing.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";
import { createUserMsg } from "./helpers/fake-ctx.js";

const { runTaskMock, scanEntriesMock } = vi.hoisted(() => ({
	runTaskMock: vi.fn(),
	scanEntriesMock: vi.fn(),
}));

vi.mock("@yandy0725/memory-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@yandy0725/memory-core")>();
	return {
		...actual,
		runTask: runTaskMock,
		scanEntries: scanEntriesMock,
	};
});

afterEach(() => {
	runTaskMock.mockReset();
	scanEntriesMock.mockReset();
});

describe("surfacing context wiring", () => {
	it("passes the full config object to runTask instead of pre-extracted budget values", async () => {
		const config = { autoSurfacing: { maxFiles: 7, maxEntryBytes: 999 } } as unknown as SessionMemoryRuntime["config"];
		const store = {} as SessionMemoryRuntime["store"];
		const rt: SessionMemoryRuntime = {
			sessionId: "s1",
			cwd: "/proj",
			config,
			store,
			memoryDir: "/mem",
			error: null,
			surfacing: { available: true, reason: null },
		};
		const deps: SurfacingDeps = {
			registry: { get: () => rt },
			indexCache: { refresh: vi.fn(async () => {}) },
			headless: { run: vi.fn(async (): Promise<HeadlessOutcome> => ({ status: "not-run", cause: "host-refused" })) },
			warn: vi.fn(),
			injected: new Map<string, Set<string>>(),
		};

		scanEntriesMock.mockResolvedValue([
			{ file: "a.md", name: "A", description: "d", type: "project", modified: "2026-01-01T00:00:00.000Z" },
		]);
		runTaskMock.mockResolvedValue({ files: [], content: "" });

		const user = createUserMsg("hi");
		const decision = await createPreStepListener(deps)(
			{
				agent: { session: { id: "s1" } },
				messages: [user],
				turn: 1,
				step: 1,
				signal: new AbortController().signal,
			},
			async () => ({ kind: "enter" as const, messages: [user] }),
		);

		expect(decision.kind).toBe("enter");
		expect(runTaskMock).toHaveBeenCalledTimes(1);
		expect(runTaskMock.mock.calls[0][0]).toBe(TASKS.autoSurfacing);
		const input = runTaskMock.mock.calls[0][1];
		const ctx = runTaskMock.mock.calls[0][2];
		expect(ctx.cfg).toBe(config);
		expect(ctx.cwd).toBe("/mem");
		expect(ctx.store).toBe(store);
		expect(ctx.ports.headless).toBe(deps.headless);
		// 配置值不再经适配层转手：input 只有宿主数据，没有 maxFiles / maxEntryBytes。
		expect(Object.keys(input).sort()).toEqual(["injectedFiles", "manifest", "userPrompt"]);
		expect((input as { maxFiles?: number }).maxFiles).toBeUndefined();
		expect((input as { maxEntryBytes?: number }).maxEntryBytes).toBeUndefined();
	});
});
