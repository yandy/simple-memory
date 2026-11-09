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

function todoWrite(status: string, content: string): { type: string; data: unknown } {
	return { type: "todo/write", data: { todos: [{ status, content }] } };
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

	it("synthetic user/message (source.kind !== 'user') does not produce a match", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello from agent-instructions", "agent-instructions")])],
		});

		expect(await search(ctx, "hello")).toBe("No matches in sessions.");
	});

	it("human user/message (source.kind === 'user') with the same text does match", async () => {
		const { ctx } = createFakeCtx({ sessions: [session("s1", [userMessage("hello from user")])] });

		expect(await search(ctx, "hello")).toContain("## Session s1");
	});

	it("falls through unknown source.kind instead of dropping the message", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [userMessage("hello from a future plugin", "future-plugin-kind")])],
		});

		expect(await search(ctx, "hello")).toContain("## Session s1");
	});

	it("tool/result error.code is searchable text", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [toolResult("file not found", { name: "Error", code: "ENOENT" })])],
		});

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

	it("todo/write status and content are searchable text", async () => {
		const { ctx } = createFakeCtx({
			sessions: [session("s1", [todoWrite("in_progress", "wire up session search")])],
		});

		expect(await search(ctx, "in_progress")).toContain("## Session s1");
		expect(await search(ctx, "session search")).toContain("## Session s1");
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

	it("formats createdAt as YYYY-MM-DD and never emits NaN or empty parens", async () => {
		const { ctx } = createFakeCtx({
			sessions: [
				session("dated", [userMessage("hello")], new Date("2026-03-05T12:00:00Z").getTime()),
				session("undated", [userMessage("hello")]),
			],
		});

		const out = await search(ctx, "hello");

		expect(out).toContain("## Session dated (2026-03-05)");
		expect(out).toContain("## Session undated");
		expect(out).not.toContain("NaN");
		expect(out).not.toContain("()");
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
