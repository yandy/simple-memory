# memory-core 的任务模型：把「三个需要模型的任务」收成一等对象

日期：2026-11-10
状态：**待批准（已过两轮审阅：建造者 + qwen3.8-max 规格审阅）**
范围：`memory-core` 引入任务描述符 + 通用编排 + 结构化结果词汇 + 自读 config；`pi-memory` / `dsh-memory`
只声明、调端口、呈现。
前置：`docs/superpowers/specs/2026-11-10-memory-core-1.2.0-config-removal-design.md`（配置文件 IO 下放）——
两刀同批交付，关系见 §10。
依据：`docs/superpowers/specs/2026-11-09-dsh-memory-adapter-design.md` §9 的 P1 / P6 / P12，以及本轮对
dsh 0.2.2-rc.1 安装树（`~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai`）的调研。

---

## 1. 意图

`memory-core` 里有三个「需要一次 LLM 调用」的任务：`autoSurfacing`、`extractMemories`、`dream`。
它们的知识今天散在**七处**：

1. `config.ts` 的三个配置子树；
2. `orchestration/{surfacing,extract,dream}.ts` 三个 `run*`，各自手写轮数、超时、工具集、锁与快照；
3. `ModelTask` 闭集合 + `requiredModels(cfg, tasks?)` 这个「调用点补丁」；
4. **三个 `run*` 的入参全是 config 派生的扁平原语**（`maxFiles`、`maxContextTokens`、`maxLines`、
   `model`、`effort`、`sessionPersistence`），真正读 `MemoryConfig` 的是适配层；
5. 适配层各自的「config → opts」胶水（pi 的 `resolveDefault`、dsh 内联的 `?? defaults`）；
6. dsh 自己维护的 `UNIMPLEMENTED_MODULES` 与 `/memory` 的「配了但不生效」提示；
7. 三个任务各不相同的失败词汇（`[]` / `{skipped}` / `throw`）。

本刀把它们收成一处：任务是一等对象，编排是一条通用循环，config 由 core 自己消费，适配层只提供
「怎么调模型」与「怎么呈现」。

## 2. 为什么是现在

- 第二个消费者（dsh）已经落地第一刀，它对三个任务的能力边界已实测清楚（§4）：受限工具的嵌套会话要靠
  `ctx.agents.create` + `setup` + `restrict` 拼，**没有轮数上限**，**会话会落盘**，**结构化输出只在
  subagent 通道上有**。这些事实决定端口长什么样。
- 上一轮已经因为「照侦察笔记猜宿主行为」返工四次（spec §2.3）。这次先把消费者形状核到位。

## 3. 目标 / 非目标 / 反目标

**目标**

- 一个任务 = 一份描述符：id、编排骨架、prompt、解析、未完成时怎么呈现、端口抛错怎么办。
- 一条通用编排 `runTask`：读 config → 跑端口 → 解释结果 → 施加锁/快照。
- **config 由 core 自己消费**：model / effort / sessionPersistence / 全部预算值在 `runTask` 里读，
  适配层不再有「config → opts」那一道（§6.5）。
- 端口返回**结构化结果**，替掉今天的 `string | null`（P12 的修法）。
- 适配层用一份声明表达「我实现了哪些任务」，替掉调用点补丁与 dsh 的 `UNIMPLEMENTED_MODULES`。
- 两处错位知识归位：`nudge*` 归 pi、`sessionPersistence` 继承规则归 core。

**非目标**

- 不在本轮**实现** dsh 的 extract / dream（判定标准：dsh 侧写这两个任务时不需要再动 core 的公开面）。
- 不改 prompt 文本、磁盘格式、`memory` 工具 action 语义、`injection.ts` 与 `MemoryStore`。
- 不改 `memory.json` 的任何用户可见键名（`nudge*` 只是从 core 的类型里搬走）。
- 不改 pi-memory 的用户可观察行为；**不给 pi 新增 stop-reason 管道**（见 §6.3 的 pi 说明）。
- **不为 `dsh-memory` 的未发布状态留任何兼容代价**：依赖直接 `^2.0.0`，端口适配、`UNIMPLEMENTED_MODULES`、
  `surfacing.ts` 里的 config 读取都可以直接重写。

