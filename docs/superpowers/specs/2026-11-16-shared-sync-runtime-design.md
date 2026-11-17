# 共享 SyncRuntime 编排层设计

## 1. 意图

当前 `memory-core` 已经拥有一轮同步的底层能力：backend 端口、三方差集、冲突收敛、锁、manifest、
engine 与写触发 scheduler。但“怎样把这些能力装成一个可用的会话级同步 runtime”仍在
`pi-memory/src/sync.ts` 与 `dsh-memory/src/sync.ts` 各实现一遍，且另一部分相同逻辑散落在 pi 的
`index.ts` 与 dsh 的 runtime 中。

本次调整的目标是让 core 拥有宿主中立的同步编排：**准备、启动、手动轮次、状态查询、换远端、
失败恢复、写触发与收摊只有一份实现**；pi/dsh 只负责宿主配置、生命周期、命令、通知和索引的接线。

这次首先是架构重构，不重设计磁盘格式、同步算法、命令面或用户配置。

## 2. 目标、非目标与反目标

### 目标

1. core 新增公开 `createSyncRuntime`，收编两份 `sync.ts` 的实质重复以及 pi/dsh 宿主文件中与其同构的
   startup/run/status/flush 调用骨架。
2. 保持现有用户行为：首次初始化、空基线、origin 为真相来源、严格 dry-run、启动共享预算、警告先于
   可能产生冲突副本的操作、换远端的持久顺序、失败后的恢复写触发、pi 退出兜底与 dsh 无退出 flush。
3. 保留两种已有的活动协调方式：pi 的立即执行并登记，dsh 的 FIFO 串行；差异通过 core 的显式模式选择，
   不在宿主再写一套同步闸。
4. 共用凭据脱敏和同步报告的共同格式化，消除纯重复，同时允许宿主追加自己的说明与配置文案。
5. runtime 的共有不变量在 core 有直接测试；宿主测试聚焦“事件/命令是否调用 core、宿主副作用是否正确”。

### 非目标

- 不改 `SyncBackend` 的传输契约、manifest 版本、entry/frontmatter、冲突命名、锁与快照算法。
- 不引入新的同步配置键，不让 core 读取或修改任何宿主配置文件。
- 不统一 pi/dsh 的命令解析、确认交互、通知级别、错误账本或索引生命周期。
- 不把 pi 的 shutdown flush 带给 dsh，也不把 dsh 的 per-session Map 带进 pi。
- 不在本次实现 S3 等新 backend，但 runtime 不得把 git backend 写死。
- 不借重构统一两侧已经不同的用户可见诊断文案；宿主自己的措辞仍由宿主拥有。

### 反目标

- 为了“只有一个 API”而强选一种队列或 dispose 时序，改变 pi/dsh 已有行为。
- 把 `/memory`、`memory.json`、`plugin row config`、宿主事件名、UI/logger 类型放进 core runtime。
- 只把两份复制代码搬到第三个文件中，却让宿主仍负责关键不变量。
- 为消除几行表面相似代码而引入通用回调框架、结构化错误大改造或新的配置系统。

## 3. 已确认的现状与约束

### 实质重复

两份 `sync.ts` 中以下主干基本同构：

- 非 git/disabled/配置错误门禁，backend 装配，首次 `ready()` 与 origin 漂移探测；
- 懒 engine、`pendingEngine`、device 创建、`prepare` 的 manifest/transport 信任判定；
- `init → getRemote → emptyManifest + 实际 revision → writeManifest`；
- 首次基线的本地 entry 冲突预告，以及失败时 pending engine 收摊；
- changeRemote 的关闸、排空、dispose、等待 `inFlight`、失效 manifest、`setRemote`、重新准备、
  恢复恰好一次 `noteWrite()`；
- startup 的共享自动预算、手动 run 的 prepare + 一轮、未准备 status 的只读分支；
- 凭据脱敏与大部分 round/status 格式化。

### 必须保留的差异

- pi：活动立即开始并登记；`prepare` single-flight；退出前 `flush` 和宿主自己的有界等待账本；索引在
  会话中冻结；通知分 notice/error；配置来源叫 `memory.json`。
- dsh：startup/run/status/changeRemote 走 FIFO；`dispose()` 被 await 且只 abort + drain，不 flush；按
  session 保存 runtime/errors/notices；手动同步后刷新 index cache；配置来源叫 `plugin row config`。
- dsh 对“origin 已切换、后续步骤失败”有额外诊断，pi 当前没有；不能借共享实现抹掉或强加。
- dsh 删除 manifest 使用 `withFsRetry`，pi 当前直接 `unlink`。共享实现采用 `withFsRetry`：这是文件系统
  可靠性细节，不是宿主策略；除瞬时错误下多重试外，失败时仍原样上抛，origin 仍不得改变。

