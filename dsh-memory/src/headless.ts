import type { HeadlessAgentPort, HeadlessOutcome, HeadlessRunRequest } from "@yandy0725/memory-core";
import { errorMessage } from "./errors.js";
import { parseModelRef } from "./model.js";

/**
 * 零工具 `HeadlessAgentPort`：core 的编排把「跑一轮受限工具的 headless 会话」委托给适配层，
 * 本模块把它落到宿主的 `ctx.llm.stream()` 上，并自己累积 assistant 文本。
 *
 * 目前只支持 auto-surfacing 的侧查询：它的 `builtinTools: "none"` 且 `memoryTool: null`
 * 是**意图本身**（查询只是「给 manifest 与用户 prompt，选相关文件」，给它任何工具都是白烧 token）。
 * extract / dream 的 `builtinTools: "file-io"` 与 `memoryTool !== null` 尚未实现，那类请求一律返回
 * `{ status: "not-run", cause: "host-refused" }`（= 没跑），**不抛错**。
 *
 * 结果词汇按 core 的判别规则映射：请求**发出前**结束 → `not-run`；发出后没拿到完整文本 →
 * `incomplete`。本适配层自己产生的 `incomplete` 只有一种：宿主发了终止 `aborted` chunk。
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
 * 在适配层里偷偷钉死一份随时会漂的宿主类型。`index?` 是防御性放宽：宿主恒发
 * `index: number`（types.d.ts:462-479），测试覆盖了缺失 index 的路径，不是对宿主形状的断言。
 */
export type StreamChunkLike =
	| { type: "text-delta"; index?: number; text: string }
	| { type: "block-end"; index?: number; block: { type: string; text?: string } }
	| { type: "finish"; reason?: { kind?: string } }
	| { type: string; [k: string]: unknown };

