# Plan: xhot 搜索默认限定英文 (lang:en)，与 xdev 对齐

## 背景

`plan-xdev-default-english-search.md` 只覆盖了 xdev。xdev 侧已完成：
`src/pipelines/xdev/scraper.ts` 的 `normalizeSearchQuery()` 在关键词无 `lang:` 时自动追加 `lang:en`。

xhot 走共享模块 `src/modules/discovery/search.ts` 的 `searchXCandidates()`：
- **`f=top` 优先 + `f=live` 兜底**：本来就有，无需改动；
- **`lang:en`**：完全没有，`query` 直接 `encodeURIComponent` 拼进 URL。

结果：同一条 pipeline 平台上，xdev 只搜英文，xhot 中英文混杂。

## 设计

1. **抽出共享纯函数** `src/libs/text/search-query.ts`
   ```ts
   export function normalizeSearchQuery(keyword: string, options?: { lang?: string | null }): string
   ```
   - 默认 `lang = 'en'`；
   - 关键词已含 `lang:xx`（大小写不敏感、词边界匹配）→ 原样返回，不重复追加；
   - `lang` 传 `null` / 空串 → 完全不加语言限定（给中文话题留逃生口）；
   - 空关键词 → 返回空串。
   - 由 `src/libs/text/index.ts` → `src/libs/index.ts`（`textLib`）统一导出。

2. **xdev 改为复用** `src/pipelines/xdev/scraper.ts`
   - 删除本地实现，改为从 `libs/text` 导入并 re-export（`tests/xdev-search-lang.test.ts` 的导入路径保持不变）。

3. **xhot discovery 接入** `src/modules/discovery/search.ts`
   - 新增导出 `buildXSearchUrl(query, rank, lang)`：内部做 normalize + encode，便于单测。
   - `SearchXOptions` 增加 `searchLang?: string | null`（默认 `'en'`）。
   - `sweepFeed()` 用它拼 URL，并打印最终实际检索的 query。

4. **配置透传**
   - `src/pipelines/xhot/contracts.ts`：`searchLang: z.string().nullable().default('en')`。
   - `src/pipelines/xhot/cli.ts`：`--search-lang <code>`，取值为 `en` / `zh` / …，`none` 表示不加限定。
   - `src/pipelines/xhot/execute.ts`：把 `searchLang` 传给 `searchXCandidates()`。

5. **不动的地方**
   - `src/modules/harvest/harvest.ts` 的 `f=top` 深挖搜索：它按 winner 的作者名/关键词精确回溯，
     加 `lang:en` 反而可能把中文作者的原文排除，保持原样（在 plan 里记录为有意为之）。

## 验证

- `npx tsc --noEmit` 通过。
- 新增 `tests/x-search-query.test.ts`：
  - 默认追加 `lang:en`；已有 `lang:en` / `lang:zh` 不重复追加；
  - `lang: null` 不加限定；空白/空串处理；
  - `buildXSearchUrl('AI agents', 'top')` → 含 `f=top` 且含 `lang%3Aen`；
  - `buildXSearchUrl('AI agents', 'live', null)` → 不含 `lang`。
- `npx tsx --test tests/xdev-search-lang.test.ts tests/x-search-query.test.ts` 全绿。
- 回归：`npx tsx --test tests/xdev-*.test.ts tests/xhot-pipeline.test.ts` 保持 49 pass / 0 fail。

## 风险

- 中文话题默认被加上 `lang:en` 会搜不到中文帖 → 用 `--search-lang none`（或 `zh`）显式覆盖；
  该逃生口在 plan 与 CLI help 中写明。