**反目标**

- 描述符变成「万能配置对象」：任何一项策略如果不是**至少一个任务**真的需要，就不许进描述符
  （因此 `builtinTools` 不进描述符：三个任务恒为 `"none"`；两个 `skip*` 由 `lock` 派生，不再单独编码）。
- 适配层重新开始读 core 已自己消费的键，或复制 core 的业务判断（哪些文件算候选、对话怎么截断）。
- 端口为了迁就某一个宿主长出第二组可选字段。

## 4. dsh 消费者形状（调研结论，0.2.2-rc.1）

`ROOT = ~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai`

### 4.1 受限工具的嵌套会话：没有现成 API，但能用公开服务拼出来

- 一等公民是 `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>`
  （`ROOT/dsh-agent/lib/types/index.d.ts:292`；`AgentHandle = { agent, dispose() }` `:150-153`）。
  `setup?: AgentSetup` 是**发布前**的组合窗口（`:101-105`，原文「Setup composes, it never drives」）。
- 「只给一个工具」在 `setup` 里做：`agentCtx.tools.restrict({ allow: ["memory"] })`
  （签名 `ROOT/dsh-tools/lib/types/index.d.ts:50-58`；语义见 `contracts.d.ts:356-365`）。`restrict` 必须由
  agent 作用域的 ctx 调用（`ROOT/dsh-tools/lib/index.js:454-455`）。
- 驱动与取结果的官方参考实现：`agents.create` → `agent.followup(createUserMessage(...))` →
  `await agent.whenIdle()` → 取「最后一条非空 assistant 消息」（`ROOT/dsh-headless/lib/index.js:336-380`；
  规则见 `dsh-subagent/lib/types/assistant-output.d.ts:20-47`）。
- 面向模型的 `subagent` 工具做不了这件事：`toolFilter` / `persona` 已被移除
  （`ROOT/dsh-tool-subagent/lib/index.js:346`）。`ctx.subagents.startActivation` 虽然是一等公民
  （`dsh-subagent/lib/types/index.d.ts:136-146`），但请求里**没有工具集字段**，也不把子 ctx 交出来。

### 4.2 没有轮数上限

全树无 `maxTurns` / `maxSteps` / `iterationLimit`；`SubagentStartRequest` 里唯一的上限是 `maxDepth`
（递归层数，`dsh-subagent/lib/types/types.d.ts:168-173`）。**core 的 `maxTurns` 只能是建议值**，dsh 要限量
得自己听 `turn/start` 再 `agent.cancel()`（`dsh-agent/lib/types/runtime-types.d.ts:184`）。

### 4.3 嵌套会话会落盘

persistence 只看服务是否挂载，**没有 per-session 开关**（`dsh-agent/lib/types/index.d.ts:182`；
`createStoredSession` 无后端时返回 `undefined`，`dsh-agent-loop/lib/index.js:1640-1642`；默认 profile 装了
jsonl，`dsh-base/cordis.patch.yml:138-141`）。**pi 的 `sessionPersistence.enabled: false` 在 dsh 侧不可兑现**，
dsh 的会话日志会多出这些子会话 —— 写进 dsh README，不假装对齐。

### 4.4 其它三条

- **超时**：`llm.stream` 没有 per-call deadline，只有 provider 级 idle watchdog（`dsh-llm-deepseek` /
  `dsh-llm-pi-ai`），通用计时器在 `dsh-timeout`（`lib/types/index.d.ts:36-101`）。超时的可观察结果是终止 chunk
  `{type:"finish", reason:{kind:"error"|"aborted"}}`，**不抛错**（`dsh-llm/lib/index.js:2404-2415`）。
