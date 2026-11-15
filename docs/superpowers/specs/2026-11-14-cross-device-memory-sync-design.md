# 跨设备记忆同步：清单驱动的引擎 + git 作为第一个 backend

日期：2026-11-14
状态：**待批准（已过一轮建造者审阅，13 条问题的裁定见 §7）**
范围：`memory-core` 新增同步引擎（三方差集 + 冲突收敛）、`SyncBackend` 端口与 git 实现、一个新的
「逐字落盘 entry」写入原语；`pi-memory` / `dsh-memory` 各自接线（配置、命令、触发点）。
前置：无（不依赖任何未交付的 spec）。
依据：本轮与用户的 brainstorming 决策（§3）、对 `memory-core/src/store/**`、`memory-core/src/config.ts`、
`memory-core/tests/neutrality.test.ts`、`pi-memory/index.ts`、`dsh-memory/src/{index,row-config,extract}.ts`、
`docs/guides/{architecture,dependencies,testing,release}.md` 的代码勘察、一次针对「索引参与 git 合并」的
实测（§4.3），以及 pi 宿主文档的 `session_shutdown.reason` 取值。

---

## 1. 意图

同一个人会在 2–3 台设备上开发同一个项目。今天每台设备的记忆是**各自独立**的：
`~/.local/share/simple-memory/git/<host__owner__repo>/` 在台式机上攒下来的东西，笔记本看不见。
于是同一件事被重新学一遍，`/dream` 在两台机器上各自把索引整理成不同的形状，而"记忆跟着人走"这个
整个仓库的立论（README 第一句：*One on-disk memory, shared by every AI coding agent you run*）在设备
维度上是断的 —— 目前只在**同一台机器的不同 harness 之间**成立。

这一刀把共享维度从「同一台机器上的多个 harness」扩到「同一个人的多台设备」。

## 2. 为什么是现在

- 磁盘布局已经预留了跨机场景：`git/<host__owner__repo>/` 这个目录名由**归一化后的 remote** 算出，
  同一个仓库在任何机器上都算出同一个目录名 —— 同步需要的 join key 已经存在，不需要新造标识。
  `store/filename.ts` 的注释里也早写着「git 类记忆目录跨机共享，名字必须在两边都安全」。
- entry 文件的 frontmatter 里有 UTC ISO 的 `modified`，`rebuildIndex()` 又完全按它排序 ——
  跨设备的定序与索引重建**已经**有确定语义，不需要引入向量时钟。
- 用户明确要求：私有 git 仓库作为第一个 backend，未来可能加 S3 等（U3）。这决定了端口必须与
  「本地有一个目录可以 clone」这个假设解耦。

## 3. 用户已定的决策

逐条来自本轮对话，不是我的推断：

| # | 决策 | 后果 |
|---|------|------|
| U1 | v1 只同步 **git 类项目**（`<root>/git/**`），`local/<绝对路径>` 不同步 | 绕开「两台机器绝对路径不同 → 目录名对不上」这个无解问题 |
| U2 | 2–3 台设备，同一个人，**基本串行**使用；但不同设备会开发同一个项目 | 不需要 CRDT / 向量时钟；需要的是"陈旧设备开写"的确定性收敛 |
| U3 | backend = **私有 git 仓库**，由本功能通过 `child_process` 驱动 git；未来可能加 S3 等 | 端口按内容级设计（§6.5），git 只是第一个实现 |
| U4 | 触发 = **自动 pull（会话开始）+ 自动 push**，手动命令保留 | 失败必须降级成"退回手动"，绝不阻塞会话（§6.11） |
| U5 | 冲突策略 = **两份都留**：写入时间新的一份留在原文件，旧的一份另存为一条新记忆，交给 `/dream` 收拾 | 引擎不需要人工介入路径；冲突产物是正常 entry（§6.4） |
| U6 | 实现走**方案 2：清单驱动引擎 + git 只当传输**（§5） | 记忆目录保持干净（无 `.git`）；三方差集自己算 |
| U7 | 自动 push 由**写入触发**（不是盲节流）：任何一次成功的 memory 写入之后推送；配退出兜底与下次开始补推 | 需要去抖（一轮 `/dream` 写十几个文件不能推十几次）；键名与语义见 §6.8 / §6.9 |
| U8 | 被挤出来的那份记忆，`name` 后缀 = **该份内容自己的写入日期 + 6 位内容指纹** | 后缀是内容的函数 → 两台设备独立解同一次冲突会写出同一个文件名，自动收敛（§6.4） |

## 4. 现状与硬约束

### 4.1 一个项目目录里有什么

`<root>/git/<host__owner__repo>/`：`MEMORY.md`（索引）、每条记忆一个 `*.md`（frontmatter：
`name`/`description`/`type`/`created`/`modified`）、`.lock`（跨进程锁文件）、
`.backups/<ts>-<label>/`（快照，保留 `lock.snapshotKeep` 份，默认 5）、`.dream-meta.json`、
`sessions/`（headless 子会话转录）。

### 4.2 `MEMORY.md` 是派生物，但不是**纯**派生物

`rebuildIndex()`（`store/memory-store.ts`）把「第一条已识别行之前的所有行」当手写头部逐字保留，
其余条目行按 `compareSummaries` 重建 —— `modified` 升序、同刻按文件名。索引为空时头部退化成
`["# Memory Index", ""]`。`parseEntryIndex` / `upsertIndexLine` / `removeIndexLine` 也都是外科式的，
刻意保留用户手写的分组、标题、注释行。

结论：**条目部分**完全由 entry 文件决定，两台设备重建结果逐字节一致；**头部**是设备本地的。
所以只要索引不参与同步，重建就是安全的收敛点 —— 代价是手写的索引分组不会跟着人走（§6.1）。

### 4.3 实测：索引参与 git 合并必然冲突

两台设备各自新增**互不相干**的条目（`c.md`/`d.md` vs `e.md`），索引都在末尾追加行：

```
# 索引参与同步
Auto-merging MEMORY.md
CONFLICT (content): Merge conflict in MEMORY.md      merge exit=1

# 索引 .gitignore 掉，只同步 entry 文件
Merge made by the 'ort' strategy.   c.md | 1 +   d.md | 1 +      merge exit=0
```

三个 entry 文件干净合入，索引却炸了 —— 因为两边在同一位置追加行。这条实测是「索引不同步、
本地重建」的直接依据，也是用户自己先提出来的疑虑。它会变成 §9 的一个回归测试。

### 4.4 写入通道是一条，且它会重写时间戳

`MemoryStore` 的注释写明「进程级唯一写入通道。所有对 memory 目录的修改必须经它」。但 `addEntry`
会 `modified: now.toISOString()` 并重新派生 `description`，`replaceEntry` 同样重打 `modified`
（只保留 `created`）。

**因此同步不能复用这两个原语**：`modified` 正是跨设备定序与冲突判定的唯一依据，被本地时间覆盖后
索引顺序会失真、冲突收敛会失效（§6.4 的后缀也取自它）。需要一个「逐字落盘」的新原语（§6.6）。

### 4.5 两级锁，整轮独占有既定契约

进程内**逻辑锁**（`store/process-lock.ts`，按 `memoryDir` 分键）承担逻辑作用域；跨进程 `.lock`
只持毫秒级、**永不自动回收**（无 TTL / 心跳 / 接管）。整轮独占的既定写法是 `withLogicalLock()`
包住整轮 + 内部调用传 `{ skipLogicalLock: true }`，并有 `logicalLockActive()` 自检。
`tryWithProcessLock` / `tryWithLock` 提供非阻塞版本 —— dream 与 extract 拿不到锁就跳过本轮，
这是本仓库既有的取向。`process-lock.ts` 的注释也明确承认「同仓库的多个 worktree 共享 memory 目录」
是既有场景，所以同一台机器上会有多个项目目录同时活跃（§6.7 的锁粒度由此而来）。

