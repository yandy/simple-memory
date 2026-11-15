# pi-memory

[English](./README.md) | 中文

给 pi coding agent 的持久记忆：项目知识（事实、偏好、调试历史）存成纯 Markdown 文件，跨会话、跨
harness 可用。记忆落在磁盘上，不在会话里。

## 安装

```sh
pi install npm:@yandy0725/pi-memory
```

或写进 `~/.pi/agent/settings.json`：

```json
{ "packages": ["npm:@yandy0725/pi-memory"] }
```

## 先配一个模型

```json
// ~/.pi/agent/memory.json
{ "defaults": { "model": "provider/model-id" } }
```

模型**没有随包默认值**，也不会回退到父会话的模型：`defaults.model` 必须能在你的 registry 里解析。
`dream` 恒需要它；`autoSurfacing` / `extractMemories` 各自开启时也需要。缺模型会让 `session_start`
报配置错误并且什么都不初始化。

## 它做什么

- **一个 `memory` 工具** —— `add` / `replace` / `remove` / `list` / `search`。一条记忆一个文件，`name`
  是定位键，`add` 同名就是覆盖。
- **`MEMORY.md` 索引进 system prompt** —— `memory_index` section 在整个会话内冻结，pi 对 sections 做
  diff 时不会逐轮追加消息，provider 的前缀缓存一直命中。
- **自动浮现** —— 每轮用一次轻量侧查询挑出相关记忆，把正文注入 `<relevant_memories>`。
- **自动提取**（默认关闭）—— 每轮结束后由子会话挑出值得长期记住的内容写进记忆。
- **`/dream`** —— headless 整理：合并重复、消解矛盾、重建索引。
- **跨设备同步**（默认关闭）—— 把当前项目的记忆推进一个 git 远端，另一台机器打开同一仓库时共用。
- Windows 原生可用，不需要 WSL。

## 常用命令

| 命令 | 作用 |
|---|---|
| `/memory` | 目录、索引容量、条目数、模块状态、锁持有者 |
| `/memory unlock` | 清除崩溃遗留的 `.lock` |
| `/memory sync [status\|pull\|push\|remote <url>\|unlock]` | 同步状态与手动收敛 |
| `/dream` | 整理记忆（先确认，再对整目录拍快照） |

工具与参数的完整说明见[工具参考](https://github.com/yandy/simple-memory/blob/main/docs/reference/pi-memory.zh.md#工具参考)。

## 数据在哪

```
$XDG_DATA_HOME/simple-memory/<git|local>/<project>/
```

`XDG_DATA_HOME` 未设置或为相对路径时用 `~/.local/share/simple-memory`。磁盘格式（entry 的
frontmatter、`MEMORY.md`、`.lock`、`.backups/`）由 [memory-core](https://www.npmjs.com/package/@yandy0725/memory-core)
定义，`memoryDir` 可以覆盖根目录 —— 但它是 per-harness 配置，用 dsh 时要在那边覆盖成同一个值。

**索引在整个会话内冻结**：本会话写入的记忆要等 compaction 或下一个会话才会出现在 system prompt 里，
工具返回值已经是写入成功的凭据。

## 文档

- [参考](https://github.com/yandy/simple-memory/blob/main/docs/reference/pi-memory.zh.md)：完整配置、跨设备同步、工作原理、工具与命令参考
- [仓库导览](https://github.com/yandy/simple-memory)：`memory-core` / `dsh-memory` 与开发流程

MIT
