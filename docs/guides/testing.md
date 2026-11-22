# 测试约定

只写**跨包通用**的约定：某个包的测试怎么组织看那个包的 `tests/`，这里回答「为什么这么写」与「违反它
会怎么炸」。

## `PI_CODING_AGENT_DIR` 隔离

任何会走到 `getAgentDir()` 的用例都必须把这个环境变量指到临时目录：默认值是 `~/.pi/agent`，
`SessionManager.list` / `create`、模型与凭据读取都会经过它 —— 没隔离的用例会在开发者机器上读写**真实的**
agent 目录，并与并行跑的用例互相踩。

`pi-memory` 的做法是每个用例调用 `tests/helpers/wiring-harness.ts` 的 `setupSession()`：建一个临时 cwd、
把 `PI_CODING_AGENT_DIR` 指到 `<cwd>/agent`，`cleanup()` 里 `vi.unstubAllEnvs()` 并删掉整棵临时目录。

**不要在用例中途调用 `vi.unstubAllEnvs()`** 来「恢复」某个环境变量：它会把隔离一起清掉，后续
`session_start` 又会去读真实 `~/.pi`，症状是「某个用例单独跑绿、整仓跑红」。

## harness 的 import 顺序

`tests/helpers/wiring-harness.ts` 注册了 `vi.mock`，所以引用它的测试文件里**它必须排在 `../index`
之前**：

```ts
import { setupSession, createFakePi } from "./helpers/wiring-harness";
import memoryFactory from "../index"; // 必须在 harness 之后
```

`vi.mock` 在 harness 模块求值时注册；`../index` 先求值就会把真实的 `src/config`、`memory-core` 拉进模块
图，之后注册的 mock 对它们无效。失败模式是**成片变红**，不是单条。

不要用「harness 已加载」的自检用例兜这条约定：顺序错时 `vi.isMockFunction(绑定的导出)` 仍然为真
（ESM 命名空间属性是调用时读取的），钉不住任何东西。

另有一条：`vi.hoisted` 创建的值不能 `export`（`SyntaxError: Cannot export hoisted variable`）—— helper
只能在体内持有 hoisted 结果，导出它的**派生**句柄。

## 临时目录

- 用 `mkdtemp(join(tmpdir(), "前缀-"))`，`afterEach` 里 `rm(..., { recursive: true, force: true })`。
- 禁止硬编码 `/tmp/...`：CI 跑 ubuntu 与 windows 两档。
- 不要用 `chmod` 造「不可写/不可读」：Windows 上无效。要造失败路径，用 `vi.mock` 注入。

## 什么时候允许 mock 失败路径

默认让真实实现跑，只在**无法用真实输入构造**的失败上注入：

```ts
// 目录解析本身炸了（HOME 不可写 / git 探测抛错）
resolveMemoryDirMock.mockRejectedValueOnce(new Error("no writable home"));
// 配置文件读不出来（`getAgentDir()` 抛错）
loadConfigMock.mockRejectedValueOnce(new Error("getAgentDir failed"));
```

- 这类注入一律用 `...Once`，并在 `beforeEach` 里 `mockReset()` —— 否则队列会串到下一条用例（症状：
  单独跑绿、按文件跑红）。
- `mockReset()` 会连实现一起清掉：默认行为是「分派到真实实现」的 mock，复位后要把它装回去。
- 「会话中途配置被改坏」不要用改文件模拟：会话内的配置是 `session_start` 那一刻的快照，改文件不影响
  运行中的会话。要测「运行中失败」，注入那次调用的 rejection。

## 什么时候必须上真机

假宿主能覆盖语义，覆盖不了**宿主自己的行为**：服务注入是否成立、`tools.restrict()` 的真实语义、子会话在
哪个阶段建得起来、进程退出会不会打断后台任务。`dsh-memory` 就在「插件到底有没有激活」上栽过 —— 单测
全绿，真机上插件一次都没生效。

每个包把「真机验过什么、怎么验、还有哪些限制」写在自己的参考文档里（`docs/reference/dsh-memory.zh.md`
的「验证状态」一节）。跨设备同步还有一层**真实托管远端**（网络 + 凭据）的验收，自动化测试覆盖不到，照
[sync-e2e.md](./sync-e2e.md) 手动走一遍。

## CI 分层

`.github/workflows/test.yml` 先用一个 `changes` job（`dorny/paths-filter`）判出三个输出，再把其余 job 挂在
它们上面：

| 输出 | 命中条件 | 打开哪些 job |
|---|---|---|
| `code` | 任何非 `.md`、非 `docs/` 的改动 | `test`（ubuntu + windows：`typecheck` / `lint` / `vitest`） |
| `artifact` | 源码、`package.json`、构建与打包配置、`scripts/`、`LICENSE`、CI 自身 | `test-dist`、`workspace-smoke`、`pack-smoke`、以及 push 到 main 时的 `registry-smoke` |
| `manifest` | 三个 `package.json` 与 `package-lock.json` | `lockfile-sync` |

只改文档时三个输出全为 false，只剩 `changes` 跑 —— 文档改动不触发任何代码测试。只改 `*/tests/**` 会跑
`code` 那一档（含 Windows），但不跑任何冒烟。

`artifact` 是**显式清单**：新增顶层源目录或新的构建配置文件时必须加进去，否则打包与 registry 冒烟会在相关
改动上静默跳过。`*/vitest.config.ts` 也在清单里 —— 它是 `test-dist` 关 alias 的开关。

三条 check 脚本（`check:license` / `check:host-deps` / `check:memory-core-deps`）只在 ubuntu 腿跑：它们是
纯 Node 脚本，与平台无关。
