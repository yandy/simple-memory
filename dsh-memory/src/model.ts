import type { MemoryConfig } from "@yandy0725/memory-core";
import { modelConfigErrors, taskModel } from "@yandy0725/memory-core";

/**
 * dsh 侧模型引用：`provider` 与 `model` 两段，外加透传给宿主的 `reasoningEffort`。
 * 与 core 的单一不透明 `model: string` 对应；拆解见 `parseModelRef`。
 */
export interface DshModelRef {
	provider: string;
	model: string;
	effort?: string;
}

/**
 * 按**第一个** "/" 把 `"<provider>/<model>"` 拆成两段。
 *
 * 边界行为（刻意显式）：
 * - 首尾空白先被 trim（配置值里的常见手误）；段内部的空白原样保留，不做二次 trim。
 * - 无斜杠（`"deepseek-flash"`、`""`、`"   "`）→ `null`。
 * - 斜杠在某一段为空（`"/x"`、`"p/"`、`"/"`）→ `null`。
 * - model id 自己含斜杠时按第一个斜杠拆：`"megcore/qwen/qwen3.8-max"` →
 *   `{ provider: "megcore", model: "qwen/qwen3.8-max" }`。
 */
export function parseModelRef(value: string): { provider: string; model: string } | null {
	const ref = value.trim();
	const slash = ref.indexOf("/");
	if (slash <= 0) return null;
	const provider = ref.slice(0, slash);
	const model = ref.slice(slash + 1);
	if (provider === "" || model === "") return null;
	return { provider, model };
}

/**
 * 宿主 `ctx.llm.resolveCallConfig` 的结构性形状：零宿主 import，只在参数层面描述。
 * 它至少证明 provider 已注册、`reasoningEffort` 合法；`signal` 原样透传。
 */
export type ResolveCallConfig = (
	config: { provider: string; model: string; reasoningEffort?: string },
	signal?: AbortSignal,
) => Promise<unknown>;

export interface ModuleAvailability {
	available: boolean;
	reason: string | null;
}

const NO_MODEL_REASON = "no model configured — set autoSurfacing.model or defaults.model in the plugin row config";
const DISABLED_REASON =
	"autoSurfacing is disabled in the plugin row config — set autoSurfacing.enabled = true to enable it";

/**
 * 宿主拒绝推理档位时的错误码：`resolveCallWithInfo`（`dsh-llm/lib/index.js:2194-2196`）在
 * `modelInfo.reasoning === undefined && requested !== undefined` 时抛它，而 `ModelInfo.reasoning` 是可选的
 * （`dsh-llm/lib/types/types.d.ts:424`）。core 的默认 `thinkLevel` 是字符串 `"off"`（一个 defined 值），
 * 所以我们**总是**发送显式档位：任何 modelInfo 不带 reasoning 的路线都会在启动期关掉
 * auto-surfacing —— 而那时错的键是 `thinkLevel`，不是 `model`。
 */
const UNSUPPORTED_EFFORT_CODE = "UNSUPPORTED_REASONING_EFFORT";

/**
 * 把宿主拒绝的可抛值转成一句可执行的原因。抛出来的值不保证是 `Error`，`code` / `message`
 * 也都可能缺失；缺 `code` 时绝不能把字符串 `"undefined"` 漏进用户可见文案。
 *
 * 建议文案按 `code` 分叉：档位不被支持时点名 `thinkLevel`，其余情况才点名模型键。指错键的代价
 * 是用户反复去改一个根本没毛病的 `model`。（不能改成「干脆不传 effort」：宿主把
 * `requested === undefined` 当成「用 `reasoning.defaultEffort`」，那会**打开**推理而不是避开错误。）
 */
function hostRejectionReason(model: string, error: unknown): string {
	const e = error as { code?: unknown; message?: unknown } | null | undefined;
	const code = typeof e?.code === "string" && e.code !== "" ? e.code : null;
	const message = typeof e?.message === "string" && e.message !== "" ? e.message : null;
	const detail = message ?? (typeof error === "string" && error !== "" ? error : null);
	let reason = `autoSurfacing model "${model}" was rejected by the host`;
	if (code !== null) reason += ` (${code})`;
	if (detail !== null) reason += `: ${detail}`;
	const advice =
		code === UNSUPPORTED_EFFORT_CODE
			? "this host route advertises no reasoning efforts, so the configured autoSurfacing.thinkLevel cannot be sent — lower or remove thinkLevel in the plugin row config (the model itself may be fine)"
			: "check autoSurfacing.model (or defaults.model) in the plugin row config";
	return `${reason} — ${advice}`;
}

/**
 * D13 的启动期降级判定：三种结果都**不抛给宿主**，缺模型只关掉需要它的那一个模块。
 *
 * 1. 模块被关掉（`autoSurfacing.enabled` falsy，含运行时合法的 `autoSurfacing: null`）→ 关。
 *    **必须先查**：`modelConfigErrors(cfg, () => true, ["autoSurfacing"])` 在「没配模型」与
 *    「enabled=false」两种情况下都返回空数组（core 保留 enabled 过滤），不先查就会误发网络调用。
 * 2. 没配模型（`taskModel` 无值）→ 关。
 * 3. 配了但格式不对（无斜杠）→ 关。
 * 4. 配了且格式对，但宿主 `resolveCallConfig` 拒绝 → 关，reason 带宿主的 code 与 message。
 * 5. 全通过 → 开。
 */
export async function resolveSurfacingAvailability(
	cfg: MemoryConfig,
	resolveCallConfig: ResolveCallConfig,
	signal?: AbortSignal,
): Promise<ModuleAvailability> {
	if (!cfg.autoSurfacing?.enabled) {
		return { available: false, reason: DISABLED_REASON };
	}

	// resolve 恒真，所以这里只可能命中有没配模型这一种错误（没配才需要降级，格式错误下一步再拆）。
	if (modelConfigErrors(cfg, () => true, ["autoSurfacing"]).length > 0) {
		return { available: false, reason: NO_MODEL_REASON };
	}

	const model = taskModel(cfg, "autoSurfacing");
	if (model === undefined) {
		// modelConfigErrors 已判过，理论到不了；防御性保留。
		return { available: false, reason: NO_MODEL_REASON };
	}

	const ref = parseModelRef(model);
	if (ref === null) {
		const reason = `model "${model}" must be "<provider>/<model>" — set autoSurfacing.model (or defaults.model) in the plugin row config`;
		return { available: false, reason };
	}

	try {
		await resolveCallConfig(
			{ provider: ref.provider, model: ref.model, reasoningEffort: cfg.autoSurfacing?.thinkLevel },
			signal,
		);
		return { available: true, reason: null };
	} catch (error) {
		return { available: false, reason: hostRejectionReason(model, error) };
	}
}
