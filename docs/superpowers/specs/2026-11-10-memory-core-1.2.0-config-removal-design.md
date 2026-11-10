# memory-core 1.2.0：把「读配置文件」下放给适配层

日期：2026-11-10
状态：**已并入 2.0.0**（本稿的版本号 1.2.0 / pi-memory 3.1.0 与“串行发布”的表述作废）
范围：`memory-core` 删掉唯一一处文件 IO 与它连带的两处兼容逻辑；`pi-memory` 接过文件读取，
行为不变。
同批交付：与 `2026-11-10-memory-core-task-model-design.md`（任务描述符）一起发 `memory-core 2.0.0` +
`pi-memory 4.0.0`；本稿保留为该切片的细节记录（§7 的具体改动、§7.3 的测试迁移表、§7.4 的冒烟脚本改法）。
发布序与 `smoke:registry` 的处理见那份设计稿 §10。
依据：`docs/superpowers/specs/2026-11-09-dsh-memory-adapter-design.md` §9 痛点 **P1** 的「下一轮」栏
（原文：「按用户定的『core 只提供默认值、不管理配置』把文件 IO 也下放 —— `loadConfigFrom` 标记废弃或
移除，适配层自己读文件再调 `mergeConfig`（对 pi-memory 是破坏性变更，要走独立 spec）」）。

---

## 1. 意图

`memory-core` 的公开面里，`loadConfigFrom(files)` 是唯一还带着宿主形状的东西：它不认任何宿主的路径，
但它的存在本身就是为了「文件是配置的来源」这一种假设。第二个消费者（dsh）的配置根本不是文件 —— 它是
cordis 行递给 `apply(ctx, config)` 的一个对象，所以 dsh 一行都没用过它，只在测试里拿它当合并语义的锚。

于是 core 里同时住着两套等价语义：`mergeConfig`（中立）与 `loadConfigFrom`（中立 + 文件 IO）。
一个核心层不需要知道配置能来自文件。把它删掉之后，core 的配置面只剩三件事：
**默认值**（`DEFAULT_CONFIG`）、**合并语义**（`mergeConfig`）、**共享数据根**（`defaultMemoryRoot`）。

## 2. 目标

- `memory-core` 的 `src/**` 里不再有任何文件读取代码，公开面不再有 `loadConfigFrom`。
- `pi-memory` 自己读它的两个 `memory.json`、自己调 `mergeConfig`，**用户可观察行为零变化**
  （读哪些文件、合并顺序、坏 JSON / 缺文件跳过、`~` 展开、平台规则全部逐字相同）。
- 覆盖靠**迁移**：core 现有的 `describe("loadConfigFrom")` 用例整段搬进 `pi-memory`，期望值不改。

## 3. 非目标

- 不改任何配置**键名**（`thinkLevel`、`sessionPersistence` 等 pi 词汇问题属痛点点 P2 / P6 / P7，另一刀）。
- 不改磁盘格式、prompt 文本、`memory` 工具 action 语义。
- 不动 `dsh-memory/src/**`（它的行 config 只用了 `DEFAULT_CONFIG` / `mergeConfig` / `defaultMemoryRoot` /
  `expandTilde`，这四个都留着）；只改它一条测试的锚。
- 不发版：`memory-core 1.2.0` 与 `pi-memory 3.1.0` 的 tag 由用户单独批准后打。

## 4. 反目标（即使技术上升级成功也算失败）

- core 里留下任何折中：中性的 `readConfigFiles(files)`、deprecated 的 `loadConfigFrom` 薄壳、
  或 `if (host === ...)` 之类的分支。
- `pi-memory` 的配置读取位置、优先级或容错语义有任何变化（用户升级后 `memory.json` 该怎样还怎样）。
- 两个适配层为了这 20 行各自长出一套 deep-merge。

## 5. 约束

- `memory-core/src/**` 只许 import `node:*` 与相对路径（`tests/neutrality.test.ts`），删完 `node:fs`
  后 `config.ts` 只剩 `node:os` 与 `node:path`。
- 适配层之间不互相 import（含测试）：`dsh-memory` 不能为了拿锚去 import `pi-memory`。
- 合并语义必须继续只有一份实现：`mergeConfig`。
- 发布顺序不变：`memory-core` 必须先于 `pi-memory`（`scripts/assert-publish-order.mjs` 自动拦）。

## 6. 方案与取舍