### core 中立性与公开出口

- `memory-core/src/**` 只能 import `node:*` 与相对路径；runtime 不认识任何宿主包。
- core 源码和测试不得出现宿主 slash 命令与宿主事件名。含 `/memory sync remote ...` 的漂移提示必须由
  宿主注入，不能原样搬进 core。
- 新公开符号只从 `memory-core/src/index.ts` 导出，不增加子路径 export。
- backend、engine 与首份基线的 manifest writer 都由宿主从 core 公开出口注入。core 拥有它们的生命周期与
  调用顺序，但不在通用 runtime 里写死 `createGitSyncBackend`；这也让现有宿主测试的包装工厂与
  `writeManifest` 故障注入继续成为有效观察点，避免 core 内部相对 import 绕过包级测试替身。

## 4. 方案比较与选择

### 方案 A：共享编排层 + 宿主策略（选定）

core 提供完整 SyncRuntime、两种协调模式、共同脱敏和报告格式化；宿主注入 backend/engine 工厂与少量
文案，保留事件、命令、通知、索引和配置接线。

优点：去重覆盖完整主干，关键不变量只有一份，同时能保留真实宿主差异。代价是 core 新增一个有明确职责的
公开组合层，以及少量模式/文案参数。

### 方案 B：只抽最小生命周期内核

只共享 prepare/changeRemote/engine 账本，startup/run/status/队列/格式化仍留宿主。API 较小，但 pi 的
`index.ts` 与 dsh runtime 仍保留明显重复，不符合“尽可能共用”的目标。

### 方案 C：彻底统一同步语义

core 只提供一种 FIFO、一种 dispose 和一套诊断文案，宿主最薄。它会改变 pi 活动启动/退出时序以及部分
用户可见行为，超出本次架构重构的合理风险。

## 5. core 的公开形状

以下是设计契约；实现可在不削弱语义的前提下调整辅助类型名字，但不能改变职责边界。

```ts
export interface SyncRuntimeOptions {
  config: MemoryConfig;
  store: MemoryStore;
  projectDir: string;
  identity: ProjectIdentity;
  scheduling: "concurrent" | "serial";
  createBackend(context: {
    syncRoot: string;
    memoryRoot: string;
    remote: string;
    branch: string;
  }): SyncBackend;
  createEngine(options: SyncEngineOptions): SyncEngine;
  /** 首份基线的写入原语；由宿主从公开出口传入，保留故障注入观察点。 */
  writeManifest: typeof writeManifest;
  messages: {
    /** 含宿主自己的命令指引；core 不内置 slash 命令。 */
    originDrift: string;
    /** 未初始化却请求换远端时，指向宿主自己的配置来源。 */
    uninitializedRemoteChange: string;
    /** 可选：保留宿主对“origin 已改但后续失败”的既有措辞。 */
    formatRemoteChangeFailure?(failure: {
      remote: string;
      originChanged: boolean;
      stage: "prepare" | "operation";
      reason: string;
    }): string;
  };
  now?: () => Date;
}

export type SyncRuntimeOutcome<T> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; reason: string };

export type SyncPrepareResult =
  | { ok: true; engine: SyncEngine; warning?: string }
  | { ok: false; reason: string };

export type SyncRuntimeStatus =
  | SyncStatusReport
  | { initialized: boolean; origin: string | null };

export interface SyncRuntime {
  readonly engine: SyncEngine | null;
  prepare(timeoutMs: number): Promise<SyncPrepareResult>;
  startup(onWarning?: (warning: string) => void): Promise<SyncRuntimeOutcome<SyncRoundResult | null>>;
  run(
    kind: "pull" | "push",
    timeoutMs: number,
    onWarning?: (warning: string) => void,
  ): Promise<SyncRuntimeOutcome<SyncRoundResult>>;
  status(timeoutMs: number): Promise<SyncRuntimeOutcome<SyncRuntimeStatus>>;
  changeRemote(
    remote: string,
    timeoutMs: number,
    onWarning?: (warning: string) => void,
  ): Promise<SyncRuntimeOutcome<null>>;
  /** 无已准备 engine 时返回 null；其余语义与 SyncEngine.flush 相同。 */
  flush(timeoutMs: number): Promise<SyncRoundResult | null>;
  noteWrite(): void;
  /** 调用时同步关闭入口并 abort/dispose；返回的 promise 只负责 drain，不发起 flush。 */
  dispose(): Promise<void>;
}

export function createSyncRuntime(options: SyncRuntimeOptions): Promise<{
  runtime: SyncRuntime | null;
  errors: string[];
  notices: string[];
}>;
```

