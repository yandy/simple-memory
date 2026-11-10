# dsh-memory 适配层设计（第一刀：共享记忆 + 自动召回）

日期：2026-11-09
状态：**待批准**（建造者审阅已完成，处置见 §13）
目标宿主：`@deepseek-ai/dsh` **0.2.2-rc.1**（本机 `npx @deepseek-ai/dsh@latest` 的安装树，Node 要求 `>=24.9.0`）
范围：把 `dsh-memory/` 从占位实现成 cordis bundle 插件，让 dsh 会话与 pi 会话读写**同一份**
`$XDG_DATA_HOME/simple-memory` 记忆。本轮交付四件事：`memory_index` system prompt section、
`memory` 工具、`/memory` 命令、auto-surfacing（每轮召回 `<relevant_memories>`）。
不在范围：extract、dream（含 nudge 与 `/dream`）、旧数据迁移提示、npm 发布动作、任何 `memory-core`
代码改动、磁盘格式 / prompt 文本 / `memory` 工具 action 语义的改动、跨 harness 的共享配置文件。

侦察依据：本机 dsh 安装树 `~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/`（0.2.2-rc.1）的
`lib/types/*.d.ts` 与 `lib/*.js`，四份笔记在 `/tmp/dsh-recon/notes-{injection,tools,headless,session}.md`
（本文引用的宿主事实都标了包名与文件，建造者可复核）。宿主自带的官方插件开发指南在
`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`，本文的装配形态以它为准。

---

## 1. 背景与目标

`simple-memory` 的存在理由是「一份磁盘记忆被多个 harness 共享」。今天只有 pi 一个消费者，而
`memory-core` 的端口面（`HeadlessAgentPort` / `HostTranscriptPort` / `memoryToolSchema` /
`createMemoryActionHandler`）**是从 pi 身上抽出来的**：`ThinkLevel` 就是 pi 的枚举，
`HeadlessRunRequest` 的注释里直接写着 pi 的白名单坑，`sessionPersistence` 是 pi `AgentSession`
的旋钮。`dsh-memory/README.md` 自己写明了这个占位的用途 ——「让 `memory-core` 的端口面有第二个
消费者可以对着设计」。

因此本轮有两个同等重要的产出：

1. **一个真跑得起来的 dsh 插件**：dsh 会话能看见记忆索引、能用 `memory` 工具读写、每轮能召回相关记忆，
   落盘位置与 pi 逐字相同。
2. **一份有证据的 core 痛点清单**（§9）：第二个消费者撞上的每一个接缝都记下来，作为之后一次性
   core 重构 spec 的输入。本轮对 core 只做三个**纯加法** API（§2.1），不改任何现有行为。

成功判据：在同一台机器上、**在使用默认 `memoryDir` 的前提下**，pi 会话写入的记忆，dsh 会话的索引
section 里能看到、`memory` 工具能读到；反向同样成立。（`memoryDir` 是 per-harness 配置，见 D4 的推论。）

## 2. 已确认决策

| 编号 | 决策 | 理由 |
|---|---|---|
| **D1** | 本轮范围 = 索引 section + `memory` 工具 + `/memory` 命令 + auto-surfacing。extract / dream 留下一轮 | 前三样是「共享记忆」的最小闭环；auto-surfacing 是用户点名要的。extract / dream 需要「一次性受限工具子会话」，而 dsh 没有这个 API（§3 第 3 行），成本与风险都独立成一刀 |
| **D2** | TS 源 + `dist/` 构建（照 `memory-core` 的形状）；**运行时零宿主 import**：宿主包只以 `import type` 出现（tsc 擦除）并声明进 `peerDependencies`，宿主能力全部经 `inject` 进来的 `ctx` 服务拿 | 宿主是快速变动的 rc（0.2.0-rc.2 → 0.2.2-rc.1 已经改了 `system-prompt/assemble` 的 payload、`PromptContext` 的字段、`agent/pre-step` 的 `modelSelection`），没有类型检查等于把破坏留到运行时。零宿主 import 则直接绕开「out-of-tree 插件静态解析不到宿主包」那条约束，不需要 `createRequire` 兜底 |
| **D3** | `dependencies` 只有 `@yandy0725/memory-core: ^1.1.0`，从 registry 装。1.1.0 = 本轮给 core 加的**三个纯加法 API**（§2.1） | 落实「不改 core 的现有行为」：三个都是加法或放宽，对 `pi-memory` 零破坏。发布推到 dsh 单测全绿之后（§7.1 的开发回路走仓内 alias，不需要 registry），因为真宿主安装那一步才需要 1.1.0 在 registry 上 |
| **D4** | 配置**只有一层：宿主的配置**。dsh 侧 = cordis 行 `config:`（在 profile 或 home 级的 `cordis.patch.yml` 里）。**没有跨 harness 的全局配置文件**；core 只提供默认值，不管理配置 | 用户定的方向。每个宿主只有一处配置入口，符合 dsh 惯例（`practices.md`：「把可调值放进插件的 `Config`，用户在 `cordis.patch.yml` 里改，用户的 patch 层能挺过升级」）。**推论**：`memoryDir` 因此是 per-harness 的 —— 谁覆盖了它，就得在两个宿主里都覆盖，否则两边写不同目录。这条要写进 README 与 `/memory` 的输出 |
| **D5** | dsh **不读任何 JSON 配置文件**（既不读项目级的，也不读 `$DSH_HOME/memory.json` 或 XDG 配置目录） | dsh 没有「项目受信任」这个概念（pi 靠 `isProjectTrusted()` 挡住 clone 下来的 `.pi/memory.json`），而宿主级配置已经有了惯用落点（行 config）。少一处落点 = 少一处「用户改了却不生效」 |
| **D6** | 注入走 `agent/pre-step` waterfall（`{ prepend: true }`），抄 `dsh-time-context` 的写法；消息 `source` 用自己的 `kind` + `form: "notice"` | `practices.md` 指定的机制就是它；`agent.inject()` 不唤醒 agent、落点是「下一个被 admit 的 step」，召回会与它要服务的那一轮错位。`form` 的选择见 §5.7 |
| **D7** | 索引走 `ctx.systemPrompt.section({ name, order, text: () => 缓存, interpolate: false })`，配一份「异步刷新 / 同步读」的 per-session 缓存 | `PromptSection.text` 的函数形态**必须同步**（每次 `assemble()` 调用一次），而 `buildIndexSection` 是异步的。`interpolate: false` 是硬要求：正文里出现 `{{` 会在渲染时抛错 |
| **D8** | 工具走 **Route A**：把 core 的 `memoryToolSchema(actions)` 原样当 `parameters` 塞进手搓的 `ToolDefinition`，不经 `defineTool` | `ctx.tools.register()` **不校验** `parameters`（`dsh-mcp-client/lib/index.js:181-196` 就是这么把上游 MCP 的 inputSchema 原样透传的）；而 core 的 schema 只用了 `type/required/properties/enum/description`，全部落在 dsh 强制的 JSON Schema 子集内（不支持 `anyOf`/`$ref`/`format`/`min*` 等，我们一个都没用）。这样模型看到的线格式与 pi **逐字相同** |
| **D9** | 工具与 store 按 **agent 作用域**注册：在 `agent/created`（serial、创建完成前被 await）里解析 memoryDir、建 store、`agent.ctx.tools.register(...)`；**只挂根 agent**，子 agent 不挂 | `MemoryHandlerDeps.getStore()` 是**同步**的，而 `resolveMemoryDir()` 是异步的（要探 git remote）；`agent/created` 是唯一的异步窗口。dsh 一个进程可同时托管多个 session（web app），全局单一 store 会把 A 项目的记忆写进 B 项目的目录。子 agent 门禁的理由见 §5.5 |
| **D10** | `engines.dsh` 显式声明 `">=0.2.2-rc.1 <0.3.0"` | profile 在 **import 插件之前**就拿 `engines.dsh` 对 `getDshRuntimeVersion()` 做版本门（`evaluatePluginCompatibility` 用 `semver.satisfies(..., {includePrerelease: true})`）；`engines.dsh` 存在时 peer 范围被忽略。`0.2.2-rc.1` 排序低于 `0.2.2`，所以 `"^0.2.2"` 匹配不到它 |
| **D11** | `private: true` 先留着；发布形态（去 private、`locale/*.json`、`icon`、`publish.yml` 的 `dsh-memory-v*` tag）等真宿主验证通过再翻 | 发布是独立决定，且 `docs/guides/release.md` 的发布顺序门目前只覆盖 core 与 pi-memory |
| **D12** | 模型标识沿用 core 的 `model: string`，编码为 `"<provider>/<model>"`，**按第一个斜杠拆**；`thinkLevel` 原样当 `reasoningEffort` 透传 | dsh 的模型是 `{provider, model}` 两段，而 model id 自己可以含斜杠（本机 profile 的历史版本里就有 `megcore` + `qwen/qwen3.8-max`）。按第一个斜杠拆对它成立。core 把 `model` 当不透明字符串、运行时也不校验 `thinkLevel`，所以**不需要改 core** |
| **D13** | **降级优先，不进全局错误态**：模型缺失或不可解析 → 只关掉需要它的那个模块（本轮只有 auto-surfacing），索引 section 与 `memory` 工具照常可用；原因在 `/memory` 里显示。只有「配置读不出来 / memoryDir 解析失败」才让该 session 进错误态，此时工具仍注册但走 core 的 unavailable 分支 | 用户定的方向（没配 model 时静默降级为关）。这也修掉了照抄 pi 会带来的问题：core 的 `requiredModels()` **恒包含 `dream`**，而本轮 dsh 不实现 dream —— 照抄就会要求用户配一个**永远用不到**的 `dream.model`，否则整个记忆层是暗的 |
| **D14** | `search scope=sessions` 用**自己扫**：`ctx.sessionQuery.filterSessions([{kind:"cwd",values:[cwd]}])` 拿该项目的会话 + `readSession(id)` 拿解码后的 events，文本抽取与上下文窗口自己写，输出口径对齐 pi | pi 侧（`pi-memory/src/session-search.ts`）本来就是纯扫描、没有索引，所以自己扫 = 与 pi **同语义**；打开宿主的 SQLite FTS 反而会让 dsh 的召回强于 pi，同一份记忆在两个 harness 里搜出不同结果。dsh 的会话日志默认 zstd 压缩，不能直接 `readFile` 分行，解码交给宿主服务 |

### 2.1 本轮附带的 `memory-core` 1.1.0（只加不改）

设计阶段就已经擞出三个「不修就得在适配层写以后要拆的脚手架」的接缝（§9 的 P1 / P2 / P11）。
三个都是**加法或类型放宽**，对 `pi-memory` 零破坏，所以先于 dsh 实现一起做；而「把 `loadConfigFrom`
拆掉、文件 IO 下放给适配层」那一步（用户定的「core 只提供默认值、不管理配置」的完整形态）
**仍留到下一轮** —— 那对 `pi-memory` 是破坏性变更，而且应该等 dsh 真跑起来、知道「宿主自己读配置」
到底长什么样之后再动刀。

| 加法 | 签名 | 为什么是安全的 |
|---|---|---|
| **导出纯函数 `mergeConfig`** | `export function mergeConfig(base: MemoryConfig, overlay: unknown): MemoryConfig` | 把 `config.ts` 里**已有的私有** `deepMerge` 提出来导出，并让 `loadConfigFrom` 内部改用它 —— 合并语义只有一份，不可能漂移。跳过 `undefined`、plain object 递归、数组整体替换的语义逐字不变 |
| **思考档位类型变不透明** | `export type EffortLevel = string`（新增，中立名）；`export type ThinkLevel = EffortLevel`（保留别名） | 闭枚举 → `string` 是放宽，core 里**没有**任何 exhaustive switch。保留 `ThinkLevel` 别名是为了 `pi-memory/src/config.ts:29` 的重导出与已发布的 3.0.0 不破。pi-memory 的 typecheck 已核实不会变红：它交给 pi SDK 的边界本来就是 cast（`agent-runner.ts:95` 是 `thinkingLevel: opts.thinkLevel as any`，`:204` 是 `req.effort as ThinkLevel \| undefined`）。**配置键名 `thinkLevel` 不动**（那是用户契约，改名要迁移说明），只改类型 —— 键名的 pi 词汇归下一轮 |
| **校验可指定任务集合** | `requiredModels(cfg, tasks?: readonly ModelTask[])` 与 `modelConfigErrors(cfg, resolve, tasks?: readonly ModelTask[])` 各加一个可选第三/第二参 | 缺省行为不变（仍走 `requiredModels(cfg)` 那个「dream 恒在集合内」的规则）；传了 `tasks` 就只校验这些任务。dsh 传 `["autoSurfacing"]`。**修订注（实现期裁定，见下）**：缺省路径上有一处已裁定的行为变更 —— 用户写了 `"extractMemories": null` 时，旧行为是抛 `TypeError`，新行为是跳过该任务 |
| **侧查询可传 abort signal**（实现期新增，见 §2.5） | `RunSideQueryOpts` 加可选 `signal?: AbortSignal`，`runSideQuery` 把它透传给端口的 `HeadlessRunRequest.signal` | 端口本来就声明了 `signal?`（`orchestration/ports.ts:29`），但 `runSideQuery`（`orchestration/surfacing.ts:49-62`）从不设它，所以宿主那一轮的取消信号传不进去。因为 core 把侧查询的 `timeoutMs` 写死为 `30_000`，而适配层是在宿主**会 await** 的 `agent/pre-step` waterfall 里调它的，不传 signal 就意味着用户取消后仍可能卡住 30 秒。可选字段 = 纯加法，pi-memory 不传就是 undefined，零影响 |

