# 依赖管理

## 宿主提供的包必须写进 `peerDependencies`

宿主提供的包（`@earendil-works/*`、`@deepseek-ai/*`、`typebox`）不得写进 `dependencies`：pi 加载扩展时
会扫描并告警，装下来的副本还会旁路扩展加载器的模块映射，造成重复运行时模块。

执行点是 `npm run check:host-deps`（CI 的 `test` job）：

- 源码 import 了宿主包，就必须在 `peerDependencies` 声明；
- `typebox` 系按宿主约定用 `*`；
- `@earendil-works/*` / `@deepseek-ai/*` 的范围由本仓自定，脚本只要求声明存在；
- `dsh-memory` 的九个 `@deepseek-ai/*` peer 全部 `optional: true`：某个 profile 缺其中一个时插件保持
  inactive（fiber pending），而不是让整个安装失败。

## 宿主包版本：peer 写下限，dev 钉精确

两个适配层的 devDependencies 都用**精确版本**（不带 `~`/`^`）钉住宿主包，peer 只写下限；dev 取的正是
peer 下限，CI 跑在冒烟也会跑的那一档上，不给「声明支持、实际没测」留缝。具体版本以各包 `package.json`
为准，本文不复制。

钉精确不是疏忽：宿主 API 会破坏性变更，而代码是照着某一档写的。两条硬约束：

- **代码真正依赖的 API 边界可能早于策略下限**：升级前按源码里的 import 与类型收窄逐项核对，别只看
  peer 范围。
- **升级必然连带改代码与测试**（`createAgentSession` 的选项、事件形状、按旧形状写的 fake 事件），所以
  升级是一次独立变更；dependabot 对宿主包整包忽略。

`dsh-memory` 另有一条更硬的规则：**运行时零宿主 import** —— out-of-tree 插件无法静态解析宿主包，所以
`@deepseek-ai/*` 只出现在 `src/host-types.ts` 且只以 `import type` 出现。执行点是
`grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js"` 零命中（`.d.ts` 命中不算）。因此也不导出
schemastery `Config`（那需要运行时 import），行 config 由 `src/row-config.ts` 自己校验。

## `@yandy0725/memory-core`：开发走仓内源码，运行走 registry

适配层对 core 有两条互斥的解析路径，必须同时成立：

| 时机 | 解析到 | 由什么保证 |
|------|--------|-----------|
| 开发（`npm test` / `typecheck`） | `../memory-core/src/index.ts` | `vitest.config.ts` 的 `resolve.alias` + `tsconfig.json` 的 `paths` |
| 构建 / 运行时 | 包 `exports` → `dist` → registry 上的版本 | `tsconfig.build.json` 清空 `paths` + `dependencies` 的 caret 范围 |

推论：

- core **只写进 `dependencies`**，不写进 `devDependencies`（workspace 已经会链接，重复声明只会制造第二份
  副本，让两条路径悄悄漂移）。
- 范围写 `^x.y.z`，不写 `file:` / `workspace:` / `*` / `latest`。
- 构建配置不得继承源码别名，否则产物会对着比 registry 更新的源码编出来。
- **适配层 import 的每个 core 导出都必须存在于声明的范围里**：core 新增导出时先发 core、再抬范围。

单宿主策略键不进 core 的配置契约：像 `dream.nudgeAfterSessions` 只属于 pi 的配置；`sync.pushDebounceMs`
因为在两个宿主上都有消费者（写入后去抖发布）才能进 `MemoryConfig`，而退出兜底的推送不设键。

执行点：

- `npm run check:memory-core-deps`（`test` job）—— 静态检查上面几条。
- `npm run smoke:workspace`（`workspace-smoke` job）—— core 与适配层的仓内 tarball 在干净目录同时安装。
- `npm run smoke:registry`（`registry-smoke` job，只在 main 跑）—— 适配层 tarball 装进干净目录、依赖只从
  registry 拉，断言解析到的 core 在目录内、版本满足范围、能真读写。未发布的适配层在找不到满足范围的
  core 时只打 notice 跳过；去掉 `private` 后同一条件变成失败。

三者互不冒充；`test-dist` 另用 `MEMORY_CORE_FROM_DIST=1` 覆盖仓内 dist。

## 依赖自动更新

`.github/dependabot.yml` 周更、限 5 个 PR、dev 依赖 minor/patch 成组；刻意的 `ignore` 只有三类：
`@earendil-works/*`、`@deepseek-ai/*`（都钉精确版本，见上）与 `@yandy0725/memory-core`（workspace 内依赖，
自动更新只会产出必然红 CI 的 PR 或绕开发布顺序）。要动这些版本走独立变更，顺手删 `ignore` 条目不算。
