# `pi-memory` 接线测试拆分 + 配置层去 mock

日期：2026-11-10
状态：**待批准**
范围：只动 `pi-memory/tests/**`。`pi-memory/index.ts` 与 `pi-memory/src/**` **一行不改**。
同批：补 `docs/guides/testing.md`（见 §7.7，三处注释已在引用一个本仓不存在的文件）。

---

## 1. 意图

`pi-memory` 的实现已经拆到 `memory-core` 之后只剩 1681 行（其中纯代码约 1080），但
`tests/index-wiring.test.ts` 一个文件占 2427 行、88 个用例 —— 全仓 234 个用例里 38% 挤在一个
文件，也是这个包里唯一名副其实的维护热区。它有两处结构性问题：

1. **一个文件混了八件互不相干的事**：工具注册、索引冻结/重放、shutdown 收尾、extract 通知、
   dream 两条链、auto-surfacing、`/memory` 命令族、配置错误态。改其中任何一件都要在 2400 行里定位。
2. **配置全是手搓的**：`mockConfigValue`（30 行手写对象）+ `dirRef` / `dirOverrideRef`（注释自称
   「用一个可变引用桥接」）+ `afterEach` 里 6 行手工复原 + 散落 8 处 `mockConfigValue.xxx = …`。
   于是「配置错误的重启」这条用例实际测的是「改 mock 假装配置坏了」，而不是用户的真实动作。

## 2. 目标

- 2427 行切成 8 个按宿主关注点的文件，每个 250–450 行；另加 `tests/helpers/` 与一个纯函数测试文件。
- 合并 8 个重复/近重复用例：88 → 80 个（全仓 234 → 226）。
- 配置层从「替换行为」改成「**默认真实 + 按需注入失败**」：`mockConfigValue`、`dirRef`、
  `dirOverrideRef`、`breakModelConfig()` / `restoreModelConfig()` 全部删除。
- **契约覆盖不减**：任何一条现有断言代表的用户可见行为，改动后仍至少有一条用例钉着；合并只发生在
  「同一条契约被两三个用例重复钉」的情形。

## 3. 非目标

- 不动 `src/**` / `index.ts`（这是测试重构，不是实现重构）。任何看起来该改实现的地方只记录、不实做。
- 不改磁盘格式、prompt 文本、`memory` 工具 action 语义。
- 不为了拆文件引入新的测试基建（不加 `setupFiles`、不加自定义 reporter、不加新依赖）。
- 不追求用例数最少化：`index-wiring.test.ts` 现在的注释（`spec §` / `R4x` / `Plan C` 出处）是资产，
  搬家时逐字保留。

## 4. 反目标（即使技术上升级成功也算失败）

- 用例变成「验证 mock 自己的行为」：去 mock 之后，配置相关的期望值必须来自**写出来的 `memory.json`**，
  不是来自另一个手写对象。
- 配置错误态那批用例被简化成「有通知就行」：那批是 `configError` 状态机 + 三处复位路径的唯一钉子
  （跨 session 状态泄漏会让项目 B 写进项目 A 的目录），断言粒度不得下降。
- split 之后同一个契约在两个文件里各钉一次（那是把重复搬了个家，不是消除）。
- `resolveMemoryDir` 真跑起来导致套件明显变慢（见 §5 第三条）。

## 5. 约束（两条已实测，不是推测）

- **helper 里的 `vi.hoisted` 不能 export**：Vitest 直接报 `SyntaxError: Cannot export hoisted
  variable`。可行形态是 helper **自己**调 `vi.mock(...)`（hoisted 与 factory 同模块，能互见），
  只导出 hoisted 派生出来的句柄；mock 对整个测试文件的模块图生效。
- **harness 的 import 必须排在 `../index` 之前**。这条约定的失败模式是响的：顺序错了 mock 根本不
  注册，用例会去读真实 `~/.pi` 配置然后整片变红，不会静默绿。根 `biome.json` 的
  `files.includes` 排除了 `**/tests/**`，Biome 不会重排 import 把它改坏。
- **不 spawn git**：真实 `resolveMemoryDir` 会走 `projectIdentity(cwd)` → 每次 `session_start` 起一个
  `git rev-parse` 子进程；88 个用例 × 两三次启动 ≈ 200 次 spawn。所以目录解析保留一个 3 行 stub，
  但**从真实的 config 参数推导**（`join(cfg.memoryDir, …)`），不需要任何可变引用桥接。
- 测试必须继续在 ubuntu + windows 双平台通过：不依赖 `chmod`、不依赖 POSIX 路径形态。
- `vitest.config.ts` 的 `include` 是 `tests/**/*.test.ts`，`tests/helpers/**` 不会被当测试收集。

## 6. 方案与取舍

