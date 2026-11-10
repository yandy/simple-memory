# memory-core

与 harness 无关的、文件系统驱动的 AI coding agent 持久记忆层。一条 memory 一个 Markdown 文件，
`MEMORY.md` 索引每条记忆恰好一行，两级锁、快照回滚，以及围绕它们的 LLM 编排（合并整理、每轮提取、
相关性浮现）—— **不依赖任何 harness**。

适配层负责宿主专属的那一半：何时注入、怎么渲染、调哪个模型。本包负责必须处处一致的那一半，
于是同一台机器上的两个 harness 共享同一份记忆。

## 这里有什么

| 层 | 内容 |
|---|---|
| **磁盘格式** | 一条 memory 一个 Markdown 文件，带 YAML frontmatter（`name` / `description` / `type` / `created` / `modified`）；`MEMORY.md` 每条记忆恰好一行索引（`- [Name](file.md) — description`，em dash）；文件名由 `name` 推导 |
| **读写门面** | `MemoryStore` —— `listEntries` / `readEntry` / `readIndex` / `searchEntries` / `addEntry` / `replaceEntry` / `removeEntry` / `renameEntry` / `rebuildIndex`，外加逻辑锁 API |
| **并发与恢复** | 只持毫秒、永不自动回收的跨进程 `.lock`；按「一次原语调用」或「一整轮 dream」持有的进程内逻辑锁；瞬时错误重试；`.backups/<ts>-<label>/` 回滚点 |
| **路径与安全** | git remote 归一化成单个合法目录名、目录逃逸断言、注入净化、Windows 保留设备名处理 |
| **LLM 编排** | `TASKS` 里的三个任务描述符（`autoSurfacing` / `extractMemories` / `dream`）与 `runTask` 入口，及其 prompt 文本，跑在下面两个端口之上 |
| **注入策略** | 索引窗口（最新 N 行 / N 字节）、正文截断、容量口径、`scanEntries`、`renderSurfacedBlock` —— 全是返回字符串的纯函数 |
| **工具契约** | action 集合、JSON Schema、模型可见文案、`createMemoryActionHandler` |
| **配置** | 默认值、`mergeConfig` deep-merge、`~` 展开、模型配置校验、`defaultMemoryRoot()` —— 不读文件：适配层自己读文件后调 `mergeConfig` |

没有 LLM 调用、没有 UI、没有宿主 API：`src/**` 只 import `node:*` 与相对路径，
`tests/neutrality.test.ts` 会在这一点被破坏时让构建变红。

## 默认数据根

```
$XDG_DATA_HOME/simple-memory        # 未设置时 ~/.local/share/simple-memory
```

`defaultMemoryRoot()` 是「两个 harness 能共享同一份记忆」的原因：规则里既没有宿主名，也没有平台
分支，所以每个适配层都独立算出同一个目录。相对的 `XDG_DATA_HOME` 按 XDG 规范忽略 —— 相对根会让
「哪个项目用哪个目录」取决于 cwd。要改就用适配层配置里的 `memoryDir`。

根下面是 `<git|local>/<project>/`，由 git remote 推导（没有 remote 时用绝对路径），所以同一仓库的
clone 与 worktree 共享记忆。

## 存储布局

```
~/.local/share/simple-memory/git/github.com__owner__repo/
  MEMORY.md            — 索引：一行一条记忆（em dash 分隔）
  SSH-port-on-staging.md
  Test-command.md      — 一条记忆一个文件
  .lock                — 跨进程写锁（只持毫秒，永不自动回收）
  .backups/            — 回滚点：<ISO-ts>-<label>/（以及旧版 1.x 迁移留下的 migrate-<ts>/ 整目录快照）
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

### 容量：200 行索引 ≈ 199 条记忆

索引上限是 `memIndexMaxLines`（200）个非空行与 `memIndexMaxBytes`（25600）字节。这 200 行是**索引行，不是记忆条数**：`rebuildIndex` 至少保证一行头部（已有手写头部时原样保留 —— 首个条目之前的末尾空行会被去掉；否则写 `# Memory Index`），手写的标题、分组、注释同样占额度。因此重建后的索引最多约 **199 条记忆**（每个项目目录；若保留手写标题则更少）。超限时写入**不会失败**：写入照样成功，工具把一条可操作的警告回给模型，让它去合并或删除条目（超出上限的部分下次加载时不可见）。

