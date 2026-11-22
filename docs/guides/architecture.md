# 仓库结构与硬约束

## 三个 workspace

| 目录 | 包名 | 职责 |
|------|------|------|
| `memory-core` | `@yandy0725/memory-core` | 与 harness 无关的基础层 |
| `pi-memory` | `@yandy0725/pi-memory` | pi 适配层 |
| `dsh-memory` | `@yandy0725/dsh-memory` | dsh（cordis）适配层：bundle 装配、行 `config:` 为唯一配置层、按 agent 注册工具、`agent/pre-step` 每轮召回、会话日志扫描 |

依赖方向单向：适配层依赖 `memory-core`，反过来不允许。

## `memory-core` 必须中立

`memory-core/src/**` 只许 import `node:*` 与相对路径（`tests/**` 另许 `vitest`），也不读任何配置文件：
配置在哪、读哪几个、项目是否受信任都是适配层的事（core 只给默认值与 `mergeConfig`）。

执行点是 `tests/neutrality.test.ts`：它扫 import 说明符与一份列出的坐标（spec 章节号、决策编号、宿主
命令/事件名），不负责发现任意宿主配置文件名或文案 —— 那些靠审查与注入参数约束。放宽这条等于让第二个
harness 装不上这个包。

## 公开 API 只从 `src/index.ts` 出

`memory-core` 的 `exports` 没有子路径，也不该有。`dsh-memory` 同理：`exports` 只有 `.`、
`cordis.patch.yml` 与 `package.json`；宿主类型只从 `src/host-types.ts` 走且只允许 `import type`
（`dist/**/*.js` 零宿主命中是 `npm run build` 的验收点）。

## 同步：core 编排，适配层接线

- `createSyncEngine` 收敛**一轮**：传输段、三方差集、冲突收敛、快照、落盘、重建索引、发布段。
- `createSyncRuntime` 把一轮变成**会话级生命周期**：配置门禁、懒 engine、`prepare`、`startup` / `run` /
  `status` / `flush`、`changeRemote`、写触发与 `dispose`。

适配层注入 `createBackend` / `createEngine` / `writeManifest` 三个原语与自己的文案，并选一种
`scheduling`：pi 用 `concurrent`（调用返回前起跑并登记），dsh 用 `serial`（一条 FIFO，已排队的跑完）。
宿主仍拥有事件接线、命令与确认、通知与错误账本、索引冻结/刷新策略；core 不认识这些，也不读配置。

磁盘布局（`.sync/` 在记忆根下、与 `git/` 同级，项目目录保持干净）：

```
<memoryRoot>/.sync/
  device.json                 本机身份，永不同步；发布提交的作者来自它
  repo/                       唯一的暂存 clone，全部传输通道都在这里
  state/<project-key>.json    manifest 基线：文件指纹 + transport{ remoteHash, branch }
  sync.lock                   根级跨进程锁，按段持有（传输段 / 发布段），绝不整轮持有
```

基线只对「同一 origin + 同一 branch」成立：v1、损坏、origin 或 branch 不匹配一律退化成空 base —— 这条
约定保证「绝不按旧 base 在新传输端删本地」。被遗弃的 `sync.lock` 会让每一轮失败，`/memory sync unlock`
是唯一认可的清除入口。字段与同步范围的完整说明见 [memory-core 参考](../reference/memory-core.zh.md)。

端口契约（`src/sync/backend.ts`）：

- `list()` 交出的 hash **恒为 `sha256(bytes)` 十六进制小写**；路径相对 `scope.prefix`（单层 entry 名），
  `scope.prefix` 恒为 POSIX 形态。
- `outOfScope` 只收**异常**路径，不是「不在本 scope 内」：兄弟项目是每轮常态，报进来会淹没真正的信号。
- `publish()` 用 `base.revision` 做乐观并发，并在任何远端 mutation 前复核 `base.remote`（fetch 同一把锁
  内读到的实际 origin），不一致抛 `NonFastForward`。
- `SyncRunOptions.timeoutMs` 是**这次调用的总预算**：backend 内部的多个子进程、引擎一轮的多段调用都共享
  剩余量；`signal` 由宿主在退出/切会话时接上。

