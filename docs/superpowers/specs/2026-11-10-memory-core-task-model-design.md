# memory-core 的任务模型：把「三个需要模型的任务」收成一等对象

日期：2026-11-10
状态：**待批准（建造者审阅后）**
范围：`memory-core` 引入任务描述符 + 通用编排 + 结构化结果词汇；`pi-memory` / `dsh-memory` 只声明与呈现。
前置：`docs/superpowers/specs/2026-11-10-memory-core-1.2.0-config-removal-design.md`（配置文件 IO 下放）——
两刀的关系见 §10。
依据：`docs/superpowers/specs/2026-11-09-dsh-memory-adapter-design.md` §9 的 P1 / P6 / P12，以及本轮对
dsh 0.2.2-rc.1 安装树（`~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai`）的调研。

---

## 1. 意图

`memory-core` 里有三个「需要一次 LLM 调用」的任务：`autoSurfacing`、`extractMemories`、`dream`。
它们的知识今天散在**六处**：

1. `config.ts` 的三个配置子树（`autoSurfacing` / `extractMemories` / `dream`）；
2. `orchestration/{surfacing,extract,dream}.ts` 三个 `run*` 函数，各自手写轮数、超时、工具集、锁与快照；
3. `ModelTask` 这个闭集合 + `requiredModels(cfg, tasks?)` 这个「调用点补丁」；
4. 适配层把 config 映射成 opts 的那段胶水（pi 的 `resolveDefault`、dsh 内联的 `?? defaults`）；
5. dsh 自己维护的 `UNIMPLEMENTED_MODULES` 常量与 `/memory` 的「配了但不生效」提示；
6. 三个任务各不相同的失败词汇（`[]` / `{skipped}` / `throw`）。

结果是：**同一个概念（一个任务）在六处各有说法**，而任何一处要改都得同时改三处以上。
本刀要把它收成一处：任务是一等对象，编排是一条通用循环，适配层只提供「怎么调模型」与「怎么呈现」。

## 2. 为什么是现在

- 第二个消费者（dsh）已经落地第一刀，它对三个任务的**能力边界**已经实测清楚（§4）：工具受限的嵌套会话要靠
  `ctx.agents.create` + `setup` + `restrict` 组合，**没有轮数上限**，**会话会落盘**，**结构化输出只在
  subagent 通道上有**。这些事实决定了端口该长什么样，晚一天设计就多一天猜。
- 上一轮已经因为「照侦察笔记猜宿主行为」返工四次（spec §2.3）。这次先把 dsh 消费者形状核到位。

## 3. 目标 / 非目标 / 反目标

**目标**

- 一个任务 = 一份描述符：id、是否要模型、静态策略（轮数/超时/工具集/锁与快照）、prompt 构造、回复解析、
  未完成时怎么呈现。三个任务都从这张表里长出来。
- 一条通用编排循环（跑一次端口 + 解释结果 + 施加锁/快照），三个任务共用。
- 端口返回**结构化结果**，替掉今天的 `string | null`；三个任务的失败词汇在同一处收口（P12 的修法）。
- 适配层用一份声明表达「我实现了哪些任务」，替掉 `requiredModels(cfg, tasks?)` 的调用点补丁与 dsh 的
  `UNIMPLEMENTED_MODULES`。
- 把两处错位的知识挪回它该在的地方：`nudge*` 归 pi、`sessionPersistence` 继承规则归 core 纯函数。

**非目标**

- 不在本轮**实现** dsh 的 extract / dream。本刀只保证描述符与端口能承载它们（判定标准：dsh 侧写这两个任务
  时，不需要再动 core 的公开面）。
- 不改 prompt 文本、磁盘格式、`memory` 工具的 action 语义（用户契约）。
- 不改 `memory.json` 的任何用户可见键名（`nudge*` 只是从 core 的类型里搬走，文件仍是同一个、键名不变）。
- 不改 pi-memory 的用户可观察行为：同一份配置、同一个时机、同一句通知。

**反目标（技术成功也算失败）**

- 描述符变成「万能配置对象」：任何一项策略如果不是**至少一个任务**真的需要，就不许进描述符。
- 适配层为了对齐描述符而开始复制 core 的业务判断（比如自己决定「哪些文件算候选」「对话怎么截断」）。
- 端口为了迁就某一个宿主长出第二组可选字段（今天的 `HeadlessRunRequest` 已经 9 个字段）。

