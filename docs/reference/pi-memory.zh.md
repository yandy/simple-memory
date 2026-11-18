# pi-memory 参考

细节文档：完整配置、跨设备同步、工作原理、工具与命令参考。[README](../../pi-memory/README.zh.md) 是上手路径。

## 配置

在 agent 目录（`~/.pi/agent/memory.json`）或项目 `.pi/` 目录（仅在项目被信任时）创建 `memory.json`：

```json
{
  "memoryDir": "~/project-memories",
  "memIndexMaxLines": 200,
  "memIndexMaxBytes": 25600,
  "memIndexInjectMaxLines": 50,
  "memIndexInjectMaxBytes": 16384,
  "lock": { "timeoutMs": 5000, "snapshotKeep": 5 },
  "defaults": { "model": "provider/model-id", "sessionPersistence": { "enabled": false } },
  "dream": { "nudgeAfterSessions": 5, "nudgeAfterHours": 24, "thinkLevel": "high" },
  "sessionSearch": { "maxSessions": 10, "maxMatches": 5 },
  "autoSurfacing": {
    "enabled": true,
    "thinkLevel": "off",
    "maxFiles": 3,
    "maxEntryBytes": 3072,
    "maxInjectionBytes": 10240
  },
  "extractMemories": {
    "enabled": false,
    "thinkLevel": "high",
    "maxContextTokens": 2000,
    "maxToolResultChars": 500,
    "maxAssistantChars": 2000
  },
  "sync": {
    "enabled": false,
    "remote": "",
    "branch": "main",
    "pullOnStart": true,
    "pushOnWrite": true,
    "pushDebounceMs": 5000,
    "autoTimeoutMs": 5000,
    "timeoutMs": 20000
  }
}
```

