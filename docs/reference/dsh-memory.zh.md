# dsh-memory 参考

细节文档：与 pi-memory 的差异、完整配置、模型与验证状态。[README](../../dsh-memory/README.zh.md) 是上手路径。

## 与 pi-memory 的真实差异

extract 与 dream 都靠**子会话**跑（dsh 里唯一能跑工具循环的机制），所以与 pi 有几处结构性差异。
这里逐条写清，而不是假装对齐：

1. **子会话会被宿主落盘。** dsh 的 persistence 只看服务是否挂载，**没有 per-session 开关**，而 pi 的
   `sessionPersistence.enabled: false` 在 dsh 侧不可兑现。所以 dsh 的会话日志会多出这些子会话（每个都
   标 `origin: "subagent"`）。行为本身不受影响，但**磁盘上的会话条数会变多**。
2. **没有轮数硬上限。** dsh 全树没有 `maxTurns` / `maxSteps` / 迭代上限。core 的 `maxTurns` 在这里是
   **尽力而为**：我们数 `agent/pre-step` 的步数，超了就把后续 step 拒掉，那一轮按 `incomplete`
   （cause `turn-limit`）收口。这不是硬预算 —— 一个卡在单步里的模型调用只能靠 `timeoutMs` 兜
   （extract 120s、dream 600s，均真的会打断子会话）。
3. **`/dream` 没有确认框，也不等它跑完。** dsh 的命令处理器拿不到交互通道（pi 的 `ctx.ui.confirm`
   没有对应物），而 dream 的 timeout 是 600s —— await 进去等于让宿主等十分钟。所以 `/dream` 立刻
   返回「已开始」，摘要与失败写进**宿主日志**。
4. **没有 dream 的 nudge 提示。** 「隔多少个会话 / 多少小时后提醒整理」是 pi 的宿主策略
   （`PiHostConfig`），core 里已经没有这两个键，dsh 也不实现：没有 nudge，只有你显式 `/dream`。
5. **extract 的 prompt 里没有 AGENTS.md 块。** pi 从 system prompt 里按
   `<project_instructions path="…">` 抠出这些块塞进 extract prompt；dsh 的 AGENTS.md 由
   `dsh-agent-instructions` 拼成**不透明的 prompt 文本**，没有稳定标记可切。所以 `## AGENTS.md Rules`
   那一段在 dsh 侧是空的 —— 指令本身对主 agent 依然可见，只是不会单独递给 extract。
