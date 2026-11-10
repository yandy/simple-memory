import { DEFAULT_CONFIG, defaultMemoryRoot, expandTilde, mergeConfig } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";

/**
 * dsh-memory 唯一的配置层。
 *
 * 设计：**不读任何配置文件**。配置只来自 cordis 行 `config:`，宿主在
 * `apply(ctx, config)` 里原样交给我们。合并语义借 core 的 `mergeConfig`（与 pi 的 `memory.json`
 * 同一份实现），所以「行 config」与「memory.json」可以逐字照抄。
 */
export interface ResolvedConfig {
	config: MemoryConfig;
	warnings: string[];
	error: string | null;
}

/**
 * 允许出现在行 config 里的顶层键。刻意从 `DEFAULT_CONFIG` 派生而不是手写：core 加键时白名单
 * 自动跟随，不会漂移。
 */
export const ROW_CONFIG_KEYS: readonly string[] = Object.freeze(Object.keys(DEFAULT_CONFIG));

/**
 * 用户在行 config 里**显式写过**的白名单顶层键（含值为 `null` 的子树），照用户写的顺序。
 *
 * 白名单外的键不在这里（它们已经进 warnings）。装配层用它判定「用户配了本适配层没实现的模块」，
 * 好让 `/memory` 就地报出来 —— 白名单是从 `DEFAULT_CONFIG` 派生的，`dream` / `extractMemories`
 * 天生能通过校验，不报就是「无告警、无效果、无提示」的静默失效。
 */
export function rowConfigSetKeys(row: unknown): readonly string[] {
	if (row === null || typeof row !== "object" || Array.isArray(row)) return [];
	return Object.keys(row as Record<string, unknown>).filter((key) => ROW_CONFIG_KEYS.includes(key));
}

function defaultConfig(platform?: NodeJS.Platform): MemoryConfig {
	const config: MemoryConfig = { ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() };
	config.memoryDir = expandTilde(config.memoryDir, platform);
	return config;
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** 值是否符合 `DEFAULT_CONFIG` 里对应值的浅类型。对象类型的键额外接受 `null`（merge 的合法子树）。 */
function matchesType(value: unknown, expected: unknown): boolean {
	const want = typeof expected;
	if (want !== "object") return typeof value === want;
	return value === null || (typeof value === "object" && !Array.isArray(value));
}

/**
 * `model` 与 `sessionPersistence` 只在**承载模型配置的四个子树**里合法。
 *
 * 这两个子键在 core 的类型里合法、但在 `DEFAULT_CONFIG` 里没有默认值，所以只能靠名字认。
 * 光认名字不够：`lock.model` / `sessionSearch.sessionPersistence` 都是用户把 `model` 嵌套错一层的
 * 典型写法，而那一层错正好落在「配错模型名的人」身上 —— 静默并进去的后果是零告警，而
 * `/memory` 还会告诉他「你没配 model」，把他真做过的事否掉，并压掉唯一能暴露错误的那条诊断。
 */
const MODEL_BEARING_SUBTREES: readonly string[] = Object.freeze([
	"defaults",
	"dream",
	"autoSurfacing",
	"extractMemories",
]);

/**
 * 递归一层校验对象子键：已认识的子键按 `DEFAULT_CONFIG` 的 typeof 判型；`model` 与
 * `sessionPersistence` 是 core 类型里合法、但 `DEFAULT_CONFIG` 里没有默认值的可选子键，这里显式
 * 认它们（string / object）—— 但**只在 `MODEL_BEARING_SUBTREES` 里的父键下**，其他子树下的同名键
 * 走普通的 unknown-key 告警；其余子键进 warnings 而不是静默丢弃 —— 用户写错大小写
 * （`autoSurfacing.maxfiles`）时能看见。
 */
function sanitizeSubtree(
	path: string,
	value: Record<string, unknown>,
	expected: Record<string, unknown>,
	warnings: string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [sub, v] of Object.entries(value)) {
		const subPath = `${path}.${sub}`;
		if (Object.hasOwn(expected, sub)) {
			if (matchesType(v, expected[sub])) {
				out[sub] = v;
			} else {
				warnings.push(`config key "${subPath}" must be ${typeof expected[sub]}, got ${typeName(v)} — ignored`);
			}
		} else if (sub === "model" && MODEL_BEARING_SUBTREES.includes(path)) {
			if (typeof v === "string") out[sub] = v;
			else warnings.push(`config key "${subPath}" must be string, got ${typeName(v)} — ignored`);
		} else if (sub === "sessionPersistence" && MODEL_BEARING_SUBTREES.includes(path)) {
			if (matchesType(v, {})) out[sub] = v;
			else warnings.push(`config key "${subPath}" must be object, got ${typeName(v)} — ignored`);
		} else {
			warnings.push(`unknown config key "${subPath}" — ignored`);
		}
	}
	return out;
}

/**
 * 把 cordis 行 config 解析成合并后的 `MemoryConfig`。
 *
 * - `row` 是 `undefined` / `null` → 纯默认值；不是对象 → `error` 非空，`config` 仍返回默认值。
 * - 是对象 → 白名单外的顶层键与白名单内类型不对的键进 `warnings`（文案由 `/memory` 打印），
 *   合法部分经 `mergeConfig` 合并到 `{ ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() }` 上，
 *   最后展开 `memoryDir` 的 `~`。
 *
 * **共享引用注意**：`mergeConfig` 返回新顶层对象，但 overlay 未触及的嵌套子树仍与
 * `DEFAULT_CONFIG` 共享引用。本函数只给顶层 `config.memoryDir` 赋值，绝不原地改写嵌套子树；
 * 消费方（index.ts 的装配）也**不得**原地改写 `config.autoSurfacing` 这类嵌套对象，否则会污染整个进程的
 * `DEFAULT_CONFIG`。
 */
export function resolveRowConfig(row: unknown, platform?: NodeJS.Platform): ResolvedConfig {
	if (row === undefined || row === null) {
		return { config: defaultConfig(platform), warnings: [], error: null };
	}
	if (typeof row !== "object" || Array.isArray(row)) {
		return { config: defaultConfig(platform), warnings: [], error: "dsh-memory row config must be an object" };
	}

	const warnings: string[] = [];
	const overlay: Record<string, unknown> = {};
	const defaultsRecord = DEFAULT_CONFIG as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
		if (!ROW_CONFIG_KEYS.includes(key)) {
			warnings.push(`unknown config key "${key}" — ignored`);
			continue;
		}
		const expected = defaultsRecord[key];
		if (!matchesType(value, expected)) {
			warnings.push(`config key "${key}" must be ${typeof expected}, got ${typeName(value)} — ignored`);
			continue;
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			overlay[key] = sanitizeSubtree(key, value as Record<string, unknown>, expected as Record<string, unknown>, warnings);
		} else {
			overlay[key] = value;
		}
	}

	const config = mergeConfig({ ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() }, overlay);
	config.memoryDir = expandTilde(config.memoryDir, platform);
	return { config, warnings, error: null };
}