**真正进模型的是另一个更小的窗口**：`memIndexInjectMaxLines` / `memIndexInjectMaxBytes`（默认 50 行 / 16384 字节）。窗口取索引的**最新**一端 —— 即**文件底部**：`memory(action="add")` 追加到末尾、`/dream` 的 `rebuild_index` 按 `modified` 重排。两种例外值得知道：`memory(action="replace")` 是**原地**重写那一行，被改写的老记忆会保持原位（可能就留在窗口外）直到下次 `/dream` 重排；而文件顶部的手写标题/分组/注释是**位置**语义而不是时间语义，索引一旦超过 50 行，先被丢出窗口的正是这块手工整理的内容。因此写满的索引恰好注入**最新的 50 条记忆**（窗口一旦截断，`# Memory Index` 头行与它下面的空行就落在窗口外）；48 条及以下则整份注入。被略过的记忆**没有丢**：auto-surfacing、`memory(action="search")` 与 `/dream` 整理都还能看到它们。`/memory` 用两行区分两套口径：`Index:` 是写入口径（磁盘真相），`Inject:` 是进 system prompt 的窗口。

这也是 `/dream` 不再是「可选的整理」而是**容量管理必需**的原因。两个阀值要分开看：prompt 可见性止于注入窗口，想让每条记忆都进 system prompt，就在**接近 48 条之前**整理；199 只是写入口径的硬上限，过了它索引自身就必须缩小。

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

`runTask(TASKS.autoSurfacing, input, ctx)`、`runTask(TASKS.extractMemories, input, ctx)`、
`runTask(TASKS.dream, input, ctx)` 都通过 `ctx.ports` 显式收端口 —— 没有模块级单例。

**注意白名单陷阱。** 如果宿主的 `tools` 选项是一个连 custom tools 一起过滤的白名单，那么
「关掉 builtin、只留 `memory` 工具」必须用别的方式表达。pi 的方式是 `noTools: "builtin"`；
在 pi 上传 `tools: []` 会把 `memory` 工具一起悄悄滤掉，于是 dream 一个原语都调不到却照样「成功」。

### 本包刻意不管的事

| 关注点 | 为什么留在适配层 |
|---|---|
| **何时**注入、以及 session 内的去重状态 | pi 为了命中 provider 的前缀缓存，会把索引在整个 session 内冻结；而「每次 assembly 重新求值 section」的宿主恰好要求相反。一个状态机装不下这两种语义 |
| prompt cache 优化（录制/重放冻结值） | 纯宿主机制 |
| 工具 schema 转换、UI 渲染、通知 | 宿主自己的 schema DSL 与 UI 通道 |
| 模型解析与校验 | 宿主自己的注册表；这里 `model` / `effort` 是不透明字符串 |
| 配置文件在哪、项目是否受信任 | 宿主知识；适配层自己读文件，把解析结果交给 `mergeConfig` |
| 数会话数以决定何时提示 consolidate | 需要宿主的会话存储 |

### 1.1.0 新增的配置辅助

- `mergeConfig(base, overlay)` 把一个内存里的对象深合并进 `MemoryConfig`。宿主的配置**不是文件**时用它
  —— 比如 cordis 行在激活插件时递进来的 `config:` 对象。合并实现只有这一份；要读文件的适配层自己
  解析后把结果交给 `mergeConfig`。
- `EffortLevel` 是配置里所有思考/推理档位的类型。它是**不透明字符串**：core 原样透传，不解释、不校验。
  合法值属于宿主数据（dsh 里按 provider 路线而异），所以闭枚举是错的形状。`ThinkLevel` 作为 deprecated
  别名保留，已有适配层的类型重导出不会破。
- `modelConfigErrors(cfg, resolve, tasks?)` 与 `requiredModels(cfg, tasks?)` 多了一个可选 `tasks`，
  让适配层声明**自己真正实现了哪些任务** —— 不再被迫为它没有的任务索要模型（例如没有 dream 支持的
  适配层）。省略 `tasks` 保持旧行为：dream 恒在必需集合内，另两个按 `enabled` 决定。

## 2.0.0 有什么变化

**配置文件 IO 下放给适配层。** core 不再读文件，旧的文件读取入口也删掉了。它仍保留配置的**语义**：
`DEFAULT_CONFIG`、`mergeConfig`、`defaultMemoryRoot` 与 `expandTilde`。适配层自己读自己的配置文件，把解析结果交给 `mergeConfig` ——
pi 就这么读它的两个 `memory.json`，dsh 也这么合并它的 cordis 行 `config:` 对象。文件在哪、项目
是否受信任，是宿主知识，留在适配层。

**三个模型任务现在是一等对象。** `autoSurfacing`、`extractMemories`、`dream` 是声明在 `TASKS` 里的
任务描述符，唯一的入口是 `runTask(task, input, ctx)`：它自己读 config、造 prompt、施加该任务的
锁/快照计划、再跑端口。旧的三个 `run*` 函数删掉了。`HeadlessAgentPort.run` 现在返回
`HeadlessOutcome`（`completed` / `no-output` / `incomplete` / `not-run`）而不是 `string | null`，
端口因此能区分「跑了但没写出东西」与「根本没跑」。每个适配层用 `IMPLEMENTED_TASKS` 声明自己实现了
哪些任务，`/memory` 的模块行由 core 的 `moduleStatusRows(cfg, tasks)` 派生 —— core 给行数据，措辞与
顺序仍是适配层自己的事。

