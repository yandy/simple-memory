import { truncateForInjection } from "@yandy0725/memory-core";
import { errorMessage } from "./errors.js";

/**
 * `search scope=sessions` 的自己扫实现：对齐 `pi-memory/src/session-search.ts`
 * 的语义 —— 同一份记忆、同一个 query，在两个 harness 里搜出可比的结果。宿主的 SQLite FTS 默认关
 * （`dsh-base` 把 `session-query-sqlite` 配成 `openAt: never` + `path: ':memory:'`），打开它会让
 * dsh 的召回强于 pi，且会为每个会话建持久索引，所以这里纯扫，不碰宿主配置。
 *
 * 本模块零运行时宿主 import：`ctx.sessionQuery` 的形状用下面的结构化子集表达，由装配层把真
 * `ctx.sessionQuery` 喂进来。
 */

/** 宿主 `SessionHeader`（`dsh-session/lib/types/types.d.ts:59-92`）里本模块用到的字段。 */
export interface SessionHeaderLike {
	id: string;
	cwd?: string;
	title?: string;
	/** 非负安全整数 Unix epoch 毫秒（宿主类型里是 `number`，不是字符串）。 */
	createdAt?: number;
}

/** 宿主 `SessionRecord`（`dsh-session-query/lib/types/types.d.ts:14-31`）的结构化最小子集。 */
export interface SessionRecordLike {
	header: SessionHeaderLike;
	live?: boolean;
	persisted?: boolean;
	formatStatus?: "current" | "migration-required";
}

/** 宿主 `SessionLogSnapshot`（`dsh-session-query/lib/types/types.d.ts:52-60`）的结构化最小子集。 */
export interface SessionLogSnapshotLike {
	session: SessionHeaderLike;
	inheritedEventCount?: number;
	events: SessionEventLike[];
}

/** 宿主 `SessionEvent` 的结构化最小子集：本模块只要 type + data。 */
export interface SessionEventLike {
	type: string;
	data: unknown;
}

/**
 * `ctx.sessionQuery` 的结构化最小子集。
 *
 * `listSessions` 在这里**只是形状**：宿主签名是 `listSessions(signal?: AbortSignal)`（裸数组、
 * newest-first、只收一个 AbortSignal）—— 把查询对象传进去时 `typeof options === "object"` 为真、
 * 各字段全 `undefined`，会**静默返回整个语料**。cwd 过滤在 `filterSessions`（宿主同文件 :81）。
 */
export interface SessionQueryLike {
	listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>;
	filterSessions(filters: ReadonlyArray<{ kind: string; values?: unknown }>, signal?: AbortSignal): Promise<SessionRecordLike[]>;
	readSession(sessionId: string): Promise<SessionLogSnapshotLike>;
}

/**
 * `user/message` 是否真人写的：白名单，只认 `source.kind === "user"`。
 *
 * 宿主 `MessageSourceMap`（`dsh-llm/lib/types/message.d.ts:101`）把真人来源声明为
 * `user: { kind: 'user' }`，`user-rpc` 也复用 `kind: 'user'`；其余 kind 都是注入/工具/模型来源。
 * 该映射是**可合并扩展**的（每个插件可声明自己的 kind），黑名单结构上不可能完备 —— 漏一项的后果
 * 是把注入噪声当真人发言静默搜出来，正是本模块要避免的静默降精度。白名单的失败模式（宿主改了
 * kind 名 → 搜索返回空）远比黑名单的（注入噪声静默变可搜）显眼。
 *
 * 完全没有 `source`、或 `kind` 非字符串的 `user/message` 归为非真人（宿主把 `source` 定为必填，
 * 这只是防御）：缺失 source ⇒ 对搜索不可见，是一个刻意的静默召回决策。
 */
function isHumanUserSource(kind: unknown): boolean {
	return kind === "user";
}

function stringPart(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * content 抽文本：`type === "text"` 的 block 取 `text`，空格连接。content 可能是字符串或数组，
 * 与 pi 的 `extractText` 一致（pi 也只认字符串与 `type === "text"` 的数组）。
 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join(" ");
}

/**
 * 单条事件的可搜文本抽取（内部纯函数，直接可单测）。可搜类型限定为四类：
 * `user/message` / `assistant/message` / `tool/call` / `tool/result`。
 * `todo/write` 与 `turn/end` 虽然在宿主的 `extractSessionEventText`
 * （`dsh-session-query/lib/index.js`）里会被抽，但 pi 搜不到它们（pi 只扫 message 文本），
 * 为了跨宿主同语义（同一份记忆、同一个 query，两边要搜出可比的结果）这里**刻意不抽** —— 不要当"遗漏"补回来。
 * 其余类型（`turn/start`、`step/start`、`step/end`、`assistant/attempt`、`request/header` 等）
 * 一律贡献空串。
 */
