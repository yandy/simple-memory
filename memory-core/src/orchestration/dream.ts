import { DEFAULT_CONFIG, mergeConfig, type SessionPersistenceConfig } from "../config.js";
import type { MemoryStore } from "../store/memory-store.js";
import { DREAM_ACTIONS } from "../tool/actions.js";
import { buildDreamTask } from "./prompts.js";
import type { HeadlessAgentPort } from "./ports.js";
import { runTask, type MemoryTask } from "./task.js";

export interface RunDreamOpts {
	/** 必填：模型来自显式配置（启动校验已保证可解析），没有父模型回退。 */
	model: string;
	/** 宿主的思考/推理档位。core 不解释，原样透传给端口。 */
	effort?: string;
	memoryDir: string;
	/** 唯一写入通道。dream 的整轮互斥与快照都挂在它上面。 */
	store: MemoryStore;
	/** 索引行数硬上限（= `config.memIndexMaxLines`），写进 prompt 让 dream 承担容量管理。 */
	maxLines: number;
	sessionPersistence?: SessionPersistenceConfig;
}

/** `incomplete` / `not-run` 的短诊断：`cause`，`not-run` 带上 `detail`。 */
function describe(why: { cause: string; detail?: string }): string {
	return why.detail ? `${why.cause} (${why.detail})` : why.cause;
}

/** dream 描述符：core 自读 `cfg.memIndexMaxLines`，适配层只给触发点与端口。 */
export const dream: MemoryTask<Record<string, never>, string> = {
	id: "dream",
	plan: {
		timeoutMs: 600_000,
		memoryTool: DREAM_ACTIONS,
		lock: "logical+snapshot",
		errorPolicy: "rethrow",
	},
	buildPrompt(cfg) {
		return buildDreamTask(cfg.memIndexMaxLines);
	},
	parse(_cfg, _deps, _input, text) {
		return text;
	},
	notCompleted(_cfg, _deps, _input, why) {
		switch (why.status) {
			case "no-input":
				// 理论不可达（dream 的 prompt 恒有值），但用户显式触发的任务不许静默报成功。
				throw new Error("dream has no input to work with");
			case "lock-busy":
				throw new Error("the dream round could not start: the memory logical lock is busy");
			case "no-output":
				throw new Error("the host ran the dream round but produced no summary");
			case "incomplete":
			case "not-run":
				throw new Error(`the dream round did not complete (${describe(why)})`);
		}
	},
};

/**
 * 跑一轮 dream。
 *
 * 【过渡】Task 7 删除本入口：适配层将直接调 `runTask(TASKS.dream, {}, ctx)`。
 * 保留期间保持旧签名与旧行为，适配层无需改动。
 */
export async function runDream(opts: RunDreamOpts, ports: { headless: HeadlessAgentPort }): Promise<string> {
	return runTask(
		dream,
		{},
		{
			cfg: mergeConfig(DEFAULT_CONFIG, {
				defaults: { model: opts.model, sessionPersistence: opts.sessionPersistence },
				memIndexMaxLines: opts.maxLines,
				dream: { thinkLevel: opts.effort, sessionPersistence: opts.sessionPersistence },
			}),
			cwd: opts.memoryDir,
			store: opts.store,
			ports,
		},
	);
}
