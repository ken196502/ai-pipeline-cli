# Plan: xdev 搜索语言/ Top feed 产出，以及 publish-to-x 因非法 SVG 直接失败

本轮先做代码与日志取证，结论如下（全部有代码行号 / 日志行号支撑）。

## 一、publish-to-x 失败根因（已定位到具体字符）

### 现象

`artifacts/xdev/2026-11-05T07-09-26-145Z/xdev-report-*.md`：

```
- **publish-to-x** (198ms): Publish to X failed: Input buffer has corrupt header:
  glib: XML parse error: Error domain 1 code 76 on line 355 column 7 of data:
  Opening and ending tag mismatch: style line 68 and svg
```

198 ms 说明流程停在「准备素材」这一步，编辑器都还没打开，所以**没有生成草稿**。

### 根因 1：LLM 产出的 SVG 里 `<style>` 没闭合

`artifacts/xdev/2026-11-05T07-09-26-145Z/multi-agent-thinking-*.md`：

- L24 `<svg ...>` 开始
- L91 `  <style>` 开始
- L92–L151 全是 CSS（`.t-title`、`.t-footb1`…`.t-footm9`）
- **全文件搜索 `</style>` 结果为空**（`grep -c '</style>'` = 0），L378 直接就是 `</svg>`

librsvg 因此在 `</svg>` 处报 "Opening and ending tag mismatch: style line 68 and svg"。
即：`style` 元素从 L91 一直"吞"到文件尾，整份 SVG 不是 well-formed XML。

### 根因 2：整条链路没有任何 XML 合法性校验

| 位置 | 现有校验 | 问题 |
| --- | --- | --- |
| `src/pipelines/xdev/svg-builder.ts:78 cleanSvgCode()` | 只做 `includes('<svg')` / `lastIndexOf('</svg>')` 截断 + 补 `border-radius` | 不解析 XML；`</svg>` 存在就算"通过"，缺 `</style>` 完全看不见 |
| 同上 `generateArchitectureSvgFromArticle()` L160 / `generateSequenceSvgFromArticle()` L190 | 只 `includes('viewBox') && includes('</svg>')` | 同上，形同虚设 |
| `src/pipelines/xdev/article-assets.ts:22 svgToRasterableBuffer()` | 用正则删 `width`/`height` 再拼新属性 | 正则手术本身也可能制造非法 XML，且不校验 |
| `src/pipelines/xdev/article-document.ts:122-138` | 仅按行匹配 `<svg`…`</svg>` | 同上 |
| `src/pipelines/xdev/article-assets.ts:41 rasterizeSvg()` | 直接交给 `sharp`(librsvg) | **唯一的"校验"就是报错，且报错不带上下文** |

### 根因 3：报错发生在 publisher 的 try/catch 之外

`src/pipelines/xdev/publisher.ts:126` 的 `prepareArticleAssets()` 在 `try {`（L135）之前：

```ts
const { ops, files } = await prepareArticleAssets(opsRaw, {...}); // L126，无保护
...
try {                                                             // L135
```

后果：异常直接冒泡到 `execute.ts:417`，`assetFiles` / `screenshots` / `expected` 全丢，失败原因只剩一行 glib 文本，坏 SVG 也没落盘，无法事后复查。

### 根因 4（诱因）：提示词允许 CSS 类 + `<style>`，模型开始退化

L92–L151 里出现了 `.t-footb1 … .t-footb10 / .t-footc1 … c10 / …` 共 100+ 条**没有任何元素引用**的类，
这是典型的重复性退化输出——正是它把 `<style>` 撑长、把 `</style>` 挤掉（输出被截断/漏写）。
而 SVG 最终只用于栅格化成 PNG，CSS 类**根本不需要**。

### 根因 5（更深的根因）：输出被截断，且没人检查 finish_reason

上表 L91–L151 只是表象。真正的证据是**这份 SVG 里根本没有图**：

```
$ grep -c '<rect' /tmp/broken.svg   → 0
$ grep -c '<text' /tmp/broken.svg   → 0
$ grep -c '<path' /tmp/broken.svg   → 5   （全部在 <defs> 的箭头 marker 里）
$ sed -n '355p' /tmp/broken.svg     → "    .t-footb67{ font-size: 10."   ← 在一个数值中间断掉
```