- **结构化输出**只有 subagent 通道有 `outputSchema`（`dsh-subagent/lib/types/structured.d.ts:14-48`）；
  `llm.stream` 的 `GenerateOptions` 没有 `toolChoice` / `response_format`。解析必须留在 core 且必须防御式。
- **结果词汇**：`stopReason: completed | aborted | error | max-tokens | refusal`
  （`dsh-subagent/lib/types/types.d.ts:222-262`），富到足以映射成 core 的结果结构。

## 5. 方案与取舍

| 方案 | 形态 | 取舍 |
|---|---|---|
| **A（选定）** | 任务描述符 + 通用编排 + 结构化结果 + 自读 config；适配层只提供端口、触发点、呈现 | 单点策略（跨宿主一致）；一次真的公开面重构 |
| B | 任务级端口（三个 `run*` 各一个） | prompt 与写入语义会分叉；第三个宿主抄第三遍 |
| C | 只做归属纠正，`run*` 形状不动 | dsh 的 §4 事实已到手，再等一轮等于把同一处签名改两次 |

判定规则（用于拒绝未来的加项）：

1. **一段逻辑的差异会不会让两个宿主对同一份磁盘记忆做出不同判断？** 会 → core。
2. **这个配置键的值会不会改变模型看到什么、写什么？** 会 → core 自己读（§6.5）；不会 → 适配层。

## 6. 核心模型

### 6.1 任务描述符

```ts
/** 沿用 core 已有的公开联合，不改名：`requiredModels` / `moduleStatusRows` / 适配层声明都用它。 */
export type ModelTask = "dream" | "extractMemories" | "autoSurfacing";

/** 编排骨架。全部是 core 常量；两个 skip 由 `lock` 派生，不再单独编码。 */
export interface TaskPlan {
  /** 建议轮数上限。dsh 无法硬性执行（§4.2），适配层尽力。 */
  maxTurns?: number;
  timeoutMs: number;
  /** 注入子会话的 memory 工具 action 集；`null` = 不注入。三个任务的 builtinTools 恒为 "none"。 */
  memoryTool: readonly MemoryAction[] | null;
  /** 互斥与快照：none / 整轮逻辑锁 / 逻辑锁 + 进入时全目录快照。 */
  lock: "none" | "logical" | "logical+snapshot";
  /** 端口抛错（传输级失败）时怎么办：surfacing 吞、extract 与 dream 上抛。 */
  errorPolicy: "swallow" | "rethrow";
}

/** 任务需要的 core 侧原料：store 恒有；transcript 只有 extract 用（判空之前就要它）。 */
export interface TaskDeps {
  store: MemoryStore;
  transcript?: HostTranscriptPort;
}

/** `notCompleted` 收的 `why`：core 自己的判定，或端口给的非 completed 结果（`IncompleteOutcome` 见 §6.2）。 */
export type Incomplete =
  | { status: "no-input" }
  | { status: "lock-busy" }
  | IncompleteOutcome;

export interface MemoryTask<I, R> {
  readonly id: ModelTask;
  readonly plan: TaskPlan;
  /** `null` = core 自己判定这一轮不跑（候选为空、消息为空）。预算值自己从 `cfg` 读。 */
  buildPrompt(cfg: MemoryConfig, deps: TaskDeps, input: I): string | null;
  /** 回复 → 结果。必须防御式：dsh 的 stream 通道拿不到强制结构化输出（§4.4）。 */
  parse(cfg: MemoryConfig, deps: TaskDeps, input: I, text: string): R | Promise<R>;
  /**
   * core 没跑、或端口没跑成时怎么呈现（三个任务词汇不同的唯一合法处）。
   * `why` 把 core 自己的判定（`no-input` / `lock-busy`）与端口给的非 completed 结果收进同一个钩子，
   * core 的「不跑」不必伪装成宿主的语言。
   */
  notCompleted(cfg: MemoryConfig, deps: TaskDeps, input: I, why: Incomplete): R;
  /** 只有 extractMemories 实现：把 `input.onWrite` 透给子会话的工具（Task 5 用）。 */
  memoryToolHooks?(input: I): { onWrite?: (info: { action: MemoryAction; name?: string }) => void } | undefined;
}

/** 任务注册表：描述符的唯一声明处；Task 6 在 dream 落地后扩成 `Record<ModelTask, MemoryTask<any, any>>`。 */
export const TASKS = { autoSurfacing } as const;
```

