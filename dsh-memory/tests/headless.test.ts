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
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "ab" });
	});

	it("ignores a text-delta whose text is not a string instead of appending 'undefined'", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: undefined },
				{ type: "text-delta", text: "ok" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "ok" });
	});

	it("accumulates text block-end chunks and ignores usage/block-start", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-end", index: 0, block: { type: "text", text: "hello " } },
				{ type: "usage" },
				{ type: "block-end", index: 1, block: { type: "reasoning", text: "IGNORED" } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "hello " });
	});

	it("does not double-count when a text-delta and a same-index block-end both arrive", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", index: 0, text: "hello" },
				{ type: "block-end", index: 0, block: { type: "text", text: "hello" } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "hello" });
	});

	it("yields the same text from delta-only and block-end-only streams", async () => {
		const run = (chunks: StreamChunkLike[]) => createDshHeadless({ stream: chunkStream(...chunks) }).run(baseReq());
		expect(await run([{ type: "text-delta", index: 0, text: "same" }])).toEqual({ status: "completed", text: "same" });
		expect(await run([{ type: "block-end", index: 0, block: { type: "text", text: "same" } }])).toEqual({
			status: "completed",
			text: "same",
		});
	});

	it("returns only the answer, not the reasoning, when reasoning-delta is present", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", index: 0, text: "answer" },
				{ type: "reasoning-delta", index: 0, text: "chain-of-thought" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "answer" });
	});

	it("excludes reasoning text even when a text-delta lands on a reasoning block-start bucket", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "block-start", index: 0, blockType: "reasoning" },
				{ type: "text-delta", index: 0, text: "x" },
				{ type: "block-start", index: 1, blockType: "text" },
				{ type: "text-delta", index: 1, text: "answer" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "answer" });
	});

	it("orders by block-start first-seen, not by the order text deltas arrive", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "block-start", index: 1, blockType: "text" },
				{ type: "text-delta", index: 1, text: "b" },
				{ type: "text-delta", index: 0, text: "a" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "ab" });
	});

	it("concatenates multiple text blocks in first-seen order when their indices arrive out of order", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "block-end", index: 1, block: { type: "text", text: "b" } },
				{ type: "block-end", index: 0, block: { type: "text", text: "a" } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "ba" });
	});

	it("freezes an index once its block-end has arrived, ignoring later deltas for that index", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "block-end", index: 0, block: { type: "text", text: "A" } },
				{ type: "text-delta", index: 0, text: "B" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "A" });
	});

	it("keys buckets by the raw index, so chunks without an index share one bucket and append together", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: "a" },
				{ type: "text-delta", text: "b" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "ab" });
	});

	it("does not use a -1 sentinel: a missing index and a real -1 index stay separate buckets", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "block-end", block: { type: "text", text: "A" } },
				{ type: "text-delta", index: -1, text: "B" },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "AB" });
	});

	it("returns the accumulated text on a normal stop finish chunk", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: "done " },
				{ type: "finish", reason: { kind: "stop" } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "done " });
	});

	it("reads to exhaustion, never entering the iterator.return cleanup channel, on a stop finish", async () => {
		const llm: LlmLike = {
			stream() {
				const chunks: StreamChunkLike[] = [
					{ type: "text-delta", text: "done " },
					{ type: "finish", reason: { kind: "stop" } },
				];
				let i = 0;
				return {
					[Symbol.asyncIterator]() {
						return {
							next: () =>
								Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
							// 宿主 adapterStream 的 finally 在 break 时才会 await iterator.return()，
							// 而 cleanup 失败归在 "remain thrown"（dsh-llm/lib/index.js:2381-2384）。
							// 这里让它 reject：若实现 break，成功调用会掉进 catch 返回 null；读到流尽则不会调用。
							return: () => Promise.reject(new Error("cleanup channel entered")),
						};
					},
				};
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "done " });
	});

	it("maps a clean empty answer to completed with empty text (an empty answer is not 'not-run')", async () => {
		const llm: LlmLike = {
			stream: chunkStream({ type: "finish", reason: { kind: "stop" } }),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "" });
	});

	it("maps a whitespace-only answer to completed with empty text", async () => {
		const llm: LlmLike = {
			stream: chunkStream({ type: "text-delta", text: "   " }),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "completed", text: "" });
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

	it("omits the reasoningEffort key entirely when req.effort is undefined", async () => {
		const captured: unknown[] = [];
		const llm: LlmLike = {
			stream(opts) {
				captured.push(opts);
				return emptyStream();
			},
		};
		const port = createDshHeadless(llm);
		await port.run(baseReq({ task: "no effort" }));
		expect(captured).toHaveLength(1);
		const opts = captured[0] as Record<string, unknown>;
		expect("reasoningEffort" in opts).toBe(false);
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
	it("maps builtinTools: file-io to not-run/host-refused and never calls llm.stream", async () => {
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ builtinTools: "file-io" }))).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: expect.any(String),
		});
		expect(stream).not.toHaveBeenCalled();
	});

	it("maps a non-null memoryTool to not-run/host-refused and never calls llm.stream", async () => {
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ memoryTool: { actions: ["list"] } }))).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: expect.any(String),
		});
		expect(stream).not.toHaveBeenCalled();
	});

	it("maps an unparseable model to not-run/unavailable and never calls llm.stream", async () => {
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ model: "no-slash" }))).toEqual({ status: "not-run", cause: "unavailable" });
		expect(stream).not.toHaveBeenCalled();
	});
});

