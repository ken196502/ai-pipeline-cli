# xdev 关键词抓取：改为 Top 流优先（f=top）

## 问题

`src/pipelines/xdev/scraper.ts` 的搜索 URL 被写死为 `&f=live`（Latest 标签页）。
Latest 流全是刚发布、几乎零曝光的新帖，实测同一条查询下只有 **3 views / 410 views / 867 views**，
永远无法通过 `--min-views 1000` 的硬门槛，导致 Stage 1 恒定为 0 候选、整条 pipeline 永远失败。

对照：`src/modules/discovery/search.ts` 早已是 Top 优先 + Latest 兜底的写法。

## 改动

1. **`src/pipelines/xdev/scraper.ts`**
   - 每个关键词改为按 `['top', 'live']` 顺序扫流：
     - `f=top` 先扫，`scrollCount` 每换一个流重置；
     - 仅当 Top 流候选耗尽（广告 / 重复 / 无外链 / 低阅读量）且未达目标时，才显式切到 `f=live` 补充，并打印一行说明；
     - `collectedForThisKeyword` 跨流累计，去重沿用全局 `tweetMap`。
   - 新增 `seenTweetIds` 集合：被低阅读量 / 无外链过滤掉的推文不再在每轮滚动里重复解析、重复打日志。
   - 每条流的 URL 都通过 `console.log` 打印（`→ [keyword] Top 流: ...`），便于事后核对实际请求的是哪个标签页。

2. **`src/pipelines/xdev/cli.ts`**
   - 删除重复声明的 `--tweets-per-keyword` 选项与重复的对象字面量键（原为 TS1117 编译错误，阻塞 typecheck）。

3. **`scripts/smoke-xdev-top-feed.ts`**（新增）
   - 独立冒烟脚本：真实拉起 Firefox ESR + cookies，只跑 Stage 1 抓取，打印每条候选的 views/链接，并把结果推回 Telegram。

## 验证

- `npx tsc --noEmit` 通过，`npm run build` 通过。
- 冒烟实跑（关键词 `Agent system`，target 3，minViews 1000）：
  - Top 流拿到 **1,549,047 views** 与 **41,465 views** 两条合格候选（旧逻辑不可能拿到）；
  - Top 流耗尽后按设计扩展到 Latest，Latest 侧实测 3 views，确认兜底不会污染结果；
  - 汇总：`collected 2`、`filtered lowViews 82`、`noLink 44`、`ads 4`，`RESULT: PASS`。

## 第二轮：Top 流里真正该拿的帖子被静默丢弃

用户指出 `Agent system` 的 Top 首条应是
`https://x.com/DeepSeekHarness/status/2116857257245987236`（**1,847,862 views**），
但 pipeline 从未收过它。用 `scripts/diag-xdev-views.ts` / `diag-xdev-article-links.ts` /
`diag-xdev-article-badge.ts` / `diag-xdev-author.ts` 逐层定位，发现 3 个独立 bug：

1. **X Article 长文帖全部被当成「无外链」丢弃**
   - 现行 X 布局下 Article 帖**没有任何 `a[href*="/article/"]` 锚点**，只有 `[data-testid="article-cover-image"]` 封面。
   - 旧的 `hasXArticle` 只查锚点 → 恒为 false → 命中 `externalLinks.length === 0 && !hasXArticle` 分支。
   - 冒烟里那 44 条 `noLink` 就是这类帖子，包含 1.8M / 1.0M / 23K views 的三条 Article。
   - 修复：改用 `[data-testid="article-cover-image"]` 作为主判据，保留旧锚点判断兼容老布局。

2. **推文 URL 解析不稳 → 空 url**
   - 旧代码取 `timeEl.parentElement()` 当锚点，某些布局下 `<time>` 外层不是 `<a>`，`href` 拿不到，记录带空 `url`。
   - 空 `url` 会破坏 citation、`tweetIdFromUrl()` 历史去重等下游逻辑。
   - 修复：在页面内用 `time.closest('a[href*="/status/"]')` 向上找锚点，并用 `/\/([^/]+)\/status\/(\d+)$/` 排除 `/analytics`、`/photo/1` 等子路径；
     仍解析不到 `status/<id>` 的记录**直接丢弃**并计入新增的 `filteredNoUrlCount`（不再产出空 url 的脏数据）。

3. **WebdriverIO 严格模式导致作者/正文丢失**
   - 含引用推文的 article 里 `[data-testid="User-Name"]` / `[data-testid="tweetText"]` 会命中 2 个元素，
     严格模式抛 `StrictSelectorError`，被外层 `catch` 静默吞掉 → 作者变 `Unknown`、正文为空 → 推文被长度检查丢弃。
   - 修复：这些单元素选择器统一加 `{ strict: false }`。

## 第二轮验证

- `scripts/smoke-xdev-top-feed.ts "from:DeepSeekHarness" 2`：收下 Article 帖
  `https://x.com/DeepSeekHarness/status/2105330281389662575`，**1,212,927 views**，作者 `@DeepSeekHarness` 正确，`noUrl 0`。
- `scripts/smoke-xdev-top-feed.ts "Super-agent Design" 2`：收下 8,128 / 2,152 views 两条，作者均正确。
- `scripts/smoke-xdev-top-feed.ts "Agent system" 4`：收下 588K / 38K / 3.2K / 1.4K views 四条，
  `noLink 0`、`noUrl 0`（旧逻辑下这些 Article 帖全部进 noLink）。
- `scripts/diag-xdev-author.ts "Agent system"` 实测 Top 流 #0 即 DeepSeekHarness 那条（1.8M views，cover=True）。

## 已知遗留

- `npm test` 有 1 个**既有**失败：`tests/xhot-pipeline.test.ts` → `executeXHotPipeline in dry-run mode ... report.md must be generated`。
  xhot pipeline 与本次改动的 xdev 代码无引用关系，未在本次处理。
