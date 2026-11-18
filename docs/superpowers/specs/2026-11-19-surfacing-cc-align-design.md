# Surfacing 对齐 Claude Code：compaction 清空、工具读取去重、prefetch 非阻塞

日期：2026-11-19
状态：待批准

## 1. 意图与背景

auto-surfacing 的现状（pi / dsh 一致）：持久注入 + session 级去重，侧查询在注入路径上被
`await`，阻塞本轮。本文把它对齐到 Claude Code 的 `findRelevantMemories.ts` 行为，并修掉
dsh 的去重状态缺陷。

CC 行为依据：v2.1.88 sourcemap 泄露源码的第三方分析
（`lin-guanguo.github.io/llm-memory-research/claude-code-sourcemap.research/` §2.4 Layer 2），
非官方文档。四个机制：

| CC 机制 | 含义 | 本次动作 |
|---|---|---|
| `alreadySurfaced` 去重 | 已注入过的文件不再浮现（无再提醒） | 现状已一致，**不加**轻量再提醒（明确否决过的方案） |
| `readFileState` 去重 | 模型主动读取过的文件也不再浮现 | 映射为 memory 工具的写成功与 memory-scope 搜索命中（我们没有直接文件读，也没有 `read` action） |
| prefetch | 轮首启动侧查询，与主循环并行，**settled 才消费，永不阻塞** | 本次主工作项，pi / dsh 统一为「边界持久化」单轨 |
| disposable | 本轮没赶上的结果作废，不带到下一轮 | 随 prefetch 一并实现 |

原痛点（「已注入的记忆后续相关也不再提醒」）经讨论决定**不处理**：接受 CC 语义，
由索引 section + memory 工具主动检索兜底。

## 2. 目标 / 非目标

目标：

- A：dsh 在 compaction / clear 之后清空 `injected`（pi 已有等价行为）。
- B：memory 工具让模型见过正文的文件进入去重集合（具体动作见 §4）。pi / dsh 都做，
  仅主 session，headless 子会话不污染。
- C：surfacing 侧查询改为 prefetch：主循环不等待；结果在同轮还有后续请求时尽早持久化、
  随下一请求进入模型上下文；持久语义（落 session、去重、resume/fork 重放）与 prefix
  caching 行为不退化。

非目标：

- 不做「已注入文件的轻量再提醒」（已否决）。
- 不改 side-query 的模型选择、maxFiles / 字节预算、`<relevant_memories>` 渲染格式。
- 不改 core 的公开 API 形状：`SurfacingInput` 不加字段；memory 工具的 action 集不变
  （不新增 `read`）。search 的 `details` 增加命中文件列表是纯加法，见 §4。
- 不处理 spec 已记录的 P12（侧查询错误语义不可区分）。

## 3. 工作项 A：dsh compaction / clear 清空 injected

事实依据（已验证）：

- 宿主 compact / clear 会以**同一个 sessionId** 重建 agent 并触发 `agent/created`，
  `payload.source` 为 `'compact' | 'clear'`（`dsh-agent/lib/types/runtime-types.d.ts` 的
  `SessionStartSource`）。
- `dsh-memory/src/index.ts:447` 已在处理「同一个 sessionId 再来一次 created」。

改法：在现有 `agent/created` 处理里，`source` 为 `'compact'` 或 `'clear'` 时
`injected.delete(sessionId)`。无需订阅 `dsh-compaction-basic`（adapter spec 的 P6 说法
被这个现有事件取代）。

为什么必须清：compaction 会把已注入的召回正文挤出上下文；不清则这些文件永不再浮现，
而正文已不在历史里 —— 去重的前提（正文可回看）被破坏。clear 同理（历史整个清空）。
pi 侧 `session_compact` 与 `resetSessionState` 已覆盖，无改动。

## 4. 工作项 B：工具读取计入去重（readFileState 的映射）

已验证的工具事实（`memory-core/src/tool/actions.ts` / `handler.ts`）：

- 主 agent 的 action 集是 `add / replace / remove / list / search`，**没有 `read`**。
- `search`（scope=memory）把每个命中 entry 的**完整 body** 拼进结果文本
  （`hits.map(e => … e.body)`）—— 搜索命中 = 模型见过正文。
- `list` 只有摘要行（name / type / modified / description / file）。
- add / replace 成功的 `details.file` 已存在；search 的 `details` 目前只有 count。

映射规则：

| 工具动作 | 是否计入去重 | 依据 |
|---|---|---|
| `add` / `replace` 成功 | 计入（`details.file`） | 模型自己写的内容必然已知 |
| `search` scope=memory 命中 | 计入命中文件 | 结果含完整正文 |
| `search` scope=sessions | 不计入 | 搜的是会话日志，不是记忆文件 |
| `list` | 不计入 | 只有摘要 |
| `remove` | 不计入 | 文件已删，自然离开 manifest |
| 任何失败 / 报错 | 不计入 | 模型没见到内容 |

