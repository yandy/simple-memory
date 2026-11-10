import { DEFAULT_CONFIG, mergeConfig, type SessionPersistenceConfig } from "../config.js";
import type { MemoryStore } from "../store/memory-store.js";
import { MAIN_AGENT_ACTIONS, type MemoryAction } from "../tool/actions.js";
import { buildExtractTask } from "./prompts.js";
import type { HeadlessAgentPort, HostTranscriptPort } from "./ports.js";
import { runTask, type MemoryTask } from "./task.js";

export interface RunExtractOpts {
	/** 必填：模型来自显式配置（启动校验已保证可解析），没有父模型回退。 */
	model: string;
	/** 宿主的思考/推理档位。core 不解释，原样透传给端口。 */
	effort?: string;
	memoryDir: string;
	/** 唯一写入通道：extract 的整轮互斥挂在它的 `tryWithLogicalLock` 上。 */
	store: MemoryStore;
	/** 宿主的原始消息序列（pi 的 `AgentMessage[]` 等），经 `ports.transcript` 转成中立形状。 */
	messages: unknown[];
	maxContextTokens: number;
	maxToolResultChars: number;
	maxAssistantChars: number;
	sessionPersistence?: SessionPersistenceConfig;
	agentsMdBlocks?: string[];
	/**
	 * 子会话里的 `memory` 工具每成功写入一条就回调一次。
	 *
	 * extract 跑在 headless 子会话里，适配层看不到它写了几条，只能靠这个回调计数（用来决定
	 * 要不要弹「Extracted N memories」）。core 不解释它，只负责透到工具规格里。
	 */
	onWrite?: (info: { action: MemoryAction; name?: string }) => void;
}

export interface ExtractPorts {
	headless: HeadlessAgentPort;
	transcript: HostTranscriptPort;
}

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

/**
 * 跑一轮 extract。
 *
 * **不等待逻辑锁**：拿不到就跳过本轮并返回 `{ skipped: true }`。extract 在每轮结束都触发，
 * 让它排队等 dream（分钟级）只会把一批批早已过时的对话堆在队列里，等 dream 结束后依次重放。
 *
 * 错误**不吞**：吞掉会让 extract 的失败对用户完全不可见。由调用方决定如何呈现（适配层通常
 * 做限流通知）。
 *
 * 【过渡】Task 7 删除本入口：适配层将直接调 `runTask(TASKS.extractMemories, input, ctx)`。
 * 保留期间保持旧签名与旧行为，适配层无需改动。
 */
export async function runExtract(opts: RunExtractOpts, ports: ExtractPorts): Promise<ExtractResult> {
	return runTask(
		extractMemories,
		{ messages: opts.messages, agentsMdBlocks: opts.agentsMdBlocks ?? [], onWrite: opts.onWrite },
		{
			cfg: mergeConfig(DEFAULT_CONFIG, {
				defaults: { model: opts.model, sessionPersistence: opts.sessionPersistence },
				extractMemories: {
					thinkLevel: opts.effort,
					maxContextTokens: opts.maxContextTokens,
					maxToolResultChars: opts.maxToolResultChars,
					maxAssistantChars: opts.maxAssistantChars,
					sessionPersistence: opts.sessionPersistence,
				},
			}),
			cwd: opts.memoryDir,
			store: opts.store,
			ports,
		},
	);
}
