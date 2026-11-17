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

`memory-core` 不读任何配置文件：配置文件在哪、读哪几个、项目是否受信任，是适配层的事（core 只给默认值
与合并语义 `mergeConfig`）。

执行点是 `memory-core/tests/neutrality.test.ts`，它同时禁止 core 里出现只有本仓才读得懂的坐标
（spec 章节号、决策编号、宿主斜杠命令、宿主事件名）。它只按 import 说明符与这份**列出的**坐标扫描，
不负责发现任意宿主配置文件名或命令文案——这类词汇靠审查与新文案的注入参数约束，不能把 neutrality
测试当成全量黑名单。放宽这条等于让第二个 harness 装不上这个包。

## 公开 API 只从 `src/index.ts` 出

`memory-core` 的 `exports` 里没有子路径，子路径也不该有。

`dsh-memory` 遵循同一条规则：`exports` 只有 `.`（`dist/index.js`）、`cordis.patch.yml` 与
`package.json`。宿主类型只从 `src/host-types.ts` 走，且只允许 `import type` —— tsc 擦除后
`dist/**/*.js` 零宿主命中（`npm run build` 的验收点）。

## 同步：core 编排，适配层接线

跨设备同步分两层，与本仓其余部分的切分同构：

- `memory-core` 的 `createSyncEngine` 收敛**一轮**：传输段、三方差集、冲突收敛、快照、落盘、重建索引、
  发布段。
- `memory-core` 的 `createSyncRuntime` 把一轮变成**会话级生命周期**：配置门禁、懒 engine、`prepare`、
  `startup` / `run` / `status` / `flush`、`changeRemote`、写触发与 `dispose`。

适配层负责接线：从公开出口注入 `createBackend` / `createEngine` / `writeManifest` 三个原语与自己的文案，
并选一种 `scheduling` —— pi 用 `concurrent`（活动在公开调用返回前起跑并登记），dsh 用 `serial`（一条
FIFO，已排队的操作允许跑完）。core 拥有它们的生命周期与调用顺序，但不选传输实现、不认识宿主、也不读
任何配置文件。

仍留宿主的是宿主那一半：调用 runtime 的宿主事件（启动、退出 flush、dispose）、命令解析与确认、通知与
错误账本、索引的冻结/刷新策略、按会话保存的状态。共同报告格式（`renderSyncRound` /
`renderSyncStatus`）与统一的凭据脱敏出口（`syncErrorMessage`，git backend 复用同一
`redactCredentials`）在 core；宿主只注入漂移提示与尾部行，并在自己的出口做配置词汇替换。

### `.sync/` 布局

同步状态全在**记忆根**下的 `.sync/`，与 `git/`、`local/` 同级。项目记忆目录保持干净（同步不往里放
`.git`），所有扫描都跳过点开头的目录：

```
<memoryRoot>/
  .sync/
    device.json                 { id, hostname, createdAt }：本机身份，永不同步；publish 的作者来自它
    repo/                       唯一的暂存 clone（工作树 + .git），全部传输通道都跑在这里
    state/<project-key>.json    manifest v2 基线：文件指纹 + transport{ remoteHash, branch }
    sync.lock                   根级跨进程锁
  git/<project>/                记忆本体（这里不加 .git，也不写别的东西）
```

- `transport.remoteHash` 存 `sha256(actualOrigin)`，**不存 URL 也不存凭据**，branch 一并绑定。基线只对
  「同一 origin + 同一 branch」成立：v1 manifest、损坏的 JSON、origin 或 branch 不匹配一律退化成空
  base —— 「绝不能在新传输端按旧 base 删除本地」这条约定就是靠它执行的。
- `sync.lock` 按段持有（传输段一次 `fetch` + origin 读取，发布段一次 `push`），绝不整轮持有；`init` /
  `setRemote` 在同一把锁上做有界等待，且不嵌套在轮次锁内。它与记忆目录里的 `.lock` 是**两把不同的锁**。
- 被遗弃的 `sync.lock` 会让此后每一轮同步失败并给出可操作的错误；`/memory sync unlock` 是唯一被认可的
  清除入口（否则用户得手工去删一个隐藏目录里的文件）。

### 端口契约

引擎只认 `SyncBackend` 端口（`memory-core/src/sync/backend.ts`），既不认字符串 id，也不出现「clone」
「commit」这类 git 专属概念 —— 端口形状是从「将来要接 S3」倒推的。

- `RemoteView.list()` 交出的 hash **恒为 `sha256(bytes)` 的十六进制小写**：差集与 manifest 直接拿它比较。
  backend 若原生只有别的标识（git blob sha1、S3 的 ETag/MD5），换算由 backend 自己负责。
- `list()` 的路径相对 `scope.prefix`（因此是单层 entry 文件名），`scope.prefix` 恒为 POSIX 形态 ——
  远端布局是数据，不跟宿主平台走，否则同一个仓库在两台设备上会算出两个目录。
- `outOfScope` 的判据是**「异常」而不是「不在本 scope 内」**。远端按设计镜像整个记忆根，而一次会话只
  同步当前项目，所以兄弟项目的 `git/<other-key>/*.md` 是每一轮的常态；把它们报进来会让报告条数与正常
  数据同量级，真正那条信号被永久埋掉。只有不该出现在那儿的路径（仓库根 `MEMORY.md`、`local/...`、
  本前缀底下的嵌套目录）才进清单。
- `publish()` 用 `base.revision` 做乐观并发，并在任何远端 mutation 之前复核 `base.remote`（`fetch` 同一把
  根锁内读到的实际 origin）—— 不一致就抛 `NonFastForward`，防止旧进程把 stale delta 写进新 origin。