## 4. dsh 消费者形状（调研结论，0.2.2-rc.1）

`ROOT = ~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai`

### 4.1 受限工具的嵌套会话：**没有现成 API，但能用公开服务拼出来**

- 更底层的一等公民是 `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>`
  （`ROOT/dsh-agent/lib/types/index.d.ts:292`，`AgentHandle = { agent, dispose() }` `:150-153`）。
  `setup?: AgentSetup` 是**发布前**的组合窗口：`(agentCtx, agent) => ...`，文档原文「Setup composes,
  it never drives」（`:101-105`）。
- 「只给一个工具」在 `setup` 里做：`agentCtx.tools.restrict({ allow: ["memory"] })`
  （签名 `ROOT/dsh-tools/lib/types/index.d.ts:50-58`；语义「只保留这些全局工具，其余移除」，作用域内注册的
  不受影响 —— `contracts.d.ts:356-365`）。`restrict` 必须由**agent 作用域**的 ctx 调用，全局调用会抛错
  （`ROOT/dsh-tools/lib/index.js:454-455`）。
- 驱动与取结果有官方参考实现：`agents.create(...)` → `agent.followup(createUserMessage(...))` →
  `await agent.whenIdle()` → 从 Session 事件里取「最后一条非空 assistant 消息」
  （`ROOT/dsh-headless/lib/index.js:336-380`；纯函数规则见 `dsh-subagent/lib/types/assistant-output.d.ts:20-47`）。
- 面向模型的 `subagent` 工具**不能**用来做这件事：`toolFilter` / `persona` 已被明确移除
  （`ROOT/dsh-tool-subagent/lib/index.js:346`），只有 preset 能配工具组合。
- `ctx.subagents.startActivation` 虽然是一等公民（`dsh-subagent/lib/types/index.d.ts:136-146`），但
  `SubagentStartRequest` **没有工具集字段**（`types.d.ts:127-174`），且它不把子 ctx 交给调用方 —— 拿不到
  `restrict` 的机会。

**结论**：dsh 侧要实现「一次性 + 只给 memory 工具 + 拿最终文本」，路径是
`agents.create` + `setup` 里 `register` 自己的工具并 `restrict({ allow })` + `followup`/`whenIdle` + 从
session 事件取文本。**每一块都是公开服务**，但拼装成本全在适配层。

### 4.2 没有轮数上限

全树查不到 `maxTurns` / `maxSteps` / `iterationLimit`（`SubagentStartRequest` 里唯一的上限是
`maxDepth`，那是递归层数 —— `dsh-subagent/lib/types/types.d.ts:168-173`）。唯一沾边的是工具结果上的
`concludesTurn`（数据驱动，不是计数，`dsh-agent/lib/types/runtime-types.d.ts:411-416`）。

**影响**：core 的 `maxTurns: 5` 在 dsh 侧**无法硬性执行**。要么适配层自己听 `turn/start` 并在超限时
`agent.cancel()`（`runtime-types.d.ts:184`），要么接受跑飞。描述符里的轮数只能是**建议值**，并且必须
被文档标成 best-effort —— 这正是「不能靠猜」那类事实。

### 4.3 嵌套会话会落盘

persistence 来自服务是否挂载（`ctx.sessionPersistence`），**没有 per-session 开关**：
`ROOT/dsh-agent/lib/types/index.d.ts:182`「if `ctx.sessionPersistence` exists」；`createStoredSession` 在没有
后端时返回 `undefined`（纯内存），但那取决于 profile 装了什么。默认 profile 装了 jsonl
（`ROOT/dsh-base/cordis.patch.yml:138-141`）。

**影响**：pi 的 `sessionPersistence: { enabled: false }`（extract / dream / 侧查询都不落盘）在 dsh 侧
**不可兑现**。所以端口里的这个字段只能是**提示**，并且用户会看到 dsh 的会话日志里多出这些子会话 ——
这是必须写进 dsh README 的行为差异，不能假装对齐。

### 4.4 其它三条

