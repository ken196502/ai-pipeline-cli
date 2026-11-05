# Plan: 删除 X Article 全部草稿 + 重跑 xdev 流水线

## Goal
1. 写一个脚本，打开 Firefox（复用已登录会话），进入 X Article 草稿列表，**删除全部草稿**（先在 LIST 模式核对，再加 `--delete` 真正删除）。
2. 删除完成后，重跑完整 xdev pipeline（supervisor + `--notify inspilot`）。

## Why a script (not one-off)
- 每次 pipeline 运行都会新建一个 X Article 草稿，长期会累积大量草稿。
- 复用现有 `src/pipelines/xdev/bidi-driver.ts` 的 `FirefoxBiDiDriver` 做认证（launch + injectCookies，injectCookies 内部会自动从 live Firefox profile 刷新 cookie），避免重复造轮子与登录态不一致。
- 草稿列表 DOM 不确定，脚本先 LIST（打印标题/URL/数量 + 截图 + dump 关键 DOM），核对后再 `--delete`，做到"先看清再删"，不隐藏问题。

## Script: `tools/xdev-delete-drafts.ts`
- 用 tsx 运行（与仓库一致）。
- 流程：
  1. `new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' })` → `launch()`。
  2. `injectCookies('https://x.com')` 注入/刷新登录态。
  3. 打开 `https://x.com/compose/articles`，识别并点击左侧「Drafts」入口（文案/aria-label 自适应匹配）。
  4. 枚举草稿：扫描 `href` 含 `/compose/articles/edit/` 的链接，提取标题 + 草稿 URL。
  5. **LIST 模式（默认，安全）**：打印草稿数量、标题、URL；保存截图与草稿列表 DOM 到 `artifacts/xdev/_drafts-cleanup/`。
  6. **DELETE 模式（`--delete`）**：逐条打开草稿编辑器 → 点击右上「…」菜单 → 点「Delete draft」→ 在确认对话框点「Delete」→ 回草稿列表校验数量减少。每条删除前打印将被删除的标题/URL；失败的单条跳过并继续，不中断。
- 清理浏览器（`driver.cleanup()`），退出码 0。
- 在命名 tmux 会话中运行（长时浏览器进程），日志落盘；不轮询，结果由日志/截图回传。

## 重跑流水线
- `tmux new-session -d -s xdev-full -c <repo> 'TMPDIR=.../AIGC-pipeline/.tmp/firefox-tmp node tools/xdev-supervisor.mjs --notify inspilot'`
- 沿用上次修复：`TMPDIR` 指向根文件系统（2GB tmpfs 不再被 Firefox 临时 profile 撑爆）。
- 结果/报错照例推送到 inspilot bot。

## Verification
- 脚本 LIST 模式先跑：确认能正确识别草稿数量与 URL（与已知草稿 `2117867234068684800` 等核对）。
- `--delete` 跑完后：再次 LIST 确认草稿数为 0（或仅剩新建的当期草稿）。
- 流水线重跑：收到 inspilot 的 ✅/💥 结果。

## Out of scope
- 不改 pipeline 其它 stage；不改发布策略（仍 DRAFT 不发布）。
- 不删除已发布的 Article，只删草稿。

## Status (2026-11-04)
- 脚本：`tools/xdev-delete-drafts.ts`（LIST / `--probe` / `--delete` 三种模式）。
- 关键 DOM 发现：每篇草稿行自己的 “…” 按钮是 `button[aria-label="More"][class*="r-bt1l66"]`；全局左侧导航是 `aria-label="More menu items"`（之前误点它导致删不掉）。行菜单是 `[role="menu"]`，删除项是 **Delete Article**，确认按钮文案 **Yes, delete**。
- 删除结果：5 篇草稿全部删除，二次 LIST 验证为 0（drafts-list-*.png / *_run3.log）。
- 全量流水线：已用 `tmux new-session -d -s xdev-full` 启动 `TMPDIR=.../.tmp/firefox-tmp node tools/xdev-supervisor.mjs --notify inspilot`；Grok 冒烟 91.6s 通过，Phase 1 Stage 1/7 进行中，告警路由到 inspilot bot (port 3095)。完成/错误告警由 supervisor 自行推送到 inspilot。
- 导航健壮性：用轮询 Drafts 导航 + reload 重试替代固定 sleep，规避偶发的 SPA 未挂载导致 0 草稿的竞态。