即模型从 L92 开始无休止地输出 `.t-footbN / .t-footcN / …` 直到 **token 上限**，
CSS 写了一半就被切断，`</style>`、整张图的 `<rect>/<text>` 全部没生成；
`cleanSvgCode()` 又"贴心"地补了一个 `</svg>`，于是它看起来像一份 SVG。

`ChatResult`（`src/libs/llm/types.ts:67`）**没有 finish_reason 字段**，调用方无从得知输出被截断，
所以截断产物被当成正常结果继续往下走。修好 XML 之后它只会变成一张**空白 PNG**（已实测：
3987 字节、纯白），这比报错更糟。

## 二、xdev 搜索策略与 Top feed 抓取逻辑

### 现状（`src/pipelines/xdev/scraper.ts`）

1. **语言硬编码、无 CLI 出口**
   - L94 `const keyword = normalizeSearchQuery(rawKeyword);` → 默认 `lang:en`，不可配。
   - xdev CLI 没有 `--search-lang`（对比 `src/pipelines/xhot/cli.ts:60` 有）。
   - 后果：中文话题无法搜；想让英文话题"放宽"也没开关。
2. **URL 手工拼串，绕过共享构造器**
   - L111 `const searchUrl = \`https://x.com/search?q=${encodeURIComponent(keyword)}&f=${rank}\`;`
   - 而 xhot/discovery 已统一用 `buildXSearchUrl()`（`src/libs/text/search-query.ts:80`）。
   - 现在两套实现，`lang:` / 参数顺序 / 编码规则迟早分叉。
3. **没有任何 CJK 兜底过滤**
   - `isCjkDominated()` 只被 `src/modules/discovery/search.ts:418` 和
     `src/modules/harvest/harvest.ts:183` 使用，**xdev 完全没用**。
   - 证据 A（`artifacts/xdev/_supervisor/last-run.log`，2026-11-04）：
     ```
     → [Agent system] Top 流: https://x.com/search?q=Agent%20system&f=top
     ✓ #7: cxuan (@criscxuan)  [Views: 24092]  "Article别学 subagent 了，现在都玩单 Agent + Main Loop 了…"
     ✓ #9: Star@Day1Global     [Views: 16929]  "Article为 Agent 打造一个 Skill 学习网络…"
     ```
     注意该日志的 URL **没有 `lang:en`**（当时还没有 b91feab），且中文推文照收。
   - 证据 B（`artifacts/xdev/2026-11-05T07-09-26-145Z/xdev-summary-*.json`）：
     跑出来的 `articleTitle` = `长时运行 Agent 的持久化架构…`，`coreTopic` = `长时运行 Agent 的五层持久化架构`，
     `executiveSummary` 整段中文 —— 而正文要求英文。**话题源头就是中文推文**，与 xhot 此前
     "发现阶段英文、harvest 阶段漏中文" 完全同型（见 `Docs/plan-xhot-harvest-lang-en-and-cjk-filter.md`）。
     该 run 发生在 b91feab 之前，说明 `lang:en` 落地后 **xdev 侧未复验**，且文本层兜底从未加上。
4. **Top feed 的实际产出结构**
   - 顺序：`for (const rank of ['top','live'])`，Top 先扫，耗尽才扩到 Latest（L105）。
   - 硬过滤：广告/推广、转推、`text.length < 15`、无 `status` URL、`views < minViews(1000)`、
     **无外链且无 X Article 封面**（L341 `externalLinks.length === 0 && !hasXArticle`）。
   - 每关键词目标 10 条，`maxScrolls = max(12, ceil(target*0.75)+8)`。
   - 上一轮报告：`Collected 20 qualified (Filtered: 3 under 1000 views, 6 ads, 0 retweets, 17 text-only posts without article/links, 0 without status URL)`。
     → Top 流里真正卡人的不是 views，而是**"必须有外链或 X Article"**：17 条纯文本被丢。
     这解释了为什么候选池薄、为什么 `--keywords` 默认只有 2 个词时很容易凑不满。
