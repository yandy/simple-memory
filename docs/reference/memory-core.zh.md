# memory-core 参考

细节文档：磁盘格式、容量口径、锁、移植端口与平台注意事项。[README](../../memory-core/README.zh.md) 是上手路径。

## 存储布局

```
~/.local/share/simple-memory/git/github.com__owner__repo/
  MEMORY.md            — 索引：一行一条记忆（em dash 分隔）
  SSH-port-on-staging.md
  Test-command.md      — 一条记忆一个文件
  .lock                — 跨进程写锁（只持毫秒，永不自动回收）
  .backups/            — 回滚点：<ISO-ts>-<label>/（`migrate-` 前缀的目录永不裁剪）
  sessions/            — headless 会话落盘目录，仅在开启 sessionPersistence 时使用
```

### Entry 文件

```yaml
---
name: SSH port on staging
description: staging SSH listens on 2222, not 22; key at ~/.ssh/staging
type: project
created: 2026-07-13
modified: 2026-10-02T08:14:03.120Z
---

staging 的 SSH 用 2222 端口，密钥在 ~/.ssh/staging。
```

- `name` —— 唯一、可读的标题；`replace` / `remove` / `rename` 的定位键。再次 `add` 同名记忆是**覆盖**，不会产生第二条。
- `description` —— **一行自包含的说明**。侧查询判断相关性时**只看得到它**，所以它必须脱离正文也能读懂。反例：`Debugging tips`；正例：`staging SSH listens on 2222, not 22`。
- `type` —— `user` | `feedback`（默认）| `project` | `reference`。
- `created` —— `YYYY-MM-DD`，只在新建时写入，覆盖时保留。
- `modified` —— ISO 8601，**一律由 store 写入**，调用方传不进来。

文件名由 `name` 派生（不安全字符替换、100 字节上限，只有**文件名**冲突时才追加 `-2` / `-3`）。任何 `name` 都写不到 `MEMORY.md` 上。

### MEMORY.md 索引

```
# Memory Index

- [SSH port on staging](SSH-port-on-staging.md) — staging SSH listens on 2222, not 22
- [Test command](Test-command.md) — run npm test, not npm run test
```

写入是**外科式**的：只改目标行，手写的标题、分组、注释逐字保留，行序稳定。唯一的例外是行尾：CRLF（以及单独的 CR）在解析前被归一为 LF，因此第一次写入 CRLF 文件会把它整体转成 LF。

### 记忆类型

| 类型 | 含义 | 示例 |
|------|------|------|
| `user` | 用户角色、偏好、知识背景 | "用户是聚焦可观测性的数据科学家" |
| `feedback` | 经验、纠正、确认（默认） | "集成测试用真库不要 mock —— 上季度栽过" |
| `project` | 项目状态、时间点、事故 | "移动端 2026-03-05 起封版" |
| `reference` | 外部系统的指针 | "缺陷跟踪 = Linear 的 INGEST 项目" |

### 容量：索引 200 行，注入窗口 50 行

两套口径别混：

| 口径 | 配置 | 语义 |
|------|------|------|
| 写入口径 | `memIndexMaxLines`(200) / `memIndexMaxBytes`(25600) | 磁盘索引的行数上限。200 行里至少一行是头部，手写标题/分组/注释也占额度 → 约 199 条记忆（每个项目） |
| 注入口径 | `memIndexInjectMaxLines`(50) / `memIndexInjectMaxBytes`(16384) | 真正进 system prompt 的窗口，取索引**最新**一端（文件底部） |

- 超限写入**不会失败**：写入成功，工具回一条可操作警告，超出部分下次加载不可见。
- 窗口按「最新」取：`add` 追加到末尾；`replace` 原地改写（被改的老记忆可能留在窗口外，直到下次 `/dream`
  重排）；文件顶部的手写标题是位置语义，索引超过 50 行后最先被挤出。写满的索引恰好注入最新 50 条，48 条
  及以下整份注入。
- 被挤出窗口的记忆**没有丢**：auto-surfacing、`search` 与 `/dream` 仍能看到。
- 因此想让每条记忆都进 prompt，就在接近 48 条前跑 `/dream`；199 只是写入口径的硬上限。
- `/memory` 的 `Index:` 是写入口径（磁盘真相），`Inject:` 是注入窗口。

## 锁

