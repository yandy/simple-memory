import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	MAIN_AGENT_ACTIONS,
	MEMORY_TOOL_DESCRIPTION,
	MEMORY_TOOL_NAME,
	MemoryStore,
	mergeConfig,
	memoryToolSchema,
} from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_SCHEMA, createMemoryTool } from "../src/memory-tool.js";
import type { MemoryToolDeps } from "../src/memory-tool.js";
import type { SessionMemoryRuntime } from "../src/store-registry.js";
import { createFakeCtx } from "./helpers/fake-ctx.js";

/** 测试级临时目录总根：所有记忆目录都建在它下面，`afterEach` 一次 `rm -rf` 全清。 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "am-mt-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 从不污染 DEFAULT_CONFIG 的副本派生一份合法的 MemoryConfig，只覆盖 memoryDir。 */
function makeConfig(memoryDir: string): MemoryConfig {
	return mergeConfig(structuredClone(DEFAULT_CONFIG), { memoryDir });
}

function makeStore(memoryDir: string): MemoryStore {
	const cfg = makeConfig(memoryDir);
	return new MemoryStore({
		memoryDir,
		indexMaxLines: cfg.memIndexMaxLines,
		indexMaxBytes: cfg.memIndexMaxBytes,
		lock: cfg.lock,
	});
}

function makeRuntime(
	memoryDir: string,
	store: MemoryStore | null,
	over: Partial<SessionMemoryRuntime> = {},
): SessionMemoryRuntime {
	const base: SessionMemoryRuntime = {
		sessionId: "s1",
		cwd: join(dir, "cwd"),
		config: makeConfig(memoryDir),
		store,
		memoryDir,
		error: null,
		surfacing: { available: true, reason: null },
	};
	return { ...base, ...over };
}

function makeDeps(over: Partial<MemoryToolDeps> = {}): MemoryToolDeps {
	return { searchSessions: vi.fn(async () => "no session matches"), ...over };
}

/** 宿主 `snapshotJsonValue` 拒绝值里**任何位置**的 `undefined`：递归扫对象与数组。 */
function collectUndefinedPaths(value: unknown, path = "$"): string[] {
	if (value === undefined) return [path];
	if (Array.isArray(value)) return value.flatMap((item, i) => collectUndefinedPaths(item, `${path}[${i}]`));
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([k, v]) => collectUndefinedPaths(v, `${path}.${k}`));
	}
	return [];
}

/** dsh 强制的 JSON Schema 子集（spec §5.6 / D8）：任何其它关键字都会被 `schemaValidate` 拒绝。 */
const ALLOWED_SCHEMA_KEYS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"examples",
]);

/**
 * 递归收集 schema 树里每个 schema 节点的**关键字**。
 *
 * `properties` 的值是 `参数名 → 子 schema` 的映射：它的键是参数名（`action`/`name`/…），不是
 * JSON Schema 关键字，所以只往下递归**值**；`required` / `enum` 的数组元素是数据，不产生键。
 */
function collectSchemaKeywords(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => collectSchemaKeywords(item));
	if (value !== null && typeof value === "object") {
		const out: string[] = [];
		for (const [key, sub] of Object.entries(value)) {
			out.push(key);
			if (key === "properties") {
				for (const subSchema of Object.values(sub as Record<string, unknown>)) {
					out.push(...collectSchemaKeywords(subSchema));
				}
			} else {
				out.push(...collectSchemaKeywords(sub));
			}
		}
		return out;
	}
	return [];
}

