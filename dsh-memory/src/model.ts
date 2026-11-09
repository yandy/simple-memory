import type { MemoryConfig } from "@yandy0725/memory-core";
import { modelConfigErrors, taskModel } from "@yandy0725/memory-core";
import { errorCode, errorDetail } from "./errors.js";

/**
 * dsh 侧模型引用：`provider` 与 `model` 两段，与 core 的单一不透明 `model: string` 对应；
 * 拆解见 `parseModelRef`（本类型就是它的返回类型）。
 *
 * 刻意**不**含推理档位：宿主的 `reasoningEffort` 直接透传 `autoSurfacing.thinkLevel`，
 * 不经这里拆解，也不属于「模型引用」这个概念。
 */
export interface DshModelRef {
	provider: string;
	model: string;
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
export function parseModelRef(value: string): DshModelRef | null {
	const ref = value.trim();
	const slash = ref.indexOf("/");
	// `slash <= 0` 同时挡住了「无斜杠」与「斜杠在首位」（后者是 provider 为空的唯一可能），
	// 所以下面只需要再判 model 那一段。
	if (slash <= 0) return null;
	const provider = ref.slice(0, slash);
	const model = ref.slice(slash + 1);
	if (model === "") return null;
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
	// 两个提取都走 src/errors.ts：宿主抛的不保证是 `Error`（可能是带 `.code`/`.message` 的普通
	// 对象、也可能就是一个字符串）。这里用 `errorDetail` 而不是 `errorMessage`：后者对「只有 code 没有
	// message」的拒绝会退到 JSON 兜底，那会把刚打印过的 code 再抄一遍进用户文案。
	const code = errorCode(error);
	const detail = errorDetail(error);
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
 * 启动期降级判定（降级而不失败）：三种结果都**不抛给宿主**，缺模型只关掉需要它的那一个模块。
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