发布顺序按 `docs/guides/release.md`：`npm version 1.1.0 --workspace=memory-core --no-git-tag-version`
→ 同时 add `memory-core/package.json` 与 `package-lock.json` → push → `gh release create
memory-core-v1.1.0 --target <完整 SHA>` → 轮询 registry 到 200 + 比对 `dist.shasum` + 确认
`dist-tags.latest`。**这是本轮唯一的不可逆动作**，排在 dsh 单测全绿之后、真宿主验证之前（§7）。

### 2.2 实现期修订：`requiredModels` 对 `null` 子树的行为

本节是实现对 §2.1「缺省行为逐字不变」那句的**一处修正**，在 Task 3 实现与审阅时被发现并裁定。

**事实**：旧实现读 `cfg.extractMemories.enabled` / `cfg.autoSurfacing.enabled`，而 `deepMerge` 会把用户
写的 `"extractMemories": null` 原样带进来 —— 所以旧行为是抛 `TypeError`。新实现统一用
`cfg[task]?.enabled`，于是变成跳过该任务。

**裁定：接受新行为**。三条证据：

1. 没有任何测试钉住那个抛错。core 现有的 null 测试（`tests/config.test.ts`）针对的是 `dream: null`
   配 `taskModel`；pi-memory 的 null 测试（`tests/index-wiring.test.ts`）针对的是 `moduleStatusLine`。
2. **core 自己的书面意图相反**：`taskModel` 的注释写着「`deepMerge` 会把用户写的 `"dream": null`
   原样带进来 —— 那时应该报「没有模型」，而不是抛 TypeError」，并为此用了 `cfg[task]?.model`；
   pi-memory 的 `moduleStatusLine` 也用 `?.` 并注「不能因此抛错，把整个 `/memory` 命令带崩」。
   旧的那个 `TypeError` 是潜在 bug：在 pi 侧被 `index.ts` 的 try/catch 吞成一个看不懂的 misconfigured 错误态。
3. 两套测试全绿：core `484 passed | 4 skipped`、pi-memory `200 passed`（与基线逐字一致）。

**净效果**：写了 `"extractMemories": null` 的用户从「一条看不懂的 misconfigured」变成
「`extractMemories=off`」，与 `/memory` 状态行既有的显示口径一致。

**这个裁定带来的两条义务**（已归入 Task 3 的 fix round）：`requiredModels` 的文档注释必须把
这个例外说清楚（不能继续写「逐字不变」），且新语义必须有一条测试钉住。

### 2.3 实现期修订：三处对宿主的事实错误（Task 6 审阅发现）

本文初版与实现计划里有三处对宿主 API 的描述是**错的**。它们是在审阅「迷你假 cordis ctx」时
被发现的 —— 那个假 ctx 是后续十一个任务唯一的测试地基，它一旦对宿主说谎，十一个任务会全绿
而插件上线即坏。三处均已对着宿主源码核实，本节是权威叙述，与下文任何描述冲突时以本节为准。

| # | 错误的描述 | 宿主的事实（已核实） | 影响 |
|---|---|---|---|
| **1** | 「`ctx.llm.stream()` 失败时抛错，所以侧查询用 try/catch 包住、抛错就返回 `null`」 | `dsh-llm/lib/index.js:2355-2357` 的 catch 是 `yield adapterFailureChunk(error, options.signal)`；方法注释（:2390-2396）逐字写着「Adapter selection, dispatch, and iteration failures become terminal `error` or `aborted` finish chunks; middleware, nested-call, cleanup, and consumer failures **remain thrown**」。`NO_ADAPTER` 由 `registration()` 抛在 `adapterStream` 内部 → **被吞成终止 chunk** | §5.7 的 headless 端口必须**两条通道都覆盖**：`try/catch` 接住真的抛错，**且**识别 `{type:"finish", reason:{kind:"error"\|"aborted"}}` 终止 chunk。只包 try/catch 的话，生产里的宿主拒绝会被当成正常数据流处理 |
| **2** | 「`ctx.sessionQuery.listSessions(...)` 按 cwd 过滤，返回 `{items, nextCursor}` 分页」 | `dsh-session-query/lib/types/index.d.ts:67` 是 `listSessions(signal?: AbortSignal): Promise<SessionRecord[]>` —— **裸数组**、newest-first、只接受一个 `AbortSignal`；cwd 过滤在**另一个方法** `filterSessions(filters, signal)`（:81）。宿主自己的 `dsh-tool-session-query` 也是 `sessionFilters.push({kind:"cwd", values:[cwd]})` | §5.8 改用 `filterSessions`。更险的是：若把 `AbortSignal` 传给一个期望查询对象的实现，`typeof signal === "object"` 为真、各字段全 `undefined` → **静默返回整个语料**，不过滤也不分页。这是无声偏差里最坏的一类 |
| **3** | 「子 agent 判据的候选字段是 `delegationDepth` / `parentSession` / `origin`」 | `dsh-session/lib/types/types.d.ts:71-76` 在 `parentSession` 上明文警告：「Ordinary forks omit this field; historical ordinary forks may retain their source id here. **Presence alone does not classify a Session as a subagent; use `origin` for that distinction.**」`origin?: 'subagent'`（:83-87）才是官方分类字段；`delegationDepth`（:86-92）只对 subagent child 递增 | §5.5 的门禁以 `origin` 为主判据。用 `parentSession` 会把**普通 fork 会话**误判为子 agent，后果是那个会话的索引 / 工具 / 召回全部静默不挂 —— 而假 ctx 永远造不出这种会话，所以测试不会红 |

| **4** | 「侧查询自己累积 `content_block` 文本」 | `dsh-llm` 的 `StreamChunk` 联合（`lib/types/types.d.ts:458-487`）里**没有 `content-block` 这个类型**。实际只有：`block-start {index, blockType}`、`text-delta {index, text}`、`reasoning-delta {index, text}`、`tool-call-delta`、**`block-end {index, block: ContentBlock}`**、`usage`、`finish {reason, replayState?}`。而宿主自己的 `BlockAssembler`（`lib/index.js:954-1055`）用**首次出现顺序**（`order.push(index)` + `assembled()` 的 `this.order.map`），且 block-end 一旦设了权威 block 就**冻结该 index**（两个分支开头的 `if (partial.block) return;`） | §5.7 的文本累积必须按真实词汇与真实顺序语义写。`reasoning-delta` 被宿主累积成独立的 `{type:"reasoning"}` block，**绕不能并入答案** |

这四条同时说明了一件事：**侦察笔记里的二手汇总不足以支撑实现级的接口定义**，尤其是「方法名对、
签名错」、「字段存在、语义不是你想的那个」与「类型名看似合理、宿主根本不发」这三类错误。
后续任务凡涉及宿主接口，以宿主 `node_modules/@deepseek-ai/*/lib/types/*.d.ts` 与 `lib/*.js` 为准。

### 2.4 实现期修订：会话搜索只抽四类事件、只搜真人发言

Task 13 审阅时发现本文初版对 §5.8 的两处描述不够严，已修订：

**一、可搜索的事件类型限定为四类，`todo/write` 不搜。** 初版只说了「四类抽文本，其余贡献空串」，
但没说明宿主自己的抽取器还含 `todo/write` 与 `turn/end`（`dsh-session-query/lib/index.js:551-552`）。
实现时把 `todo/write` 加了进来，那会让 dsh 的召回**强于** pi（pi 只搜 message 文本）—— 正是 D14 要避开的分叉。
已明确：只抽 `user/message`、`assistant/message`、`tool/call`、`tool/result`；`todo/write` 与 `turn/end`
虽然宿主会抽，但为了跨宿主同语义，这里不抽。

**二、`user/message` 的真人判定用白名单，不用黑名单。** 初版同时写了「按 `source.kind === "user"` 过滤」
与「对未知 kind 要放行」，两者矛盾：前者是白名单，后者是黑名单。实现选了黑名单 + 一份只覆盖
约 7/30 个真实 kind 的清单（其中 `"skill"` 在宿主里根本不存在，真名是 `skill-invocation` 与
`skill-catalog`）。因为黑名单对未列项默认放行，那些漏掉的合成消息会被当成真人发言搜出来。

定为白名单（只认 `source.kind === "user"`），理由：宿主的 `MessageSourceMap` 是**可合并扩展**的
（任何插件都能声明自己的 kind），所以黑名单结构上不可能完备；而两种失败模式里，
「静默搜出注入噪声」比「宿主改了 kind 名 → 搜索返回空」难发现得多。

这两条与 §2.3 的四条同源：都是「看上去合理的宿主描述」与「宿主实际行为」的差。区别在于：
§2.3 的四条是事实错误，本节两条是**约束自身不自洽 / 不够精确**。

### 2.5 实现期修订：core 需要第四个加法（侧查询的 abort signal）

Task 14 的审阅发现本文 §3 第 8 行的一句声称是**做不到的**：「侧查询挂在 pre-step 的 `signal` 上，
随 turn 取消」。事实是：

- core 的 `HeadlessRunRequest` **声明了** `signal?: AbortSignal`（`orchestration/ports.ts:29`），
  dsh 的端口实现（`dsh-memory/src/headless.ts`）也真的组合并兜它；
- 但 `RunSideQueryOpts`（`orchestration/surfacing.ts:6-21`）**没有 signal 字段**，
  `runSideQuery`（:49-62）也从不设 `HeadlessRunRequest.signal`；
- 而 `runSideQuery` 把 `timeoutMs` 写死为 `30_000`（:57）。

所以适配层拿到的端口根本没机会收到宿主那一轮的取消信号。后果是具体的：`agent/pre-step` 是宿主
agent loop **会 await** 的 waterfall，用户按 Esc 取消之后，循环仍会被一次已经没人要结果的侧查询
占住最多 30 秒 —— 这正是本模块「绝不能拖垮一轮」承诺的反面。

**裁定：给 core 加第四个纯加法** —— `RunSideQueryOpts.signal?: AbortSignal`，并由 `runSideQuery`
透传给端口。理由：（1）可选字段，对 pi-memory 零影响（不传就是 undefined，而端口本来就声明了它）；
（2）core 1.1.0 **尚未发布**，现在加几乎零成本，等发布后再加就要再走一次发布流程与顺序门；
（3）不加的代价是用户可见的 30 秒卡顿。§3 第 8 行已按此修订。

同时记录一条相关但**本轮不改**的事实：`runSideQuery` 把三种语义完全不同的结果（宿主拒绝/超时、
跑了但没选中、抛错）全部压成 `[]`（:49-67 的 `try/catch` 与 `result === null` 分支），适配层因此
无法向用户或日志区分「召回失败」与「没有相关记忆」。pi-memory 同样受此限制。→ §9 痛点 P12。

### 2.6 实现期修订：`MEMORY_TOOL_SNIPPET` 在 dsh 的落点与出现判据

Task 16 审阅发现：§5.5 / §5.6 写了「`promptSnippet` → 索引 section 开头」，但**没有任何一个任务把它派下去**，
于是 `MEMORY_TOOL_SNIPPET` 在 `dsh-memory/src/**` 里零引用。本节把落点与判据定下来。

