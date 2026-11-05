# Plan: xhot 视频仍出现中文推文 — harvest 阶段补 lang:en + CJK 兜底过滤

## 现象

`xhot-1793891168854-9scw2p` 的成片里仍有中文推文（@wangwan97978269 / @fankaishuoai /
@huang18825 / @feishutoday / @leo114119 / @jackyang886 / @xKaka1456 等）。

## 根因（已用日志证实）

`lang:en` 只覆盖了发现阶段，harvest 阶段完全没有：

| 阶段 | 日志证据 | 是否带 lang:en |
| --- | --- | --- |
| x-search-grid（discovery） | `Effective search query: "new model lang:en"` / `?q=new%20model%20lang%3Aen&f=top` | ✅ |
| x-harvest（deep search） | `?q=OpenAI%20GPT-6.2%20Astra%2FSol&f=top` | ❌ |

`src/modules/harvest/harvest.ts:122` 自己拼 URL：

```ts
const searchUrl = `https://x.com/search?q=${encodeURIComponent(winnerName)}&f=top`;
```

`plan-xhot-search-lang-en.md` 第 5 条把这里写成「有意保持原样」，理由是怕中文作者的原文被排除。
实际后果就是：发现阶段 12 条全是英文，harvest 阶段 20 条里 7 条中文，全部进入 materials →
explainer 的推文卡片/引用里出现中文。这个「有意为之」是错的，撤销。

## 设计

1. **harvest 复用共享 URL 构造** `src/modules/harvest/harvest.ts`
   - 删掉本地拼串，改用 `buildXSearchUrl(winnerName, 'top', searchLang)`。
   - `HarvestWinnerOptions` 增加 `searchLang?: string | null`，默认 `'en'`。
   - 日志同时打印 `effectiveQuery`（normalize 后的 query），便于下次核对。

2. **CJK 兜底过滤（不依赖 X 的 lang: 判定）**
   X 的 `lang:en` 是启发式判定，中英混排 / 英文关键词 + 中文正文仍可能漏进来，所以加一道
   文本层硬过滤：
   - `src/libs/text/search-query.ts` 新增 `cjkRatio(text)` / `isCjkDominated(text, threshold = 0.15)`；
   - harvest 扫描循环里 `searchLang === 'en'` 且 `isCjkDominated(text)` → 打印 `Skipping non-English tweet`
     并 `continue`（不进 candidates、不占 previewCount）；
   - discovery 的 `sweepFeed()` 对 `captureCandidate()` 返回的 ok 候选做同样判断；
   - 纯图/纯视频（text 为空）CJK 比例为 0，不受影响。

3. **配置透传** `src/pipelines/xhot/execute.ts`
   - `harvestWinnerTopicMaterials({ ..., searchLang: options.searchLang })`。
   - 复用已有的 `--search-lang <code>|none`，`none` 时 harvest 也不加语言限定（给中文话题留口）。

4. **不动的地方**
   - 发现阶段的 `f=top` 优先 + `f=live` 兜底逻辑。
   - `--search-lang none` 的逃生口语义。

## 验证

- `npx tsc --noEmit`。
- `tests/x-search-query.test.ts` 补 `cjkRatio` / `isCjkDominated` 用例（中文正文、中英混排、
  纯英文、空串、纯 emoji）。
- 回归 `npx tsx --test tests/x-search-query.test.ts tests/xdev-*.test.ts tests/xhot-pipeline.test.ts`。
- 真跑一次 xhot，检查 `pipeline.log` 里：
  - `[x-harvest] Deep searching ... -> https://x.com/search?q=...%20lang%3Aen&f=top`
  - 不出现 `Skipping non-English tweet` 之外的意外跳过（若出现，说明 X 搜索结果确实混语言，属于预期兜底）。
- 用 `harvest-result.json` 的 `items[].text` 检查 CJK 占比为 0。

## 风险

- 中文话题（`--search-lang none`）不走 CJK 过滤，行为不变。
- 极端情况下英文话题的英文结果不足 20 条 → harvest 只收集到更少候选，`targetCount` 由 VL 排名
  决定，仍能凑够 10 条（Top feed 至少几十条）。若真不足，日志会显示实际数量，不静默截断。
