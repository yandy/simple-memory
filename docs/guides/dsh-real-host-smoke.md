# dsh 真实宿主验收：extractMemories / dream

单元测试里 dsh 是**假宿主**（`tests/helpers/fake-ctx.ts`）。下面这些只有真宿主能证明：

- `agents.create()` 在哪个阶段可用（**只有会话启动阶段**，见下「为什么是常驻 worker」）；
- `tools.restrict({ allow: [] })` 之后子会话真的只剩 `memory` 工具；
- 一轮 `followup` 真的发出模型请求并以 `turn/end` 收口；
- dream 的合并/改写/重建索引真的把磁盘改成预期形状。

本文的命令都在 `0.2.2-rc.1` 上逐条跑过。

## 为什么是常驻 worker（真机结论，直接影响怎么验）

`AgentRegistry.create()` 用 `this.ctx` 作为子 agent 的 owner，而 cordis 的 traceable 机制把它解析成
「访问服务时的调用方作用域」。实测结果：

| 调用位置 | `agents.create()` |
|---|---|
| `apply` 期间 | ✅ 成功 |
| `agent/created` 期间 | ✅ 成功 |
| `agent/turn-stopping` 派发里 | ❌ `cannot create effect on inactive context` |
| `agent/status`（idle）派发里 | ❌ 同上 |

（插件作用域绑定、agent 作用域 `agent.ctx.agents` 绑定、宏任务延迟三种写法全部复现。）

所以适配层的做法是：**会话启动阶段为每个任务建一个常驻子会话**（extract 5 个 action / dream 7 个
action），之后每轮只往里 `followup` 一条消息 + 等它的 `turn/end`。验收时要验的就是这条链路。

## 前置

- Node ≥ 24、`pnpm`（`dsh plugin` 把参数转发给 pnpm）、已能跑通的 `dsh`。
- 模型凭据：`$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）。

## 第 0 步：构建

```sh
cd /path/to/simple-memory
npm run build -w memory-core && npm run build -w dsh-memory
```

顺序不能反：`dsh-memory` 的 build 经 workspace 符号链接解析 core 的 `dist/`。

## 第 1 步：隔离的 DSH_HOME（不碰真实 profile）

```sh
export DSH_TEST=/tmp/dsh-mem-test
rm -rf "$DSH_TEST" && mkdir -p "$DSH_TEST"
export DSH_HOME="$DSH_TEST"
cp ~/.dsh/.credentials.yaml "$DSH_TEST"/ 2>/dev/null || echo "注意：没有凭据，模型调用会失败"
```

## 第 2 步：建 profile

**extract / dream 要用 `web` 模板**，不要用 `headless`：

```sh
dsh --from-default-profile web --profile memtest --dump-config >/dev/null
```

> 为什么不建议用 `headless`：`dsh headless` 是「答一轮就退出」的宿主，父轮结束即退出进程，后台在途的
> 抽取会被 `aborted/disposed` 打断（实测：子会话只有 `turn/start` → `turn/end(aborted, disposed)`，
> 0 个 `request/header`）。适配层在卸载时会 `drain()` 在途任务，但进程退出不等我们 —— 所以
> **extract/dream 的完整语义只在长寿命宿主（web / TUI）成立**。`headless` 只适合验「插件是否激活」。

## 第 3 步：装本地插件

```sh
dsh plugin --profile memtest add file:/path/to/simple-memory/dsh-memory
dsh --profile memtest --dump-config | grep -A2 "id: memory"
# - id: memory
#   name: '@yandy0725/dsh-memory'
#   config: {}
```

## 第 4 步：用户 patch 层

`memoryDir` 是**根**：真实目录是 `<根>/<git|local>/<项目名>`。

```sh
cat > "$DSH_HOME/profiles/memtest/cordis.patch.yml" <<'YAML'
- id: memory
  name: '@yandy0725/dsh-memory'
  config:
    memoryDir: /tmp/dsh-mem-test/mem
    defaults:
      model: deepseek-official/deepseek-flash
    extractMemories:
      enabled: true
    dream:
      model: deepseek-official/deepseek-flash
      thinkLevel: high
