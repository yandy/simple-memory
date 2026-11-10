import type { SessionPersistenceConfig } from "../config.js";
import type { EntryManifest } from "../injection.js";
import { buildSideQueryTask, renderSurfacedBlock } from "../injection.js";
import type { HeadlessAgentPort } from "./ports.js";
import type { MemoryTask } from "./task.js";

export interface SurfacingInput {
	/** 本轮的候选清单（`scanEntries` 的产出）。 */
	manifest: EntryManifest[];
	/** 用户这一轮的输入（调用方负责先截到预算内）。 */
	userPrompt: string;
	/** 本 session 已经注入过的文件，不再重复选。 */
	injectedFiles: Set<string>;
}

export interface SurfacingResult {
	/** 本轮选中且渲染成功的文件；渲染不出内容时恒为 `[]`（不标记已注入）。 */
	files: string[];
	content: string;
}

/** 去掉已注入的文件，得到真正进入侧查询的候选清单。 */
function candidates(input: SurfacingInput): EntryManifest[] {
	return input.manifest.filter((entry) => !input.injectedFiles.has(entry.file));
}

/** 从侧查询的回复里解析 `selected_files`，只保留确实在候选清单里的文件。 */
function parseSelectedFiles(result: string, candidates: EntryManifest[], maxFiles: number): string[] {
	try {
		const jsonMatch = result.match(/\{[^}]*"selected_files"[^}]*\}/s);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]);
		const files: string[] = parsed.selected_files ?? [];
		return files.filter((f: string) => candidates.some((c) => c.file === f)).slice(0, maxFiles);
	} catch {
		return [];
	}
}

/** autoSurfacing 描述符：core 自读 `cfg.autoSurfacing` 的预算，适配层只给宿主数据。 */
export const autoSurfacing: MemoryTask<SurfacingInput, SurfacingResult> = {
	id: "autoSurfacing",
	plan: {
		maxTurns: 1,
		timeoutMs: 30_000,
		memoryTool: null,
		lock: "none",
		errorPolicy: "swallow",
	},
	buildPrompt(cfg, _deps, input) {
		const remaining = candidates(input);
		if (remaining.length === 0) return null;
		return buildSideQueryTask(remaining, input.userPrompt, cfg.autoSurfacing.maxFiles);
	},
	async parse(cfg, deps, input, text) {
		const files = parseSelectedFiles(text, candidates(input), cfg.autoSurfacing.maxFiles);
		const content = await renderSurfacedBlock(
			deps.store,
			files,
			cfg.autoSurfacing.maxEntryBytes,
			cfg.autoSurfacing.maxInjectionBytes,
		);
		// 渲染不出来的文件不该被适配层标记为已注入：内容为空时文件列表一并清空。
		return content === "" ? { files: [], content: "" } : { files, content };
	},
	notCompleted() {
		return { files: [], content: "" };
	},
};

export interface RunSideQueryOpts {
	/** 本轮的候选清单（`scanEntries` 的产出）。 */
	manifest: EntryManifest[];
	/** 用户这一轮的输入（调用方负责先截到预算内）。 */
	userPrompt: string;
	/** 本 session 已经注入过的文件，不再重复选。 */
	injectedFiles: Set<string>;
	maxFiles: number;
	/** 宿主的思考/推理档位，core 原样透传。 */
	effort?: string;
	model: string;
	/** 子会话 cwd；传 memoryDir。 */
	cwd: string;
	/**
	 * 宿主那一轮的取消信号，原样透传给端口的 `HeadlessRunRequest.signal`。
	 * 适配层通常在「宿主会 await 的钩子」里调用本函数（例如每轮开始前），此时不传 signal 意味着
	 * 用户取消后，调用方仍要等满 `timeoutMs` 才拿得到一个没人要的结果。
	 */
	signal?: AbortSignal;
	sessionPersistence?: SessionPersistenceConfig;
}

/**
 * 【过渡】跑一轮轻量侧查询，选出与用户输入相关的 entry 文件名。
 *
 * Task 7 删除本入口：适配层将直接调 `runTask(TASKS.autoSurfacing, input, ctx)` 并拿到
 * `{ files, content }`。保留期间保持旧签名与旧行为，适配层无需改动。
 *
 * 超时/失败一律返回 `[]`，**没有回退**：auto-surfacing 是纯增益，选不出来就不注入，
 * 绝不因为侧查询挂了而打断用户这一轮。
 */
export async function runSideQuery(
	opts: RunSideQueryOpts,
	ports: { headless: HeadlessAgentPort },
): Promise<string[]> {
	const remaining = opts.manifest.filter((entry) => !opts.injectedFiles.has(entry.file));
	if (remaining.length === 0) return [];
	const task = buildSideQueryTask(remaining, opts.userPrompt, opts.maxFiles);
	try {
		const result = await ports.headless.run({
			task,
			cwd: opts.cwd,
			model: opts.model,
			effort: opts.effort,
			maxTurns: 1,
			timeoutMs: 30_000,
			signal: opts.signal,
			// 零工具就是意图：侧查询只需要回一个 JSON，给它任何工具都是白烧 token。
			builtinTools: "none",
			memoryTool: null,
			sessionPersistence: opts.sessionPersistence,
		});
		if (result.status !== "completed") return [];
		return parseSelectedFiles(result.text, remaining, opts.maxFiles);
	} catch {
		return [];
	}
}