### 4.6 `memory-core` 的中立性是一道**测试门**

`memory-core/tests/neutrality.test.ts` 扫 `src/**` 的 import 说明符（只许 `node:*` 与相对路径），
并额外禁止这些字面量出现在 core 源码里：`§<数字>`、`D<数字>` 决策编号、斜杠命令 `/memory`、
宿主事件名 `session_start|agent_end|before_agent_start|session_compact|session_shutdown`。

对本文档的约束：core 的同步模块只能用**中立词汇**（"会话开始时拉取"这种散文可以，事件名不行），
且不得引用本 spec 的章节号。`child_process` 调 git 是被允许的（`store/paths.ts` 已有先例：
`promisify(execFile)` + 3s 超时 + 失败返回 null）。

### 4.7 未来的 S3 backend 进不了 core

第三方 SDK 会直接违反 §4.6 的门。所以它只能是独立包（如 `@yandy0725/memory-sync-s3`）实现 core
导出的端口，由适配层装配。这决定了端口不能假设"有一个本地工作树"（§6.5）。

### 4.8 两个 harness 的触发点不对称

- **pi**：索引在 `before_agent_start` 被冻结进 `systemPromptOptions.sections["memory_index"]`，
  整个会话不再变（只有 compaction 重读）。所以 pull + `rebuildIndex()` 必须排在它**之前**。
  `session_shutdown` 带 `reason: "quit" | "reload" | "new" | "resume" | "fork"`（Ctrl+C/Ctrl+D/SIGHUP/
  SIGTERM 走 `quit`），且宿主的 `dispose()` 是 **await 且没有超时** —— 一次慢推送会把退出/切会话
  阻塞满整个网络往返，所以退出兜底推必须有独立短预算（§6.8）。pi 侧已有 `inFlight` 账本 +
  `session_shutdown` 里"等在途写操作收尾（上限 `lock.timeoutMs`）"，在途推送要登记进去。
- **dsh**：`agent/disposed` **不可靠**（`dsh-memory/src/extract.ts` 的注释记录了实测：太晚，长寿命
  宿主进程里等于永不触发）。所以 dsh 没有退出兜底推，靠写触发 + 下次开始补推。
- 两侧都已有"写入发生"的现成挂点：pi 的 `memory` 工具有 `onWrite` 回调（`agent_end` 里就在用它
  统计本轮写了几条），dsh 的工具包装同理。core 只需要一个中立的 `noteWrite()`（§6.8）。

### 4.9 用户可能已经自己把记忆目录做成了 git 仓库

`pi-memory/README.md` 的迁移一节明确提到「If your memory directory is a git repository
(a `~/.pi/memory/git/.git` checkout, say), the `mv` takes the `.git` directory with it」。
本功能不碰根目录的 `.git`（§6.2 用独立暂存仓库），但初始化时必须处理这种共存（§6.12）。

### 4.10 单宿主策略键不得进 core 的配置契约

`docs/guides/dependencies.md`：*「像 pi 的 `dream.nudgeAfterSessions` / `dream.nudgeAfterHours` 这类
『只服务一个宿主』的键，只属于那个宿主的配置（pi 侧的 `PiHostConfig`），不得进 `MemoryConfig`。
core 的配置契约只收两个宿主共有的语义。」* 而 dsh **没有**宿主配置层：它的行 config 白名单
`ROW_CONFIG_KEYS` 是从 `Object.keys(DEFAULT_CONFIG)` 派生的（`dsh-memory/src/row-config.ts`），
不进 core 默认值的键会被当成 `unknown config key` 告警并忽略。

结论：§6.9 的每一个 sync 配置键都必须是**两个宿主共有的语义**，否则它根本无处安放。

### 4.11 sync 的配置错误不能走既有的致命通道

pi 侧 `modelConfigErrors` 的唯一消费者是启动路径上的 `failConfig`，后果是**整个记忆层不初始化**：
不解析目录、不建 store、不注册 `memory` 工具、没有索引段。少写一个同步 URL 就丢掉全部记忆功能，
与 §6.11 的铁律直接冲突。dsh 侧形状不同（`apply` 绝不抛错，坏配置进 `resolved.error` 由 `/memory`
打印）。所以 sync 的校验必须有自己独立的、**非致命**的出口（§6.9）。

## 5. 方案对比

| | 机制 | 代价 |
|---|------|------|
| **1** | 记忆根目录本身就是 git 工作树，`.gitignore` 排掉范围外文件，`git pull` 直接合并 | 代码最少，白拿 git 的三方合并/删除传播/历史；但 `.git` 进用户数据目录，与用户自建仓库撞车（§4.9），且引擎与 git 强绑定 —— 未来 S3 要重写 |
| **2（选中）** | 清单驱动引擎，git 只当传输：`<root>/.sync/` 下一个独立暂存 clone + 每项目一份 manifest，引擎自己算 base/ours/theirs 三方差集 | 代码量最大（清单、hash、原子应用、回滚都自己写）；磁盘多一份副本；换来可插拔端口、与用户 git 彻底隔离、删除与冲突语义完全自定义 |
| **3** | 方案 2 的抽象 + 方案 1 的机制：接口按清单设计，但 git 实现内部用暂存工作树做三方 diff | 比 1 隔离、比 2 少写 diff；但"冲突由 git 报、应用由我们做"两套语义要对齐，接缝最容易藏 bug，且 S3 实现拿不到"白拿 merge"这个便宜，两条 backend 内部结构不对称 |

**选 2 的理由**（U6）：用户已明说未来要加 S3。方案 1 到那天要重写引擎；方案 3 的 git backend 与
S3 backend 会长成两个形状，接口被迫向 git 妥协。方案 2 要自己写的三方差集其实很小 —— 只有
「按逻辑路径的 add / modify / delete」三种，且 entry 文件是**不可变整体**（没有行内合并需求），
比通用目录同步简单一个量级；而且它恰好是最容易纯函数单测的部分，符合本仓既有测试风格。

## 6. 设计

### 6.1 同步范围与远端布局

**在范围内**：`<root>/git/<project>/` 下的 entry `*.md`（即 `MemoryStore.#entryFiles()` 的路径口径：
以 `.md` 结尾、不是 `MEMORY.md`、不以 `.` 开头），**且能被 `parseEntryFile` 解析**（§6.6）。

**明确不在范围内**：

| 路径 | 为什么 |
|------|--------|
| `MEMORY.md` | 本地派生物，pull 后 `rebuildIndex()` 重建（§4.2、§4.3）。代价：手写索引分组是设备本地的 |
| `.lock` | 跨进程锁文件永不自动回收；同步过去等于在另一台设备造一把假死锁 |
| `.backups/` | 每次写入一份快照，同步会让体积在设备间乘倍，且它是本地回滚点 |
| `sessions/` | headless 子会话转录，体积大、是本地执行痕迹。**后果**：`memory search scope=sessions` 只搜得到本机历史。跨设备搜历史会话是另一个功能（体积与隐私都要重算），v1 不做 |
| `.dream-meta.json` | dream nudge 的"上次 dream 时间"，按设备本地更合理（各机器会话数各自累计） |
| `<root>/local/**` | U1 |
| `<root>/.sync/**` | 本功能自己的状态（§6.2） |

**v1 每次只同步当前项目**（会话解析出的那个 `<root>/git/<project>/`），不是整个根。理由：逻辑锁是
按 `memoryDir` 分键的，同步整个根要对每个项目目录取锁 —— 另一个会话正在项目 B 里跑 `/dream` 时，
整根同步要么等要么跳过，语义糊掉。按当前项目同步把锁作用域收成一个目录，其他项目在各自的会话里
同步。远端仓库仍然是**一个**，布局镜像 `<root>`。