`backend` 与 `syncRoot` 不进入新的公开 runtime 面：生产宿主在 status 收进 core 后不再需要直接读 backend，
解锁仍使用既有 `syncRootPath`/`syncLockPath`。测试通过注入工厂捕获 backend/engine，而不是为测试保留无生产
消费者的字段。

`prepare` 仍公开，供需要分阶段接线的宿主使用；pi/dsh 的正常 startup/run 不再自行拼这段流程。

## 6. SyncRuntime 的行为契约

### 6.1 装配与门禁

1. 从传入 config、identity、store 计算 memoryRoot、syncRoot、remote、branch、projectKey；通过注入工厂
   创建 backend，engine 保持 `null`。
2. 非 git、disabled、配置非法的返回形状与今天相同；同步失败不得影响 store 和其他记忆功能。
3. 首次 `ready()` 只用于配置校验和 origin 漂移提示；`ready() === true` 时允许配置 remote 为空。
4. 所有 runtime 产生的错误文本先经 core 的同步脱敏；宿主可在自己的边界再做配置词汇替换。
5. 工厂本身不 init、不写 device、不写 manifest。

### 6.2 prepare 与懒 engine

保持当前顺序和失败语义：

1. 校验有限正预算；disposed/remote-change busy 走各自既有结果。
2. `ready → readManifest →（必要时）getRemote → transport 匹配`。完整基线且 engine 已存在时走快路径，
   不重新 init。
3. 未 ready 或 transport 不匹配时调用 `backend.init`，登记 AbortController；init 后从实际 origin 构造固定
   空基线，写入 init 返回的真实 revision，不能复用 drift 配置或旧 base。
4. 只有 init 共存检查通过后才 `loadOrCreateDevice` 并创建 engine；交付前的 engine 记入 pending 账本。
5. 首次基线用 `store.listEntries()` 生成冲突副本预告。任一 await 后重新检查 disposed；失败时 dispose
   pending engine，manifest 缺失/不匹配留待下一次 prepare 重试。
6. concurrent 模式下并发 prepare 共用同一 flight，并返回同一 engine。serial 模式的 prepare 由排队后的
   高层操作调用，仍保留 single-flight 防护。

### 6.3 startup / run / status / flush

- `startup`：只计算一次 `autoTimeoutMs` deadline；先 prepare，再先交付 warning；`pullOnStart !== true`
  时返回 `value: null`。需要启动轮时用剩余正预算执行一次 `push`；预算耗尽返回成功、`value: null` 和现有
  “下一轮再推”warning，不发起 1ms 网络轮。
- `run`：prepare 后先交付 warning，再以调用方给出的完整手动 `timeoutMs` 执行 `engine[kind]`；不像
  startup 那样扣减 prepare 用时。
- `status`：严格 dry-run。已有 engine 时调用 `engine.status(timeoutMs)`；否则只读 `backend.ready()` 与
  `getRemote()`，绝不 prepare/init、创建设备或写 manifest。
- `flush`：供 pi 的退出兜底使用；无 engine 返回 `null`，有 engine 时直接调用其 `flush(timeoutMs)`。
  `null` 不表示成功，成败仍由返回 round 自己表达。dsh 不调用它。
- warning 回调只负责“在产生冲突副本之前让宿主看到 warning”；core 不决定它走 UI、logger 还是数组。

### 6.4 活动协调模式

**concurrent（pi 选择）**：

- startup/run/status/flush 在公开调用返回前就开始执行，并登记到活动集合；不得仅因登记多引入一个微任务。
- changeRemote 在调用时同步关闸，新活动立即拒绝；随后排空已登记活动与 prepare flight。
- engine 的自动 scheduler 轮次继续由 `engine.inFlight` 单独登记，不塞进宿主活动队列。

**serial（dsh 选择）**：

- startup/run/status/flush/changeRemote 使用 core 内的一条 FIFO tail；已经排队的操作允许完成。
- changeRemote 在公开调用时就同步关闸并排入 tail，之后的新活动立即 busy，不能排到它后面；第二个
  changeRemote 不能共享第一个的结果。
- 操作真正开始时仍登记活动，使两种模式共用后续排空和恢复代码。

两种模式共享以下持久顺序：

