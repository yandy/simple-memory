# 跨设备同步：真实远端验收清单

自动化测试只跑**本地 bare 仓库**（无网络、无凭据）：`memory-core` 的引擎/端口用例、两个适配层的
`sync*.test.ts` 都是这条路。所以「真实 dsh / pi 进程连真实托管远端（GitHub、GitLab，SSH 或 HTTPS）」
这一格必须由人手动走一遍。

本页是一份可照着敲的清单。执行完把结果写进两份 reference 的 `Verification status`（模板见 §4）；
**没走到的条目不要写 “verified”**。

## 0. 前置

- 两个**私有**空仓库：`$REMOTE_A`（主）与 `$REMOTE_B`（用来验换远端）。凭据只走环境变量/agent，
  不要写进命令历史或配置文件提交：

  ```bash
  export MEMORY_SYNC_REMOTE_A='git@github.com:you/project-memory.git'
  export MEMORY_SYNC_REMOTE_B='git@github.com:you/project-memory-b.git'
  ```

- 一台机器就能模拟两台设备：两个独立的记忆根（配置里的 `memoryDir`）+ 同一个远端。
- 所有临时目录、两个远端在验完后删掉。

## 1. pi 侧

隔离配置与会话，避免污染你自己的 `~/.pi`：

```bash
export PI_CODING_AGENT_DIR=/tmp/e2e-pi-a
mkdir -p "$PI_CODING_AGENT_DIR" /tmp/e2e-mem-a /tmp/e2e-project-a
cat > "$PI_CODING_AGENT_DIR/memory.json" <<JSON
{ "memoryDir": "/tmp/e2e-mem-a", "sync": { "enabled": true, "remote": "$MEMORY_SYNC_REMOTE_A" } }
JSON
cd /tmp/e2e-project-a && git init -q . && pi
```

| # | 操作 | 期望（凭证 / 判定点） |
|---|------|----------------------|
| P1 | 在 `/tmp/e2e-project-a` 启动 pi（`sync.enabled: true`，未初始化） | 自动初始化，**没有** `/memory sync init`。`/tmp/e2e-mem-a/.sync/` 下出现 `device.json`、`repo/`、`state/<project-key>.json`；`$REMOTE_A` 里出现 `git/<host__owner__repo>/` 前缀。`/memory sync` 报 `Initialized: yes` 与被识别出的 origin |
| P2 | 让模型（或工具）写入一条记忆，等 `pushDebounceMs`（默认 5s） | 远端出现对应 `<file>.md`；`/memory sync` 的待发布清单归零。写一串（`/dream` 一轮）只产生**一次**推送 |
| P3 | 第二台：`PI_CODING_AGENT_DIR=/tmp/e2e-pi-b`、`memoryDir=/tmp/e2e-mem-b`、同一个 `$REMOTE_A`，启动 | 启动收敛把 P2 那条拉到 `/tmp/e2e-mem-b`；`/memory sync` 的落后清单归零 |
| P4 | 两台设备**各自**改同一条（不同内容），先 A `/memory sync push`，再 B `/memory sync push` | B 侧出现冲突副本，文件名后缀 = 该份内容的 `modified` + 内容 sha256 前 6 位（**不是** hostname/日期）；两份内容都在；两边再各推一轮后收敛 |
| P5 | 已初始化的会话里 `/memory sync remote $MEMORY_SYNC_REMOTE_B` | 措辞含 `Origin changed and this project's baseline was reset`；`$REMOTE_B` 里没有历史提交；`$REMOTE_A` 内容原样保留；`/memory sync` 的 `Origin:` 变成 B |
| P6 | 写入一条后**立刻**退出（Ctrl+D，before debounce） | 下一次启动补推成功（`reason: quit` 的退出 flush）；远端最终可见该条 |
| P7 | `touch /tmp/e2e-mem-a/.sync/sync.lock` 并写入任意 holder 文本 → `/memory sync` | 报根锁被占用、给出可操作错误；`/memory sync unlock`（显式确认）删掉它，下一轮恢复正常。项目 `.lock` 不被误删 |
| P8 | 非 git 目录启动（`enabled: true`）；以及 `enabled: true` 但 `remote: ""` | 前者只产生一条 **notice**（info 级 `pi-memory sync notice:`），不创建 `.sync`、不报 Error；后者是**非致命**配置错误，`memory` 工具与索引照常工作 |
| P9 | 把 `remote` 换成 `https://user:<token>@host/repo.git` | 所有报告、错误、日志里 token 显示为 `***`；`/memory sync` 的 origin 行同样打码 |
| P10 | 同步来一条新记忆后，在同一会话 `resume`（或 `reload`） | 已知语义：`memory list` 能看到，但 system prompt 里的 `memory_index` **看不到**，直到下一次 compaction 或下一个会话（`/memory sync status` 尾行会说明） |

## 2. dsh 侧

按 [dsh-memory 参考](../reference/dsh-memory.zh.md) 的「安装」用 `file:` 装进一个隔离的
`DSH_HOME`（避免碰到你自己的 profile）。配置写在行 `config:`（不是 `memory.json`）：

| # | 操作 | 期望（凭证 / 判定点） |
|---|------|----------------------|
| D1 | 首次启动（行 config 里 `sync.enabled: true` + `sync.remote`） | 自动初始化；`.sync/` 出现在记忆根；远端出现 `git/<key>/` 前缀 |
| D2 | 另一台设备先推一条，再启动本设备 | 启动拉取排在**第一次** `indexCache.refresh()` 之前：**第一份** `memory_index` 里就能看到那条（dsh 每步重装 system prompt，没有 pi 的录制索引例外） |
| D3 | 三种写入各做一次：主 `memory` 工具、extract worker、`/dream` | 每次成功写都把去抖上弦，各自合并成一次推送；`pushOnWrite: false` 时不自动推、手动命令照常 |
| D4 | 写入后直接结束进程（无退出兜底） | 远端**不会**立刻更新（dsh 没有可靠的退出事件）；下一次 `agent/created` 的启动轮补推，或下一次写触发接住 |
| D5 | `/memory sync remote $MEMORY_SYNC_REMOTE_B`；以及伪造 `.sync/sync.lock` 后 `/memory sync unlock --force` | 同 P5（基线重置、A 不动）；unlock 需要显式 `--force`（dsh 命令处理器没有交互确认） |
| D6 | 两台 dsh 改同一条后各推一轮 | 冲突副本命名与收敛同 P4；`/memory sync pull\|push` 后就地刷新 `indexCache` |

## 3. 判定与留痕

- 每条都记录：**做了 / 结果 / 与期望的差异**。只跑通了「初始化 + 一次 push」不算覆盖 P4–P7。
- 凭据、仓库地址、token 不要贴进 PR 或 issue；地址用 `<owner>/<repo>` 形式脱敏。
- 失败时保留 `pi-memory sync error:` / 报告原文与 `.sync/` 下的 `state/*.json`（后者不含凭据）。

## 4. 更新参考文档的验证状态

跑完把 `docs/reference/pi-memory.zh.md` / `dsh-memory.zh.md` 的「验证状态」一节改成**现状**：做过哪些、
还差哪些。不写日期、测试数量与逐条过程 —— 那些属于 PR 与 spec，不属于文档。