export function createDshHeadless(llm: LlmLike): HeadlessAgentPort {
	return {
		async run(req: HeadlessRunRequest): Promise<HeadlessOutcome> {
			// 不支持的请求：没跑（`not-run` + `host-refused`），不抛错。extract / dream 尚未实现。
			if (req.builtinTools !== "none" || req.memoryTool !== null) {
				return {
					status: "not-run",
					cause: "host-refused",
					detail: "this adapter implements zero-tool headless calls only",
				};
			}

			const ref = parseModelRef(req.model);
			if (ref === null) return { status: "not-run", cause: "unavailable" };

			// 还没开始就取消：请求从未发出，所以是 `not-run`（不是 `incomplete`）。
			if (req.signal?.aborted) return { status: "not-run", cause: "aborted" };

			// `maxTurns` 在这里不需要工具循环：零工具的一问一答就是一 turn，没有循环可封顶。
			// 这不是「静默忽略」—— 不存在需要封顶的循环；将来若在这里加工具，`maxTurns` 必须成为循环上界。
			// （调用方 surfacing.ts 恒传 maxTurns: 1，见 memory-core/src/orchestration/surfacing.ts。）
			// `cwd` 与 `sessionPersistence` 也是刻意忽略而非漏实现：零工具的一问一答没有工作目录或
			// 会话可挂靠；`sessionId` 照旧不传（宿主有 fail-closed 的 session-checkpoint 策略，
			// 一传就触发，测试已钉住它的缺席）。

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

			// 已发出但被中断（还没拿到完整文本）时的收口：定时器响过 = `timeout`，否则是委托方取消 /
			// 宿主中断。两者都是 `not-run`：这次调用没拿到可用的答案，调用方不该把它当「跑过」。
			const interruptedOutcome = (): HeadlessOutcome =>
				timeoutController?.signal.aborted === true
					? { status: "not-run", cause: "timeout" }
					: {
							status: "not-run",
							cause: "host-refused",
							detail: "the call was aborted before the answer completed",
						};

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
			// - block-start 建立该 index 的顺序并记录 blockType（宿主在 :968 与 ensure() 的 :1016 里
			//   order.push(index)），不贡献文本。
			// - text-delta 是增量流，追加到该 index；一旦 block-end 给出权威终值，该 index 就冻结，
			//   之后的 delta 一律忽略（宿主两个分支开头的 `if (partial.block) return;`）。
			// - 任何 block-end 都置权威块并冻结该 index；text 块覆盖之前累积的 delta，同发时不重复计数。
			// - 最后只取「解析后 type 为 text」的桶：宿主把 reasoning-delta 累积成独立的 {type:"reasoning"}
			//   块（assemble 按 blockType 产块，:1020-1035），reasoning 文本绝不能进答案。
			const partials = new Map<unknown, { text: string; block: { type: string; text: string } | null; blockType: string | null }>();
			const ensure = (index: unknown, blockType?: string): { text: string; block: { type: string; text: string } | null; blockType: string | null } => {
				let partial = partials.get(index);
				if (partial === undefined) {
					partial = { text: "", block: null, blockType: blockType ?? null };
					partials.set(index, partial);
				}
				return partial;
			};

			let terminalKind: string | undefined;
			try {
				for await (const chunk of llm.stream(streamOptions)) {
					// 每个 chunk 先查组合 signal 是否已 abort：宿主会把 abort 转成终止 aborted chunk，
					// 但一个不理会 signal 的流会一直 yield，超时就兜不住。
					// 定时器响过（也就是说超时了）优先判 `timeout` —— 组合 signal 两者都会为真，不先看分不开。
					if (signal?.aborted) return interruptedOutcome();
					if (chunk.type === "text-delta") {
						// 兜底 arm 让判别式收窄失效：`chunk.text` 在这里是 unknown，必须 typeof 收窄。
						// 宿主不会发 text: undefined，但 ctx.llm.stream 经 waterfall 暴露给三方插件，
						// 一个缺 text 的 text-delta 不能把字面量 "undefined" 拼进答案。
						const delta = chunk as { index?: unknown; text?: unknown };
						if (typeof delta.text !== "string") continue;
						const partial = ensure(delta.index, "text");
						if (partial.block !== null) continue; // 已被 block-end 冻结，后续 delta 忽略
						partial.text += delta.text;
					} else if (chunk.type === "block-start") {
						// 兜底 arm 让判别式收窄失效：`chunk.blockType` 是 unknown，显式 cast 读形状。
						const start = chunk as { index?: unknown; blockType?: unknown };
						if (typeof start.blockType !== "string") continue;
						ensure(start.index, start.blockType);
					} else if (chunk.type === "block-end") {
						// 兜底 arm（`{ type: string; [k: string]: unknown }`）会让判别式收窄失效：
						// `chunk.block` 在这里是 unknown，必须显式 cast 到我们要读的形状。
						const end = chunk as { index?: unknown; block?: { type?: unknown; text?: unknown } };
						if (typeof end.block?.type !== "string") continue;
						const partial = ensure(end.index, end.block.type);
						if (partial.block !== null) continue; // 重复 block-end：保持首个权威值
						partial.block = { type: end.block.type, text: typeof end.block.text === "string" ? end.block.text : "" }; // 覆盖累积的 delta，冻结该 index
					} else if (chunk.type === "finish") {
						// 宿主有两条失败通道：adapter 选择/派发/迭代失败被转成终止 finish chunk，
						// 只有 middleware/consumer 失败才真的抛（dsh-llm/lib/index.js:2355-2357,
						// :2390-2396）。所以失败判定必须看 reason.kind，不能只靠外层 try/catch。
						// 故意不读 reason.failure.code：真宿主一定有 failure，但测试假宿主（fake-ctx）
						// 的 aborted chunk 没有 failure 字段，读它会崩。
						// 只记录不 break：break 会触发 for await 的隐式 await iterator.return()，而宿主
						// adapterStream 的 finally（:2381-2384）在 completed === false 时会 await close()，
						// cleanup 失败归在 "remain thrown" 那一半（:2390-2396）—— 成功调用可能因此丢文本，
						// 或 cleanup 挂住时无上限挂死（timeoutMs 此时已用完）。读到流尽后在循环外裁决。
						terminalKind = (chunk as { reason?: { kind?: string } }).reason?.kind;
					}
					// reasoning-delta 是思维链，绝不能累积进答案 —— 加进来会污染侧查询输出，
					// 这是最容易被人「好心」补上的地方。tool-call-delta / usage 也一律忽略。
				}
			} catch (e) {
				// middleware / nested-call / cleanup / consumer 失败仍会抛：同样视为「本轮没跑成」。
				// 定时器响过时宿主很可能只是把 abort 变成异常抛出 —— 那也是超时，不是宿主拒绝。
				return timeoutController?.signal.aborted === true
					? { status: "not-run", cause: "timeout" }
					: { status: "not-run", cause: "host-refused", detail: errorMessage(e) };
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}

			// 终止 finish chunk 的裁决移到循环外（读到流尽）：失败 → `not-run`，
			// 中途取消 → `incomplete`，成功（stop/max-tokens/未知）→ 继续。
			if (terminalKind === "error") {
				return { status: "not-run", cause: "host-refused", detail: "the host ended the stream with an error finish" };
			}
			if (terminalKind === "aborted") {
				return timeoutController?.signal.aborted === true
					? { status: "not-run", cause: "timeout" }
					: { status: "incomplete", cause: "aborted" };
			}

			// 按首次出现顺序（Map 插入序）拼接，只取解析后 type 为 text 的桶；
			// 空文本也是 `completed`：core 靠 `status` 区分「没跑」与「跑了没写出东西」。
			const text = [...partials.values()]
				.map((partial) => {
					const type = partial.block !== null ? partial.block.type : partial.blockType;
					return type === "text" ? (partial.block !== null ? partial.block.text : partial.text) : null;
				})
				.filter((value): value is string => value !== null)
				.join("");
			// 成功但空文本必须是 `completed` + `text: ""`（空回复是意图内的结果，不是没跑）。
			return { status: "completed", text: text.trim() === "" ? "" : text };
		},
	};
}