1. 关闸并等待已登记手动活动/prepare/tail；
2. 取出旧 engine、将公开 engine 置空、dispose 旧 engine；
3. 等待旧 `engine.inFlight` 真正 settled（abort/dispose 不等于 settled）；
4. 经 `withFsRetry` 删除项目 manifest，ENOENT 幂等；删除失败则 origin 不动；
5. `setRemote`，然后按同一 prepare 流程建立新空基线；
6. 首次基线 warning 先于 replacement `noteWrite()`；无论成功失败，都恢复一个 engine 并恰好调用一次
   `noteWrite()`，接住旧 dirty 与关闸期间的写入。

`noteWrite()` 在 disposed 或 changeRemote 关闸期间不直接触碰旧 engine；第 6 步的 replacement trigger 保证
这些写入仍有下一次自动发布机会。pi 改走这个 runtime 入口后不再直接调用 `runtime.engine?.noteWrite()`。

### 6.5 changeRemote 的宿主诊断

core 始终知道 `originChanged` 与失败发生在 prepare 还是其他 operation，但默认只返回原始、已脱敏 reason。
dsh 通过 `formatRemoteChangeFailure` 生成现有的“origin 已切换，但 prepare/后续操作失败”文案；pi 不传该
formatter，保持当前文案。恢复写触发自身的失败仍追加到最终 reason，不被 formatter 吞掉。

### 6.6 dispose 与 drain

`dispose()` 的同步部分立即：关闭入口、abort init、将 engine/pending 置空并 dispose 两者、取消 scheduler。
随后返回一个幂等 promise，drain 当前 tail、活动集合、prepare/changeRemote flight 与旧 engine 的
`inFlight`；绝不调用 flush，drain 自身也不发起新操作。

drain 是等待已接纳工作，不是取消已经启动的原子写：dispose 前 prepare/changeRemote 已经调用的
`writeManifest` 可以在 drain 内完成，且 dispose 必须等它完成。因此收摊后盘上可以留下一份绑定实际或新
origin 的一致空 v2 基线，但 `runtime.engine` 仍为 `null`，也不会补发 replacement `noteWrite()`。dispose
调用后不得再启动新的 manifest 写入；drain resolve 后不得残留写入或 I/O，也不得再启动新的写入或 I/O。

- dsh `await dispose()`，保持现有 abort + drain。
- pi 调用后仍使用自己的 `track` + 有界 shutdown 等待，不把无界 drain 直接 await 在退出路径上；core 返回的
  promise 不 reject，可由 pi 安全地 `void`。pi 在 dispose 前自行快照需要在退出账本里继续等待的旧 engine/
  inFlight。

## 7. 脱敏与报告格式化

### 7.1 core 拥有共同部分

新增中立的 `syncErrorMessage(error: unknown): string`，把目前 backend-git 私有的同一套 URL userinfo 脱敏
规则与两个宿主重复的正则收敛到一处；backend-git 内部也复用，避免第三份实现。

共同报告格式化进入 core：

```ts
renderSyncRound(result: SyncRoundResult): string;
renderSyncStatus(
  report: SyncStatusReport,
  configuredRemote: string,
  options?: {
    originDriftMessage?: string;
    trailingLines?: readonly string[];
  },
): string;
```

它们保留现有的排序、按文件去重、失败轮展开、空/缺 revision 区分和最终脱敏。core 在检测到配置与 origin
漂移时追加宿主传入的 `originDriftMessage`，自身不含 slash 命令；`trailingLines` 只放确实跨宿主一致的报告
尾部扩展，不是通用通知通道。

### 7.2 宿主保留展示策略

- pi 传自己的 drift 指引和 `"Prompt index: frozen ..."` 行；UI 通知前缀、notice/error 级别、去重与增量
  通知仍在 pi。
- dsh 传自己的 drift 指引，在文本出口继续做 `memory.json → plugin row config`；`renderSyncSummary`、
  session errors/notices/persistentErrors 账本仍留 dsh。
- 命令 usage、参数错误、unlock 确认/ `--force`、disabled 的使用指引不进入 core 格式化器。

这里共享的是**同一份同步报告的共同格式**，不是把宿主 UI 抽象进 core。

## 8. pi/dsh 的最终职责

### pi

- 从 `memory.json` 读配置并构造 store/identity；以 `scheduling: "concurrent"` 调用 core 工厂。
- 在正确的宿主事件中 await `runtime.startup()`，保持它发生在索引来源选择/冻结之前；保留 resume/fork/
  reload 的录制索引例外。
- 成功写入调用 `runtime.noteWrite()`；shutdown 使用 `runtime.flush()` 和自己的有界等待；dispose 只做收摊，
  不在 core 里识别任何 shutdown reason。
- 命令调用 runtime 的 status/run/changeRemote；自行 rebuildIndex、渲染、通知和处理 UI 异常。
- 保留会话世代号、context 快照、sync notices/errors 账本。

