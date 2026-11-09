import type { HeadlessRunRequest } from "@yandy0725/memory-core";
import { describe, expect, it, vi } from "vitest";
import { createDshHeadless } from "../src/headless.js";
import type { LlmLike, StreamChunkLike } from "../src/headless.js";

/** 一份合法的零工具请求；单个用例按需覆盖字段。 */
function baseReq(over: Partial<HeadlessRunRequest> = {}): HeadlessRunRequest {
	return {
		task: "TASK",
		cwd: "/mem",
		model: "deepseek-official/deepseek-flash",
		builtinTools: "none",
		memoryTool: null,
		...over,
	};
}

/** 立刻结束的空流：一次都没 yield 就 done。 */
function emptyStream(): AsyncIterable<StreamChunkLike> {
	return {
		[Symbol.asyncIterator]() {
			return { next: () => Promise.resolve({ value: undefined, done: true }) };
		},
	};
}

/** 把一串 chunk 逐个 yield 出来的流。 */
function chunkStream(...chunks: StreamChunkLike[]): LlmLike["stream"] {
	return async function* () {
		for (const chunk of chunks) yield chunk;
	};
}

describe("createDshHeadless — 成功路径", () => {
	it("concatenates text-delta chunks into one string", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: "a" },
				{ type: "text-delta", text: "b" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBe("ab");
	});

	it("accumulates text content-blocks and ignores unrelated chunks", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "content-block", block: { type: "text", text: "hello " } },
				{ type: "usage" },
				{ type: "content-block", block: { type: "reasoning", text: "IGNORED" } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBe("hello ");
	});

	it("returns the accumulated text on a normal stop finish chunk", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: "done " },
				{ type: "finish", reason: { kind: "stop" } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBe("done ");
	});

	it("returns an empty string (not null) for a successful round with no text", async () => {
		const llm: LlmLike = {
			stream: chunkStream({ type: "finish", reason: { kind: "stop" } }),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBe("");
	});

	it("returns an empty string when the only text is whitespace", async () => {
		const llm: LlmLike = {
			stream: chunkStream({ type: "text-delta", text: "   " }),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBe("");
	});
});

describe("createDshHeadless — 传给 llm.stream 的入参", () => {
	it("splits model on the first slash, forwards effort, puts task in messages, and omits tools/sessionId/system", async () => {
		const captured: unknown[] = [];
		const llm: LlmLike = {
			stream(opts) {
				captured.push(opts);
				return emptyStream();
			},
		};
		const port = createDshHeadless(llm);
		await port.run(baseReq({ task: "the task", model: "megcore/qwen/qwen3.8-max", effort: "max" }));

		expect(captured).toHaveLength(1);
		const opts = captured[0] as Record<string, unknown>;
		expect(opts).toStrictEqual({
			provider: "megcore",
			model: "qwen/qwen3.8-max",
			reasoningEffort: "max",
			messages: [{ role: "user", content: [{ type: "text", text: "the task" }] }],
		});
		// 零工具是意图本身：`tools` 键必须整个不存在（`tools: []` 对宿主可能是另一种语义）。
		expect("tools" in opts).toBe(false);
		expect("sessionId" in opts).toBe(false);
		expect("system" in opts).toBe(false);
	});

	it("forwards the caller's signal through unchanged", async () => {
		const controller = new AbortController();
		const captured: unknown[] = [];
		const llm: LlmLike = {
			stream(opts) {
				captured.push(opts);
				return emptyStream();
			},
		};
		const port = createDshHeadless(llm);
		await port.run(baseReq({ signal: controller.signal }));
		expect((captured[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
	});
});

describe("createDshHeadless — 不支持的请求", () => {
	it("returns null and never calls llm.stream for builtinTools: file-io", async () => {
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ builtinTools: "file-io" }))).toBeNull();
		expect(stream).not.toHaveBeenCalled();
	});

	it("returns null and never calls llm.stream for a non-null memoryTool", async () => {
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ memoryTool: { actions: ["list"] } }))).toBeNull();
		expect(stream).not.toHaveBeenCalled();
	});

	it("returns null and never calls llm.stream for an unparseable model", async () => {
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ model: "no-slash" }))).toBeNull();
		expect(stream).not.toHaveBeenCalled();
	});
});

describe("createDshHeadless — 两条失败通道", () => {
	it("returns null on a terminal error finish chunk (NO_ADAPTER)", async () => {
		const llm: LlmLike = {
			stream: chunkStream({
				type: "finish",
				reason: { kind: "error", failure: { code: "NO_ADAPTER", message: "no adapter" } },
			}),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBeNull();
	});

	it("returns null on a terminal aborted finish chunk (no failure field, like the fake host)", async () => {
		const llm: LlmLike = {
			stream: chunkStream({ type: "finish", reason: { kind: "aborted" } }),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBeNull();
	});

	it("returns null (not throwing) when llm.stream itself throws", async () => {
		const llm: LlmLike = {
			stream() {
				throw Object.assign(new Error("auth failed"), { code: "AUTH" });
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBeNull();
	});

	it("returns null (not the partial text) when an error finish follows a text chunk", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: "partial" },
				{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT" } } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toBeNull();
	});
});

describe("createDshHeadless — signal", () => {
	it("returns null and never calls llm.stream when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ signal: controller.signal }))).toBeNull();
		expect(stream).not.toHaveBeenCalled();
	});

	it("returns null (not the partial text) when the signal aborts mid-stream", async () => {
		const controller = new AbortController();
		const llm: LlmLike = {
			async *stream() {
				yield { type: "text-delta", text: "partial" };
				controller.abort();
				// 真实宿主会把 signal abort 转成终止 aborted chunk。
				yield { type: "finish", reason: { kind: "aborted" } };
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq({ signal: controller.signal }))).toBeNull();
	});
});

describe("createDshHeadless — timeout", () => {
	it("returns null when timeoutMs elapses and aborts the stream's signal", async () => {
		let seenSignal: AbortSignal | undefined;
		const llm: LlmLike = {
			async *stream(opts) {
				seenSignal = opts.signal;
				// 模拟宿主：挂起直到 signal abort，再 yield 终止 aborted chunk。
				await new Promise<void>((resolve) => {
					if (opts.signal?.aborted) return resolve();
					opts.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				yield { type: "finish", reason: { kind: "aborted" } };
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq({ timeoutMs: 20 }))).toBeNull();
		expect(seenSignal?.aborted).toBe(true);
	});

	it("composes the timeout with the caller's signal so either abort ends the stream", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const llm: LlmLike = {
			async *stream(opts) {
				seenSignal = opts.signal;
				await new Promise<void>((resolve) => {
					if (opts.signal?.aborted) return resolve();
					opts.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				yield { type: "finish", reason: { kind: "aborted" } };
			},
		};
		const port = createDshHeadless(llm);
		const pending = port.run(baseReq({ signal: controller.signal, timeoutMs: 50 }));
		controller.abort();
		expect(await pending).toBeNull();
		expect(seenSignal?.aborted).toBe(true);
	});

	it("clears its timeout timer after a successful call", async () => {
		vi.useFakeTimers();
		try {
			const llm: LlmLike = {
				async *stream() {
					yield { type: "text-delta", text: "ok" };
				},
			};
			const port = createDshHeadless(llm);
			expect(await port.run(baseReq({ timeoutMs: 30_000 }))).toBe("ok");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