- **超时**：`llm.stream` 没有 per-call deadline，adapter 只有 provider 级的 idle watchdog；通用计时器在
  `dsh-timeout`（`deadline` / `idleWatchdog` / `clampTimeout`，`ROOT/dsh-timeout/lib/types/index.d.ts:36-101`）。
  超时的可观察结果是终止 chunk `{type:"finish", reason:{kind:"error"|"aborted"}}`，**不抛错**
  （`ROOT/dsh-llm/lib/index.js:2404-2415`）。
- **结构化输出**：只有 subagent 通道有 `outputSchema`（自动挂 `structured_output` 工具 +
  `dsh-subagent/lib/types/structured.d.ts:14-48`）；`llm.stream` 的 `GenerateOptions` **没有**
  `toolChoice` / `response_format`（`dsh-llm/lib/types/types.d.ts:538-580`，全树无匹配）。
  所以「解析模型回复」必须留在 core 且必须防御式。
- **结果词汇**：dsh 侧有 `stopReason: completed | aborted | error | max-tokens | refusal`
  （`dsh-subagent/lib/types/types.d.ts:222-262`），rich 到足以直接映射成 core 的结果结构；而今天的端口签名
  `Promise<string | null>` 把它压成一个 null（与 P12 同病）。

## 5. 方案与取舍

| 方案 | 形态 | 取舍 |
|---|---|---|
| **A（选定，C1）** | 任务描述符 + 通用编排 + 结构化结果 + `implementedTasks` 声明；适配层只提供 transport、触发点、呈现 | 单点策略（跨宿主一致），端口从「哑管道」变成「有词汇的端口」；代价是一次真的公开面重构 |
| B | 任务级端口（`runSurfacing` / `runExtract` / `runDream` 各一个） | prompt 与写入语义会分叉（两个宿主对同一份 `MEMORY.md` 的维护规则不同），且第三个宿主抄第三遍 |
| C（已弃） | 只做归属纠正（nudge / sessionPersistence / implementedTasks），`run*` 形状不动 | dsh 的 §4 事实已经到手，现在收形状的成本最低；再等一轮等于把同一处签名改两次 |

判定规则（写进 §7 的任务描述符纪律，用于拒绝未来的加项）：**一段逻辑的差异会不会让两个宿主对同一份磁盘
记忆做出不同判断？会 → core；不会 → 适配层。**

## 6. 核心模型

### 6.1 任务描述符

```ts
export type MemoryTaskId = "autoSurfacing" | "extractMemories" | "dream";

/** 一次任务的静态策略：全是数字/枚举，不含宿主形状。 */
export interface TaskPolicy {
  /** 建议轮数上限。dsh 无法硬性执行（§4.2），适配层尽力。 */
  maxTurns?: number;
  timeoutMs: number;
  /** 子会话可用的 builtin 工具。 */
  builtinTools: "none" | "file-io";
  /** 注入子会话的 memory 工具 action 集；`null` = 不注入。 */
  memoryTool: readonly MemoryAction[] | null;
  skipLogicalLock: boolean;
  skipSnapshot: boolean;
  /** 编排层施加的互斥与快照：none / 整轮逻辑锁 / 逻辑锁 + 进入时全目录快照。 */
  lock: "none" | "logical" | "logical+snapshot";
}

export interface MemoryTask<I, R> {
  readonly id: MemoryTaskId;
  readonly policy: TaskPolicy;
  /**
   * 输入 → prompt 全文。返回 `null` = **core 自己判定这一轮不跑**（候选为空、消息为空）。
   * 今天这两处判定在 `runSideQuery` / `runExtract` 的头部，保留它们就意味着两个薄包装仍带业务判断；
   * 收进这里之后 `runTask` 才是唯一循环。
   */
  buildPrompt(input: I): string | null;
  /** 回复 → 结果。必须防御式：dsh 的 stream 通道拿不到强制结构化输出（§4.4）。 */
  parse(text: string, input: I): R;
  /** 端口没跑完/跑飞时，这个任务怎么呈现（三个任务词汇不同的唯一合法处）。 */
  incomplete(input: I, outcome: IncompleteOutcome): R;
}
```

三个任务的具体值（今天散在三个 `run*` 里，逐字搬过来）：

| 任务 | maxTurns | timeout | builtinTools | memoryTool | lock |
|---|---|---|---|---|---|
| autoSurfacing | 1 | 30 s | none | null | none |
| extractMemories | 5（best-effort） | 120 s | none | `MAIN_AGENT_ACTIONS` + skipLogicalLock | logical（`tryWithLogicalLock`，拿不到就跳过） |
| dream | 无 | 600 s | none | `DREAM_ACTIONS` + skipLogicalLock + skipSnapshot | logical+snapshot（整轮持锁 + 进入时全目录快照） |

