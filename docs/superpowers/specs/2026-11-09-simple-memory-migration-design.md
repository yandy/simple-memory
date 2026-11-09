# simple-memory 迁移设计（memory-core / pi-memory 出仓）

日期：2026-11-09
状态：**待批准**
范围：新建 monorepo `github.com/yandy/simple-memory`（`memory-core`、`pi-memory`、`dsh-memory` 占位）；`pi-packages` 删除 `pi-memory`，并把 `feat/auto-memory-core-split` 收尾为「只做删除 + 引用清理」。
不在范围：任何 npm 发布动作、dsh 插件实现、磁盘格式变更、`memory` 工具语义变更、用户数据的自动迁移。

---

## 1. 背景与目标

`pi-memory` 已被拆成两层（`docs/superpowers/specs/2026-11-08-auto-memory-core-split-design.md`）：harness 无关的 core（拆分期暂名 `auto-memory`）与 pi 适配层（`pi-memory` 3.0.0）。拆分的目的不是「代码更整齐」，而是让同一份磁盘记忆被多个 harness 共享。这个目的对布局有两个硬要求：

- **core 必须能被 pi 之外的东西依赖** → 它得是可发布的 npm 包，不能是某个 monorepo 里的 `private` workspace（out-of-tree 插件解析不到宿主包，只能把 core 当自己的真依赖）。
- **core 与适配层必须贴着放** → 适配层只实现两个端口（`HeadlessAgentPort` / `HostTranscriptPort`），它的正确性由 core 的版本决定；分仓就要靠版本号对齐，而 dsh 适配层当下连一行代码都没有。

因此把三个包收进独立 monorepo `simple-memory`，`pi-packages` 只保留 pi 生态其余 9 个包。

## 2. 已确认决策

| 编号 | 决策 | 理由 |
|---|---|---|
| **D1** | 目标仓是 monorepo，三个 workspace：`memory-core`、`pi-memory`、`dsh-memory` | 三者共享一份契约（core 的端口、纯 JSON Schema、prompt 文本、磁盘格式）。拆成三个仓就要用版本号对齐这份契约，而 dsh 侧还没有实现可供对齐 |
| **D2** | `auto-memory` 改名为 `memory-core`：包名 `@yandy0725/memory-core`，目录 `memory-core/` | 「auto-memory」在 pi 的语境里指「自动落记忆」这套机制（auto-surfacing / extract），与包的角色（共享内核）不是一回事 |
| **D3** | 共享数据根改为 `$XDG_DATA_HOME/simple-memory`（未设置或非绝对路径时 `~/.local/share/simple-memory`），其下 `<git\|local>/<project>/` 结构与磁盘格式逐字不变 | 数据根与仓名对齐，用户在 `ls ~/.local/share` 里一眼能反查到写它的仓库；3.0.0 尚未发布，改名没有兼容成本 |
| **D4** | 保留 `@yandy0725` scope；版本：`memory-core` 1.0.0、`pi-memory` 3.0.0、`dsh-memory` 0.0.0 | `pi-memory` 3.0.0 的破坏性变更（数据根搬家）由拆分设计 D8 定案，本次不改版本号 |
| **D5** | 这次就把发布形态做完：`memory-core` 加 `dist` 构建、`exports`/`main`/`types` 指向 `dist`、`files`、`repository`、`publishConfig`，去掉 `private`；同步补 `publish.yml` | 新仓存在的理由就是「让别的 harness 装得上 core」。把 `exports` 的翻转留到发布那一刻，等于让一个必然失败的时刻（首次发布）去承担从没跑过的代码路径 |
| **D6** | `memory-core` 的包入口是 `dist`，但**仓内**解析走源码：`pi-memory` 的 `vitest.config.ts` 用 `resolve.alias`、`tsconfig.json` 用 `paths` 指向 `../memory-core/src/index.ts` | 日常 `npm test` / `typecheck` 不引入「先 build」的顺序依赖；发布出去的那个形状（`dist` + `files`）由 CI 单独验证，不走开发路径 |
| **D7** | `dsh-memory` 只是占位：`package.json`（`private`、零依赖、零脚本）+ `README.md`。零代码、零测试、不进 vitest projects | 占位的价值是把「dsh 适配层住哪」写进仓库结构。真实现要 cordis 装配、schemastery 转换、profile 打包，各有独立验证成本 |
| **D8** | `pi-packages` 的 `feat/auto-memory-core-split` 就地收尾为「删除 `pi-memory` + 清理引用」，用**追加提交**实现，不改写已推送历史 | 拆分代码在新仓有了去处，pi-packages 只需回到「没有 memory 包」的状态。改写历史会让已评审、CI 全绿的 14 个提交从 PR 里消失，而它们正是这段代码的唯一评审记录 |
| **D9** | 新仓用单个 initial commit，不迁 `pi-packages` 历史 | `pi-packages` 的历史里混着 9 个与 memory 无关的包，`filter-repo` 抽子目录后 SHA 全变、跨仓交叉引用照样断；包的 lineage 从发布起算，版本历史由 npm 与 GitHub Release 承担 |

