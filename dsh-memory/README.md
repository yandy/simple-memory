# dsh-memory

给 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh)（一个基于 cordis 的宿主）用的记忆插件：让 dsh
会话与 pi 会话读写**同一份**磁盘记忆。

它不自己实现记忆逻辑。磁盘格式、`MemoryStore`、锁、快照、注入截断、prompt 文案、`memory` 工具的
JSON Schema 与 handler 全在 [`@yandy0725/memory-core`](https://www.npmjs.com/package/@yandy0725/memory-core)
里；本插件只做宿主那一半 —— 什么时候注入、怎么注册工具、调哪个模型、怎么扫会话日志。

## 它做什么

落地目录与 `pi-memory` 逐字相同：`$XDG_DATA_HOME/simple-memory/<git|local>/<project>/`
（`XDG_DATA_HOME` 未设置或为相对路径时是 `~/.local/share/simple-memory`）。默认 `memoryDir` 下，
pi 会话写入的记忆，dsh 会话的索引与工具能看到；反向同样成立。

本轮交付五件事：

- **`memory_index` system prompt 段** —— 把索引（`MEMORY.md` 的最新一段窗口）注入进每个 session 的
  system prompt，正文与 pi 注入的逐字相同；注册了工具的会话还会在正文之前看到 `memory` 工具的
  snippet 与 guidelines（见下「提示词三通道」）。
- **`memory` 工具** —— 五个 action：`add` / `replace` / `remove` / `list` / `search`，schema 与
  handler 直接来自 core，模型看到的线格式与 pi 一致。
- **`/memory` 命令** —— 打印状态块（目录、索引容量、条目数、模块开关、锁持有者），`/memory unlock
  --force` 是清除崩溃遗留 `.lock` 的唯一入口。即使会话是以配置错误启动的（启动时目录没解出来），
  `unlock` 也会用会话的 cwd 按需重解一次目录再清锁 —— 它不能变成死路。
- **每轮自动召回（auto-surfacing）** —— 每一轮第一步之前，用一次零工具侧查询挑出与用户输入相关的
  条目，把正文包进 `<relevant_memories>` 插进进入该步的消息。
- **每轮自动提取（extractMemories）** —— 开启 `extractMemories.enabled` 后，每一轮收口时
  （`agent/turn-stopping`）起一个只带 `memory` 工具的**嵌套子会话**，让它从这一轮的对话里挑出值得
  长期记住的东西写进同一份记忆。
- **`/dream` 命令** —— 把整目录记忆交给同一个机制的子会话去合并、改名、清陈旧条目、重建索引。
  整轮持逻辑锁，进入时对整目录拍一次快照（回滚点）。

## 它不做什么（与 pi-memory 的真实差异）

extract 与 dream 都靠**嵌套子会话**跑（dsh 里唯一能跑工具循环的机制），所以与 pi 有几处结构性差异。
这里逐条写清，而不是假装对齐：

1. **子会话会被宿主落盘。** dsh 的 persistence 只看服务是否挂载，**没有 per-session 开关**
   （主稿 §4.3），而 pi 的 `sessionPersistence.enabled: false` 在 dsh 侧不可兑现。所以 dsh 的会话日志会
   多出这些子会话（每个都标 `origin: "subagent"`）。行为本身不受影响，但**磁盘上的会话条数会变多**。
2. **没有轮数硬上限。** dsh 全树没有 `maxTurns` / `maxSteps`，`maxIterations` 那一类上限
   （主稿 §4.2）。core 的 `maxTurns` 在这里是**尽力而为**：我们数 `agent/pre-step` 的步数，超了就把后
   续 step 拒掉，那一轮按 `incomplete`（cause `turn-limit`）收口。这不是硬预算 —— 一个卡在单步里的
   模型调用只能靠 `timeoutMs` 兜（extract 120s、dream 600s，均真的会打断子会话）。
3. **`/dream` 没有确认框，也不等它跑完。** dsh 的命令处理器拿不到交互通道（pi 的 `ctx.ui.confirm`
   没有对应物），而 dream 的 timeout 是 600s —— await 进去等于让宿主等十分钟。所以 `/dream` 立刻
   返回「已开始」，摘要与失败写进**宿主日志**。
4. **没有 dream 的 nudge 提示。** 「隔多少个会话 / 多少小时后提醒整理」是 pi 的宿主策略
   （`PiHostConfig`），core 里已经没有这两个键，dsh 本轮也不实现：没有 nudge，只有你显式 `/dream`。
5. **extract 的 prompt 里没有 AGENTS.md 块。** pi 从 system prompt 里按
   `<project_instructions path="…">` 抠出这些块塞进 extract prompt；dsh 的 AGENTS.md 由
   `dsh-agent-instructions` 拼成**不透明的 prompt 文本**，没有稳定标记可切。所以 `## AGENTS.md Rules`
   那一段在 dsh 侧是空的 —— 指令本身对主 agent 依然可见，只是不会单独递给 extract。

除此之外，`dream` / `extractMemories` 两个配置子树与 pi 的 `memory.json` 逐字同名，可以照抄；
它们的 `model` / `thinkLevel` / 预算值全部由 core 自己消费，本适配层一个都不读（除了 `/memory` 的
展示与 `/dream` 的发起前检查）。

不冻结索引的原因是 dsh 每一步都重新装配 system prompt（pi 是整个会话冻结索引、回放录制值来护住 prompt
cache），所以索引是一份快照：在 `agent/created`、每次记忆写入成功后、`/memory` 执行后、每个 `pre-step`
之前异步刷新，读侧同步查表。

## 安装

一条命令。宿主会在包操作之后自动把包名写进 profile 的 `dsh.profile.bundles` 并应用 bundle 的
`cordis.patch.yml`（`dsh-plugin-manager/lib/types/operations.js:101-135`），**不需要**手工编辑 profile
的 `package.json`：

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # 先产出 dist/
dsh plugin --profile web add file:/abs/path/to/dsh-memory
```

顺序不能反：`dsh-memory` 的 build 经 workspace 符号链接解析 core 的 `dist/`，而 `dist/` 不入库。

`<spec>` 现在是本地目录（本包 `private: true`、版本 `0.0.0`，尚未发布）；将来发布后换成包名
`@yandy0725/dsh-memory`。装完重启 dsh 生效。

改代码后的开发回路：重新 `npm run build -w dsh-memory` 然后重启 dsh。

> **限定**：这条回路假定安装是**软链**的（即 pnpm 把 `file:` 目录依赖当链接而不是拷贝处理）。
> 这一点**尚未在真宿主上核实**；若实际是拷贝安装，每次改完代码都得重新跑一次 `dsh plugin … add`（或等价的
> 重装命令）才能看到新产物，单重启不够。

卸载一条命令即可，同时摘掉 `dependencies` 与 `dsh.profile.bundles` 两处：

```sh
dsh plugin --profile web remove @yandy0725/dsh-memory
```

## 要求

- **宿主版本**：`engines.dsh` 声明 `>=0.2.2-rc.1 <0.3.0`。宿主在 **import 插件之前**就拿这个字段对当前
  运行时版本做门（不匹配就直接拒绝加载，不是加载后报错）。注意预发布版本不满足 `^` 范围：`0.2.2-rc.1`
  排序低于 `0.2.2`，所以 `^0.2.2` 匹配不到它 —— 范围必须写成带 rc 的形式。
- **Node**：`engines.node` 声明 `>=24.9.0`。

## 配置

**唯一的配置层是 cordis 行 `config:`**，在 profile 自己的 `cordis.patch.yml` 里（或机器级的
`~/.dsh/cordis.patch.yml`，对所有 profile 生效）。本插件**不读任何 JSON 配置文件** —— 既不读项目级
文件，也不读 `$DSH_HOME/memory.json` 或任何 XDG 配置目录。改配置只改行 config 一处。

行配置是**整体替换**的，所以覆盖时要连同 `id` 与 `name` 一起写（`config:` 之外的字段按你的需要填，
键名与 core 的 `MemoryConfig` 逐字一致，见下）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
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
    # 每轮结束自动提取（默认关闭：每轮一次模型调用）
    extractMemories:
      enabled: true
      thinkLevel: "high"
    # 只在你敲 /dream 时才跑（没有包级开关）
    dream:
      model: "deepseek-official/deepseek-pro"
      thinkLevel: "high"
```

键名与 `memory-core` 的 `MemoryConfig` **逐字相同**（`defaults` / `memoryDir` / `memIndex*` /
`lock` / `sessionSearch` / `autoSurfacing` / `extractMemories` / `dream`），所以 pi 的 `memory.json`
与 dsh 的行 config 可以照抄。白名单之外的键**不会被静默丢弃**：它们会收集成 `Config: N warning(s)`
由 `/memory` 打印，让你看见「拼错的键没生效」。

## memoryDir 警告（重要）

`memoryDir` 是 **per-harness 配置** —— 本设计刻意没有跨 harness 的共享配置文件。pi 从自己的
`memory.json` 读它，dsh 从自己的行 config 读它。**如果你在 pi 里覆盖了 `memoryDir`，就必须在 dsh
里也覆盖成同一个值**，否则两个宿主写进不同的目录，共享就静默失效了。

`/memory` 的第一行会打印解析出的 `Dir:`，这正是用来发现这种不一致的入口：两边的 `Dir:` 对不上，
就是配置没对齐。

## 模型

模型值沿用 core 的单一字符串，dsh 侧编码为 `"<provider>/<model>"`，按**第一个**斜杠拆开 —— 所以
model id 自己含斜杠也没问题（如 `megcore/qwen/qwen3.8-max` → `provider=megcore`、
`model=qwen/qwen3.8-max`）。

**缺模型或模型不可解析时，降级而不是关掉记忆**：只有拿到不到模型的那一个模块被关闭，`memory_index`
段与 `memory` 工具照常可用；降级原因显示在 `/memory` 的 `Modules:` 行（`autoSurfacing=off(<原因>)`）。

三个任务各自的模型需求：

- `autoSurfacing`：**启动期**就用宿主的 `resolveCallConfig` 探测一次，不可用只关掉召回。
- `extractMemories`：默认关闭（每轮都跑一次模型调用，代价要你显式承担）。开了但没配模型时，每一轮
  的抽取会以一条「extract failed」写进宿主日志 —— 它不阻塞对话。
- `dream`：没有包级开关，只有你敲 `/dream` 才跑。缺模型时**命令结果**里就报
  「set dream.model (or defaults.model)」，不会起个子会话再在后台失败。

`thinkLevel` 会原样当宿主的 `reasoningEffort` 透传（core 的默认值是 `"off"`）。若某条宿主路线的
model info 不带 `reasoning` 块，宿主会以 `UNSUPPORTED_REASONING_EFFORT` 拒绕—— 这时 `Modules:` 行的
原因会点名 `thinkLevel`（而不是 `model`）：要改的是档位，模型本身可能根本没毛病。

## search scope=sessions

`memory search scope=sessions` 由本插件**自己扫**：经 `ctx.sessionQuery.filterSessions` 取该项目最近
的会话，再 `readSession` 拿解码后的事件，抽取文本、匹配、截断 —— 语义对齐 pi 的实现。**刻意不**用
宿主的 SQLite 全文搜索：它在宿主里默认关，而且打开它会让 dsh 的召回强于 pi，同一份记忆在两个宿主里
搜出不同结果，与「行为一致」的目标相冲。

## 提示词三通道

core 的工具文案有三个通道，在 dsh 里的落点如下：

- `MEMORY_TOOL_DESCRIPTION` → 工具 schema 的 `description`（模型可见）。
- `MEMORY_TOOL_SNIPPET` 与 `MEMORY_TOOL_GUIDELINES` → 同一个 `memory_index` 段，且**恰好在该 session
  注册了 `memory` 工具时**才出现（没有 runtime 的 session、子 agent 两样都拿不到）。固定顺序：
  snippet → guidelines → 索引正文，每段之间空一行；索引正文逐字不动。

  宿主的 `ToolSchema` 只有 `{name, description, parameters, deferLoading?}`，没有 pi 的
  `promptSnippet` / `promptGuidelines` 两个专属通道，所以三通道里有两个搭的是 section 的车。
  guidelines 是 7 条字符串，渲染成 `- <规则>` 逐行（与 pi 宿主对 `promptGuidelines` 的渲染同式），
  文本逐字来自 core。代价是每轮 system prompt 多约 1143 字符（≈ 300 token），但它是**静态**文本，
  能被 prompt cache 命中。为什么值得落：记忆目录是两个宿主共享的，guidelines 管的正是写入质量
  （「description 必须自足」及其正反例）—— dsh 会话写出含糊的 description，会连带降低 pi 会话的召回质量。

## 开发

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # 顺序不能反：build 配置经 workspace 符号链接解析 core 的 dist/
npm test -w dsh-memory
```

`@yandy0725/memory-core` 有两条解析路径，与 `pi-memory` 同口径：**开发**（`npm test` / `typecheck`）
经 `vitest.config.ts` 的 alias 与 `tsconfig.json` 的 `paths` 指向 `../memory-core/src/index.ts`，
**构建与运行时**经包 `exports` 解析 `dist/`，用户机器上就是从 registry 装的那个版本。
`npm run check:memory-core-deps` 静态守这条，`npm run smoke:registry` 真装一次验证（见
[docs/guides/dependencies.md](../docs/guides/dependencies.md)）。

设计保证：`dsh-memory/dist/**/*.js` 里 **零** `@deepseek-ai` 引用。宿主包全部只以 `import type`
出现（tsc 擦除），运行时能力经 `inject` 进来的 `ctx` 服务拿 —— 所以产物 `.js` 里没有宿主 import。
CI 用 `grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` 守这条（`.d.ts` 里出现宿主类型是合法的，
不算失败）。

`inject` 声明了八个服务：`tools` / `systemPrompt` / `llm` / `agents` / `commands` /
`workingDirectory` / `sessionQuery` / `logger`。其中 **`agents` 是 extract / dream 必需的**（子会话的
工具循环只能由它开）；精简 profile 里缺它时整个 bundle 保持 inactive —— 刻意不要「半边挂」的
状态（召回在、`/dream` 静默不工作，那种半挂比整体不挂难查得多）。

## 验证状态

单元测试全绿（dsh-memory `281 passed`），并且已在**真实 dsh `0.2.2-rc.1`** 上端到端跑通（隔离
`DSH_HOME` + `file:` 装包，流程见 [docs/guides/dsh-real-host-smoke.md](../docs/guides/dsh-real-host-smoke.md)）。

真机确认（web profile，长寿命宿主）：

- 插件**真的会激活**（`inject` 里曾经多写了 `logger` —— 它是 `Context` 的普通属性、不是服务，
  写进去会让 fiber 永久 `pending`，插件一次都不会生效）。
- `memory_index` 段与 `memory` 工具在真会话里出现，模型主动 `add` 的记忆落盘正确。
- **extract 端到端可用**：父会话被要求「不要调用任何工具」，仅 1 轮 1 步；`MEMORY.md` 仍出现两条
  记忆，来自 extract 的子会话 —— 该子会话 `request/header` 里工具面只有 `["memory"]`，调用序列是
  `memory list` → `memory add` ×2，`turn/end: completed`。
- `/memory`、`/dream` 两个命令注册成功（空 `input.hint` 会让宿主拒绝注册并回滚整个 bundle）。

### 子会话为什么是「常驻 worker」

`AgentRegistry.create()` 用 `this.ctx` 作为子 agent 的 owner，而 cordis 的 traceable 机制把它解析成
「访问服务时的调用方作用域」。在 `agent/turn-stopping` / `agent/status` 的派发里创建子会话会抛
`cannot create effect on inactive context`（插件作用域绑定、agent 作用域绑定、宏任务延迟三种写法
全部复现）；同样的调用在 `agent/created` 期间是成功的。

所以本适配层在**会话启动阶段**为每个任务建一个常驻子会话（extract 5 个 action / dream 7 个 action，
能力面不同不能共用），每轮只往里 `followup` 一条消息并等它的 `turn/end`。代价与门禁：

- 只有 `extractMemories.enabled` 为真才建 extract worker；只有用户显式写了 `dream` 键才建 dream
  worker。默认（两者都没开）**零额外子会话**。
- 建了 worker 的会话会多出一条**空的**子会话记录（只有 followup 之后才会有轮次内容）。

### 一次性宿主里的限制

`dsh headless` 是「答一轮就退出」的宿主：父轮结束即退出进程，后台在途的抽取会被 `aborted/disposed`
打断（真机实测）。适配层在卸载/`agent/disposed` 时会 `drain()` 在途的抽取（最多 5s），但进程退出
不会等我们。所以 **extract / dream 的完整语义只在长寿命宿主（web / TUI）里成立**；一次性 headless
里它们是「尽力而为」。