# dsh-memory

[English](./README.md) | 中文

给 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh)（基于 cordis 的宿主）的记忆插件，与
`pi-memory` 读写**同一份**磁盘记忆。记忆逻辑全在
[`@yandy0725/memory-core`](https://www.npmjs.com/package/@yandy0725/memory-core) 里，本插件只做宿主那一半：
什么时候注入、怎么注册工具、调哪个模型、怎么扫会话日志。

## 安装

```sh
npm run build -w memory-core && npm run build -w dsh-memory   # 顺序不能反：本包 build 解析 core 的 dist/
dsh plugin --profile web add file:/abs/path/to/dsh-memory
```

装完重启 dsh。`file:` 安装是**拷贝**，所以改完代码要重跑 `dsh plugin … add` 才会生效。本包目前
`private: true`、版本 `0.0.0`，发布后 `<spec>` 换成 `@yandy0725/dsh-memory`。

卸载：`dsh plugin --profile web remove @yandy0725/dsh-memory`。

## 配置

唯一的配置层是 cordis 行 `config:`，写在 profile 的 `cordis.patch.yml`（或机器级
`~/.dsh/cordis.patch.yml`）。不读任何 JSON 配置文件。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    defaults: { model: "deepseek-official/deepseek-flash" }   # "<provider>/<model>"
    autoSurfacing: { enabled: true }                          # 每轮召回
    extractMemories: { enabled: false }                       # 每轮结束自动提取（默认关闭）
    dream: { model: "deepseek-official/deepseek-pro" }        # 只有你敲 /dream 才跑
```

键名与 `memory-core` 的 `MemoryConfig`、pi 的 `memory.json` **逐字相同**。缺模型时只关掉拿不到模型的
那个模块，`memory_index` 与 `memory` 工具照常可用。`memoryDir` 是 per-harness 配置 —— 在 pi 里覆盖了，
这里也要覆盖成同一个值。

## 它做什么

- `memory_index` system prompt 段，正文与 pi 注入的逐字相同
- `memory` 工具：`add` / `replace` / `remove` / `list` / `search`
- `/memory` 状态与 `/memory unlock --force`
- 每轮自动召回
- 每轮自动提取（`extractMemories.enabled` 默认关闭）
- `/dream` 整理
- **跨设备同步**（默认关闭）—— 把当前项目的记忆推进一个 git 远端，另一台机器打开同一仓库时共用（见下）

## 跨设备同步（可选，默认关闭）

把**当前项目**的记忆 entry 推进一个 git 远端，同一仓库在另一台机器上打开时共用一份：

```yaml
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    sync: { enabled: true, remote: "git@github.com:you/project-memory.git" }
```

- **没有 init 命令**：下一次会话启动时按这份配置 clone 到 `<memoryDir>/.sync/repo` 并记下基线。初始化
  之后，行 config 里的 `sync.remote` 只用于**首次** clone —— 之后暂存 clone 的 `origin` 才是真相来源，
  `sync.remote` 留空或与 origin 不一致只会产生一条非致命提醒（`/memory sync remote <url>` 改 origin，
  绝不会回写你的行 config）。
- 远端仓库自己准备好（空仓库也行），并确保 `git` 能非交互地 clone/push —— dsh-memory 不存任何凭据。
- 只同步 entry `*.md` 文件：`MEMORY.md`、`.lock`、`.backups/`、`sessions/` 都留在本地。
- 两边都改了同一条记忆时，**两份都留**：另一份会变成一条确定性的冲突副本，之后由 `/dream` 合并。
- 项目**第一次**同步、且本地已经有 entry 时，会看到一条预告（`simple-memory: memory sync notice: …`）：
  同名条目可能被留成冲突副本。这不是失败，且这条基线之后不会重复出现。
- 手动命令：`/memory sync`（= `status`，严格 dry-run）/ `pull` / `push` / `remote <url>` /
  `unlock [--force]`（清除崩溃遗留的根锁 `.sync/sync.lock`）。
- **没有退出兜底推送**：长寿命宿主里 `agent/disposed` 不可靠，所以 dsh 不会在会话销毁时尝试推送。
  没发布出去的写入由下一次 `agent/created` 的启动轮次补推（一轮 `push()`，同时完成远端收敛与遗留内容
  重试），或由下一次写触发的去抖推送（`sync.pushOnWrite`，默认开）接住。

## 与 pi 的真实差异

- 子会话会被宿主落盘（dsh 没有 per-session 持久化开关），会话日志会变多。
- 没有轮数硬上限，`maxTurns` 是尽力而为；超时才是硬打断。
- `/dream` 立刻返回「已开始」，不等它跑完，也没有确认框 —— 摘要写进宿主日志。
- 没有「该整理了」的 nudge，只有你显式 `/dream`。
- extract 的 prompt 里没有 AGENTS.md 块（dsh 那边是不透明文本，切不出来）。
- 索引不冻结：dsh 每一步都重新装配 system prompt，索引是一份异步刷新的快照。同步会在一次会话的
  **第一次**快照刷新**之前**跑完，所以启动拉取的结果在第一份 `memory_index` 里就看得见。
- 同步配置写在 cordis 行 config 里（这一侧没有 `memory.json`），且没有退出兜底推送（见上）。

完整语义见[跨设备同步](https://github.com/yandy/simple-memory/blob/main/docs/reference/dsh-memory.zh.md#跨设备同步)。

## 要求

- dsh `>=0.2.2-rc.1 <0.3.0`（宿主在 import 插件之前就按 `engines.dsh` 拒载）
- Node `>=24.9.0`

## 文档

- [参考](https://github.com/yandy/simple-memory/blob/main/docs/reference/dsh-memory.zh.md)：完整配置、跨设备同步、模型、验证状态与实现限制
- [架构与硬约束](https://github.com/yandy/simple-memory/blob/main/docs/guides/architecture.md)
- [依赖管理](https://github.com/yandy/simple-memory/blob/main/docs/guides/dependencies.md)

MIT
