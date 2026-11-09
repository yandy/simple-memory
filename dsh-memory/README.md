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

本轮交付四件事：

- **`memory_index` system prompt 段** —— 把索引（`MEMORY.md` 的最新一段窗口）注入进每个 session 的
  system prompt，正文与 pi 注入的逐字相同。
- **`memory` 工具** —— 五个 action：`add` / `replace` / `remove` / `list` / `search`，schema 与
  handler 直接来自 core，模型看到的线格式与 pi 一致。
- **`/memory` 命令** —— 打印状态块（目录、索引容量、条目数、模块开关、锁持有者），`/memory unlock
  --force` 是清除崩溃遗留 `.lock` 的唯一入口。即使会话是以配置错误启动的（启动时目录没解出来），
  `unlock` 也会用会话的 cwd 按需重解一次目录再清锁 —— 它不能变成死路。
- **每轮自动召回（auto-surfacing）** —— 每一轮第一步之前，用一次零工具侧查询挑出与用户输入相关的
  条目，把正文包进 `<relevant_memories>` 插进进入该步的消息。

## 它不做什么

**`extractMemories` 与 `dream` 本轮没有实现**，包括 dream 的 nudge 提示与 `/dream` 命令。这两样在 dsh
侧需要先新造一个「一次性受限工具子会话」，风险与成本独立成下一刀。所以不要拿它当 pi-memory 的完全
对等物：**没有**每轮自动提取，**没有** `/dream` 整理，索引也不会在会话中途被冻结（见下）。

这两个键在行 config 里**能**通过校验（白名单与 core 的 `MemoryConfig` 逐字对齐，方便照抄 pi 的
`memory.json`），但写了不生效 —— 所以你写了它们时，`/memory` 的 `Modules:` 行会就地报
`dream=not implemented in this adapter`（`extractMemories` 同理）。

不冻结的原因是 dsh 每一步都重新装配 system prompt（pi 是整个会话冻结索引、回放录制值来护住 prompt
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

改代码后的开发回路：重新 `npm run build -w dsh-memory` 然后重启 dsh。卸载一条命令即可，同时摘掉
`dependencies` 与 `dsh.profile.bundles` 两处：

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

**缺模型或模型不可解析时，降级而不是关掉记忆**：只有 auto-surfacing 被关闭，`memory_index` 段与
`memory` 工具照常可用；降级原因显示在 `/memory` 的 `Modules:` 行（`autoSurfacing=off(<原因>)`）。
本轮 dsh 不实现 dream，所以**不会**像 pi 那样要求你配一个永远用不到的 `dream.model`。

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
- `MEMORY_TOOL_SNIPPET` → `memory_index` 段**开头**，且**恰好在该 session 注册了 `memory` 工具时**才出现
  （没有 runtime 的 session、子 agent 都拿不到它）。
- `MEMORY_TOOL_GUIDELINES` → **本轮在 dsh 没有落点**。宿主的 `ToolSchema` 只有
  `{name, description, parameters, deferLoading?}`，没有 pi 的 `promptSnippet` 通道，也没有放 guidelines
  的字段。这是与 pi 的一个已知差异。

## 开发

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # 顺序不能反：build 配置经 workspace 符号链接解析 core 的 dist/
npm test -w dsh-memory
```

设计保证：`dsh-memory/dist/**/*.js` 里 **零** `@deepseek-ai` 引用。宿主包全部只以 `import type`
出现（tsc 擦除），运行时能力经 `inject` 进来的 `ctx` 服务拿 —— 所以产物 `.js` 里没有宿主 import。
CI 用 `grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` 守这条（`.d.ts` 里出现宿主类型是合法的，
不算失败）。

## 验证状态

单元测试与跨 harness 共享测试全绿（dsh-memory `206 passed`，memory-core `489 passed | 4 skipped`，
pi-memory `200 passed`）。**尚未对真实运行的宿主验证**：装进真实 dsh profile 的端到端、以及召回消息
用 `form: "notice"` 时正文是否确实进模型（单测只钉住了「消息的 content 含完整正文、summary 是短摘要」，
真宿主行为待后续任务确认）。别把这两样当成已验证。