| 层级 | 作用域 | 行为 |
|---|---|---|
| 进程内逻辑锁（按记忆目录分键） | 单次原语；或 dream 的整轮 | 最多等 `lock.timeoutMs`，超时抛一条写明目录的可读错误。`extract` 用不等待的形态，直接跳过本回合 |
| 跨进程 `.lock` | 每次重试调用毫秒级，只包住物理写入（重试风暴下可持有数秒） | 用 `open(…, "wx")`（`O_CREAT|O_EXCL`）建立 —— **创建**在 NTFS、ReFS、exFAT/FAT32 与网络共享的命名空间里是原子的，因此能排除使用同一共享的所有机器上的进程；在同步客户端目录里只能排除同机进程（见 [Windows](#windows)）。持有者记录在文件建立后立即写入。**永不自动回收**：无 TTL、无心跳、无接管 |

因此写入中途崩溃可能留下一个 `.lock`，而且**没有任何进程会替你删掉它** —— 这是「互斥是硬保证」的刻意代价。错误文案会写明 pid、op、开始时间与路径；`/memory unlock` 是唯一被认可的清除方式。

## 适配一个新的 harness

两个端口。其余的都在这里了 —— 磁盘格式、两级锁、快照、项目目录推导、dream / extract / 侧查询的
编排与 prompt 文本，以及 `memory` 工具的 JSON Schema、文案与分派逻辑。

```ts
export interface HeadlessRunRequest {
  task: string;                 // prompt 全文，由本包生成
  cwd: string;                  // 记忆目录
  model: string;                // 不透明：本包不解释、不校验
  effort?: string;              // 不透明：宿主的思考/推理档位
  maxTurns?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  builtinTools: "none" | "file-io";
  memoryTool: {                 // null = 不注入工具
    actions: readonly MemoryAction[];
    skipLogicalLock?: boolean;
    skipSnapshot?: boolean;
    onWrite?: (info: { action: MemoryAction; name?: string }) => void;
  } | null;
  sessionPersistence?: { enabled: boolean; sessionDir?: string };
}

export interface HeadlessAgentPort {
  /** completed / no-output / incomplete / not-run —— 见 `HeadlessOutcome`。 */
  run(req: HeadlessRunRequest): Promise<HeadlessOutcome>;
}

export interface HostTranscriptPort {
  searchSessions(cwd: string, query: string,
                 cfg: { maxSessions: number; maxMatches: number }): Promise<string>;
  toExtractMessages(raw: unknown[]): ExtractMessage[];
}
```

`HeadlessOutcome` 是 `run` 必须返回的结果，它是一个四分支 union：

```ts
type HeadlessOutcome =
	| { status: "completed"; text: string }
	| { status: "no-output" }
	| { status: "incomplete"; cause: "max-tokens" | "turn-limit" | "aborted" }
	| { status: "not-run"; cause: "host-refused" | "unavailable" | "timeout" | "aborted"; detail?: string };
```

**判别规则：请求发出之前就结束 → `not-run`；发出之后没拿到完整答案 → `incomplete`。**
（`no-output` 是「跑了但没有任何文本」；空回复是 `{ status: "completed", text: "" }`，不是 `no-output`。）

各任务的后果：

- **extract**：`not-run` → `{ skipped: true }`；`incomplete` → 跑过一部分（`{ skipped: false }`）；
  `no-output` → `{ skipped: false, result: "" }`。
- **dream**：任何非 `completed` 结果都会抛错（fail-closed）。
- **surfacing**：返回空结果（`{ files: [], content: "" }`）。

注意：这是新的 `HeadlessAgentPort` 必须返回的形状 —— `runTask` 建在它之上，不会退回到纯字符串。

`runTask(TASKS.autoSurfacing, input, ctx)`、`runTask(TASKS.extractMemories, input, ctx)`、
`runTask(TASKS.dream, input, ctx)` 都通过 `ctx.ports` 显式收端口 —— 没有模块级单例。

**注意白名单陷阱。** 如果宿主的 `tools` 选项是一个连 custom tools 一起过滤的白名单，那么
「关掉 builtin、只留 `memory` 工具」必须用别的方式表达。pi 的方式是 `noTools: "builtin"`；
在 pi 上传 `tools: []` 会把 `memory` 工具一起悄悄滤掉，于是 dream 一个原语都调不到却照样「成功」。

### 跨设备同步的编排层

同步分两层，分界与本包其余部分一致：

- `createSyncEngine` 收敛**一轮**：远端快照 + 本地扫描 + 上次基线 → 三方差集、冲突收敛、快照、落盘、
  重建索引、发布。
- `createSyncRuntime` 把一轮变成**会话级 runtime**：配置门禁、懒 engine、`prepare`、`startup` / `run` /
  `status` / `flush`、`changeRemote`、写触发与 `dispose`。

runtime 自己什么都不装配：backend、engine 与首份基线的 writer（`writeManifest`）都由适配层从本包公开
出口注入，另外注入自己的文案（`originDrift`、`uninitializedRemoteChange`，可选
`formatRemoteChangeFailure`）。core 拥有它们的生命周期与调用顺序，但既不选传输实现，也不读配置文件。

`scheduling` 是真实的会话行为选择，不是重构开关：

| 模式 | 谁在用 | 行为 |
|---|---|---|
| `concurrent` | pi | `startup` / `run` / `status` / `flush` 在公开调用返回前就起跑并登记为活动；并发 `prepare` 共用一次 flight。`changeRemote` 调用即关闸，已接纳的工作允许完成；关闸后的新操作直接拒绝 busy，不等待 |
| `serial` | dsh | `startup` / `run` / `status` / `flush` / `changeRemote` 排一条 FIFO；`changeRemote` 关闸前已接纳或排队的操作允许完成，关闸后的新操作直接拒绝 busy，不入队等待 |

两种模式共用同一条 `changeRemote` 持久顺序（关闸 → 排空 → dispose 旧 engine → 等它 `inFlight` 落定 →
删本项目 manifest → `setRemote` → 按同一流程建新空基线 → 恰好一次 replacement `noteWrite()`）与同一个
`dispose()` 契约：同步部分关闸、abort、dispose，返回的 promise 只 drain，**绝不** flush。dispose 前已经启动的
原子 manifest 写入可以在 drain 内完成，且会被等待；盘上因此可以留下一致的空 v2 基线，但不交付 engine，
也不补发 replacement trigger。dispose 后不新起 manifest 写入，drain resolve 后无残留或新启动的写入/I/O。

共同报告格式也在本包：`renderSyncRound` / `renderSyncStatus` 拥有字段集合、排序去重、失败轮展开与
revision 空/缺区分；`syncErrorMessage` 是全部同步错误文本唯一的归一化与脱敏出口，git backend 拼自己的
错误文本时复用同一个 `redactCredentials` 实现。展示策略仍归适配层：漂移提示与尾部行由宿主注入，
通知前缀与 notice/error 级别、错误账本留在宿主，宿主可在自己的出口再做配置词汇替换。

仍留宿主的事：哪个宿主事件调用 `startup` / `flush` / `dispose`（长寿命宿主可以完全没有退出 flush）、
命令解析与确认、通知与错误账本、索引的冻结/刷新策略，以及按会话保存的状态。

### 本包刻意不管的事

何时注入、以及 session 内的去重状态（pi 为命中前缀缓存把索引整个 session 冻结，而「每轮重算 section」的
宿主恰好相反，一个状态机装不下两种语义）、prompt cache 的录制/重放、工具 schema 转换与 UI/通知、模型解析
与校验（`model` / `effort` 是不透明字符串）、配置文件在哪与项目是否受信任、数会话数决定何时提醒
consolidate —— 这些都是适配层的事。

### 配置辅助

- `mergeConfig(base, overlay)` 把一个内存里的对象深合并进 `MemoryConfig`。宿主的配置**不是文件**时用它
  —— 比如 cordis 行在激活插件时递进来的 `config:` 对象。合并实现只有这一份；要读文件的适配层自己
  解析后把结果交给 `mergeConfig`。
- `EffortLevel` 是配置里所有思考/推理档位的类型。它是**不透明字符串**：core 原样透传，不解释、不校验。
  合法值属于宿主数据（dsh 里按 provider 路线而异），所以闭枚举是错的形状。`ThinkLevel` 是保留的别名。
- `modelConfigErrors(cfg, resolve, tasks?)` 与 `requiredModels(cfg, tasks?)` 收一个可选 `tasks`，
  让适配层声明**自己真正实现了哪些任务** —— 不必为它没有的任务索要模型（例如没有 dream 支持的
  适配层）。省略 `tasks` 时 dream 恒在必需集合内，另两个按 `enabled` 决定。
- `IMPLEMENTED_TASKS` 声明适配层实现了哪些任务；`/memory` 的模块行由 `moduleStatusRows(cfg, tasks)`
  派生 —— core 给行数据，措辞与顺序属于适配层。
- `pathConfigErrors(cfg, platform?, { configSource })` 校验 `memoryDir` 的**形状**，返回消息列表
  （空 = 通过）：POSIX 上的 Windows 盘符或 UNC 路径、win32 上以 `/` 或 `\` 开头的路径、空值、非字符串。
  否则 `resolve()` 会把它们变成**当前工作目录下的**一个目录 —— 记忆库会静默地在别处重新开始。
  对适配层它是致命错误（不建 store、不注册工具、没有索引段），这也是它与 `syncConfigErrors` 分开的
  原因（后者的失败只降级同步）。它刻意不碰文件系统：「根存在但不是目录」「悬空符号链接/联结」由
  `resolveMemoryDir` 报出。
- dream 的两个 nudge 键（`nudgeAfterSessions` / `nudgeAfterHours`）不属于 `MemoryConfig`：
  提醒策略是单宿主的关切，由适配层自己持有（pi 在 `PiHostConfig` 里）。

### pi 适配层的对应关系

| 需要 | core | pi |
|---|---|---|
| 索引进 system prompt | `buildIndexSection`、`truncateIndexForInjection`、`indexInjectionCapacity` | `systemPromptOptions.sections["memory_index"]` + transcript 重放 |
| 每轮浮现的记忆 | `scanEntries`、`runTask(TASKS.autoSurfacing, …)` | message 注入、session 内去重 |
| `memory` 工具 | `memoryToolSchema`、`MEMORY_TOOL_*`、`createMemoryActionHandler` | typebox + `ToolDefinition` + pi-tui 渲染 + `ctx.ui.notify` |
| dream / extract 轮次 | `runTask(TASKS.dream, …)`、`runTask(TASKS.extractMemories, …)`、prompt 文本 | `createPiHeadlessAgent` 里的 `createAgentSession` |
| 搜历史会话 | `HostTranscriptPort.searchSessions` | `SessionManager` |
| 跨设备同步 | `createSyncRuntime`、`createSyncEngine`、`createGitSyncBackend`、`renderSyncRound`/`renderSyncStatus` | `createPiSyncRuntime`（`scheduling: "concurrent"`）+ `memory.json` 配置、宿主事件、命令与通知 |

## Windows

pi-memory 在 Windows 上原生可用，不需要 WSL。

- **目录名。** 由项目 key 派生的名字一定是单个、合法的 Windows 分量：`\` 被当作分隔符（`C:\Users\you\proj` → `C_3a__Users__you__proj`），结尾的点或空格被十六进制转义（`proj.` → `proj_2e`），而「第一个 `.` 之前的部分」是保留设备名的名字会加 `_` 前缀（`nul` → `_nul`）。普通 remote 的 `git/` 目录名在所有平台上一致（`github.com__owner__repo`），因此共享 `memoryDir` 时同一仓库从 Linux 与 Windows 打开都会落到同一个目录。首段与保留设备名撞名（如 `aux.example.com/...`）、含反斜杠、或以点或空格结尾的 key，其目录名在两端仍可能不同。
- **仓库根。** 根路径取自 `git rev-parse --show-toplevel`：从仓库子目录启动与从仓库根启动映射到同一个记忆目录。注意该路径是按 git 的输出原样使用的，必须是原生 Windows 形态 —— Git for Windows 会打印 `C:/...`；若 PATH 上的 `git` 是 cygwin/MSYS 构建，它会打印 `/cygdrive/c/...` 这类 POSIX 形态路径，记忆目录会落到错前缀下。装了多个 git 时，把 Git for Windows 的 `git.exe` 放到 PATH 前面。
- **`memoryDir`。** `~`、`~/` 与（Windows 上）`~\` 都会展开；相对路径会被解析成绝对路径。Windows 路径与 UNC 共享都可用。**另一个平台**写法的值是配置错误，而不是「换个位置」：否则 `resolve()` 会把 `E:/shared/x` 落到 `<cwd>/E:/shared/x`（POSIX），或把 `/mnt/shared/x` 落到 `<当前盘>:\mnt\shared\x`（Windows）。空值、以及「根存在但不是目录」（含悬空符号链接/联结）同样会被拒绝，后者得到的是可读消息而不是裸 `ENOTDIR`。
- **锁。** 跨进程锁用 `open(…, "wx")`（`CREATE_NEW`）建立。在网络共享上这个原语在共享的单一命名空间里是原子的，因此锁能排除使用同一共享的**所有机器**上的进程 —— `memoryDir` 放在非 NTFS 卷上也能用。在**同步客户端目录**（OneDrive、Dropbox 等）里没有单一命名空间：每台机器各留一份副本，锁只能排除同一台机器上的进程 —— 不要用这种方式在多台机器间共享 `memoryDir`；需要跨机互斥时用网络共享。杀软、编辑器或索引器造成的瞬时 `EPERM`/`EACCES`/`EBUSY` 会做短退避重试；持续失败仍按原始错误报出。
- **换行符。** 读取记忆文件时一律容忍 CRLF 与孤立 CR（解析前归一为 LF），写入一律输出 LF。被记事本等 Windows 编辑器重新保存过的 `MEMORY.md` 或 entry 文件既不会从索引里消失，也不会推高「无法识别的行」计数。
- **已知限制。** 名字是保留设备名的文件（例如 `con.md`，由手工或在别的平台上创建）在 Windows 上会被**跳过**而不是被读取 —— 按该名字打开会到达控制台设备而不是文件。请改名（需用 `\\?\` 路径）或换名字重新写入这条记忆。在它存在期间，若再添加一条会派生到该名字的记忆（`CON` 现在派生 `_CON.md`），会得到第二个文件与第二条同名索引行；下一次 `rebuild_index`（dream 会定期调用）会清掉那条陈旧索引行。