**远端路径的 key 必须平台无关**（这是远端数据格式，用户仓库一旦有数据就难迁移）：

```
远端路径 = git/<remoteProjectKey>/<entry 文件名>
remoteProjectKey = projectDirName(identity.key, { platform: "linux" })   // 恒按非 win32（= POSIX）规则派生
```

`NodeJS.Platform` 里没有 `posix` 这个值，而 `projectDirName` 只在 `win32` 上分支，所以传任一非 win32 值（这里用 `linux`，与既有测试同口径）就是 POSIX 规则。`projectDirName` 在 win32 上还有两条额外变换（`\` 参与分段、`windowsSafeName` 改写结尾的 `.`/空格
与保留设备名），`paths.ts` 顶部也记录了 cygwin 构建会打印 POSIX 形态路径这个已知限制。任何一种都
会让两台设备算出**不同**的目录名 → 远端出现两个目录、各同步各的、静默分叉。恒用 POSIX 规则派生
远端 key 就与本地平台解耦；本地目录名与远端 key 不同时（win32 的那几种情况），由 `projectIdentity(cwd)`
在同步时现算映射（不需要存储），`status` 把映射关系报出来。

### 6.2 磁盘布局

```
<root>/                              # 例如 ~/.local/share/simple-memory
├── .sync/                           # 本功能的全部状态；不参与同步
│   ├── device.json                  # { id: <持久 uuid>, hostname, createdAt }
│   ├── sync.lock                    # 根级跨进程锁（复用 store/fs-lock.ts 的 tryWithLock）
│   ├── repo/                        # git backend 的暂存 clone（工作树 + .git）
│   └── state/<project-key>.json     # 每项目一份 manifest（§6.3）
└── git/<project>/                   # 用户数据，保持干净：没有 .git，没有新增文件
```

- `device.json` 的 `id` 用于提交作者与 `status` 报告；它本身绝不同步。**不参与冲突副本的命名**（U8
  的后缀只由内容派生，见 §6.4）。
- 暂存 clone 用**工作树**而不是 bare + plumbing：porcelain（`fetch`/`reset`/`add`/`commit`/`push`）
  比 `mktree`/`commit-tree`/`update-ref` 好推理、也好人工抢救；多占的磁盘与记忆文本同量级。
  *（我的判断：日后体积若成为问题，可以在不改端口的前提下换成 bare + `GIT_INDEX_FILE`。）*
- `<project-key>` 就是 §6.1 的 `remoteProjectKey`（已经过转义与截断，可安全做文件名）。

### 6.3 三方差集

manifest（`.sync/state/<project-key>.json`）：

```jsonc
{
	"version": 1,
	"base": { "revision": "<git commit sha>", "syncedAt": "<ISO>" },
	"files": {
		"foo.md": { "hash": "<sha256(bytes)>", "modified": "<frontmatter modified>", "bytes": 1234 }
	}
}
```

三个集合：**base** = 上次成功同步的 manifest；**ours** = 本地当前扫描；**theirs** = 远端当前状态。
逐逻辑路径判定（hash 相等即"同"）：

| base | ours | theirs | 动作 |
|------|------|--------|------|
| 同 | 同 | 同 | 无 |
| 有 | 改 | 同 | 推（本地胜） |
| 有 | 同 | 改 | 拉（远端胜） |
| 有 | 改 | 改 | **冲突** → §6.4 |
| 有 | 删 | 同 | 远端删 |
| 有 | 同 | 删 | 本地删 |
| 有 | 删 | 改 | **冲突** → §6.4（改的一方按新 entry 留下，删除照办） |
| 有 | 改 | 删 | **冲突** → §6.4（同上，镜像） |
| 无 | 加 | 无 | 推 |
| 无 | 无 | 加 | 拉 |
| 无 | 加 | 加 | **冲突** → §6.4（内容 hash 相同则视为同一个，无冲突） |

hash 用 sha256（`node:crypto`，`store/paths.ts` 已在用）。**内容相同不算冲突**这条让"两台设备都跑了
同一次 `/dream`"这种常见情况零噪声。

差集是**纯函数**：输入三个 `Map<path, {hash, modified}>`，输出 `{ pull, push, delete, conflicts }`，
不碰 IO —— 上表就是它的完整真值表，实现与单测直接照它（§9）。

首次同步（无 manifest）时 base 为空集：一台**空**的新设备拉下全部远端条目、零冲突（最常见的
onboarding 路径）；一台**已有**记忆的设备与远端同名的条目会走冲突分支，产生带后缀的副本，交给
`/dream` 合并（§6.12 会在初始化时明确告知）。manifest 读不懂（版本不认识、JSON 坏）一律当"无 base"
处理，等价首次同步 —— 不会静默丢东西，最坏是多产生几条冲突副本。

### 6.4 冲突收敛

同一逻辑路径两边内容不同时：

1. **谁留在原文件**：按 frontmatter `modified` 取新的一方；`modified` 相同则按内容 sha256 字典序取
   大的一方。两个判据都只依赖**内容**，所以两台设备独立算出同一个结果 —— 幂等，不依赖谁先推。
2. **被挤出来的那一份**写成一条**新 entry**：
   - `name` 加后缀 ` (冲突 <该份内容的 modified 日期> <该份内容 sha256 的前 6 位>)`，
     例如 `发布状态 (冲突 2026-11-09 3fa1b2c)`（U8）；
   - 文件名由 `entryFileName(新 name)` + `resolveUniqueFileName()` 派生；
   - frontmatter 的 `created` / `modified` / `type` / `description` **原样保留**，只改 `name`。
   - 后缀的两个成分都是**这份内容的函数**，因此台式机与笔记本各自解同一次冲突会写出**同一个**
     文件名 → 下一轮它们是"两边都加了同一个路径、内容相同" → 收敛成一份，不会越同步越多。
     *（这是建造者审阅抓到的真 bug：我最初写的后缀含本地 hostname 与当天日期，那会让两台设备各造
     一份永不收敛的重复。设备归属信息改放在 git 提交信息与作者里，`git log` 可查，不进文件名。）*
3. 两者都进索引（pull 后统一 `rebuildIndex()`），`/dream` 的既有职责（合并重复、解决矛盾、重建索引）
   负责后续收敛。
4. **删除 vs 修改**：删除照办，被修改的那份内容按第 2 步留下 —— 没有任何一方丢内容。
5. 新 `name` 要过 `MemoryStore.#validateName` 的既有校验；后缀约 22 字符，撞长度上限时按既有截断
   规则处理（截断后仍带指纹，确定性不丢）。

*（我的判断：不另设 `.sync-conflicts/` 之类的归档目录。这个策略下"被挤出来的那份"就是一条正常记忆，
没有残骸需要保管；`.backups/<ts>-sync/` 的整目录快照仍然是"引擎自己有 bug"时的兜底，它被
`snapshotKeep` 裁剪可以接受，因为收敛本身不丢内容。）*

### 6.5 `SyncBackend` 端口

引擎只认端口，不认字符串 id。端口形状由"未来要有 S3"倒推（§4.7）：**不得**出现「本地工作树」
「clone」「commit」这类 git 专属概念。