5. **去重**：`seenTweetIds`（L87）只防重复解析，不做跨 run 去重；跨 run 靠 `splitByHistory` +
   account history（本 run `0 skipped as already written`）。

## 三、修复设计

### A. SVG 生产端：先校验，再交给 librsvg（不做静默兜底）

新增 `src/libs/svg/sanitize-svg.ts`（`src/libs/svg/index.ts` 统一导出）：

1. `sanitizeSvg(raw): { svg, repairs[] }`
   - 去 BOM / XML 非法控制字符；去 `<?xml …?>` / `<!DOCTYPE>`；
   - 删 `<script>`、`on*=` 事件属性；
   - 裸 `&`（CDATA 之外）→ `&amp;`；
   - 标签配平：`<style>`/`<defs>`/`<g>` 等未闭合则补闭合，游离的 `</span>` 丢弃，裸 `<` 转义；
     `style`/`script` 内容按 raw text 处理，CSS 里的 `>` 不会被误判成标签；
   - 根节点缺 `xmlns` 时补上；
   - 每一条修复都进 `repairs[]` 并被打成 warning（可观测，不隐藏）。
2. `assertWellFormedSvg(svg, label)`：用 `@xmldom/xmldom` 真解析（新增依赖，纯 JS），
   失败抛 `SvgXmlError`，带 `line/column` + 出错行上下文。
3. `assertSvgHasContent(svg, label, min=8)`：统计 `<defs>`/`<style>` 之外的
   `rect|circle|ellipse|line|polyline|polygon|path|text` 数量，少于 8 视为「图是空的」。
   这条专门挡「XML 合法但画面全白」——本次真实产物就是这种（可见元素 0 个）。

改造点：

- `svg-builder.ts`：`cleanSvgCode()` **不再**在缺 `</svg>` 时自动补闭合，直接报错；
  之后走 `sanitize → assertWellFormedSvg → assertSvgHasContent`；
  任一步失败 → 把**校验器错误原文 + 出错行**回灌 LLM 重生成一次，仍失败则抛错让
  `asset-generation` 阶段明确失败（不生成坏图、不静默换模板）。
- `llm/types.ts` + `llm/client.ts`：`ChatResult` 增加 `finishReason`，三条解析路径
  （chat completions / SSE / responses API）都填；`finishReason === 'length'` 直接判定截断。
- `article-assets.ts`：`rasterizeSvg()` 先 sanitize + 两道校验；任何失败都把
  **原始 SVG 落盘** `broken-svg-<ts>.svg` 并写进 error message；sharp/librsvg 报错同样落盘。
- `publisher.ts`：`prepareArticleAssets()` 移入 `try`，失败按 `{success:false, error, assetFiles}` 返回，
  不再把异常扔出函数导致 mode/screenshots/expected 全丢。

### B. 提示词硬化（治根因 4/5）

两个 SVG 提示词抽出共享 `VISUAL_BRIEF`，STRICT COMPLIANCE 明确：

- **禁止 `<style>` / CSS 类 / `<script>` / `<foreignObject>`**，所有样式写内联属性；
- 每个开标签必须闭合，空元素自闭合；文本里不得出现裸 `<` / `&`；
- 可见元素 12–60 个，**禁止输出未使用的定义/重复声明**（退化输出的入口）；
- 只输出裸 `<svg>…</svg>`。


### C. xdev 搜索与 xhot 对齐

1. `src/pipelines/xdev/cli.ts`：新增
   `.option('--search-lang <code>', 'Language operator for X search (e.g. en, zh; "none" disables)', 'en')`，
   用 `parseSearchLangOption()` 归一（与 xhot 完全同一实现）。
2. `contracts.ts`：`XDevPipelineOptions` 增 `searchLang: string | null`（default `'en'`）。
3. `scraper.ts`：
   - `KeywordScraperOptions` 增 `searchLang?: string | null`；
   - 删掉 L111 手工拼串，改 `buildXSearchUrl(normalizeSearchQuery(rawKeyword, { lang: searchLang }), rank)`；
   - 候选落库前加 `if (searchLang === 'en' && isCjkDominated(text)) { filteredNonEnglishCount++; log; continue; }`
     （位置：views 过滤之后、`externalLinks` 检查之前，省掉后续无谓的 DOM 查询）；
   - `ScrapedKeywordResult` 增 `filteredNonEnglishCount`，`execute.ts` 的 stage summary 里显式报出。
