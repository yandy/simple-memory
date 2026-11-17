import { describe, expect, it } from "vitest";
// 刻意从**包的公开出口**导入：这组符号是宿主共用的唯一一份实现，适配层就是从出口拿它们。
import {
	type SyncRoundResult,
	type SyncStatusReport,
	renderSyncRound,
	renderSyncStatus,
	syncErrorMessage,
} from "../src/index.js";

/** 一轮同步的完整形状：字段一个不缺，用例只按需覆盖自己关心的那几项。 */
function round(over: Partial<SyncRoundResult> = {}): SyncRoundResult {
	return {
		ok: true,
		pulled: [],
		pushed: [],
		deletedLocal: [],
		deletedRemote: [],
		conflicts: [],
		rejected: [],
		unparsableLocal: [],
		outOfScopeRemote: [],
		...over,
	};
}

/** `status` 报告的完整形状（同上）。路径刻意放在 `/tmp` 下：它是记忆根，不是宿主的命令。 */
function status(over: Partial<SyncStatusReport> = {}): SyncStatusReport {
	return {
		configured: true,
		initialized: true,
		remote: "https://origin.example.invalid/org/memory.git",
		branch: "main",
		device: { id: "device-1", hostname: "host-a", createdAt: "2026-01-01T00:00:00.000Z" },
		projectDir: "/tmp/memory-root/project",
		projectKey: "example.com__org__memory",
		base: { revision: "rev-123", syncedAt: "2026-11-15T01:02:03.000Z" },
		ahead: [],
		behind: [],
		conflicts: [],
		rejected: [],
		unparsableLocal: [],
		outOfScopeRemote: [],
		errors: [],
		...over,
	};
}

describe("syncErrorMessage", () => {
	it("HTTP(S) 的 token-only userinfo 整段变 `***`，`user:pass` 只隐去口令，普通 URL 不动", () => {
		// 后两种 scheme（含 git+ 别名）里整个 userinfo 都是秘密：`https://<token>@host/...`
		// 是 CI 上免交互推送的常规写法，整段必须消失。带冒号的既有写法仍保留用户名。
		expect(syncErrorMessage("failed https://token-only@example.invalid/o/r.git")).toBe(
			"failed https://***@example.invalid/o/r.git",
		);
		expect(syncErrorMessage("failed git+https://token-only@example.invalid/o/r.git")).toBe(
			"failed git+https://***@example.invalid/o/r.git",
		);
		expect(syncErrorMessage("failed https://user:password@example.invalid/o/r.git")).toBe(
			"failed https://user:***@example.invalid/o/r.git",
		);
		expect(syncErrorMessage("failed https://example.invalid/o/r.git")).toBe("failed https://example.invalid/o/r.git");
	});

	it("Error 只取 message，非 Error 输入先归一成字符串再脱敏", () => {
		// 宿主打印/通知走的是 `error.message`；带上 `Error: ` 前缀就等于让同一个原因有两种文本形状。
		expect(syncErrorMessage(new Error("push https://token@example.invalid/o/r.git rejected"))).toBe(
			"push https://***@example.invalid/o/r.git rejected",
		);
		// 同步口径里抛出来的不一定是 Error（子进程 stderr、字符串 cause），非 Error 也必须能渲染
		expect(syncErrorMessage("clone https://token@example.invalid/o/r.git failed")).toBe(
			"clone https://***@example.invalid/o/r.git failed",
		);
	});
});

