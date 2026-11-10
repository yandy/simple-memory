import { format } from "node:util";

/**
 * 迷你假 cordis ctx —— Task 7–16 所有适配器测试的地基。
 *
 * 它刻意不 import 任何 `@deepseek-ai/*` 包：它模拟的是「我们观察到的宿主行为」，
 * 而不是「我们可能误读的宿主类型」。需要宿主形状的地方都在这里用本地结构化接口表达。
 *
 * 语义来源（recon notes + 宿主 `.d.ts`/`.js`，均已逐条核对；§2.3 的三处修正以本文件为准）：
 * - `agent/pre-step` 是 waterfall：最内层 `next()` 产出 base `{ kind: "enter", messages }`；
 *   `{ prepend: true }` 的监听器 unshift 到最外层（先进入、最后看到 decision、返回值胜出）。
 *   每个监听器拿到的 `next()` 只能调一次，第二次抛 `"next() called multiple times"`（cordis）。
 * - `agent/created` 串行且被 await，监听器抛出即创建失败；`agent/disposed` 是 fire-and-forget emit。
 * - 注册类方法（section/context/tools.register/commands.register/on）都返回普通 `() => void` disposer；
 *   同一层内重名注册抛错（tools 按 agent 作用域分层，agent 作用域合法遮蔽全局）。
 * - `tools.register` 校验 `output`：必须存在、带 `schema`、`render` 是函数，否则 `TypeError`。
 * - cordis 4 没有 `ctx.on("dispose")`；清理走 `ctx.effect`（立即执行，拥有回调返回的 disposer）。
 * - 根 ctx 的 `tools.register` 是全局的；`agent.ctx.tools.register` 按 agent 隔离、遮蔽全局。
 * - `ctx.llm.stream()` 的失败有两条通道：middleware/consumer 失败**真的抛**（`llmError`），
 *   而 adapter 选择/派发/迭代失败被宿主转成**终止 `finish` chunk**（`llmStreamFailure` / `llmStreamAborted`）。
 * - `sessionQuery.listSessions(signal?)` 返回**裸数组**、newest-first，只收 `AbortSignal`；
 *   cwd 过滤走另一个方法 `filterSessions([{ kind: "cwd", values: [cwd] }], signal)`。
 * - 子 agent 的官方分类字段是 `session.header.origin === "subagent"`；普通 fork 只带 `parentSession`，
 *   不带 `origin`/`delegationDepth`，仍是根 agent（`parentSession` 存在不足以判定子 agent）。
 */

export interface FakeAgent {
	id: string;
	sessionId: string;
	cwd: string;
	subagent: boolean;
	session: {
		id: string;
		header: { cwd: string } & Record<string, unknown>;
		/** `agent/turn-stopping` 的 extract 触发点会同步读它（宿主 `Session` 的结构化子集）。 */
		seq: number;
		snapshotEvents(from?: number, to?: number): readonly { type: string; data?: unknown }[];
	};
	/** 这条会话的事件日志（`snapshotEvents` 的来源）。 */
	events?: Array<{ type: string; data?: unknown }>;
}

export interface FakeCtxOptions {
	llmStream?: (opts: unknown) => AsyncIterable<unknown>;
	/** middleware/consumer 失败：`llm.stream` 与 `llm.resolveCallConfig` 真的抛（host 两条通道之一）。 */
	llmError?: { code: string; message: string };
	/** adapter 失败：`llm.stream` yield 终止 chunk `{ type:"finish", reason:{ kind:"error", failure:{code,message} } }`。 */
	llmStreamFailure?: { code: string; message?: string };
	/** 让 `llm.stream` yield 终止 chunk `{ type:"finish", reason:{ kind:"aborted" } }`。 */
	llmStreamAborted?: boolean;
	sessions?: FakeSessionInfo[];
	/**
	 * `ctx.agents.create()` 的行为脚本：入参是适配层传来的 create options（含 `setup`），返回这一轮
	 * 子会话要发生什么。缺省 = 一个默认步、事件为空、什么都不抛。
	 */
	childRun?: (options: any) => FakeChildScript | Promise<FakeChildScript>;
	/**
	 * 测试专用钩子：每次假 ctx 自己拥有的注册 disposer 执行时按注册种类（"section"/"context"/"tool"/"command"）
	 * 回调，用于钉住 `disposeAll` 的逆序执行。effect 回调返回的 disposer 是用户代码，自行记录。
	 */
	onDispose?: (kind: string) => void;
}