**明确排除（非目标）**：npm 发布、对旧版本执行 `npm deprecate`、dsh 插件实现、opencode 适配、磁盘格式 / `memory` 工具语义 / prompt 文本的任何改动、用户数据自动迁移代码。

## 3. 目标仓结构

```
simple-memory/
├── package.json              private:true · workspaces:[dsh-memory, memory-core, pi-memory] · 4 个共享 devDeps
├── package-lock.json
├── tsconfig.base.json        沿用 pi-packages 的同名文件
├── biome.json                沿用（lineWidth 120、tab、双引号）
├── vitest.config.ts          projects: ["memory-core", "pi-memory"]
├── .gitignore                node_modules/ · dist/ · .worktrees/ · **/docs/superpowers/plans/
├── .gitattributes            * text=auto eol=lf（逐字沿用 pi-packages）
├── LICENSE                   MIT（Copyright (c) 2026 Michael Ding，沿用 auto-memory/LICENSE）
├── README.md / README.zh.md  三包总览 · 共享数据根 · 从 pi-memory 2.x 迁移
├── AGENTS.md                 语言 · 发布流程入口 · 中立性门 · 测试约定
├── scripts/
│   ├── check-host-deps.mjs   沿用 pi-packages 的同名脚本（pi-memory 的 peer 依赖纪律）
│   └── pack-smoke.mjs        新：只装 memory-core tarball 的干净目录里跑写入/读回
├── docs/
│   ├── guides/release.md     tag 格式 · 发布顺序 · registry 验收
│   └── superpowers/specs/
│       ├── 2026-11-08-auto-memory-core-split-design.md   从 pi-packages 迁入并修订（D3/D5/D6、阶段表、§8）
│       └── 2026-11-09-simple-memory-migration-design.md  本文件
├── memory-core/              ← auto-memory（改名 + 数据根 + 发布形态）
│   ├── package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
│   ├── src/  tests/  README.md  README.zh.md  LICENSE  .gitignore
└── pi-memory/
    ├── package.json  tsconfig.json  vitest.config.ts
    ├── index.ts  src/  tests/  docs/（15 份历史 spec/plan/verification 原样随包搬）
    └── README.md  README.zh.md
└── dsh-memory/
    ├── package.json
    └── README.md             未实现声明 · 要绑定的 dsh API · 两个端口
└── .github/workflows/
    ├── test.yml              lockfile-sync · test(ubuntu+windows) · pack-smoke(ubuntu)
    └── publish.yml           release:published → npm publish --provenance -w <dir>
```

## 4. 逐个改动

### 4.1 `memory-core`（原 `auto-memory`）

**代码**：`src/**`、`tests/**` 原样搬，改动只有三类——包名引用、数据根字符串、注释里的旧名。

| 位置 | 改动 |
|---|---|
| `src/config.ts` `defaultMemoryRoot()` | `join(base, "auto-memory")` → `join(base, "simple-memory")` |
| `tests/memory-root.test.ts` | 六处期望值同步改名 |
| `tests/neutrality.test.ts` | 散文里的包名与 `$XDG_DATA_HOME/auto-memory` 字样同步改名；扫描规则本身（import 说明符、悬空坐标）不动 |
| `src/index.ts` 文件头 | 包名注释改名 |
| `src/config.ts` 其余 | 无（默认值、deep-merge、模型校验都不动） |

**`package.json`（目标形态）**