**为什么需要重新找落点**：pi 的 snippet 不在索引 section 里，它是 `ToolDefinition.promptSnippet`
字段（`pi-memory/src/memory-tool.ts:79`），由 pi 宿主自己渲染进 system prompt —— 即 snippet 搭的是
**工具定义**的车。dsh 的 `ToolSchema` 只有 `{name, description, parameters, deferLoading?}`（`output` /
`execute` 等在投影时被剥掉），投有 `description` 一个模型可见通道，而那个已经给了
`MEMORY_TOOL_DESCRIPTION`。所以我们自己的 `memory_index` section 是唯一能把 snippet 递给模型的通道。

**出现判据（本节新定，原文未写）**：snippet 出现 ⇔ **该 session 有 runtime**
（`registry.get(sessionId) !== undefined`）。理由：那正是 `agent/created` 给该 agent 注册工具的
条件，而 pi 的 snippet 是「工具注册了就在」。三个推论：

1. 健康但**零记忆**的会话也要有 snippet（此时索引正文为空，section 就只有 snippet）——
   这正是新项目第一次被鼓励写记忆的时机，不能因为索引还是空的就把工具说明也吐掉。
2. **错误态**会话（`store === null`）也要有：按 D13 工具仍然注册（只是 `execute` 抛可读原因），
   与 pi 一致。
3. **子 agent 不要**：D9 的门禁使子 agent 根本不会得到 runtime，而全局 section 的 `text` 回调
   查不到缓存就返回空串 —— 两个机制自然对齐，无需额外门禁。

**落点：`index.ts` 的 section `text` 回调，而不是 `index-cache.ts`。** 理由：「三通道文案往哪里落」
是宿主知识（本文自己的判据：语义相同 → core，语义随宿主而异 → 适配层），而 `index-cache` 的职责是
「索引快照」，它必须继续对未知 session 返回 `""`。拼接规则：无 runtime → `""`；有 runtime 且索引为空
→ 只有 snippet；两者都有 → `snippet + "\n\n" + 索引正文`。

注意这**不会**改变索引正文本身：`buildIndexSection` 的输出仍逐字不动（跨宿主字节恒等仍是硬要求），
snippet 只是在它前面。也不影响 pi：pi 继续用宿主的 `promptSnippet` 通道。

### 2.7 实现期修订：`MEMORY_TOOL_GUIDELINES` 也落进同一个 section

本节由终审引出。§9 的痛点 P4 原本写着「guidelines 在 dsh 没有落点」，但这个理由**已被 §2.6 自己推翻**：
既然 `memory_index` section 是一个可用的模型可见通道、且 snippet 已经落在那里，guidelines 同样能落，
而且不需要改 core、不需要改 prompt 文本、不碰用户契约（落的**位置**是适配层的事，文本本身逐字不动）。

实测三通道字数（从 `memory-core/dist` 读）：`description` **522**、`snippet` **58**、`guidelines` **1143**（7 条）。
只落前两个意味着 dsh 只发了 core 提示词契约的 580/1723 = **34%**，而 pi 的三通道预算是 2750 字符。

**裁定：guidelines 也落进 `memory_index` section，出现判据与 snippet 完全相同（该 session 有 runtime）。**
三条理由：

1. **记忆目录是共享的，所以写入质量是跳宿主的。** guidelines 管的正是写入质量（「description 必须自足」
   及其正反例：Bad: "Debugging tips" / Good: "staging SSH listens on 2222, not 22"）。dsh 会话写出含糊的
   description，会**连带降低 pi 会话的召回质量** —— 这是跨宿主损害，不是 dsh 单方面的风格选择，
   而 P4 原本的框定没提到这一层。
2. **pi 三通道全发**，对齐才符合 D14 的同语义原则。
3. **成本很小且可缓存**：约 1143 字符 ≈ 300 token，而且是 section 里的**静态**文本（能被 prompt cache
   命中），相对于索引本身最多 16KB 的注入预算占比很小。

公平地说反面：`MEMORY_TOOL_DESCRIPTION` 已经携带了其中最重要的那一条规则（「A memory's description is
the only text a future session sees when deciding relevance, so it must be self-contained」），所以这是一个
**质量差距而不是空洞**。如果用户更在意那 300 token，删掉它是一行的事 —— 所以这条裁定已明确报给用户。

拼接顺序固定为：`snippet` → `guidelines` → 索引正文（与 pi 把两者都放 system prompt 、工具描述另走的
布局等价），分隔用空行。无 runtime 时仍返回 `""`，索引正文仍逐字不动。

## 3. 宿主事实：pi 的原语在 dsh 里对应什么

这张表是本轮全部工作量的来源。**没有一行是记忆逻辑** —— 记忆逻辑在 core 里，一行都不用重写。

| # | pi 有 | dsh 0.2.2-rc.1 的对应物 | 本适配层的做法 |
|---|---|---|---|
| 1 | `before_agent_start` 一个钩子返回 `{systemPromptOptions.sections, message}` | 没有单一钩子。system prompt 是 `ctx.systemPrompt.section()`（`text` 回调**必须同步**，每次 `assemble()` 调一次，`assemble()` 每个 step 调一次）；每轮上下文是 `agent/pre-step` waterfall（异步，可替换进入该 step 的 messages） | D7 + D6，两个机制各管一半 |
| 2 | `pi.registerTool(typebox schema)`，handler 返回 `{content, details}` | `ctx.tools.register(definition)`，`output` 是**必填**的；`execute(args, exec)` 必须返回符合 `output.schema` 的**规范 JSON 值**，模型看到的文本由 `output.render(args, value)` 产生；返回值里**任何位置**出现 `undefined` 都会让 `snapshotJsonValue` 抛 `ToolOutputError`；报错方式是 **throw**（宿主转成 `isError: true` + `Error: <msg>`） | D8；output 只放 `content`（§5.6），从根上避免 `undefined` |
| 3 | `createAgentSession`：一次性受限工具子会话 | **没有这个 API**。`ctx.subagents.startActivation(spec)` 的 `spec.request.parent` 是**必填的活 Agent**；`ctx.llm.stream()` **没有内置 tool loop**（`tools.execute(` 在全部 331 个宿主包里只出现一次，在 `dsh-agent-loop/lib/index.js:961`） | 本轮不需要（侧查询是零工具）。下一轮 extract / dream 要用 `ctx.agents.create()` + `agentCtx.tools.restrict({allow:[...]})` + `concludeTurn()` 自己搭 |
| 4 | `ctx.ui.notify/confirm/setStatus` | **不存在**（116 个宿主 `Context` 服务里没有 ui/notify/toast/status）。`ctx.logger`（`error\|warn\|info\|debug`）不进 UI —— 宿主只装了个 1000 条环形缓冲 | 用户可见通道 = `/memory` 命令的返回文本、以及召回消息的 `form: "notice"` 摘要（§5.7）；诊断走 `ctx.logger` |
| 5 | `pi.registerCommand("memory", {handler})` | `ctx.commands.register({name, description, input?, handler})`，`name` 须匹配 `/^[a-z][a-z0-9_-]*$/`（不带斜杠），handler 收 `{commandId, agent, rawInput, attachments, signal}`，返回 `{kind:"success", text?}` 或 `{kind:"error", text}` | `/memory` 直接可用。`unlock` 的确认：命令 handler **不在 turn 里**，`ctx.approval.request()` 会拒；改用「必须显式写 `unlock --force`」（§5.6） |
| 6 | `SessionManager.list(cwd)` + 直接读 jsonl | `ctx.sessionQuery`（`listSessions` / `readSession` / `filterEvents` / `observeSession` 都可用），但**全文搜索默认关**：`dsh-base/cordis.patch.yml:149-161` 把 `session-query-sqlite` 配成 `openAt: never` + `path: ':memory:'`，`searchSessions()` 直接抛 `SESSION_QUERY_SEARCH_DISABLED` | D14：自己扫，不碰宿主配置 |
| 7 | `event.messages` 就是 `{role, content, toolCalls}` | session **events**（`user/message` / `assistant/message` / `tool/call` / `tool/result`），且**多数 `user/message` 是合成的**，要靠 `source.kind` 区分（`'user'` 才是真人） | 本轮只需要「取本轮真人 prompt」（`agent/pre-step` 的 `messages` 已经是被 claim 的 user messages，再按 `source.kind === "user"` 过一遍）；events → `ExtractMessage` 的映射留给下一轮 |
| 8 | `session_shutdown` 等在途任务收尾 | SIGTERM 后 **5 秒硬退**（`PROCESS_SHUTDOWN_TIMEOUT_MS = 5000`），第二个信号立即 `process.exit()` | 本轮没有在途 LLM **写**任务（侧查询不写盘，不会留下 `.lock`），所以硬退不造成数据损坏。侧查询靠 `RunSideQueryOpts.signal`（§2.1 第四个加法）挂到 pre-step 的 signal 上随 turn 取消，并在 await 之后复检 abort；注意宿主 5 秒硬退仍短于 core 写死的 30 秒超时，退出时仍可能在途（可接受）。下一轮 dream 必须用 `ctx.jobs` 的 unowned job + 锁的同步 `cancel()` 钩子 |
| 9 | model id 字符串 + `ThinkLevel`（pi 的 6 档枚举） | `{provider, model}` 两段 + `reasoningEffort`（**合法值是 per-route 的数据**，不是枚举：DeepSeek 路线 `off\|low\|high\|max`，pi-ai 路线 `off\|minimal\|low\|medium\|high\|xhigh\|max`） | D12 + D13。core 1.1.0 把档位类型放宽成不透明的 `EffortLevel = string`（§2.1），所以 `max` 能过 typecheck；合法值由适配层的启动期 `resolveCallConfig` 校验 |
| 10 | `ctx.cwd`（一个 session 固定不变） | 没有 `ctx.cwd` / `ctx.workspace`。用 `ctx.workingDirectory.get(session)`（同步）或 `.ensure(agent, signal)`（带校验，first-party 用法）；另有不可变的 `agent.session.header.cwd`（原始项目目录）。**而且 dsh 的 cwd 是运行期可变的**（`ctx.workingDirectory.set()` + durable `working-directory/change`） | `agent/created` 时解析一次，作为该会话的权威（与 pi 对等）；不订阅 `working-directory/change`。`/memory` 打印解析出的 `Dir`，让用户能发现不一致 → §9 痛点 P10 |
| 11 | `pi.extensions: ["./index.ts"]`，宿主剥类型 | bundle 形态：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；in-tree 包**全部**发编译后的 `lib/index.js` + `lib/types/**/*.d.ts`。bundle 必须出现在 profile 的 `dsh.profile.bundles` 列表里才会被 compose，而**`dsh plugin --profile <p> add <spec>` 会自动写这个列表**：`dsh-plugin-manager/lib/types/operations.js:101-135` 在包管理操作之后 reconcile bundles（新装且声明了 `dsh.bundle.patch` 的依赖被 push 进去并写回 manifest，移除时同样过滤掉）；`dsh-app-boot` 的 `reconcileProfilePlugins` 文档原文即「New bundle dependencies activate automatically」。本机 `web` profile 里的 `dsh-web-fetch-http-fakeip` 就是这个路径的活证据（同时出现在 `dependencies` 与 `dsh.profile.bundles`，而安装只用了一条 `dsh plugin add`） | D2 + D11；安装与开发回路见 §7.1 |
| 12 | 扩展加载器把宿主包映射好 | 运行时解析表只供给「安装自带的包与被选中的 bundle」；out-of-tree 插件静态 import 宿主包不保证可解析 | D2 的零宿主 import 让这条约束失效（不需要碰它） |
| 13 | 插件配置由扩展自己读文件 | 行 `config:` 由 loader 传给 `apply(ctx, config)`；**不导出 `Config` 时原样透传**（`cordis-plugin-loader/lib/index.js:746-752`：`const schema = fiber.runtime?.Config; const unparse = schema?.["simplify"]; entry.options.config = unparse ? unparse.call(schema, config) : config`）。导出 `Config` 才换来校验与免费 Settings UI，但那需要运行时 import `@deepseek-ai/schemastery` | D4：不导出 `Config`，自己校验行 config（约 40 行 + 单测），代价是没有 Settings UI 页面 → §9 痛点 P5 |

## 4. 目录结构与模块职责

