# 发布新版本

发布通过 GitHub Actions 完成，触发条件是创建 GitHub Release（tag 格式 `memory-core-v*` 或
`pi-memory-v*`）。`publish.yml` 收到 `release: published` 后执行 `npm ci` +
`npm publish --provenance --workspace=<dir>`（OIDC 认证，不需要本地 token）。

## 顺序：`memory-core` 必须在 `pi-memory` 之前

`pi-memory` 与 `dsh-memory` 的 `dependencies` 都指向 `@yandy0725/memory-core@^2.2.0`（跨设备同步的
会话级编排 API 从 core 2.2.0 起才提供）。下面的步骤以发布 `pi-memory` 为例。

- **core 不在 registry 上就发 `pi-memory`，得到的是一个装不上的包**：用户会拿到
  `No matching version found for @yandy0725/memory-core@^2.2.0`。
- 反过来安全：只发 core、不发 `pi-memory`，不影响任何现有用户。
- **只要 workspace 的 `memory-core` 版本没有满足适配层声明的 `^2.2.0`，仓内 `npm ci` 就会失败**：
  `npm error notarget No matching version found for @yandy0725/memory-core@^2.2.0`。本地/PR 阶段的闸门
  看的是 workspace 版本与范围，与 core 是否已发布无关；把 workspace 版本升到 2.2.0 后，`npm ci` 走的
  是 workspace 链接。
- **registry 安装是另一道门**：用户与 `registry-smoke` 只会从 registry 解析，所以还必须先把 core 2.2.0
  真正发布；否则同一条 `notarget` 会在干净目录里重现。不能靠放宽范围或改锁绕过任何一道。

## 步骤

### 0. 先发 `memory-core` 的新版本（本功能要求 2.2.0）

```bash
# 1. 升 core 版本并提交（不动 pi-memory 的版本号）
npm version 2.2.0 --workspace=memory-core --no-git-tag-version
git add memory-core/package.json package-lock.json
git commit -m "memory-core v2.2.0"
COMMIT=$(git rev-parse HEAD)

# 2. 此刻 workspace 版本已满足 ^2.2.0；npm ci 验证的是本地 workspace 链接，与 registry 是否已有 2.2.0 无关
npm ci && npm run typecheck && npm run lint && npm test
git push origin main

# 3. 创建 GitHub Release（gh 自动创建 tag；--target 必须是完整 SHA）
gh release create memory-core-v2.2.0 --target "$COMMIT" \
  --title "memory-core v2.2.0" --notes ""
```

然后按下面「验收」一节确认 2.2.0 在 registry 上真的可查、latest 已翻过去、shasum 对得上。

### 1. 再发 `pi-memory`（必须等上一步验收通过）

```bash
# 1. 升 pi-memory 版本并提交
npm version <新版本号> --workspace=pi-memory --no-git-tag-version
git add pi-memory/package.json package-lock.json
git commit -m "pi-memory v<新版本号>"
COMMIT=$(git rev-parse HEAD)

# 2. 全量校验 + 运行时解析闸门（这一次会真的从 registry 装 core 2.2.0）
npm ci && npm run typecheck && npm run lint && npm test
npm run build -w memory-core -w dsh-memory
npm run smoke:registry -- pi-memory

# 3. 推送并创建 Release
git push origin main
gh release create pi-memory-v<新版本号> --target "$COMMIT" \
  --title "pi-memory v<新版本号>" --notes ""
```

`memory-core` 带 `prepublishOnly: npm run build`，所以发布前一定会重新构建 `dist/`；不要提交 `dist/`。

## `workspace-smoke`（PR）与 `registry-smoke`（main）

PR 的 `workspace-smoke` 把 core 与适配层各自的**仓内 tarball** 在干净目录同时安装，验证发布形态与实际解析；
它会在输出里明确写「registry 路径未验证」，因此 core 尚未发布时也能把代码、打包和仓内依赖问题先测出来，
不需要为了跑 CI 临时发版。

`registry-smoke` 把适配层的 tarball 装进干净目录、**从 registry** 拉 core 再 `import` 入口，只在 main 上跑。
所以当核心的新版本还没发布时，这条路径**客观上无法验证**，也不会用 workspace 的结果冒充。脚本按
「声明的范围在 registry 上存不存在」与「适配层自己是否已发布」分三种情形：

- **适配层已发布、而 `dependencies` 里的 core 范围在 registry 上不存在** → **硬失败**。上一次（`2.1.0`）
  发布时就是这种：`pi-memory@4.0.1` 已经在 registry 上，把范围改成 `^2.1.0` 之后立刻报
  `@yandy0725/pi-memory: registry 上查不到满足 "@yandy0725/memory-core@^2.1.0" 的版本，而
  @yandy0725/pi-memory@4.0.1 已发布 —— 这份声明装不起来`。这是发布前的**闸门**：不许用降低依赖范围或跳过 job 来「修」它。
- **发布进行中**（核心范围在 registry 上查不到，**且**适配层自己声明的版本也未发布）→ `::notice::` 跳过，
  不报错。不要把它当成代码错，也不要把跳过看成验证通过。
- **范围在 registry 上查得到** → 真装一遍，并断言解析到的 core 带声明的版本范围。

因此顺序固定为：先发 core → 在 registry 上确认新版本可查 → 再升 `pi-memory` 版本并发布。在 core 2.2.0
上架之前，main 的 `registry-smoke` job 会一直是红的（硬失败），那是闸门在正常工作；PR 则先由
`workspace-smoke` 验证仓内 tarball，不以它为借口跳过发布后的 registry 验收。

发完 core 之后，***在同一条合并提交的 workflow 上重跑***，那一次它会真的装一遍：

```bash
gh run rerun <run-id> --failed
```

由「失败 / 跳过」变成「通过」之后，再按上面的步骤发 `pi-memory`。顺序不能反：先 `memory-core`，后
`pi-memory`（后者依赖前者的新版本）。

## 验收：不要只看 workflow 绿

npm 的 publish 成功不等于 registry 立刻可查（会先返回「being processed」）。按这三步确认：

```bash
# 1. 轮询版本文档到 200
curl -s -o /tmp/v.json -w "%{http_code}\n" https://registry.npmjs.org/@yandy0725%2Fmemory-core/2.2.0
# 2. 把 dist.shasum 与 publish 日志里 npm notice 打的 shasum: 逐字比对
node -e 'console.log(require("/tmp/v.json").dist.shasum)'
# 3. 确认 dist-tags.latest 已翻到新版本
curl -s https://registry.npmjs.org/@yandy0725%2Fmemory-core | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)["dist-tags"]))'
```

## 注意事项

- LICENSE 不需要手工准备：`prepack` 会从仓库根复制进包目录（`postpack` 删掉），见
  [architecture.md](./architecture.md) 的「LICENSE 只有根目录一份」。`npm publish --ignore-scripts`
  会跳过它 —— 那样发出去的包没有许可证文本。
- `npm version --workspace` 在 monorepo 里不会自动 commit/tag（已用 `--no-git-tag-version`），需手动提交。
- 必须同时 add `package.json` 与 `package-lock.json`。
- `gh release create` 会自动创建对应名称的 tag，无需手动 `git tag`。
- `--target` 指定 tag 指向的 commit，**必须给完整 SHA**（缩写会失败，报错信息还会误导成 tag 非法）。
- tag 格式必须带包名前缀（`memory-core-v1.0.0`），不能是 `v1.0.0`：`publish.yml` 靠 tag 前缀判断发哪个 workspace。