4. 保留 Top→Latest 顺序、`minViews`、广告/转推/无链接过滤不变（这些是产品决策，不是 bug）。
5. 不新增"关键词自动扩展"之类隐式兜底；如果 Top 流凑不满，日志已经打印实际数量，由人决定加 `--keywords`。

## 四、验证清单

1. `npx tsc --noEmit`。
2. 新增 `tests/svg-sanitize.test.ts`：
   - 未闭合 `<style>` → 修复后可通过 XML 解析，`repairs` 含 `close:style`；
   - 裸 `&`（`AT&T`）→ `&amp;`；
   - 合法 SVG → `repairs` 为空、原样返回；
   - `<script>`/`onload=` → 被剥离；
   - 截断输出（缺 `</svg>`）→ 抛错而非静默补全（`cleanSvgCode` 仍补 `</svg>`，此处验证补完后 `assertWellFormedSvg` 仍能识别其它缺失）。
3. `tests/xdev-search-lang.test.ts` 扩展：`searchLang='none'` 不加 `lang:`；`zh` 加 `lang:zh`；CJK 推文被过滤。
4. 回归：`npx tsx --test tests/xdev-*.test.ts tests/x-search-query.test.ts`。
5. 真跑一次（tmux 命名会话）：
   ```
   tmux new-session -d -s xdev-fix-run -c /mnt/share/VM/AIGC-pipeline \
     'node_modules/.bin/tsx src/cli.ts xdev --draft-only --notify inspilot 2>&1 | tee artifacts/xdev/_supervisor/fix-run.log'
   ```
   验收点：
   - 日志 URL 形如 `...?q=Agent%20system%20lang%3Aen&f=top`；
   - 无 `filteredNonEnglishCount` 之外的意外丢弃，stage summary 里该计数 > 0 属预期兜底；
   - `publish-to-x` 阶段 completed，`x-article-assets-*/inline-01-*.png` 存在；
   - 若仍失败，`broken-svg-*.svg` 落盘且错误信息带行号。

## 五、风险

- 加 `@xmldom/xmldom` 是新依赖（纯 JS、无原生编译），也可退化为自写 SAX 校验；建议直接用库，别自造解析器。
- 禁止 `<style>` 后，SVG 体积略增（内联属性重复），但栅格化结果不变，且彻底消灭该类解析错误。
- CJK 兜底阈值沿用 xhot 的 0.15；中文话题必须显式 `--search-lang zh|none`，否则会被过滤 —— 这是有意的显式行为。
- Top feed 产出薄的问题本轮**不**用"降低 minViews / 放宽链接要求"来掩盖；如需扩池，走 `--keywords` 或新增 `--min-views` 参数显式指定。

## 六、实施结果（已落地）

