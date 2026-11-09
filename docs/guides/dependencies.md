# 依赖管理

## 宿主提供的包必须写进 `peerDependencies`

宿主提供的包（`@earendil-works/*`、`typebox`）不得写进 `dependencies`：pi 在加载扩展时会扫描并
告警，安装的副本还会旁路扩展加载器的模块映射，造成重复运行时模块。

执行点是 `npm run check:host-deps`（`scripts/check-host-deps.mjs`），CI 的 `test` job 会跑。
规则：

- 源码里 import 了宿主提供包，就必须在 `peerDependencies` 里声明；
- `typebox` 系（`typebox` / `@sinclair/typebox`）按宿主约定用 `*` 范围；
- `@earendil-works/*` 的范围由本仓自定，当前是 `>=<最低宿主版本>`，脚本只要求声明存在。

## pi 宿主包的版本

`pi-memory` 的 `devDependencies` 把 `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui`
**钉死在 `0.80.2`**（精确版本，不带范围）。

这不是疏忽：宿主在 1.5.0 改了 API（`BeforeAgentStartEvent` 变成 union、
`CreateAgentSessionOptions.modelRegistry` → `modelRuntime`/`model`），而当前代码是按 0.80.2
写的。升级这三个 devDependency 必然连带改代码，必须当成一次独立变更来做。

## dsh 宿主包

`dsh-memory` 的宿主包是 `@deepseek-ai/*`（九个），处理规则比 pi 系更严格：

- **只能出现在 `peerDependencies` 与 `devDependencies`**。九个 peer 全部在 `peerDependenciesMeta` 里标
  `optional: true`：某个 profile 缺其中一个时，插件保持 inactive（fiber pending）而不是让整个安装失败。
  它们绝不能进 `dependencies`（`npm run check:host-deps` 会拦）。
- **devDependencies 钉精确版本**：`0.2.2-rc.1`，`@deepseek-ai/cordis` 例外为 `4.1.0`。这不是疏忽 ——
  宿主 `0.2.0-rc.2` → `0.2.2-rc.1` 一个跨度就破坏了三处本仓已经对着宿主源码改正的接口
  （见 `docs/superpowers/specs/2026-11-09-dsh-memory-adapter-design.md` §2.3），升级必须是一次
  deliberate 的变更，与本仓对 `@earendil-works/*` 钉死的理由相同。
- **运行时零宿主 import**：out-of-tree 插件无法静态解析宿主包，所以 `src/` 里 `@deepseek-ai/*` 只出现在
  `src/host-types.ts`、且只以 `import type` 出现（tsc 擦除）。执行点是
  `grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` 必须零命中（`.d.ts` 里命中是合法的，不算失败）。
- **不导出 schemastery `Config`**：导出它需要运行时 import `@deepseek-ai/schemastery`，与零宿主 import
  冲突。代价是没有宿主的 Settings-UI 页面，行 config 由插件自己校验（`src/row-config.ts`）。

**`@deepseek-ai/dsh-session` 看似可以删，实际不行**：`src/` 里没有一行按名字 import 它，但它参与了
typecheck。`src/host-types.ts` 从 `@deepseek-ai/dsh-agent` 取 `Agent`，而 `Agent` 的 `session` 属性是宿主用
模块增广补上的（`dsh-agent/lib/types/runtime-types.d.ts:164-168`），类型为 `dsh-session` 的 `Session`，
`Session.header` 又是 `SessionHeader`。适配层正是读 `agent.session.id` 与 `agent.session.header`（会话键、
根/子 agent 门禁），所以这些类型经 `dsh-agent` 间接到达，而不是直接 import。九个 peer 全 `optional: true`，
声明它零成本。

这九条精确版本各有一条 `.github/dependabot.yml` 的 `ignore`（与 `@earendil-works/*` 同样处理）：升级只能
走一次独立变更，不能让自动 PR 越过它。

## 依赖自动更新

`.github/dependabot.yml` 的骨架与 `yandy/pi-packages` 保持一致（周更、限 5 个 PR、dev 依赖
minor/patch 成组）。唯一刻意的差异是 `ignore`：

- `@earendil-works/*` 三个宿主包精度钉死 0.80.2（见上节）；
- `@deepseek-ai/*` 九个 dsh 宿主包同样钉死精确版本（见上节「dsh 宿主包」）；
- `@yandy0725/memory-core` 是 workspace 内依赖 —— 自动更新只会产出必然红 CI 的 PR 或绕开发布
  顺序。

要动这些版本，走独立变更；顺手删 `ignore` 条目不算。
