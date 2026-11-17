# AGENTS.md

## 仓库结构与硬约束

workspace 划分、`memory-core` 的中立性要求、公开 API 出口、不可顺手改动的用户契约、仓内解析与发布
形态的差异，请参考 [docs/guides/architecture.md](docs/guides/architecture.md)。

## 依赖

宿主包的 `peerDependencies` 约定、`@earendil-works/*` 版本钉死的原因、dependabot 的刻意例外，请参考
[docs/guides/dependencies.md](docs/guides/dependencies.md)。

## 文档

用户文档（`README*`、`docs/reference`、`docs/guides`）只描述**当前状态**，不是 changelog：

- 不写日期、PR/commit/CI run 编号、测试数量，也不写「上一次 / 曾经 / 修复波 / 审阅提出 / 已修」这类过程叙事；
- 不写版本演进（「从 x.y.z 起」）；具体版本号指向 `package.json` 与 CI，不在文档里复制；
- 历史留在 git log、PR 描述与该次变更的 spec 里。`docs/superpowers/specs/` 是唯一例外 —— 它本身就是记录。

## 发布新版本

请参考 [docs/guides/release.md](docs/guides/release.md)。