`TASKS` 在本轮（Task 4）只声明已实现的 `autoSurfacing`，用 `as const` 固定这一个键；Task 6 落 dream 时再
显式放宽成 `Record<ModelTask, MemoryTask<any, any>>`。中间任务**不得**为缺失的描述符造假对象：`TASKS.dream`
此刻不存在，比存在一个会抛错的占位对象诚实。

编排骨架（core 常量，从三个 `run*` 逐字搬来）：

| 任务 | maxTurns | timeout | memoryTool | lock | errorPolicy |
|---|---|---|---|---|---|
| autoSurfacing | 1 | 30 s | `null` | `none` | `swallow` |
| extractMemories | 5（best-effort） | 120 s | `MAIN_AGENT_ACTIONS` | `logical` | `rethrow` |
| dream | 无 | 600 s | `DREAM_ACTIONS` | `logical+snapshot` | `rethrow` |

三个任务的输入/结果形状（**输入只含宿主数据，不含 config 值**）：

| 任务 | `I` | `R` |
|---|---|---|
| autoSurfacing | `{ userPrompt: string; injectedFiles: Set<string>; manifest: EntryManifest[] }` | `{ files: string[]; content: string }` |
| extractMemories | `{ messages: unknown[]; agentsMdBlocks: string[]; onWrite?: (info) => void }` | `{ skipped: boolean; result?: string }` |
| dream | `{}` | `string`（摘要） |

**从 `cfg` 自读的值**（今天全部由适配层读出来再当参数传）：

| 任务 | 键 | 读在哪 |
|---|---|---|
| autoSurfacing | `maxFiles` | `buildPrompt`（prompt）+ `parse`（slice） |
| autoSurfacing | `maxEntryBytes` / `maxInjectionBytes` | `parse` 里调 `renderSurfacedBlock`（`injection.ts` 签名不变，预算由 core 传） |
| extractMemories | `maxContextTokens` / `maxToolResultChars` / `maxAssistantChars` | `buildPrompt` → `buildExtractTask` / `renderConversation` |
| dream | `memIndexMaxLines` | `buildPrompt` → `buildDreamTask(maxLines)` |
| 三个任务 | `model`、`thinkLevel`、`sessionPersistence`（per-task ?? `defaults`） | `runTask` 构造 `HeadlessRunRequest` |

`maxFiles` 的候选清单来自 `scanEntries(store)` —— 它是 core 的纯函数、不看 config，适配层取一次放进 `input`
（一行调用，不是判断）。

### 6.2 端口结果词汇（替掉 `string | null`）

```ts
export type HeadlessOutcome =
  | { status: "completed"; text: string }
  /** 跑过但拿不到最终文本（终止事件无 assistant 输出）。pi 不产生它（恒返回 string，空回复是 ""）。 */
  | { status: "no-output" }
  /** 跑过一部分：写入可能已发生。`aborted` 指请求已发出、中途被取消。 */
  | { status: "incomplete"; cause: "max-tokens" | "turn-limit" | "aborted" }
  /** 请求从未真正开始：宿主拒绝、模型不可用、适配层判定不该发、请求前就超时。`aborted` 指发出前取消。 */
  | { status: "not-run"; cause: "host-refused" | "unavailable" | "timeout" | "aborted"; detail?: string };

/** 描述符的 `notCompleted` 收的那一半：除 "completed" 之外的一切。 */
export type IncompleteOutcome = Exclude<HeadlessOutcome, { status: "completed" }>;
```