```ts
/** 远端一次快照的只读视图。 */
export interface RemoteView {
	/** 不透明标识，写回 manifest 的 base.revision。git: commit sha；S3: manifest 对象的 etag。 */
	readonly revision: string;
	/**
	 * 远端在 `scope.prefix` 下的全部路径 + 内容 hash。
	 * **路径相对于 `scope.prefix`**（因此就是单层 entry 文件名），与引擎差集的 key 同域。
	 * **hash 恒为 sha256(bytes) 的十六进制小写** —— 这是端口契约的一部分，不是实现细节：
	 * manifest 与三方差集都直接与它比较。backend 若原生只有别的标识（git blob sha1、S3 的
	 * ETag/MD5），由 backend 自己负责换算（读内容后算 sha256，或自己存一份 sha256 清单对象）。
	 */
	list(): Promise<Array<{ path: string; hash: string }>>;
	/** 取内容。只会被 list() 报出的路径调用。 */
	read(path: string): Promise<string>;
	/**
	 * 远端存在、但不属于本 scope 的 entry 的路径（**仓库根相对**）。纯报告用：引擎把它抄进
	 * 同步结果与 `status`，让人知道远端有东西没被同步（有人手工推了 `MEMORY.md`、`local/...`、
	 * 或 scope 下的嵌套目录）。**不得静默丢弃范围外路径**；无法廉价判断的 backend 返回 `[]`。
	 */
	readonly outOfScope: string[];
}

/**
 * 远端内的一个前缀。v1 恒为 `git/<remoteProjectKey>`（§6.1）；backend 只在该前缀内活动，
 * 因此引擎不必知道远端还有别的项目。
 */
export interface SyncScope {
	readonly prefix: string;
}

export interface SyncBackend {
	/** 是否已初始化（暂存 clone 是否存在等）。false 时自动路径直接跳过（§6.11）。 */
	ready(): Promise<boolean>;
	/** 首次初始化：只由显式命令触发（§6.12）。 */
	init(opts: SyncRunOptions): Promise<void>;
	/** 拉取远端最新状态。 */
	fetch(scope: SyncScope, opts: SyncRunOptions): Promise<RemoteView>;
	/**
	 * 把「从 `base`（= 本次 fetch 到的 theirs）到合并结果」的**增量**发布到远端，返回新的 revision。
	 * 用增量而不是完整文件集：S3 这类 backend 只需 PUT/DELETE 变化的对象，不必重传全量。
	 * 端口不承诺原子，但要求 backend **要么整体成功、要么抛错且不留下半推状态**
	 * （git 天然是一个 commit；S3 需要清单对象 + 条件写）。
	 * `base.revision` 用于乐观并发：远端已经不在 base 上时抛 NonFastForward（§6.11）。
	 */
	publish(
		scope: SyncScope,
		changes: { writes: Array<{ path: string; content: string }>; deletions: string[] },
		base: { revision: string },
		opts: SyncRunOptions & { message: string; author: { name: string; email: string } },
	): Promise<string>;
}

/** 每次 backend 调用的运行参数。timeoutMs 由调用方按"自动/手动"两档给（§6.9）。 */
export interface SyncRunOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}
```

**v1 不提供 backend 注册表，配置里也没有 `backend` 键**（有 `remote` 就是 git）。理由是本仓既有
取向：「任何一项策略如果不是至少一个消费者真的需要，就不许进」。加 S3 那天再引入 `backend` 键是
**新增键**，不破坏既有配置。同理，`list()` **不带** per-file 设备归属 —— U8 已经让归属信息对收敛
不再必要（§6.4）。

**git backend 实现要点**（`memory-core/src/sync/backend-git.ts`）：

- 全部走 `execFile("git", [...])`（不是 shell），带 `timeoutMs`、`cwd: <root>/.sync/repo`、
  可选 `signal`；沿用 `store/paths.ts` 的口径（`promisify(execFile)` + catch）。
- `fetch()`：`git fetch --quiet origin <branch>`；`list()` 用 `git ls-tree -r --name-only -z FETCH_HEAD`
  （**整棵树**，且**必须带 `-z`** —— 不加时 git 会把非 ASCII 路径 C-quote 成八进制转义形式，中文文件名
  会全部落到 `outOfScope`，一条都同步不了且不报错）再分类：在 `<scope.prefix>/` 下且去掉前缀后不再含 `/` 的 → 进 scope，其余 →
  进 `outOfScope`；再用**一次** `git cat-file --batch` 读出范围内全部 blob 并逐个算 sha256
  （`ls-tree` 给的是 blob sha1，与端口契约的 sha256 不同源；记忆文本量小，一次批量读比维护两套
  hash 语义简单）。
- `read()` 复用同一次 `cat-file --batch` 的结果（`fetch()` 内部缓存），不额外 spawn。
- `publish()`：`git reset --hard origin/<branch>`（暂存 = theirs）→ 写入 `changes.writes`、删除
  `changes.deletions` → `git add -A -- git/<project-key>`（限定路径，不吞用户随手丢进暂存目录的
  东西；`-A` 让删除也进索引）→ `git commit`（作者 = `device.json`）→ `git push origin <branch>`。
  因为我们的 commit 是 theirs 的子提交，push 是快进。**不触发任何 git merge** —— 三方差集已经在
  引擎里算完了。
- push 撞上非快进（fetch 与 publish 之间另一台设备推了）：抛 `NonFastForward`，引擎整轮重跑，
  上限 1 次；仍失败则本轮放弃（manifest 的 base 不前进），下次再来。

### 6.6 新的 store 写入原语

同步必须走「唯一写入通道」（§4.4），但既有的 `addEntry` / `replaceEntry` 会重打 `modified`。
新增一个原语（`MemoryStore` 方法，从 `src/index.ts` 导出）：

```ts
/**
 * 逐字落盘一批 entry 文件 + 删除一批 entry 文件，**不**重新派生 description、**不**改
 * created/modified、**不**碰 MEMORY.md。调用方负责之后统一 rebuildIndex()。
 * 走同一条 #pipeline（进程内 mutation 队列 → 跨进程 .lock → 重试），因此与所有既有写入互斥。
 * 返回实际落盘/删除/拒收的清单，供调用方报告。
 */
async applyEntryFiles(
	changes: { writes: Array<{ file: string; raw: string }>; deletes: string[] },
	options?: WriteOptions,
): Promise<ApplyResult>;
```

**它不是"纯逐字"，落盘前逐份校验并拒收**（`ApplyResult.rejected`）：

- `parseEntryFile(raw)` 返回 null → 拒收（坏 frontmatter 的文件落盘后对 store 静默不可见）。
- `name` / `created` / `type` 过不了既有的 `#validateName` / `#validateCreated` / `isEntryType` →
  拒收。**理由**：一个 `name` 里含 `](` 的远端条目，逐字落盘后经 `rebuildIndex()` 会直接伪造索引行
  —— 那正是 `#validateName` 存在的唯一后果（`removeIndexLine` 删错行、真条目变孤儿）。逐字写入
  绕过了 `addEntry` 的校验，所以校验必须搬到这个原语里。
- 路径 fail-closed：只接受单层 `.md` 文件名（不含分隔符、不是 `MEMORY.md`、不以 `.` 开头、
  不是 win32 保留设备名），否则整批抛错（远端内容里的畸形路径不得逃出目录）。
- **大小写 / Unicode 规范化碰撞检测**：落盘前把整批 `writes` 按平台相关的折叠规则
  （win32/darwin 大小写不敏感、NFC/NFD）归一成 key，若批内自相撞、或与目录里既有文件相撞
  （沿用 `sameFile` 与 `#resolveTargetFile` 的磁盘探测思路），**跳过该文件并记进 `rejected`**，
  绝不静默写穿同一个 inode。2–3 台设备里只要有一台 mac 或 Windows 就会碰到：`Foo.md` 与 `foo.md`
  在 Linux 上是两条合法记忆，在 APFS/NTFS 上是同一个文件。

其余约束：

- 逐字写入字节（`parseEntryFile` 的 CRLF 归一只发生在**解析**入口，写回不改行尾，与既有行为一致）。
- 每个被写/被删/被拒的文件都要 `#cache.delete(file)` —— auto-surfacing 的注入清单来自这个 mtime
  缓存，漏掉会让本会话继续用旧正文。