### 6.2 端口结果词汇（替掉 `string | null`）

```ts
export type HeadlessOutcome =
  | { status: "completed"; text: string }
  /** 跑了，但宿主拿不到最终文本（终止事件没有 assistant 输出）。pi 今天不产生它（恒返回 string），
   *  空回复是 `completed` + `text: ""`。 */
  | { status: "no-output" }
  /** 跑过一部分（max-tokens / 轮数用尽 / 中途取消）：写入可能已经发生。 */
  | { status: "incomplete"; cause: "max-tokens" | "turn-limit" | "aborted" }
  /** 没跑：宿主拒绝、模型不可用、适配层判定不该跑、超时。
   *  **`timeout` 只是 dsh 的路：** pi 的超时今天在 `createPiHeadlessAgent` 里 throw（`agent-runner.ts:170-180`），
   *  本轮不改 —— 端口级异常继续抛，由任务的决定沿用今天的行为（surfacing 吞 / extract 上抛 / dream 上抛）。 */
  | { status: "not-run"; cause: "host-refused" | "unavailable" | "timeout" | "aborted"; detail?: string };
```

**core 自己的「不跑」不进端口词汇**：`runTask` 另有一个只属于 core 的返回类型，避免把 core 的判定伪装成宿主的语言：

```ts
export type TaskRunResult<R> = { kind: "ran"; value: R } | { kind: "skipped"; cause: "no-input" | "lock-busy" };
```

三个任务各自把它映射成自己的词汇（**这是本轮唯一允许「三套词汇」的地方**）：

| 任务 | completed | no-output | incomplete | not-run | core skipped |
|---|---|---|---|---|---|
| autoSurfacing | 解析 → 文件名数组；解析失败 → `[]` | `[]` | `[]`（部分结果不注入） | `[]` | `[]` |
| extractMemories | `{ skipped: false, result }` | `{ skipped: false, result: "" }`（今天 pi 的空回复就是这个形状，不能变成 skipped —— 否则「写了 N 条但没写总结」那轮的通知会消失） | `{ skipped: false, result? }`（写入已发生，不能报错） | `{ skipped: true }` | `{ skipped: true }` |
| dream | 摘要文本 | `throw`（用户显式触发，静默等于骗人） | `throw`（带 cause，提示可能有不完整写入；快照已在） | `throw`（带 cause） | `throw`（理论不可达） |

`error` 不作为一个 status：适配层自己的异常仍然**抛**（transport 级失败），由各任务的决定沿用今天的行为
（surfacing 吞、extract 上抛、dream 上抛）—— 这条不变量写进 `runTask` 的注释。

### 6.3 通用编排 + 声明的任务集

```ts
export async function runTask<I, R>(
  task: MemoryTask<I, R>,
  input: I,
  req: {
    model: string;
    effort?: string;
    cwd: string;
    signal?: AbortSignal;
    sessionPersistence?: SessionPersistenceConfig;
    /** extract 用它数「本轮真的写了几条」（`HeadlessRunRequest.memoryTool.onWrite` 的唯一来源）。
     *  放在 task input 而不是这里：它是任务的结果统计，不是宿主形状。见 §11。 */
  },
  deps: { store: MemoryStore; headless: HeadlessAgentPort },
): Promise<TaskRunResult<R>>;
```

`runTask` 负责：`buildPrompt` 返回 `null` → `{ kind: "skipped", cause: "no-input" }`；施加 `policy.lock`
（含 dream 的 `logicalLockActive()` 自检与进入时快照、extract 的 `tryWithLogicalLock` 拿不到就
`lock-busy`）；构造 `HeadlessRunRequest`（轮数/超时/工具集全部来自 `policy`；适配层只是把这些字段原样交给
宿主，**不再自己决定策略值**）；跑端口；按 §6.2 收口。

适配层声明实现面：

```ts
export interface OrchestrationPorts {
  headless: HeadlessAgentPort;
  transcript?: HostTranscriptPort;
  /** 本适配层实现了哪些任务。core 据此派生模型校验集与 /memory 的模块行。 */
  tasks: readonly MemoryTaskId[];
}
```