> 每个 `model` 值都必须能在你的 registry 里解析 —— 没有默认值。缺失或解析不出的模型会让 `session_start` 报配置错误并且什么都不初始化。详见[模型配置](#模型配置)。

| 键 | 默认值 | 说明 |
|-----|---------|------|
| `memoryDir` | `$XDG_DATA_HOME/simple-memory`（默认 `~/.local/share/simple-memory`） | 所有记忆数据的根目录。`~`、`~/` 与（Windows 上）`~\` 会展开；相对路径按工作目录解析为绝对路径。**另一个平台**写法的值、空值，以及「根存在但不是目录」会在 `session_start` 变成一条配置错误（什么都不初始化），而不会静默换一个记忆库 |
| `memIndexMaxLines` | `200` | 写入口径：`MEMORY.md` 的最大非空行数（`# Memory Index` 头行与手写标题同样占额度，所以并不等于记忆条数） |
| `memIndexMaxBytes` | `25600` | 写入口径：`MEMORY.md` 的最大字节数 |
| `memIndexInjectMaxLines` | `50` | 注入口径：放进 `memory_index` section 的最大行数。窗口保留**最新**的行、丢弃**最旧**的行 —— 索引是纯时间序，窗口再小也不会藏住你刚写完的那条。**任一键写 `0` = 完全不注入索引**（section 保持空值） |
| `memIndexInjectMaxBytes` | `16384` | 注入口径：section 的最大字节数（优先丢最旧的行，截断标记在**开头**） |
| `lock.timeoutMs` | `5000` | 单次原语等逻辑锁 / 等跨进程 `.lock` 的上限。同时也是 `session_shutdown` 等在途写入的上限 |
| `lock.snapshotKeep` | `5` | `.backups/` 保留的回滚点数量（`migrate-` 前缀的目录永不裁剪） |
| `defaults.model` | —（必需） | 三个子任务的共享模型。**没有默认值**：会执行的任务必须能解析出模型，否则启动失败（见[模型配置](#模型配置)）。per-task 覆盖它 |
| `defaults.sessionPersistence.enabled` | `false` | 共享回退：headless 子会话（extract / dream / 侧查询）默认只在内存里跑 |
| `defaults.sessionPersistence.sessionDir` | `<项目记忆目录>/sessions/` | headless 会话的自定义落盘目录 |
| `dream.nudgeAfterSessions` | `5` | 距上次 dream 多少个会话后开始提醒 |
| `dream.nudgeAfterHours` | `24` | 距上次 dream 多少小时后开始提醒 |
| `dream.model` | — | dream 用的模型（`"provider/id"`）。回退 `defaults.model`；没有 `defaults.model` 时必填（必须可解析，不回退父会话模型） |
| `dream.thinkLevel` | `"high"` | dream 的思考强度：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `dream.sessionPersistence.*` | 继承 `defaults` | 把 dream 会话落盘（调试/审计用） |
| `sessionSearch.maxSessions` | `10` | `search scope=sessions` 扫描的最大会话数 |
| `sessionSearch.maxMatches` | `5` | 历史检索返回的最大命中数 |
| `autoSurfacing.enabled` | `true` | ⭐ 开启每回合的 entry 自动注入 |
| `autoSurfacing.model` | — | ⭐ 相关性侧查询用的模型。回退 `defaults.model`；没有 `defaults.model` 时必填（必须可解析，不回退父会话模型） |
| `autoSurfacing.thinkLevel` | `"off"` | ⭐ 侧查询的思考强度（`"off"` 最省） |
| `autoSurfacing.maxFiles` | `3` | ⭐ 每回合最多注入几条 entry |
| `autoSurfacing.maxEntryBytes` | `3072` | ⭐ 单条 entry 正文的注入字节上限（超出截断） |
| `autoSurfacing.maxInjectionBytes` | `10240` | ⭐ 每回合注入内容的总字节上限 |
| `autoSurfacing.sessionPersistence.*` | 继承 `defaults` | 把侧查询会话落盘 |
| `extractMemories.enabled` | `false` | ⭐ 开启每轮自动提取。**默认关闭**（opt-in）：开启后每轮结束都会跑一次 headless 模型调用 |
| `extractMemories.model` | — | ⭐ 提取 agent 用的模型。回退 `defaults.model`；没有 `defaults.model` 时必填（必须可解析，不回退父会话模型） |
| `extractMemories.thinkLevel` | `"high"` | ⭐ 提取的思考强度 |
| `extractMemories.maxContextTokens` | `2000` | ⭐ 渲染后对话的预算（`× 4` 个字符；超出时先裁中段、首尾优先保留，user 消息最后才动） |
| `extractMemories.maxToolResultChars` | `500` | ⭐ 单条 `tool_result` 渲染的字符上限 |
| `extractMemories.maxAssistantChars` | `2000` | ⭐ 单条 assistant 文本渲染的字符上限（user 消息从不截断） |
| `extractMemories.sessionPersistence.*` | 继承 `defaults` | 把 extract 会话落盘 |
| `sync.enabled` | `false` | ⭐ 开启跨设备同步。按**类型**校验：`"enabled": "false"` 这种字符串会报成「sync is disabled because …」，绝不会被当真值读成开 |
| `sync.remote` | `""` | ⭐ git 远端 URL，**只供首次初始化**使用。空值只在 `enabled` 为真且尚未初始化时算错；初始化之后真相来源是暂存 clone 的 `origin` |
| `sync.branch` | `"main"` | ⭐ 本项目同步的远端分支 |
| `sync.pullOnStart` | `true` | ⭐ 会话启动时跑一轮收敛（一轮 push：先收敛再发布），排在索引值选定**之前**。`false` 仍会 prepare（并在首次使用时初始化），只是永不自动 fetch/pull/push |
| `sync.pushOnWrite` | `true` | ⭐ 每次成功的记忆写入后自动发布，按 `pushDebounceMs` 去抖 |
| `sync.pushDebounceMs` | `5000` | ⭐ 静默期，从**第一次**写入起算：一串写入（一轮 `/dream` 改十几个文件）合并成一轮 push |
| `sync.autoTimeoutMs` | `5000` | ⭐ 一条自动路径（启动 prepare + 收敛轮、退出 flush）的总预算；同一次调用里的所有 git 子进程共享它 |
| `sync.timeoutMs` | `20000` | ⭐ 手动命令的预算，用户正在显式等待（`/memory sync pull` / `push` / `status`） |

headless 会话默认落在 `<项目记忆目录>/sessions/` —— 在项目记忆目录里，不在你的工作副本里。

### 禁用本扩展

pi-memory 没有自己的包级开关 —— `memory.json` 里的顶层 `enabled` 键会被忽略。禁用它与其他 pi package 一样，靠「不加载这个扩展」：

只在本项目禁用（项目根目录的 `.pi/settings.json`，仅在项目被信任后读取）：

```json
{ "packages": [{ "source": "npm:@yandy0725/pi-memory", "extensions": [] }] }
```

项目条目会替换个人条目，因此该项目不会加载本扩展。全局禁用：`pi remove npm:@yandy0725/pi-memory`，或用 `pi config` 关闭该包的资源（项目 scope 会写成 `autoload: false` + `extensions: ["-index.ts"]`）。扩展保持加载时，仍可用模块级开关（`autoSurfacing.enabled` / `extractMemories.enabled` / `sync.enabled`）单独关掉某个行为。

## 跨设备同步

pi-memory 可以把一个项目的记忆 entry 复制到**一个 git 远端**，同一仓库在另一台机器上打开时落到同一批记忆上。它**默认关闭** —— 同步会把记忆写到远端，这笔代价必须由用户显式承担（同 `extractMemories`）。

### 配置即初始化：没有 `/memory sync init`

1. 远端仓库由你自己准备（**空仓库可以**），并确保 pi 运行环境里的 `git` 能非交互地 `clone` / `push` 它 —— SSH key、credential helper、URL 里的 token，用你现有那套即可。pi-memory 自己**不保存任何凭据**、也从不提示输入；它只调用 `PATH` 上的 `git`。预期默认使用**私有**远端：仓库与访问权限都由你自己开通。
2. 在 `memory.json` 里指向它：

```json
{ "sync": { "enabled": true, "remote": "git@github.com:you/simple-memory.git" } }
```

3. 启动一个会话。带这份配置的第一次 `session_start` 会**自动初始化**：先 clone 到唯一 staging，完成后原子发布为 `<memoryDir>/.sync/repo`，再写出这个项目的首份基线。初始化与换 origin 经有界根锁串行；失败/abort 只清自己的 staging，绝不删除另一进程已经发布的 clone。这里刻意**没有 `/memory sync init`** 命令 —— 它第一次执行可能是一次慢 clone，而「敲了却没生效」又多一个要排查的状态（URL 写错？远端连不上？），并不比改一行配置省事。

「origin 是真相来源」派生的规则：

- **初始化之后，暂存 clone 的 `origin` 才是权威**，不是 `sync.remote`。之后把 `sync.remote` 留空，同步照常工作。
- **配置 remote 与 `origin` 不一致是非致命的**：每个会话一条错误提醒（`sync.remote differs from the initialized origin; continuing to use origin …`），`/memory sync status` 两行并报，之后每一轮仍按 `origin` 走。不禁用同步、不碰本地记忆。真要改用它：`/memory sync remote <url>`。
- **首次初始化之前** `sync.enabled: true` + 空 `sync.remote` 才是配置错误（同步报不可用，其余记忆功能照常）。初始化之后空 `remote` 不再是错误。
- `enabled`、`pullOnStart`、`pushOnWrite` 按**类型**校验，不看真值：`"enabled": "false"` 会报成 `sync is disabled because …`，绝不会被默默读成开。
- 初始化失败（没有 `git`、断网、URL 写错、没有权限）一律**非致命**：会话只用本地记忆继续跑，一条可读的错误提醒解释原因。修好之后，下次会话启动 —— 或一次显式 `/memory sync pull` / `push` —— 会重走同一条幂等的初始化。
- 若 `<memoryDir>` 自己就是 git 仓库：它的 remote 与目标 URL **相同**时初始化**拒绝**（两个写入者推同一个远端是丢数据的标准姿势）；指向别处只给一条 warning —— 暂存 clone 是独立的，绝不动你自己的仓库。

### 同步范围与布局

只有**当前项目**的 entry 文件参与同步：`<memoryDir>/git/<project>/` 下能解析成 v2 entry 的扁平 `*.md`。一个远端镜像整个记忆根（`git/<project-key>/…`），但一次会话只同步自己所在的那个项目；其他项目在各自的会话里同步。

| 路径 | 是否同步 | 原因 |
|---|---|---|
| 当前项目的 entry `*.md` | **是** | 记忆本身 |
| `MEMORY.md` | 否 | 本地派生文件，pull 后从磁盘重建；手写的标题与分组留在所在设备 |
| `.lock` | 否 | 跨进程锁永不自动回收；同步过去等于在另一台设备上造一把假死锁 |
| `.backups/` | 否 | 本地回滚点；同步会让体积在设备间乘倍 |
| `sessions/` | 否 | headless 会话转录：体积大，且是本机执行痕迹。因此 `memory search scope=sessions` 只搜得到本机历史 |
| `.dream-meta.json` | 否 | 「上次 dream」按设备本地更合理（每台机器各自累计会话数） |
| `<memoryDir>/local/**` | 否 | 非 git 项目在 v1 不复制 |
| `<memoryDir>/.sync/**` | 否 | 本功能自己的状态 |

```
<memoryDir>/                     例如 ~/.local/share/simple-memory
  .sync/                         同步状态 —— 只在开启同步后才创建
    device.json                  { id, hostname, createdAt }：每台设备自己的身份，永不同步
    repo/                        暂存 clone（工作树 + .git）—— 全部传输通道都在这里
    state/<project-key>.json     v2 基线：文件指纹 + { sha256(实际 origin), branch }，不存原始 URL
    sync.lock                    根级跨进程锁（fetch/publish，以及有界的 init/setRemote）
  git/<project>/                 你的记忆：这里不加 .git，也不写别的东西
  local/<project>/               永不同步
```

`.sync` 位于**记忆根**，与 `git/`、`local/` 同级，不在任何项目记忆目录里面：项目目录保持干净，而所有扫描都会跳过它（点开头的目录不算 entry）。根级 `sync.lock` 与上面那个项目 `.lock` 是**两把不同的锁**：同步轮按段持有 —— 传输段一次 `fetch` + origin 读取、发布段一次 `push` —— 绝不整轮持有。管理操作（`init` / `setRemote`）在同一把锁上做有界等待，且绝不嵌套在轮次锁内。一旦被遗弃，此后每一轮同步都会失败并给出可操作的错误 —— `/memory sync unlock` 是唯一被认可的清除入口。

### 生命周期

```
session_start
  1. 配置 + 模型 + 记忆目录
  2. 同步：prepare（首次使用、缺基线，或 origin/branch 传输身份不匹配时初始化/重置）
     —— 无论 pullOnStart 是否开启，这一步都跑
  3. pullOnStart === true → 一轮 push（只用共享启动预算的剩余量），排在索引值被选定之前
  4. 确定索引值（startup/new 读磁盘；resume/fork/reload 用 transcript 的录制值）

每一次成功的记忆写入
  → core 去抖：标脏，从第一次写入起算 pushDebounceMs 静默期后排一次 push

session_shutdown
  → 不看去抖，立刻 flush 一次，上限 sync.autoTimeoutMs
```

- **一轮 push 就是完整的一次收敛**：传输段（fetch）→ 对基线做三方差集并应用（快照、落盘、重建索引）→ 发布段。所以启动那一轮既把别的设备写的东西拉下来，也把上个会话没推出去的补推上去。这也正是「一轮 push」而不是「先 pull 再 push」的原因：进程内的脏标记只认得**本进程**写过的内容。prepare 与启动 push 共用一份 `sync.autoTimeoutMs` deadline；prepare 耗尽时就跳过 push 并给出非致命的「下一轮再推」预告（`pi-memory sync notice: …`，info 级），绝不再发起一次 1ms 网络轮。
- **`pullOnStart: false` 仍会 prepare** —— 只是永不自动 fetch/pull/push。首次初始化与「上次初始化失败」的恢复仍然发生在会话启动时。键名保持既有契约：启动那一轮 push 本身就包含拉取与发布。
- **已有本地 entry**：初始化新基线时，prepare 会在任何启动 push **之前**提示可能产生确定性的冲突副本；同一份基线只提示一次，不会每次启动都重复。这条是**预告，不是错误**：以 info 级 `pi-memory sync notice: …` 通知，`/memory` 里单列一行 `Sync notice:`；只有真正的失败才用 `pi-memory sync error: …` 与持久错误态。
- **非 git 项目**：`sync.enabled` 为真但当前项目不是 git 仓库时，v1 不做任何同步初始化。这条同样是**预告，不是错误**：以 info 级 `pi-memory sync notice: …` 通知一次，`/memory` 里出现在 `Sync notice:` 下，`/memory sync` 会原样给出这个原因而不是「未启用」。
- **写入触发**：每一次成功的 entry 写入（`memory` 工具、一整轮 `/dream`、extract 的落盘）都会给去抖上弦。`pushOnWrite: false` 装的是空转触发器 —— 不自动发布任何东西，手动命令照常可用。
- **退出兜底**：即使去抖还没到点也 flush 一次，这一轮的上限是 `sync.autoTimeoutMs`；在途等待的上限仍是既有写入用的 `lock.timeoutMs`。flush 失败只产生一条 `Memory sync flush failed: … local changes will be retried at the next session start.` —— 内容仍在本地，下一轮就会补推：下次会话启动（`pullOnStart` 默认开启）或下一次写入的去抖推送。若 `pushOnWrite` 与 `pullOnStart` 都关了，用 `/memory sync push`。
- **录制索引（已知语义，不是 bug）**：`resume` / `fork` / `reload` 冻结 transcript 里录制的索引值。启动收敛照样跑、磁盘照样更新，但同步来的记忆**不会**出现在本会话的 `memory_index` 里，直到下一次 compaction（或下一个会话）。`/memory sync status` 的最后一行会说明这一点。

### 编排在 core，pi 只留宿主策略

会话级同步编排由 `@yandy0725/memory-core` 的 `createSyncRuntime` 提供：配置门禁、懒 engine、`prepare`、
启动与手动轮次、严格 dry-run 的 `status`、`changeRemote` 的持久顺序、写触发与 `dispose`。pi 只注入自己的
那一半：

- **调度 `concurrent`**：启动与手动轮次在调用返回前就起跑并登记，与 pi 的其他会话级工作并发；`prepare`
  是 single-flight，并发的准备共用同一次。
- **注入原语**：backend、engine 与首份基线的 `writeManifest` 都从 core 公开出口传入，所以接线测试里的
  包装工厂继续命中真实实现。
- **文案与展示**：漂移指引只指向 `/memory sync remote`；未初始化时换远端的另一条指引才指向
  `memory.json` 里的 `sync.remote`。报告尾部那行「索引只在本会话内冻结」，以及 `pi-memory sync notice:` /
  `pi-memory sync error:` 的前缀与 notice/error 级别也留在 pi。
- **宿主生命周期**：`session_start` 中 await `startup()` 且排在索引值选定之前、`session_shutdown` 的
  `flush()` 与有界等待、`dispose()` 只收摊；命令解析与确认、错误/预告账本也都在这一侧。

### 命令

```
/memory sync              — 状态（等同 `/memory sync status`）；严格 dry-run
/memory sync pull         — 把远端变更收敛到磁盘并重建索引；不发布
/memory sync push         — 先收敛再发布
/memory sync remote <url> — 把暂存 clone 的 origin 改到 <url>，并重置这个项目的基线
/memory sync unlock       — 清除遗留的 .sync/sync.lock（会先要求确认）
```

`status` 是**严格 dry-run**：它算出与真跑一轮完全相同的三方差集，但不 clone、不初始化、不快照、不写基线、不改任何记忆文件（它的 `git fetch` 只动 `.sync/repo` 内的传输元数据）。报告内容：`Configured` / `Initialized`、`Origin` 与 `Configured remote`、`Branch`、`Device`、本地目录 → 远端 key 的映射、基线 revision、`Ahead` / `Behind` / `Conflicts` 文件清单、`Rejected`（带原因）、`Unparsable local`（既不算 entry、也不能安全当删除的文件，因此原地不动）、`Out of scope remote`（远端里不属于本项目 entry 的路径 —— 例如有人手工推了一个根 `MEMORY.md`）以及 `Errors`。v1、损坏或 transport 不匹配的 manifest 一律按空 base；origin/branch 不匹配会在 `Errors` 里显示 reset，而不是把旧基线冒充当前状态。

`remote <url>` 是改 origin 的唯一入口：

- 它会先关闸拒绝新的同步活动（再敲一次 `/memory sync remote` 会得到 `sync remote change is already in progress`），排空已登记的轮次，然后**持久失效本项目的基线**（删掉 `state/<project-key>.json`），再对新 origin 重跑一遍准备。基线缺失是**安全的空基线**：它表示「两侧还没达成过一致」，绝不是「用户把东西都删了」。
- 每份 v2 manifest 还绑定 `sha256(实际 origin)` 与 `branch`，不存可能带凭据的原始 URL。另一个进程晚写的旧 manifest 因此会在新传输端被忽略 —— 对**所有项目**都成立，不只是正在换远端的这个。旧发布也带着 fetch 时的 origin，若与当前 origin 不同，在写入新远端之前就会被拒绝。
- 因为基线为空，对新远端的第一轮可能看到同一条记忆两侧内容不同。**两份都保留**：`modified` 较新的那份留在原路径（时间相同则比内容 hash），另一份变成一条正常 entry，`name` 加上 ` (冲突 <date> <sha6>)` 后缀。后缀只由内容派生，所以两台设备各自解同一次冲突会写出**同一个**文件、收敛成一份，不会越同步越多；后续由 `/dream` 合并重复。
- 若新 origin 是空仓库，第一次发布会从暂存 clone 当前的 HEAD 起步，因此新远端可能收到既有的**整个记忆根历史，包括其他项目**，而不只是当前项目的最新文件。把「换成空 origin」理解为整根历史迁移，执行前先检查目标仓库。
- `memory.json` **绝不会被改写**（这一层没有配置写入能力）—— 通知里会明说。想让新地址成为下次启动的配置默认值，请自己改文件。
- 首次初始化之前没有 origin 可改：它会告诉你改 `memory.json` 里的 `sync.remote`。

### 验证状态

对真实托管 git 远端端到端跑通（走网络，而不是测试套件用的本地 bare 仓库）：首次初始化（无
`/memory sync init`）、写去抖推送、第二台设备拉取、`/memory sync remote` 换远端、冲突副本（按内容命名、
两份都留、再推一轮收敛）、写入后立刻退出的兜底补推、两条降级路径、`resume` / `fork` / `reload` 的录制
索引语义、`/memory sync unlock`，以及带 token 的 HTTPS 远端在报告与错误里的凭据脱敏。

## 模型配置

会执行的任务必须能解析出模型 —— **既没有随包默认值，也没有父会话模型回退**。`defaults.model` 可以满足全部任务；各任务自己的 `model`（`dream.model` / `extractMemories.model` / `autoSurfacing.model`）优先于它。

| 任务 | 何时必需 |
|------|---------|
| `dream` | **恒**需要 —— 每个会话启动时都校验 |
| `extractMemories` | `extractMemories.enabled` 为真时 |
| `autoSurfacing` | `autoSurfacing.enabled` 为真时 |

`session_start` 会把每个必需模型拿到注册表里解析；只要有缺失或解析不出的，就**不初始化任何东西**：弹一条 error 通知 `pi-memory config error:` + 每个问题一行 `- <error>`，`/memory` 则报 `Memory: misconfigured` + `Dir: not initialized` + 同样的行。两条错误文案：

- `no model for <task> — set "<task>.model" or "defaults.model" in memory.json`
- `model "<value>" for <task> is not resolvable (unknown id or missing credentials)`

改好 `memory.json` 后重启会话 —— 配置在启动时只读一次。headless / print 会话里配置错误是静默的（不会弹任何通知），所以要在交互式会话里用 `/memory` 确认。

解析用的是会话的模型注册表，但 headless 子会话跑在 pi-memory 自建的 runtime 里：`models.json` 里的 provider、以及另一个扩展用 `pi.registerProvider()` **运行时注册**的 provider 都能用。搬不过去的是运行时注册的**虚拟模型** —— 那种模型启动时能解析、执行时给一条显式错误（`… resolves in the host registry but not in a headless runtime`）。用到虚拟模型的话，请在 `models.json` 里配置物理 provider。

## 工作原理

### 会话生命周期

| 事件 | pi-memory 做什么 |
|---|---|
| `session_start` | 加载配置 → 校验必需模型（失败即什么都不初始化）→ 解析记忆目录 → **准备跨设备同步**（首次使用时自动初始化，即使 `pullOnStart: false` 也照做）→ `pullOnStart` 开启时跑一轮收敛（一轮 push）→ **确定索引值并冻结**（`startup`/`new` 读磁盘；`resume`/`fork`/`reload` 重放 transcript 取录制值）→ 注册 `memory` 工具（仅首次，5 个 action）→ 重建清单缓存 → dream 提醒检查 |
| `before_agent_start` | 把冻结值写进 `sections["memory_index"]`（**每一轮、无条件**），然后在**主会话的用户轮**里启动召回预取（不 await、本轮不注入；custom 消息触发的 run 没有用户输入可检索，跳过） |
| `turn_end` | 召回的消费点：结果已就绪、本轮有工具结果（= 后面还有请求）、且边界仍属于启动检索的那条 prompt 时，把召回块持久化进会话并标记去重。零工具轮、取消、未就绪、被新 prompt 取代的轮都不会碰到这一步 |
| `agent_end` | `extractMemories.enabled` 开启时触发异步 extract；写入成功通知 `Extracted N memories.`，失败通知 `Extract failed: …`（每会话一次） |
| `agent_settled` | run 彻底收尾：作废未持久化的在途召回（不跨 run 保留）。已持久化的召回块不受影响 |
| `session_compact` | 清空已注入集合，**并从磁盘重读索引** —— 会话内唯一的刷新点 |
| `session_shutdown` | 把待发布的同步推送 flush 一次（上限 `sync.autoTimeoutMs`），并等在途写入收尾（上限 `lock.timeoutMs`），因此退出既不会留下 stale 的 `.lock`，也不会留下一批只到过本地磁盘的记忆 |

每一次成功的记忆写入还会给同步的写入触发上弦，一串写入因此合并成一轮去抖推送。详见[跨设备同步](#跨设备同步)。

### 为什么索引要冻结

pi 用有序的 sections 构建 system prompt，只对**值发生变化**的 section 追加一条 patch 消息；全部没变时一条都不追加。自定义 section 插在**最后**，所以 `memory_index` 是 system prompt 的最后一段，其后紧跟整段对话。一旦它的值在会话中途变化，折叠后的头部就会被改写，其后的全部内容失去 prefix cache。因此：一个会话一个值，只有 compaction 才刷新（那时对话中段本来就要被重写）。

有意接受的代价：**本会话内写入的记忆不会出现在本会话的索引里**。工具返回值已经确认写入，下一个会话立刻可见。

`systemPromptOptions.sections` 是宿主事件的**必填字段**（pi 0.99.2 起），而 `>=1.5.0` 的 peer 下限更严格：
代码里没有「把索引拼到 system prompt 末尾」的回退。宿主不提供 `sections` 就是违反契约。

### 自动浮现

召回是**非阻塞预取**：侧查询与主循环并行，本轮第一个请求不等它。

1. 用户轮开始时（主会话、非子 agent、`messageType` 为 `user`）从 store 的 `mtime` 缓存构建清单：`[type] file.md — description`，按 `modified` 降序，最多 200 条、4000 字符（description 预算按条数均分，每条不低于 80 字符）。
2. 侧查询（`maxTurns: 1`、零工具）在后台启动，从清单里返回至多 `maxFiles` 个文件名；不在清单里的一律丢弃。结果没就绪的请求**不带召回** —— 包括本轮的第一个请求。
3. 只有「本轮之后还会有请求」的边界才消费：`turn_end` 有工具结果、结果已就绪、且这个边界仍属于启动检索的那条 prompt 时，选中 entry 的**正文**（不含 frontmatter）按 `maxEntryBytes` 截断、净化，作为一条 `display: false` 的 custom 消息**持久化**到会话，外面包 `<relevant_memories>`；总量到 `maxInjectionBytes` 就停。它在下一请求进入上下文，位置固定、只出现一次。你会看到 `Recalled: N entries` 通知。
4. 消费不了的轮**作废**：零工具调用的单请求轮（本轮之后再没有请求）、取消的轮、结果还没就绪的轮、被新用户 prompt 取代的轮、以及 `agent_settled` 一到（run 彻底收尾）时仍未持久化的结果，都不落 session、不标去重；下一轮按新 prompt 重新检索。

有一个**刻意的例外**：`turn_end` 有工具结果并不严格等于「后面一定还有请求」—— 工具结果全部要求终止工具循环时，run 会在边界之后直接结束（`finishTurn` 也可以返回 end）。宿主没有信号能把这种提前终止和普通边界区分开，所以这种轮**仍会持久化召回并标记去重**：召回块留在会话历史里（后续轮次、`resume` 都看得见），代价是多出一条注入。dsh 侧没有后续 `pre-step` 时这份结果会作废，这是两边已知的语义分叉。

两道**同步门**守住同轮的并发写入：结果在飞期间 store 被写过（同轮 `memory remove` / `replace`、dream / extract 的 worker、同步写入都算），或者选中的文件里已有一个进了去重集合（同轮 `memory search` 已经把它的完整正文交给模型），整份结果作废 —— 不持久化、不标去重，下一轮重新检索。没有这两道门，同一份正文会在工具结果和召回块里各出现一次，或者把已删 / 已改的正文写进会话。
5. 去重口径是「本 session 已让模型见过正文的文件」：注入过的 entry，加上**主 session** 的 `memory` 工具读取过的 —— `add` / `replace` 成功写入的文件，以及 `scope=memory` 的 `search` 命中的文件（它的结果带完整正文）。`list`（只有摘要）、`scope=sessions`（搜的是会话日志）、失败的调用都不算。headless 子会话（dream / extract）的工具读到的正文主模型没见过，不标记。
6. compaction 清空去重集合（正文被挤出上下文，这些 entry 必须能重新浮现）；会话切换时也从空集合开始。

### 自动提取

> **默认关闭。** 先在 `memory.json` 里设 `"extractMemories": { "enabled": true }`（配置只在 `session_start` 读一次，改动需重启会话），并确保 `extractMemories.model` 或 `defaults.model` 可解析。

extract 拿到的是结构化渲染，而不是有损的两条消息摘要：

```
=== Conversation ===
[1] user: <全文>
[2] assistant: <文本> | tool_call: memory({"action":"list"})
[3] tool_result: <摘要，按 maxToolResultChars 截断>
[4] user: <纠正>
```

它只有主 agent 的五个 action（永远拿不到 `rename` / `rebuild_index`）、没有文件工具、`maxTurns: 5`、超时 120s。逻辑锁被占用时（dream 正在整轮持有）它**跳过本回合**而不是排队 —— 下一次 `agent_end` 还会来。

### 锁

| 层级 | 作用域 | 行为 |
|---|---|---|
| 进程内逻辑锁（按记忆目录分键） | 单次原语；或 dream 的整轮 | 最多等 `lock.timeoutMs`，超时抛一条写明目录的可读错误。`extract` 用不等待的形态，直接跳过本回合 |
| 跨进程 `.lock` | 每次重试调用毫秒级，只包住物理写入（重试风暴下可持有数秒） | 用 `open(…, "wx")`（`O_CREAT|O_EXCL`）建立 —— **创建**在 NTFS、ReFS、exFAT/FAT32 与网络共享的命名空间里是原子的，因此能排除使用同一共享的所有机器上的进程；在同步客户端目录里只能排除同机进程（见 [Windows](#windows)）。持有者记录在文件建立后立即写入。**永不自动回收**：无 TTL、无心跳、无接管 |

因此写入中途崩溃可能留下一个 `.lock`，而且**没有任何进程会替你删掉它** —— 这是「互斥是硬保证」的刻意代价。错误文案会写明 pid、op、开始时间与路径；`/memory unlock` 是唯一被认可的清除方式。

## 工具参考

```
memory(action: "add" | "replace" | "remove" | "list" | "search",
       name?, description?, content?, type?, query?, scope?)
```

`description` 是未来会话唯一能拿到的相关性信号 —— `add` 与 `replace` 请务必带上自包含的一行。

### `add`

新建一条记忆，或**覆盖 `name` 完全相同的那一条**（幂等；`created` 保留）。

- `name`（必填）—— 唯一、可读的标题
- `content`（必填）—— 记忆正文，它会成为整个 entry 文件
- `description`（可选）—— 一行自包含说明；缺省取 `content` 的第一句
- `type`（可选）—— `user` / `feedback`（默认）/ `project` / `reference`

### `replace`

重写已有记忆的 `content` / `description` / `type`，按 `name` 定位。改名是 `rename`，dream 专属。

### `remove`

删除 `name` 匹配的记忆 —— 文件、索引行一起删。找不到条目或删不掉文件时**明确报错**，不会假装删成功。

### `list`

每条记忆一行：`- name (type, modified …) — description [file]`。

### `search`

- `query`（必填）
- `scope`（可选）—— `memory`（默认：在所有 entry 的 name / description / 正文里找）或 `sessions`（查历史会话）

### dream 专属 action

`rename`（`name` + `new_name`；文件名与索引行跟着走，并保持索引行的位置）与 `rebuild_index`（从磁盘全量重建，保留手写头部）。它们**只**注册在 `/dream` 的 headless 会话里，主 agent 与 extract 都调不到。

## 命令

### `/memory`

```
/memory                      — 查看状态
/memory unlock               — 清除遗留的 .lock（会先要求确认）
/memory sync                 — 同步状态（等同 `/memory sync status`）；严格 dry-run
/memory sync pull            — 把远端变更收敛到磁盘并重建索引
/memory sync push            — 先收敛再发布
/memory sync remote <url>    — 改暂存 clone 的 origin，并重置这个项目的基线
/memory sync unlock          — 清除遗留的 .sync/sync.lock（会先要求确认）
```

状态输出：

```
Dir: /home/you/.local/share/simple-memory/git/github.com__owner__repo
Index: 38/200 lines, 2841/25600 bytes, 1 unrecognized lines
Inject: 39/50 lines, 2841/16384 bytes
Entries: 37
Modules: dream=on(provider/model-a) extractMemories=off autoSurfacing=on(provider/model-b)
Last dream: 2026-10-01T22:10:04.882Z
Lock: free
Sync: ready
```

- `Index` 用**写入**口径（`memIndexMax*`），并报告索引里有多少非空行解析不出（`# Memory Index` 头行与手写标题会计入）。CRLF（以及单独的 CR）行尾在解析前就被归一为 LF，下一次写入也一律输出 LF，因此被 Windows 编辑器改过行尾的 `MEMORY.md` **不会**推高这个计数。注入侧同样做归一：CRLF 文件不会把 `\r` 送进 system prompt。
- `Inject` 用**注入**口径（`memIndexInjectMax*`），统计窗口内的行数与字节数 —— 即真正会进 `memory_index` section 的索引文本（截断标记本身不计入）。它与真正注入的值由同一份窗口代码算出来，不可能漂移。注意两行的口径不同：`Index` 数的是**非空**行，`Inject` 数的是窗口内的**全部**行，所以规范索引（LF 行尾、以换行结尾、头部后有且仅有一个空行）下 `Inject` 会比 `Index` 多一行而字节数相同。system prompt 里的值是**会话内冻结**的（见[为什么索引要冻结](#为什么索引要冻结)）：`session_start` 之后写入的记忆会立刻出现在 `Index`，但要等 compaction 或下一个会话才出现在 `Inject`。
- `Modules` 报三个模型驱动功能的激活状态：`on(<生效模型>)` / `off`。生效模型 = 该任务自己的 `model`，没有则用 `defaults.model`。`dream` 没有独立开关 —— 健康会话里它始终可用。
- `Lock` 有三种：`free`、`held by <op> (pid N on <hostname>, started <ISO>)`、`unreadable — run /memory unlock`。`/memory unlock` 的确认框会显示同一行持有者信息。
- `Sync` 有三种：`ready`（engine 已就绪）、`not initialized`（runtime 存在但准备还没完成 —— 跑一次 `/memory sync pull` 或 `push` 可重试）、`disabled`（没有 runtime）。这一行只在开启同步或发生降级时追加，所以默认安装仍然只打上面七行；同步错误作为 `- <error>` 行跟在它后面。详见[跨设备同步](#跨设备同步)。
- 必需模型缺失或解析不出时不初始化任何东西，`/memory` 报 `Memory: misconfigured` + `Dir: not initialized` + 每行一条 `- <error>`；同样的错误在 session_start 时以 error 通知出现。

### `/dream`

先要求确认，然后对整个目录拍快照，再跑一个 headless agent 走完四个阶段：

1. **Orient** —— `list`，读相关 entry
2. **Gather Signal** —— 找重复（同一事实的多条 entry）、矛盾、过时内容
3. **Consolidate** —— 用 `replace` + `remove` 合并，用 `rename` 改名
4. **Prune & Index** —— 用 `rebuild_index` 兜底重建

它碰不到文件：只有七个 `memory` action。完成时通知摘要，失败时通知 `Dream failed: …`。模型可用 `dream.model` 配置。

## 文件布局

磁盘格式、项目目录推导、锁与快照布局都由 [`@yandy0725/memory-core`](https://www.npmjs.com/package/@yandy0725/memory-core)（本包适配的、与 harness 无关的基础层）定义，细节见 [memory-core 参考](./memory-core.zh.md)；本节只说明 pi 把它们放在哪。

```
~/.local/share/simple-memory/
  git/
    github.com__yandy__pi-packages/    ← https://github.com/yandy/pi-packages.git
      MEMORY.md            — 索引：一行一条记忆
      SSH-port-on-staging.md
      Test-command.md      — 一条记忆一个文件
      .lock  .backups/  .dream-meta.json
  local/
    home__yandy__workspace__scratch/   ← 非 git 目录 /home/yandy/workspace/scratch
```

目录名的推导规则：

- remote 是 http(s)、ssh（含 scp 写法 `[user@]host:owner/repo`，user 可省略）或 `git://`，以及 `git+ssh://` / `git+https://` 别名的 git 仓库 → `git/<host>__<owner>__<repo>`；端口、凭据、结尾的 `/` 与 `.git` 会被剥掉，host 转小写
- remote URL 从原始 git config 读取（`remote.<name>.url`；先 `origin`，再按字母序，第一个可用的胜出），所以 `url.*.insteadOf` 重写不会影响映射
- scheme 形式走 WHATWG URL 规范化（IDN host 转 punycode，百分号编码与 `.`/`..` 折叠生效，凭据/query/fragment 被丢弃），scp 形式保留原样路径 —— 等价但写法不同的 remote 可能映射到不同目录
- 其余情况 —— 非 git 目录、没有 remote 的 git 仓库、`file://`、UNC（`\\server\share\repo.git`）、相对路径与本地路径 remote → `local/<absolute-path>`（git 仓库用仓库根）。Windows 盘符形式的 remote（`Z:\repos\foo.git`）**在 Windows 上算本地路径**，与 git 在那里的一致；同一串在 POSIX 上是 scp 写法（盘符字母是 host），仍映射到 `git/` 目录名，也与 git 一致
- `/` 变成 `__`；文件名里不可移植的字符（`<>:"|?*`、控制字符）变成 `_XX` 十六进制转义
- 超过 120 UTF-8 字节的名字在码点边界截断到 100 字节，再加 `__<hash8>` 后缀
- 名字是平台感知的：Windows 上反斜杠是分隔符，并避开保留设备名与结尾点/空格；POSIX 上反斜杠仍是普通字符，上述 Windows 规则不适用。唯一在所有平台都生效的规则是「stem 形如设备名的 entry 文件名加 `_` 前缀」（见 [Windows](#windows)）

映射不是单射：下划线原样保留，所以 `/home/a__b` 与 `/home/a/b` 都映射到 `home__a__b`（共享同一个记忆目录）。改动或重命名 remote、新增一个排序更靠前的 remote、移动本地目录，都会改变记忆目录，旧目录会被孤立。

## Windows

pi-memory 在 Windows 上原生可用，不需要 WSL。

- **目录名。** 由项目 key 派生的名字一定是单个、合法的 Windows 分量：`\` 被当作分隔符（`C:\Users\you\proj` → `C_3a__Users__you__proj`），结尾的点或空格被十六进制转义（`proj.` → `proj_2e`），而「第一个 `.` 之前的部分」是保留设备名的名字会加 `_` 前缀（`nul` → `_nul`）。普通 remote 的 `git/` 目录名在所有平台上一致（`github.com__owner__repo`），因此共享 `memoryDir` 时同一仓库从 Linux 与 Windows 打开都会落到同一个目录。首段与保留设备名撞名（如 `aux.example.com/...`）、含反斜杠、或以点或空格结尾的 key，其目录名在两端仍可能不同。
- **仓库根。** 根路径取自 `git rev-parse --show-toplevel`：从仓库子目录启动与从仓库根启动映射到同一个记忆目录。注意该路径是按 git 的输出原样使用的，必须是原生 Windows 形态 —— Git for Windows 会打印 `C:/...`；若 PATH 上的 `git` 是 cygwin/MSYS 构建，它会打印 `/cygdrive/c/...` 这类 POSIX 形态路径，记忆目录会落到错前缀下。装了多个 git 时，把 Git for Windows 的 `git.exe` 放到 PATH 前面。
- **`memoryDir`。** `~`、`~/` 与（Windows 上）`~\` 都会展开；相对路径会被解析成绝对路径。Windows 路径与 UNC 共享都可用。**另一个平台**写法的值是配置错误而不是「换个位置」，空值与「根不可用」同样如此 —— 见 [memory-core 参考](https://github.com/yandy/simple-memory/blob/main/docs/reference/memory-core.zh.md#windows)。
- **锁。** 跨进程锁用 `open(…, "wx")`（`CREATE_NEW`）建立。在网络共享上这个原语在共享的单一命名空间里是原子的，因此锁能排除使用同一共享的**所有机器**上的进程 —— `memoryDir` 放在非 NTFS 卷上也能用。在**同步客户端目录**（OneDrive、Dropbox 等）里没有单一命名空间：每台机器各留一份副本，锁只能排除同一台机器上的进程 —— 不要用这种方式在多台机器间共享 `memoryDir`；需要跨机互斥时用网络共享。杀软、编辑器或索引器造成的瞬时 `EPERM`/`EACCES`/`EBUSY` 会做短退避重试；持续失败仍按原始错误报出。
- **换行符。** 读取记忆文件时一律容忍 CRLF 与孤立 CR（解析前归一为 LF），写入一律输出 LF。被记事本等 Windows 编辑器重新保存过的 `MEMORY.md` 或 entry 文件既不会从索引里消失，也不会推高「无法识别的行」计数。
- **已知限制。** 名字是保留设备名的文件（例如 `con.md`，由手工或在别的平台上创建）在 Windows 上会被**跳过**而不是被读取 —— 按该名字打开会到达控制台设备而不是文件。请改名（需用 `\\?\` 路径）或换名字重新写入这条记忆。在它存在期间，若再添加一条会派生到该名字的记忆（`CON` 现在派生 `_CON.md`），会得到第二个文件与第二条同名索引行；下一次 `rebuild_index`（dream 会定期调用）会清掉那条陈旧索引行。

## 通知

| 时机 | 通知 |
|---|---|
| `memory add` 成功（有 UI 的会话） | `Saved: <name>` |
| 自动浮现注入了 entry | `Recalled: <N> entries` |
| extract 写入了记忆 | `Extracted <N> memory.` / `Extracted <N> memories.` |
| extract 失败 | `Extract failed: <message>` —— 每会话最多一次 |
| `/dream` 结束 / 失败 | headless agent 的摘要 / `Dream failed: <message>` |
| 同步因环境降级（`sync.enabled` 为真但不是 git 项目） | `pi-memory sync notice:` + `Memory sync v1 only supports git projects; sync is disabled for this session.`（info 级，不是错误） |
| 启动时或手动命令同步失败 | `pi-memory sync error:` + 每行一条 `- <error>` / `Memory sync pull failed: <reason>` / `Memory sync push failed: …` / `Memory sync remote failed: …` / `Memory sync status failed: …` |
| 手动同步命令成功 | `Memory sync pull:` / `Memory sync push:` / `Memory sync remote: <url>`，后面跟该轮的拉取 / 推送 / 冲突 / 拒收清单 |
| 退出 flush 失败 | `Memory sync flush failed: <reason>; local changes will be retried at the next session start.` |

headless 会话（`hasUI === false`）不发任何通知。