```jsonc
{
	"name": "@yandy0725/memory-core",
	"version": "1.0.0",
	"description": "Harness-agnostic file-system memory layer: one memory = one Markdown file, a MEMORY.md index, two-level locking, snapshots, and the LLM orchestration around them.",
	"license": "MIT",
	"repository": { "type": "git", "url": "https://github.com/yandy/simple-memory", "directory": "memory-core" },
	"type": "module",
	"engines": { "node": ">=20.16.0" },
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
	"files": ["dist/", "src/", "README.md", "README.zh.md", "LICENSE"],
	"publishConfig": { "access": "public" },
	"keywords": ["agent-memory", "memory", "harness-agnostic"],
	"scripts": {
		"build": "tsc -p tsconfig.build.json",
		"prepublishOnly": "npm run build",
		"test": "vitest run", "test:watch": "vitest",
		"typecheck": "tsc --noEmit", "lint": "biome lint .", "format": "biome format --write ."
	},
	"devDependencies": { "@biomejs/biome", "@types/node", "typescript", "vitest" }
}
```

- `src/` 一并发布：`declarationMap`/`sourceMap` 要能对回源码。
- `tsconfig.build.json` 已就位（`nodenext`、`outDir: dist`、`rootDir: src`、declaration + maps），源码说明符已带 `.js` 后缀，不需改。
- `prepublishOnly` 让 `npm publish -w memory-core` 自动先 build：发布产物不可能来自过期的 `dist/`。
- `engines.node: ">=20.16.0"`：下限取 dsh 插件生态声明的最低宿主版本（拆分设计 §3.2 里「core 必须出 `dist`」正是这个版本约束推出来的）。声明了就要测，所以 `pack-smoke` 在 20.16 与 24 上各跑一次（§4.5）。

**README**：沿用现有的双语结构，删掉「拆分过渡期」的表述（`private: true`、`main` 指 `src`、阶段 1/2），改为「装这个包 + 两条命令拿到记忆根」；`## Adapting to a new harness` 一节保留（两个端口的说明是包的门面）。

### 4.2 `pi-memory`

| 位置 | 改动 |
|---|---|
| `package.json` | `dependencies` 的 `@yandy0725/auto-memory` → `@yandy0725/memory-core`（range `^1.0.0` 不变）；`repository` 指向 `simple-memory` + `"directory": "pi-memory"` |
| `src/**`、`index.ts` | 21 处 import 说明符改名；`legacy-hint.ts` 的提示文案与注释里的旧数据根字样改为 `simple-memory` |
| `tests/**` | 同上改名；`config-paths` / `legacy-hint` / `memory-tool` / `inject-pi` / `index-wiring` / `host-transcript` 里的期望路径与快照文案同步 |
| `docs/`（15 份） | 原样随包搬，不改写历史 spec 的正文 |
| `vitest.config.ts` | 新增 `resolve.alias`：`@yandy0725/memory-core` → `../memory-core/src/index.ts`（`fileURLToPath` 解析，Windows 安全）。`MEMORY_CORE_FROM_DIST=1` 时**不设** alias，改由包 `exports` 解析到 `dist` —— 这是 §4.5 `test-dist` job 的开关 |
| `tsconfig.json` | 新增 `paths`：`@yandy0725/memory-core` → `["../memory-core/src/index.ts"]`（不设 `baseUrl`，相对 tsconfig 所在目录解析） |

`pi-memory` 仍然**没有 build 步骤**：它自身以 TS 源码发布（`files: [index.ts, src/]`，`pi.extensions: ["./index.ts"]`），由 pi 的扩展加载器剥离类型。它唯一需要的 `dist` 来自 core 依赖。

### 4.3 `dsh-memory`（占位）

```jsonc
{
	"name": "@yandy0725/dsh-memory",
	"version": "0.0.0",
	"private": true,
	"description": "Memory plugin for @deepseek-ai/dsh (cordis). Placeholder: not implemented.",
	"license": "MIT",
	"type": "module",
	"repository": { "type": "git", "url": "https://github.com/yandy/simple-memory", "directory": "dsh-memory" }
}
```

`README.md` 写四件事，不写代码：

1. 状态：**未实现**，本目录只有 `package.json` 与这份说明。
2. 要绑定的 dsh API（`ctx.systemPrompt.section` / `.context`、`ctx.tools.register` + schemastery、`ctx.subagents` / `ctx.llm.stream`、`ctx.sessionQuery`、`ctx.storage`）。
3. 它未来必须实现的两个端口，以及「哪一半进 core、哪一半留在这里」的判据（语义相同 → core）。
4. 装配形态（cordis `apply(ctx, config)` + profile 的 `cordis.patch.yml`），以及 out-of-tree 插件只能静态 `import 'node:*'`、宿主包须 `createRequire` 的那条约束。