```
dsh-memory/
├── package.json            private · type:module · main/exports→dist · engines.dsh · files
│                           · dsh.bundle.patch · peerDependencies(@deepseek-ai/*) · dependencies(memory-core ^1.1.0)
├── tsconfig.json           开发/typecheck：paths 把 @yandy0725/memory-core 指到 ../memory-core/src/index.ts
├── tsconfig.build.json     产出 dist/（ESM + .d.ts + maps），照 memory-core 的同名文件
├── vitest.config.ts        resolve.alias 同上；MEMORY_CORE_FROM_DIST=1 时不设 alias
├── cordis.patch.yml        bundle 层：insert 一行 { id: memory, name: '@yandy0725/dsh-memory', config: {} }
├── src/
│   ├── index.ts            apply(ctx, config)：装配全部注册；inject 列表；错误态
│   ├── row-config.ts       行 config 的白名单校验 + 与 core DEFAULT_CONFIG 的 deep-merge（含与 loadConfigFrom 的等价性测试）
│   ├── model.ts            "<provider>/<model>" 拆解 + 启动期校验（走 ctx.llm.resolveCallConfig）+ 模块降级判定
│   ├── store-registry.ts   per-agent 的 memoryDir/store 解析与缓存（异步解析、同步取用）
│   ├── index-cache.ts      索引快照：异步刷新 / 同步读（section 的 text 回调必须同步）
│   ├── memory-tool.ts      core 的 JSON Schema + handler → dsh 的 ToolDefinition 字面量
│   ├── surfacing.ts        agent/pre-step：取真人 prompt → runSideQuery → 拼 <relevant_memories> → 插回 messages
│   ├── headless.ts         零工具 HeadlessAgentPort：ctx.llm.stream + 自己累积文本
│   ├── session-search.ts   search scope=sessions（D14 的自己扫）
│   └── commands.ts         /memory 状态、/memory unlock --force
└── tests/
    ├── helpers/fake-ctx.ts 手写的迷你 cordis ctx（只实现我们用到的服务面）
    └── *.test.ts           各模块单测 + 一条端到端装配测
```

`package.json` 的目标形态（关键字段）：

```jsonc
{
	"name": "@yandy0725/dsh-memory",
	"version": "0.0.0",
	"private": true,
	"description": "Memory bundle for @deepseek-ai/dsh (cordis): shares one on-disk memory with pi-memory.",
	"license": "MIT",
	"type": "module",
	"engines": { "node": ">=24.9.0", "dsh": ">=0.2.2-rc.1 <0.3.0" },
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }, "./package.json": "./package.json" },
	"files": ["dist/", "src/", "cordis.patch.yml", "README.md", "LICENSE"],
	"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } },
	"scripts": {
		"build": "tsc -p tsconfig.build.json",
		"test": "vitest run", "test:watch": "vitest",
		"typecheck": "tsc --noEmit", "lint": "biome lint .", "format": "biome format --write ."
	},
	"dependencies": { "@yandy0725/memory-core": "^1.1.0" },
	"peerDependencies": { /* 只列 src 里 import type 到的宿主包，范围 >=0.2.2-rc.1 <0.3.0 */ },
	"devDependencies": { /* 同上宿主包，钉 0.2.2-rc.1 精确版本，只为拿类型 */ }
}
```

宿主包钉**精确版本**做 devDependency（照 `docs/guides/dependencies.md` 对 `@earendil-works/*` 的处理）：
0.2.0-rc.2 → 0.2.2-rc.1 已经证明破坏性变更会发生，升级必须当成一次独立变更。

## 5. 逐模块设计

### 5.1 `row-config.ts` —— 唯一的配置层

行 `config:` 的形状 = **core `MemoryConfig` 的白名单子集，键名与 core 逐字一致**（不做
`models.<task>` 之类的翻译层 —— 那样会与 core 的 `taskModel(cfg, task)` 读法分叉，用户也没法在
pi 的 `memory.json` 与 dsh 的行 config 之间照抄）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（profile 级）或 ~/.dsh/cordis.patch.yml（机器级，对所有 profile 生效且优先级更高）
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    # memoryDir: ~/memories                                  # 可选；默认 $XDG_DATA_HOME/simple-memory
    defaults: { model: "deepseek-official/deepseek-flash" }   # dsh 特有："<provider>/<model>"
    autoSurfacing:
      enabled: true
      model: "deepseek-official/deepseek-flash"               # per-task 覆盖 defaults.model
      thinkLevel: "high"                                      # 原样当 reasoningEffort 透传
      maxFiles: 3
```

```ts
/** 允许出现在行 config 里的键（白名单，深度）。不在名单里的键 → 收集成 warning，不静默丢弃。 */
export const ROW_CONFIG_KEYS = { /* memoryDir, lock, memIndex*, sessionSearch, defaults, autoSurfacing, extractMemories, dream */ } as const;

