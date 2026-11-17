# simple-memory

[English](./README.md) | 中文

一份磁盘上的记忆，被你在用的每个 AI coding agent 共享。一条记忆就是一个 Markdown 文件，`MEMORY.md`
索引里每条一行；指向同一台机器的两个 harness 读写的正是同一批文件。

| 包 | 用途 | npm |
|---|---|---|
| [memory-core](./memory-core) | 与 harness 无关的底座：磁盘格式、`MemoryStore`、两级锁、快照、注入策略、`memory` 工具契约。只 import `node:*`。 | `@yandy0725/memory-core` |
| [pi-memory](./pi-memory) | pi 适配层：`memory` 工具、`/memory`、`/dream`、自动浮现与自动提取、跨设备同步。 | `@yandy0725/pi-memory` |
| [dsh-memory](./dsh-memory) | DeepSeek harness（`@deepseek-ai/dsh`，cordis）适配层，与 pi 共用同一份记忆。 | `@yandy0725/dsh-memory` |

宿主专属的那一半（何时注入、怎么渲染、调哪个模型）在适配层；必须处处一致的那一半在 `memory-core`。

## 装上试试

用 pi：

```sh
pi install npm:@yandy0725/pi-memory
```

用 dsh：见 [dsh-memory](./dsh-memory) 的两条构建 / 安装命令。

`memory-core` 不用单独装，两个适配层会依赖它。

## 记忆存在哪

```
$XDG_DATA_HOME/simple-memory/<git|local>/<project>/
```

`XDG_DATA_HOME` 未设置或为相对路径时用 `~/.local/share/simple-memory`。git 仓库按 remote 落到
`git/<host__owner__repo>`（同一仓库的 clone 与 worktree 共享），其余按绝对路径落到 `local/<path>`。
`memoryDir` 可以覆盖根目录，但它是**每个 harness 各自的配置** —— 要覆盖就在每个宿主里覆盖成同一个值，
否则共享会静默失效。

## 跨设备同步

记忆默认只在本机。两个适配层都可以把当前项目的记忆推进一个 git 远端（默认关闭），同一仓库在另一台
机器上打开时落到同一批文件上。见 [pi-memory](./pi-memory)、[dsh-memory](./dsh-memory) 与
[参考文档](./docs/reference/pi-memory.zh.md#跨设备同步)。

## 文档

- 参考：[memory-core](./docs/reference/memory-core.zh.md) · [pi-memory](./docs/reference/pi-memory.zh.md) · [dsh-memory](./docs/reference/dsh-memory.zh.md)
- 开发：[架构与硬约束](./docs/guides/architecture.md) · [依赖](./docs/guides/dependencies.md) · [测试](./docs/guides/testing.md) · [发布](./docs/guides/release.md)

## 开发

```sh
npm ci                         # 根 + 三个 workspace
npm test                       # 三个包的测试
npm run typecheck && npm run lint
npm run build -w memory-core   # dist/（ESM + .d.ts + maps）
npm run smoke:registry         # 需要先 build：从 registry 拉 core 验证发布形态
```

MIT