**A（选定）：文件 IO 整体下放到 `pi-memory`。**

| 方案 | 内容 | 为什么落选/入选 |
|---|---|---|
| **A** | core 删 `loadConfigFrom` / 私有 `readJsonSafe` / `LoadConfigFromOptions`；`pi-memory` 的 `loadConfig()` 自己读 `configFiles()` 给的文件、逐个 `mergeConfig`、末尾 `expandTilde` | 直接落地「core 不管理配置」；合并语义仍只有 `mergeConfig` 一份；pi 的行为可以逐字保留（迁移测试为证） |
| B | core 保留一个中性的 `readConfigFiles(files)`（只读文件、不认路径） | 与目标冲突：core 里仍有文件 IO；而 dsh 不读文件，等于为一个消费者养着机制 |
| C | 保留 deprecated 的 `loadConfigFrom` 薄壳 | core 不能 import 适配层，壳只能再实现一遍文件 IO —— 假删除；破坏已被接受，留壳无收益 |

## 7. 已定的怎么做

### 7.1 `memory-core`

**删除**：`readJsonSafe`（私有）、`LoadConfigFromOptions`、`loadConfigFrom`；`config.ts` 里随之不再需要
`node:fs`。

**保留（公开面不变）**：`DEFAULT_CONFIG`、`mergeConfig`、`defaultMemoryRoot`、`expandTilde`、
`taskModel`、`requiredModels`、`modelConfigErrors`、`requiredModel`，以及全部类型
（`MemoryConfig` / `EffortLevel` / `ThinkLevel` / `ModelTask` / 各子 config 类型）。

`src/index.ts` 的配置段导出列表与 `LoadConfigFromOptions` 类型导出同步删掉，段注释改写为
「core 只给默认值与合并语义；配置文件在哪、读不读，是适配层的事」。

### 7.2 `pi-memory`

`src/config.ts` 里 `loadConfig()` 自读自合并，语义按下面这一条链逐字复刻（就是 core 1.1.0 的实现）：

```
cfg = { ...DEFAULT_CONFIG, memoryDir: defaultMemoryRoot() }   // 浅展开，嵌套子树仍与 DEFAULT_CONFIG 共享引用
for (file of configFiles(ctx)) cfg = mergeConfig(cfg, read(file) ?? {})
cfg.memoryDir = expandTilde(cfg.memoryDir, ctx._platform ?? process.platform)
```

`read(file)`：缺文件、不可读、坏 JSON 一律返回 `{}`（跳过）；`mergeConfig` 的
`undefined` 跳过 / 数组整体替换 / `null` 子树原样带入语义不动。
`memoryRoot` 注入缝随 `LoadConfigFromOptions` 一起消失 —— pi 从未用过它（`loadConfig(ctx)` 只传
`platform`），测试里也没有。

重导出面：`loadConfigFrom` 从 `pi-memory/src/config.ts` 的再导出里去掉，其余 6 个符号照旧
（`index.ts` 与其余模块的 import 面不变）。

### 7.3 测试迁移

| 现在在哪 | 怎么处理 |
|---|---|
| `memory-core/tests/config.test.ts` 的 `describe("loadConfigFrom")`（默认值、缺文件、坏 JSON、文件顺序、嵌套合并、残留 `enabled` 键、`~` 展开、平台规则…） | **整段搬**进 `pi-memory/tests/config-paths.test.ts`，改成 `describe("loadConfig")`；入参从「文件列表」换成 pi 的注入缝（`_globalDir` / `_configDirName` / `_platform`），**期望值不变** |
| 同上块里的 `expect(cfg.dream.nudgeAfterSessions)…` / `nudgeAfterHours` 两条 | **删除**：这两个键已搬去 pi 的宿主扩展位（主稿 §7.1），不再是 `MemoryConfig` 的字段。它们的默认值 5 / 24 改在 `pi-memory/tests/nudge.test.ts` 钉 |
| `memory-core/tests/config.test.ts` 的 `describe("公开出口")` | 补一条反断言：`"loadConfigFrom" in api === false`（删除必须能被 CI 看见） |
| `dsh-memory/tests/row-config.test.ts` 的「matches core loadConfigFrom byte-for-byte」 | 改成「与 `mergeConfig` + `expandTilde` 的手工链逐字相等」，不再写临时文件；它仍然钉住「行 config 没有额外合并语义」 |
| `pi-memory/tests/config-paths.test.ts` 文件头注释（「合并语义…都在 core」） | 改成：合并语义在 core 的 `mergeConfig`，**读文件**在 pi 这一侧 |