三条路都基于同一套去重清单（§7.5）与同一种文件切分（§7.1），差别在「mock 怎么办」：

| 方案 | 内容 | 取舍 |
|---|---|---|
| A | 共享 harness 收走全部 `vi.hoisted` + 7 个 `vi.mock` | 改动最小；但 `mockConfigValue` / `dirRef` / `dirOverrideRef` 这套假货原样搬进 harness，只是换了个位置 |
| B | 每个文件自带约 50 行 mock 前导 | 没有顺序约定；代价是 8 × 50 ≈ 400 行重复，改一个 mock 要改 8 处 |
| **C（选定）** | 配置层走**真实** `loadConfig`（从 `PI_CODING_AGENT_DIR` 下的 `memory.json` 读）+ 按需注入失败；目录解析留 3 行 stub | 删掉整层手搓 fixture；配置错误态用例读起来像用户操作；代价是约 30 个用例要重写 setup 段（断言基本不动） |

选 C 的理由：A 只是把「假货」换个文件放，B 用 400 行重复换一条约定。C 是唯一真正消掉问题根源
（配置由手写对象变成磁盘文件）的一条，而它的额外风险（配置错误态覆盖缩水）可以用 §4 第二条 +
§7.6 的验收清单盯住。

## 7. 已定的怎么做

### 7.1 文件切分与用例归属

| 文件 | 内容 | 用例数 |
|---|---|---|
| `tests/helpers/wiring-harness.ts` | hoisted 状态、8 个 `vi.mock`、纯 fixture、`setupSession()` | — |
| `wiring-session-start.test.ts` | 工具注册（含「只注册一次」）、端到端写入、`injectedFiles` 每次启动清空、只配 `defaults.model` 也能初始化 | 4 |
| `wiring-index-section.test.ts` | 索引 section 冻结、resume/fork/reload 录制值、磁盘回退、无 `sections` 的旧 SDK 退路、空值、`session_compact` 刷新 | 12 |
| `wiring-shutdown.test.ts` | 等在途、超时放弃、空闲不挂定时器、定时器清理 | 4 |
| `wiring-extract.test.ts` | 写入计数与通知、单复数、静默路径、失败配额、非 Error rejection、`ctx` 已销毁、`runTask` 入参、AGENTS.md 提取、端口 5 个 action | 14 |
| `wiring-dream.test.ts` | nudge 链、`/dream` 命令、两条链的 ctx 快照与定时器、端口转发 7 个 action | 10 |
| `wiring-surfacing.test.ts` | 走 store 的召回、同文件不重复、subagent 跳过、`Recalled` 通知、section 在 await 之前写好 | 7 |
| `wiring-commands.test.ts` | `/memory` 状态块、`unlock` 家族、迁移提示、legacy 文件、`on/off` 不再是子命令 | 16 |
| `wiring-config-errors.test.ts` | 模型校验、初始化/`loadConfig` 失败、跨 session 复位、错误态生命周期 | 10 |
| `module-status-line.test.ts` | `moduleStatusLine` 纯函数（原样搬出，不属接线） | 3 |

合计 77 个接线用例 + 3 个纯函数用例 = 80（当前 88，§7.5 合并 8 个；全仓 234 → 226）。

### 7.2 `tests/helpers/wiring-harness.ts`

内容：原来的两个 `vi.hoisted` 块 + 8 个 `vi.mock`（`../src/config`、`@yandy0725/memory-core`、
`../src/nudge`、`../src/memory-tool`、`../src/legacy-hint`、`../src/session-search`、
`../src/index-source`、`@earendil-works/pi-coding-agent` 如需要），导出：

- mock 句柄：`loadConfigMock`、`scanEntriesMock`、`runTaskMock`、`shouldNudgeMock`、
  `readRecordedMemoryIndexMock`、`dreamMetaMock`、`detectLegacyMemoryDirMock`、`createMemoryToolSpy`、
  `resolveMemoryDirMock`、`searchSessionsMock`。
- 纯 fixture：`createFakePi`、`fakeRegistry`、`sectionsEvent`、`legacyEvent`、`uiWith`、`flush`、
  `waitFor`、`disposableCtx`、`captureUnhandledRejections`、`DISK_INDEX`、`LEGACY_TOPIC`。
- `setupSession(opts?)`：`mkdtemp` → 写 `MEMORY.md` → 写 `agent/memory.json` → `vi.stubEnv`，返回
  `{ dir, agentDir, memoryDir, uiCtx(over), cleanup() }`。**不再有模块级可变的目录引用。**
- `uiCtx()` 的 `cwd` 由 `setupSession` 的返回值显式提供，不再是 `dirRef.current`。

`../src/config` 与 `resolveMemoryDir` 的 mock 一律「默认真实」：