- `options` 沿用 `WriteOptions`：整轮已快照时传 `{ skipLogicalLock: true, skipSnapshot: true }`。

**本地扫描口径**同步改为「`#entryFiles()` 的路径过滤 + `parseEntryFile` 能解析」（即 `listEntries()`
的口径）。差集因此只对**可解析**的 entry 成立；解析不出的本地 `.md` 不参与同步，由 `status` 报一行
「本地有 N 个无法解析的 .md，未同步」—— 不推上去污染远端，也不让用户毫不知情。

**一个有意的读路径收窄**（建造者审阅提出、已裁定）：`isEntryFileName` 把「含 `/` 或 `\`」也判为
不合格，而 `MemoryStore.#entryFiles()` 现在复用它 —— 于是在 POSIX 上，一个名字里**字面含反斜杠**的
`.md` 文件（ext4/APFS 允许，但 store 自己永远造不出来：`entryFileName` 的 `UNSAFE` 类会剔掉 `\`）
不再出现在 `listEntries()` / 搜索 / dream 里。这是对既有可见集合的收窄，记在这里而不是悄悄发生：

- **为什么接受**：这种文件只能来自手工创建或外部工具。若留在读路径里，它会被同步扇描收进
  manifest、推到远端，然后在**对端**的 `applyEntryFiles` 触发整批 fail-closed 抛错 —— 一个怪文件
  会让两台设备的同步全断。收窄到"看不见"的代价是一条记忆不可见（文件仍在盘上，重命名即恢复），
  比"同步全断"轻。
- **迁移**：无需动作。它也不会被 `status` 报出来（与任何非 `.md`、点开头的文件同样对待）——
  只有"能看见但解析不了"的文件才进 `unparsable` 报告。

### 6.7 锁与快照

**锁拆两段，两把锁永不嵌套**（建造者审阅指出：整轮持一把根锁会把网络时间算进去，同机开两个项目
会话时后启动的那个整轮跳过，而 pull 一次会话只有一次机会）：

```
① 传输段   tryWithLock(<root>/.sync/sync.lock, "sync")     # 保护共享的 .sync/repo；忙 → 跳过本轮
             backend.fetch() → RemoteView（含内容）
           释放根锁
② 应用段   store.tryWithLogicalLock(...)                   # 当前项目的进程内逻辑锁；忙 → 跳过本轮
             三方差集（纯函数）
             createSnapshot(.backups, "sync", 全部 entry + MEMORY.md, keep)   # 本轮会改本地才做
             store.applyEntryFiles(合并结果, { skipLogicalLock: true, skipSnapshot: true })
             冲突副本落盘（同一条原语）
             store.rebuildIndex({ skipLogicalLock: true, skipSnapshot: true })
             写回 manifest（base 前进到新 revision）
           释放逻辑锁
③ 发布段   tryWithLock(<root>/.sync/sync.lock, "sync")     # 忙 → 放弃本次发布，下次补推
             backend.publish(合并结果, base)
           释放根锁