`modelConfigErrors` / `requiredModels` 的 `tasks?` 参数保留（它是干净的纯函数参数），但**所有调用点**改成
传 `ports.tasks`；dsh 的 `UNIMPLEMENTED_MODULES` 删掉，由 `TASKS − ports.tasks` 派生。

`/memory` 的状态行不进 core 的字符串形态 —— 两个宿主的文案结构本来就不同（pi 空格分隔、
`dream=on(m) extractMemories=off autoSurfacing=on(m)`；dsh 逗号分隔、`autoSurfacing` 在前、
`off(<宿主给的 reason>)`、未实现的追加 `dream=not implemented in this adapter`），强行统一等于改文案。
所以 core 只提供**行数据**，由适配层拼：

```ts
export interface ModuleStatusRow {
  id: MemoryTaskId;
  status: "on" | "off" | "unimplemented";
  /** status === "on" 时有值。 */
  model?: string;
}
/** 顺序恒为 dream → extractMemories → autoSurfacing；`off` 的 reason 由适配层自己补。 */
export function moduleStatusRows(cfg: MemoryConfig, tasks: readonly MemoryTaskId[]): ModuleStatusRow[];
```

## 7. 两处归属纠正

1. **`nudge*` 归 pi**：`MemoryConfig.dream` 去掉 `nudgeAfterSessions` / `nudgeAfterHours`。它们只决定「何时
   提醒用户跑 dream」，不写记忆（§5 的判定规则）。`memory.json` 的键名不变。
   - **默认值住在 pi**：`PI_HOST_DEFAULTS = { nudgeAfterSessions: 5, nudgeAfterHours: 24 }`（今天在 core 的
     `DEFAULT_CONFIG.dream`，值原样搬）。
   - **只有一条读取路径**：pi 的加载器本来就要 `JSON.parse` 那两个文件，把**已经解析出来的 overlay 对象**
     交给 `readPiHostConfig(overlay)`（纯函数：白名单这两键 + 类型校验 + 落到默认值），与 `mergeConfig`
     共用同一次读取，**不新增第二次读盘**、不依赖 `deepMerge` 留未类型化残留键（那会让「写了但没生效」
     再次变成静默回归）。
   - `nudge.ts` 的 `shouldNudge` 签名从 `config.dream.*` 改成收 `PiHostConfig`；`/memory` 输出不变。
   - 副作用（好的）：dsh 的行 config 白名单是从 `DEFAULT_CONFIG` 派生的，这两个键因此自然不再被 dsh 接受。
2. **`sessionPersistence` 继承归 core**：新增纯函数
   `resolveSessionPersistence(cfg, task)`（per-task ?? `defaults`）。pi 的 `resolveDefault` 与 dsh 内联的
   `?? defaults?.sessionPersistence` 都删掉 —— 这是跨宿主必须一致的语义。

## 8. 不动的东西

`MemoryStore`、磁盘格式、`MEMORY.md` 索引、注入截断、prompt 文本（`prompts.ts` / `injection.ts` 一字不改）、
`memory` 工具的 schema 与 action 语义、`HostTranscriptPort` 的形状、`installTask` 之外的锁实现。

## 9. 迁移与验收

**迁移**：`pi-memory` 的 `createPiHeadlessAgent` 从「返回 `string | null`」改成「返回 `HeadlessOutcome`」
（pi 的会话结果 → `completed` / `no-output` / `incomplete` 的映射，以及超时/拒绝 → `not-run`）；
`dsh-memory` 的 `createDshHeadless` 把 `finish.reason.kind` 与 `stopReason` 映射进同一套词汇。两处都在适配层，
三行左右的 switch。**`MemoryConfig` 的形状变了（少两个 nudge 键），所以是破坏性变更**。

**验收**

- `core` 的三个任务共用 `runTask`；三个 `run*` 函数退化为 `runTask` + 描述符的薄包装（保留导出名，
  避免适配层一次性全改）。
- 同一组「outcome → 任务结果」的映射测试跑三个任务（表驱动），三个任务的差异只出现在期望值里。
- `nudgeAfterSessions` 在 `memory-core/src` 与 `memory-core/README*` 里零命中。
- `pi-memory` 的**行为测试**期望值不变（`index-wiring`、`nudge`、`session-search` 等）；只有直接桩端口的单元测试要
  按新返回类型**构造** `HeadlessOutcome`（断言语义不变）—— 今天端口恒返回 `string`，改类型必然碰这类桩。