| 文件 | 改动 |
| --- | --- |
| `src/libs/svg/sanitize-svg.ts`（新） | `sanitizeSvg`（非法字符/XML 声明/DOCTYPE/`<script>`/`on*=`/裸 `&`/标签配平/`xmlns`，逐条返回 `repairs`）、`assertWellFormedSvg`（`@xmldom/xmldom` 真解析，抛 `SvgXmlError` 带行号+上下文）、`assertSvgHasContent`（`<defs>` 外可见图元 < 8 视为空图） |
| `src/libs/svg/index.ts`（新） | 统一导出 |
| `src/libs/llm/types.ts` | `ChatResult.finishReason?: string \| null` |
| `src/libs/llm/client.ts` | chat completions / SSE / responses API 三条路径都填 `finishReason`（responses 的 `status: incomplete` 映射为 `length`） |
| `src/pipelines/xdev/svg-builder.ts` | 缺 `</svg>` 直接报错（不再自动补闭合）；`finalizeSvg` = sanitize → XML 校验 → 空图校验；`generateValidSvg` 带错误回灌重生成一次，仍失败即抛；两个提示词抽出 `VISUAL_BRIEF`，禁 `<style>`/CSS 类/`<script>`，限 12–60 个可见元素 |
| `src/pipelines/xdev/article-assets.ts` | `rasterizeSvg` 先 sanitize + 两道校验；任何失败都把原始 SVG 落盘 `broken-svg-<ts>.svg` 并写进错误信息；librsvg 报错同样落盘 |
| `src/pipelines/xdev/publisher.ts` | `prepareArticleAssets()` 移入 `try`，失败按 `{success:false,error,assetFiles}` 返回 |
| `src/pipelines/xdev/scraper.ts` | 新增 `searchLang` 选项；URL 改用 `buildXSearchUrl()`；views 过滤后加 CJK 兜底（`isCjkDominated`），新增 `filteredNonEnglishCount` |
| `src/pipelines/xdev/cli.ts` / `contracts.ts` / `execute.ts` | `--search-lang <code>`（默认 `en`，`none` 关闭），stage summary 报出非英文过滤数 |
| `tests/svg-sanitize.test.ts`（新） | 11 个用例：未闭合 `<style>`/`<g>`、裸 `&`、CDATA、`<script>`/`on*=`、游离闭合标签、缺 `xmlns`、XML 声明/DOCTYPE、非 svg 根、行号报错 |
| `tests/xdev-search-lang.test.ts` | 补 `--search-lang` 归一、`buildXSearchUrl`（含不重复 `lang:`）、CJK 兜底用例 |

### 验证记录

- `npx tsc --noEmit` → 通过。
- `npx tsx --test tests/svg-sanitize.test.ts tests/xdev-*.test.ts tests/x-search-query.test.ts`
  → **52 + 11 用例全绿**（`xdev-*` 52 pass；svg-sanitize 11 pass）。
- 用**本次真实失败产物**回放（`/tmp/broken.svg` = 报告里那份 SVG）：
  - `assertWellFormedSvg(raw)` → 拒绝：`invalid SVG XML: Opening and ending tag mismatch: "style" != "svg"`
  - `sanitizeSvg(raw)` → 1 处修复 `unclosed(<style> opened at line 68, column 3)`
  - `prepareArticleAssets([{svg: raw}])` → 拒绝并落盘 `broken-svg-*.svg`：
    `SVG has only 0 visible drawing element(s) (< 8): the diagram is empty, degenerate or truncated`
    （修复 XML 后原本会栅格化出一张纯白 3987 字节 PNG —— 现在被空图检查拦住）
  - 一张 12 图元的正常示意图 → `inline-01-*.png` 45118 字节，肉眼确认渲染正确。

### 未做/待办

- 尚未真跑一次完整 xdev（浏览器 + Grok + 生图约 20 分钟）验证 `--search-lang` 与草稿发布端到端；
  建议用命名 tmux 会话跑 `--draft-only`，验收点见第四节。

## 七、更正：`lang:en` 才是漏掉 Top 首位帖子的原因（A/B 实测）

### 先更正一处错误推断

上一版把 `The original article is in Chinese. This is a machine translation.` 当成了 X 的应用内提示。
实际打开 `https://x.com/DeepSeekHarness/article/2116857257245987236` 可见，它是**文章正文的第一段**
（紧跟在作者名/互动数之后，`<html lang="en">`）。由此推出「X 把它判为 zh」是**没有依据的**，撤回。

### 实测（2026-11-06，同一会话，同一账号，`f=top`）

| 查询 | 返回条数 | `DeepSeekHarness/2116857257245987236` |
| --- | --- | --- |
| `Agent system` | 6 | **#1** ✅ |
| `Agent system lang:en` | 4 | 不存在 ❌ |
| `Exploring Super-agent Design` | 5 | **#1** ✅ |
| `Exploring Super-agent Design lang:en` | 6 | 不存在 ❌ |
| `from:DeepSeekHarness` | 0（该账号只有长文帖，普通搜索不索引） | — |

结论：**帖子仍在 Top 第一位**，是 `lang:en` 这个操作符把它从结果里剔掉了
（X 对长文帖的语言判定依据文章正文，而正文是中文原文的机器翻译）。
这是 b91feab 把 `lang:en` 设为 xdev 默认值后引入的回归。

