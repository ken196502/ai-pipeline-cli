# Plan: xdev 候选池扩容到 20 条 + 候选推文 TXT 归档 + Grok 产物改 TXT

## 1. 现象与根因

| 现象 | 根因 |
| --- | --- |
| 连续两次运行（`artifacts/xdev/2026-11-02T07-21-16-458Z`、`07-28-12-194Z`）目录为空，只有 “没有合适的候选” 提示 | Stage 1 每个关键词只收 `tweetsPerKeyword: 10` 条；Stage 2 审稿人提示词要求「硬核多智能体工程」且鼓励 `STOP: NO_SUITABLE_CANDIDATES` / `selectedIndices: []`，任何“不够硬核”的候选都被整批否决，流水线在写出任何产物前终止 |
| 失败后无法复盘到底搜到了什么 | 候选推文只存在于内存与日志，没有落盘产物 |
| Grok 研究产物是 `.md` | `grok-response-<ts>.md`，Telegram 以 `text/markdown` 发送 |

## 2. 目标

1. 候选池扩大：每个关键词目标 20 条（可配置），滚动轮数随目标自动放大。
2. 选题策略改造：从「二值接受/拒绝 + 停止词」改为「打分排序 + 必选最优」，只有在整批候选都被硬规则命中（发币/纯广告/与 AI 无关）时才允许空选；若模型仍然空选，自动用「强制择优」提示词重试一次，并记录 `selectionMode`。
3. Stage 1 结束即把全部候选推文拼接成一个 `.txt` 落盘（含作者、链接、阅读量、外链、是否往期已写、完整原文、过滤统计），失败也能复盘。
4. Grok 联网研究产物由 `.md` 改为 `.txt`（纯文本排版，无 Markdown 标记），Telegram 以 `text/plain` 发送。

## 3. 改动清单

- `src/pipelines/xdev/contracts.ts`
  - 新增选项 `tweetsPerKeyword`（默认 20）。
  - `XDevPipelineResult` 新增 `tweetsDumpPath`。
  - 阶段描述更新（候选 20 条 / 打分排序选题）。
- `src/pipelines/xdev/cli.ts`
  - 新增 `--tweets-per-keyword <number>`（默认 20），透传给 pipeline。
- `src/pipelines/xdev/scraper.ts`
  - 滚动上限由固定 10 轮改为按目标条数推导（`max(12, ceil(target*0.75)+8)`），否则 20 条目标永远滚不满。
- `src/pipelines/xdev/candidate-dump.ts`（新增）
  - `renderCandidateTweetsTxt()`：纯文本候选汇总渲染（可单测）。
- `src/pipelines/xdev/analyzer.ts`
  - 提示词改为「工程实质 / 题材相关 / 可验证性 / 新颖度」四维打分 + 硬淘汰规则 + 必选最优。
  - 输出新增 `candidateScores`（打分与淘汰原因，便于日志复盘）。
  - 空选/停止词不再直接终止：用「强制择优」提示词重试一次，仍为空才抛 `OperationalWarningError`。
  - `TweetEvaluationResult` 新增 `selectionMode`。
- `src/pipelines/xdev/execute.ts`
  - Stage 1 使用 `options.tweetsPerKeyword`；抓取后立即写 `tweets-<ts>.txt`（零候选时也写，含过滤统计）。
  - Grok 产物改 `grok-response-<ts>.txt`，纯文本内容，`text/plain`。
  - summary JSON / report Markdown 记录 `tweetsDumpPath` 与 `selectionMode`。
- `tests/xdev-candidate-dump.test.ts`（新增）
  - 校验 TXT 渲染包含完整原文、状态标记与过滤统计；零候选时仍产出头部统计。
- `.gitignore`：`artifacts/` 已在忽略列表中（确认）。

## 4. 验证

1. `npx tsc --noEmit` 通过。
2. `npm test`（`tsx --test tests/*.test.ts`）全绿，新增用例覆盖渲染。
3. 真实运行（tmux 命名会话 `xdev-run`）：确认每个关键词抓取目标 20 条、`tweets-<ts>.txt` 落盘、Grok 产物为 `.txt`、选题不再因“不够硬核”整批否决。

## 5. 不做的事

- 不降低 `minViews`、不放开“必须有外链/长文”的硬过滤（属于题材质量底线）。
- 不用模板文章兜底：成稿失败仍然 Fail-Fast。
- 不自动把候选 TXT 推送 Telegram（避免刷屏），仅落盘并在报告中给出路径。