export interface ResolvedConfig { config: MemoryConfig; warnings: string[]; error: string | null }
export function resolveRowConfig(row: unknown): ResolvedConfig;
```

- 合并走 core 的 **`mergeConfig`**（§2.1 新增的导出），再补上 `loadConfigFrom` 最后那步
  `expandTilde(cfg.memoryDir)`：

  ```ts
  const cfg = mergeConfig({ ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() }, row);
  cfg.memoryDir = expandTilde(cfg.memoryDir);
  ```

  这四行与 `loadConfigFrom([])` + overlay 逐字等价，所以适配层**不需要**自己写 deep-merge。
- 仍要一条**等价性测试**钉住它：同一份对象，一条路径走 `resolveRowConfig(obj)`，另一条写进临时
  JSON 文件走 `loadConfigFrom([tmpFile])`，断言两者逐字相等。这不是为了补偿自写的 merge（已经没了），
  而是钉住「行 config 与 pi 的 memory.json 是同一套语义」—— 用户能在两边照抄的前提。
- 白名单外的键**不静默丢弃**：收集成 `warnings`，由 `/memory` 打印（用户写了 `memoryDir` 的拼写错误
  时，静默忽略等于让他以为改了却没生效）。
- 类型校验：只校验「形状与类型」（对象/数组/字符串/正整数），不校验语义；语义错误（模型不可解析）
  由 §5.2 的启动期校验负责。校验失败 → `error` 非空 → 该 session 进错误态（D13）。

### 5.2 `model.ts`

```ts
export interface DshModelRef { provider: string; model: string }
export function parseModelRef(value: string): DshModelRef | null;   // 按第一个 "/" 拆；无斜杠 → null
export type ModuleTask = "autoSurfacing";                            // 本轮只有这一个会跑的任务
export async function resolveModuleAvailability(
	cfg: MemoryConfig,
	llm: { resolveCallConfig(c: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> },
): Promise<{ available: boolean; reason: string | null }>;
```

- **校验集合 = 本轮真会跑的任务**（只有 `autoSurfacing`）：用 §2.1 新增的可选参数
  `modelConfigErrors(cfg, resolve, ["autoSurfacing"])`，**不照抄无参形式**：`requiredModels()` 缺省
  恒包含 `dream`（`memory-core/src/config.ts:129-141` 注释明写「dream 恒在执行集合内」），
  而本轮 dsh 不实现 dream，照抄就会要求用户配一个永远用不到的模型（D13）。
  返回的错误文案直接当降级原因用，不自己拼。
- 三种结果，都不抛给宿主：
  1. 没配模型（`taskModel(cfg, "autoSurfacing") === undefined`）→ `available: false`，
     `reason: "no model configured — set autoSurfacing.model or defaults.model in the plugin row config"`，
     auto-surfacing 静默关闭，索引与工具照常。
  2. 配了但格式不对（无斜杠）→ `reason: 'model "<v>" must be "<provider>/<model>"'`，同上降级。
  3. 配了且格式对，但 `resolveCallConfig` 抛错（`NO_ADAPTER` / `UNSUPPORTED_REASONING_EFFORT` / …）
     → `reason` 带宿主的 `code` 与 message，同上降级。
- `resolveCallConfig` 是 `ctx.llm` 上的**服务方法**（不是宿主模块函数），零宿主 import 也拿得到。
  它至少证明 provider 已注册与 effort 合法。**不做严格模型存在性校验**：`resolveModelInfo` 对未知
  model id 不抛错（DeepSeek adapter 会静默降级），而唯一严格的 `listModels(provider).some(m => m.id === model)`
  是网络发现（5s 超时、10min 缓存），不适合放在启动路径上。
- `thinkLevel` 原样传 `reasoningEffort`，类型用 §2.1 新增的 `EffortLevel`（= `string`），所以配置里写
  DeepSeek 路线的 `"max"` 能过 typecheck。core 运行时本来也不校验它，所以行为与 pi 无差异 → §9 痛点 P2。

### 5.3 `store-registry.ts`

```ts
export interface SessionMemoryRuntime {
	sessionId: string;
	cwd: string;
	config: MemoryConfig;
	/** null = 该会话没初始化成功；原因在 error 里。core 的 getStore() 本来就接受 null。 */
	store: MemoryStore | null;
	memoryDir: string | null;
	error: string | null;
}
export interface StoreRegistry {
	/** agent/created 里 await。**不抛错**：失败也返回一个 store=null 的 runtime（D13）。 */
	prepare(agent: AgentLike, resolved: ResolvedConfig, llm: LlmLike): Promise<SessionMemoryRuntime>;
	/** 同步取用（core 的 MemoryHandlerDeps.getStore() 是同步的）。没 prepare 过 → undefined。 */
	get(sessionId: string): SessionMemoryRuntime | undefined;
	forget(sessionId: string): void;
}
```

- cwd 来源：`ctx.workingDirectory.ensure(agent, signal)`，异常时回退 `agent.session.header.cwd`。
  **解析一次，作为该会话的权威**（与 pi 对等，见 §3 第 10 行）。
- 按 **memoryDir** 复用 `MemoryStore` 实例（同一目录的多个 session 共用一个 store，与 core 的
  进程内互斥 / 变更队列语义一致），按 **sessionId** 建索引；`forget()` 时按目录引用计数，归零才丢。
- 失败路径（配置 error / `resolveMemoryDir` 抛错 / 模型校验降级）都产出 `store: null` + `error`
  的 runtime，让工具能给出可读原因（§5.6）。

### 5.4 `index-cache.ts`

```ts
export interface IndexCache {
	/** 异步刷新；失败保留旧值（section 绝不能因为一次读盘失败而消失）。 */
	refresh(rt: SessionMemoryRuntime): Promise<void>;
	/** section 的 text 回调：同步、永不抛错。没有值 → 空串（该 session 不注入索引）。 */
	read(sessionId: string): string;
	forget(sessionId: string): void;
}
```

- 值 = `buildIndexSection(store, cfg.memIndexInjectMaxLines, cfg.memIndexInjectMaxBytes)`（core 出口，
  已含截断与净化）。`store === null` 时值为空串。
- 刷新时机：`agent/created`（首建）、`memory` 工具成功写入后（`onWrite`）、`/memory` 命令执行后、
  以及**每个 turn 的第 1 个 step 之前**（在 pre-step 监听器里，与召回同一处，成本是一次
  `readIndex`）。最后这条是为了缓解「长会话里看不到别的进程写的记忆」：dsh web app 的会话可以
  连开几天，而共享记忆的前提是别人写的东西最终能看见。**不做 watcher**（跨进程实时性不是本轮判据，
  pi 侧同样只在 compaction 刷新），`/memory` 也给用户一个手动同步入口。
- **不做 pi 那种「整 session 冻结 + 回放录制值」**（`pi-memory/src/index-source.ts`，186 行）：那是 pi
  的 `diffSystemPromptSections` + resume/fork 语义逼出来的；dsh 每个 step 重新 assemble，没有对应问题。
  代价是索引变化会废掉它之后那几段的 KV 前缀（宿主 gotcha：改 system prompt section 会失效一次缓存前缀）
  —— 我们的 section order 在工具段之后，且刷新只在「真的变了」时改变输出，可接受。
  这是**刻意的行为差异**，记进 §9 痛点 P3。

### 5.5 `index.ts` 的装配（section + 生命周期 + 子 agent 门禁）

```ts
export const name = "simple-memory";
export const inject = ["tools", "systemPrompt", "llm", "commands", "workingDirectory", "sessionQuery", "logger"];
export async function apply(ctx: Context, config: unknown): Promise<void> { /* ... */ }
```

- `inject` 里放全部用到的服务：按 `practices.md`，缺服务的 profile 里插件应保持 inactive（fiber
  pending）而不是抛错。`sessionQuery` 必须在列表里 —— D14 的会话搜索要用它。
- 索引 section（全局注册一次，`text` 回调按 `context.agent` 查缓存）：

```ts
ctx.systemPrompt.section({
	name: "memory_index",
	order: 4000,                 // 宿主 SECTION_ORDERS 里未占用（TOOL_SUBAGENT 2800 … TOOLS_SDK 5000 之间）
	interpolate: false,          // 硬要求：正文里出现 {{ 会在渲染时抛错
	text: (context) => indexCache.read(context.agent?.session.id ?? ""),
});
```

  section 文本本体 = core 的 `buildIndexSection` 输出，与 pi 逐字相同（含截断标记），
  前面拼 core 的 `MEMORY_TOOL_SNIPPET`（三通道说明见 §5.6，出现判据见 §2.6）。
- **子 agent 门禁**：`agent/created` 对**每个** agent 都发（子 agent 由 `dsh-subagent` 走
  `ctx.agents.create`，根 ctx 的监听器会看到全部）。不过滤的后果是每个子 agent 都触发一次
  `workingDirectory.ensure` + git 探测 + 建 store，且子 agent 每轮多付一次侧查询。pi 侧同样对子 agent
  跳过 auto-surfacing（靠嗅探 system prompt 里的 `<active_agent name="`）。
  dsh 侧用**结构化判据**而不是嗅探：以 `agent.session.header.origin === "subagent"` 为主判据
  （`delegationDepth` 作辅助），根 agent 才注册工具 / 解析 store / 跑 surfacing。
  **不得用 `parentSession` 做判据** —— 宿主在该字段的文档里明文警告：「Presence alone does not
  classify a Session as a subagent; use `origin` for that distinction」，普通 fork 也可能带
  `parentSession`，误判的后果是该会话整个记忆注入被静默跳过（见 §2.3）。
  索引 section 因为是全局注册、`text` 回调查不到缓存就返回空串，子 agent 自然拿不到索引，无需额外门禁。
- per-agent 注册（`agent/created` 是 serial 且在创建完成前被 await，是唯一的异步窗口）：

```ts
ctx.on("agent/created", async ({ agent, signal }) => {
	if (!isRootAgent(agent)) return;
	const rt = await registry.prepare(agent, resolved, ctx.llm);   // 不抛错；失败 → store=null + error
	await indexCache.refresh(rt);
	const disposeTool = agent.ctx.tools.register(memoryTool(ctx, rt));
	// practices.md 规则 2：agent.ctx 上的注册有两个 owner，disposer 必须也挂进自己的 effect
	ctx.effect(() => () => { disposeTool(); registry.forget(rt.sessionId); indexCache.forget(rt.sessionId); }, "memory/agent");
	if (rt.error) ctx.logger.warn("simple-memory: %s", rt.error);
});
```

- 全部注册都在 `apply` 的 effect 里，`apply` 返回 disposer（cordis 4 **没有** `ctx.on('dispose')`）。
- `apply` 每进程跑一次（配置变更 / HMR 才重跑），所以 per-session 状态一律挂在 agent/session 上，
  不能挂在模块级。

### 5.6 `memory-tool.ts` 与 `commands.ts`

工具（Route A，见 D8）：

```ts
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["content"],
	properties: { content: { type: "string" } },
} as const;

export function memoryTool(ctx: Context, rt: SessionMemoryRuntime): ToolDefinitionLike {
	const handler = createMemoryActionHandler({
		getStore: () => rt.store,                                   // 可以是 null（core 的契约）
		getConfig: () => rt.config,
		getUnavailableMessage: () => rt.error,                      // null = 没有错误
		searchSessions: (cwd, query, cfg) => searchSessions(ctx, cwd, query, cfg),
		cwd: () => rt.cwd,
	}, { actions: MAIN_AGENT_ACTIONS, onWrite: () => void indexCache.refresh(rt) });
	return {
		name: MEMORY_TOOL_NAME,                    // core 出口，与 pi 同名
		description: MEMORY_TOOL_DESCRIPTION,      // core 出口，三通道文案不自己改
		parameters: memoryToolSchema(MAIN_AGENT_ACTIONS),   // 原样透传（register() 不校验）
		output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: "text", text: value.content }] },
		async execute(args, exec) {
			const r = await handler(args);         // 失败靠 throw，宿主转成 isError:true
			return { content: r.text };            // ← 只有 content；details 本轮不进 output（见下）
		},
		isConcurrencySafe: (args) => args?.action === "list" || args?.action === "search",
	};
}
```

- **为什么不把 `details` 放进 output**：core 的 handler 返回的 `details` 里带
  `capacityWarning: string | undefined`（`memory-core/src/tool/handler.ts:111,125`），也就是**绝大多数
  成功写入都带一个值为 `undefined` 的键**；而 dsh 的 `snapshotJsonValue` 拒绝值里**任何位置**的
  `undefined`。顶层条件展开不够，`add` / `replace` 会 100% 变成 `ToolOutputError`。dsh 侧
  `details` 又**没有消费者**（Web 客户端明确忽略 `presentCall` / `presentResult`），所以本轮直接不放。
  仍要有一条单测深度扫描 `execute` 的返回值，断言「任何层级都没有 `undefined`」—— 这条测试是
  真宿主上「每写必炸」与「能用」的分界线。
- 三通道文案（core 出口，措辞与预算由 `scripts/prompt-hygiene.ts` 把关，执行点在
  `pi-memory/tests/prompt-meta.test.ts`）在 dsh 的落点：`description` → 工具 schema（dsh 的
  `ToolSchema` 只有 `{name, description, parameters, deferLoading?}`，`output`/`execute` 等在投影时
  被剥掉）；`promptSnippet` 与 `promptGuidelines` → **都落进索引 section**，顺序为
  snippet → guidelines → 索引正文，出现判据与该 session 是否有 runtime 绑定（**见 §2.6 与 §2.7**）。
  三通道因此全部有落点，§9 痛点 P4 已结案。
- 错误传播：core 的 handler **抛错**表达失败，dsh 也是 throw → `isError: true`，语义天然对齐。

`/memory` 命令：

```ts
ctx.commands.register({
	name: "memory",
	description: "Show memory status, or remove a stale lock with `unlock --force`",
	input: { hint: "[unlock --force]" },
	handler: async ({ agent, rawInput, signal }) => ({ kind: "success", text: await render(agent, rawInput, signal) }),
});
```

- 状态块沿用 pi 的口径，去掉 dsh 本轮没有的行：

  ```
  Dir: <解析出的记忆目录>            ← 必须打印：memoryDir 是 per-harness 配置（D4 推论），
                                        这是用户发现「两个宿主写不同目录」的唯一入口
  Index: <lineCount>/<max> lines, <bytes>/<max> bytes, <n> unrecognized lines
  Inject: <lineCount>/<max> lines, <bytes>/<max> bytes
  Entries: <n>
  Modules: autoSurfacing=on(deepseek-official/deepseek-flash) | autoSurfacing=off(<reason>)
  Lock: free | held by <op> (pid N on <hostname>, started <ISO>) | unreadable — run /memory unlock --force
  Config: <n> warning(s)             ← 仅当行 config 有白名单外的键时出现
  ```

  数字来自 core 的 `indexCapacity` 与 `indexInjectionCapacity`，与真正写入 / 注入共用同一套窗口核心，
  不可能漂移。
- `unlock`：pi 用 `ui.confirm` 弹确认框；dsh 的命令 handler 不在 turn 里，`ctx.approval.request()`
  会直接拒。改为**要求显式 `unlock --force`**，不带 `--force` 时只打印持有者描述与一句
  「确认后加 --force」。语义与 pi 等价（都要一次人的显式确认），且删的仍然只有 `.lock` 本身
  （删除走 core 的 `withFsRetry`，与 pi 同一条路径）。
- 命令 handler 的生命周期照 `dsh-command-compact`：一个 `active` Set + 在自己的 effect 里
  `yield async () => Promise.allSettled(active)`，这样 HMR / 卸载顺序正确。
- 旧数据提示（pi 的 `legacy-hint.ts`）本轮不做：它探测的是 `~/.pi/memory`，属 pi 的历史包袱。

### 5.7 `surfacing.ts` + `headless.ts` —— auto-surfacing

```ts
ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
	const decision = await next();                       // 永远先 await next()
	if (decision.kind === "reject" || signal.aborted) return decision;
	const rt = registry.get(agent.session.id);
	if (rt) await indexCache.refresh(rt);                // 每轮第一个 step 刷新索引（§5.4）
	if (step !== 1 || !surfacingAvailable || !rt?.store) return decision;
	const prompt = humanPromptText(messages);            // 只取 source.kind === "user" 的文本
	if (!prompt) return decision;
	try {
		const selected = await runSideQuery({ ... }, { headless: dshHeadless(ctx) });   // core 出口
		if (selected.length === 0) return decision;
		const content = await renderSurfacedBlock(rt.store, selected, maxEntryBytes, maxInjectionBytes);
		if (!content) return decision;
		markInjected(rt.sessionId, selected);
		const lastClaimed = decision.messages.findLastIndex((m) => messages.includes(m));
		const msg = recallMessage(content, selected.length);
		return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, msg) };
	} catch (e) {
		ctx.logger.warn("simple-memory: auto-surfacing skipped: %s", e);   // 召回是增强，不能拖垮 turn
		return decision;
	}
}, { prepend: true });
```

- 只在 `step === 1` 跑：召回服务的是「这一轮的用户意图」，同一轮里模型自己发起的后续 step 不该再
  付一次侧查询的延迟与 token。pi 那边是 `before_agent_start` + `event.prompt` 存在，等价于「有新用户输入」。
- `{ prepend: true }`：我们的监听器要在 compaction 等其它 pre-step 监听器**之前**跑，这样
  `decision.messages` 已是最终形态，`toSpliced` 的位置才准。
- 永远 `{...decision, messages}` 展开：`startsRequestSeries` 必须存活（`practices.md` 明写），
  并加单测钉住。
- `dshHeadless(ctx)`（`headless.ts`）实现 core 的 `HeadlessAgentPort`，本轮只需支持零工具：
  `ctx.llm.stream({ provider, model, reasoningEffort, messages, system, signal })`，自己累积文本
  （不用宿主的 `BlockAssembler` —— 那是运行时宿主 import）。**累积规则按宿主真实的 chunk 词汇（§2.3 第 4 行）**：
  按 **首次出现顺序**维护缓冲区（与宿主 `BlockAssembler` 一致）—— 首次出现的时机是 **`block-start`**
  （宿主在 `block-start` 与 `ensure()` 里 `order.push(index)`），所以 `block-start` 用来**建立 index 顺序与
  记录 `blockType`**，但不贡献文本；`text-delta` 追加到该 index；`block-end` 一旦设了权威 block 就**冻结该 index**
  （之后的 delta 忽略）；最后按首次出现顺序拼接，**只取 `blockType`（或 block-end 的 `block.type`）为 `text` 的桶**。
  依据：`dsh-llm/lib/index.js:954-1055` 的 `order.push(index)`、`ensure(index, blockType)`、
  `assemble()` 按 blockType 产块、以及 text-delta / block-end 两个分支开头的 `if (partial.block) return;`。
  **不是数值升序**，也**不是覆盖后继续追加**。只取 text 块是必须的：宿主把 `reasoning-delta` 累积成独立的
  `{type:"reasoning"}` 块，若不按 blockType 区分，一个 reasoning 块上的 `text-delta` 会被当成答案输出。
  `tool-call-delta`（含其 `block-end`）、`usage` 一律忽略；`finish` **只记录不 break**，读到流尽后在循环外裁决
  （两个 first-party 一次性调用都这么写：`dsh-session-title-llm/lib/index.js:209-217`、
  `dsh-experimental-translator/lib/index.js:741-757`）。**不 break 是硬要求**：`for await` 提前退出会隐式
  `await iterator.return()`，而宿主 `adapterStream` 的 `finally`（`dsh-llm/lib/index.js:2381-2384`）在
  `completed === false` 时会 `await close()`，而方法注释把 cleanup 失败归在 "remain thrown" 那一半 ——
  一次成功调用可能因此丢掉有效文本，或因 cleanup 挂住而无上限挂死（此时 `timeoutMs` 已用完）。
  `builtinTools: "none"` → `tools` 字段直接不给；`memoryTool: null`；
  收到 `builtinTools: "file-io"` 或 `memoryTool !== null` 的请求 → 返回 `null`（本轮不支持，
  下一轮 extract / dream 才实现），**不抛错**。
  `null` 的语义要保住：宿主拒绝（`NO_ADAPTER` / `AUTH` / …）或 `signal.aborted` → `null`
  （core 靠它区分「跑了没选出来」与「根本没跑」）。
  **但失败有两条通道，必须都覆盖**（见 §2.3）：adapter 选择/派发/迭代失败被宿主转成**终止
  chunk**（`{type:"finish", reason:{kind:"error"|"aborted", failure}}`）而不是抛错，只有
  middleware / nested-call / cleanup / consumer 失败才真的抛。只包 try/catch 会漏掉前者。
循环内每个 chunk 还要先 `signal?.throwIfAborted()`（两个 first-party 消费者都这么做），否则一个不理会
  signal 的流会让调用超过 `timeoutMs`。
- 召回消息的形状（`dsh-llm` 的 `UserMessage`）：

```ts
{
	role: "user",
	id: randomUUID(),                                    // createUserMessage 也只是 mint 一个 id
	content: [{ type: "text", text: content }],          // content 已含 <relevant_memories> 包裹标签（core 生成）
	source: { kind: "simple-memory", form: "notice", summary: `Recalled ${n} ${n === 1 ? "memory" : "memories"}` },
}
```

  - `MessageSourceMap` 是可合并扩展的，没有 catch-all 的 `'plugin'` kind，所以用自己的 kind
    （first-party 先例：`'agent-instructions'` / `'time-context'` / `'working-directory'` / `'runtime-context'`）。
  - **不能** `session.append()` 一个新的 event `type` —— 那样 session 会拒绝重新打开。
  - `form` 选 `"notice"` 而不是 `"snapshot"`：pi 那边是 `display: false` + 一行
    `notify("Recalled: N entries")`，即**正文对用户不可见、只给一行提示**。dsh 里 `snapshot` 会把
    sections 展开在会话里，`notice` 只显示 `summary`（受 `CONTEXT_SUMMARY_MAX_CHARS = 120` 约束），
    是最接近 pi 的形态。**前提**：`form` 只影响渲染与归属，`content` 里的完整
    `<relevant_memories>` 仍然进模型消息 —— 这一点必须由单测钉住（断言消息的 `content` 含完整正文，
    而 `source.summary` 是短摘要）。若实测发现 `notice` 会让正文不进模型，则退回 `snapshot`
    并接受「正文在 UI 里展开」这个差异（记进 §9 痛点清单）。
- 会话内去重：`Map<sessionId, Set<file>>`，与 pi 的 `injectedFiles` 同语义。清理时机：`agent/disposed`。
  pi 在 compaction 时清空（因为压缩会把已注入内容挤出上下文）；dsh 侧本轮**不清** —— 观察宿主的
  compaction 需要额外订阅 `dsh-compaction-basic`，而漏清的后果只是「本会话不再重复召回同一条」。
  记进 §9 痛点 P6，下一轮和 extract 一起做。
- 失败一律静默跳过（与 pi 一致）+ 一行 `ctx.logger.warn`。

### 5.8 `session-search.ts`

出口签名由 core 固定：`searchSessions(cwd, query, cfg): Promise<string>`（返回**已格式化好的文本**）。

- 实现（D14）：`ctx.sessionQuery.filterSessions([{ kind: "cwd", values: [cwd] }], signal)` 拿该项目的
  会话（**裸数组**，newest-first）→ 取前 `cfg.maxSessions`（默认 10，因宿主 newest-first 所以是「最近 N 个」）
  → 对每个 session 用 `readSession(id)` 拿解码后的完整 events（`SessionLogSnapshot`，一次调用返回全量，
  不需要分页；不要改用已废弃的 `session.snapshotEvents()` / `eventAt()`）
  → 自己写文本抽取（宿主的 `extractSessionEventText` 是宿主模块导出，运行时 import 不到）：
  **只抽四类** —— `user/message` 取 `data.content`、`assistant/message` 取 `data.message.content`、
  `tool/call` 取 `data.name` + `data.arguments`（宿主的 `arguments` 已经是模型原样产出的 JSON **字符串**，
  不要再 `JSON.stringify` 一次）、`tool/result` 取 `data.message.content` + `data.error?.name`/`data.error?.code`；
  **其余类型一律贡献空串**。特别地，`todo/write` 与 `turn/end` 虽然在宿主自己的抽取器里，但 pi 不搜它们，
  为了跨宿主同语义（D14）这里也不搜。
  → 每个命中输出 `## Session <id 或标题> (<日期>)` + `…matched: "<片段>"…` + 前后各 50 条消息的
  上下文窗口 → `cfg.maxMatches`（默认 5）封顶 → 整体截到 2000 行 / 50KB（口径对齐 pi 的
  `truncateHead`，用 core 的 `truncateForInjection` 实现同样效果）。
- **只搜真人发言：`user/message` 按 `source.kind === "user"` 白名单过滤**（实现期修订，见 §2.4）。
  宿主大多数 `user/message` 是它自己或其他插件注入的合成消息（`agent-instructions`、`runtime-context`、
  `time-context`、`skill-invocation`、`skill-catalog`、`working-directory`、`goal`、`plan-mode`、
  `subagent-settled` …），把它们搜出来等于把噪声当用户说过的话。**用白名单而不是黑名单**：
  宿主的 `MessageSourceMap` 是可合并扩展的，黑名单结构上不可能完备，而漏一项的后果是
  静默降级搜索精度。白名单的失败模式（宿主改了 kind 名 → 搜索返回空）比黑名单的
  （静默搜出噪声）更容易被发现。完全没有 `source` 的 `user/message` 归为非真人
  （宿主把 `source` 定为必填，这只是防御）。
- 无命中返回 `"No matches in sessions."`（与 pi 逐字相同）。
- 失败不得抛错：`filterSessions` / `readSession` reject（包括 `SESSION_QUERY_SEARCH_DISABLED`，
  即用户从未启用宿主 FTS 时得到的结果）→ 返回
  `"Session search is unavailable in this host configuration: <message>"`。工具调用的失败应该让模型
  看见原因，而不是变成 `isError`。
- 纵深防御：拿到结果后再按 `header.cwd === cwd` 过一道。宿主的 `cwd` 过滤已经做了这件事，
  但万一它哪天松了，失败模式是静默扫最近 10 个会话（**跨项目**）并当作本项目结果展示。

## 6. 仓库集成

| 位置 | 改动 |
|---|---|
| `memory-core/src/config.ts` | §2.1 的三个加法：导出 `mergeConfig`（把私有 `deepMerge` 提出来，`loadConfigFrom` 改用它）、`export type EffortLevel = string` + `ThinkLevel` 改为它的别名、`requiredModels` / `modelConfigErrors` 加可选 `tasks` 参 |
| `memory-core/src/index.ts` | 导出 `mergeConfig` 与 `EffortLevel`（`ThinkLevel` 已在导出列表里） |
| `memory-core/tests/config.test.ts` | 新增用例：`mergeConfig` 与现有合并语义逐字相等（含 `undefined` 跳过、数组整体替换、`null` 子树原样带入）；`tasks` 参传与不传的行为；缺省路径零差异 |
| `memory-core/package.json` | 版本 1.0.1 → **1.1.0**（发布时机见 §7） |
| `memory-core/README.md` / `README.zh.md` | `## Adapting to a new harness` 一节补上三个新出口的用途（它们是给适配层用的，属包的门面） |
| 根 `vitest.config.ts` | `projects: ["memory-core", "pi-memory", "dsh-memory"]` |
| `scripts/check-host-deps.mjs` | `HOST_PROVIDED_PACKAGES` 加 `@deepseek-ai/*`（它的正则会扫到 `import type`，所以只要源码里出现就必须声明成 peer）；新增一条规则：dsh 系宿主包的 peer 范围必须是 `>=0.2.2-rc.1 <0.3.0`。**注意**它的 `collectSourceFiles` 只看 `index.ts` + `src/`，dsh-memory 的入口是 `src/index.ts`，正好被覆盖 |
| 根 `README.md` / `README.zh.md` | 表格里 dsh-memory 那行去掉「Placeholder — not implemented」，写清本轮交付的四件事与「extract/dream 未实现」；`## Development` 里「`dsh-memory` 没有代码所以没有 test 脚本」那句要删；`## Shared data root` 一节补一句「`memoryDir` 是 per-harness 配置：覆盖了就要在两个宿主里都覆盖」 |
| `docs/guides/architecture.md` | 三个 workspace 表格里 dsh-memory 那行从「占位 / 无代码」改成实际职责；「公开 API 只从 `src/index.ts` 出」那节补一句 dsh-memory 同样遵守 |
| `docs/guides/dependencies.md` | 新增一节：dsh 宿主包的处理（peer + devDep 钉精确版本 + 为什么零运行时 import + 为什么不导出 schemastery `Config`） |
| `dsh-memory/README.md` | **重写**：现在那份「dsh APIs this will bind to」是对着 0.2.0-rc.2 写的，`ctx.subagents.start(name, request)`、「参数用 schemastery DSL」、「`ctx.storage` 做数据根覆盖」、「`ctx.logger` 对应 pi 的 `ctx.ui.notify`」四处已失效（见 §3）。改成实际实现的样子 + 安装（§7.1 的一条命令）+ 行 config 说明（中文，照 `dsh-web-fetch-http-fakeip` 的 README 风格） |
| `.github/workflows/test.yml` | `test` job 已经跑 `npm run typecheck/lint/test --workspaces`，自动覆盖；**新增**一步 `npm run build -w dsh-memory`，确保 `dist` 真能构建出来，并断言 `grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` 零命中（D2 的执行点；**只 grep `.js`** —— `.d.ts` 里出现宿主类型是合法的，已实测：type-only import 在 `.js` 里 0 命中、在 `.d.ts` 里 4 命中） |
| `.github/workflows/publish.yml` | 本轮不动（D11：先不发布） |

## 7. 验证计划

**阶段划分**（发布是本轮唯一的不可逆动作，排在单测全绿之后）：

1. **阶段 A**：core 1.1.0 的三个加法 + 测试；dsh-memory 全部代码与单测。仓内解析走 alias/paths
   指到 `../memory-core/src/index.ts`（同 `pi-memory` 的做法），所以这一阶段**不需要** core 已发布。
2. **阶段 B**：发布 core 1.1.0（按 `docs/guides/release.md`，待用户批准）。
3. **阶段 C**：真宿主端到端验证（§7.2 第 8–11 步）—— pnpm 从 registry 拉 `^1.1.0`，所以必须等阶段 B。

### 7.1 安装、开发回路与卸载（已核实，不需要手工改 profile manifest）

```sh
# 装：一条命令。pnpm 装包 + 自动把包名写进 profile 的 dsh.profile.bundles + 应用 bundle 的 cordis.patch.yml
npm run build -w dsh-memory
dsh plugin --profile web add file:/home/yandy/workspace/pri/simple-memory/dsh-memory

# 改代码后的开发回路：只需重新 build + 重启 dsh（profile 的 patchReload 是 live，
# 但换 JS 模块世代要重启 —— 宿主文档：「replacing an installed package requires restart」）
npm run build -w dsh-memory      # 然后重启 dsh

# 卸：一条命令，同时摘掉 dependencies 与 bundles 两处
dsh plugin --profile web remove @yandy0725/dsh-memory
```

**建造者要先核实的一件事**（不影响设计，只影响开发回路的措辞）：pnpm 对 `file:` 目录依赖是
**symlink** 还是**拷贝/硬链**。用户自己那份 `dsh-web-fetch-http-fakeip/README.md` 记的是「本地目录
（软链，改完重启即生效）」，若成立则上面的回路就是「build + 重启」；若实际是拷贝，则每次改代码要
重装一次（`dsh plugin --profile web add file:...` 再跑一遍），README 的安装章节要照实写。
核实方式：装完之后 `ls -l ~/.dsh/profiles/web/node_modules/@yandy0725/dsh-memory`。

### 7.2 步骤

| # | 命令 / 动作 | 通过标准 |
|---|---|---|
| 1 | `npm ci && npm run typecheck && npm run lint` | 全绿（含新 workspace） |
| 2 | `npm run check:host-deps` | PASS（`@deepseek-ai/*` 只在 peer + dev，不在 dependencies） |
| 3 | `npm test -w dsh-memory` | 新测试全绿 |
| 4 | `npm test -w memory-core` / `-w pi-memory` | 与改动前**同口径**（core 一行没动，pi-memory 一行没动，应零差异） |
| 5 | `npm run build -w dsh-memory` | `dist/` 有 `.js` + `.d.ts` + maps；`grep -rn "@deepseek-ai" dist --include="*.js"` **零命中**（`.d.ts` 里命中是合法的，不算失败） |
| 6 | 假 ctx 端到端测：装配 → `agent/created` → 索引 section 的 `text()` 返回非空 → 调 `memory add` → 磁盘上出现 entry 文件与索引行 → 再 `text()` 能看到新行 | 全链路在单测里跑通，不依赖真宿主 |
| 7 | **共享性验证**（本设计的成功判据）：用 pi 会话（或 pi-memory 的 store 路径）写一条记忆到默认根，再用假 ctx 的 dsh 装配读同一个 memoryDir | 索引与 entry 逐字一致 |
| 8 | 真实 dsh：按 §7.1 装进 `web` profile → 启动 → 会话里看到 `memory_index` 段、`memory` 工具可调用、`/memory` 打印状态块 | 三样都在 |
| 9 | 真实召回：在有一定 entry 数量的项目里发一轮消息（需先在行 config 里配 `autoSurfacing.model`） | 该轮上下文里出现 `<relevant_memories>`，UI 上只显示一行 `Recalled N memories` 摘要，`ctx.logger` 无 warn |
| 10 | 与 pi 交叉：dsh 会话写的记忆，pi 会话 `/memory` 能看见（Entries 数一致） | 双向共享成立 |
| 11 | 卸载：`dsh plugin --profile web remove @yandy0725/dsh-memory` → `~/.dsh` 的 git diff 回到验证前 | 无残留（`dependencies` 与 `dsh.profile.bundles` 两处都被摘掉） |

第 8–11 步会真的调用模型（花 token），且会改动 `~/.dsh/profiles/web`（用户已批准用这个 profile；
`~/.dsh` 本身是 git 仓库，改动可 diff 可回滚）。

## 8. 风险与回滚

| 风险 | 处理 |
|---|---|
| 宿主 API 在 rc 之间继续变（0.2.0-rc.2 → 0.2.2-rc.1 已经变了三处） | `engines.dsh` 版本门（D10）让不匹配的宿主**在 import 之前**就拒绝；devDependency 钉精确版本，升级当独立变更 |
| core 1.1.0 发布顺序错乱（dsh 先装、core 还没上 registry） | §7 的阶段划分把发布卡在真宿主验证之前；`publish.yml` 靠 tag 前缀区分 workspace，`memory-core-v1.1.0` 只发 core；发布验收不看 workflow 绿，按 `docs/guides/release.md` 的三步轮询 registry |
| 零宿主 import 导致不能用 `defineTool` / `createUserMessage` / `BlockAssembler` / `extractSessionEventText` | 四处都有等价的手搓写法（§5.6 / §5.7 / §5.8），且都有 first-party 先例（MCP 客户端手搓 `ToolDefinition`）。手搓的代价是失去宿主的参数校验 → core 的 handler 本来就会抛「`name` is required for add」这类错，够用 |
| `output` 返回值里混进 `undefined` → `ToolOutputError`（**每写必炸**） | output 只放 `content`（§5.6）+ 一条深度扫描的单测 |
| 索引 section 的 `text` 回调抛错 → 整个 system prompt 组装失败 | `IndexCache.read` 契约是**永不抛错**，没有值就返回空串；刷新失败保留旧值 |
| `{{` 出现在记忆正文里 → 渲染抛错 | `interpolate: false`（D7）+ 单测：正文含 `{{x}}` 时 section 原样输出 |
| 一个进程多个 session（web app）导致 store 串目录 | D9 的 per-agent 注册 + per-session registry；单测覆盖「两个不同 cwd 的 agent 各自写各自的目录」 |
| 子 agent 也挂上记忆 → 每个子 agent 一次 git 探测 + 每轮一次侧查询 | §5.5 的根 agent 门禁 + 一条单测 |
| 侧查询给每一轮加延迟与 token | 只在 `step === 1` 跑；没配模型时静默降级为关（D13）；失败静默跳过 |
| pre-step 监听器把别人的 decision 弄丢 | 永远 `await next()`、永远 `{...decision, messages}` 展开，单测钉住 `startsRequestSeries` 存活 |
| `form: "notice"` 万一让正文不进模型 | §5.7 的单测钉住「content 含完整正文」；不成立则退回 `snapshot` 并记录差异 |
| 自写 deep-merge 与 core 的语义漂移 | §5.1 的等价性测试（同一份对象，两条路径，逐字相等） |
| 装进用户 profile 后留下垃圾 | §7.2 第 11 步：一条 `remove` 命令（宿主同时摘 `dependencies` 与 `bundles`）+ `~/.dsh` 的 git diff 回到验证前 |
| 回滚 | core 侧只有三个加法 API（未发布前 = 一个 commit，`git revert` 即可；已发布后也不影响任何现有用户，因为无人被迫升级）；pi-memory 一行未改。所以回滚 = 删掉 `dsh-memory/src`+`tests`、把根配置与文档的 6 处改动 revert、revert core 那个 commit。数据面零风险：dsh 写的就是 pi 已经在写的那份目录与格式 |

## 9. core 痛点清单

P1 / P2 / P11 已定为**本轮就修**（core 1.1.0 的三个加法，见 §2.1），表里给出修法；其余八条只记不改，
作为下一次 core 重构 spec 的输入。

| 编号 | 接缝 | dsh 撞上的具体事实 | 本轮的处置 | 建议方向 |
|---|---|---|---|---|
| **P1** | `loadConfigFrom(files)` 只接受**文件列表**，`deepMerge` 是私有函数 | dsh 的唯一配置层是内存里的行 `config:` 对象，没有文件 | **本轮修（§2.1）**：core 导出纯函数 `mergeConfig(base, overlay)`，并让 `loadConfigFrom` 内部改用它（合并语义只有一份）。dsh 侧因此不需要自写 deep-merge | **下一轮**：按用户定的「core 只提供默认值、不管理配置」把文件 IO 也下放 —— `loadConfigFrom` 标记废弃或移除，适配层自己读文件再调 `mergeConfig`（对 pi-memory 是破坏性变更，要走独立 spec） |
| **P2** | `ThinkLevel` 是 pi 的闭枚举（`off\|minimal\|low\|medium\|high\|xhigh`） | dsh 的 DeepSeek 路线合法档位是 `off\|low\|high\|max` —— **`max` 在 core 的类型里表达不出来**；pi-ai 路线又是另一套（含 `xhigh`）。合法值在 dsh 里是 **per-route 的数据**，不是枚举 | **本轮修（§2.1）**：新增 `export type EffortLevel = string`，`ThinkLevel` 降为它的别名；已核实 pi-memory 的 typecheck 不受影响（它交给 SDK 的边界本来就是 cast） | **下一轮**：配置**键名** `thinkLevel` 也是 pi 词汇（dsh 叫 `reasoningEffort`），但它是用户契约，改名要迁移说明；与 P6（`sessionPersistence`）、P7（`MEMORY_TOOL_LABEL`）一起做 |
| **P3** | 索引注入的「异步刷新 + 同步读」缓存没有抽象 | pi 用 186 行（`index-source.ts`）实现冻结 + 回放录制值；dsh 因为 `section.text` 必须同步，也要一份同样的缓存，但刷新时机完全不同 | 适配层各写一份 | core 提供 `createIndexSnapshot({ refresh, read })`，把「刷新时机」留给适配层，把「截断 + 净化 + 空值语义」收进来 |
| **P4** | 三通道文案（`description` / `promptSnippet` / `promptGuidelines`）假设宿主有三个落点 | dsh 的 `ToolSchema` 只有 `{name, description, parameters, deferLoading?}`，`output`/`execute` 等在投影时被剥掉 → 宿主侧只有 `description` 一个模型可见通道 | **已解决（实现期，见 §2.6 与 §2.7）**：三个通道全部落地 —— `description` 进工具 schema，`promptSnippet` 与 `promptGuidelines` 进 `memory_index` section | ~~需要实测~~ —— 本条原记的理由（「guidelines 没有落点」）已被 §2.6 自己推翻：既然 section 是一个可用的模型可见通道且 snippet 已落在那里，guidelines 同样能落，且不需改 core、不需改 prompt 文本。**剩下的真问题不是落点而是预算**：三通道共 1723 字符（description 522 / snippet 58 / guidelines 1143），而 pi 的三通道预算是 2750；若将来要缩，应作为一个独立的 prompt 预算决策来做（属用户契约，要独立 spec） |
| **P5** | 宿主想要 schema 化的配置（dsh 的 schemastery `Config`、pi 的 typebox），而 core 的配置是纯 JSON | 导出 `Config` 就要运行时 import `@deepseek-ai/schemastery`，与「零宿主 import」冲突 | 不导出，自己校验行 config，放弃免费 Settings UI | core 提供一份**纯 JSON Schema** 的配置描述（就像 `memoryToolSchema()` 那样），由适配层转成宿主的 schema DSL |
| **P6** | `SessionPersistenceConfig` 是 pi `AgentSession` 的旋钮，却出现在共享配置契约与 `HeadlessRunRequest` 里 | dsh 没有对应旋钮，只能忽略 | 忽略 | 挪进「宿主自有扩展位」（如 `host?: Record<string, unknown>`），共享契约里只留中立字段 |
| **P7** | `MEMORY_TOOL_LABEL` 的注释自己写着「pi 的 UI 标签…其他宿主没有对应通道时忽略即可」 | dsh 的工具没有 label 通道（`presentCall` 是 Host-local、Web 客户端明确忽略） | 不用 | 标注为 pi 专属，或从 core 公开面移走 |
| **P8** | `MemoryHandlerDeps.getStore()` 是同步的 | dsh 的 memoryDir 解析必须异步（`resolveMemoryDir` 要探 git remote），而同步窗口只在工具执行那一刻 | 用 `agent/created`（serial + 被 await）提前解析并缓存 | 保持不变即可 —— 这是**好**的约束（它逼出了 D9 的 per-agent 注册）。记录在此是为了说明它不是缺陷 |
| **P9** | `neutrality.test.ts` 只查 import 说明符与仓内坐标，**不查词汇** | P2 / P6 / P7 这类 pi 词汇泄漏今天没有任何门禁拦得住 | 无 | 加一条词汇扫描（core 的 `src/**` 里出现宿主专有名词就红），或改成「公开面上每个宿主味符号必须有中立替代」的清单测 |
| **P10** | core 假设「一个会话一个固定 cwd」（`resolveMemoryDir(cfg, cwd)` 调一次） | dsh 的 cwd 运行期可变（`ctx.workingDirectory.set()` + durable `working-directory/change`），且 web app 会话的初始 cwd 往往是通用 default-workspace 而不是项目目录 | `agent/created` 时解析一次当作会话权威（与 pi 对等），`/memory` 打印 `Dir` 让用户能发现不一致 | 下一轮（extract / dream）之前重新评估：要不要支持「cwd 变化 → 换 store」，以及 default-workspace 这种「不是项目」的 cwd 该落到 `local/<escaped-path>` 的哪个键上 |
| **P11** | `requiredModels()` 恒包含 `dream` | dsh 本轮不实现 dream，照抄就会要求用户配一个永远用不到的 `dream.model`，否则整个记忆层是暗的 | **本轮修（§2.1）**：`requiredModels` / `modelConfigErrors` 各加一个可选 `tasks` 参，缺省行为逐字不变；dsh 传 `["autoSurfacing"]`。「失败只降级该模块而不进全局错误态」仍是适配层的职责（D13） | 无（修完即毕）。可考虑进一步把「适配层实现了哪些任务」变成注册式声明，但那要等第三个宿主出现才知道对不对 |
| **P12** | `runSideQuery` 把三种语义完全不同的结果压成同一个 `[]` | `orchestration/surfacing.ts:49-67`：`try { … if (result === null) return []; return parseSelectedFiles(…) } catch { return [] }` —— 宿主拒绝/超时、「跑了但没选中」、抛错，对适配层完全不可区分。后果：适配层无法向用户或日志报「召回失败了」，只能静默当「没相关记忆」。pi-memory 同样受此限制（它的 catch 只能包住自己的代码） | 本轮不改（只记录）。dsh 侧的 `deps.warn` 因此只能盖住 `scanEntries` / `renderSurfacedBlock` 这类适配层自己的失败 | 返回 `{ selected, outcome: "ok" \| "skipped" \| "error" }`，或让端口错误上抛由适配层决定。注意这是**行为**变更，会影响 pi-memory 的现有用例，要走独立 spec |
| **P13** | `MemoryHandlerDeps.searchSessions(cwd, query, cfg)` 的签名里**没有 signal**，适配层想传也传不了 | `memory search scope=sessions` 跑在工具的 `execute` 里，一次可能读多达 10 个 zstd 解码的完整会话日志（`session-search.ts:184-201`），而它**完全不可取消**：`memory-tool.ts` 只能忽略 `exec.signal`。这也与宿主文档冲突：`dsh-tools/lib/types/contracts.d.ts:28-31` 要求「Async work must observe or forward `exec.signal` and settle only after its owned work reaches quiescence」 | 本轮不改。影响是**有界**的（确实会 settle，不会挂死），后果仅是 Esc 之后浪费一些 CPU/IO，与 P12 不同量级 | 给 `searchSessions` 加可选 `signal?: AbortSignal`（TS 的参数双变性使 pi-memory 现有的三参实现仍可赋值，所以是纯加法），并把 `exec.signal` 从 `createMemoryActionHandler` 透传下来。**应与 P12 一起设计** —— 两者都是「core 的端口签名缺少适配层需要的取消/结果词汇」，分两次改同一处签名是浪费 |

## 10. 备选方案（已排除）

**A. 把 `dependencies` 写成 `file:../memory-core`（而不是 registry 的 `^1.1.0`）。**
改 core 立刻生效、不用发版。排除原因：pnpm 会把 profile 之外的目录 link 进 profile，装出来的形状
与用户真正拿到的不一样（用户只能从 registry 装）。注意这与**开发时的仓内解析**不是一回事：
`vitest.config.ts` 的 `resolve.alias` 与 `tsconfig.json` 的 `paths` 指到 `../memory-core/src/index.ts`
（同 `pi-memory` 的做法，迁移设计 D6），所以阶段 A 能在未发布的 core 源码上开发与测试，
而 `package.json` 里写的仍是用户将来真会装到的那个 range。

**B. 纯 JS + JSDoc，零构建（照本机已有的 `dsh-web-fetch-http-fakeip` 插件）。**
零构建、`file:` link 改完重启即生效。排除原因：宿主是快速变动的 rc，光 0.2.0-rc.2 → 0.2.2-rc.1
就改了 `system-prompt/assemble` 的 payload、`PromptContext` 的字段、`agent/pre-step` 的
`modelSelection`；没有类型检查等于把这些破坏全留到运行时。本仓 CI 的 `typecheck` 也覆盖不到它，
core 的 `.d.ts` 白给。

**C. 用 `defineTool` + 把 core 的 JSON Schema 转成 `ParameterSchemaSpec`（Route B）。**
能拿回宿主的参数校验与 TS 推断。排除原因：`defineTool` 是宿主运行时 import（与 D2 冲突），
而 Route A 已有 first-party 先例（MCP 客户端）；且 Route A 让模型看到的线格式与 pi **逐字相同**
（`parameters` 原样透传，不经任何转换），这对「两个宿主同一份契约」是可验证的强性质。
Route A 失去的参数校验由 core handler 自己的必填检查兜住。

**D. 一次做完全量对齐（含 extract / dream）。** 排除原因：extract / dream 需要在 dsh 上**新造**
一个「一次性受限工具子会话」（`ctx.agents.create()` + `tools.restrict()` + `concludeTurn()`），
还要处理 5 秒硬退 vs 10 分钟 dream 的锁残留。这块的风险与验证成本独立成一刀，混进来会拖累
「共享记忆」这个主判据的落地。

**E. 用 `agent.inject()` 做召回。** 排除原因：`inject()` **不唤醒** agent，落点是「下一个被 admit
的 step」，召回会与它要服务的那一轮错位；`practices.md` 把它定位成「加 per-agent 上下文」，
而我们要的是「插进本轮 step 的消息序列并控制位置」，那是 `agent/pre-step` 的能力。

**F. 跨 harness 的共享配置文件（`$XDG_CONFIG_HOME/simple-memory/config.json`）+ 宿主文件 + 行 config
三层。** 曾是本文档的 D4 初版。排除原因：用户明确改为「配置只有一层，即宿主的配置；core 只提供
默认值，不管理配置」。三层会让「用户改了哪一层才生效」变成需要解释的东西，而共享层还带来
「pi 侧今天不读它」的空窗。

**G. 打开宿主的 SQLite 全文搜索（bundle patch 覆盖 `session-query-sqlite` 行）。** 能力最强。
排除原因：它改的是**宿主全局**行为（行配置整体替换，要重述 `path`），会给所有 session 建一份持久
SQLite 索引（磁盘与隐私面），而且会让 dsh 的召回强于 pi —— 同一份记忆在两个 harness 里搜出不同
结果，与「行为一致」的目标相冲。

## 11. 留给建造者的部分

- 各模块内部的文件顺序、注释措辞、假 ctx 的组织方式（沿用 `pi-memory/tests` 的风格即可）。
- 根 agent 判据的确切字段名已定（见 §2.3 与 §5.5）：以 `session.header.origin === "subagent"` 为主，
  `delegationDepth` 为辅；**不得用 `parentSession`**。
- `/memory` 状态块的确切行序与措辞（§5.6 给的是口径，不是逐字文案）。
- 单测的具体用例切分，但下列几条是**必须**有的：
  1. `dist/` 里零 `@deepseek-ai` 命中（D2 的执行点）—— **这一条落在 CI 而不是单测**（它需要先 build，见 §6 的 `.github/workflows/test.yml` 行）；§11 旧版把它列为单测是错的，已修正；
  2. `interpolate: false` 下正文含 `{{x}}` 原样输出；
  3. `execute` 的返回值**深度**无 `undefined`；
  4. 两个不同 cwd 的 agent 各写各的目录；
  5. 子 agent 不注册工具、不解析 store；
  6. pre-step 返回值保住 `startsRequestSeries`；
  7. 侧查询宿主拒绝时 `headless.run()` 返回 `null` 而不是抛错；
  8. 行 config 的 deep-merge 与 `loadConfigFrom` 逐字相等；
  9. 没配模型时 auto-surfacing 关闭、但索引 section 与 `memory` 工具仍可用；
  10. 召回消息的 `content` 含完整 `<relevant_memories>` 正文，`source.summary` 是短摘要。

## 12. 待用户确认

**无。** 四条开放问题全部已确认或已核实：

| 编号 | 问题 | 结论 |
|---|---|---|
| OQ1 | `search scope=sessions` 怎么实现（宿主的 FTS 默认关） | 用户选 **(a) 自己扫，对齐 pi 的行为** → D14 |
| OQ2 | auto-surfacing 在 dsh 侧的默认行为 | 用户选 **没配 model 时静默降级为关**（不让整个会话进错误态）→ D13 |
| OQ3 | 端到端验证装哪个 profile | 用户选 **装进现有 `web` profile**（`~/.dsh` 是 git 仓库，改动可 diff 可回滚）→ §7.2 第 8–11 步 |
| OQ4 | 安装路径（建造者提出：`dsh plugin add` 声称不写 `dsh.profile.bundles`） | **建造者的判断有误，已核实**：`dsh-plugin-manager/lib/types/operations.js:101-135` 在包管理操作后 reconcile bundles 并写回 manifest，一条 `dsh plugin add` 就够；用户 profile 里的 `dsh-web-fetch-http-fakeip` 是活证据 → §7.1 |

配置层的决定在对话中被用户改过一次，最终形态见 D4/D5（**只有一层：宿主的行 config；没有跨 harness
的共享配置文件；core 只提供默认值**），被排除的三层方案记在 §10 备选方案 F。

## 13. 建造者审阅的处置

一个没参与过对话的建造者读了本文档的早期版本并提出 11 条问题。处置如下（「已答」= 对话或项目里
已有答案，已写进文档；「my call」= 建造者能自己定的，我定了并标注；「用户的」= 只有用户能答）。

| # | 建造者的问题 | 处置 |
|---|---|---|
| 1 | 模型校验的任务集合（`requiredModels()` 恒含 dream）+ 开箱无配置时的行为 | **已答**：用户定了「没配 model 静默降级为关」→ D13；校验集合收窄成本轮真会跑的任务 → §5.2；并记为痛点 **P11** |
| 2 | 两个宿主读的不是同一份配置文件，共享判据可能落空 | **已答（用户的决定推翻了前提）**：配置只有一层、各宿主自己的（D4/D5），不存在共享配置文件。共享判据随之收窄为「默认 `memoryDir` 下共享」，并把「覆盖了 `memoryDir` 就要两边都覆盖」写进 §1、`/memory` 的 `Dir` 行与 README |
| 3 | memoryDir 的 cwd 权威：一次性解析 vs 跟随运行期变化 | **my call**：`agent/created` 时解析一次当作会话权威（与 pi 对等），不订阅 `working-directory/change`；`/memory` 打印 `Dir`。记为痛点 **P10**（dsh 的 cwd 可变、web 会话初始 cwd 常是 default-workspace，下一轮必须重估） |
| 4 | 子 agent 要不要挂记忆（文档完全没提） | **my call**：只挂根 agent（D9 + §5.5 的门禁与理由）。判据的确切字段名留给建造者从 `SessionHeader` 确认 |
| 5 | 安装/挂载方式：文档给的命令不足以让插件被加载（声称 `dsh plugin add` 不写 `dsh.profile.bundles`） | **建造者的判断有误，已核实并纠正**：`operations.js:101-135` 在包管理操作后 reconcile 并写回 bundles，`reconcileProfilePlugins` 的文档原文是「New bundle dependencies activate automatically」，用户 profile 里已装的那个插件就是这条路径的产物。一条命令即可 → §7.1；剩下唯一要建造者实测的是 pnpm 对 `file:` 目录是 symlink 还是拷贝（只影响开发回路措辞，不影响设计） |
| 6 | 配置失败时工具到底注册不注册（D13 与 §5.3/§5.6 互相矛盾） | **my call**：照 pi 的语义 —— 工具**仍注册**，`store` 为 `null`，走 core 的 unavailable 分支给出可读原因。`SessionMemoryRuntime.store` 的类型改为 `MemoryStore \| null` 并加 `error` 字段（§5.3），矛盾消除 |
| 7 | OQ1 之外：能力差要不要暴露给模型 | **已答**：用户选 (a) 自己扫 → D14。`inject` 保留 `sessionQuery`。宿主 FTS 方案连同其授权问题一起进 §10 备选方案 G |
| 8 | `details.capacityWarning` 是 `string \| undefined`，顶层条件展开不够；且代码片段里 `text` 与 `content` 不一致 | **my call（建造者指出的是我的错误，已修）**：output schema 只留 `content`，`execute` 返回 `{ content: r.text }`，`details` 本轮不进 output（dsh 侧无消费者）；单测从「details 为空时无该键」升级为「深度无 `undefined`」（§5.6、§11 第 3 条） |
| 9 | 召回消息在 UI 上是否可见（`form: "snapshot"` 会展开整块） | **my call**：改用 `form: "notice"` + 短摘要，对齐 pi 的 `display: false` + 一行提示；并加一条单测钉住「正文仍进模型消息」，不成立则退回 `snapshot`（§5.7、§11 第 10 条） |
| 10 | 长会话内的跨进程索引新鲜度 | **my call**：本轮判据是「会话启动时新鲜 + 本会话写入后新鲜」，额外加「每轮第一个 step 前刷新」；不做 watcher（pi 侧同样只在 compaction 刷新）。`/memory` 作为手动同步入口（§5.4） |
| 11 | 行 config 的键面与用户实际编辑的文件 | **my call（建造者指出的是我的错误，已修）**：键名与 core **逐字一致**（`autoSurfacing.model`，不搞 `models.<task>` 翻译层，否则与 core 的 `taskModel` 读法分叉）；用户编辑入口是 **profile 自己的 `cordis.patch.yml`**（或 home 级 `~/.dsh/cordis.patch.yml`），我们包内那份只提供一个 `config: {}` 的空行（§5.1） |

建造者另外核对通过、不需要再问的两条：D10 的版本门确实成立（`evaluatePluginCompatibility` 用
`semver.satisfies(..., {includePrerelease: true})`，`engines.dsh` 存在时 peer 范围被忽略）；宿主
没有已存在的 `memory` 工具或 `memory_index` section，无命名冲突。