- `SyncRunOptions.timeoutMs` 是**这次调用的总预算**，不是单次往返的上限：backend 内部的多个 git 子进程
  共享它（`budgeted()` 每跑一个子进程现算剩余量），引擎一轮在多段 backend 调用之间交下去的也是剩余量。
  `signal` 由宿主在退出 / 切会话时接上，让在途的远端操作尽快收尾。

### 规模与复杂度

一轮同步的本地开销是 **O(远端总字节)**，不是 O(变更量)：git backend 每轮 `fetch` 之后用一次
`cat-file --batch` 读出范围内**全部** blob 并逐个算 sha256（`ls-tree` 给的是 blob sha1，与端口契约的
sha256 不同源），`read()` 复用这次批量读的缓存。

参考量级（300 条 CJK 记忆、本机、本地 bare 远端）：`init` 约 39ms、首次 push 约 183ms、**空转 pull
72–77ms**、`status` 约 78ms —— 空转并不便宜，它的成本就是「把远端全部内容读一遍」。

**上万条时该换成 oid 缓存**：把 blob 的 sha1 与内容 sha256 的对应关系缓存在 manifest 里，只对变更的
路径读内容。触发条件是远端总量而不是变更量；在那之前不要拿「只改了一条」去解释或优化这条路径。

自动化测试只跑本地 bare 仓库（无网络、无凭据）。真实托管远端（GitHub / GitLab）上的手动验收清单见
[sync-e2e.md](./sync-e2e.md)。

## 用户契约

磁盘格式、prompt 文本、`memory` 工具的 action 语义不得顺手改。它们对用户是契约，改动要有独立的
spec。

工具提示词（`description` / `promptSnippet` / `promptGuidelines` 三通道）的措辞与预算由
`scripts/prompt-hygiene.ts` 把关，执行点是 `pi-memory/tests/prompt-meta.test.ts`。

## 行尾必须是 LF

`.gitattributes` 固定 `* text=auto eol=lf`。Windows runner 默认 CRLF 检出，会把 `\r\n` 带进
`prompts.ts` 的模板字面量（也就是发给模型的 prompt 本体）。

## 测试

`PI_CODING_AGENT_DIR` 隔离、`tests/helpers/wiring-harness.ts` 的 import 顺序、临时目录与失败
注入的边界，见 [testing.md](./testing.md)。

## 仓内解析 vs 发布形态

`pi-memory` 与 `dsh-memory` 的 `vitest.config.ts` 用 `resolve.alias`、`tsconfig.json` 用 `paths`，把
`@yandy0725/memory-core` 指到 `../memory-core/src/index.ts`，所以日常 `npm test` / `typecheck`
不需要先 build。`dsh-memory` 的 `tsconfig.build.json` 再把 `paths` 清空，构建因此经包 `exports`
解析 `memory-core/dist`。

发布形态有三条，分别由对应 job 覆盖：

- **仓内的 `dist`**：`test-dist` 用 `MEMORY_CORE_FROM_DIST=1` 关掉 alias，让同一套测试打到
  `memory-core/dist`（经包 `exports` 解析）。
- **仓内 tarball**：`workspace-smoke` 把 core 与适配层各自的 tarball 在干净目录同时安装，验证 PR 阶段的
  发布形态与解析；输出明确标注 registry 路径未验证。
- **registry 上的 core**：`registry-smoke` 把适配层打成 tarball 装进干净目录，依赖只从 registry 拉，
  断言解析到的 core 在该目录内、版本满足声明的范围、并能真读写。用户装包时走的就是这条，只在 main 上跑。

解析路径的完整约定与静态闸门（`npm run check:memory-core-deps`）见
[dependencies.md](./dependencies.md) 的「开发走仓内源码，运行走 registry」一节。

## LICENSE 只有根目录一份

仓库根的 `LICENSE` (MIT) 覆盖所有包。`memory-core/`、`pi-memory/`、`dsh-memory/` 目录里**没有**提交的
LICENSE 副本，`package.json` 的 `license` 字段只声明 SPDX 标识。

发布出去的 tarball 仍然带完整许可证文本：各包在 `prepack` 里用 `scripts/sync-license.mjs` 把根
LICENSE 复制进包目录，`postpack` 再删掉；生成物被 `.gitignore` 忽略。原因是 `npm pack` **不跟随**
指向包目录外的符号链接（`ln -s ../LICENSE` 打出来的 tarball 里连条目都没有），而 MIT 要求随附
版权与许可声明，所以文本必须在打包那一刻真实落盘。

不要把副本提交回来：执行点是 `npm run check:license`（`scripts/assert-license-source.mjs`），
`pack-smoke` 另外用 `scripts/assert-pack-manifest.mjs` 断言两个包的 tarball 里都有 `LICENSE`。

## CI job 各自的用途

`.github/workflows/test.yml`：

| job | 覆盖什么 |
|-----|----------|
| `lockfile-sync` | `package-lock.json` 与各 `package.json` 未漂移 |
| `test` | 逻辑（ubuntu + windows），含 `check:license` / `check:host-deps` / `check:memory-core-deps` / `typecheck` / `lint` / `test` |
| `test-dist` | 发布形态的解析路径（见上节） |
| `workspace-smoke` | core 与适配层的仓内 tarball 在干净目录安装后能跑（PR 阶段；不冒充 registry） |
| `registry-smoke` | 适配层 tarball 从 registry 装上 memory-core 后能跑（只在 main 上跑，见上节） |
| `pack-smoke` | tarball 里带齐了 `dist/`、types、`LICENSE` 与 `pi-memory` 的 TS 入口；在干净目录装包后能跑 |

`pack-smoke` 跑 Node 20.16.0（`memory-core` 的 `engines` 下限）与 24 两档，只验证运行时形状，
不跑 vitest —— 开发工具链的 Node 下限高于 `engines`。
