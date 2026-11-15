# memory-core

[English](./README.md) | 中文

与 harness 无关的文件系统记忆层。一条记忆一个 Markdown 文件，`MEMORY.md` 索引里每条一行；读写门面、
两级锁、快照回滚、注入策略、以及围绕它们的 LLM 编排都在这里。`src/**` 只 import `node:*` 与相对路径。

适配层负责宿主那一半：何时注入、怎么渲染、调哪个模型。本包负责必须处处一致的那一半 —— 所以同一台
机器上的两个 harness 能共享同一份记忆。

## 安装

```sh
npm i @yandy0725/memory-core
```

## 最小用法

```ts
import { DEFAULT_CONFIG, MemoryStore, resolveMemoryDir } from "@yandy0725/memory-core";

const memoryDir = await resolveMemoryDir(DEFAULT_CONFIG, process.cwd());
const store = new MemoryStore({
	memoryDir,
	indexMaxLines: DEFAULT_CONFIG.memIndexMaxLines,
	indexMaxBytes: DEFAULT_CONFIG.memIndexMaxBytes,
	lock: DEFAULT_CONFIG.lock,
});

await store.addEntry({
	name: "SSH port on staging",
	description: "staging SSH listens on 2222, not 22",
	type: "project",
	body: "staging 的 SSH 用 2222 端口。",
});

for (const entry of await store.listEntries()) console.log(entry.name, entry.description);
```

`DEFAULT_CONFIG.memoryDir` 是共享数据根 `$XDG_DATA_HOME/simple-memory`（未设置时
`~/.local/share/simple-memory`），`resolveMemoryDir` 把它解析成当前项目的 `<git|local>/<project>/`。
规则里没有宿主名与平台分支，所以每个适配层独立算出的目录相同。适配层还可以用 `mergeConfig` 合并自己
的配置，用 `runTask` 跑 autoSurfacing / extractMemories / dream。

## 包含什么

| 层 | 内容 |
|---|---|
| 磁盘格式 | 每条记忆一个带 YAML frontmatter 的 Markdown 文件；`MEMORY.md` 每条一行索引；文件名由 `name` 派生 |
| 读写门面 | `MemoryStore` —— `listEntries` / `readEntry` / `readIndex` / `searchEntries` / `addEntry` / `replaceEntry` / `removeEntry` / `renameEntry` / `rebuildIndex` |
| 并发与恢复 | 跨进程 `.lock`（毫秒级持有、永不自动回收）+ 进程内逻辑锁 + 瞬时错误重试 + `.backups/` 回滚点 |
| 路径与安全 | git remote 归一化成单个合法目录名、目录逃逸断言、注入净化、Windows 保留设备名处理 |
| LLM 编排 | `TASKS` 里的三个任务描述符与 `runTask` 入口，跑在 `HeadlessAgentPort` / `HostTranscriptPort` 上 |
| 注入策略 | 索引窗口、正文截断、容量口径、`scanEntries`、`renderSurfacedBlock` —— 返回字符串的纯函数 |
| 工具契约 | action 集合、JSON Schema、模型可见文案、`createMemoryActionHandler` |
| 配置 | 默认值、`mergeConfig`、`~` 展开、模型校验、`defaultMemoryRoot()` —— 不读文件 |

没有 LLM 调用、没有 UI、没有宿主 API。这条由 `tests/neutrality.test.ts` 守着，它也是第二个 harness
能依赖这个包的唯一理由。

## 开发

```sh
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # biome
npm run build     # tsc -p tsconfig.build.json → dist/（ESM + .d.ts）
```

## 文档

- [参考](https://github.com/yandy/simple-memory/blob/main/docs/reference/memory-core.zh.md)：磁盘格式、容量口径、锁、适配新 harness 的端口、Windows
- [架构与硬约束](https://github.com/yandy/simple-memory/blob/main/docs/guides/architecture.md)
- [依赖管理](https://github.com/yandy/simple-memory/blob/main/docs/guides/dependencies.md)

MIT