YAML
```

两个门禁（决定会不会建常驻子会话，**默认零额外子会话**）：

- extract worker 只在 `extractMemories.enabled: true` 时建；
- dream worker 只在用户**显式写了 `dream` 键**时建。没建时 `/dream` 会返回一条可操作的报错，而不是
  静默什么都不做。

## 第 5 步：起 web 宿主并驱动一轮

浏览器里手敲最省事；自动化用 playwright（`[data-composer-input]` 是那个 contenteditable 输入框，
首次进入会有一个 Preview Notice 弹窗，先点 **Continue**）：

```sh
export DEEPSEEK_API_KEY=$(sed -n 's/^[[:space:]]*DEEPSEEK_API_KEY:[[:space:]]*//p' ~/.dsh/.credentials.yaml | tr -d '"'"'"'' | head -1)
dsh --profile memtest --no-open        # 打印 http://127.0.0.1:3080/?token=…
```

```js
// 关键点：发完消息后**别关浏览器**——关掉 UI 会让会话结束，后台抽取就断了。
const page = await browser.newPage();
await page.goto(url);
await page.getByRole("button", { name: "Continue" }).first().click().catch(() => {});
const composer = page.locator("[data-composer-input]").first();
await composer.click();
await page.keyboard.type("请说明：这个仓库的锁文件永不自动回收。只回复「收到」，不要调用任何工具。");
await page.keyboard.press("Enter");     // 之后保持页面打开，直到抽取跑完
```

**验 extract 的关键设计**：提示词要求主 agent **不调用任何工具**。这样下面出现的记忆只可能来自
extract 的子会话 —— 否则分不清是谁写的（模型自己也会调 `memory add`）。

### 断言 A：记忆真的被写入

```sh
MEM=$(dirname "$(find /tmp/dsh-mem-test/mem -name MEMORY.md | head -1)")
cat "$MEM/MEMORY.md"          # 期望：- [name](file.md) — description
ls "$MEM"/*.md
```

### 断言 B：子会话（worker）存在，且只拿到 `memory`

```sh
for f in $(find "$DSH_HOME/sessions" -name 'session.v4.jsonl.zstd'); do
  zstdcat "$f" | head -1 | grep -q subagent && echo "$f"
done
```

```sh
# 工具面在 data.header.tools（不是 data.tools）
zstdcat "$CHILD" | grep '"request/header"' | tail -1 | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  const e=JSON.parse(s);
  console.log((e.data.header.tools??[]).map(t=>t.name));
})'
```

期望：`[ 'memory' ]`。出现 `read` / `bash` / `write` / `subagent` 就说明 `restrict` 没生效。

### 断言 C：那一轮真的调了 memory 工具并正常收口

```sh
zstdcat "$CHILD" | grep -E '"tool/call"|"turn/end"' | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  for (const l of s.split("\n").filter(Boolean)) { const e=JSON.parse(l);
    if (e.type==="tool/call") console.log("call:", e.data.name, String(e.data.arguments).slice(0,40));
    else console.log("end:", JSON.stringify(e.data.reason)); }
})'
```

实跑得到的形状：`memory list` → `memory add` ×N，`{"kind":"completed"}`。

## 第 6 步：`/dream`

在同一个 UI 里输入 `/dream`（命令立刻返回「Dream started」，不阻塞界面），然后等它跑完。

**别只看日志**：`ctx.logger` 的输出在 web/headless 下不一定落到 stdout，验收以**磁盘**为准。

### 断言 D：合并/改写真的发生了

```sh
MEM=$(dirname "$(find /tmp/dsh-mem-test/mem -name MEMORY.md | head -1)")
cat "$MEM/MEMORY.md"     # 首行会出现 "# Memory Index"，条目数应少于预置条数
ls "$MEM"/*.md | xargs -n1 basename   # 被合并掉的旧条目文件应已删除
ls "$MEM/.backups"       # 期望出现 <ts>-dream/（整轮快照 = 回滚点）
```

### 断言 E：dream 的子会话用的是 7 个 action 且跑完了

```sh
zstdcat "$DREAM_CHILD" | grep '"request/header"' | tail -1 | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  const e=JSON.parse(s);
  const schema=(e.data.header.tools??[])[0]?.parameters;
  console.log(JSON.stringify(schema).match(/"rename"|"rebuild_index"/g));
})'
```

实跑得到的调用序列：`memory list` → `memory search` ×2 → `memory rebuild_index`，
`turn/end: completed`；4 条预置记忆（含两条互相冲突的）最终变成 3 条：两条被合并成一条、一条的
`description` 被改写、无关的一条保留。

> 手写 fixture 必须带 core 的 YAML frontmatter（`---\nname:/description:/type:/created:/modified:\n---`），
> 否则条目不被识别，`rebuild_index` 会把索引写成只剩 `# Memory Index` 一行 —— 那是 fixture 的问题，
> 不是适配层行为。

## 清理

```sh
rm -rf /tmp/dsh-mem-test
unset DSH_HOME DSH_TEST
```

## 已知不覆盖

- **`maxTurns` 的硬上界**：dsh 侧本来就是尽力而为（`agent/pre-step` 计数 + 拒绝后续 step），真机上
  只能观察到「被拒」这件事，没有确定的轮数上限可断言。
- **`sessionPersistence.enabled: false`**：在 dsh 上不可兑现，worker 一定落盘（这是披露，不是缺陷）。
  代价是：建了 worker 的会话会多一条**空的**子会话记录（`followup` 之后才有轮次内容）。
- **`builtinTools: "file-io"`**：三个 core 任务的取值恒为 `"none"`，这条分支只需单测覆盖。
- **AGENTS.md 块**：dsh 侧恒为空（`agentsMdBlocks: []`），没有真机可验的东西。
- **`dsh headless` 里的 extract/dream**：进程退出会打断后台任务（见第 2 步），不适合作为验收宿主。
