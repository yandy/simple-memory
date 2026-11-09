import { format } from "node:util";

/**
 * 迷你假 cordis ctx —— Task 7–16 所有适配器测试的地基。
 *
 * 它刻意不 import 任何 `@deepseek-ai/*` 包：它模拟的是「我们观察到的宿主行为」，
 * 而不是「我们可能误读的宿主类型」。需要宿主形状的地方都在这里用本地结构化接口表达。
 *
 * 语义来源（recon notes，均已逐条核对宿主 `.d.ts`）：
 * - `agent/pre-step` 是 waterfall：最内层 `next()` 产出 base `{ kind: "enter", messages }`；
 *   `{ prepend: true }` 的监听器 unshift 到最外层（先进入、最后看到 decision、返回值胜出）。
 * - `agent/created` 串行且被 await，监听器抛出即创建失败；`agent/disposed` 是 fire-and-forget emit。
 * - 注册类方法（section/context/tools.register/commands.register/on）都返回普通 `() => void` disposer。
 * - cordis 4 没有 `ctx.on("dispose")`；清理走 `ctx.effect`（立即执行，拥有回调返回的 disposer）。
 * - 根 ctx 的 `tools.register` 是全局的；`agent.ctx.tools.register` 按 agent 隔离、遮蔽全局。
 */

export interface FakeAgent {
	id: string;
	sessionId: string;
	cwd: string;
	subagent: boolean;
	session: { id: string; header: { cwd: string } };
}

export interface FakeCtxOptions {
	llmStream?: (opts: unknown) => AsyncIterable<unknown>;
	llmError?: { code: string; message: string };
	sessions?: FakeSessionInfo[];
}