export interface FakeSessionInfo {
	id: string;
	cwd: string;
	/** Unix epoch ms；缺省时 listSessions/filterSessions 保持 fixture 顺序（稳定排序）。 */
	createdAt?: number;
	/** 是否当前在 `ctx.sessions` 里（宿主 `SessionRecord.live`）。缺省 true。 */
	live?: boolean;
	/** 是否被持久化后端列出（宿主 `SessionRecord.persisted`）。缺省 true。 */
	persisted?: boolean;
	events: Array<{ type: string; data: unknown }>;
}

export interface RecordedSection {
	name: string;
	order: number;
	interpolate?: boolean;
	text: unknown;
}

export interface RecordedTool {
	name: string;
	description: string;
	parameters: unknown;
	output: unknown;
	execute: (args: any, exec: any) => Promise<any>;
}

export interface RecordedCommand {
	name: string;
	description: string;
	input?: unknown;
	handler: (inv: any) => Promise<any>;
}

/**
 * 一次嵌套子会话的剧本。每一项都对应适配层必须翻成 core 词汇的一个宿主行为
 * （`agent-session.ts` 的结果映射表）。
 */
export interface FakeChildScript {
	/** `setup` 抛错（作用域装配失败：工具注册/限制失败都会走这里）。 */
	setupThrows?: string;
	/** `ctx.agents.create()` 本身拒绝（会话创建失败）。 */
	createThrows?: string;
	/** 这一轮跑多少个 step（默认 1）。`maxTurns` 的封顶靠它观察。 */
	steps?: number;
	/** 子会话这一轮落进日志的事件（`assistant/message` / `turn/end` …）。 */
	events?: Array<{ type: string; data?: unknown }>;
	/** `whenIdle` 拒绝（驱动层的传输级失败）。 */
	idleThrows?: string;
}

/** 子会话在测试里可观察到的状态。 */
export interface FakeChildSession {
	sessionId: string;
	meta: any;
	agentOptions: any;
	/** 落进日志的事件系数（按 `turn/end` 收口）。 */
	events: Array<{ type: string; data?: unknown; seq: number }>;
	/** `followup` 收到的那条用户消息。 */
	messages: any[];
	/** 实际跑过的 step 数。 */
	stepsRun: number;
	/** 被 `cancel()` 过（参数原样记录）。 */
	cancelCauses: unknown[];
	/** 有没有被 `dispose()`。 */
	disposed: boolean;
}

/** dsh-system-prompt `SECTION_ORDERS`（recon §2.3，逐字）。 */
const SECTION_ORDERS: Record<string, number> = {
	HARNESS_IDENTITY: -1000,
	DEPLOYMENT_PERSONA_PREFIX: 0,
	PLAN_POLICY: 500,
	TEAM_POLICY: 600,
	PTC_ONLY: 800,
	FILE_REFERENCE: 900,
	TOOL_BASH: 1000,
	TOOL_PWSH: 1010,
	TOOL_READ: 1100,
	TOOL_WRITE: 1200,
	TOOL_EDIT: 1300,
	TOOL_APPLY_PATCH: 1350,
	TOOL_GLOB: 1400,
	TOOL_GREP: 1500,
	TOOL_JOBS: 1600,
	TOOL_PTY: 1700,
	TOOL_WEB_SEARCH: 2000,
	TOOL_WEB_FETCH: 2100,
	TOOL_LSP: 2200,
	TOOL_SESSION_QUERY: 2300,
	TOOL_GOAL: 2400,
	TOOL_SCHEDULE: 2500,
	TOOL_WORKFLOW: 2600,
	TOOL_RALPH: 2700,
	TOOL_SUBAGENT: 2800,
	TOOL_REPORT: 2900,
	TOOL_COMPUTER_USE: 3000,
	MCP_SERVERS: 3100,
	TOOLS_SDK: 5000,
	DELIVERABLE_FILE_REFERENCES: 9000,
	STRUCTURED_OUTPUT: 9900,
	HARNESS_SOURCE: 10000,
	WEB_SURFACE: 10100,
	DEPLOYMENT_PERSONA_SUFFIX: 10200,
};