**判别规则**：请求发出去之前就结束 → `not-run`；发出去之后没拿到完整文本 → `incomplete`。
（pi 读这条时：`agent-runner` 的超时仍在抛错（`agent-runner.ts:170-180`，测试钉住 `rejects.toThrow`），
本轮不改，所以 **pi 实际只产生 `completed`**；`incomplete` / `no-output` 是给 dsh 的词汇，pi 侧的补齐见 §11。）

**core 自己的「不跑」不进端口词汇**：`runTask` 直接返回任务的 `R`（没有单独的 `TaskRunResult` 之类的
core 专用返回类型），core 自己的判定与端口给的非 `completed` 结果都由描述符的**同一个 `notCompleted` 钩子**
收口（`Incomplete` 联合的声明见 §6.1），避免把 core 的判定伪装成宿主的语言。

三个任务在 `notCompleted` 里把它映射成自己的词汇（**唯一允许「三套词汇」的地方**）：

| 任务 | ran（`parse`） | no-output | incomplete | not-run | no-input / lock-busy |
|---|---|---|---|---|---|
| autoSurfacing | `{files, content}`；`content === ""` 时适配层不注入 | `{files:[], content:""}` | `{files:[], content:""}` | `{files:[], content:""}` | `{files:[], content:""}` |
| extractMemories | `{skipped:false, result}` | `{skipped:false, result:""}`（今天 pi 的空回复就是这个形状，不能变成 skipped —— 否则「写了 N 条但没写总结」那轮的通知会消失） | `{skipped:false, result?}`（写入已发生，不能报错） | `{skipped:true}` | `{skipped:true}` |
| dream | 摘要 | `throw`（用户显式触发，静默等于骗人） | `throw`（带 cause；快照已在） | `throw`（带 cause） | `throw`（理论不可达） |

端口**抛错**（传输级异常）由 `plan.errorPolicy` 决定：`swallow` → 该任务把
`{status:"not-run", cause:"host-refused", detail}` 交给 `notCompleted`；`rethrow` → 原样上抛。
**try/catch 只在 `runTask` 一处**，三个任务不再各写一个。

`enabled` 不在这里判：它是**触发点决策**（§6.5 允许适配层读它），core 不会因为 `enabled: false` 而收到调用。

### 6.3 通用编排 + 任务声明

```ts
/** 适配层要提供的两个端口（形状不变，只有 `run` 的返回类型改了）。 */
export interface OrchestrationPorts {
  headless: HeadlessAgentPort;
  transcript?: HostTranscriptPort;
}

export interface TaskContext {
  cfg: MemoryConfig;
  cwd: string;                       // 三个任务恒为 memoryDir
  store: MemoryStore;
  ports: OrchestrationPorts;
  signal?: AbortSignal;
}

export async function runTask<I, R>(
  task: MemoryTask<I, R>,
  input: I,
  ctx: TaskContext,
): Promise<R>;
```

`runTask` 负责（全在 core 内）：读 `cfg`（model / effort / sessionPersistence / §6.1 表的预算）→
`buildPrompt` 返回 `null` 则 `task.notCompleted(…, { status: "no-input" })` → 施加 `plan.lock`（dream 的
`logicalLockActive()` 自检 + 进入时全目录快照；extract 的 `tryWithLogicalLock` 拿不到就
`task.notCompleted(…, { status: "lock-busy" })`）→ 构造 `HeadlessRunRequest` 跑端口 →
`completed` 走 `task.parse`，其余结果走 `task.notCompleted`（含 `errorPolicy`）。

**适配层只剩三件事**：提供端口（怎么调模型）、决定何时调 `runTask`（含 `enabled` 判定）、呈现结果。

「实现了哪些任务」是**适配层的一个常量声明**，不进端口：

```ts
export const IMPLEMENTED_TASKS: readonly ModelTask[];   // pi: 三个全有；dsh 本轮: ["autoSurfacing"]
```

它喂给两个纯函数：`modelConfigErrors(cfg, resolve, tasks)`（已有参数）与

