import { ENTRY_TRUNCATION_MARKER } from "@yandy0725/memory-core";
import { describe, expect, it, vi } from "vitest";
import { createSessionSearch } from "../src/session-search.js";
import { createFakeCtx } from "./helpers/fake-ctx.js";
import type { FakeSessionInfo } from "./helpers/fake-ctx.js";

const CWD = "/proj";
const CFG = { maxSessions: 10, maxMatches: 5 };

function textBlock(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

function userMessage(text: string, kind = "user"): { type: string; data: unknown } {
	return { type: "user/message", data: { content: [textBlock(text)], source: { kind } } };
}

function assistantMessage(text: string): { type: string; data: unknown } {
	return { type: "assistant/message", data: { message: { content: [textBlock(text)] } } };
}

function toolCall(name: string, args: string): { type: string; data: unknown } {
	return { type: "tool/call", data: { name, arguments: args } };
}

function toolResult(content: string, error?: { name: string; code: string }): { type: string; data: unknown } {
	return { type: "tool/result", data: { message: { content: [textBlock(content)] }, ...(error ? { error } : {}) } };
}

function session(id: string, events: Array<{ type: string; data: unknown }>, createdAt?: number): FakeSessionInfo {
	return { id, cwd: CWD, events, ...(createdAt !== undefined ? { createdAt } : {}) };
}

/** 用假 ctx 的 `sessionQuery` 构造一个真实的 `createSessionSearch` 实例。 */
function search(ctx: { sessionQuery: unknown }, query: string, cfg = CFG): Promise<string> {
	return createSessionSearch(ctx.sessionQuery as never)(CWD, query, cfg);
}

describe("createSessionSearch", () => {
	it("returns the matching session and omits the non-matching one", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello world")]), session("s2", [userMessage("goodbye")])],
		});

		const out = await search(ctx, "hello");

		expect(out).toContain("## Session s1");
		expect(out).not.toContain("## Session s2");
	});

	it("returns the byte-identical no-match string when nothing matches", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("goodbye")])] });

		expect(await search(ctx, "zzz")).toBe("No matches in sessions.");
	});

	it("maxSessions takes the most recent N sessions (newest-first), not fixture order", async () => {
		const { ctx } = createFakeCtx({
			sessions: [
				session("old", [userMessage("hello old")], 1000),
				session("new", [userMessage("hello new")], 2000),
			],
		});

		const out = await search(ctx, "hello", { maxSessions: 1, maxMatches: 5 });

		expect(out).toContain("## Session new");
		expect(out).not.toContain("## Session old");
	});

	it("maxMatches caps multiple matches within a single session to one hit", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello one"), userMessage("hello two")])],
		});

		const out = await search(ctx, "hello", { maxSessions: 10, maxMatches: 1 });

		expect(out).toContain("Found 1 match(es):");
		expect((out.match(/## Session /g) ?? []).length).toBe(1);
	});

	it("synthetic user/message with a real host kind (skill-invocation) is not searchable", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello from the harness", "skill-invocation")])],
		});

		expect(await search(ctx, "hello")).toBe("No matches in sessions.");
	});

	it("human user/message (source.kind === 'user') with the identical text is searchable", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello from the harness", "user")])],
		});

		expect(await search(ctx, "hello")).toContain("## Session s1");
	});

	it("unknown/future source.kind is not searchable (allowlist, not fall-through)", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello from a future plugin", "future-plugin-kind")])],
		});

		expect(await search(ctx, "hello")).toBe("No matches in sessions.");
	});

	it("tool/result message content, error.name, and error.code are each searchable", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [toolResult("file not found", { name: "FSError", code: "ENOENT" })])],
		});

		expect(await search(ctx, "file not found")).toContain("## Session s1");
		expect(await search(ctx, "FSError")).toContain("## Session s1");
		expect(await search(ctx, "ENOENT")).toContain("## Session s1");
	});

	it("tool/call name and arguments are searchable text", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [toolCall("web_fetch", '{"url":"https://x.example"}')])],
		});

		expect(await search(ctx, "web_fetch")).toContain("## Session s1");
		expect(await search(ctx, "https://x.example")).toContain("## Session s1");
	});

	it("assistant/message content is searchable text", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [assistantMessage("the answer is 42")])],
		});

		expect(await search(ctx, "answer is 42")).toContain("## Session s1");
	});

	it("todo/write is not searchable even though the host extractor includes it", async () => {
		const { ctx } = createFakeCtx({
			sessions: [
				session("s1", [
					{ type: "todo/write", data: { todos: [{ status: "in_progress", content: "wire up session search" }] } },
				]),
			],
		});

		expect(await search(ctx, "in_progress")).toBe("No matches in sessions.");
		expect(await search(ctx, "session search")).toBe("No matches in sessions.");
	});

	it("filters string content and only type === 'text' blocks", async () => {
		const { ctx } = createFakeCtx({
			sessions: [
				session("s1", [
					{ type: "user/message", data: { content: "plain string content", source: { kind: "user" } } },
				]),
				session("s2", [
					{
						type: "user/message",
						data: {
							content: [
								{ type: "reasoning", text: "hidden thought" },
								{ type: "text", text: "visible world" },
							],
							source: { kind: "user" },
						},
					},
				]),
			],
		});

		expect(await search(ctx, "plain string")).toContain("## Session s1");
		// reasoning block 不算可搜文本（宿主 extractSessionEventText 的 blockText 同样丢弃它）。
		expect(await search(ctx, "hidden thought")).toBe("No matches in sessions.");
		expect(await search(ctx, "visible world")).toContain("## Session s2");
	});

	it("matches case-insensitively as a literal substring", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("Hello World")])] });

		expect(await search(ctx, "hELLo wORLd")).toContain("## Session s1");
	});

	it("does not treat the query as a regex (metacharacters cannot throw)", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("plain text")])] });

		await expect(search(ctx, "(")).resolves.toBe("No matches in sessions.");
		await expect(search(ctx, "[a-z]+")).resolves.toBe("No matches in sessions.");
	});

	it("empty or whitespace-only query does not match everything", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("hello")])] });

		expect(await search(ctx, "")).toBe("No matches in sessions.");
		expect(await search(ctx, "   ")).toBe("No matches in sessions.");
	});

	it("includes a ±50-message context window around each match", async () => {
		const events = [
			userMessage("near context"),
			userMessage("needle here"),
			...Array.from({ length: 100 }, (_, i) => userMessage(`filler ${i}`)),
			userMessage("far away"),
		];
		const { ctx } = createFakeCtx({ sessions: [session("s1", events)] });

		const out = await search(ctx, "needle");

		expect(out).toContain("…matched: \"needle here\"…");
		expect(out).toContain("  near context");
		expect(out).toContain("  filler 49");
		expect(out).not.toContain("  filler 50");
		expect(out).not.toContain("far away");
	});

	it("truncates each context line to 200 characters (plus the two-space indent)", async () => {
		const longContext = "x".repeat(300);
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage(longContext), userMessage("needle here")])],
		});

		const out = await search(ctx, "needle");

		const contextLine = out.split("\n").find((l) => l.startsWith("  x"));
		expect(contextLine).toBe(`  ${"x".repeat(200)}`);
	});

	it("truncates the matched snippet to 150 characters", async () => {
		const longMatch = `needle ${"y".repeat(300)}`;
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage(longMatch)])] });

		const out = await search(ctx, "needle");

		const matchedLine = out.split("\n").find((l) => l.includes("…matched:"));
		expect(matchedLine).toBe(`…matched: "${longMatch.slice(0, 150)}"…`);
	});

	it("caps the output body at 50000 bytes (the byte arm of truncateForInjection)", async () => {
		// 5 个命中，每个命中拿满 ±50 的上下文窗口（101 行）。每行是两个空格缩进 + 截到 200 字符
		// 的消息文本：本例文本长 191–192 字符，即约 193–194 字节/行，每个命中约 19.5 KB，5 个合计
		// 约 98 KB（实测 97538 字节）—— 足以触发按字节削的 50000 上限（2000 行的那一臂
		// 在 maxMatches: 5 下到不了）。
		const events: Array<{ type: string; data: unknown }> = [];
		for (let region = 0; region < 5; region++) {
			for (let i = 0; i < 50; i++) events.push(userMessage(`before-${region}-${i} ${"x".repeat(180)}`));
			events.push(userMessage(`needle-${region}`));
			for (let i = 0; i < 50; i++) events.push(userMessage(`after-${region}-${i} ${"y".repeat(180)}`));
		}
		const { ctx } = createFakeCtx({ sessions: [session("s1", events)] });

		const out = await search(ctx, "needle");

		expect(out).toContain("Found 5 match(es):");
		// core 先按字节削到 50000，**再**追加 `\n` + 标记，所以整体是 50000 + 1 + 49 = 50050 字节。
		// 这里 pin 住的是 core 的口径：正文（去掉标记行）不超过 50000 字节，且削得足够紧。
		const markerLine = `\n${ENTRY_TRUNCATION_MARKER}`;
		expect(out.endsWith(markerLine)).toBe(true);
		const bodyBytes = Buffer.byteLength(out.slice(0, out.length - markerLine.length), "utf8");
		expect(bodyBytes).toBeLessThanOrEqual(50_000);
		expect(bodyBytes).toBeGreaterThan(49_900);
	});

	it("drops sessions whose header.cwd differs from the queried cwd even if the host filter returns them", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("other", [userMessage("hello from another project")])] });
		// 假 ctx 的 filterSessions 本来会按 cwd 过滤；stub 成"照单全收"以证明本模块自己的
		// header.cwd 后置过滤仍然兜底。
		ctx.sessionQuery.filterSessions = vi.fn(async () => [{ header: { id: "other", cwd: "/somewhere-else" } }]);

		expect(await search(ctx, "hello")).toBe("No matches in sessions.");
	});

	it("formats createdAt as YYYY-MM-DD; the fake maps a missing createdAt to epoch 0 (1970-01-01)", async () => {
		const { ctx } = createFakeCtx({
			sessions: [
				session("dated", [userMessage("hello")], new Date("2026-03-05T12:00:00Z").getTime()),
				session("undated", [userMessage("hello")]),
			],
		});

		const out = await search(ctx, "hello");

		expect(out).toContain("## Session dated (2026-03-05)");
		// 假 ctx 的 sessionHeader 把缺省 createdAt 填成 0（epoch），不是 formatDate 的空分支。
		expect(out).toContain("## Session undated (1970-01-01)");
		expect(out).not.toContain("NaN");
		expect(out).not.toContain("()");
	});

	it("omits the parenthetical date when the host record truly has no createdAt", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("undated", [userMessage("hello")])] });
		// 假 ctx 的 filterSessions 总是填 createdAt ?? 0；stub 掉它返回一个真正没有 createdAt 的
		// header，让 formatDate 的空分支被真正走到（否则会被 epoch-0 默认值掩盖）。
		ctx.sessionQuery.filterSessions = vi.fn(async () => [{ header: { id: "undated", cwd: CWD } }]);

		const out = await search(ctx, "hello");

		expect(out).toContain("## Session undated");
		expect(out).not.toContain("## Session undated (");
	});

	it("filterSessions rejecting yields the unavailable string without throwing", async () => {
		const { ctx } = createFakeCtx();
		const disabled = Object.assign(new Error("Session query search is disabled"), {
			code: "SESSION_QUERY_SEARCH_DISABLED",
		});
		ctx.sessionQuery.filterSessions = vi.fn(async () => {
			throw disabled;
		});

		const out = await search(ctx, "hello");

		expect(out).toContain("Session search is unavailable in this host configuration:");
		expect(out).toContain("Session query search is disabled");
	});

	it("readSession rejecting yields the unavailable string without throwing", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("hello")])] });
		ctx.sessionQuery.readSession = vi.fn(async () => {
			throw new Error("readSession exploded");
		});

		const out = await search(ctx, "hello");

		expect(out).toContain("Session search is unavailable in this host configuration:");
		expect(out).toContain("readSession exploded");
	});

	it("scopes via filterSessions([{kind:'cwd',values:[cwd]}]) and never calls listSessions", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("hello")])] });
		const filterSessions = vi.fn(ctx.sessionQuery.filterSessions.bind(ctx.sessionQuery));
		const listSessions = vi.fn(async () => {
			throw new Error("listSessions must not be called");
		});
		ctx.sessionQuery.filterSessions = filterSessions;
		ctx.sessionQuery.listSessions = listSessions;

		const out = await search(ctx, "hello");

		expect(out).toContain("## Session s1");
		expect(filterSessions).toHaveBeenCalledExactlyOnceWith([{ kind: "cwd", values: [CWD] }]);
		expect(listSessions).not.toHaveBeenCalled();
	});
});