实现：

- core：`search`（scope=memory）的 `details` 增加 `files: string[]`（命中文件列表，纯加法）。
- core 的 `SurfacingInput.injectedFiles` 注释语义扩展为「本 session 已让模型见过正文的
  文件（召回注入或工具读取）」，字段名不变，`candidates()` 过滤逻辑不变。
- pi / dsh 各自在**主 session 注册的 memory 工具** execute 成功分支，按上表把文件塞进
  同一个 `injectedFiles` Set。**headless 子会话（dream / extract / dsh 常驻 worker）的
  工具实例不做标记** —— 它们读写的正文主模型从未见过，污染去重会让主 session 静默
  失去召回。
- 与 `injectedFiles` 同生命周期：compaction / clear / session 切换时一起清空（工具读到的
  正文同样被 compaction 挤出），不需要第二套清空逻辑。

边界：`list` 行尾的 `[file]` 意味着模型也可能绕过 memory 工具、用宿主自带的文件工具
直读记忆文件。这条旁路钩不住（无法拦截宿主 read），不计入去重；官方读取通道是
`search`（工具 guidelines 也是如此引导的），上表已覆盖全部官方读通道。

## 5. 工作项 C：prefetch 非阻塞

### 5.1 统一消费语义（pi / dsh 一致）

- 只在「有真实用户 prompt 的轮」启动（pi：`messageType === "user"`；dsh：`step === 1`
  且真人 prompt 非空，均维持现状判据）。
- 启动后不 await；结果**就绪（settled）才消费**，未就绪的请求不带召回 —— 包括本轮
  第一个请求。这是对 CC `never blocks` 的对齐，也是对「现状第一轮必带记忆」的刻意行为变更。
- **消费 = 在「本轮之后还会有请求」的边界持久化**。若结果就绪时本轮已没有后续请求
  （零工具调用的单请求轮），则**作废**：不持久化、不标去重，下一轮按新 prompt 重新检索。
  pi 与 dsh 在此刻意一致，对齐 CC 的 disposable。
- 只有持久化才标记去重：持久化保证它最迟在下一请求进入模型上下文；渲染为空、取消、
  作废都不标记（维持现状原则）。
- 新用户轮启动时旧 pending 一律作废（新 prompt 取代）。

### 5.2 pi：turn_end 边界持久化（单轨，无 transient 注入）

1. `before_agent_start`（user run）：索引 section 照常无条件写入（保持在任何 await 之前）；
   启动 prefetch（`scanEntries` + `runTask(TASKS.autoSurfacing)`，传 `injectedFiles` 快照），
   存为 `pending`；**立即返回，不注入 message**。旧 `pending` 直接作废。
2. `turn_end`：`pending` 已就绪、未持久化、且 **本 turn 有工具结果**
   （`event.toolResults.length > 0`，保证必有下一请求）→ `entries` 追加
   `{ type: "custom_message", customType: "memory-auto-surfacing", content, display: false }`，
   标记 `injectedFiles`，清 `pending`。**不 `continue`**（工具结果自然引发下一请求）。
3. 零工具的 `turn_end`（含单请求轮）不持久化；`agent_before_settle` / abort /
   `agent_settled` 时清 `pending`，未持久化即作废。
4. 持久化的消息位于本 turn 的 assistant / tool-result 之后（entries 只能追加在边界），
   下一请求起它在历史固定位置，后续轮、resume/fork、extract 的 `host-transcript`
   跳过逻辑全部沿用现状。

可见时机：settle 后第一个「有工具结果的 turn」的下一请求 —— 与现状相比，本轮第一个
请求不再等待侧查询；与 transient 方案相比可见时机相同（pi 的 turn = 一次 LLM 响应 +
工具调用，turn_end 之后紧接着就是下一请求），见 §5.4 的 caching 分析。

### 5.3 dsh：同轮下一 pre-step 消费（现状机制的时序平移）

dsh 的 pre-step splice 消息随 admitted messages 落 session（现状即持久），只需把
「await 侧查询」改为「step 1 启动、同轮后续 step 消费」：

1. `pre-step` `step === 1`：索引快照照常刷新；启动 prefetch 存为 `pending`（记录 `turn`），
   **立即返回原 decision**，不 splice。
2. `pre-step` 同 `turn` 的 `step >= 2`：`pending` 已就绪 → 按现有逻辑 splice
   `<relevant_memories>` 消息、标记 `injected`、清 `pending`；未就绪 → 原样返回。
