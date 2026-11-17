import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { pathConfigErrors } from "../src/config.js";

/**
 * 跨平台路径校验。
 *
 * 存在理由：`resolveMemoryDir` 对 `memoryDir` 只做 `resolve()`，于是**另一个平台**写法的绝对路径
 * 会被静默改写成「相对当前工作目录」的路径（POSIX 上 `E:/shared/x` → `<cwd>/E:/shared/x`；
 * Windows 上 `/mnt/shared/x` → `<当前盘>:\mnt\shared\x`）。那不是一个可读的失败，而是一个悄悄
 * 分叉出去的新记忆库 —— 用户看到的是「记忆全没了」。
 */
describe("pathConfigErrors", () => {
	const configWith = (memoryDir: string) => ({ ...DEFAULT_CONFIG, memoryDir });

	const errorsOf = (memoryDir: string, platform: NodeJS.Platform) => pathConfigErrors(configWith(memoryDir), platform);

	it("is silent for a POSIX absolute path on a POSIX platform", () => {
		expect(errorsOf("/mnt/shared/pi-memory", "linux")).toEqual([]);
		expect(errorsOf("/mnt/shared/pi-memory", "darwin")).toEqual([]);
	});

	it("is silent for a Windows path on win32 (drive letter, UNC, ~\\)", () => {
		expect(errorsOf("E:\\shared\\pi-memory", "win32")).toEqual([]);
		expect(errorsOf("E:/shared/pi-memory", "win32")).toEqual([]);
		expect(errorsOf("\\\\server\\share\\pi-memory", "win32")).toEqual([]);
		expect(errorsOf("~\\shared\\pi-memory", "win32")).toEqual([]);
	});

	it("is silent for a plain relative path (documented: resolved against the cwd)", () => {
		expect(errorsOf("./memories", "linux")).toEqual([]);
		expect(errorsOf("memories", "win32")).toEqual([]);
	});

	// 唯一允许「长得像盘符」的相对目录的写法：显式加上 `./`。守卫必须给它留活路，
	// 否则用户会陷入「配什么都不对」的境地。
	it("allows a drive-shaped relative directory when it is explicitly relative", () => {
		expect(errorsOf("./C:/not-a-drive", "linux")).toEqual([]);
	});

	it("flags a Windows drive-letter path on POSIX", () => {
		for (const platform of ["linux", "darwin", "freebsd"] as NodeJS.Platform[]) {
			const errors = errorsOf("E:/shared/pi-memory", platform);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain('"memoryDir"');
			expect(errors[0]).toContain("E:/shared/pi-memory");
			expect(errors[0]).toContain("Windows");
			expect(errors[0]).toContain(platform === "linux" ? "linux" : platform);
		}
	});

	it("flags a Windows path written with backslashes on POSIX", () => {
		expect(errorsOf("E:\\shared\\pi-memory", "linux")).toHaveLength(1);
	});

	it("flags a UNC path on POSIX", () => {
		const errors = errorsOf("\\\\server\\share\\pi-memory", "linux");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("\\\\server\\share\\pi-memory");
	});

	it("flags a POSIX-rooted path on win32", () => {
		const errors = errorsOf("/mnt/shared/pi-memory", "win32");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"memoryDir"');
		expect(errors[0]).toContain("/mnt/shared/pi-memory");
		expect(errors[0]).toContain("win32");
	});

	// 空串与全空白都不是「没配」：`resolve("")` 是当前工作目录，于是记忆会写到**启动目录**里。
	it("flags an empty or whitespace-only memoryDir on every platform", () => {
		for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
			for (const value of ["", "   ", "\t"]) {
				const errors = errorsOf(value, platform);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain('"memoryDir"');
				expect(errors[0]).toContain("empty");
			}
		}
	});

	it("never mutates the config it is given", () => {
		const cfg = configWith("E:/shared/pi-memory");
		const before = structuredClone(cfg);
		pathConfigErrors(cfg, "linux");
		expect(cfg).toEqual(before);
	});

	// `mergeConfig` 不校验类型，手写配置里 `"memoryDir": 5` 会一直传到 `resolve()` 才抛 TypeError。
	it("flags a non-string memoryDir instead of letting resolve() throw", () => {
		const errors = pathConfigErrors({ memoryDir: 5 } as unknown as typeof DEFAULT_CONFIG, "linux");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"memoryDir"');
		expect(errors[0]).toContain("must be a string");
	});

	// 文案里点名的配置来源由适配层注入（与 modelConfigErrors / syncConfigErrors 同一约定）：
	// core 不写宿主的文件名。
	it("names the injected config source instead of a host file name", () => {
		const errors = pathConfigErrors(configWith("E:/shared/pi-memory"), "linux", { configSource: "plugin row config" });
		expect(errors[0]).toContain("plugin row config");
		expect(errors[0]).not.toContain("memory.json");
	});
});
