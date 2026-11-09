# AGENTS.md

## 语言

与用户沟通使用简体中文。代码注释、commit message、包内 README 沿用现有风格（注释中文、README 英文 +
中文双语）。

## 仓库结构

三个 workspace：`memory-core`（与 harness 无关的基础层）、`pi-memory`（pi 适配层）、`dsh-memory`
（占位，无代码）。依赖方向单向：适配层依赖 `memory-core`，反过来不允许。

## 硬约束

- **`memory-core/src/**` 只许 import `node:*` 与相对路径**（`tests/**` 另许 `vitest`）。
  `memory-core/tests/neutrality.test.ts` 是执行点；它同时禁止 core 里出现只有本仓才读得懂的坐标
  （spec 章节号、决策编号、宿主斜杠命令、宿主事件名）。放宽这条等于让第二个 harness 装不上这个包。
- **`memory-core` 的公开 API 只从 `src/index.ts` 出**。`exports` 里没有子路径，子路径也不该有。
- **宿主提供的包（`@earendil-works/*`、`typebox`）必须写在 `peerDependencies`，不得写进
  `dependencies`** —— pi 在加载扩展时会扫描并告警，安装副本还会造成重复运行时模块。`npm run check:host-deps`
  是执行点；`typebox` 系按宿主约定用 `*` 范围。
- **磁盘格式、prompt 文本、`memory` 工具的 action 语义不得顺手改**。它们对用户是契约，改动要有独立
  的 spec 与迁移说明。
- **`.gitattributes` 固定 `* text=auto eol=lf`**。Windows runner 默认 CRLF 检出，会把 `\r\n` 带进
  `prompts.ts` 的模板字面量（也就是发给模型的 prompt 本体）。

## 仓内解析 vs 发布形态

`pi-memory` 的 `vitest.config.ts` 用 `resolve.alias`、`tsconfig.json` 用 `paths`，把
`@yandy0725/memory-core` 指到 `../memory-core/src/index.ts`，所以日常 `npm test` / `typecheck` 不需要
先 build。

CI 的 `test-dist` job 用 `MEMORY_CORE_FROM_DIST=1` 关掉 alias，让同一套测试打到
`memory-core/dist`（经包 `exports` 解析）—— 用户拿到的那条路径必须被真实执行过一次。

## pi 宿主包的版本

`pi-memory` 的 `devDependencies` 把 `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` **钉死在
`0.80.2`**（精确版本，不带范围）。这不是疏忽：宿主在 1.5.0 改了 API（`BeforeAgentStartEvent` 变成
union、`CreateAgentSessionOptions.modelRegistry` → `modelRuntime`/`model`），而当前代码是按 0.80.2
写的。升级这三个 devDependency 必然连带改代码，必须当成一次独立变更来做。

## 发布

见 `docs/guides/release.md`。tag 格式 `memory-core-v*` / `pi-memory-v*`；顺序不可交换：`memory-core`
必须先上 registry，`pi-memory` 才能发（它的 `dependencies` 指向 `^1.0.0`）。
