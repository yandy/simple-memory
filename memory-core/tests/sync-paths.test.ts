import { describe, expect, it } from "vitest";
import { remoteEntryPath, remotePrefix, remoteProjectKey } from "../src/sync/paths.js";
import { projectDirName } from "../src/store/paths.js";

describe("remoteProjectKey", () => {
	it("与宿主平台无关：恒等于 POSIX 规则的派生名", () => {
		// win32 上 projectDirName 会经 windowsSafeName 改写结尾的 "."；远端 key 不得跟随
		expect(remoteProjectKey("github.com/o/repo.")).toBe(projectDirName("github.com/o/repo.", { platform: "linux" }));
		expect(remoteProjectKey("github.com/o/repo.")).toBe("github.com__o__repo.");
		expect(remoteProjectKey("github.com/o/con")).toBe("github.com__o__con");
	});
	it("转义与截断沿用 projectDirName（长 key 截到 100 字节再带 8 位 sha256 后缀）", () => {
		const long = `github.com/o/${"r".repeat(200)}`;
		// 实测：truncateToBytes 从整个拼接串开头截 100 字节，前缀 "github.com__o__" 已占 15 → r 只剩 85
		expect(remoteProjectKey(long)).toMatch(/^github.com__o__r{85}__[0-9a-f]{8}$/);
		expect(remoteProjectKey(long).length).toBe(110);
	});
	it("remotePrefix / remoteEntryPath 拼出 spec 的布局", () => {
		expect(remotePrefix("github.com/o/r")).toBe("git/github.com__o__r");
		expect(remoteEntryPath("git/github.com__o__r", "foo.md")).toBe("git/github.com__o__r/foo.md");
	});
});