一轮的本地开销是 **O(远端总字节)**：git backend 每轮 `fetch` 后用一次 `cat-file --batch` 读出范围内全部
blob 并算 sha256（`ls-tree` 给的是 sha1，不同源），`read()` 复用这份缓存。所以空转 pull 并不便宜 ——
300 条 CJK 记忆在本机是「初始化几十毫秒、首次推送一两百毫秒、空转 pull 与 status 几十到上百毫秒」的
量级，别把它当基准。

**上万条时该换成 oid 缓存**（manifest 里存 blob sha1 → 内容 sha256，只对变更路径读内容）。触发条件是
远端总量而不是变更量；在那之前不要拿「只改了一条」去优化这条路径。

自动化测试只跑本地 bare 仓库；真实托管远端的手动清单见 [sync-e2e.md](./sync-e2e.md)。

## 用户契约

磁盘格式、prompt 文本、`memory` 工具的 action 语义不得顺手改 —— 它们是用户契约，改动要独立 spec。工具
提示词三通道（`description` / `promptSnippet` / `promptGuidelines`）的措辞与预算由
`scripts/prompt-hygiene.ts` 把关，执行点是 `pi-memory/tests/prompt-meta.test.ts`。

## 行尾必须是 LF

`.gitattributes` 固定 `* text=auto eol=lf`：Windows runner 默认 CRLF 检出，会把 `\r\n` 带进
`prompts.ts` 的模板字面量（也就是发给模型的 prompt 本体）。

## 测试

隔离方式、harness import 顺序、临时目录与失败注入的边界见 [testing.md](./testing.md)。

## 仓内解析 vs 发布形态

开发与测试经 `vitest.config.ts` 的 `resolve.alias` + `tsconfig.json` 的 `paths` 解析到
`../memory-core/src/index.ts`，不必先 build。发布形态由三个 job 各管一段，互不冒充：

| job | 解析到 |
|-----|--------|
| `test-dist` | `memory-core/dist`（`MEMORY_CORE_FROM_DIST=1` 关掉 alias） |
| `workspace-smoke` | 仓内 tarball：core 与适配层一起装进干净目录 |
| `registry-smoke` | registry 上的 core（只在 main 跑；用户装包走的就是这条） |

静态闸门 `npm run check:memory-core-deps` 与完整约定见 [dependencies.md](./dependencies.md)。

## LICENSE 只有根目录一份

根 `LICENSE`(MIT) 覆盖所有包；三个包目录里没有提交的副本，`package.json` 只写 SPDX 标识。tarball 里仍有
完整文本：`prepack` 用 `scripts/sync-license.mjs` 复制进包目录、`postpack` 删掉（`npm pack` 不跟随指向
包外的符号链接，而 MIT 要求随附声明）。执行点是 `npm run check:license`；`pack-smoke` 另用
`scripts/assert-pack-manifest.mjs` 断言 tarball 带 `LICENSE`。不要把副本提交回来。

## CI job 各自的用途

`.github/workflows/test.yml`：

| job | 覆盖什么 |
|-----|----------|
| `lockfile-sync` | `package-lock.json` 与各 `package.json` 未漂移 |
| `test` | 逻辑（ubuntu + windows），含 `check:license` / `check:host-deps` / `check:memory-core-deps` / `typecheck` / `lint` / `test` |
| `test-dist` | 发布形态的解析路径（见上节） |
| `workspace-smoke` | core 与适配层的仓内 tarball 在干净目录安装后能跑（PR 阶段；不冒充 registry） |
| `registry-smoke` | 适配层 tarball 从 registry 装上 memory-core 后能跑（只在 main 上跑，见上节） |
| `pack-smoke` | tarball 里带齐 `dist/`、types、`LICENSE` 与 `pi-memory` 的 TS 入口；干净目录装包后能跑 |

`pack-smoke` 跑 Node 20.16.0（`memory-core` 的 `engines` 下限）与 24 两档，只验证运行时形状，不跑 vitest。

<!-- ci docs-only probe -->