describe("renderSyncRound", () => {
	it("失败轮也展开全部部分结果，文件名去重排序，重复的冲突/拒收只留第一条", () => {
		const result = round({
			ok: false,
			skipped: { reason: "fetch https://token-only@example.invalid/private failed" },
			revision: "rev-1",
			pulled: ["z.md", "a.md", "z.md"],
			pushed: ["p.md", "p.md"],
			deletedLocal: ["d.md", "d.md"],
			deletedRemote: ["r.md", "r.md"],
			conflicts: [
				{ file: "c.md", keptAsNew: "c-1.md" },
				{ file: "c.md", keptAsNew: "c-2.md" },
			],
			rejected: [
				{ file: "bad.md", reason: "invalid modified" },
				{ file: "bad.md", reason: "duplicate rejection" },
			],
			unparsableLocal: ["u.md", "u.md"],
			outOfScopeRemote: ["MEMORY.md", "MEMORY.md"],
		});

		const text = renderSyncRound(result);

		expect(text).toContain("Result: failed");
		expect(text).toContain("Reason: fetch https://***@example.invalid/private failed");
		expect(text).not.toContain("token-only");
		expect(text).toContain("Revision: rev-1");
		expect(text).toContain("Pulled (2): a.md, z.md");
		expect(text).toContain("Pushed (1): p.md");
		expect(text).toContain("Deleted local (1): d.md");
		expect(text).toContain("Deleted remote (1): r.md");
		expect(text).toContain("Conflicts (1):\n- c.md -> c-1.md");
		expect(text).not.toContain("c-2.md");
		expect(text).toContain("Rejected (1):\n- bad.md: invalid modified");
		expect(text).not.toContain("duplicate rejection");
		expect(text).toContain("Unparsable local (1): u.md");
		expect(text).toContain("Out of scope remote (1): MEMORY.md");
	});

	it("revision 缺席不打印，空串打印 `(empty)`", () => {
		const result = round({ revision: undefined });
		expect(renderSyncRound(result)).not.toContain("Revision:");
		expect(renderSyncRound({ ...result, revision: "" })).toContain("Revision: (empty)");
	});

	it("空列表逐项渲染成 `none`，成功轮不打印 Reason", () => {
		const text = renderSyncRound(round());
		expect(text).toContain("Result: ok");
		expect(text).not.toContain("Reason:");
		expect(text).toContain("Pulled: none");
		expect(text).toContain("Pushed: none");
		expect(text).toContain("Deleted local: none");
		expect(text).toContain("Deleted remote: none");
		expect(text).toContain("Conflicts: none");
		expect(text).toContain("Rejected: none");
		expect(text).toContain("Unparsable local: none");
		expect(text).toContain("Out of scope remote: none");
	});
});

