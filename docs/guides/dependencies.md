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

## 依赖自动更新

`.github/dependabot.yml` 的骨架与 `yandy/pi-packages` 保持一致（周更、限 5 个 PR、dev 依赖
minor/patch 成组）。唯一刻意的差异是 `ignore`：

- `@earendil-works/*` 三个宿主包精度钉死 0.80.2（见上节）；
- `@yandy0725/memory-core` 是 workspace 内依赖 —— 自动更新只会产出必然红 CI 的 PR 或绕开发布
  顺序。

要动这些版本，走独立变更；顺手删 `ignore` 条目不算。
