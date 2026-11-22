# CI 分级测试设计

## 意图

`.github/workflows/test.yml` 目前对任何改动都跑满全部 job。一次 main push 的实测耗时：`test (windows)` 195s、
`test (ubuntu)` 53s、`test-dist` 37s、`workspace-smoke` 14–20s、`registry-smoke` 14–18s、`pack-smoke` ×2 各 17s、
`lockfile-sync` 6s。改一个 `docs/**` 的 md 也会付这笔账。

目标：按「这次改动能不能影响代码 / 能不能影响发出去的产物」分级，文档改动不跑代码测试，只在产物形态可能
变化时才跑打包与 registry 冒烟。参考 `yandy/pi-packages` 的 `dorny/paths-filter` 结构。

## 目标 / 非目标

- 目标：docs-only 的 PR 在 ~15s 内给出绿色结论；tests-only 的改动跳过打包与 registry 冒烟；打包/registry
  冒烟只在真正相关时跑。
- 目标：任何**代码**改动仍然跑 Windows 腿。Windows 抓过真实 bug（`vi.waitFor` 默认 1s、`EBUSY` 删除、
  预算超时），PR 上不放松这一关。
- 非目标：不做包级矩阵（`pi-memory` / `dsh-memory` 的 vitest alias 直指 `memory-core/src/index.ts`，改
  core 必须重跑两个适配层，矩阵收益接近零）；不引入 nightly / 定时任务；不改任何测试内容。

## 约束

- 仓库只有 3 个包，其中 2 个依赖第 3 个的**源码**，所以「改哪个包跑哪个包」不成立。
- `pi-memory` 以 TS 源码发布，`src/**` 就是产物；`dsh-memory` 目前 `private: true` 但同样有 dist 和 tarball
  形态可验。
- `registry-smoke` 只在 push 到 main 才有意义（PR 阶段的 core 尚未发布），这条保留。

## 方案（已选定）

在 pi-packages 式的 `dorny/paths-filter` 结构上按**成本**分档，而不是按包分矩阵。三个过滤器
（`predicate-quantifier: some-with-excludes`，即「命中任一正向规则且不命中任何排除规则」）：

```yaml
code:      # 任何非文档改动 → tier1
  - '**'
  - '!**/*.md'
  - '!docs/**'
artifact:  # 可能影响发出去的东西 → tier2 / tier3；显式正向清单
  - 'package.json'
  - 'package-lock.json'
  - '*/package.json'
  - 'tsconfig.base.json'
  - '*/tsconfig*.json'
  - 'vitest.config.ts'
  - '*/vitest.config.ts'
  - 'LICENSE'
  - 'scripts/**'
  - '*/src/**'
  - '*/index.ts'
  - '.github/workflows/**'
manifest:  # 只影响依赖图 → 额外跑 lockfile-sync
  - 'package.json'
  - '*/package.json'
  - 'package-lock.json'
```

`artifact` 用显式正向清单而不是「code 减去 tests」：向后兼容的写法在新增目录时会静默漏掉，显式清单漏掉
时 **tier1 仍然会跑**（fail safe），代价只是少跑一次冒烟，且清单本身是「哪些路径能改变产物」这个判断的
落地处。workflow 里会写一行注释说明新增构建路径时要加进来。

### 分档

| 档 | job | 触发条件 |
|---|---|---|
| 0 | `changes`（paths-filter） | 永远跑；也是唯一的「什么都没改」时的结论 |
| 1 | `test` ubuntu + windows | `code == 'true'`；含 `typecheck` / `lint` / `vitest`；三条 check 脚本只在 ubuntu 腿跑 |
| 1 | `lockfile-sync` | `manifest == 'true'` |
| 2 | `test-dist` | `artifact == 'true'` |
| 2 | `workspace-smoke` | `artifact == 'true'` |
| 2 | `pack-smoke`（Node 20.16 / 24） | `artifact == 'true'` |
| 3 | `registry-smoke` | `push` 到 main **且** `artifact == 'true'` |

`docs-only`（只改 `**/*.md`、`docs/**`）→ 只有 `changes` 跑，秒过，不需要任何占位 job。
`tests-only`（只改 `*/tests/**`）→ tier1 全跑（含 Windows），跳过所有冒烟。

### 保留与收紧

- `registry-smoke` 的 `github.event_name == 'push'` 条件保留，再加 `artifact` 门。
- `pack-smoke`、`workspace-smoke`、`test-dist` 的语义、注释、断言一律不动，只改 `if:`。
- `changes` job 在 PR 事件上不需要 checkout（走 REST API，需要 `permissions: pull-requests: read`），push 事件
  上需要 checkout 才能用 git 算 diff；checkout 显式 `fetch-depth: 0`，避免深度不足时把「全部文件都算改动」
  当成结果。
- `*/vitest.config.ts` 必须在 `artifact` 里：它是 `test-dist` 关闭 alias 的开关（`MEMORY_CORE_FROM_DIST`），
  漏了就会在「把开关改坏」的那次提交上跳过 `test-dist`。

### 不加 `workflow_dispatch` 的 `force_full`

需要一次强制全量时，推一个触碰 `artifact` 路径的提交（例如 `scripts/` 或 workflow 自身）即可；重跑同一次
run 的事件负载不变，paths-filter 会算出同样的 diff，加了输入也解决不了「重跑历史提交」这个用例。这条是
实现期的判断，评审可推翻。

## 留给实现者的

- 具体 `if:` 表达式写法、`needs: changes` 的编排、job 顺序。
- 是否需要给 `workflow_dispatch` 加一个 `force_full` 输入（当前判断：不加 —— 需要全量时推一个触碰
  `scripts/` 的提交或直接 rerun 即可；如果实现时发现 rerun 会重跑被跳过的 job 这条不成立，就加输入）。
- 改完在自己的 fork / 分支上确认四种形态（docs-only、tests-only、src-only、scripts/）的 job 组合符合上表。

## 我的判断（可在评审时推翻）

- 三条 check 脚本（`check:license` / `check:host-deps` / `check:memory-core-deps`）目前 ubuntu 与 windows
  都跑；Windows 上是纯 Node 脚本、与平台无关，收成 ubuntu-only。省下的绝对值很小，纯粹是「Windows 腿
  只跑平台相关的事」这条一致性。
- 文档侧同步一小节写进 `docs/guides/testing.md`（「CI 分层」）：只写现状 —— 哪一档跑什么、新增路径要加进
  `artifact` 清单。不写「以前是全量」这类过程叙事。