describe("createMemoryTool", () => {
	it("uses MEMORY_TOOL_NAME and MEMORY_TOOL_DESCRIPTION verbatim from core", () => {
		const rt = makeRuntime(join(dir, "mem"), null);
		const tool = createMemoryTool(rt, makeDeps());

		expect(tool.name).toBe(MEMORY_TOOL_NAME);
		expect(tool.description).toBe(MEMORY_TOOL_DESCRIPTION);
	});

	it("passes memoryToolSchema(MAIN_AGENT_ACTIONS) through as parameters byte-identically", () => {
		const rt = makeRuntime(join(dir, "mem"), null);
		const tool = createMemoryTool(rt, makeDeps());

		// toEqual 深比较：模型看到的线格式必须与 pi 逐字相同，绝不转成 dsh 的 authoring DSL。
		expect(tool.parameters).toEqual(memoryToolSchema(MAIN_AGENT_ACTIONS));
	});

	it("uses only host-supported JSON Schema subset keywords at every node", () => {
		const rt = makeRuntime(join(dir, "mem"), null);
		const tool = createMemoryTool(rt, makeDeps());

		const keys = collectSchemaKeywords(tool.parameters);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(ALLOWED_SCHEMA_KEYS.has(key), `schema keyword not allowed by dsh: ${key}`).toBe(true);
		}
	});

	it("writes an entry file and index line on disk and returns the Saved content", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const tool = createMemoryTool(rt, makeDeps());

		const result = await tool.execute({ action: "add", name: "N", content: "C" }, {});

		expect(result).toEqual({ content: 'Saved "N" (N.md).' });
		expect(existsSync(join(memoryDir, "N.md"))).toBe(true);
		const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
		expect(index).toContain("[N](N.md)");
	});

	it("returns a value with no undefined anywhere, even after a real successful write", async () => {
		const memoryDir = join(dir, "mem");
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store);
		const tool = createMemoryTool(rt, makeDeps());

		// add 走 core 的 details 分支：details.capacityWarning 是 string | undefined，大多数成功写入
		// 都会带上一个值为 undefined 的键。这条递归扫描就是「真宿主上每写必炸 vs 能用」的分界线。
		const result = await tool.execute({ action: "add", name: "N", content: "C" }, {});
		expect(collectUndefinedPaths(result)).toEqual([]);
	});

	it("renders output.render as a single text block with the content string", () => {
		const rt = makeRuntime(join(dir, "mem"), null);
		const tool = createMemoryTool(rt, makeDeps());

		expect(tool.output.schema).toEqual(OUTPUT_SCHEMA);
		expect(tool.output.render({}, { content: "hi" })).toEqual([{ type: "text", text: "hi" }]);
	});

	it("throws with rt.error when rt.store is null", async () => {
		const rt = makeRuntime(join(dir, "unused"), null, { error: "row config is broken" });
		const tool = createMemoryTool(rt, makeDeps());

		await expect(tool.execute({ action: "list" }, {})).rejects.toThrow("row config is broken");
	});

	it("delegates scope=sessions search to deps.searchSessions with rt.cwd and rt.config.sessionSearch", async () => {
		const memoryDir = join(dir, "mem");
		const cwd = join(dir, "project");
		const sessionSearch = { maxSessions: 7, maxMatches: 3 };
		const store = makeStore(memoryDir);
		const rt = makeRuntime(memoryDir, store, {
			cwd,
			config: mergeConfig(makeConfig(memoryDir), { sessionSearch }),
		});
		const searchSessions = vi.fn(async () => "found sessions");
		const tool = createMemoryTool(rt, { searchSessions });

		const result = await tool.execute({ action: "search", scope: "sessions", query: "hello" }, {});

		expect(result).toEqual({ content: "found sessions" });
		expect(searchSessions).toHaveBeenCalledExactlyOnceWith(cwd, "hello", sessionSearch);
	});

	it("isConcurrencySafe is total and returns true only for list/search", () => {
		const rt = makeRuntime(join(dir, "mem"), null);
		const tool = createMemoryTool(rt, makeDeps());

		expect(tool.isConcurrencySafe({ action: "list" })).toBe(true);
		expect(tool.isConcurrencySafe({ action: "search" })).toBe(true);
		expect(tool.isConcurrencySafe({ action: "add" })).toBe(false);
		expect(tool.isConcurrencySafe(undefined)).toBe(false);
		// 宿主调度器可能回放或塞进畸形 args：null / {} / 非对象都不许抛。
		expect(tool.isConcurrencySafe(null as unknown as { action?: string } | undefined)).toBe(false);
		expect(tool.isConcurrencySafe({} as { action?: string } | undefined)).toBe(false);
	});

	it("registers cleanly through the fake ctx agentTools path", () => {
		const { makeAgent, agentTools } = createFakeCtx();
		const agent = makeAgent({ id: "s1" });
		const rt = makeRuntime(join(dir, "mem"), null);
		const tool = createMemoryTool(rt, makeDeps());

		// validateToolDefinition：output 存在、output.schema 存在、output.render 是函数，否则 TypeError。
		expect(() => (agent as any).ctx.tools.register(tool)).not.toThrow();

		const registered = agentTools.get("s1");
		expect(registered).toHaveLength(1);
		expect(registered?.[0].name).toBe(MEMORY_TOOL_NAME);
		expect((registered?.[0].output as { schema: unknown }).schema).toEqual(OUTPUT_SCHEMA);
	});
});
