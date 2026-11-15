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

## 与 pi 的真实差异

- 子会话会被宿主落盘（dsh 没有 per-session 持久化开关），会话日志会变多。
- 没有轮数硬上限，`maxTurns` 是尽力而为；超时才是硬打断。
- `/dream` 立刻返回「已开始」，不等它跑完，也没有确认框 —— 摘要写进宿主日志。
- 没有「该整理了」的 nudge，只有你显式 `/dream`。
- extract 的 prompt 里没有 AGENTS.md 块（dsh 那边是不透明文本，切不出来）。
- 索引不冻结：dsh 每一步都重新装配 system prompt，索引是一份异步刷新的快照。

## 要求

- dsh `>=0.2.2-rc.1 <0.3.0`（宿主在 import 插件之前就按 `engines.dsh` 拒载）
- Node `>=24.9.0`

## 文档

- [参考](https://github.com/yandy/simple-memory/blob/main/docs/reference/dsh-memory.zh.md)：完整配置、模型、验证状态与实现限制
- [架构与硬约束](https://github.com/yandy/simple-memory/blob/main/docs/guides/architecture.md)
- [依赖管理](https://github.com/yandy/simple-memory/blob/main/docs/guides/dependencies.md)

MIT