```

- 两把锁都用 **try 语义**，任一忙就跳过并记一条可读原因（与 dream / extract 同款）。因为不嵌套，
  锁序论证比"根锁在外"更强：不可能成环。
- ②与③之间根锁被放开，另一个进程可能抢先发布 → ③ 撞非快进 → 整轮重跑一次（§6.5）。
- **push 轮会不会改本地？会。** 「先收敛再发布」意味着远端有新东西时，push 轮也要拉进来、也可能
  产生冲突副本、也要 `rebuildIndex()` → **所以要快照**。唯一的例外是远端 `revision === base.revision`
  （最常见情况）：此时无事可收敛，直接发布，零本地写入、不快照。
- pull 轮与 push 轮共用同一套①②③骨架，区别只在 pull 轮跳过③。

### 6.8 触发点

core 的引擎只提供中立入口：`syncPull()` / `syncPush()` / `syncStatus()` / `noteWrite()`。
**什么时候调是适配层的事**（§4.6 的字面量禁令也要求这一点）。

**pull**

| harness | 挂点 |
|---------|------|
| pi | `session_start` 内、**在 `before_agent_start` 冻结索引之前**（§4.8）。成功后索引快照才是新鲜的 |
| dsh | `agent/created` 内，在每轮召回（`agent/pre-step` waterfall）第一次读索引之前 |

**push（U7：写入触发 + 去抖，不是盲节流）**

1. **写触发**：任何一次成功的 memory 写入（`add`/`replace`/`remove`/`rename`/`rebuild_index`、
   `/dream` 整轮结束、extract 落盘）由适配层调 `noteWrite()`，把当前项目标脏并安排一次去抖推送。
   两侧都已有现成挂点（pi 的 `memory` 工具 `onWrite` 回调、dsh 的工具包装）。
2. **去抖**：`pushDebounceMs`（默认 5000）静默期内的多次写入合并成一次推送。一轮 `/dream` 写十几个
   文件 → 一次推送。锁天然帮了忙：dream 整轮持有项目逻辑锁，期间的推送尝试在②拿不到锁就跳过，
   整轮结束后去抖定时器才触发。
3. **退出兜底**（仅 pi，因为 dsh 的 `agent/disposed` 不可靠）：`session_shutdown` 无条件再推一次
   （不看去抖），但有独立的短预算 `autoTimeoutMs`，超时就放弃并提示"下次会话开始时补推"。**不按
   `reason` 分支** —— `quit`/`new`/`resume`/`fork`/`reload` 都推，因为切会话同样是"人要换设备"的信号。
4. **补推**：pull 轮结束后若发现本地有未发布成功的变更（上次推送失败留下的），顺手推一次。这是
   失败自愈路径，不单独设开关，跟着 `enabled` 走。*（我的判断：关掉它没有合理场景。）*

**定时器与在途账本的硬要求**：去抖定时器必须 `unref()`（pi 的 `session_shutdown` 注释明确警告
"漏一个定时器就把退出拖满超时"），且在途推送必须登记进 pi 既有的 `inFlight` 账本，退出时才会被等；
dsh 侧对应挂进它的 per-session 清理账本，`agent/disposed` 时销账。

### 6.9 配置

`MemoryConfig` 新增可选子树（core 只给默认值与合并语义，**不读也不写任何配置文件**；由适配层从
pi 的 `memory.json` / dsh 的行 `config:` 读出后交给 `mergeConfig`）：

```jsonc
{
	"sync": {
		"enabled": false,        // opt-in：自动往远端写数据必须由用户显式承担（同 extractMemories）
		"remote": "",            // git 远端 URL；init 时用它，之后真相来源是暂存 clone 的 origin（§6.12）
		"branch": "main",
		"pullOnStart": true,     // 会话开始时自动 pull
		"pushOnWrite": true,     // 写入后去抖自动 push（U7）
		"pushDebounceMs": 5000,  // 写触发的静默期；一轮 dream = 一次推送
		"autoTimeoutMs": 5000,   // 自动路径（pull / 兜底推）每次 git 子进程上限
		"timeoutMs": 20000       // 手动命令每次 git 子进程上限
	}
}
```

每个键都是**两个宿主共有的语义**（§4.10）：`pushDebounceMs` 对 pi 与 dsh 的写触发都生效，退出兜底
是 pi 自己的接线细节、**不设键**（dsh 没有可靠挂点，不是"配了不生效"而是"这个键不存在"）。

`autoTimeoutMs` 与 `timeoutMs` 分两档的理由：自动 pull 被 await 在会话启动路径上，离线/VPN 未连时
若按 20s 计，**每开一次会话都卡满 20s**（一轮 pull 至少两次 git 子进程）。自动档给 5s，手动命令
（用户显式在等）给 20s。

**校验是非致命的**（§4.11）：core 导出 `syncConfigErrors(cfg): string[]`（形状仿 `modelConfigErrors`，
但**不进** `modelConfigErrors`，避免被 pi 的 `failConfig` 消费成"整个记忆层不初始化"）。适配层拿到
非空列表时：把 sync 当成**未启用**，用一条可读通知 + `/memory` 状态行报出来，其余记忆功能照常。

### 6.10 命令面

`/memory` 增加 `sync` 子命令（与既有 `/memory unlock` 同款 `args` 字符串解析）：

| 命令 | 行为 |
|------|------|
| `/memory sync` = `/memory sync status` | **dry-run**：本地领先 N 条、落后 M 条、冲突 K 条（列文件名），上次同步时间与 revision、设备 id、远端与分支、本地目录名 ↔ 远端 key 的映射、被拒收/未同步的文件清单。不改任何文件 |
| `/memory sync pull` | 立即收敛远端变更 + `rebuildIndex()` |
| `/memory sync push` | 先收敛再发布（§6.7） |
| `/memory sync init <remote-url>` | 首次初始化（§6.12） |
| `/memory sync remote <url>` | 改暂存 clone 的 origin（`git remote set-url`）。**不写用户配置文件** —— core 与适配层都没有改 `memory.json` 的既有能力，不为此开先例 |

`/memory` 的状态区（目录、索引容量、条目数、上次 dream、锁状态）追加一行同步状态。
`status` 的 dry-run 几乎免费 —— 引擎本来就要算差集。dsh 侧提供同一组子命令（它已有 `/memory`）。

### 6.11 失败模式与降级矩阵

**铁律：任何同步失败都不得阻塞会话、不得损坏本地记忆。** 最坏结果永远是"退回手动"。

| 情况 | 行为 |
|------|------|
| `sync.enabled` 为 false / `remote` 为空 | 自动路径静默跳过；`/memory sync` 报"未配置"并给出 `init` 用法 |
| sync 配置校验不通过（§6.9） | 当成未启用 + 一条可读通知；**其余记忆功能照常** |
| PATH 上没有 git | 同上，报"git 不可用"（`execFile` 失败口径同 `store/paths.ts`） |
| 暂存 clone 不存在（未初始化） | 自动路径跳过 + 一条提示"跑 `/memory sync init`"。**自动路径绝不偷偷 clone**（首次 clone 可能几十秒） |
| 配置的 `remote` 与暂存 clone 的 origin 不一致 | `status` 报一行并指向 `/memory sync remote <url>`；同步仍按 **origin** 走（§6.12） |
| 离线 / fetch 失败 / 认证失败 | pull 跳过 + 一条提示；不重试到卡住会话（受 `autoTimeoutMs` 上限） |
| publish 失败 | 本地状态原样保留，manifest 的 base **不前进**，脏标记留着 → 下次写触发或下次会话补推 |
| 子进程超时 | `execFile` 的 `timeout` 杀掉；按失败处理 |
| publish 非快进 | 整轮重跑 1 次，仍失败则留到下次（§6.5） |
| 暂存 clone 损坏 / 卡在 merge 中间态 | `git reset --hard` + 重试 1 次；仍失败报"请手动检查 `<root>/.sync/repo`"，不再自动动它 |
| 逻辑锁忙（dream 在跑）或根 sync 锁忙 | 跳过本轮 + 记原因（§6.7） |
| 远端出现范围外的路径（有人手工推了 `local/...` 或 `MEMORY.md`） | 忽略，不拉到本地；backend 经 `RemoteView.outOfScope` 报上来，`status` 报一行 |
| 远端文件解析不出 frontmatter / 过不了 name·created·type 校验 | **拒收**，不覆盖本地同名文件，`status` 报一行（§6.6） |
| 远端文件与本地/批内发生大小写或 Unicode 规范化碰撞 | **跳过**该文件 + `status` 报一行，绝不静默写穿（§6.6） |
| 本地有解析不出的 `.md` | 不参与同步，`status` 报一行（§6.6） |

所有提示都要能在**无 UI** 的 headless 路径下安全降级（沿用适配层既有的 `hasUI` 判据）。

### 6.12 首次设置与接管既有仓库

**`remote` 的真相来源是暂存 clone 的 origin**，不是配置文件。理由：core 不写配置文件（§4.6），
pi/dsh 也没有改用户配置文件的既有能力，而 `init` 收到的 URL 必须有地方落地 —— 落在它自己的
clone 里最诚实。配置里的 `sync.remote` 因此只是"未初始化时的期望值"；两者不一致时以 origin 为准，
`status` 报出来并指向 `/memory sync remote <url>`（§6.10）。

`/memory sync init <remote-url>`：

1. 检查 `<root>/.sync/repo` 不存在（存在则报"已初始化，当前 origin 是 X；要换用
   `/memory sync remote <url>`"—— 给得出路，不是死胡同）。
2. `git clone <remote-url>`（远端是空仓库时 `git init` + `remote add` + 建 `<branch>`）。这一步可能慢，
   所以只由显式命令触发。
3. 写 `device.json`（uuid + hostname）。
4. **接管检查**：若发现 `<root>/.git` 存在 —— 用户自己把记忆根做成了仓库（§4.9）：
   - 它的 remote 与我们要配的**相同** → **拒绝**初始化并解释（两个写入者推同一个远端是丢数据的
     标准姿势）；
   - **不同** → 警告但允许（各推各自的地方，互不干扰）。
   *（我的判断：分界按"是否同一个远端"划，因为那才是真正会互相覆盖的情形。）*
5. 若本地已有记忆：明确告知"与远端同名的条目会按 §6.4 产生带后缀的副本，下次 `/dream` 会合并"，
   然后询问是否立即 push。
6. 成功后写 manifest（base = 当前远端 revision）。

### 6.13 恢复的会话看不到新同步来的记忆（已知语义，不是 bug）

pi 在 `resume` / `fork` / `reload` 三种 reason 下**刻意**用 transcript 的录制索引值而不是磁盘值
（改动它会破坏 prompt cache，而 `memory_index` 是头部的最后一段；`docs/guides/architecture.md`
把 prompt 与磁盘格式列为"不得顺手改"的用户契约）。所以这三种路径上：pull 照样跑、磁盘照样更新，
但**本会话的 system prompt 里看不到**同步来的记忆，直到 compaction 重读。

裁定：**接受这个语义，不动录制值**。文档与 `/memory sync status` 要能解释它（"本会话的索引在会话
开始时已冻结"），README 的同步一节明写。

## 7. 建造者审阅的裁定

一轮 builder check 提出 13 个问题（2 个是本设计的真 bug、2 个是文档自相矛盾、其余是缺口）。
逐条裁定如下，「归属」列区分用户决策与我的判断：

| # | 问题 | 裁定 | 归属 |
|---|------|------|------|
| 1 | 冲突副本的 name 含本地 hostname/日期 → 两台设备各造一份、永不收敛 | 后缀改成**内容的函数**：该份内容的 `modified` 日期 + sha256 前 6 位（§6.4） | **用户（U8）** |
| 2 | `sync.remote` 的真相来源？`init` 要不要写配置文件 | origin 是真相来源；不写用户配置文件；新增 `/memory sync remote <url>`（§6.10、§6.12） | 我的判断 |
| 3 | sync 配置错误是致命还是降级 | **降级**：独立的 `syncConfigErrors`，不进 `modelConfigErrors`/`failConfig`（§6.9、§4.11） | 我的判断 |
| 4 | `pushIntervalMs` 是 dsh 专属键，违反"单宿主键不进 core" | 写触发 + 去抖后，`pushDebounceMs` 成为**两宿主共有**语义 → 合法进 core；退出兜底不设键（§6.8、§6.9、§4.10） | 我的判断（触发方式来自 **U7**） |
| 5 | 远端 entry 要不要过既有校验；本地解析不出的 `.md` 算不算范围 | `applyEntryFiles` **前置校验并拒收**（否则 `name` 带 `](` 能伪造索引行）；本地口径改用可解析集，坏文件不同步但 `status` 报出来（§6.6） | 我的判断 |
| 6 | 大小写 / Unicode 规范化碰撞（mac ↔ Windows 写穿同一 inode） | apply 前整批碰撞检测，命中就跳过 + 报告，不静默覆盖（§6.6、§6.11） | 我的判断 |
| 7 | pi 的 push 按哪些 `reason` 触发；§6.7 自相矛盾（push 到底改不改本地） | 不按 `reason` 分支（切会话同样是换设备的信号）；矛盾修掉 —— push 轮先收敛，**会**改本地，因此**要**快照，仅当远端未动时零写入不快照（§6.7、§6.8） | 我的判断 |
| 8 | `resume`/`fork`/`reload` 时 pull 结果进不进本会话 prompt | 不进（录制值不动，prompt cache 是用户契约）；作为已知语义写进文档与 `status`（§6.13） | 我的判断 |
| 9 | 自动 pull 的时间预算与退避 | 两档预算：自动 `autoTimeoutMs` 5s、手动 `timeoutMs` 20s；不做退避状态（失败即跳过，下次会话再试）（§6.9） | 我的判断 |
| 10 | 根锁罩住整轮（含网络）→ 同机多项目互相跳过 | 锁拆两段（传输段持根锁、应用段持项目逻辑锁），两把锁永不嵌套 → 不可能成环（§6.7） | 我的判断 |
| 11 | 远端布局 key 用平台相关的 `projectDirName()` 会静默分叉 | 远端 key 恒按 **POSIX** 规则派生（`remoteProjectKey`），与本地平台解耦；映射现算，`status` 报出（§6.1） | 我的判断 |
| 12 | `list()` 的 hash 算法是不是端口契约 | **是**：sha256 写进端口注释，换算责任在 backend（§6.5） | 我的判断 |
| 13 | 适配层对 core 的依赖范围要不要一起提 | 要：提到 `^2.1.0`，否则 `^2.0.0` 会解析到 2.0.1、装上能跑但调新原语时运行时炸；发布顺序见 §10 | 我的判断 |

## 8. 留给建造者的部分

- 三方差集纯函数的文件划分与签名（建议 `sync/diff.ts`）—— §6.3 的表是完整真值表，照它实现与单测。
- `git cat-file --batch` 的具体解析（二进制安全、缺 blob、超大输出的分块）。
- manifest 的原子写（临时名 + rename，沿用仓库既有写法）。
- 冲突副本 `name` 撞 `#validateName` 长度上限时的截断细节（截断后必须仍带指纹，§6.4）。
- 大小写/规范化折叠的具体规则表（darwin 的 NFD、win32 的大小写与保留名，`windows-names.ts` 已有
  一半）。
- 提示文案（中英）与 `/memory` 状态行的排版。注意 `scripts/prompt-hygiene.ts` 只管工具提示词三通道，
  同步提示不进 prompt，不受它约束。
- `noteWrite()` 在两个适配层各自接到哪几个写入点（pi 的 `onWrite` 之外，`/dream` 整轮结束与 extract
  落盘也要接）。
- dsh 的在途推送挂进哪个 per-session 清理账本。
- 测试的临时仓库怎么建（建议 `git init --bare` 一个本地路径当 remote，避免碰网络）。

## 9. 测试策略

对齐 `docs/guides/testing.md` 与既有风格：

- **纯函数单测**：三方差集全真值表（§6.3 的 11 行 + 内容相同不算冲突 + 首次同步的空 base +
  manifest 读不懂当空 base）。
- **冲突收敛单测**：§6.4 的后缀是内容的函数 —— 同一份败者内容从两个不同"本地设备"上下文各解一次，
  断言产出的 `name`、文件名、frontmatter **逐字节相同**（这条直接锁死 #1 那个 bug 不复发）。
- **引擎集成测试**：注入假 backend（内存 Map），断言 pull/push 后的磁盘状态、索引重建结果、
  manifest 前进、脏标记与去抖、"锁忙就跳过"、"远端未动时零本地写入"。
- **git backend 集成测试**：真实的临时 bare 仓库 + 两个工作副本模拟两台设备，跑完整剧本 ——
  「A 改 → B 改同名 → 碰面 → 两份都在索引里且名字确定」、「各自新增不同条目 → **零冲突**」
  （§4.3 的实测变回归测试）、「A 删 → B 改 → 碰面 → 删除照办且改的那份成为新 entry」。
- **原语单测**：`applyEntryFiles` 保留 `modified`/`created`、拒收坏 frontmatter 与非法 name、
  路径 fail-closed、碰撞跳过、清缓存、与既有写入互斥。
- **中立性门**：新增的 `memory-core/src/sync/**` 自动被 `neutrality.test.ts` 扫到 —— core 里不得出现
  宿主事件名、斜杠命令或 `§` 编号（§4.6）。
- **平台**：CI 的 ubuntu + windows 两档都要跑（仓库既有矩阵）。git 在两个 runner 上都有；windows 上
  注意既有的 sharing-violation 处理（`store/fs-retry.ts`）与 2a668fc 那类"超时被 runner 吃掉"的坑。
- **不新增依赖** → `package-lock.json` 不变 → `lockfile-sync` / `check:host-deps` /
  `check:memory-core-deps` 都应无感通过。

## 10. 交付切分与发布

四刀，各自可独立评审：

1. **core**：`applyEntryFiles` 原语 + 三方差集 + 引擎 + git backend + `syncConfigErrors` + 全部测试
   （§6.1–§6.7）。公开面只从 `src/index.ts` 出。
2. **pi 接线**：config 子树、pull/push 触发点与 `noteWrite()` 接线、`/memory sync` 子命令、状态行、
   双语 README。
3. **dsh 接线**：同上，触发点按 §6.8 的不对称处理（无退出兜底推）。
4. **文档**：`README.md` / `README.zh.md` 的同步一节（含 §6.13 的已知语义）、
   `docs/guides/architecture.md` 补 `.sync/` 布局与端口约定、`docs/guides/dependencies.md` 若
   `pushDebounceMs` 的归属需要补充说明。

发布按 `docs/guides/release.md`，并注意 #13：**core 先发**（minor → 2.1.0，新增公开面无破坏），
两个适配层的 `dependencies` 同批提到 `^2.1.0`。`registry-smoke` 的两段式窗口要排好 —— 适配层的刀
在 core 2.1.0 上 registry 之前合并会硬失败（"适配层已发布/已声明而范围不存在"），所以顺序是
core 合并 → core 发布 → 适配层合并 → 在同一条合并提交的 workflow 上重跑 `registry-smoke`。
`npm version` 会用 2 空格缩进重写 `package.json`，发布后不要手改，直接
`npx biome format --write <包>/package.json` 再提交。

## 11. 第一刀（memory-core）交付后的遗留清单

第一刀已实现并通过最终整分支审阅（`memory-core` 705 passed + 5 skipped、dsh 282、pi 228，
typecheck / lint / format / build / 三道 `check:*` 全绿，`package-lock.json` 零变化，未发布）。
审阅判定 **With fixes → 修复波已做完一轮**（R57–R62 六条全部落地并经 scoped re-review 确认），
re-review 又报出 1 条 Important + 6 条 Minor 的残留。按流程**不开第二轮修复波**，逐条裁定如下，
并把载重项显式交给后续三刀 —— 这份清单是那些裁定的**入库**记录（执行台账在 git-ignored 的
`.superpowers/sdd/` 下，会随工作区消失，所以载重项必须落在这里）。

### 必须先修，再开始第二刀（载重：适配层接线时会读到/用到）

1. **`src/sync/paths.ts` 的 `syncRootPath` 文档里有一句假话**（re-review 的 Important）：它说
   `.sync` "会被算进项目目录的内容里（备份排除清单、`snapshotFiles` 扫的就是这一层）"。两处都不成立 ——
   仓库里没有任何"备份排除清单"（同一文件 18 行之上的 `SYNC_DIR_NAME` 文档已经改成实话，两处现在互相矛盾），
   而 `.sync` 以点开头，`#entryFiles` / `scanLocalEntries` / `snapshotFiles` **全都看不见它**。
   这句恰好把因果讲反了：传错目录的后果是**静默**的（没有任何测试会红），而不是"会被扫描器抓到"。
   这是本分支上第 7 例"注释与代码不符"，而它落在第二/三刀决定"该把哪个目录传给 `syncRootPath`"时
   唯一会读的那段公开文档上。改成实话：传错的后果是 `.sync` 落进项目目录 → 每项目一份暂存 clone、
   根锁退化成每项目一把，且**没有任何测试会红**。
2. **`SyncScheduler.flush` 的接口文档少一种情形**：它写"返回 `null` 的三种情形"并承诺"会等那一轮收尾"，
   而修复波新增的 `if (disposed) return null` 是第四种情形、且**不等** `inFlight`。接线方（pi 的退出兜底）
   正是照这段文档决定要不要 `await inFlight` 的。
3. **`SyncRunOptions.timeoutMs` 的字段文档口径过时**：仍写"单次远端往返的上限"，而修复波把语义改成了
   "本次调用的**总预算**，调用内多次往返共享"（一次 `fetch` 是 fetch + ls-remote + ls-tree + cat-file
   四五个往返）。字段文档是未来的独立包 backend 实现者最先读的东西。

### 归第二/三刀（适配层接线）

- **端口的自省面（M6）**：设计 §6.12 把 origin 定为 `remote` 的真相来源、§6.11 要求"配置与 origin
  不一致 → `status` 报一行"、§6.10 要求 `/memory sync remote <url>`，但端口目前既不能读 origin 也不能改
  origin，`init()` 也不交出引导后的 revision（于是 §6.12 第 6 步要适配层用 `init()` → `fetch()` →
  `writeManifest` 三个公开符号拼）。**裁定：留到第二刀加**，因为 core 还没带着 sync 发布过，
  加成员不是破坏性变更。
- **根 `sync.lock` 的清除入口（M10）**：`tryWithLock` 对遗弃锁是**抛错**而不是返回 null（刻意设计），
  所以一次崩溃会让此后每一轮同步都失败，文案是"delete the file to clear it"；而既有 unlock 入口针对
  `<memoryDir>/.lock`，够不到 `<syncRoot>/sync.lock`。第二/三刀**必须**把 unlock 扩到这个文件
  （或提供 `sync unlock`），否则"一次崩溃 → 永久不同步 + 用户得手工 rm 一个隐藏目录里的文件"。
- **`init()` 由适配层直接调、不经引擎的 `positiveMs` 兜底**，所以 `timeoutMs` 为 `NaN` 会直接透传给
  `execFile`（与修复波之前同级，不是回退）。接线时把配置校验过的值传进去。
- **`pull()` / `push()` 在 `dispose()` 之后仍会跑一整轮**（引擎层没有 disposed 守卫，`flush` 有）——
  这个不对称接线时顺手统一。
- 渲染契约（见 §6.11 与执行台账的 R45/R49/R52）：失败轮也要摊开 `pulled`/`conflicts`/`rejected`、
  按文件去重、`flush() === null` **不是**成功判据（只有 `ok` 是）、退出前必须 `await engine.inFlight`。
- windows CI 腿上有 10 条 skip（chmod / 符号链接），意味着"目录读不了要上抛"与"符号链接 stat 的 errno
  分流"这两条数据安全线在 windows 上从未执行过。接线期间补 `vi.mock` 版本（样板：`tests/sync-scan.test.ts`
  的委托缝）。
- `pullOnStart` 在 core 里**没有消费者**（引擎只在被调用时干活），接线时必须照 `=== true` 判定。

### 归第四刀（文档）

- 本文件 §6.6 仍写 `isEntryFileName`，修复波已把它按方向拆成 `isEntryFileNameForRead(name, platform)`
  与 `isEntryFileNameForWrite(name)`（网络进来的名字一律走写方向）。§6.5 的端口形状也要跟上
  （`RemoteView.outOfScope` 的判据是"异常"而不是"不在本 scope 内"、`SyncRunOptions.signal` 现在真的被接线、
  `timeoutMs` 是一轮的总预算）。
- 把实测性能数量级写进 `docs/guides/architecture.md`：300 条 CJK 记忆下 `init` 39ms、首次 push 183ms、
  **空转 pull 72–77ms**、`status` 78ms。它是 O(远端总字节) 而非 O(变更量) —— 把"上万条时该换成 oid 缓存"
  这个触发条件写明，免得将来有人当它是 O(变更) 去优化别处。

### 已裁定为"不修"（附理由，免得下一个人再提第三次）

- **不抽 `writeJsonAtomic`**：`manifest.ts` 要的是原子替换，`device.ts` 要的是排他创建 + 发布后读回 +
  无硬链接时退回覆盖 —— 两套语义，抽出来必然带 flag，而 flag 会掩盖排他性边界的论证。真正重复的只有
  `tempPath` 那 3 行。（这个决定已写进两个文件的注释。）
- **`modified` 用字典序而非时间序比较**：混合时区偏移时时间上更旧的一侧可能胜出，但两台设备仍然一致、
  两份都留 —— 不丢内容、不破坏收敛。要改就是改设计的定序键，属于另一件事。
- **R39（`cat-file --batch` 按 `\n` 分帧、符号链接也是 blob）不在本刀修**：两条触发路径的后果都推演过，
  都是 fail-closed 而非错位落盘（名字含换行 → 帧字段失配 → 抛错；符号链接 blob → `parseEntryFile`
  返回 null → `rejected`），且都需要"手工往自己的私有同步仓库推畸形内容"。真正的修法动的正是测试最密的
  那段代码，应与 S3 backend 的 hash 语义讨论合并成一次独立改动。
- **`conflict.ts` 删掉尾部线性扫描的结论正确**（审阅者用 `dist/` 对 20 万个随机主干、约 1600 万次求值
  暴力验证了单调性，0 处违反），但它留下的理由不是载重的那条：真正的理由是"`build(keep)` 的字节长度对
  `keep` 单调不减"，而不是"头部发生什么都不影响结尾"（`con.` 补 `_` 前缀恰恰是头部影响长度的例子）。
  连同四处错字（"绍不"→绝不、"兵底"→兜底、"桶穿"→捅穿、"成败失败"）、`engine.ts` 一处 import 顺序、
  以及"一轮预算被传输段吃光时首次尝试仍带着 1ms 去 publish、于是用户看到 `timed out after 1ms`
  而不是说得清的 budget 文案"（行为安全：基线不前进、脏标记留着、下一轮接着推），一起归第二刀顺手清理。
- **一条不可达的升级风险，仅记录**：R57 之后远端的 `con.md` 会被归成范围外而不进 `theirs`；假如某个
  **更早的构建**已经把它发布出去并写进了基线，"base 有 / ours 有 / theirs 无"会被读成"远端删了它"→
  `deleteLocal`。今天不可达（sync 从未随 core 发布过），若这条分支曾被真机 dogfooding 过，
  第二刀接线时扫一眼既有 manifest。

## 12. 规模

按上面的切分，这是一个**项目**而不是小改动：core 那一刀最大（引擎 + backend + 新原语 + 四类测试），
两个适配层各自是中等接线。粗略估计 core 新增 800–1200 行含测试，每个适配层 150–300 行含测试。