```ts
export interface ModuleStatusRow {
  id: ModelTask;
  /** 该适配层是否实现了这个任务（`IMPLEMENTED_TASKS`）。 */
  implemented: boolean;
  /** 配置层面的开关；`dream` 恒为 true（它没有包级开关）。 */
  enabled: boolean;
  model?: string;
}
export function moduleStatusRows(cfg: MemoryConfig, tasks: readonly ModelTask[]): ModuleStatusRow[];
```

**core 只给数据，不给文案**：行序恒为 `dream → extractMemories → autoSurfacing`，但**过滤、排序、覆盖
`enabled` 都归适配层**：
- pi 直接按序拼 `id=on(model)` / `id=off`，与现有输出逐字一致；
- dsh 用自己的顺序（`autoSurfacing` 在前）、用自己的宿主可用性覆盖 `enabled` 与 reason
  （`rt.surfacing.available` 来自 `model.ts:96-136`，core 看 cfg 是看不出来的）、并**保留现有过滤**：
  未实现的模块只在用户的行 config 真写了该键时才显示（`index.ts:167` 的 `setKeys` 过滤）。
  `/memory` 的文案与那两条测试因此都不用改。

### 6.4 删掉的三个公开函数

`runSideQuery` / `runExtract` / `runDream` 与它们的 `RunSideQueryOpts` / `RunExtractOpts` / `RunDreamOpts`
**删除**（不留薄包装：那些 Opts 的字段全是 config 派生的扁平原语，裁定「core 自读 config」之后签名必换，
保留名字只会留下三个空壳）。适配层改为直接调 `runTask(TASKS.x, input, ctx)`；
core 自己的三个编排测试（`tests/orchestration/{surfacing,extract,dream}.test.ts`）改为对着 `runTask` 断言。
`scanEntries` / `renderSurfacedBlock` / `buildIndexSection` 等纯函数保留原签名（§8）。

### 6.5 为什么 config 必须由 core 自己消费

今天是反的：**core 定义旋钮，适配层拧旋钮** —— 三个 `run*` 的入参是扁平原语，读 `MemoryConfig` 的是适配层。
三个具体后果：

1. 每个适配层各有一段「config → opts」胶水，两段必须逐字一致却无法互相校验
   （`sessionPersistence` 的继承规则已经写了两遍：`pi-memory/index.ts:160-164` 的 `resolveDefault`、
   `dsh-memory/src/surfacing.ts:169-170` 的内联 `?? defaults`）。
2. 一个键是否生效取决于**每个调用点都记得传**；漏一个就静默回退，而测试只盖本校的调用点。
3. 错位知识无法从签名看出来（`nudge*` 就是例子）。

**所以本轮把消费点收回 core。** 但「适配层一个字都不读 cfg」是不成立的，也不该成立 —— 适配层仍可读三类：

| 允许适配层读 | 为什么 |
|---|---|
| `enabled`（`autoSurfacing.enabled` / `extractMemories.enabled`） | 触发点决策：不开启就不该调 `runTask`（连带 UI 的「搜索中…」也不该亮） |
| `memIndexMaxLines` / `memIndexMaxBytes` / `lock` | 构造 `MemoryStore` 与 `/memory` 的容量行（§8 不动 store） |
| 宿主能力类（dsh 的 `thinkLevel` → `resolveCallConfig` 探测、`model.ts` 的可用性） | 那是「宿主能不能跑这个模型」，不是配置值 |

**config 值**（预算、model、effort、sessionPersistence）一律 core 读。

## 7. 两处归属纠正

1. **`nudge*` 归 pi**：`MemoryConfig.dream` 去掉 `nudgeAfterSessions` / `nudgeAfterHours`。
   - 默认值住在 pi：`PI_HOST_DEFAULTS = { nudgeAfterSessions: 5, nudgeAfterHours: 24 }`（值原样搬）。
   - **两个文件的优先级不变**：pi 的 `loadConfig` 返回 `{ config, host }` —— 同一次 `JSON.parse` 出来的
     overlay 按**同样的顺序**（全局 → 受信项目）喂给 `mergeConfig` 和 `readPiHostConfig(overlay)`，
     项目级覆盖全局。不新增第二次读盘，不依赖 `deepMerge` 留未类型化残留键。
   - `shouldNudge` 改收 `PiHostConfig`；`/memory` 输出不变；`tests/index-wiring.test.ts` 的 fixture 形状
     要改（把 nudge 从 `dream` 子树挪到 `host`），断言语义不变。
