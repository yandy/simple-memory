import { describe, expect, it } from "vitest";
import { errorCode, errorDetail, errorMessage } from "../src/errors.js";

describe("errorMessage", () => {
	it("returns a thrown string verbatim, including the empty string", () => {
		expect(errorMessage("boom")).toBe("boom");
		// 空串也是一条信息：判空是调用方的事（store-registry 靠它退到 "no working directory available"）。
		expect(errorMessage("")).toBe("");
	});

	it("returns Error.message verbatim, including the empty string", () => {
		expect(errorMessage(new Error("disk gone"))).toBe("disk gone");
		expect(errorMessage(new Error(""))).toBe("");
	});

	it("reads .message off a thrown plain object instead of yielding [object Object]", () => {
		// 这是收敛到一份实现的全部理由：`String(e)` 在这种情况下给出 "[object Object]"，
		// 而那正是用户最需要看见原因的时刻。
		expect(errorMessage({ message: "host said no" })).toBe("host said no");
		expect(errorMessage({ code: "NO_ADAPTER", message: "no adapter" })).toBe("no adapter");
		expect(String({ message: "host said no" })).toBe("[object Object]");
	});

	it("falls back to JSON for a value with no usable message", () => {
		expect(errorMessage({ code: "NO_ADAPTER" })).toBe('{"code":"NO_ADAPTER"}');
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(null)).toBe("null");
		expect(errorMessage(true)).toBe("true");
	});

	it("never returns undefined and never leaks it into a template string", () => {
		// `JSON.stringify(undefined)` 的运行时结果是 `undefined`（声明类型骗人）。
		expect(errorMessage(undefined)).toBe("unknown error");
		expect(`failed: ${errorMessage(undefined)}`).toBe("failed: unknown error");
	});

	it("survives a value JSON cannot serialise", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(errorMessage(circular)).toBe("unknown error");
		expect(errorMessage(10n)).toBe("unknown error");
	});
});

describe("errorDetail", () => {
	it("returns a sentence only when there really is one", () => {
		expect(errorDetail(new Error("disk gone"))).toBe("disk gone");
		expect(errorDetail({ message: "host said no" })).toBe("host said no");
		expect(errorDetail("boom")).toBe("boom");
	});

	it("returns null for empty or absent messages, and never JSON", () => {
		expect(errorDetail(new Error(""))).toBeNull();
		expect(errorDetail({ message: "" })).toBeNull();
		expect(errorDetail("")).toBeNull();
		// 关键分工：不做 JSON 兜底，否则「只有 code」的拒绝会把 code 抄第二遍进用户文案。
		expect(errorDetail({ code: "NO_ADAPTER" })).toBeNull();
		expect(errorDetail(undefined)).toBeNull();
		expect(errorDetail(null)).toBeNull();
	});
});

describe("errorCode", () => {
	it("reads a non-empty string code off any thrown shape", () => {
		expect(errorCode({ code: "UNSUPPORTED_REASONING_EFFORT" })).toBe("UNSUPPORTED_REASONING_EFFORT");
		expect(errorCode(Object.assign(new Error("boom"), { code: "NO_ADAPTER" }))).toBe("NO_ADAPTER");
	});

	it("returns null instead of the string \"undefined\" for a missing or empty code", () => {
		expect(errorCode(new Error("boom"))).toBeNull();
		expect(errorCode({ code: "" })).toBeNull();
		expect(errorCode({ code: 42 })).toBeNull();
		expect(errorCode("boom")).toBeNull();
		expect(errorCode(undefined)).toBeNull();
		expect(errorCode(null)).toBeNull();
	});
});