### dsh

- 从行 config 得到配置并构造 store/identity；以 `scheduling: "serial"` 调用 core 工厂。
- 在根 agent 创建时、第一次 index cache refresh 前 await `runtime.startup()`；保留 per-session Map 和根 agent
  门禁。
- 成功写入调用 `runtime.noteWrite()`；await `runtime.dispose()`，没有退出 flush。
- 命令调用 runtime 后刷新 index cache；自行处理配置词汇、日志、持久漂移错误和 `--force` unlock。

两侧原有 `sync.ts` 可以保留为很薄的宿主适配文件，但不得再拥有 prepare/changeRemote 等第二份编排实现。

## 9. 测试策略

### core 新增 runtime 测试

用注入的假 backend/engine 与真实临时文件系统覆盖关键不变量，必要时再以真 git 做少量端到端验证：

1. disabled、非 git、非法配置不创建 sync 状态；initialized + 空 remote 合法；origin drift 使用注入文案。
2. engine 懒创建、固定空 v2 基线、真实 origin/branch 绑定、二次 prepare 不 init、transport mismatch 重置。
3. concurrent prepare single-flight；dispose-during-init 的 abort、pending engine 收摊与不建 device。
4. startup 共享预算、pullOnStart false、预算耗尽 warning；手动 run 不扣减预算；warning 严格先于轮次。
5. status 严格 dry-run；flush 无 engine 返回 null，有 engine 透传结果。
6. concurrent 活动立即开始并登记；serial FIFO；changeRemote 调用即关闸，第二次 busy。
7. changeRemote 的完整持久顺序、旧 inFlight drain、manifest 删除失败不改 origin、成功/失败都恰好一次
   replacement noteWrite、warning 先于 replacement trigger。
8. dsh formatter 与默认原始 reason 两种诊断；恢复 trigger 失败仍追加。
9. dispose 幂等、同步 abort/dispose、drain 不 flush；serial tail、automatic inFlight 与已启动的 manifest
   writer 都被等待，writer 可在 drain 内完成，但 dispose 后不启动新写、不交付 engine、不补 replacement trigger。
10. `withFsRetry` 的删除重试不改变最终 fail-closed 语义。

公开出口测试补充 `createSyncRuntime`、`syncErrorMessage` 和两个共同 renderer；中立性测试继续零例外。

### 宿主测试

- 现有 pi/dsh 集成用例继续跑，尽量不改用户可见期望；通过注入的 backend/engine 工厂保留顺序、预算、
  inFlight、noteWrite 等观察点。
- 已在 core 直接钉住的通用算法不必在两侧各复制一套单元测试，但每个宿主至少保留一条启动、手动命令、
  换远端、写触发和收摊的接线验证。
- pi 的 shutdown、冻结索引、通知与配置文案测试保留；dsh 的 FIFO 外部表现、index refresh、session 账本、
  plugin row config 与无退出 flush 测试保留。
- 共同 renderer 的字段/排序/去重在 core 测；宿主只测各自 drift 文案、尾部说明与配置词汇替换。

### 验证门

实现后运行并通过：全仓 `npm test`、`npm run typecheck`、`npm run lint`、三道静态检查、core/adapters 的
`test-dist` 等价验证及 `npm run smoke:workspace`。Windows 相关的现有 CI 覆盖不能削弱。

## 10. 兼容性与发布约束

- 对 core 是新增 API，按 minor 处理；源码版本目标为 `memory-core@2.2.0`。
- pi/dsh 对 core 的依赖下限必须改为 `^2.2.0`，不能让安装解析回没有 `createSyncRuntime` 的 2.1.x。
- 本次不执行发布。实际发布仍须先发布 core，再让使用新 API 的适配层进入依赖 registry smoke 的路径；
  workspace smoke 不能冒充 registry smoke。
- 不改变 pi 的宿主包版本下限，也不改变 dsh 的宿主 peer 约束。
- 更新架构/参考文档，使其只描述调整后的现状；历史设计文档保留为决策记录，不在用户文档里写迁移史。

## 11. 留给实现者的部分

- runtime 内部辅助函数、队列/活动账本的模块拆分与变量命名。
- 为测试选择假 backend/engine 的具体夹具，以及最少量的真 git 用例。
- 宿主测试观察点的具体迁移方式，只要不通过 mock 掉被测 runtime 来制造绿色。
- 是否把共同 renderer 放在独立 `sync/view.ts`、脱敏放在 `sync/errors.ts`；它们仍只能从包公开出口供宿主
  使用。