/** dsh-system-prompt `CONTEXT_ORDERS`（recon §2.3，逐字）。 */
const CONTEXT_ORDERS: Record<string, number> = {
	WORKING_DIRECTORY: 100,
	SANDBOX_POLICY: 110,
	APPROVAL_POLICY: 115,
	SUBAGENT_DELEGATION: 120,
	TEAM_IDENTITY: 125,
	HARNESS_SOURCE: 200,
	WEB_SURFACE: 210,
};

function emptyAsyncIterable(): AsyncIterable<unknown> {
	return {
		[Symbol.asyncIterator]() {
			return { next: () => Promise.resolve({ value: undefined, done: true }) };
		},
	};
}

function singleChunkIterable(chunk: unknown): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			yield chunk;
		},
	};
}

interface ListenerEntry {
	handler: (payload: any, next?: () => Promise<any>) => any;
	prepend: boolean;
}

/** 从最外层往内卷的 cordis waterfall。entries[0] 最外层（先进入，返回值胜出）。 */
function runWaterfall(entries: ListenerEntry[], payload: unknown, base: unknown): Promise<any> {
	const dispatch = (index: number): Promise<any> => {
		if (index >= entries.length) return Promise.resolve(base);
		const { handler } = entries[index];
		let called = false;
		const next = () => {
			if (called) throw new Error("next() called multiple times");
			called = true;
			return dispatch(index + 1);
		};
		return Promise.resolve(handler(payload, next));
	};
	return dispatch(0);
}

export function createUserMsg(text: string, over?: Record<string, unknown>): any {
	return {
		id: `msg-${Math.random().toString(36).slice(2)}`,
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "user" },
		...over,
	};
}

export function createSyntheticMsg(kind: string, text: string): any {
	return {
		id: `msg-${Math.random().toString(36).slice(2)}`,
		role: "user",
		content: [{ type: "text", text }],
		source: { kind },
	};
}

