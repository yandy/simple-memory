# 仓库结构与硬约束

## 三个 workspace

| 目录 | 包名 | 职责 |
|------|------|------|
| `memory-core` | `@yandy0725/memory-core` | 与 harness 无关的基础层 |
| `pi-memory` | `@yandy0725/pi-memory` | pi 适配层 |
| `dsh-memory` | `@yandy0725/dsh-memory` | dsh（cordis）适配层：bundle 装配、行 `config:` 为唯一配置层、按 agent 注册工具 / 解析 store、`agent/pre-step` 每轮召回、会话日志扫描（`scope=sessions`） |

依赖方向单向：适配层依赖 `memory-core`，反过来不允许。

## `memory-core` 必须中立

`memory-core/src/**` 只许 import `node:*` 与相对路径（`tests/**` 另许 `vitest`）。

执行点是 `memory-core/tests/neutrality.test.ts`，它同时禁止 core 里出现只有本仓才读得懂的坐标
（spec 章节号、决策编号、宿主斜杠命令、宿主事件名）。放宽这条等于让第二个 harness 装不上这个包。

## 公开 API 只从 `src/index.ts` 出

`memory-core` 的 `exports` 里没有子路径，子路径也不该有。

`dsh-memory` 遵循同一条规则：`exports` 只有 `.`（`dist/index.js`）、`cordis.patch.yml` 与
`package.json`。宿主类型只从 `src/host-types.ts` 走，且只允许 `import type` —— tsc 擦除后
`dist/**/*.js` 零宿主命中（`npm run build` 的验收点）。

## 用户契约

磁盘格式、prompt 文本、`memory` 工具的 action 语义不得顺手改。它们对用户是契约，改动要有独立的
spec 与迁移说明。

工具提示词（`description` / `promptSnippet` / `promptGuidelines` 三通道）的措辞与预算由
`scripts/prompt-hygiene.ts` 把关，执行点是 `pi-memory/tests/prompt-meta.test.ts`。

## 行尾必须是 LF

`.gitattributes` 固定 `* text=auto eol=lf`。Windows runner 默认 CRLF 检出，会把 `\r\n` 带进
`prompts.ts` 的模板字面量（也就是发给模型的 prompt 本体）。

## 仓内解析 vs 发布形态

`pi-memory` 与 `dsh-memory` 的 `vitest.config.ts` 用 `resolve.alias`、`tsconfig.json` 用 `paths`，把
`@yandy0725/memory-core` 指到 `../memory-core/src/index.ts`，所以日常 `npm test` / `typecheck`
不需要先 build。`dsh-memory` 的 `tsconfig.build.json` 再把 `paths` 清空，构建因此经包 `exports`
解析 `memory-core/dist`。

发布形态有两条，分别由两个 job 覆盖：

- **仓内的 `dist`**：`test-dist` 用 `MEMORY_CORE_FROM_DIST=1` 关掉 alias，让同一套测试打到
  `memory-core/dist`（经包 `exports` 解析）。
- **registry 上的 core**：`registry-smoke` 把适配层打成 tarball 装进干净目录，依赖只从 registry 拉，
  断言解析到的 core 在该目录内、版本满足声明的范围、并能真读写。用户装包时走的就是这条。

解析路径的完整约定与静态闸门（`npm run check:memory-core-deps`）见
[dependencies.md](./dependencies.md) 的「开发走仓内源码，运行走 registry」一节。

## CI job 各自的用途

`.github/workflows/test.yml`：

| job | 覆盖什么 |
|-----|----------|
| `lockfile-sync` | `package-lock.json` 与各 `package.json` 未漂移 |
| `test` | 逻辑（ubuntu + windows），含 `check:host-deps` / `check:memory-core-deps` / `typecheck` / `lint` / `test` |
| `test-dist` | 发布形态的解析路径（见上节） |
| `registry-smoke` | 适配层 tarball 从 registry 装上 memory-core 后能跑（见上节） |
| `pack-smoke` | tarball 里带齐了 `dist/`、types 与 `pi-memory` 的 TS 入口；在干净目录装包后能跑 |

`pack-smoke` 跑 Node 20.16.0（`memory-core` 的 `engines` 下限）与 24 两档，只验证运行时形状，
不跑 vitest —— 开发工具链的 Node 下限高于 `engines`。