export interface FakeSessionInfo {
	id: string;
	cwd: string;
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

interface ListenerEntry {
	handler: (payload: any, next?: () => Promise<any>) => any;
	prepend: boolean;
}

/** 从最外层往内卷的 cordis waterfall。entries[0] 最外层（先进入，返回值胜出）。 */
function runWaterfall(entries: ListenerEntry[], payload: unknown, base: unknown): Promise<any> {
	const dispatch = (index: number): Promise<any> => {
		if (index >= entries.length) return Promise.resolve(base);
		const { handler } = entries[index];
		return Promise.resolve(handler(payload, () => dispatch(index + 1)));
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
		preStep(payload: {
			agent: FakeAgent;
			messages: any[];
			turn: number;
			step: number;
			signal: AbortSignal;
			modelSelection?: unknown;
		}): Promise<any>;
	};
	makeAgent(over?: Partial<FakeAgent>): FakeAgent;
	cwdFor: Map<string, string>;
	disposeAll(): void;
	effects: Array<{ label: string }>;
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

	function registerDisposer(fn: () => void): () => void {
		let called = false;
		const disposer = () => {
			if (called) return;
			called = true;
			fn();
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

	function on(event: string, handler: (payload: any, next?: () => Promise<any>) => any, options?: boolean | { prepend?: boolean }): () => void {
		const prepend = options === true || (typeof options === "object" && options.prepend === true);
		let arr: ListenerEntry[] | null = null;
		if (event === "agent/created") arr = createdListeners;
		else if (event === "agent/disposed") arr = disposedListeners;
		else if (event === "agent/pre-step") arr = preStepListeners;
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
			sections.push(rec);
			return registerDisposer(() => {
				const i = sections.indexOf(rec);
				if (i >= 0) sections.splice(i, 1);
			});
		},
		context(context: any): () => void {
			const rec = { ...context };
			contexts.push(rec);
			return registerDisposer(() => {
				const i = contexts.indexOf(rec);
				if (i >= 0) contexts.splice(i, 1);
			});
		},
		getSectionOrder(name: string): number | undefined {
			return SECTION_ORDERS[name];
		},
		getContextOrder(name: string): number | undefined {
			return CONTEXT_ORDERS[name];
		},
	};

	function makeGlobalToolsService() {
		return {
			register(definition: any): () => void {
				const rec: RecordedTool = { ...definition };
				tools.set(rec.name, rec);
				return registerDisposer(() => {
					if (tools.get(rec.name) === rec) tools.delete(rec.name);
				});
			},
		};
	}

	function makeAgentToolsService(agentId: string) {
		return {
			register(definition: any): () => void {
				const rec: RecordedTool = { ...definition };
				let arr = agentTools.get(agentId);
				if (!arr) {
					arr = [];
					agentTools.set(agentId, arr);
				}
				arr.push(rec);
				return registerDisposer(() => {
					const list = agentTools.get(agentId);
					if (!list) return;
					const i = list.indexOf(rec);
					if (i >= 0) list.splice(i, 1);
				});
			},
		};
	}

	const commandsService = {
		register(definition: any): () => void {
			const rec: RecordedCommand = { ...definition };
			commands.push(rec);
			return registerDisposer(() => {
				const i = commands.indexOf(rec);
				if (i >= 0) commands.splice(i, 1);
			});
		},
	};

	const llm = {
		stream(options: unknown): AsyncIterable<unknown> {
			if (opts.llmError) throw makeError();
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

	function sessionHeader(s: FakeSessionInfo) {
		return { id: s.id, cwd: s.cwd, createdAt: "1970-01-01T00:00:00.000Z" };
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

	// 简单、数据驱动的会话查询：形状对齐 Task 13 的 `SessionQueryLike`（`listSessions` 返回 `{ items }`
	// 页对象、`readSession` 返回 `{ events }`），同时保留宿主真 `filterEvents` 的文档数组形态。
	// `listSessions` 支持两种 cwd 过滤写法：`{ cwd }`（便利）与 `{ filters: [{ kind: "cwd", values: [cwd] }] }`。
	const sessionQuery = {
		async listSessions(
			options?: { cwd?: string; limit?: number; filters?: readonly any[] } | AbortSignal,
			_opts?: { signal?: AbortSignal },
		): Promise<{ items: Array<{ header: { id: string; cwd?: string; createdAt?: string } }> }> {
			const q = options && typeof options === "object" ? (options as { cwd?: string; limit?: number; filters?: readonly any[] }) : {};
			const cwdFilter = q.filters?.find((f: any) => f?.kind === "cwd")?.values?.[0];
			const cwd = q.cwd ?? cwdFilter;
			let records = (opts.sessions ?? []).map((s) => ({ header: sessionHeader(s) }));
			if (cwd !== undefined) records = records.filter((r) => r.header.cwd === cwd);
			if (q.limit !== undefined && q.limit > 0) records = records.slice(0, q.limit);
			return { items: records };
		},
		async readSession(sessionId: string, _opts?: { signal?: AbortSignal }): Promise<any> {
			const s = (opts.sessions ?? []).find((x) => x.id === sessionId);
			if (!s) throw new Error(`fake ctx: session not found: ${sessionId}`);
			return { session: sessionHeader(s), events: s.events.map((e, i) => ({ ...e, seq: i, time: 0 })) };
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
			workingDirectory,
			sessionQuery,
			logger,
			on,
			effect,
		};
	}

	let nextId = 1;
	function makeAgent(over: Partial<FakeAgent> = {}): FakeAgent {
		const id = over.id ?? `agent-${nextId++}`;
		const cwd = over.cwd ?? "/fake/workspace";
		const subagent = over.subagent ?? false;
		const session = over.session ?? {
			id,
			header: {
				cwd,
				...(subagent ? { parentSession: "session-parent-fake", delegationDepth: 1 } : {}),
			},
		};
		const agent: any = {
			id,
			sessionId: over.sessionId ?? id,
			cwd,
			subagent,
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

	const emitter = {
		agentCreated,
		agentDisposed,
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
	};
}
