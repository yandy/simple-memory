import { describe, expect, it } from "vitest";
import { readRecordedMemoryIndex } from "../src/index-source";

/**
 * 真实宿主的 `sessionEntryToContextMessages` 打一次真实形状。
 *
 * 其它用例把 SDK 模块 mock 成注入的 passthrough，entry 用的是 `{ type, messages }` 假形状 ——
 * 生产路径（具名 import 的转换器）从没被执行过。这个文件不注入 converter，entry 用宿主的
 * `{ type: "message", message }` 形状，钉住「真转换器 + 真 entry」这条最短路径。
 */
describe("readRecordedMemoryIndex（真实 SDK 转换器）", () => {
	const systemEntry = (sections: Record<string, string | null>) => ({
		type: "message",
		id: "e1",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "system", content: "", sections },
	});
	const sessionManager = (entries: unknown[]) => ({ getEntries: () => entries, getLeafId: () => null });

	it("converts host session entries and unwraps the recorded section", () => {
		const wrapped = "<memory_index>\n- [A](a.md) — d\n</memory_index>";

		// 宿主的包裹是 `<name>\n${content}\n</name>`：脱一层后 content 不带尾部换行。
		expect(readRecordedMemoryIndex(sessionManager([systemEntry({ memory_index: wrapped })]))).toBe("- [A](a.md) — d");
	});

	it("keeps an unwrapped recorded value as-is", () => {
		expect(readRecordedMemoryIndex(sessionManager([systemEntry({ memory_index: "bare" })]))).toBe("bare");
	});

	it("returns null when the record was deleted by a later null patch", () => {
		const entries = [systemEntry({ memory_index: "v1" }), systemEntry({ memory_index: null })];

		expect(readRecordedMemoryIndex(sessionManager(entries))).toBeNull();
	});
});