3. `pre-step` 发现 `turn` 已变 → 旧 `pending` 作废。同轮没有后续 step（模型直接答完）
   → 结果随轮结束作废，不标去重。

这正好复刻 CC 的「与工具执行并行、settled 才消费」：step 1 的模型请求与侧查询并行，
工具执行后的 step 2 消费。持久化、去重标记、渲染、取消复检全部沿用现有代码路径。

不采用 `agent.inject()`：它 queue 到「下一个被 admit 的 step」，本轮无后续 step 时会
pending 到下一轮（与 §5.1 的作废语义冲突），且「取消可能丢弃 pending context」会让
去重标记时机变复杂。

### 5.4 Prefix caching 分析（本次设计的硬约束）

原则：**召回正文一旦进入上下文，必须在会话历史中占据唯一、固定的位置**；同一份内容
绝不在不同请求里变换位置、重复出现。任何「每次请求临时拼进去」的形态都要避免。

- **被否决的双轨方案**（context transient 附加 + turn_end 持久化）：context 的附加不落
  session，下一请求的历史里没有它，只能再附在当时的消息尾部。于是召回块在每个请求里
  位置漂移、永远不属于任何稳定前缀 —— 每个请求都要对它重新 prefill（预算上限 20KB），
  缓存无法复用；而它带来的可见时机收益为零，因为 pi 的 turn_end 持久化之后紧接着就是
  下一请求，单轨持久化的可见时机与双轨完全相同。**收益为零、缓存成本为正，故删除
  transient 轨。**
- **本方案的缓存行为**：召回块只注入一次、位置固定（pi 在 turn 边界，dsh 在 claim 消息
  之后）。首次出现的请求对它 prefill 一次（任何注入方案都不可免），之后它成为稳定前缀
  的一部分，后续请求正常命中前缀缓存。未消费（未就绪 / 作废）的请求序列与召回关闭时
  逐字节一致，公共前缀不受任何影响。
- **system prompt 侧**：索引 section 继续按 session 冻结、每轮无条件写回同值，prefetch
  不触碰这条通道；召回不进入 system prompt，不制造 section diff。
- 回归验证：测试里记录连续两次请求的消息序列，断言召回块只出现一次、位置固定、且其
  之前的消息序列与不注入时一致。

### 5.5 其它被否决的替代方案

- **bounded wait**（在注入点等最多 N ms，超时放弃）：慢查询时本轮永远没有召回，且仍在
  阻塞路径上放固定延迟。
- **纯 transient 注入（不持久化）**：违背「持久 + 去重」语义；transient + 去重是最差组合
  （正文不在历史又不再浮现）。
- **零工具单请求轮也持久化（下轮历史可见）**：与 dsh 无法对齐（dsh 需额外引入
  `agent.inject()` 通道与取消丢弃的标记复杂度），且 CC 的 disposable 语义就是本轮没赶上
  即作废；统一作废更简单、更忠实。
- **维持 await 注入**：本次要消除的正是它。

## 6. 风险与待验证

- pi `turn_end` 的 `custom_message` entries 在 fake harness 与真宿主的行为一致性（现有
  wiring 测试的 fake 需要支持 entries 提案与 `toolResults`），以及不 `continue` 时不制造
  额外请求。
- 零工具单请求轮的召回作废是刻意语义（本轮模型不见、下轮重新检索），要写进用户文档。
- dsh `turn` 计数在 compaction 重建 agent 后可能归零：pending 判 turn 作废的逻辑要容忍
  重建（重建时 pending 一律作废）。
- 并发：pi 的 `before_agent_start` 可能重叠（queued follow-up），新 run 启动即作废旧
  pending，保证只有最新 prompt 的检索在飞。
- headless 工具不标记的回归：dream 全流程后，主 session 的 `injectedFiles` 必须保持为空。

## 7. 测试与文档

- pi wiring 测试：deferred 侧查询（手工控制 settle 时机）覆盖：未就绪不注入、有工具结果
  的 turn_end 持久化 + 去重标记、下一请求消息序列中召回块位置固定且唯一、零工具轮作废、
  晚于轮结束作废、abort 作废、新 run 作废旧 pending。
- dsh 测试：step 1 启动不等待、step 2 消费并标记、turn 变化作废、compact/clear 后
  `injected` 清空（复用现有 fake agent/created）。
- 工具读取去重：add/replace 成功标记、memory-scope search 命中标记（details.files）、
  sessions-scope search / list / 失败不标记、headless 工具不标记、compaction 后重新可浮现。
- 关键用例做变异验证（如删掉「未就绪不注入」「仅主 session 标记」应红）。
- `docs/reference/{pi-memory,dsh-memory}{,.zh}.md` 的召回段落改为描述新时序与去重口径
  （只写现状，不写演进）；README 不动。
