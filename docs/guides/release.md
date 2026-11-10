# 发布新版本

发布通过 GitHub Actions 完成，触发条件是创建 GitHub Release（tag 格式 `memory-core-v*` 或
`pi-memory-v*`）。`publish.yml` 收到 `release: published` 后执行 `npm ci` +
`npm publish --provenance --workspace=<dir>`（OIDC 认证，不需要本地 token）。

## 顺序：`memory-core` 必须在 `pi-memory` 之前

`pi-memory` 的 `dependencies` 指向 `@yandy0725/memory-core@^2.0.0`。

- **core 不在 registry 上就发 `pi-memory`，得到的是一个装不上的包**：用户会拿到
  `No matching version found for @yandy0725/memory-core@^2.0.0`。
- 反过来安全：只发 core、不发 `pi-memory`，不影响任何现有用户。

## 步骤

```bash
# 1. 确保全部通过
npm ci && npm run typecheck && npm run lint && npm test

# 2. 升级版本号并提交（core 与 pi-memory 各自独立升）
npm version <新版本号> --workspace=memory-core --no-git-tag-version
git add memory-core/package.json package-lock.json
git commit -m "memory-core v<新版本号>"
COMMIT=$(git rev-parse HEAD)

# 3. 推送
git push origin main

# 4. 创建 GitHub Release（gh 自动创建 tag；--target 必须是完整 SHA）
gh release create memory-core-v<新版本号> --target "$COMMIT" \
  --title "memory-core v<新版本号>" --notes ""
```

`pi-memory` 同理，把 `memory-core` 换成 `pi-memory`，且要等上一步的 core 已经在 registry 上。

`memory-core` 带 `prepublishOnly: npm run build`，所以发布前一定会重新构建 `dist/`；不要提交 `dist/`。

## `registry-smoke` 的两段式：先跳过，发布后重跑

`registry-smoke` 把适配层的 tarball 装进干净目录、**从 registry** 拉 core 再 `import` 入口。所以当核心的新版本
还没发布时，这条路径**客观上无法验证**。脚本因此分两种情形：

- **发布进行中**（核心范围在 registry 上查不到，**且**适配层自己声明的版本也未发布）→ `::notice::` 跳过，
  不报错。不要把它当成代码错，也不要把跳过看成验证通过。
- **声明的范围真的不存在**（适配层已发布，而 `dependencies` 里的核心范围在 registry 上没有）」→ 硬失败。
  这是真错：手改了范围却忘了发 core。

所以发完 core 之后，***在同一条合并提交的 workflow 上重跑***，那一次它会真的装一遍：

```bash
gh run rerun <run-id> --failed
```

由「跳过」变成「通过」之后，再按上面的步骤发 `pi-memory-v4.0.0`。顺序不能反：先 `memory-core`，后
`pi-memory`（后者依赖前者的新版本）。

## 验收：不要只看 workflow 绿

npm 的 publish 成功不等于 registry 立刻可查（会先返回「being processed」）。按这三步确认：

```bash
# 1. 轮询版本文档到 200
curl -s -o /tmp/v.json -w "%{http_code}\n" https://registry.npmjs.org/@yandy0725%2Fmemory-core/2.0.0
# 2. 把 dist.shasum 与 publish 日志里 npm notice 打的 shasum: 逐字比对
node -e 'console.log(require("/tmp/v.json").dist.shasum)'
# 3. 确认 dist-tags.latest 已翻到新版本
curl -s https://registry.npmjs.org/@yandy0725%2Fmemory-core | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)["dist-tags"]))'
```

## 注意事项

- `npm version --workspace` 在 monorepo 里不会自动 commit/tag（已用 `--no-git-tag-version`），需手动提交。
- 必须同时 add `package.json` 与 `package-lock.json`。
- `gh release create` 会自动创建对应名称的 tag，无需手动 `git tag`。
- `--target` 指定 tag 指向的 commit，**必须给完整 SHA**（缩写会失败，报错信息还会误导成 tag 非法）。
- tag 格式必须带包名前缀（`memory-core-v1.0.0`），不能是 `v1.0.0`：`publish.yml` 靠 tag 前缀判断发哪个 workspace。