6. **同步没有退出兜底推送。** 长寿命宿主里 `agent/disposed` 不是可靠的收口点（见下文
   [跨设备同步](#跨设备同步)），所以不同于 pi 的 `session_shutdown` flush，dsh 不会在会话销毁时
   尝试推送。没发布出去的写入由下一次 `agent/created` 的启动轮次补上。

除此之外，`dream` / `extractMemories` 两个配置子树与 pi 的 `memory.json` 逐字同名，可以照抄；
它们的 `model` / `thinkLevel` / 预算值全部由 core 自己消费，本适配层一个都不读（除了 `/memory` 的
展示与 `/dream` 的发起前检查）。

不冻结索引的原因是 dsh 每一步都重新装配 system prompt（pi 是整个会话冻结索引、回放录制值来护住 prompt
cache），所以索引是一份快照：在 `agent/created`、每次记忆写入成功后、`/memory` 执行后、每个 `pre-step`
之前异步刷新，读侧同步查表。跨设备同步（开启时）会在一次会话的**第一次**刷新**之前**跑完（见
[跨设备同步](#跨设备同步)），所以启动轮次拉下来的 entry 在第一份 `memory_index` 里就看得见 ——
这里没有 pi 那种「冻结的录制索引」问题（`resume` / `fork` / `reload`）。

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

> **限定**：这条回路假定安装是**软链**的（pnpm 把 `file:` 目录依赖当链接而不是拷贝处理）。
> 实测 `file:` 安装是**拷贝**的，所以重建 `dist/` 并不够 —— 必须重跑 `dsh plugin … add`（或等价的
> 重装命令）才能看到新产物。

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

`memoryDir` 本身还有一道形状校验：**另一个平台**写法的绝对路径（POSIX 上的 `E:/…` / `\\server\share`，
Windows 上的 `/mnt/…`）、空值，以及「根存在但不是目录」或悬空符号链接/联结，都会让这个 session 进入
错误态（不建 store、不注册工具，`/memory` 打印原因），而**不是**被 `resolve()` 悄悄落到工作目录下开一个
新库。这道校验不依赖环境变量或平台配置，零配置即可用。

## 召回：pre-step 两段式

与 pi 一样，侧查询不阻塞任何请求；dsh 的差异在消费点 —— 没有 pi 那种可以在边界追加消息的 `turn_end`，所以用「同轮的后续 step」。监听器挂在 `agent/pre-step` waterfall 上，用 `{ prepend: true }` 注册在最外层：先进入、最后看到 decision，于是 splice 进去的是其它监听器（compaction / instructions / time-context）都处理过的最终消息数组。

1. `step === 1`（轮首，且这一步 claim 的 messages 里有真人 prompt）：先作废**上一轮**的在途召回，再把 `scanEntries` + 侧查询丢到后台，**立即返回原 decision** —— 本轮第一个请求与侧查询并行，可能不带召回。
2. **同一 turn** 的 `step >= 2`（模型调过工具之后）：结果已就绪才把 `<relevant_memories>` 消息 splice 进这一步 claim 的消息之后（`form: "notice"` + 一行 `Recalled N memories` 摘要），并把这些文件标进去重集合；未就绪就原样返回，留给后面的 step。
3. 下列情况结果一律作废、不标去重：turn 变了、step 被拒、轮被取消、这一步 claim 里出现与启动时不同的真人输入、`agent/status` 转 `idle`（这一轮及其排队续轮都跑完了，没赶上的结果不跨轮保留），以及这一轮没有后续 step（模型直接答完）。同一 turn 重复进 step 1 = 重新启动一次预取，旧结果按身份校验丢弃。
4. 去重口径与 pi 一致：「本 session 已让模型见过正文的文件」—— 召回注入的文件，加上**主 session** `memory` 工具读取过的（`add` / `replace` 成功写入的文件，`scope=memory` 的 `search` 命中的文件；`list` / `scope=sessions` / 失败调用不计）。extract / dream 的常驻 worker 读到的正文只进了子会话，主模型没见过，不标记。
5. 同轮的并发写入同样被两道**同步门**拦住（与 pi 相同的判据）：结果在飞期间 store 被写过（同轮 `memory remove` / `replace`、常驻 worker、同步写入都算），或者选中的文件里已有一个进了去重集合（同轮 `memory search` 已经把完整正文交给模型）→ 整份作废，不 splice、不标去重。
6. 宿主 compact / clear 会用**同一个 sessionId** 重建 agent（`agent/created` 的 `payload.source` 为 `compact` / `clear`）：这时清空去重集合与在途召回 —— 被挤出或清空的正文若继续算「已见过」，这些 entry 在本会话里就再也不会浮现。`startup` / `resume` 相反：历史还在上下文里，去重状态保留。

## 跨设备同步

dsh-memory 可以把一个项目的记忆 entry 同步到**一个 git 远端**，同一仓库在另一台机器上打开时会落到
同一份记忆。**默认关闭** —— 同步会把你的记忆写到远端，这份代价必须显式开启，与 `extractMemories`
同理。引擎本身（三方差集、冲突收敛、manifest 基线、git 传输）与会话编排（门禁、`prepare`、启动与
手动轮次、换远端、写触发、收摊）与 pi 用的是同一份 `@yandy0725/memory-core` 代码；本节只写 **dsh 侧
不一样**的部分 —— 配置来源、生命周期挂点、以及没有退出兜底。共享的 core 语义（同步范围、磁盘布局、
冲突后缀规则、`status` 字段）见 [pi-memory 参考](./pi-memory.zh.md#跨设备同步)，这里完全一致。

### 初始化 —— 没有 `/memory sync init`

1. 远端仓库自己准备好（**空仓库也行**），并确保 dsh 运行环境里的 `git` 能非交互地 `clone` / `push`
   它 —— SSH key、credential helper、URL 里带 token，用你现成的方式都行。dsh-memory 自己不存凭据，
   也从不弹提示；它只是从 `PATH` 上调 `git`。**私有**远端是预期的默认用法。
2. 在行 config 里指向它：

```yaml
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    sync: { enabled: true, remote: "git@github.com:you/simple-memory.git" }
```

3. 开一次会话。第一个带着这份配置的根 agent `agent/created` 会**自动初始化**：clone 到一个唯一的
   staging 目录，原子发布为 `<memoryDir>/.sync/repo`，并写下这个项目的第一份基线。初始化与换 origin
   由有界根锁串行；被 abort 的 init 只清理自己的 staging，绝不动另一个进程已经发布的 clone。刻意
   **没有 `/memory sync init` 命令**，理由与 pi 相同。

「origin 是真相来源」衍生出的规则与 pi 完全一致（见上面的共享参考）：初始化之后暂存 clone 的
`origin` 优先于 `sync.remote`；`sync.remote` 漂移是一条非致命提醒，不是错误；`enabled` /
`pullOnStart` / `pushOnWrite` 按**类型**校验而不是按真值；初始化失败降级为只用本地记忆，配一条
可读提醒。

### 生命周期（dsh 特有）

```
agent/created（只对根 agent；子 agent 被门禁挡掉，与 memory 工具同一套判据）
  1. registry.prepare —— 解析记忆目录 / store（不变）
  2. sync：createDshSyncRuntime + prepare（首次使用、基线缺失、或 origin/branch transport 不匹配时
     初始化）—— 无论 pullOnStart 是否开启都会跑这一步
  3. pullOnStart === true → 只用剩余共享启动预算跑一轮 push
  4. indexCache.refresh —— 这个会话的**第一份**快照，在 2–3 步都完成之后才取

每一次成功的记忆写入（主工具、extract worker、dream worker）
  → core 去抖：标脏，静默期 pushDebounceMs 后排一次推送（静默期从第一次写入算起）

agent/disposed
  → dispose() 这个 runtime：abort 在途的 init，dispose engine（连带 abort 当前轮次的 signal），
    排空已登记的手动/自动轮次。**不会**尝试推送。
```

- **为什么没有退出兜底**：长寿命宿主进程里，一个只是闲置的会话，`agent/disposed` 触发得太晚（甚至
  实际上永不触发）—— 这一点在 extract 触发点上已经实测过，也是 `extract.ts` 改用
  `agent/turn-stopping` 的同一个理由（见[子会话为什么是「常驻 worker」](#子会话为什么是常驻-worker)）。
  在那里推送要么根本不会跑，要么与进程销毁抢时序，所以 dsh 干脆不做。**一轮 push 仍然是完整的收敛**
  （fetch → 三方应用 → publish），所以*下一次* `agent/created` 的启动轮次会接住上一个会话没发布出去
  的内容 —— 这就是补推路径，替代 pi 的 `session_shutdown` flush。如果 `pushOnWrite` 与 `pullOnStart`
  都关着，就用 `/memory sync push` 手动补。
- **`pullOnStart: false` 仍然会 prepare** —— 只是从不自动 fetch / pull / push。与 pi 语义相同。
- **本地已有 entry**：新基线初始化时，prepare 会在**任何启动 push 之前**预告可能产生确定性冲突副本，
  每份基线只预告一次，走的是预告通道（`simple-memory: memory sync notice: …`，info 级），不是错误。
- **非 git 项目**：`sync.enabled` 为真但项目不是 git 仓库时，v1 完全不初始化同步；同样是一条预告，
  `/memory sync` 会复述这条原因，而不是笼统地说「同步没开」。
- **按会话，不是按进程**：不同于 pi 的单个 `syncRuntime` 变量，dsh 用一张 `sessionId → runtime` 的表，
  因为一个长寿命宿主进程要服务很多会话（与 store registry、index cache 按 session 分键是同一个理由）。
  同一个 `sessionId` 重建 agent（宿主 `clear` / `compact`）时，`agent/created` 会先 await 上一代
  runtime 的 dispose 再准备新一代，所以陈旧的自动轮次绝不会跨代写远端。`apply` 自己的 disposer
  只对剩余会话逐个 `void disposeSyncSession(sessionId)` 启动清理；它不会 await 这些 promise，也不会在返回前
  排空所有会话。

### 编排在 core，dsh 只留宿主策略

会话级编排同样由 core 的 `createSyncRuntime` 提供：配置门禁、懒 engine、`prepare`、启动与手动轮次、
严格 dry-run 的 `status`、`changeRemote` 的持久顺序、写触发与 `dispose`。dsh 注入与保留的部分：

- **调度 `serial`**：startup / run / status / changeRemote 排一条 FIFO，已排队的操作允许跑完；换远端在
  公开调用时就关闸，第二个请求立刻得到 `sync remote change is already in progress`。
- **注入原语**：backend、engine 与 `writeManifest` 从 core 公开出口传入 —— 测试因此能在装配时捕获实例
  做故障注入。
- **宿主文案**：漂移指引指向行 config 与 `/memory sync remote`；「origin 已切换，但 prepare/后续操作
  失败」经 `formatRemoteChangeFailure` 保留 dsh 的既有措辞；文本出口仍把 `memory.json` 换成
  `plugin row config`。
- **宿主生命周期与账本**：`agent/created` 中先 await 上一代的 dispose，再 await `startup()` 且排在
  第一次索引快照之前；`agent/disposed` 只是 fire-and-forget 收摊（`void disposeSyncSession(sessionId)`，
  没有退出 flush）；此外还有按 session 保存 runtime/errors/notices、手动轮次后的索引刷新、命令解析与
  `--force` 确认。

### 命令

```
/memory sync                    — status（等价于 `/memory sync status`）；严格 dry-run
/memory sync pull               — 把远端变更收敛进磁盘 + 刷新索引快照；不发布
/memory sync push               — 先收敛，再发布
/memory sync remote <url>       — 把暂存 clone 的 origin 指向 <url>，并重置这个项目的基线
/memory sync unlock [--force]   — 清除遗留的 .sync/sync.lock
```

`status`、`pull`、`push`、`remote <url>` 的行为与 pi 完全一致（见共享参考）。两处是 dsh 特有的：

- **`pull` / `push` 会顺带刷新索引快照**（经 `indexCache.refresh`），因为 dsh 没有需要保护的冻结索引 ——
  下一个 `pre-step` 本来也会刷新它，但就地刷一次意味着手动轮次之后立刻敲 `/memory`，看到的就是收敛后
  的状态，不用等下一步。
- **`unlock` 用 `--force`，不用交互式确认。** dsh 的命令处理器没有交互通道（与 `/dream` 没有确认框
  是同一个理由），所以显式的 `--force` 旗标 —— 本适配层 `/memory unlock` 已有的既定模式 —— 就是确认
  机制。不带它时，命令只报告当前持有者，拒绝删除任何东西。

## 模型

模型值沿用 core 的单一字符串，dsh 侧编码为 `"<provider>/<model>"`，按**第一个**斜杠拆开 —— 所以
model id 自己含斜杠也没问题（如 `megcore/qwen/qwen3.8-max` → `provider=megcore`、
`model=qwen/qwen3.8-max`）。

**缺模型或模型不可解析时，降级而不是关掉记忆**：只有拿不到模型的那一个模块被关闭，`memory_index`
段与 `memory` 工具照常可用；降级原因显示在 `/memory` 的 `Modules:` 行（`autoSurfacing=off(<原因>)`）。

三个任务各自的模型需求：

- `autoSurfacing`：**启动期**就用宿主的 `resolveCallConfig` 探测一次，不可用只关掉召回。
- `extractMemories`：默认关闭（每轮都跑一次模型调用，代价要你显式承担）。开了但没配模型时，每一轮
  的抽取会以一条「extract failed」写进宿主日志 —— 它不阻塞对话。
- `dream`：没有包级开关，只有你敲 `/dream` 才跑。缺模型时**命令结果**里就报
  「set dream.model (or defaults.model)」，不会起个子会话再在后台失败。

`thinkLevel` 会原样当宿主的 `reasoningEffort` 透传（core 的默认值是 `"off"`）。若某条宿主路线的
model info 不带 `reasoning` 块，宿主会以 `UNSUPPORTED_REASONING_EFFORT` 拒绝 —— 这时 `Modules:` 行的
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
[依赖管理](../guides/dependencies.md)）。

设计保证：`dsh-memory/dist/**/*.js` 里 **零** `@deepseek-ai` 引用。宿主包全部只以 `import type`
出现（tsc 擦除），运行时能力经 `inject` 进来的 `ctx` 服务拿 —— 所以产物 `.js` 里没有宿主 import。
CI 用 `grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` 守这条（`.d.ts` 里出现宿主类型是合法的，
不算失败）。

`inject` 声明了**七个**服务：`tools` / `systemPrompt` / `llm` / `agents` / `commands` /
`workingDirectory` / `sessionQuery`。两条要点：

- **`agents` 是 extract / dream 必需的**（子会话的工具循环只能由它开）。精简 profile 里缺它时整个
  bundle 保持 inactive —— 刻意不要「半边挂」的状态（召回在、`/dream` 静默不工作，那种半挂比整体不挂
  难查得多）。
- **`logger` 绝不能写进去**：`ctx.logger` 是 cordis 在 `Context` 构造器里赋的普通属性，不是服务。
  写进 `inject` 会让 fiber 永远 `pending (waiting for service: logger)`，插件**一次都不激活**。

## 验证状态

真机（隔离 `DSH_HOME` + `file:` 装包的 web profile）确认过：插件会激活；`memory_index` 段与 `memory` 工具
出现且写入落盘；extract 与 `/dream` 端到端可用（子会话工具面分别是 5 / 7 个 action）；`/memory` 与
`/dream` 注册成功。

跨设备同步目前**只有单元测试**覆盖（本地 bare 仓库、无网络无凭据）。真实托管远端的手动验收清单见
[sync-e2e.md](../guides/sync-e2e.md)；走完之前，dsh 上的同步按**未验证**对待。

## 子会话为什么是「常驻 worker」

`AgentRegistry.create()` 用 `this.ctx` 作为子 agent 的 owner，而 cordis 的 traceable 机制把它解析成
「访问服务时的调用方作用域」。在 `agent/turn-stopping` / `agent/status` 的派发里创建子会话会抛
`cannot create effect on inactive context`（插件作用域绑定、agent 作用域绑定、宏任务延迟三种写法
全部复现）；同样的调用在 `agent/created` 期间是成功的。

所以本适配层在**会话启动阶段**为每个任务建一个常驻子会话（extract 5 个 action / dream 7 个 action，
能力面不同不能共用），每轮只往里 `followup` 一条消息并等它的 `turn/end`。代价与门禁：

- 只有 `extractMemories.enabled` 为真才建 extract worker；只有用户显式写了 `dream` 键才建 dream
  worker。默认（两者都没开）**零额外子会话**。
- 建了 worker 的会话会多出一条**空的**子会话记录（只有 followup 之后才会有轮次内容）。

## 一次性宿主里的限制

`dsh headless` 是「答一轮就退出」的宿主：父轮结束即退出进程，后台在途的抽取会被 `aborted/disposed`
打断（真机实测）。适配层在卸载/`agent/disposed` 时会 `drain()` 在途的抽取（最多 5s），但进程退出
不会等我们。所以 **extract / dream 的完整语义只在长寿命宿主（web / TUI）里成立**；一次性 headless
里它们是「尽力而为」。
