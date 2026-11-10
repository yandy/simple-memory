# dsh 真实宿主验收：extractMemories / dream

单元测试里 dsh 是**假宿主**（`tests/helpers/fake-ctx.ts`）。`agents.create → setup →
followup/whenIdle/cancel` 这条链、以及「子会话只拿到 `memory` 工具」这件事，只有真宿主能证明。
本文是一份可复制的验收流程，全部命令都在 `0.2.2-rc.1` 上核过。

## 为什么必须做这一步

三条断言在假宿主上**结构性无法**验证：

1. **工具面真的被收窄**：`tools.restrict({ allow: [] })` 的语义由宿主实现（作用域注册不受限制、
   `restrict` 对未知名字抛错）。假宿主的实现是照文档抄的，抄错了测试照样绿。
2. **超时真的能打断**：`agent.cancel()` → 驱动收敛 → `whenIdle()` 返回。
3. **子会话落盘**：`origin: "subagent"` 的会话是否真的出现在会话日志里（这是 README 第 1 条披露）。

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
# 复用模型凭据；其余一切都在 /tmp 里，跑完整目录删掉即可。
cp ~/.dsh/.credentials.yaml "$DSH_TEST"/ 2>/dev/null || echo "注意：没有凭据，第 5 步会报 extract failed"
export DSH_HOME="$DSH_TEST"
```

## 第 2 步：从模板建一个 headless profile

```sh
dsh --from-default-profile headless --profile memtest --dump-config >/dev/null
# profiles/memtest/package.json 的 bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless]
```

## 第 3 步：装本地插件

```sh
dsh plugin --profile memtest add file:/path/to/simple-memory/dsh-memory
```

`@yandy0725/dsh-memory` 会被自动写进 `dsh.profile.bundles`，`@yandy0725/memory-core@^2.0.0` 从 registry
解析（2.0.0 已发布）。确认 patch 层已经进组合树：

```sh
dsh --profile memtest --dump-config | grep -A2 "id: memory"
# - id: memory
#   name: '@yandy0725/dsh-memory'
#   config: {}
```

## 第 4 步：用户 patch 层（模型 + 打开 extract + 隔离记忆目录）

`memoryDir` 是**根**：真实目录是 `<根>/<git|local>/<项目名>`。指到 `/tmp` 才不会写你的真实记忆。

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
YAML
```

## 第 5 步：跑一轮（extract 端到端）

在 `$DSH_TEST/proj` 里跑，让目录解析确定下来（非 git 目录 → `<根>/local/<escaped>`）：

```sh
mkdir -p "$DSH_TEST/proj" && cd "$DSH_TEST/proj"
dsh --profile memtest "记住：这个项目的锁文件永不自动回收。另外以后都用 uv 而不是 pip。"
```

### 断言 A：记忆目录里真的出现了条目

```sh
MEMDIR=$(dirname "$(find "$DSH_TEST/mem" -name MEMORY.md | head -1)")
echo "$MEMDIR"
cat "$MEMDIR/MEMORY.md"
ls "$MEMDIR" | head
```

期望：`MEMORY.md` 至少一行 `- [name](file.md) — description`，且对应的 `*.md` 存在。

### 断言 B：子会话真的落了盘，且标成 subagent

```sh
# 直接按「header 里带 subagent」找，不依赖目录转义规则与时间排序
CHILD=$(for f in $(find "$DSH_HOME/sessions" -name 'session.v4.jsonl.zstd'); do
          zstdcat "$f" | head -1 | grep -q subagent && echo "$f" && break
        done)
echo "$CHILD"
zstdcat "$CHILD" | head -1 | cut -c1-300
```

期望：打印出一个会话文件，其 header 里含 `subagent`（`origin: "subagent"` 是我们的标记）。
**一个都没有** = 子会话没建起来，先看第 5 步的日志。

### 断言 C：子会话的工具面只有 `memory`（本轮最关键的一条真机证据）

```sh
zstdcat "$CHILD" \
  | grep '"request/header"' \
  | tail -1 \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      const e=JSON.parse(s);
      console.log((e.data.header.tools??[]).map(t=>t.name));
    })'
```

期望：`[ 'memory' ]` —— 没有 `read` / `bash` / `write` / `subagent`。
（工具表在 `data.header.tools`，不在 `data.tools`；字段形状随宿主版本变，以你这一版的实际位置为准。）
出现别的工具就说明 `tools.restrict()` 没生效（或作用域注册被当成全局）。

### 断言 D：宿主日志里有抽取结果

```sh
grep -r "simple-memory" "$DSH_HOME/logs" | tail -5
```

期望：`extracted N memories`（`N` 与断言 A 里新增的条目数一致）。没有写入时不打印（刻意的静默）。

## 第 6 步：两条负例

```sh
# 1) 关掉 extract：不该再出现新的子会话
sed -i 's/enabled: true/enabled: false/' "$DSH_HOME/profiles/memtest/cordis.patch.yml"
BEFORE=$(ls -d "$DSH_HOME"/sessions/*/*/ | wc -l)
dsh --profile memtest "再记一条：extract 关掉时不该起子会话。"
test "$(ls -d "$DSH_HOME"/sessions/*/*/ | wc -l)" -gt "$BEFORE" || echo "OK：没有子会话"

# 2) 模型写错：抽取必须在日志里说清原因，而不是静默吞掉
sed -i 's|enabled: false|enabled: true|' "$DSH_HOME/profiles/memtest/cordis.patch.yml"
sed -i 's|deepseek-official/deepseek-flash|deepseek-official/no-such-model|' "$DSH_HOME/profiles/memtest/cordis.patch.yml"
dsh --profile memtest "这一轮应该报 extract failed。"
grep -r "extract failed" "$DSH_HOME/logs" | tail -2
```

## 第 7 步：`/dream`

`/dream` 是**命令**，`headless` profile 没有命令通道，所以这一步要交互界面。两种做法：

```sh
# a) 浏览器里手敲 /dream（最少准备）
dsh plugin --profile memtest add file:/path/to/simple-memory/dsh-memory   # 已装可跳过
dsh --from-default-profile web --profile memtest-web --dump-config >/dev/null
# 把第 4 步的 patch 层复制到 memtest-web，然后把 bundles 换成 web 模板 + 本插件
dsh --profile memtest-web
# 打开 UI → 输入 /dream

# b) 用 playwright-cli 脚本化（本机已有该技能）
```

要看的四件事：

1. 命令**立刻**返回「Dream started」（不等 600s）；
2. `Modules:` 行里 `dream=on(<model>)`（不是 `not implemented`）；
3. 跑完后 `$DSH_HOME/logs` 里出现 `dream finished:` 与摘要；
4. `$DSH_TEST/mem/<...>/backup/` 下出现这一轮的全目录快照（`logical+snapshot` 的产物）。

## 清理

```sh
rm -rf /tmp/dsh-mem-test
unset DSH_HOME DSH_TEST
```

## 已知不覆盖

- **`maxTurns` 的硬上界**：dsh 侧本来就是尽力而为（`agent/pre-step` 计数 + 拒绝后续 step），
  真机上也只会观察到「拒绝」这件事，不会有确定的轮数上限可断言。
- **`sessionPersistence.enabled: false`**：在 dsh 上不可兑现，子会话一定落盘（这是披露，不是缺陷）。
- **`builtinTools: "file-io"`**：三个 core 任务的取值恒为 `"none"`，这条分支只需单测覆盖。
- **AGENTS.md 块**：dsh 侧恒为空（`agentsMdBlocks: []`），没有真机可验的东西。