### 7.4 两个冒烟脚本（真实消费者，断了 CI 就会红）

`scripts/pack-smoke.mjs` 与 `scripts/registry-smoke-runtime.mjs` 都在装好的 tarball 里调了
`loadConfigFrom([])` 来证明「默认数据根跟随 `XDG_DATA_HOME`」。改成直接断言
`DEFAULT_CONFIG.memoryDir === join(XDG_DATA_HOME, "simple-memory")` —— 等价覆盖（`memoryDir` 的默认值就是
`defaultMemoryRoot()`，在模块加载时求值）。

为什么必须用两版都有的符号：`pack-smoke.mjs` 跑的是**本次发布的 memory-core tarball**，而
`registry-smoke-runtime.mjs` 跑的是「适配层 tarball + registry 上满足适配层 range 的 core」——
本轮之后那个 range 是 `^2.0.0`，在 2.0.0 发布前根本找不到版本（见主稿 §10.1）。所以这两个脚本只能用
跨版本稳定的符号（`DEFAULT_CONFIG` / `defaultMemoryRoot` / `MemoryStore`），不能用本轮新加的（`runTask` 等）。

### 7.5 文档

- `memory-core/README.md` / `README.zh.md`：那一行表格（「配置文件在哪…`loadConfigFrom(files)` 收显式列表」）
  与 1.1.0 小节里「`loadConfigFrom` 现在委托给它」都改成过去式；新增「1.2.0：文件 IO 下放」小节，
  写清迁移方式（适配层自己读文件后调 `mergeConfig`）。
- `docs/guides/architecture.md`：「`memory-core` 必须中立」一节补一句「core 不读任何配置文件」。
- `docs/superpowers/specs/2026-11-09-dsh-memory-adapter-design.md` §9 P1 的「下一轮」标注为**已完成（1.2.0）**。

### 7.6 版本与发布

- `memory-core` → `2.0.0`；`pi-memory` → `4.0.0`，其 `dependencies` 抬到 `^2.0.0`（与任务描述符刀同批发）。
- `dsh-memory` 也抬到 `^2.0.0`：它未发布、没有用户，不为兼容留代价。

## 8. 已接受的破坏（用户明确同意）

已发布的 `@yandy0725/pi-memory@3.0.0` 声明 `@yandy0725/memory-core@^1.0.0`。`^1.0.0` 的语义是
`>=1.0.0 <2.0.0`，而配置 IO 下放实际随 `2.0.0` 一起发布（见主稿 §10），因此 `2.0.0` **不在**该范围里：
全新安装 `pi-memory@3.0.0` 仍解析到 core `1.0.1`，不会因缺少 `loadConfigFrom` 导出而在 import 时崩。
真正的迁移对象是**直接以浮动范围依赖 `memory-core` 的任何人**；`pi-memory@3.0.0` 只是不再收到修复。
用户已确认接受，因此只发一次 `2.0.0` + `4.0.0`、不留薄壳。

## 9. 留给建造者的

- pi 侧那个私有读取函数的命名与形态（一处 `try/catch` 包住 `readFile` 即可）。
- `dsh-memory` 那条等价测试的最终措辞（允许它变成「没有额外合并语义」的钉子，但不得为了绿而删）。
- README 新小节的措辞与位置。

## 10. 验收

```
grep -rn "loadConfigFrom" memory-core/src memory-core/README.md memory-core/README.zh.md   # 零命中
npm run check:host-deps && npm run check:memory-core-deps
npm run typecheck && npm run lint && npm test
npm run build -w memory-core && npm run build -w dsh-memory
grep -rn "@deepseek-ai" dsh-memory/dist --include="*.js" | wc -l    # 0
MEMORY_CORE_FROM_DIST=1 npm test -w pi-memory && MEMORY_CORE_FROM_DIST=1 npm test -w dsh-memory
```

外加：`memory-core` 的 `dist/index.d.ts` 里不再出现 `loadConfigFrom`（发布形态也要干净）。

**`npm run smoke:registry` 不在本清单里**：它要求 core 2.0.0 已在 registry 上，而本 PR 合并时还没有。
处理方式见主稿 §10.1（合并 → 发 2.0.0 → rerun 转绿 → 再发 pi-memory 4.0.0）。
