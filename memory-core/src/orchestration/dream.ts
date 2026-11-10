import { DREAM_ACTIONS } from "../tool/actions.js";
import { buildDreamTask } from "./prompts.js";
import type { MemoryTask } from "./task.js";

/** `incomplete` / `not-run` 的短诊断：`cause`，`not-run` 带上 `detail`。 */
function describeCause(why: { cause: string; detail?: string }): string {
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
				throw new Error(`the dream round did not complete (${describeCause(why)})`);
		}
	},
};