### 修正

- `contracts.ts` / `cli.ts`：`searchLang` 默认改为 `null`（`--search-lang none`），
  即**默认不向查询追加语言操作符**；`--search-lang en` 仍可显式开启（此时 CJK 兜底才生效）。
- `scraper.ts`：未传 `searchLang` 时不再默认 `'en'`；启动时打印当前语言策略，避免再次"静默过滤"。
- 顺带补上「无外链/长文」丢弃的日志（之前是静默 `continue`，导致"帖子为什么没进来"无法从日志回答）。
- 语言控制回到素材/产出层：文章正文本来就有英文闸门（CJK 占比 > 5% 判不合格）。

### 修复后实测（`scrapeTweetsForKeywords('Agent system', 4)`）

```
collected=4 targetPresent=true
target at position #1: views=3191161 links=0
order: #1 @DeepSeekHarness, #2 @AnatoliKopadze, #3 @StackDhruv, #4 @AnatoliKopadze
filtered: nonEnglish=0 noLink=2 lowViews=1 ads=1
```

即：默认配置下 Top 首位帖子重新进入候选池。

### 已知副作用（需产品决策）

- 中文推文现在会进入候选（`filteredNonEnglishCount` 恒为 0，除非显式 `--search-lang en`）。
- 中文原文长文会被选中，正文仍由英文闸门保证输出英文，但 `coreTopic` / `executiveSummaryZh`
  这类中间产物会是中文（2026-11-05 那次就是这样）。
- 若要「只要英文来源」，用 `--search-lang en`，代价是本次这类 Top 首位帖子会被漏掉。

### 最终策略（按用户要求：去掉 lang，改为列表级英文过滤）

- **彻底移除** xdev 的 `--search-lang` 选项与 `searchLang` 配置：查询 URL 永远是
  `https://x.com/search?q=<keyword>&f=top`，不再向 X 发送任何 `lang:` 操作符
  （`buildXSearchUrl(rawKeyword, rank, null)`）。xhot 仍保留自己的 lang 逻辑，互不影响。
- **列表级英文过滤（无条件生效）**：`scraper.ts` 新增纯函数
  `isEnglishListText(text) = !isCjkDominated(text)`，在「阅读量过滤之后、外链/长文判定之前」
  逐条判断搜索结果行的预览文本；CJK 占比 ≥ 15% 即丢弃并打印
  `↳ Skip non-English tweet [@handle]: …`，计入 `filteredNonEnglishCount`（写进 stage summary）。
  - 纯图/纯视频行文本为空 → CJK 比例为 0 → 不会被误杀。
  - 英文标题 + 中文正文的长文（本次的 DeepSeekHarness 帖）→ 列表文本是英文 → 保留。
- 实测（2026-11-06）：
  - `Agent system` → `#1 @DeepSeekHarness`（3.19M views）重新进入候选池；
  - `智能体` → `Skip non-English tweet` 连续丢弃 `@guanmo_ai / @huxlab / @katcat_AI /
    @jinchenma_ai / @Khazix0918` 等中文行，一条都不进候选。
- 测试：`tests/xdev-search-lang.test.ts` 覆盖「URL 不含 lang:」「中文行被拒」「英文长文标题通过」
  「纯图/空文本不被误杀」。

## 八、为什么"最高阅读量"的帖子没被引用（Stage 2 打分机制）

去掉 `lang:` 后，DeepSeekHarness 那帖确实以 **#1（3,196,230 views）** 进入候选池
（见 `artifacts/xdev/_supervisor/verify-nolang.log` 第 18 行），但 Stage 2 的审稿人把它淘汰了：

```
#5 88 分 @0xwhrrari   ← 选中
#2 75 分 @StackDhruv
#13 70 分 @monokern
#4 65 分 @_avichawla
#14 65 分 @Promixyz
（DeepSeekHarness 不在前五）
```

根因不是"搜索/语言"，而是**打分时看不到长文正文**：

1. 选题由 LLM 按 100 分制打分（工程实质 40 / 相关性 30 / 可验证性 20 / 新颖度 10），
   **阅读量只展示、不参与计分**。
