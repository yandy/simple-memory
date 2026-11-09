import { DEFAULT_CONFIG, defaultMemoryRoot, expandTilde, mergeConfig } from "@yandy0725/memory-core";
import type { MemoryConfig } from "@yandy0725/memory-core";

/**
 * dsh-memory 唯一的配置层。
 *
 * 设计（spec §2 D4/D5）：**不读任何配置文件**。配置只来自 cordis 行 `config:`，宿主在
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
 * 递归一层校验对象子键：已认识的子键按 `DEFAULT_CONFIG` 的 typeof 判型；`model` 与
 * `sessionPersistence` 是 core 类型里合法、但 `DEFAULT_CONFIG` 里没有默认值的可选子键，这里显式
 * 认它们（string / object）；其余子键进 warnings 而不是静默丢弃 —— 用户写错大小写
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
		} else if (sub === "model") {
			if (typeof v === "string") out[sub] = v;
			else warnings.push(`config key "${subPath}" must be string, got ${typeName(v)} — ignored`);
		} else if (sub === "sessionPersistence") {
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
 * **共享引用注意**（Task 1 的 M3）：`mergeConfig` 返回新顶层对象，但 overlay 未触及的嵌套子树仍与
 * `DEFAULT_CONFIG` 共享引用。本函数只给顶层 `config.memoryDir` 赋值，绝不原地改写嵌套子树；
 * 消费方（Task 16）也**不得**原地改写 `config.autoSurfacing` 这类嵌套对象，否则会污染整个进程的
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
