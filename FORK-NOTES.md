# Fork 说明

本项目是 [kyle123740/dsh-message-recall](https://github.com/kyle123740/dsh-message-recall) 的 fork，
在上游 0.2.1 的基础上做了本地增强，主要用于 DSH 0.2.1 桌面端。

## 与上游的差异

- `lib/main.js`、`lib/client.js` 重写/增强（构建标记 `BUILD = "2026-10-22.4"`）：
  - 新增 `migrate` / `inspect` / `repair` 三个维护动作；
  - 新增孤儿墓碑修复（`repairOrphans`）、墓碑溢出对齐（`alignSpan` / `userSpanForward`）；
  - 撤回/删除回执带说明（`receiptNotes` / `mergeNotes`）；
  - 删除用户提问时连带删除它触发的回答（含 reasoning 块）；
  - 补充了大段行为说明注释。
- 新增 `tools/`：会话修复与自检脚本（`repair-session.mjs`、`check-pairing.mjs` 等），
  仅用于排障，不会随插件安装。

## 安装

```bash
# 在 DSH profile 目录（如 ~/.dsh/profiles/desktop）执行
pnpm add github:1234yqcg/dsh-message-recall
```

然后把 `@kyle123740/dsh-message-recall` 加进 `package.json` 的 `dsh.profile.bundles`，重启 DSH。

## 说明

- 包名仍是 `@kyle123740/dsh-message-recall`，bundle id 不用改。
- 上游更新后可以直接 merge 上游 `main`。