describe("createDshHeadless — 两条失败通道", () => {
	it("maps a terminal error finish chunk (NO_ADAPTER) to not-run/host-refused", async () => {
		const llm: LlmLike = {
			stream: chunkStream({
				type: "finish",
				reason: { kind: "error", failure: { code: "NO_ADAPTER", message: "no adapter" } },
			}),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: expect.any(String),
		});
	});

	it("maps a terminal aborted finish chunk (no failure field, like the fake host) to incomplete/aborted", async () => {
		const llm: LlmLike = {
			stream: chunkStream({ type: "finish", reason: { kind: "aborted" } }),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({ status: "incomplete", cause: "aborted" });
	});

	it("maps a throwing llm.stream to not-run/host-refused carrying the error message", async () => {
		const llm: LlmLike = {
			stream() {
				throw Object.assign(new Error("auth failed"), { code: "AUTH" });
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: "auth failed",
		});
	});

	it("drops the partial text when an error finish follows a text chunk", async () => {
		const llm: LlmLike = {
			stream: chunkStream(
				{ type: "text-delta", text: "partial" },
				{ type: "finish", reason: { kind: "error", failure: { code: "TIMEOUT" } } },
			),
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq())).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: expect.any(String),
		});
	});
});

describe("createDshHeadless — signal", () => {
	it("maps an already-aborted signal to not-run/aborted and never calls llm.stream", async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = vi.fn(() => emptyStream());
		const port = createDshHeadless({ stream });
		expect(await port.run(baseReq({ signal: controller.signal }))).toEqual({ status: "not-run", cause: "aborted" });
		expect(stream).not.toHaveBeenCalled();
	});

	it("maps a mid-stream abort to not-run/host-refused (not the partial text)", async () => {
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
		expect(await port.run(baseReq({ signal: controller.signal }))).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: expect.any(String),
		});
	});

	it("gives up on the next chunk when the signal aborts but the stream ignores it", async () => {
		const controller = new AbortController();
		const llm: LlmLike = {
			async *stream() {
				yield { type: "text-delta", text: "x" };
				controller.abort();
				// 一个不理会 signal 的流：abort 后继续 yield，永不结束。
				yield { type: "text-delta", text: "y" };
				yield { type: "text-delta", text: "y" };
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq({ signal: controller.signal }))).toEqual({
			status: "not-run",
			cause: "host-refused",
			detail: expect.any(String),
		});
	});
});

describe("createDshHeadless — timeout", () => {
	it("maps its own timeout to not-run/timeout and aborts the stream's signal", async () => {
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
		expect(await port.run(baseReq({ timeoutMs: 20 }))).toEqual({ status: "not-run", cause: "timeout" });
		expect(seenSignal?.aborted).toBe(true);
	});

	it("maps an aborting llm.stream to not-run/timeout when its own timer fired", async () => {
		const llm: LlmLike = {
			async *stream(opts) {
				// 宿主把 abort 变成异常抛出，而不是终止 chunk：超时仍必须是 timeout，不是 host-refused。
				await new Promise<void>((resolve) => {
					if (opts.signal?.aborted) return resolve();
					opts.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new DOMException("aborted", "AbortError");
			},
		};
		const port = createDshHeadless(llm);
		expect(await port.run(baseReq({ timeoutMs: 20 }))).toEqual({ status: "not-run", cause: "timeout" });
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
		expect(await pending).toEqual({ status: "not-run", cause: "host-refused", detail: expect.any(String) });
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
			expect(await port.run(baseReq({ timeoutMs: 30_000 }))).toEqual({ status: "completed", text: "ok" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears its timer after a terminal error finish", async () => {
		vi.useFakeTimers();
		try {
			const llm: LlmLike = {
				stream: chunkStream({ type: "finish", reason: { kind: "error" } }),
			};
			const port = createDshHeadless(llm);
			expect((await port.run(baseReq({ timeoutMs: 30_000 }))).status).toBe("not-run");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears its timer when llm.stream throws", async () => {
		vi.useFakeTimers();
		try {
			const llm: LlmLike = {
				stream() {
					throw Object.assign(new Error("auth failed"), { code: "AUTH" });
				},
			};
			const port = createDshHeadless(llm);
			expect((await port.run(baseReq({ timeoutMs: 30_000 }))).status).toBe("not-run");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears its timer after a timeout abort", async () => {
		vi.useFakeTimers();
		try {
			const llm: LlmLike = {
				async *stream(opts) {
					await new Promise<void>((resolve) => {
						if (opts.signal?.aborted) return resolve();
						opts.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					yield { type: "finish", reason: { kind: "aborted" } };
				},
			};
			const port = createDshHeadless(llm);
			const pending = port.run(baseReq({ timeoutMs: 30_000 }));
			await vi.advanceTimersByTimeAsync(30_000);
			expect(await pending).toEqual({ status: "not-run", cause: "timeout" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