不声明 `dependencies`：零代码时声明一个用不到的依赖，只会让 `npm i` 多装一个包。真正开工时再加。

### 4.4 根配置

| 文件 | 内容 |
|---|---|
| `package.json` | `{ "name": "simple-memory", "private": true, "workspaces": ["dsh-memory", "memory-core", "pi-memory"], "scripts": { test, typecheck, lint, format, "check:host-deps" }, devDependencies }`。不设 `test:windows`：两个包都是平台中立的，Windows 上跑全量 |
| `tsconfig.base.json` | 逐字沿用 pi-packages（`ES2022` / `bundler` / `strict` / `noEmit`） |
| `biome.json` | 逐字沿用 |
| `.gitattributes` | `* text=auto eol=lf`，逐字沿用。Windows runner 默认 `core.autocrlf=true`：少了这一行，`prompts.ts` 的多行模板字面量会把 CRLF 带进发给模型的 prompt，`entry-index` 的 CRLF 用例与大量 `\n` 期望值也会在 Windows 上分叉 |
| `package-lock.json` | 用 `--registry=https://registry.npmjs.org` 生成。本机 `.npmrc` 指向 npmmirror，而这份 lock 要一次性写进公开仓，`resolved` 应指向 npmjs（`npm ci` 会照 `resolved` 拉，不按当前 registry 重写） |
| `vitest.config.ts` | `projects: ["memory-core", "pi-memory"]` |
| `AGENTS.md` | 简体中文；发布见 `docs/guides/release.md`；`memory-core` 零 harness 依赖（`tests/neutrality.test.ts` 是执行点）；`memory-core` 的公开 API 只从 `src/index.ts` 出；`pi-memory` 的宿主包必须在 `peerDependencies` |

### 4.5 CI

`test.yml`（`push: [main]` + `pull_request: [main]`）：

| job | 内容 |
|---|---|
| `lockfile-sync` | ubuntu：`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` + `git diff --exit-code -- package-lock.json` |
| `test` | matrix `[ubuntu-latest, windows-latest]`：`npm ci` → `npm run check:host-deps` → `npm run typecheck && npm run lint && npm test`。仓内解析走源码（D6），所以这一 job 测的是逻辑，不是发布形态 |
| `test-dist` | ubuntu：`npm ci` → `npm run build -w memory-core` → `MEMORY_CORE_FROM_DIST=1 npm test -w pi-memory`。alias 被这个环境变量关掉，于是 `pi-memory` 的 14 个测试文件全部经 `exports` 打到 `dist/index.js` —— 首次有东西真的走一遍用户拿到的那条解析路径 |
| `pack-smoke` | matrix node `["20.16.0", "24"]`（ubuntu）：`npm ci` → `npm run build -w memory-core` → `npm pack -w memory-core --pack-destination "$RUNNER_TEMP" --json`（清单断言：含 `dist/index.js`、`dist/index.d.ts`、`src/index.ts`、`README.md`、`LICENSE`；不含 `tests/`）→ 干净目录 `npm init -y && npm i <tarball>` → **把 `scripts/pack-smoke.mjs` 拷进干净目录再执行** |

两处容易写错、必须照做：

- **`pack-smoke.mjs` 必须从安装树解析**。Node 的 ESM 解析跟随**脚本自身位置**，不是 cwd；`node "$GITHUB_WORKSPACE/scripts/pack-smoke.mjs"` 会命中仓库自己的 `node_modules`（workspace 符号链接 → `memory-core/dist`），tarball 哪怕是空包也照样绿。所以脚本拷进干净目录、在那里执行。
- **`pack-smoke` 跑两个 Node 版本**：`20.16.0` 是 `engines` 的下限，`24` 是开发版本。core 存在的理由就是被第三方 harness 装上，下限不测等于没声明。

脚本只 `import { MemoryStore, resolveMemoryDir } from "@yandy0725/memory-core"`，在一个临时 git 目录里写入一条、读回一条，断言解析出的根形如 `<root>/git/<project>`，并断言安装树里没有 `@earendil-works/*` / `typebox`。

`publish.yml`（`release: published`，`id-token: write`）：