2. **`sessionPersistence` 继承归 core**：per-task ?? `defaults`，在 `runTask` 内部读（§6.3）。
   pi 的 `resolveDefault` 与 dsh 的内联 `?? defaults` 都删掉。

## 8. 不动的东西

`MemoryStore`、磁盘格式、`MEMORY.md` 索引、`injection.ts`（`renderSurfacedBlock` / `buildIndexSection` /
`scanEntries` 的签名）、注入截断、prompt 文本（`prompts.ts` 一字不改）、`memory` 工具的 schema 与 action
语义、锁的实现（`tryWithLogicalLock` / `withLogicalLock` / 快照）。

## 9. 迁移与验收

**迁移清单**

| 位置 | 改动 |
|---|---|
| `memory-core/src/orchestration/{surfacing,extract,dream}.ts` | 退化为 `TASKS` 里的三个描述符；三个 `run*` 与 `Run*Opts` 删除（§6.4） |
| `memory-core/src/orchestration/ports.ts` | `HeadlessAgentPort.run` 返回 `HeadlessOutcome`；其余不动 |
| `memory-core/src/orchestration/task.ts`（新） | `runTask` / `TaskPlan` / `TaskDeps` / `TaskContext` / `Incomplete` / `buildRequest` / `TASKS` |
| `memory-core/src/config.ts` | 去掉 `nudge*`；其余不动 |
| `memory-core/src/index.ts` | 导出面增删（新增 `runTask` / `TASKS` / `moduleStatusRows` / `HeadlessOutcome` 等；删三个 `run*` 与 Opts） |
| `memory-core/tests/orchestration/{surfacing,extract,dream}.test.ts` | 改为跑 `runTask` + 描述符；端口桩返回 `HeadlessOutcome`；`toHaveBeenCalledWith` 的请求断言改按新构造；dream 的错误文案变成带 cause 的版本 |
| `memory-core/tests/config.test.ts` | `loadConfigFrom` 块整体迁往 pi（见姊妹稿 §7.3），其中 `nudgeAfterSessions` / `nudgeAfterHours` 两条期望随之删除 |
| `pi-memory/index.ts` | 四处 config 读取与 `requiredModel` 调用删除，改调 `runTask`；surfacing 的「渲染 → 标记 injected → 通知」顺序保留（渲染现在由 core 做，`content` 随结果返回） |
| `pi-memory/src/{config,nudge,agent-runner}.ts` | `loadConfig` 返回 `{config, host}`；`shouldNudge` 收 `PiHostConfig`；`createPiHeadlessAgent` 返回 `HeadlessOutcome`（pi 只产 `completed`，超时仍抛） |
| `dsh-memory/src/{headless,surfacing,index,model,commands}.ts` | 端口返回新词汇；`surfacing.ts` 不再读预算与 model；`UNIMPLEMENTED_MODULES` 删除、改用 `IMPLEMENTED_TASKS`；依赖抬到 `^2.0.0` |
| `dsh-memory/package.json` | `@yandy0725/memory-core` → `^2.0.0` |

**验收**

- 三个任务共用 `runTask`；`TASKS` 是唯一声明处；三个 `run*`/`Run*Opts` 在 `memory-core/src` 零命中。
- 表驱动测试：同一组 outcome → 任务结果断言跑三个任务，差异只在期望值。
- **config 消费点的机械检查**（不是「适配层零命中」，那是做不到的，见 §6.5）：
  ```
  grep -nE "maxFiles|maxContextTokens|maxToolResultChars|maxAssistantChars|maxEntryBytes|maxInjectionBytes|memIndexMaxLines" \
       pi-memory/index.ts pi-memory/src/*.ts dsh-memory/src/*.ts
  ```
  期望：只命中「构造 `MemoryStore`」与「`/memory` 容量行」那几处，且每一处都在上一轮的允许清单里。
  另：`pi-memory/src/config.ts` 的重导出面里不再有 `requiredModel` / `taskModel`（它们的使用点全部移进 core）。