- `pi-memory` 的 `agent-runner` 超时仍然是 throw（见 §6.2），那条 `rejects.toThrow(/timed out/)` 测试保持不动。
- `dsh-memory` 的 `UNIMPLEMENTED_MODULES` 消失；`/memory` 的 `Modules:` 行由 `moduleStatusRows` 生成，
  现有那条「dream=not implemented in this adapter」测试仍绿（文案不变，因为拼装仍在 dsh 侧）。
- `grep -rn "loadConfigFrom" memory-core/src` 零命中（与 §10 的前置刀一致）。
- 全量：`check:host-deps` / `check:memory-core-deps` / `typecheck` / `lint` / `test` / `test-dist` /
  `smoke:registry` 全绿。

## 10. 与配置 IO 下放同批交付（已定：一次发 2.0.0）

`2026-11-10-memory-core-1.2.0-config-removal-design.md` 那刀（配置文件 IO 下放）与本刀**同批交付**，
一次发 `memory-core 2.0.0` + `pi-memory 4.0.0`。那份文档保留为**该切片的细节记录**（§7 的具体改动、测试迁移表、
两个冒烟脚本的改法）；它的版本号（1.2.0 / 3.1.0）与“串行发布”的表述作废，以本文为准。

### 10.1 PR 内会有一段暂时红：`smoke:registry`

`scripts/registry-smoke.mjs` 把适配层的 tarball 装进干净目录、**从 registry** 拉 core，然后 `import` 入口。
本 PR 之后，pi 的入口会用上 `runTask` / `TASKS` / 新的端口类型 —— 这些东西只存在于 `2.0.0` 里，而 registry 上
最新是 `1.0.1`。所以：

- **本 PR 的 `registry-smoke` 预期红**，它红在「`@yandy0725/memory-core@^2.0.0` 查不到」这一步，不是代码错；
- 它也是本轮唯一一个“必须先发布才能绿”的 job，因为它的全部意义就是「用户拿到的那条路径必须真跑过一次」。

发布步骤因此写进 release 流程（不只写在本稿）：

1. 合并 PR（接受 `registry-smoke` 红，其余全绿）；
2. 在合并提交上打 `memory-core-v2.0.0` → `publish.yml` 发布 → 按 `docs/guides/release.md` 轮询 registry、
   比对 `dist.shasum`、确认 `dist-tags.latest`；
3. `gh run rerun` 合并提交的 workflow，`registry-smoke` 转绿（这才是它真正被满足的时刻）；
4. 再打 `pi-memory-v4.0.0`。

备选（我不推荐）：把 core 2.0.0 从**已审阅的 PR 分支提交**上打 tag 先发 —— 它能让 PR 绿，代价是发布未经合并的代码。

### 10.2 两个破坏性变更的合并后果（已接受）

已发布的 `pi-memory@3.0.0` 声明 `@yandy0725/memory-core@^1.0.0`，它会浮到 `2.0.0` 并在 import 时崩
（缺 `loadConfigFrom`、端口返回形状也变了）。用户已确认接受：不发 `1.2.0` / `3.1.0` 过渡版本，只发一次
`2.0.0` + `4.0.0`。缓解只有一条：core 与 pi 的发布间隔尽可能短。

## 11. 留给建造者的

- `runTask` 与 `MemoryTask` 的最终泛型形状（`<I, R>` 是否够用，还是要 `MemoryTask<unknown, unknown>` + cast）。
- 三个 `run*` 薄包装的保留期限（建议本轮保留，下一刀删）。
- `onWrite` 的落点：本轮定为 **任务 input** 上的字段（`RunExtractInput.onWrite`），因为它是「本轮写了几条」的
  结果统计，不是宿主形状；`runTask` 只负责把它透到 `HeadlessRunRequest.memoryTool.onWrite`。
- `incomplete` 在 extract 里的精确返回形状（`{ skipped: false, result? }` 与 pi 现有通知逻辑的对接）。
- 迁移期是否需要 `HeadlessAgentPort` 的兼容层（建议不要：两个适配层都在本仓内，一次改完）。