```
memory-core-v* → dir=memory-core
pi-memory-v*   → dir=pi-memory
npm ci && npm publish --provenance --workspace=<dir>
```

### 4.6 docs

- `docs/guides/release.md`：照 pi-packages 的节奏写（升版本 → 提交 → `gh release create <tag> --target <完整 SHA>` → workflow 发布），tag 格式改为 `memory-core-v*` / `pi-memory-v*`；新增两条本仓特有的约束：
  - **发布顺序不可交换**：`pi-memory` 的 `dependencies` 指向 `@yandy0725/memory-core@^1.0.0`。core 不在 registry 上就发 `pi-memory`，得到的是一个装不上的包（`No matching version found`）。反过来安全。
  - **验收别看 workflow 绿**：轮询 `registry.npmjs.org/@yandy0725%2F<name>/<version>` 到 200、把返回的 `dist.shasum` 与发布日志里的 `shasum:` 逐字比对、确认 `dist-tags.latest` 已翻到新版本。
- `2026-11-08-auto-memory-core-split-design.md` 随代码迁入并按新事实修订：D3（数据根 `simple-memory`）、D5（仓名与三包布局，原「单包独立仓」作废）、D6/§2.1（阶段 2 已执行：`dist`/`exports`/去 `private`）、§8.2/§8.3（monorepo 集成点改为新仓的 CI 与根 `package.json`）。措辞按最终形态写，不留过程痕迹。

## 5. `pi-packages` 收尾（PR #227 就地改造）

目标是：**`pi-packages` 里除历史 spec/plan 外，不再出现 `pi-memory` 与 `auto-memory` 任一 token**。残留一个幽灵 workspace 的后果实测是「静默 + 一处红」：`lockfile-sync` / `npm ci` / `npm test` 全部 exit 0 静默通过，`check:dev-deps` 抛未捕获 ENOENT 变红，`test:windows` 因显式 `-w auto-memory` 变红，根 `vitest.config.ts` 里那条引用则永远烂在那儿（CI 不读根 vitest 配置）。

在 `feat/auto-memory-core-split` 上追加提交（不改写历史、不 force push）：