export function createFakeCtx(
	opts: FakeCtxOptions = {},
): {
	ctx: any;
	sections: RecordedSection[];
	tools: Map<string, RecordedTool>;
	agentTools: Map<string, RecordedTool[]>;
	commands: RecordedCommand[];
	logs: Array<{ level: string; message: string }>;
	emitter: {
		agentCreated(agent: FakeAgent): Promise<void>;
		agentDisposed(agent: FakeAgent): void;
		turnStopping(payload: { agent: FakeAgent; turn?: number }): Promise<void>;
		preStep(payload: {
			agent: FakeAgent;
			messages: any[];
			turn: number;
			step: number;
			signal: AbortSignal;
			modelSelection?: unknown;
		}): Promise<any>;
	};
	makeAgent(over?: Partial<FakeAgent> & { fork?: boolean }): FakeAgent;
	cwdFor: Map<string, string>;
	disposeAll(): void;
	effects: Array<{ label: string }>;
	/** 每次 `agent.ctx.tools.restrict()` 的账（`builtinTools` / 工具集的断言靠它）。 */
	restrictions: Array<{ agentId: string; filter: { allow?: readonly string[]; deny?: readonly string[] } }>;
	/** `ctx.agents.create()` 建出来的子会话账本。 */
	childSessions: FakeChildSession[];
	/** 每次 `agents.create()` 的原始 create options（模型 / cwd / origin / setup 都在里面）。 */
	childCreateOptions: any[];
} {
	const sections: RecordedSection[] = [];
	const contexts: Array<RecordedSection & { required?: boolean }> = [];
	const tools = new Map<string, RecordedTool>();
	const agentTools = new Map<string, RecordedTool[]>();
	const commands: RecordedCommand[] = [];
	const logs: Array<{ level: string; message: string }> = [];
	const effects: Array<{ label: string }> = [];
	const cwdFor = new Map<string, string>();

	// 所有 disposer 的注册顺序总账；disposeAll 按逆序调用。
	const disposers: Array<() => void> = [];

	function registerDisposer(fn: () => void, kind?: string): () => void {
		let called = false;
		const disposer = () => {
			if (called) return;
			called = true;
			fn();
			if (kind !== undefined) opts.onDispose?.(kind);
		};
		disposers.push(disposer);
		return disposer;
	}

	function disposeAll(): void {
		for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
		disposers.length = 0;
	}

	function makeError(): Error & { code?: string } {
		const err = new Error(opts.llmError?.message ?? "llm error");
		if (opts.llmError) (err as { code?: string }).code = opts.llmError.code;
		return err;
	}

	function logMethod(level: string): (msg: any, ...params: any[]) => void {
		return (msg, ...params) => {
			const message = params.length > 0 ? format(msg, ...params) : typeof msg === "string" ? msg : format(msg);
			logs.push({ level, message });
		};
	}

	const createdListeners: ListenerEntry[] = [];
	const disposedListeners: ListenerEntry[] = [];
	const preStepListeners: ListenerEntry[] = [];
	const turnStoppingListeners: ListenerEntry[] = [];

	/** 每个 agent 作用域调过的 `tools.restrict()` 过滤器（按调用顺序）。 */
	const restrictions: Array<{ agentId: string; filter: { allow?: readonly string[]; deny?: readonly string[] } }> = [];
	/** 每次 `ctx.agents.create()` 的子会话账本（含 create options 与运行时状态）。 */
	const childSessions: FakeChildSession[] = [];

	function on(event: string, handler: (payload: any, next?: () => Promise<any>) => any, options?: boolean | { prepend?: boolean }): () => void {
		const prepend = options === true || (typeof options === "object" && options.prepend === true);
		let arr: ListenerEntry[] | null = null;
		if (event === "agent/created") arr = createdListeners;
		else if (event === "agent/disposed") arr = disposedListeners;
		else if (event === "agent/pre-step") arr = preStepListeners;
		else if (event === "agent/turn-stopping") arr = turnStoppingListeners;
		if (!arr) throw new Error(`fake ctx: unknown event "${event}"`);
		const entry: ListenerEntry = { handler, prepend };
		if (prepend) arr.unshift(entry);
		else arr.push(entry);
		return registerDisposer(() => {
			const i = arr!.indexOf(entry);
			if (i >= 0) arr!.splice(i, 1);
		});
	}

	const systemPrompt = {
		section(section: any): () => void {
			const rec: RecordedSection = { ...section };
			if (sections.some((s) => s.name === rec.name)) {
				throw new Error(`prompt section "${rec.name}" is already registered`);
			}
			sections.push(rec);
			return registerDisposer(() => {
				const i = sections.indexOf(rec);
				if (i >= 0) sections.splice(i, 1);
			}, "section");
		},
		context(context: any): () => void {
			const rec = { ...context };
			if (contexts.some((c) => c.name === rec.name)) {
				throw new Error(`prompt context "${rec.name}" is already registered`);
			}
			contexts.push(rec);
			return registerDisposer(() => {
				const i = contexts.indexOf(rec);
				if (i >= 0) contexts.splice(i, 1);
			}, "context");
		},
		getSectionOrder(name: string): number | undefined {
			return SECTION_ORDERS[name];
		},
		getContextOrder(name: string): number | undefined {
			return CONTEXT_ORDERS[name];
		},
	};

	function validateToolDefinition(definition: any): void {
		const name = definition?.name;
		const output = definition?.output;
		if (output === undefined || output === null || typeof output !== "object" || output.schema === undefined || typeof output.render !== "function") {
			throw new TypeError(`tool "${name}" must declare output { schema, render }`);
		}
	}

	function makeGlobalToolsService() {
		return {
			register(definition: any): () => void {
				validateToolDefinition(definition);
				const rec: RecordedTool = { ...definition };
				if (tools.has(rec.name)) {
					throw new Error(`tool "${rec.name}" is already registered`);
				}
				tools.set(rec.name, rec);
				return registerDisposer(() => {
					if (tools.get(rec.name) === rec) tools.delete(rec.name);
				}, "tool");
			},
		};
	}

	function makeAgentToolsService(agentId: string) {
		return {
			register(definition: any): () => void {
				validateToolDefinition(definition);
				const rec: RecordedTool = { ...definition };
				let arr = agentTools.get(agentId);
				if (!arr) {
					arr = [];
					agentTools.set(agentId, arr);
				}
				if (arr.some((t) => t.name === rec.name)) {
					throw new Error(`tool "${rec.name}" is already registered in this scope`);
				}
				arr.push(rec);
				return registerDisposer(() => {
					const list = agentTools.get(agentId);
					if (!list) return;
					const i = list.indexOf(rec);
					if (i >= 0) list.splice(i, 1);
				}, "tool");
			},
			/**
			 * 忠实宿主 `ToolsService.restrict()`（`dsh-tools/lib/index.js:453-468`）的两条硬约束：
			 * - `allow` / `deny` 全缺 → 抛（空过滤器是 bug）；但 `allow: []` 合法 = 隐藏全部全局工具；
			 * - 名字必须是**已知全局工具**，否则抛（这是适配层必须与 `definitions()` 求交集的原因）。
			 */
			restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void {
				if (filter.allow === undefined && filter.deny === undefined) {
					throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny`");
				}
				const named = [...(filter.allow ?? []), ...(filter.deny ?? [])];
				if (named.includes("run_code")) throw new Error('tools.restrict() cannot name reserved "run_code"');
				const known = new Set(tools.keys());
				const unknown = named.filter((name) => !known.has(name));
				if (unknown.length > 0) {
					throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}`);
				}
				restrictions.push({ agentId, filter });
				return registerDisposer(() => {});
			},
			/** 全局视图（不传 scope）：宿主 `definitions()` 的无参形式。 */
			definitions(): readonly RecordedTool[] {
				return [...tools.values()];
			},
		};
	}

	const commandsService = {
		register(definition: any): () => void {
			const rec: RecordedCommand = { ...definition };
			if (commands.some((c) => c.name === rec.name)) {
				throw new Error(`command "${rec.name}" is already registered`);
			}
			commands.push(rec);
			return registerDisposer(() => {
				const i = commands.indexOf(rec);
				if (i >= 0) commands.splice(i, 1);
			}, "command");
		},
	};

	const llm = {
		stream(options: unknown): AsyncIterable<unknown> {
			if (opts.llmError) throw makeError();
			if (opts.llmStreamFailure) {
				const failure = { code: opts.llmStreamFailure.code, message: opts.llmStreamFailure.message ?? opts.llmStreamFailure.code };
				return singleChunkIterable({ type: "finish", reason: { kind: "error", failure } });
			}
			if (opts.llmStreamAborted) return singleChunkIterable({ type: "finish", reason: { kind: "aborted" } });
			if (opts.llmStream) return opts.llmStream(options);
			return emptyAsyncIterable();
		},
		resolveCallConfig(config: unknown): Promise<unknown> {
			if (opts.llmError) return Promise.reject(makeError());
			return Promise.resolve(config);
		},
	};

	const workingDirectory = {
		get(session: any): string {
			const sid = typeof session === "string" ? session : session?.id;
			return cwdFor.get(sid) ?? session?.header?.cwd ?? session?.cwd ?? process.cwd();
		},
		async ensure(agent: any, _signal?: AbortSignal): Promise<string> {
			const sid = typeof agent === "string" ? agent : agent?.id ?? agent?.sessionId;
			return cwdFor.get(sid) ?? agent?.session?.header?.cwd ?? agent?.cwd ?? process.cwd();
		},
	};

	/** 宿主 `SessionHeader`（`dsh-session/lib/types/types.d.ts:59-92`）的最小忠实子集。 */
	function sessionHeader(s: FakeSessionInfo) {
		return {
			version: 4,
			id: s.id,
			createdAt: s.createdAt ?? 0,
			cwd: s.cwd,
			isSeeded: false,
		};
	}

	/** 宿主 `SessionRecord`（`dsh-session-query/lib/types/types.d.ts:14-31`）：header + live + persisted。 */
	function sessionRecord(s: FakeSessionInfo) {
		return { header: sessionHeader(s), live: s.live ?? true, persisted: s.persisted ?? true };
	}

	/** newest-first 稳定排序；缺 createdAt 的记录排在带日期的记录之后、保持 fixture 顺序。 */
	function sortedSessionRecords(): any[] {
		const records = (opts.sessions ?? []).map((s) => ({ record: sessionRecord(s), createdAt: s.createdAt }));
		records.sort((a, b) => {
			const ka = a.createdAt ?? Number.NEGATIVE_INFINITY;
			const kb = b.createdAt ?? Number.NEGATIVE_INFINITY;
			return kb === ka ? 0 : kb - ka;
		});
		return records.map((r) => r.record);
	}

	function extractText(event: { type: string; data: unknown }): string {
		const d = event.data;
		if (d === null || d === undefined) return "";
		if (typeof d === "string") return d;
		if (typeof d !== "object") return String(d);
		const obj = d as any;
		if (typeof obj.text === "string") return obj.text;
		const content = obj.content ?? obj.message?.content;
		if (Array.isArray(content)) {
			return content
				.map((b: any) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
				.join(" ");
		}
		if (typeof content === "string") return content;
		if (typeof obj.arguments === "string") return `${obj.name ?? ""} ${obj.arguments}`.trim();
		try {
			return JSON.stringify(obj);
		} catch {
			return "";
		}
	}

	function matchesEventFilters(doc: any, filters: readonly any[]): boolean {
		for (const f of filters ?? []) {
			if (!f || typeof f !== "object") continue;
			if (f.kind === "type" && Array.isArray(f.values) && !f.values.includes(doc.type)) return false;
			if (f.kind === "text" && typeof f.text === "string" && !doc.text.toLowerCase().includes(f.text.toLowerCase())) {
				return false;
			}
		}
		return true;
	}

	// 忠实宿主：`listSessions(signal?)` 返回裸数组、newest-first；cwd 过滤在 `filterSessions(filters, signal)`。
	const sessionQuery = {
		async listSessions(_signal?: AbortSignal): Promise<any[]> {
			return sortedSessionRecords();
		},
		async filterSessions(filters?: readonly any[], _signal?: AbortSignal): Promise<any[]> {
			const clauses = filters ?? [];
			for (const f of clauses) {
				if (f && typeof f === "object" && f.kind !== "cwd") {
					throw new Error(`fake ctx: unsupported session filter kind "${String(f.kind)}"`);
				}
			}
			const cwdClause = clauses.find((f: any) => f?.kind === "cwd");
			let records = sortedSessionRecords();
			if (cwdClause) {
				const values: readonly any[] = cwdClause.values ?? [];
				records = records.filter((r) => values.includes(r.header.cwd ?? null));
			}
			return records;
		},
		async readSession(sessionId: string, _opts?: { signal?: AbortSignal }): Promise<any> {
			const s = (opts.sessions ?? []).find((x) => x.id === sessionId);
			if (!s) throw new Error(`fake ctx: session not found: ${sessionId}`);
			return {
				session: sessionHeader(s),
				inheritedEventCount: 0,
				events: s.events.map((e, i) => ({ ...e, seq: i, time: 0 })),
			};
		},
		async filterEvents(sessionId: string, filters?: readonly any[]): Promise<any[]> {
			const s = (opts.sessions ?? []).find((x) => x.id === sessionId);
			if (!s) throw new Error(`fake ctx: session not found: ${sessionId}`);
			const docs = s.events.map((e, i) => ({
				sessionId,
				seq: i,
				type: e.type,
				time: 0,
				surface: "log-only",
				text: extractText(e),
			}));
			return docs.filter((d) => matchesEventFilters(d, filters ?? []));
		},
	};

	const logger = {
		error: logMethod("error"),
		warn: logMethod("warn"),
		info: logMethod("info"),
		debug: logMethod("debug"),
	};

	/**
	 * 宿主 `ctx.agents.create()` 的最小忠实实现：
	 *
	 * - 先 `await setup(childCtx, childAgent)`（**未发布**的 agent 作用域）—— 抛错 = 创建失败；
	 * - 返回 `{ agent, dispose }`；`followup()` 启动这一轮（按剧本走子会话的 `agent/pre-step`
	 *   waterfall，被 `reject` 就收口），`whenIdle()` await 它，`cancel()` 只记账；
	 * - `session.snapshotEvents()` 返回日志切片，`seq` 随事件递增（适配层据此取最终文本）。
	 *
	 * `childRun.hang` 模拟「永不收敛的模型调用」：只有 `timeoutMs` 真的能打断它，适配层的超时
	 * 路径才被证明是活的（甲则 `whenIdle()` 会一直挂着）。
	 */
	const agents = {
		async create(options: any): Promise<any> {
			childCreateOptions.push(options);
			const script: FakeChildScript & { hang?: boolean } = (await opts.childRun?.(options)) ?? {};
			if (script.createThrows !== undefined) throw new Error(script.createThrows);

			const sessionId = String(options.sessionId);
			const state: FakeChildSession = {
				sessionId,
				meta: options.meta,
				agentOptions: options.agentOptions,
				events: [],
				messages: [],
				stepsRun: 0,
				cancelCauses: [],
				disposed: false,
			};
			childSessions.push(state);

			const childPreStep: ListenerEntry[] = [];
			const childCtx = {
				tools: makeAgentToolsService(`${sessionId}:child`),
				on(event: string, handler: ListenerEntry["handler"], optionsArg?: unknown): () => void {
					if (event !== "agent/pre-step") {
						throw new Error(`fake ctx: child scope does not emit "${event}"`);
					}
					const prepend =
						optionsArg === true ||
						(typeof optionsArg === "object" && (optionsArg as { prepend?: boolean })?.prepend === true);
					const entry: ListenerEntry = { handler, prepend };
					if (prepend) childPreStep.unshift(entry);
					else childPreStep.push(entry);
					return () => {
						const i = childPreStep.indexOf(entry);
						if (i >= 0) childPreStep.splice(i, 1);
					};
				},
			};

			let pending: Promise<void> | undefined;
			const child: any = {
				session: {
					id: sessionId,
					header: {
						cwd: options.meta?.cwd,
						origin: options.meta?.origin ?? "subagent",
						delegationDepth: options.meta?.delegationDepth ?? 1,
					},
					get seq(): number {
						return state.events.length;
					},
					snapshotEvents(from = 0, to = state.events.length): unknown[] {
						return state.events.slice(from, to);
					},
				},
				followup(message: any): void {
					state.messages.push(message);
					pending = runTurn();
				},
				whenIdle(): Promise<void> {
					return pending ?? Promise.resolve();
				},
				cancel(cause: unknown): void {
					state.cancelCauses.push(cause);
				},
			};

			async function runTurn(): Promise<void> {
				// 被 cancel 过就不再走 step（忠实效地：取消后这一轮应该收口）。
				const totalSteps = script.steps ?? 1;
				for (let step = 1; step <= totalSteps; step++) {
					if (state.cancelCauses.length > 0) break;
					const decision = await runWaterfall(
						childPreStep,
						{ agent: child, turn: 1, step, signal: new AbortController().signal },
						{ kind: "enter", messages: [] },
					);
					if (decision?.kind === "reject") break;
					state.stepsRun += 1;
				}
				for (const event of script.events ?? []) {
					state.events.push({ ...event, seq: state.events.length });
				}
				if (script.hang === true) await new Promise<void>(() => {});
				if (script.idleThrows !== undefined) throw new Error(script.idleThrows);
			}

			try {
				options.setup?.(childCtx, child);
			} catch (e) {
				throw script.setupThrows !== undefined ? new Error(script.setupThrows) : e;
			}

			return {
				agent: child,
				dispose: async (): Promise<void> => {
					state.disposed = true;
				},
			};
		},
	};
	/** 每次 `agents.create()` 的原始 options（断言模型 / cwd / origin 用）。 */
	const childCreateOptions: any[] = [];

	function effect(fn: () => any, label?: string): void {
		effects.push({ label: label ?? "" });
		addEffectResult(fn());
	}

	function addEffectResult(result: any): void {
		if (result === null || result === undefined) return;
		if (typeof result === "function") {
			registerDisposer(result);
			return;
		}
		if (typeof result === "object" && typeof result[Symbol.iterator] === "function") {
			for (const d of result) addEffectResult(d);
			return;
		}
		if (typeof result === "object" && typeof result[Symbol.asyncIterator] === "function") {
			void (async () => {
				for await (const d of result) addEffectResult(d);
			})();
			return;
		}
		if (typeof result === "object" && typeof result.then === "function") {
			result.then(addEffectResult);
		}
	}

	function makeAgentCtx(agent: FakeAgent): any {
		return {
			systemPrompt,
			tools: makeAgentToolsService(agent.id),
			commands: commandsService,
			llm,
			agents,
			workingDirectory,
			sessionQuery,
			logger,
			on,
			effect,
		};
	}

	let nextId = 1;
	function makeAgent(over: Partial<FakeAgent> & { fork?: boolean } = {}): FakeAgent {
		const id = over.id ?? `agent-${nextId++}`;
		const cwd = over.cwd ?? "/fake/workspace";
		const subagent = over.subagent ?? false;
		const fork = over.fork ?? false;
		const events = over.events ?? [];
		const session = over.session ?? {
			id,
			header: {
				cwd,
				...(subagent
					? { parentSession: "session-parent-fake", origin: "subagent" as const, delegationDepth: 1 }
					: fork
						? { parentSession: "session-parent-fake" }
						: {}),
			},
			seq: events.length,
			snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
		};
		const agent: any = {
			id,
			sessionId: over.sessionId ?? id,
			cwd,
			subagent,
			events,
			session,
			...over,
		};
		agent.ctx = makeAgentCtx(agent);
		return agent;
	}

	async function agentCreated(agent: FakeAgent): Promise<void> {
		if (!(agent as any).ctx) (agent as any).ctx = makeAgentCtx(agent);
		// serial：按序 await，抛错即创建失败。
		for (const { handler } of createdListeners.slice()) {
			await handler({ agent, source: "startup" });
		}
	}

	function agentDisposed(agent: FakeAgent): void {
		for (const { handler } of disposedListeners.slice()) handler({ agent });
	}

	/** 触发 `agent/turn-stopping`（串行、被 await）：适配层的 extract 触发点。 */
	async function turnStopping(payload: { agent: FakeAgent; turn?: number }): Promise<void> {
		for (const { handler } of turnStoppingListeners.slice()) {
			await handler({ turn: payload.turn ?? 1, signal: new AbortController().signal, ...payload });
		}
	}

	const emitter = {
		agentCreated,
		agentDisposed,
		turnStopping,
		preStep(payload: {
			agent: FakeAgent;
			messages: any[];
			turn: number;
			step: number;
			signal: AbortSignal;
			modelSelection?: unknown;
		}): Promise<any> {
			return runWaterfall(preStepListeners, payload, { kind: "enter", messages: payload.messages });
		},
	};

	const ctx = {
		systemPrompt,
		tools: makeGlobalToolsService(),
		commands: commandsService,
		llm,
		agents,
		workingDirectory,
		sessionQuery,
		logger,
		on,
		effect,
	};

	return {
		ctx,
		sections,
		tools,
		agentTools,
		commands,
		logs,
		emitter,
		makeAgent,
		cwdFor,
		disposeAll,
		effects,
		restrictions,
		childSessions,
		childCreateOptions,
	};
}