describe("renderSyncStatus", () => {
	it("渲染全部共同字段：origin、映射、基线、差异、拒收与错误，列表去重排序", () => {
		const text = renderSyncStatus(
			status({
				remote: "https://origin-token@example.invalid/org/memory.git",
				ahead: ["z.md", "a.md", "z.md"],
				behind: ["y.md", "b.md", "y.md"],
				conflicts: ["z.md", "c.md", "z.md"],
				rejected: [
					{ file: "z.md", reason: "bad" },
					{ file: "a.md", reason: "bad" },
					{ file: "z.md", reason: "duplicate rejection" },
				],
				unparsableLocal: ["u.md", "broken.md", "u.md"],
				outOfScopeRemote: ["MEMORY.md", "git/x/nested/z.md", "MEMORY.md"],
				errors: ["second", "first https://error-token@example.invalid/x", "second"],
			}),
			"https://configured-token@example.invalid/org/memory.git",
		);

		expect(text).toContain("Configured: yes");
		expect(text).toContain("Initialized: yes");
		// userinfo 全是 token：整段变 `***`（断言的是秘密消失，而不是某一种 scheme 的写法）
		expect(text).toContain("Origin: https://***@example.invalid/org/memory.git");
		expect(text).toContain("Configured remote: https://***@example.invalid/org/memory.git");
		expect(text).not.toMatch(/origin-token|configured-token|error-token/);
		expect(text).toContain("Branch: main");
		expect(text).toContain("Device: host-a (device-1)");
		expect(text).toContain("Project: /tmp/memory-root/project -> example.com__org__memory");
		expect(text).toContain("Base: rev-123 at 2026-11-15T01:02:03.000Z");
		expect(text).toContain("Ahead (2): a.md, z.md");
		expect(text).toContain("Behind (2): b.md, y.md");
		expect(text).toContain("Conflicts (2): c.md, z.md");
		expect(text).toContain("Rejected (2):\n- a.md: bad\n- z.md: bad");
		expect(text).not.toContain("duplicate rejection");
		expect(text).toContain("Unparsable local (2): broken.md, u.md");
		expect(text).toContain("Out of scope remote (2): MEMORY.md, git/x/nested/z.md");
		expect(text).toContain("Errors (2):\n- first https://***@example.invalid/x\n- second");
		// 两侧指向同一个仓库（userinfo 不参与等价比较）：不算漂移，也不该有提示
		expect(text).not.toContain("differs");
	});

	it("配置与 origin 漂移时追加注入的中立提示，尾部行按原序追加", () => {
		const drift = "configured remote differs from the initialized origin; keep using origin";
		const text = renderSyncStatus(
			status({ remote: "https://origin.example.invalid/org/memory.git" }),
			"https://configured.example.invalid/org/other.git",
			{ originDriftMessage: drift, trailingLines: ["first trailing line", "second trailing line"] },
		);

		expect(text).toContain("Origin: https://origin.example.invalid/org/memory.git");
		expect(text).toContain("Configured remote: https://configured.example.invalid/org/other.git");
		// core 只负责追加宿主给的那一句：文案本身（含任何命令指引）不在 core 里
		expect(text).toContain(drift);
		expect(text.indexOf(drift)).toBeLessThan(text.indexOf("first trailing line"));
		expect(text.indexOf("first trailing line")).toBeLessThan(text.indexOf("second trailing line"));
	});

	it("漂移提示为空串时不追加空行，尾部行仍紧跟共同字段", () => {
		const text = renderSyncStatus(status(), "https://configured.example.invalid/org/other.git", {
			originDriftMessage: "",
			trailingLines: ["first trailing line"],
		});

		expect(text.endsWith("Errors: none\nfirst trailing line")).toBe(true);
		expect(text).not.toContain("Errors: none\n\nfirst trailing line");
	});

	it("没有漂移时不追加注入的提示", () => {
		const drift = "should not appear";
		const text = renderSyncStatus(status(), "https://origin.example.invalid/org/memory.git", {
			originDriftMessage: drift,
		});
		expect(text).not.toContain(drift);
	});

	it("没有漂移时尾部行照样按原序追加在 `Errors: none` 之后", () => {
		// 尾行和漂移**无关**：它报的是跨宿主一致的报告尾巴（例如本轮之外的补充行），
		// 不该被「这一轮有没有漂移」分成两种行为。
		const drift = "should not appear";
		const text = renderSyncStatus(status(), "https://origin.example.invalid/org/memory.git", {
			originDriftMessage: drift,
			trailingLines: ["first trailing line", "second trailing line"],
		});

		expect(text).not.toContain(drift);
		// 顺序断言用相对关系：三条行必须按「Errors → 第一条尾行 → 第二条尾行」真实出现
		const errorsIndex = text.indexOf("Errors: none");
		expect(errorsIndex).toBeGreaterThan(-1);
		expect(errorsIndex).toBeLessThan(text.indexOf("first trailing line"));
		expect(text.indexOf("first trailing line")).toBeLessThan(text.indexOf("second trailing line"));
		expect(text.endsWith("second trailing line")).toBe(true);
	});

	it("origin 或配置为空时既不算漂移，也照实打印 `(not set)` / `none`", () => {
		const drift = "should not appear";
		// 已配置但还没初始化：没有 origin 可比，不构成漂移
		const originUnset = renderSyncStatus(
			status({ remote: "", base: null }),
			"https://configured.example.invalid/org/other.git",
			{ originDriftMessage: drift },
		);
		expect(originUnset).toContain("Origin: (not set)");
		expect(originUnset).toContain("Base: none");
		expect(originUnset).toContain("Errors: none");
		expect(originUnset).not.toContain(drift);

		// 反过来：origin 在，但配置留空（合法状态：地址只存在已初始化的 origin 里）
		const configuredUnset = renderSyncStatus(status(), "   ", { originDriftMessage: drift });
		expect(configuredUnset).toContain("Configured remote: (not set)");
		expect(configuredUnset).not.toContain(drift);
	});

	it("漂移但宿主没注入提示时只渲染共同字段，末尾不留空行", () => {
		// core 不通自己补一句：「漂移了该去改哪里」是宿主的展示策略，core 没有可说的话。
		// 尾行缺席也要真的什么都不加 —— 推一个空串会留下一个看着像渲染 bug 的末尾空行。
		const drifted = status();
		const configured = "https://configured.example.invalid/org/other.git";
		expect(renderSyncStatus(drifted, configured).endsWith("Errors: none")).toBe(true);
		expect(renderSyncStatus(drifted, configured, { trailingLines: [] }).endsWith("Errors: none")).toBe(true);
	});

	it("不传选项时也渲染完整报告，且不追加任何尾部行", () => {
		const text = renderSyncStatus(status(), "https://origin.example.invalid/org/memory.git");
		// 末尾就是最后一行共同字段：Options 缺席不得留下空行或占位
		expect(text.endsWith("Errors: none")).toBe(true);
	});
});