| 位置 | 改动 |
|---|---|
| `pi-memory/` | 整目录删除 |
| `auto-memory/` | 整目录删除（回到 `main` 的形态：本轮之前它不存在） |
| `docs/superpowers/specs/2026-11-08-auto-memory-core-split-design.md` | 删除（迁往新仓） |
| `docs/guides/release.md` | 撤掉 #227 加的「跨仓依赖：先发被依赖的那个包」小节，换成两行指针：`pi-memory` 已迁往 `github.com/yandy/simple-memory`，其发布流程见该仓 `docs/guides/release.md` |
| `docs/guides/testing.md` | 保留与 pi-memory 路径无关的通用条目；以 pi-memory 测试文件为坐标的行改为指向新仓或删除 |
| 根 `package.json` | 回退 #227 对它的 diff：`workspaces` 恢复成 `main` 的 10 项（无 `auto-memory`），`test:windows` 去掉 `-w pi-memory` |
| 根 `vitest.config.ts` | 同上回退：projects 恢复 `main` 的列表，再去掉 `pi-memory` |
| `.github/workflows/test.yml` | `paths-filter` 的 `pi-memory` 与 `auto-memory` 两条一起删 |
| `.github/workflows/publish.yml` | `pi-memory-v*` 的 case 删除（`auto-memory` 从未加过） |
| `README.md` / `README.zh.md` | 表格删 `pi-memory` 行；新增一行「`pi-memory` 已迁往 [simple-memory](https://github.com/yandy/simple-memory)」 |
| `package-lock.json` | 重新生成 |

PR 标题与正文改写为「删除 `pi-memory`（迁往 simple-memory）」，正文给出新仓地址、迁移后的包名与数据根、以及「`@yandy0725/pi-memory` 的后续版本从新仓发布」。

## 6. 旧 → 新对照

| | 旧（pi-packages） | 新（simple-memory） |
|---|---|---|
| core 包名 / 目录 | `@yandy0725/auto-memory` / `auto-memory/` | `@yandy0725/memory-core` / `memory-core/` |
| core 入口 | `./src/index.ts`，`private`，无 `exports` | `./dist/index.js` + `.d.ts`，`publishConfig.access=public` |
| 适配层 | `@yandy0725/pi-memory` 3.0.0，`pi-packages/pi-memory/` | 同名，`simple-memory/pi-memory/` |
| dsh 适配层 | 不存在（设计文档里的「本轮不做」） | `dsh-memory/` 占位 |
| 共享数据根 | `$XDG_DATA_HOME/auto-memory` | `$XDG_DATA_HOME/simple-memory` |
| 项目子路径 / 磁盘格式 | `<git\|local>/<project>/` | **不变** |
| 依赖解析 | workspace link | 仓内 alias + paths；发布后 registry |
| 发布入口 | 无（`pi-memory` 3.0.0 发不出去） | `publish.yml`，tag `memory-core-v*` / `pi-memory-v*` |

用户侧的数据迁移（一次性，两个方向都只是 `mv`）：

```sh
root="${XDG_DATA_HOME:-$HOME/.local/share}"
mv "$root/auto-memory" "$root/simple-memory" 2>/dev/null || true
mkdir -p "$root" && mv ~/.pi/memory "$root/simple-memory" 2>/dev/null || true
```

README 与 `pi-memory` 的旧目录提示（`legacy-hint.ts`）覆盖 `~/.pi/memory` → 新根这一条；`auto-memory` → `simple-memory` 这一条只影响本轮之前的开发机，靠 README 说明，不写代码探测。

## 7. 验证计划

| # | 命令 | 通过标准 |
|---|---|---|
| 1 | `npm ci && npm run typecheck && npm run lint` | 全绿 |
| 2 | `npm test -w memory-core` | 30 个测试文件（含 `tests/helpers/`）、`476 passed \| 4 skipped`（与搬迁前同口径，零删减） |
| 3 | `npm test -w pi-memory` | 14 个测试文件、`200 passed` |
| 4 | `npm run check:host-deps` | PASS |
| 5 | `npm run build -w memory-core` | `dist/` 里有 `.js` + `.d.ts` + `.js.map` + `.d.ts.map`，且 `dist/index.js` 的说明符全部带 `.js` |
| 6 | build 之后 `MEMORY_CORE_FROM_DIST=1 npm test -w pi-memory` | 仍是 14 文件 / `200 passed` —— 关掉 alias 后 `pi-memory` 经 `exports` 打到 `dist` 也全绿 |
| 7 | `npm pack -w memory-core --json` + 干净目录安装 + 拷入并执行 `pack-smoke.mjs` | 清单含 `dist/index.js`、`dist/index.d.ts`、`src/`，不含 `tests/`；写入 → 读回成功；根形如 `.../simple-memory/git/<project>`；安装树里**没有** `@earendil-works/*` / `typebox` |
| 8 | 在 Node 20.16 上重复 5–7 | 同样通过（`engines` 下限成立） |
| 9 | 装两个 tarball（core + pi-memory）后 `node -e "import('@yandy0725/memory-core')"` | 从 `pi-memory` 自己的 `dependencies` 解析到 core |
| 10 | `grep -rn "@earendil-works\|typebox\|pi-tui\|schemastery" memory-core/src/` | 零命中 |
| 11 | 新仓 CI（ubuntu + windows + `test-dist` + 两个 Node 版本） | `lockfile-sync`、`test`、`test-dist`、`pack-smoke` 全绿 |
| 12 | `pi-packages`：`npm install --package-lock-only` + `git diff --exit-code -- package-lock.json`；`npm run typecheck && npm run lint && npm test` | lockfile 无 diff；除已存在的 `pi-container-sandbox > detectEngine` 失败外全绿（删除 workspace 不引起依赖漂移：`typebox` 与 `@earendil-works/*` 仍有 7 个包以同样 range 声明） |
| 13 | `pi-packages` CI（PR #227） | `test-full` ubuntu + windows 绿 |
| 12 | `grep -rn "pi-memory\|auto-memory" pi-packages/{package.json,vitest.config.ts,.github,scripts,README.md,README.zh.md,docs/guides}` | 零命中（`docs/superpowers/specs/` 下的历史 spec 不在扫描范围） |
| 13 | 顺序门：新仓 `git push` 后 CI 全绿 | 之后才更新 PR #227 的标题/正文并合并 |

不做的事（明确）：不执行 `npm publish`；不创建 GitHub Release；不对 `@yandy0725/pi-memory@2.5.2` 执行 `npm deprecate`（等 3.0.0 真的在 registry 上之后再做才有意义）。

## 8. 风险与回滚

| 风险 | 处理 |
|---|---|
| 改名把某处路径写错，测试仍绿（期望值与实现同时改错） | 验证 6 用的是**发布产物**在干净目录里算出的真实路径，不依赖仓内期望值；另有一条「只装 core、不装宿主包」的独立性断言 |
| `dist` 入口与仓内 alias 双轨导致「测试跑的是源码，发布的是另一份」 | 验证 5/6/7 直接在 tarball 上跑；`prepublishOnly` 保证发布前必 build；`exports` 里只有 `dist`，没有 `src` 旁路 |
| Windows 上 `paths`/alias 的路径分隔符 | alias 用 `fileURLToPath(new URL(...))`；`paths` 用相对 tsconfig 的相对路径；新仓 CI 有 windows job 真跑 |
| 删 `pi-memory` 后 `pi-packages` 里有悬空引用（CI filter、script、README） | 验证 12 的 grep 是硬门；`lockfile-sync` 兜住 lockfile |
| 用户在 `~/.local/share/auto-memory` 或 `~/.pi/memory` 里有数据 | 不写自动迁移代码；README 与 PR 正文给出一行 `mv`；`legacy-hint` 继续只提示、不搬动 |
| Windows 上 CRLF 污染 prompt 模板字面量 | `.gitattributes` 逐字带过去（`* text=auto eol=lf`），windows job 因此在 LF 检出的树上跑；`entry-index` 的 CRLF 用例本来就是「显式写入 `\r\n` 再断言」，不依赖检出行为 |
| `pi-packages` 里残留幽灵 workspace（`auto-memory`）静默通过 lockfile 与 `npm ci` | §5 的 grep 门按两个 token 扫，覆盖 `.github`、`scripts`、`docs/guides` |
| 3.0.0 发布前，`@yandy0725/pi-memory@2.5.2` 在任何一个接了 CI 的仓库里都没有源码 | 2.5.x 的源码在 `pi-packages` 的 git 历史里（删除提交的父提交），应急打补丁可以从那里出版本；不保留活分支（没有 bug 报告前，一条不会跑 CI 的分支只是负债） |
| 顺序错乱：先合并清理、后推新仓 | 顺序门写进 §7 第 13 行：新仓 push 且 CI 全绿之后，才更新并合并 #227。否则 PR 正文指向的是空仓 |
| 回滚 | 新仓：删除远端仓即可（无外部引用）。`pi-packages`：`git revert` 该 PR。数据根再改一次 = 一行 `mv` 加一个常量 |

## 9. 备选方案（已排除）

**A. 只搬 core，`pi-memory` 留在 `pi-packages`（拆分设计 D5 的原方案）。** 好处是 `pi-packages` 的 10 个包不动，`pi-memory` 的发布流程零改动。排除原因：`pi-memory` 的 `dependencies` 要指向 registry 上的 core，而 core 的 API 会随第一个真实适配层（也就是 `pi-memory`）的实测继续调整；一行依赖改动跨两个仓、两套 CI，改一次要发两次版本。dsh 适配层落地时同样要面对这套跨仓节奏。

**B. core 保持 `src` 入口，`dist`/`exports` 留到首次发布前再做。** 好处是仓内没有任何双轨（alias + paths），测试就是源码。排除原因：首次发布前那次改动会同时引入 `dist`、`exports`、`files`、`publishConfig` 与 `prepublishOnly`，而这套形状此前一次都没跑过 —— 失败点被推迟到最不适合调试的时刻。代价是本次要多写 3 行 alias/paths。

**C. 用 `git filter-repo` 把 `pi-memory` 的历史抽到新仓。** 好处是 `git blame` 连续。排除原因：`pi-packages` 的历史里每个提交都混着 9 个无关包，抽子目录后 SHA 全变，spec 之间的交叉引用照样断；而这段代码的 lineage 实际从 3.0.0 发布起算。

## 10. 留给建造者的部分

- 三个包内部的文件顺序、注释措辞、README 章节顺序（沿用现有风格即可）
- `scripts/pack-smoke.mjs` 的具体断言写法（写入/读回的字段选择）
- `docs/guides/testing.md` 里哪几行算「与 pi-memory 路径无关的通用条目」（判据：例子是否只能靠 pi-memory 的文件路径读懂）
- `pi-packages` 收尾的提交粒度（一个提交删干净，还是「删包」+「清引用」两个提交）
