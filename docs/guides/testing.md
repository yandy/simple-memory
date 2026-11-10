# 测试约定

这份指南只写**跨包通用**的约定。某个包的测试怎么组织、有哪些 fixture，看那个包的 `tests/`
本身；这里回答的是「为什么这么写」以及「违反它会以什么方式炸」。

## `PI_CODING_AGENT_DIR` 隔离

任何会走到 `getAgentDir()` 的用例都必须把这个环境变量指到临时目录。`getAgentDir()` 的默认值
是 `~/.pi/agent`，而 `SessionManager.list`、`SessionManager.create`、模型与凭据读取都会经过它
—— 一个没隔离的用例会在开发者机器上读写**真实的** agent 目录，在并行跑整仓时与别的用例互相
踩。

`pi-memory` 的做法是每个用例调用一次 `tests/helpers/wiring-harness.ts` 的 `setupSession()`：
它建一个临时 cwd，把 `PI_CODING_AGENT_DIR` 指到 `<cwd>/agent`，在 `cleanup()` 里
`vi.unstubAllEnvs()` 并删掉整棵临时目录。

**不要在用例中途调用 `vi.unstubAllEnvs()`** 来「恢复」某个环境变量：它会把隔离一起清掉，
后续的 `session_start` 又会去读真实 `~/.pi`，而症状是「某个用例单独跑绿、整仓跑红」。

## harness 的 import 顺序

`tests/helpers/wiring-harness.ts` 注册了 `vi.mock`。任何引用它的测试文件，**它必须排在
`../index` 之前**：

```ts
import { setupSession, createFakePi } from "./helpers/wiring-harness";
import memoryFactory from "../index"; // 必须排在 harness 之后
```

`vi.mock` 的注册发生在 harness 模块求值时，而 `../index` 一旦先求值就会把真实的
`src/config`、`memory-core` 拉进模块图，之后注册的 mock 对它们无效。失败模式是**响的**：
被移动过的用例会成片变红（实测把 harness 挪到 `../index` 之后，一个文件里 89 个用例红了 73 个）。

不要试图写一条「harness 已加载」的自检用例来兜住这条约定：`vi.isMockFunction(绑定的导出)`
在顺序错时**仍然为真**（ESM interop 的命名空间属性是调用时读取的），这条断言钉不住任何东西。
真正的护栏是整片红。

另有一条：`vi.hoisted` 创建的值不能 `export`（`SyntaxError: Cannot export hoisted variable`）。
helper 只能在体内持有 hoisted 结果，导出它的**派生**句柄（`export const x = h.x`）。

## 临时目录

- 用 `mkdtemp(join(tmpdir(), "前缀-"))`，`afterEach` 里 `rm(..., { recursive: true, force: true })`。
- 禁止硬编码 `/tmp/...`：CI 跑 ubuntu 与 windows 两档。
- 不要用 `chmod` 造「不可写/不可读」：Windows 上无效。要造失败路径，用 mock 注入（下一节）。

## 什么时候允许 mock 失败路径

默认让真实实现跑，只在**无法用真实输入构造**的失败上注入：

```ts
// 目录解析本身炸了（HOME 不可写 / git 探测抛错）—— 真实输入无法稳定构造
resolveMemoryDirMock.mockRejectedValueOnce(new Error("no writable home"));
// 配置文件读不出来（`getAgentDir()` 抛错）
loadConfigMock.mockRejectedValueOnce(new Error("getAgentDir failed"));
```

配套要求：

- 这类注入一律用 `...Once`，并在 `beforeEach` 里 `mockReset()` —— 否则队列会串到下一条用例，
  症状是「单独跑绿、按文件跑红」。
- `mockReset()` 会连实现一起清掉。如果某个 mock 的默认行为是「分派到真实实现」，复位后要把它
  装回去（`pi-memory` 的 harness 用一个 hoisted 的可变引用记住那个分派函数）。
- 「会话中途配置被改坏」不要用改文件来模拟：会话内的配置是 `session_start` 那一刻的快照，
  改文件不影响运行中的会话（真实用户也要改完重启）。要测「运行中失败」，注入那次调用的 rejection。
