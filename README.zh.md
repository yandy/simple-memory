# simple-memory

[English](./README.md) | 中文

一份磁盘上的记忆，被你在用的每个 AI coding agent 共享。一条记忆就是一个纯 Markdown 文件，索引里每条
一行。指向同一台机器的两个 harness 读写的正是同一批文件。

## 包

| 包 | 说明 | npm |
|---|---|---|
| [memory-core](./memory-core) | 与 harness 无关的基础层：磁盘格式、`MemoryStore`、两级锁、快照、项目路径、注入策略、dream/extract 编排，以及中立的 `memory` 工具契约（JSON Schema + handler）。只 import `node:*`。 | `@yandy0725/memory-core` |
| [pi-memory](./pi-memory) | pi 适配层：extension 装配、`/memory` 与 `/dream`、typebox schema + pi-tui 渲染、prompt cache 的 section 冻结、headless 子会话、会话搜索。 | `@yandy0725/pi-memory` |
| [dsh-memory](./dsh-memory) | DeepSeek harness（`@deepseek-ai/dsh`，cordis）适配层。**占位，尚未实现。** | `@yandy0725/dsh-memory` |

宿主专属的那一半（何时注入、怎么渲染、调哪个模型）由适配层负责；`memory-core` 负责必须处处一致的
那一半 —— 下面的文件是共享的，不是每个 harness 各存一份。

## 共享数据根

```
$XDG_DATA_HOME/simple-memory/<git|local>/<project>/
```

`XDG_DATA_HOME` 未设置或为相对路径时用 `~/.local/share/simple-memory`。有 http(s)/ssh/git remote 的
仓库落在 `git/<host__owner__repo>`（同一仓库的 clone 与 worktree 共享）；其余落在
`local/<转义后的绝对路径>`。

每个项目目录下有 `MEMORY.md`（索引）、一条记忆一个 `*.md`、`.lock`、`.backups/`、`.dream-meta.json`
与 `sessions/`。`memoryDir` 配置项可覆盖根目录；`~` 与 `~/` 会展开，相对路径按工作目录解析。

磁盘格式与 `pi-memory` 2.x 逐字节相同：YAML frontmatter 含 `name`/`description`/`type`/`created`/
`modified`，索引每条记忆一行（`- [Name](file.md) — description`），回滚点是 `.backups/<ts>-<label>/`。

## 从 pi-memory 2.x 迁移

2.x 把记忆放在 `~/.pi/memory/` 下。3.0 把它搬出了 pi 的目录，这样别的 harness 才读得到。**不自动迁移**
（静默搬动用户数据比提示更危险），手动搬一次：

```sh
# 相对路径的 XDG_DATA_HOME 会被忽略（XDG 规范如此），与包的解析规则一致：
case "${XDG_DATA_HOME:-}" in /*) root="$XDG_DATA_HOME";; *) root="$HOME/.local/share";; esac
mkdir -p "$root"
mv ~/.pi/memory "$root/simple-memory"                              # 2.x → 3.0
mv "$root/auto-memory" "$root/simple-memory" 2>/dev/null || true    # 早年工作名
```

`$root/simple-memory` **已存在**时，上面这条 `mv` 会把源目录塞进目标里而不是合并。遇到这种情况
（跑过一次 3.0、或第一条命令执行过两遍），改成按项目目录搬，并自己核对同名冲突：
`mv ~/.pi/memory/* "$root/simple-memory"/`。

`/memory` 发现在原地留着 pre-3.0 数据时会多打一行提示；它只报告，不搬动、不修改任何文件。
它在 `session_start` 时**不**提示，且本项目的**新目录一旦出现就不再提示** —— 所以拿不准就先别用 3.0
写任何东西，先看一眼提示。

## 开发

```bash
npm ci                        # 根 + 两个可测 workspace
npm test                      # memory-core 与 pi-memory
npm run typecheck && npm run lint
npm run build -w memory-core  # dist/（ESM + .d.ts + maps）；CI 另外验证打包出来的 tarball
npm run check:host-deps       # 宿主提供的包必须在 peerDependencies，不能进 dependencies
```

`memory-core` 的 `src/**` 只许 import `node:*` 与相对路径 —— `memory-core/tests/neutrality.test.ts` 是这条
约束的执行点，也是第二个 harness 能依赖这个包的唯一理由。

`dsh-memory` 没有代码，因此没有 test 脚本；`npm test` 会跳过它。

发布流程见 [docs/guides/release.md](./docs/guides/release.md)。
