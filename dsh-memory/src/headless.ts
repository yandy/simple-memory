import type { HeadlessAgentPort, HeadlessRunRequest } from "@yandy0725/memory-core";
import { parseModelRef } from "./model.js";

/**
 * 零工具 `HeadlessAgentPort`：core 的编排把「跑一轮受限工具的 headless 会话」委托给适配层，
 * 本模块把它落到宿主的 `ctx.llm.stream()` 上，并自己累积 assistant 文本。
 *
 * 本轮只支持 auto-surfacing 的侧查询：它的 `builtinTools: "none"` 且 `memoryTool: null`
 * 是**意图本身**（查询只是「给 manifest 与用户 prompt，选相关文件」，给它任何工具都是白烧 token）。
 * extract / dream 的 `builtinTools: "file-io"` 与 `memoryTool !== null` 是下一刀，请求一律返回
 * `null`（本轮没跑），**不抛错**。
 */

/** 宿主 `ctx.llm` 里我们用到的那一小片，结构化描述、零宿主 import。 */
export interface LlmLike {
	stream(opts: {
		provider: string;
		model: string;
		reasoningEffort?: string;
		messages: unknown[];
		system?: string;
		signal?: AbortSignal;
	}): AsyncIterable<StreamChunkLike>;
}

/**
 * 宿主 chunk 词汇的宽松投影。刻意不成为第二份宿主定义：只有我们要读的那三种 arm 有精确形状，
 * 其余一律落到 `{ type: string; [k: string]: unknown }`。宿主是快速变动的 rc，收紧这里就是
 * 在适配层里偷偷钉死一份随时会漂的宿主类型。
 */
export type StreamChunkLike =
	| { type: "text-delta"; index?: number; text: string }
	| { type: "block-end"; index?: number; block: { type: string; text?: string } }
	| { type: "finish"; reason?: { kind?: string } }
	| { type: string; [k: string]: unknown };

export function createDshHeadless(llm: LlmLike): HeadlessAgentPort {
	return {
		async run(req: HeadlessRunRequest): Promise<string | null> {
			// 不支持的请求：本轮没跑，返回 null，不抛错。extract / dream 留给下一刀。
			if (req.builtinTools !== "none" || req.memoryTool !== null) return null;

			const ref = parseModelRef(req.model);
			if (ref === null) return null;

			// 还没开始就取消：直接没跑。
			if (req.signal?.aborted) return null;

			// `maxTurns` 在这里不需要工具循环：零工具的一问一答就是一 turn，没有循环可封顶。
			// 这不是「静默忽略」—— 不存在需要封顶的循环；将来若在这里加工具，`maxTurns` 必须成为循环上界。
			// （调用方 surfacing.ts 恒传 maxTurns: 1，见 memory-core/src/orchestration/surfacing.ts。）

			// 超时：用显式 setTimeout + unref，而不是 AbortSignal.timeout() —— 后者创建的定时器
			// 无法提前清除，一次 30s 超时的调用完成后会留一个 30s 才到期的定时器挂在长寿命宿主进程里。
			// 显式 clearTimeout 让完成的调用零残留（仓库先例：pi-memory/index.ts 的 session_shutdown）。
			let timer: ReturnType<typeof setTimeout> | undefined;
			let timeoutController: AbortController | undefined;
			if (typeof req.timeoutMs === "number" && req.timeoutMs > 0) {
				timeoutController = new AbortController();
				timer = setTimeout(
					() => timeoutController?.abort(new Error(`headless LLM call timed out after ${req.timeoutMs}ms`)),
					req.timeoutMs,
				);
				timer.unref?.();
			}

			// 与调用方的 signal 组合而不是替换：任一 abort，底层流都得跟着 abort。
			const signals: AbortSignal[] = [];
			if (req.signal !== undefined) signals.push(req.signal);
			if (timeoutController !== undefined) signals.push(timeoutController.signal);
			const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

			const streamOptions = {
				provider: ref.provider,
				model: ref.model,
				messages: [{ role: "user", content: [{ type: "text", text: req.task }] }],
				...(req.effort !== undefined ? { reasoningEffort: req.effort } : {}),
				...(signal !== undefined ? { signal } : {}),
			};

			// 按 index 累积文本，语义对齐宿主的 BlockAssembler（dsh-llm/lib/index.js:954-1055）：
			// - Map 键 = 原始 chunk.index（含 undefined，不做 -1 之类的哨兵替换；哨兵会与真实 index 相撞），
			//   Map 的插入序就是首次出现序 —— 拼接按首次出现序，不是数字升序。
			// - text-delta 是增量流，追加到该 index；一旦 block-end 给出权威终值，该 index 就冻结，
			//   之后的 delta 一律忽略（宿主两个分支开头的 `if (partial.block) return;`）。
			// - block-end 的 text 块是该 index 的权威终值（覆盖之前累积的 delta），两者同发时不能重复计数。
			const partials = new Map<unknown, { text: string; block: string | null }>();
			const ensure = (index: unknown): { text: string; block: string | null } => {
				let partial = partials.get(index);
				if (partial === undefined) {
					partial = { text: "", block: null };
					partials.set(index, partial);
				}
				return partial;
			};

			try {
				for await (const chunk of llm.stream(streamOptions)) {
					if (chunk.type === "text-delta") {
						const partial = ensure((chunk as { index?: unknown }).index);
						if (partial.block !== null) continue; // 已被 block-end 冻结，后续 delta 忽略
						partial.text += chunk.text;
					} else if (chunk.type === "block-end") {
						// 兜底 arm（`{ type: string; [k: string]: unknown }`）会让判别式收窄失效：
						// `chunk.block` 在这里是 unknown，必须显式 cast 到我们要读的形状。
						const end = chunk as { index?: unknown; block?: { type?: unknown; text?: unknown } };
						if (end.block?.type === "text" && typeof end.block.text === "string") {
							const partial = ensure(end.index);
							if (partial.block !== null) continue; // 重复 block-end：保持首个权威值
							partial.block = end.block.text; // 覆盖之前累积的 delta，并冻结该 index
						}
					} else if (chunk.type === "finish") {
						// 宿主有两条失败通道：adapter 选择/派发/迭代失败被转成终止 finish chunk，
						// 只有 middleware/consumer 失败才真的抛（dsh-llm/lib/index.js:2355-2357,
						// :2390-2396）。所以失败判定必须看 reason.kind，不能只靠外层 try/catch。
						// 故意不读 reason.failure.code：真宿主一定有 failure，但测试假宿主（fake-ctx）
						// 的 aborted chunk 没有 failure 字段，读它会崩。
						const reason = (chunk as { reason?: { kind?: string } }).reason;
						if (reason?.kind === "error" || reason?.kind === "aborted") return null;
						// stop / max-tokens / tool-calls / 未知（宿主可合并扩展）→ 正常结束，返回累积文本。
						break;
					}
					// reasoning-delta 是思维链，绝不能累积进答案 —— 加进来会污染侧查询输出，
					// 这是最容易被人「好心」补上的地方。tool-call-delta / usage / block-start 也一律忽略。
				}
			} catch {
				// middleware / nested-call / cleanup / consumer 失败仍会抛：同样视为「本轮没跑成」。
				return null;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}

			// 按首次出现顺序（Map 插入序）拼接；core 靠 null 区分「没跑」与「跑了没写出东西」。
			const text = [...partials.values()].map((partial) => partial.block ?? partial.text).join("");
			// 成功但空文本必须是 ""。
			return text.trim() === "" ? "" : text;
		},
	};
}
