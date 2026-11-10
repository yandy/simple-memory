import type { EntryManifest } from "../injection.js";
import { buildSideQueryTask, renderSurfacedBlock } from "../injection.js";
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

