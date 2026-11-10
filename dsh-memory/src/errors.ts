/**
 * 「宿主/库抛出来的任意值」→ 一句可读文本。
 *
 * 全适配层只此一份：`catch` 到的值不保证是 `Error`（宿主可能抛普通对象、字符串，甚至 `undefined`），
 * 而 `String(e)` 对普通对象只会给出 `"[object Object]"` —— 那正是用户最需要看见原因的时候
 * （`/memory` 的降级理由、启动日志、清锁失败）拿到的东西。
 */

/** 既不是文本也没有 `.message` 时的兜底：宁可说「不知道」，也不要漏一个 `undefined` 进用户文案。 */
const UNKNOWN = "unknown error";

/**
 * 取一句**总能拿到**的文本（全函数，永不抛错）。
 *
 * 优先级：字符串本身 → `Error.message` → 普通对象自己的 `.message` → `JSON.stringify` → 兜底。
 * `Error.message` 是空串时**原样返回空串**：那也是一条信息，判空是调用方的事
 * （store-registry 就用「空白 message 视同没有原因」来决定要不要退到 `no working directory available`）。
 */
export function errorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	try {
		const json = JSON.stringify(error);
		// `JSON.stringify` 的声明返回类型是 `string`，但传入 `undefined`（以及函数、symbol）时
		// 运行时返回的是 `undefined` —— 按运行时判，别把类型当保证。
		return typeof json === "string" ? json : UNKNOWN;
	} catch {
		// 循环引用、BigInt 等：JSON 也救不了。
		return UNKNOWN;
	}
}

/**
 * 只在**真有一句话可说**时返回它（`.message` 非空，或抛出的就是非空字符串），否则 `null`。
 *
 * 与 `errorMessage` 的分工：这个版本**不做** JSON 兜底，因为它服务的是「拼一句给用户看的诊断」——
 * 例如宿主只给了 `{ code: "NO_ADAPTER" }` 时，`errorMessage` 会返回 `{"code":"NO_ADAPTER"}`，
 * 把它接在已经打印过 code 的句子后面就是同一份信息抄两遍。
 */
export function errorDetail(error: unknown): string | null {
	if (typeof error === "string") return error === "" ? null : error;
	const message = (error as { message?: unknown } | null | undefined)?.message;
	return typeof message === "string" && message !== "" ? message : null;
}

/**
 * 抛出值上的错误码（宿主的失败通道普遍带 `code`，如 `NO_ADAPTER` / `UNSUPPORTED_REASONING_EFFORT`）。
 * 不是非空字符串就返回 `null` —— 绝不能把 `"undefined"` 漏进用户可见文案。
 */
export function errorCode(error: unknown): string | null {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" && code !== "" ? code : null;
}