2. X 原生长文在时间线卡片上**只露出标题**：
   `推文原句 = "ArticleExploring Super-agent Design: Towards a More Autonomous Agent System"`，
   而 `外链: 无` —— 于是「工程实质」和「可验证性」两项都接近 0 分。
3. 正文（`fetchSelectedArticles`）原本在 **Stage 3** 才抓，也就是**选完之后**才抓 →
   长文永远只能拿标题参赛，必然输给有正文的普通推文。

### 修正

- `contracts.ts`：`ExtractedTweet` 增加 `isXArticle` / `articleUrl`（`scraper` 落库时写入，
  `articleUrl = x.com/<handle>/article/<statusId>`）。
- `analyzer.ts`：
  - `buildCandidateList()` 增加 `类型: X 原生长文（Article），正文已预取 / 未预取（仅标题）`，
    并把预取到的正文（前 1500 字）一并给审稿人；`外链` 行注明「无（原生长文: URL）」。
  - 新增 `hydrateArticleCandidates(tweets, fetcher, {limit=8, minChars=200})`：
    在 Stage 2 打分**之前**，按阅读量从高到低预取最多 8 条 X 原生长文正文
    （失败/过短/超预算都显式打日志，不静默）。
  - 评分细则「可验证性」明确把「X 原生长文正文（已预取）」计入。
- `execute.ts`：Stage 2 先 hydrate 再打分，stage summary 报出预取条数。
- 实测 `fetchArticleContent('https://x.com/DeepSeekHarness/article/2116857257245987236')`
  → 4000 字符正文（页面 `<title>` 是 "X"，故标题回退用推文标题）。
- 测试：`tests/xdev-candidate-articles.test.ts`（5 例：类型标注、正文注入、按阅读量取前 N、
  过短判失败、单条失败不影响整批）。

### 仍未改变的部分（需产品决策）

- 阅读量**依然不参与计分**。若要求"阅读量最高的必须当引用"，需要显式改规则
  （例如给热度 5–10 分，或"阅读量 > N 且分数不低于阈值者优先"），这属于产品策略，
  不应由实现悄悄决定。

## 九、阅读量加权（网友的肯定 = 硬指标）

按用户要求：**阅读量必须大权重**。最终选题不再只由 LLM 内容分决定，而是系统按下式排名：

```
综合分 = 内容分(0-100) × 0.5 + 阅读量热度(0-100) × 0.5
阅读量热度 = 100 × log10(1 + views) / log10(1 + 本批最大 views)
```

- 权重常量集中在 `analyzer.ts`：`CONTENT_WEIGHT = 0.5` / `VIEW_WEIGHT = 0.5`，
  改策略只改这两个数（不散落在提示词里）。
- 用 log 而非线性：线性会让 3.19M 把其余全部压到 ~0；log 下 25k views ≈ 68 分、3.19M = 100 分，
  既保留量级差，又不会让中腰部全军覆没。
- 硬淘汰仍然优先：内容分 0（发币/纯广告/无关）不进排名；LLM 未打分的候选不进排名（不当作 0）。
- **改判机制**：若 LLM 初选与综合分第一不一致，系统把第一名锁定，再让 LLM 只产出该候选的
  `articleTitle / executiveSummaryZh / topics`（`buildLockedSelectionPrompt`）。若 LLM 不按锁定索引
  输出 → 直接报错，**绝不静默回退**到低热度候选。
- 日志可审计：
  ```
  • 综合得分（内容 50% + 阅读量热度 50%）前五名：
      - #0 综合 82.5（内容 65 / 热度 100 / 3,190,536 views）@DeepSeekHarness
      - #1 综合 77.8（内容 88 / 热度 68 / 25,973 views）@StackDhruv
  • 阅读量加权改判：LLM 初选 #1 → 综合最高 #0（内容 65 / 热度 100 / 综合 82.5）
  ```
- 按本次真实数据验算：3.19M views + 内容 65 = 82.5，反超 25,973 views + 内容 88 = 77.8。
- 测试 `tests/xdev-view-weighted-selection.test.ts`（7 例）：权重常量、log 归一化、真实数据反超、
  0 分硬淘汰、热度高但内容差仍会输、未打分不参与、权重可配置。