function eventText(event: SessionEventLike): string {
	const data = event.data;
	switch (event.type) {
		case "user/message": {
			const message = data as { content?: unknown; source?: { kind?: unknown } } | null | undefined;
			if (!isHumanUserSource(message?.source?.kind)) return "";
			return contentText(message?.content);
		}
		case "assistant/message": {
			const message = (data as { message?: { content?: unknown } } | null | undefined)?.message;
			return contentText(message?.content);
		}
		case "tool/call": {
			// 宿主 `tool/call` 的 `arguments` 是**原始 JSON 字符串**（未解析），直接拼接即可。
			const call = data as { name?: unknown; arguments?: unknown } | null | undefined;
			return [stringPart(call?.name), stringPart(call?.arguments)].filter(Boolean).join(" ");
		}
		case "tool/result": {
			const result = data as
				| { message?: { content?: unknown }; error?: { name?: unknown; code?: unknown } }
				| null
				| undefined;
			return [
				contentText(result?.message?.content),
				stringPart(result?.error?.name),
				stringPart(result?.error?.code),
			]
				.filter(Boolean)
				.join(" ");
		}
		default:
			return "";
	}
}

/** 缺 `createdAt` / 非法值时不输出 `NaN-NaN-NaN`，而是让调用方省略括号里的日期。 */
function formatDate(createdAt: number | undefined): string {
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return "";
	try {
		return new Date(createdAt).toISOString().slice(0, 10);
	} catch {
		return "";
	}
}

function formatHeading(header: SessionHeaderLike): string {
	const date = formatDate(header.createdAt);
	return date === "" ? `## Session ${header.id}` : `## Session ${header.id} (${date})`;
}

/**
 * 把 `ctx.sessionQuery` 包成 core 的 `searchSessions(cwd, query, cfg)` 依赖。
 *
 * - cwd 过滤**只**走 `filterSessions([{ kind: "cwd", values: [cwd] }])`，绝不把查询对象塞给
 *   `listSessions`（那只接受 AbortSignal）。
 * - 宿主返回 newest-first 裸数组 → 取前 `maxSessions` 即「最近 N 个会话」。
 * - 逐个 `readSession(id)` 拿解码后的事件，抽取文本、大小写不敏感子串匹配、±50 消息上下文窗口，
 *   `maxMatches` 封顶，整体截到 2000 行 / 50000 字节。
 * - 任何宿主方法抛错（含 `SESSION_QUERY_SEARCH_DISABLED`）都转成一句可读文本，**不抛错**。
 */
export function createSessionSearch(
	sq: SessionQueryLike,
): (cwd: string, query: string, cfg: { maxSessions: number; maxMatches: number }) => Promise<string> {
	return async (cwd, query, cfg) => {
		try {
			const q = query.toLowerCase();
			// 空 / 全空白 query 不能匹配一切（core 的 handler 已挡在门外，本模块仍自保）。
			if (q.trim() === "") return "No matches in sessions.";

			const sessions = (await sq.filterSessions([{ kind: "cwd", values: [cwd] }]))
				.slice(0, cfg.maxSessions)
				// 纵深防御：宿主 cwd 过滤已经做过这事，但万一它哪天松了，失败模式是静默扫最近 N 个
				// 会话（跨项目）并当成本项目结果展示。`SessionHeader.cwd` 可选，缺 cwd 的记录在这里被
				// 丢弃 —— 那是安全方向（宁可少召回，不跨项目泄漏）。
				.filter((record) => record.header.cwd === cwd);
			const hits: string[] = [];
			for (const record of sessions) {
				const snapshot = await sq.readSession(record.header.id);
				const msgs: Array<{ text: string; idx: number }> = [];
				for (const [idx, event] of snapshot.events.entries()) {
					const text = eventText(event);
					if (text) msgs.push({ text, idx });
				}
				for (const m of msgs) {
					if (m.text.toLowerCase().includes(q)) {
						const context = msgs
							.filter((x) => Math.abs(x.idx - m.idx) <= 50)
							.map((x) => `  ${x.text.slice(0, 200)}`)
							.join("\n");
						hits.push(`${formatHeading(record.header)}\n…matched: "${m.text.slice(0, 150)}"…\ncontext:\n${context}`);
						if (hits.length >= cfg.maxMatches) break;
					}
				}
				if (hits.length >= cfg.maxMatches) break;
			}
			if (hits.length === 0) return "No matches in sessions.";
			return truncateForInjection(`Found ${hits.length} match(es):\n\n${hits.join("\n\n")}`, 2000, 50000).content;
		} catch (error) {
			return `Session search is unavailable in this host configuration: ${errorMessage(error)}`;
		}
	};
}
