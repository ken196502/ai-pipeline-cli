# Plan: Filter xdev Candidate Tweets by Minimum 1000 Views Threshold

## Background & Objective
Currently, the `xdev` pipeline scrapes candidate tweets matching search keywords on X (Twitter), but does not inspect or filter by tweet view count (impressions/analytics). Low-view tweets (e.g. dozens or a few hundred views) lack community validation and are not suitable as technical reference candidates for multi-agent architecture thought articles.

The requirement is:
1. Tweets must have at least **1,000 views** to be worthy of reference.
2. If tweets do not meet the minimum view count (< 1000), they must be filtered out.
3. If no candidate tweets meet this criterion (or zero valid tweets remain), fail fast and directly throw an error ("没有直接报错"), with strict adherence to "No fallbacks to hide problems".

## Implementation Details

### 1. Robust View Count Parser (`parseTweetViews`)
Twitter/X presents view counts on candidate tweet cards (`article[data-testid="tweet"]`) in the analytics button (`a[href*="/analytics"]`), formatted in various ways depending on locale and UI version:
- English text/aria-label: `"1,234"`, `"2.5K"`, `"12.4M"`, `"2,450 views. View post analytics"`, `"1.5K Views"`
- Chinese text/aria-label: `"1.2万"`, `"12万"`, `"2,450 次查看。查看推文数据分析"`
- Pure numbers with commas: `"1,050"`, `"950"`

We will implement and export `parseTweetViews(text?: string | null): number`:
- Normalizes comma separators and trims whitespace.
- Detects numeric tokens and scale multipliers:
  - `K` / `k` -> * 1,000
  - `W` / `w` / `万` -> * 10,000
  - `M` / `m` -> * 1,000,000
  - `B` / `b` -> * 1,000,000,000
  - `亿` -> * 100,000,000
- Returns integer views count, or 0 if unparseable/absent.

### 2. Contract Updates (`contracts.ts`)
- Add `views: number` to `ExtractedTweet`.
- Add `minViews: z.number().int().nonnegative().default(1000)` to `XDevPipelineOptionsSchema`.
- Add `filteredLowViewsCount: number` to `ScrapedKeywordResult` and `XDevPipelineResult`.

### 3. DOM Scraping & Filtering (`scraper.ts`)
- In `scrapeTweetsForKeywords`:
  - Query `a[href*="/analytics"]` (or fallback to `[aria-label*="view" i], [aria-label*="次查看"]`) via browser evaluate.
  - Parse the view count with `parseTweetViews`.
  - Filter: if `views < minViews` (default 1000):
    - Increment `filteredLowViewsCount`.
    - Log skip reason.
    - Continue to next tweet.
  - If views >= minViews, proceed with external links / article checks.
  - Set `views` property on `ExtractedTweet`.
  - Return `filteredLowViewsCount` in `ScrapedKeywordResult`.

### 4. Pipeline Execution & Fail-Fast Error (`execute.ts`)
- Pass `minViews: options.minViews ?? 1000` to `scrapeTweetsForKeywords`.
- Record `filteredLowViewsCount` in Stage 1 summary.
- If `allTweets.length === 0`:
  - Throw an explicit Error: `未抓取到符合条件的候选推文（已过滤阅读量不足 1000 的推文 ${scrapeResult.filteredLowViewsCount} 条...）。至少需要 1000 阅读量才值得作为参考。`
  - Immediately dispatch failure alert to Telegram/Pi inbound and stop execution without fallback.

### 5. Reviewer Context (`analyzer.ts`)
- Present `阅读量: ${t.views.toLocaleString()}` in each candidate's summary for LLM reviewer evaluation.

### 6. CLI Support (`cli.ts`)
- Add `--min-views <number>` option (default: 1000).

### 7. Verification & Tests
- Add comprehensive unit tests in `AIGC-pipeline/tests/xdev-views-filter.test.ts`:
  - Verify `parseTweetViews` parsing all formats.
  - Verify filtering logic (< 1000 skipped, >= 1000 retained).
  - Verify zero-survivor throws error directly.
- Run all tests to ensure zero regressions.
- Ensure `.gitignore` ignores test outputs and temporary files.
