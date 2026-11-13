import { MAIN_AGENT_ACTIONS, type MemoryAction } from "../tool/actions.js";
import { buildExtractTask } from "./prompts.js";
import type { MemoryTask } from "./task.js";

/** `runTask(TASKS.extractMemories, …)` 的输入：宿主只给数据，预算由 core 从 `cfg` 自读。 */
export interface ExtractInput {
	messages: unknown[];
	agentsMdBlocks: string[];
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

export interface ExtractResult {
	skipped: boolean;
	result?: string;
}

/** extractMemories 描述符：core 自读 `cfg.extractMemories` 的预算，适配层只给宿主数据。 */
export const extractMemories: MemoryTask<ExtractInput, ExtractResult> = {
	id: "extractMemories",
	plan: {
		maxTurns: 5,
		timeoutMs: 120_000,
		memoryTool: MAIN_AGENT_ACTIONS,
		lock: "logical",
		errorPolicy: "rethrow",
	},
	buildPrompt(cfg, deps, input) {
		if (!deps.transcript) throw new Error("the extract task requires a transcript port");
		const messages = deps.transcript.toExtractMessages(input.messages);
		// 「判空在锁之前」由 `runTask` 的顺序契约保证（buildPrompt 先于 plan.lock 执行），
		// 这里只做纯计算，不碰 store / lock。
		if (messages.length === 0) return null;
		return buildExtractTask(messages, cfg.extractMemories.maxContextTokens, input.agentsMdBlocks, {
			maxToolResultChars: cfg.extractMemories.maxToolResultChars,
			maxAssistantChars: cfg.extractMemories.maxAssistantChars,
		});
	},
	parse(_cfg, _deps, _input, text) {
		return { skipped: false, result: text };
	},
	notCompleted(_cfg, _deps, _input, why) {
		switch (why.status) {
			case "no-input":
			case "lock-busy":
			case "not-run":
				return { skipped: true };
			case "no-output":
				// pi 的空回复一直是 `{ skipped: false, result: "" }`：这一轮确实跑完、只是没写出文本，
				// 得让「Extracted N memories」通知的既有语义活下来。
				return { skipped: false, result: "" };
			case "incomplete":
				// 写入可能已经通过子会话工具发生过：报失败会歪曲一个确实落盘了的轮次。
				return { skipped: false };
		}
	},
	memoryToolHooks(input) {
		return { onWrite: input.onWrite };
	},
};