```ts
vi.mock("../src/config", async (io) => {
	const actual = await io<typeof import("../src/config")>();
	return { ...actual, loadConfig: loadConfigMock.mockImplementation(actual.loadConfig) };
});
```

### 7.3 新的 `beforeEach` 形状

```ts
let s: Awaited<ReturnType<typeof setupSession>>;
beforeEach(async () => {
	s = await setupSession({ model: "test/model" });   // 写 memory.json + stubEnv
	resetWiringMocks();
});
afterEach(async () => { await s.cleanup(); vi.unstubAllEnvs(); });
```

「配置错误的重启」不再调 `breakModelConfig()`，而是写一份**没有 `defaults.model` 的 `memory.json`**
再触发 `session_start` —— 与用户改坏配置再重启的动作一致。为此 `setupSession` 暴露
`writeConfig(patch)` 供用例中途改写配置。

### 7.4 只剩 5 处需要造假（失败注入）

| 用例 | 注入方式 |
|---|---|
| `loadConfig` 抛错（2 条：初始化失败态 / 首次即失败） | `loadConfigMock.mockRejectedValueOnce(...)` |
| `resolveMemoryDir` 抛错（2 条：初始化失败 / `/memory unlock` 目录不可解析） | `resolveMemoryDirMock.mockRejectedValueOnce(...)` |
| 会话中途配置被改坏（`/dream` 不留状态行） | `loadConfigMock.mockImplementationOnce(...)` 喂坏 config（该用例刻意绕过 `session_start`，本来就必须造假） |
| 「registry 违反契约」（`getAll` 缺失） | 现有 `fakeRegistry` 变体即可，无需 mock |
| 注册/模型的各个形状 | `fakeRegistry(ids, availableIds)`，无需 mock |

### 7.5 去重清单（−8 个用例）

1. 「只注册一次」并入「注册恰好一个 memory 工具」：一个用例断言 5 个 action 枚举 + 不重复注册。
2. `/memory unlock` 的两对「健康会话 / 配置错误会话」逐字同体 → 各折成一个用例，内部循环
   `for (const boot of ["healthy", "misconfigured"])`。
3. 模型校验三条「配置了但解析不出」（未知 id / 无凭据 / 有其它可用模型）只差 registry fixture 与
   期望文案 → 一个 `it.each` 三行。
4. `Extracted 2 memories` / `Extracted 1 memory` → `it.each` 两行。
5. 「headless 不通知成功」+「headless 不通知失败」→ 一个用例两阶段（成功、失败各自静默）。
6. 迁移提示的「探测器返回 null」+「探测器抛错」→ 一个用例两阶段（都是「7 行状态块 + 无提示」）。
7. 「残留 `enabled` 键被忽略」删掉顺带的 `toHaveLength(7)` / `Dir:` 重复断言，只留它真正钉的事。
8. 错误态生命周期用例里 `lines[0]` 的 `toBe` 与 `toContain` 断言同一个字符串，删一个。

### 7.6 验收

- `npm test -w pi-memory`：226 个用例通过（当前 234 − 8），0 skip、0 只跑一半。
- `npm run typecheck -w pi-memory` / `npm run lint -w pi-memory` 干净。
- 逐条核对：§7.5 的 8 条合并之外，**没有任何一个原本存在的契约失去断言**（搬家用例逐个对照原文件）。
- `git diff --stat` 只出现 `pi-memory/tests/**` 与 `docs/`。
- 套件总时长不比现在（2.6s）显著上升，目标 < 4s。

### 7.7 同批补 `docs/guides/testing.md`（提案，我的判断，可否决）

`pi-memory/tests/index-wiring.test.ts:35`、`:1103`、`:1433` 与 `agent-runner-tools.test.ts:41` 已经在引用
`docs/guides/testing.md`，而本仓**没有**这个文件（它是从旧 pi-memory 仓拆过来时漏掉的）。这次改动正好
确立了两条新的通用约定（harness 的 import 顺序、`PI_CODING_AGENT_DIR` 隔离），补一篇短指南比留在
注释里更划算。内容只写通用约定，不写本仓坐标。

## 8. 留给 builder 的决定

- 每个用例具体落在 §7.1 的哪个文件（边界用例：`injectedFiles` 的清空归 session-start 还是 surfacing）。
- `setupSession` 的选项形状（`model` / `extract` / `autoSurfacing` 是否做成快捷开关）。
- `scanEntries` / `shouldNudge` 是否也改成真实实现（当前计划保留 mock：它们是「选择/LLM 边界」，
  真实化会把用例变成文件系统 fixture 的堆叠，收益不明）。
- 合并后的用例标题措辞（保留原有语义，中文注释原样搬）。