- `nudgeAfterSessions` 在 `memory-core/src`、`memory-core/tests`、`memory-core/README*` 里零命中；
  pi 侧默认值仍是 5 / 24。
- `pi-memory` 行为测试期望值不变（`index-wiring` 只改 fixture 形状；`nudge`、`session-search`、`prompt-meta` 不动）；
  `agent-runner` 的 `rejects.toThrow(/timed out/)` 保持不动。
- `dsh-memory`：`/memory` 文案与那两条测试（`commands.test.ts` 的 quiet/loud 精确串、`assembly.test.ts:317`）
  保持不变 —— core 给行数据，dsh 仍自己过滤/排序/覆盖。
- `grep -rn "loadConfigFrom" memory-core/src` 零命中（姊妹稿的切片）。
- 全量：`check:host-deps` / `check:memory-core-deps` / `typecheck` / `lint` / `test` / `test-dist` 全绿；
  `smoke:registry` 见 §10.1。

## 10. 与配置 IO 下放同批交付（已定：一次发 2.0.0）

姊妹稿（`2026-11-10-memory-core-1.2.0-config-removal-design.md`）与本刀**同批交付**，一次发
`memory-core 2.0.0` + `pi-memory 4.0.0`。那份文档保留为**该切片的细节记录**，但它的版本号（1.2.0 / 3.1.0）、
串行发布表述、以及任何「`smoke:registry` 全绿」的验收措辞**以本文为准**。

### 10.1 PR 内会有一段暂时红：`smoke:registry`

该 job 把适配层 tarball 装进干净目录、**从 registry** 拉 core 再 import 入口。本 PR 之后 pi 的入口用上
`runTask` / `TASKS`，这些只存在于 `2.0.0`，而 registry 最新是 `1.0.1`。所以：

- **本 PR 的 `registry-smoke` 预期红**，红在「`@yandy0725/memory-core@^2.0.0` 查不到」，不是代码错；
- 它也是本轮唯一「必须先发布才能绿」的 job。

发布步骤（同时写进 `docs/guides/release.md`）：合并 PR（接受该 job 红，其余全绿）→ 在合并提交上打
`memory-core-v2.0.0` → 轮询 registry / 比对 `dist.shasum` / 确认 `dist-tags.latest` → `gh run rerun` 让
`registry-smoke` 转绿 → 再打 `pi-memory-v4.0.0`。

### 10.2 已接受的破坏

已发布的 `pi-memory@3.0.0` 声明 `@yandy0725/memory-core@^1.0.0`，会浮到 `2.0.0` 并在 import 时崩
（缺 `loadConfigFrom`，端口返回形状也变了）。用户已确认接受，只发一次 `2.0.0` + `4.0.0`。

## 11. 留给建造者的

- `runTask` 与 `MemoryTask` 的最终泛型形状（`<I, R>` 是否够用）。
- `parse` 是否需要 `async`（surfacing 的渲染是 async；若定成 `R | Promise<R>`，`runTask` 里统一 await）。
- extract 的 `incomplete` 精确返回形状（`{ skipped: false, result? }` 与 pi 现有通知逻辑的对接）。
- 迁移期是否需要端口兼容层（建议不要：两个适配层都在本仓内，一次改完）。
- pi 是否也在本轮补 stop-reason 管道（把 `softLimitReached` / abort 来源外提，让它能产 `incomplete`）。
  **建议不做**：与「pi 行为零变化」冲突，且 dsh 才是需要这套词汇的消费者。
- dsh 可以顺手删的重复判定：`model.ts` 里「有没有配 model」那一层（`runTask` 现在会抛，dsh 只在需要
  降级时提前门一道）。