**dream 的 nudge 键移出共享配置。** `memory.json` 的键名不变、仍挂在 `dream` 下，但 core 不再拥有
它们：pi 把它们读进自己的 `PiHostConfig`（默认值 5 / 24），它们不再是 `MemoryConfig` 的一部分。
提醒策略是单宿主的关切，属于适配层而不是共享的 core。

### pi 适配层的对应关系

| 需要 | core | pi |
|---|---|---|
| 索引进 system prompt | `buildIndexSection`、`truncateIndexForInjection`、`indexInjectionCapacity` | `systemPromptOptions.sections["memory_index"]` + transcript 重放 |
| 每轮浮现的记忆 | `scanEntries`、`runTask(TASKS.autoSurfacing, …)` | message 注入、session 内去重 |
| `memory` 工具 | `memoryToolSchema`、`MEMORY_TOOL_*`、`createMemoryActionHandler` | typebox + `ToolDefinition` + pi-tui 渲染 + `ctx.ui.notify` |
| dream / extract 轮次 | `runTask(TASKS.dream, …)`、`runTask(TASKS.extractMemories, …)`、prompt 文本 | `createPiHeadlessAgent` 里的 `createAgentSession` |
| 搜历史会话 | `HostTranscriptPort.searchSessions` | `SessionManager` |

## Windows

pi-memory 在 Windows 上原生可用，不需要 WSL。

- **目录名。** 由项目 key 派生的名字一定是单个、合法的 Windows 分量：`\` 被当作分隔符（`C:\Users\you\proj` → `C_3a__Users__you__proj`），结尾的点或空格被十六进制转义（`proj.` → `proj_2e`），而「第一个 `.` 之前的部分」是保留设备名的名字会加 `_` 前缀（`nul` → `_nul`）。普通 remote 的 `git/` 目录名在所有平台上一致（`github.com__owner__repo`），因此共享 `memoryDir` 时同一仓库从 Linux 与 Windows 打开都会落到同一个目录。首段与保留设备名撞名（如 `aux.example.com/...`）、含反斜杠、或以点或空格结尾的 key，其目录名在两端仍可能不同。
- **仓库根。** 根路径取自 `git rev-parse --show-toplevel`：从仓库子目录启动与从仓库根启动映射到同一个记忆目录。注意该路径是按 git 的输出原样使用的，必须是原生 Windows 形态 —— Git for Windows 会打印 `C:/...`；若 PATH 上的 `git` 是 cygwin/MSYS 构建，它会打印 `/cygdrive/c/...` 这类 POSIX 形态路径，记忆目录会落到错前缀下。装了多个 git 时，把 Git for Windows 的 `git.exe` 放到 PATH 前面。
- **`memoryDir`。** `~`、`~/` 与（Windows 上）`~\` 都会展开；相对路径会被解析成绝对路径。Windows 路径与 UNC 共享都可用。
- **锁。** 跨进程锁用 `open(…, "wx")`（`CREATE_NEW`）建立。在网络共享上这个原语在共享的单一命名空间里是原子的，因此锁能排除使用同一共享的**所有机器**上的进程 —— `memoryDir` 放在非 NTFS 卷上也能用。在**同步客户端目录**（OneDrive、Dropbox 等）里没有单一命名空间：每台机器各留一份副本，锁只能排除同一台机器上的进程 —— 不要用这种方式在多台机器间共享 `memoryDir`；需要跨机互斥时用网络共享。杀软、编辑器或索引器造成的瞬时 `EPERM`/`EACCES`/`EBUSY` 会做短退避重试；持续失败仍按原始错误报出。
- **换行符。** 读取记忆文件时一律容忍 CRLF 与孤立 CR（解析前归一为 LF），写入一律输出 LF。被记事本等 Windows 编辑器重新保存过的 `MEMORY.md` 或 entry 文件既不会从索引里消失，也不会推高「无法识别的行」计数。
- **已知限制。** 名字是保留设备名的文件（例如 `con.md`，由手工创建或旧版本在别的平台上创建）在 Windows 上会被**跳过**而不是被读取 —— 按该名字打开会到达控制台设备而不是文件。请改名（需用 `\\?\` 路径）或换名字重新写入这条记忆。在它存在期间，若再添加一条会派生到该名字的记忆（`CON` 现在派生 `_CON.md`），会得到第二个文件与第二条同名索引行；下一次 `rebuild_index`（dream 会定期调用）会清掉那条陈旧索引行。

## 开发

```sh
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # biome
npm run build     # tsc -p tsconfig.build.json → dist/（ESM + .d.ts）
```

monorepo 内以 `src/**` 为准；`dist/` 是给普通 Node 进程消费的（发布出去的包不能只带 `.ts` ——
Node 拒绝 strip `node_modules` 下的类型）。相对 import 都带显式 `.js` 后缀，编译产物才能解析。

## License

MIT
