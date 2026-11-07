# 实施计划 v2：xhot 脚本生成的 Fireship 化叙事与表现力增强

> 本文件仅为**实施计划**，不含任何代码改动。所有编码在计划评审通过后进行。
> 行文为中文，所有标识符 / 字段名 / 文件路径 / CLI 选项保持英文原样。

## 0. 目标与范围

**目标**：优化 xhot pipeline 的脚本生成（storyboard），把叙事从"沉稳纪录片"风格转向 **Fireship**（快节奏、高信息密度、短句、冷幽默、直接称呼"you"、用具体数字与对比、有观点但严格基于事实），再在**不破坏内容/效果分离铁律**的前提下提升**表现力（表现力 = 视觉与听觉节奏）**。

**三条主线**：
- A. 叙事（Fireship 化）——改 prompt。
- B. 确定性约束（核心工程量）——新增 narrative linter，接入与 schema 校验**同一条 repair 循环**，一轮修复后硬失败，**绝不 fallback**。
- C. 表现力——新增 `preset:fireship` 样式，调整 xhot 默认值。

**绝对边界**：
- 只新建本文件之外列出的新文件；不改 render pipeline、WebGL post stack、`src/libs/player/contracts.ts`。
- storyboard JSON 永远只含**内容**（title/subtitle/meta/clips/shots/elements/narration），**绝不**出现任何颜色、字体、时长、相机、转场、特效字段。
- 所有新增特效表达只进 `style.json`（`src/libs/player/styles/*.json`），由 `src/libs/player/style.ts` 的 `loadStyle`/`ExplainerStyleSchema`/`deepMergeStyle` 解析。

---

## 1. 现状基线（已核实的 ground truth）

### 1.1 代码路径

| 职责 | 文件:行 | 说明 |
|---|---|---|
| xhot storyboard 生成 | `src/modules/explainer-video/video.ts` ~150-300 `generateExplainerStoryboardFromXHot` | 组装 `systemPrompt`+`userPrompt` |
| 现有语气块（纪录片） | `video.ts` ~165-180 | "calm, steady, insightful, professional"，明令禁止 "sensationalist/theatrical/over-excited" |
| 共享生成器 + repair 循环 | `src/modules/explainer-video/produce.ts` ~395-505 `generateExplainerStoryboard` | `chat()` temperature 0.3；strict schema；effect 字段拒绝；PHRASE=EXCERPT 校验；`MAX_ATTEMPTS=3`，附 `repairNote` 重试，最后 `throw`（无 fallback） |
| effect 字段拒绝 | `produce.ts` `collectStoryboardEffectFields()` | storyboard 含 effect 字段即抛错 |
| PHRASE=EXCERPT 校验 | `src/libs/player/phrase.ts` `assertPhraseExcerpts()` / `collectPhraseExcerptErrors()` | phraseText 必须是 narration[i] 的连续逐字片段（忽略大小写/标点） |
| storyboard 形状/schema | `src/libs/player/contracts.ts` | 见 1.2 |
| 样式解析 | `src/libs/player/style.ts` | `loadStyle` / `ExplainerStyleSchema` / `deepMergeStyle` |
| 内置 preset | `src/libs/player/styles/{cyan-tech,ember-dark,apple-clean}.json` | |
| xhot 接线 | `src/pipelines/xhot/execute.ts` ~238 `createExplainerVideo(...)` | 传 ttsVoice/ttsRate/ttsInstruct/stylePreset/style/transition |
| xhot CLI 选项 | `src/pipelines/xhot/cli.ts` | `--tts-rate`(默认 `+0%`)、`--explainer-style`、`--explainer-transition`、`--explainer-subtitles` 等 |
| xhot 默认值 | `video.ts` `createExplainerVideo` ~320-337 | `ttsRate '+0%'`、`stylePreset 'preset:cyan-tech'`、`ttsInstruct 'authoritative tech news anchor ... broadcast-ready'` |
| 通用默认 | `produce.ts` `EXPLAINER_DEFAULTS.stylePreset = 'preset:ember-dark'` | 被 video.ts 用 cyan-tech 覆盖 |

**已核实的接线缺口**：`execute.ts` ~238 虽然传了 `options.ttsInstruct`，但 `cli.ts` 的 `baseOptions` **并未**定义 `ttsInstruct`，CLI 也没有对应选项 —— 因此 `--narrative` 的接线必须新增一条完整链路（见 B.3），不能假设已有通道。

### 1.2 storyboard 形状（硬约束）

```jsonc
{
  "title": "...", "subtitle": "...",
  "meta": { "title": "...", "subtitle": "..." },
  "clips": [{
    "id": "...", "kicker": "...", "title": "...", "subtitle": "...",
    "shots": [{
      "id": "...",
      "elements": [[phraseText, visualRef], ...],  // 顺序与 narration 1:1
      "narration": [sentence, ...]
    }]
  }]
}
```

- `elements.length === narration.length`（严格 1:1）。
- `phraseText` 必须是 `narration[i]` 的**连续逐字片段**（大小写/标点不敏感），否则 phrase reveal 时序错乱。
- `visualRef` ∈ { 真实 asset id, 合法 lucide 图标名, `'component:flash'` }。

### 1.3 最近一次真实运行基线

来源：`artifacts/xhot/xhot-1793936369904-35ibm1/10-explainer-storyboard.json`

| 指标 | 基线值 |
|---|---|
| chapters | 5 |
| shots | 10 |
| narration 行数 | 28 |
| 总词数 | 340 |
| 平均词/行 | 12.1 |
| 开场句 | "Today's X discussions are focused on rumors of a new OpenAI frontier model."（平铺概述，无 hook） |
| kickers | `00 · OVERVIEW` / `01 · WINNER` / `02 · COMMUNITY` / `03 · SHOWCASE` / `04 · PERSPECTIVE` |
| 典型病症 | 被动罗列（"One developer says ..."、"Another thread connects ..."） |

---

## A. 叙事：Fireship 化（逐文件）

> 全部改动集中在 `src/modules/explainer-video/video.ts` 的 `systemPrompt` 与 `userPrompt`（仅当 `narrative === 'fireship'` 时启用，见 B.3；`documentary` 保留今天的文案不变）。

### A.1 重写 systemPrompt 语气（video.ts ~165-180）

把现有"纪录片"语气块整体替换为 Fireship 语气块（仅 fireship 分支）。要点：

- **角色**：rapid-fire tech storyteller / 高信息密度解说。
- **句式**：short punchy sentences；deadpan wit（冷幽默）；opinionated but strictly factual；直接称呼 **"you"**；用 concrete numbers 与 contrasts；no filler、no throat-clearing。
- **保留的不可动规则**（原封不动带入新语气块）：
  - **no-fabrication**：每一个 claim 必须可回溯到 `evalResult`（winner summary / topCandidates / reasoning）或 `harvestResult` 的 tweets。禁止编造数字、基准、引用。
  - PHRASE=EXCERPT 规则说明（先写 narration，再从中切出 phrase）。
  - 内容/效果分离说明（脚本绝不描述颜色/字体/时序/相机/转场）。
  - `component:flash` 的用途说明。
- **删除**：所有 "calm/steady/insightful"、"smooth cohesive thoughtful"、"Bloomberg/Vox mini-documentary"、以及禁止 "exploded/insane/fever pitch" 的那段（这段与 Fireship 直接冲突）。
  - 注意边界：Fireship 允许"锐利、有张力"，但仍**禁止编造夸张事实**（如凭空说 "10x faster"）。禁令从"禁止夸张语气"改为"禁止无来源的夸张事实"。

### A.2 重写 narration / element 规则（userPrompt）

硬性写入：
- 每行 narration **5-9 词**（linter 以此为阈值，见 B.1）。
- 每个 shot **2-3 行**（flash 开场 shot 例外，单行）。
- **hook 必须落在前 1-2 行**（bold claim / 具体数字 / 反直觉对比）。
- **禁止**：`"Today's discussions ..."` 式开场；`"One developer says ..."` 式逐条罗列 tweets。
- **要求**：cause→effect 链接（每一行回答"so what?"）；concrete numbers；contrast；结尾给 verdict（观点判断）。

**GOOD / BAD 示例（必须满足 PHRASE=EXCERPT：短、逐字切片，不是改写）**：

```text
GOOD narration: "OpenAI dropped GPT-6.3 Sol overnight."
GOOD phrase:    "GPT-6.3 Sol overnight"            (narration 的连续逐字切片)

BAD  narration: "OpenAI dropped GPT-6.3 Sol overnight."
BAD  phrase:    "Sol launch shakes the market"     (词不在 narration 中 → 破坏时序)

GOOD narration: "Benchmarks put it 18% above Claude."
GOOD phrase:    "18% above Claude"

GOOD narration: "Devs are already shipping with it."
GOOD phrase:    "already shipping with it"

BAD  narration: "Today's discussions focus on a new model."   (禁开场句式)
GOOD narration: "Everyone thought the race was over."          (hook：反直觉)
GOOD phrase:    "the race was over"

GOOD narration: "Here's why that matters to you."
GOOD phrase:    "matters to you"
```

（示例数字仅为**格式演示**；实际生成时数字必须来自输入材料，linter 的 no-fabrication 不校验语义真伪，由 prompt 的 no-fabrication 规则 + 人工抽检保证。）

### A.3 kicker / title / subtitle 指南（含锚点）

- **kicker 锚点**（替换 OVERVIEW/WINNER/... 这类平淡词）：
  `00 · THE HYPE` / `01 · THE CLAIM` / `02 · DEVS REACT` / `03 · THE PROOF` / `04 · THE VERDICT`
  （4 章时去掉其一，优先保留 THE HYPE / THE CLAIM / THE PROOF / THE VERDICT）。
- **title / subtitle**：禁止 `"Analysis & Overview"`、`"Trending Overview"` 这类模板腔；要求短、带态度、点出 winner 名与一句话卖点（仍需事实可回溯）。
  - 坏：`"GPT-6.3 Sol: Analysis & Overview"`
  - 好：`"GPT-6.3 Sol: the model that broke X today"`（卖点须有来源）

### A.4 结构密度

| 维度 | fireship 目标 |
|---|---|
| chapters | 4-5 |
| shots | 12-15 |
| narration 行数 | 45-60 |
| Chapter 0 | **单个 flash-montage shot**，仅 1 行、最具爆点的那句，`visualRef: 'component:flash'` |

### A.5 素材使用（保持严格）

- 优先真实媒体（`*-image-*`、`*-video-*`）> 压缩截图（`*-shot`）。规则原样保留。
- `visualRef` 只能是真实 asset id、合法 lucide 图标、或 `'component:flash'`（strict schema 已强制，见 produce.ts）。

---

## B. 确定性约束（核心工程）

> prompt 文案不足以保证密度——必须有可度量、可触发 repair 的 linter。

### B.1 新模块：narrative linter

**路径**：`src/modules/explainer-video/narrative-lint.ts`

导出一个**纯函数**：

```ts
// 伪签名（实现时以实际类型为准）
export interface NarrativeThresholds {
  minWordsPerLine: number;      // default 5
  maxWordsPerLine: number;      // default 9
  minLines: number;             // default 45
  maxLines: number;             // default 60
  minShots: number;             // default 12
  maxShots: number;             // default 15
  minChapters: number;          // default 4
  maxChapters: number;          // default 5
  hookScanLines: number;        // default 2  (前 N 行内必须命中 hook)
  bannedPhrases: string[];      // 见下
  minNumberHits: number;        // 含数字/百分比的行数下限，default 3
}

export interface NarrativeMetrics {
  chapters: number; shots: number; lines: number; totalWords: number;
  avgWordsPerLine: number;
  linesOverMax: number; linesUnderMin: number;
  hookFound: boolean;
  bannedHits: { phrase: string; line: string }[];
  numberHits: number; contrastHits: number;
  phraseExcerptErrors: number; // 复用 collectPhraseExcerptErrors 的计数
}

export interface NarrativeViolation { code: string; message: string; }

export function lintNarrative(
  storyboard: ExplainerStoryboard,
  thresholds?: Partial<NarrativeThresholds>
): { metrics: NarrativeMetrics; violations: NarrativeViolation[] };
```

**度量项**：
- words/line（分词：按空白切，去标点）、line 总数、shot 数、chapter 数。
- **opening-hook check（可自动化定义）**：前 `hookScanLines` 行中，至少有一行满足以下任一：含阿拉伯数字或 `%`；或含对比词（`but/than/not/beats/vs/overnight/suddenly/everyone thought ...`）；且该行**不**以禁用开场式样匹配。
- **banned-phrase check**（大小写不敏感、子串匹配）：
  `"today's discussions"`, `"today's tech conversations"`, `"one developer says"`, `"another thread"`, `"in conclusion"`, `"it is worth noting"`, `"let's dive in"`, `"in this video"`, `"as we can see"`, `"reaches a fever pitch"`。
- **numbers/contrast density**：含数字的行数 ≥ `minNumberHits`；统计 contrast 词命中数（仅度量、不强制失败，供观察）。
- **verbatim-phrase integrity**：直接**复用** `collectPhraseExcerptErrors()`（`src/libs/player/phrase.ts`），把结果计入 `phraseExcerptErrors`，与 produce.ts 的 `assertPhraseExcerpts` 保持同一判定逻辑，避免双实现漂移。

**纯函数**：不读文件、不打日志、无副作用；全部阈值从入参来，便于单测。

### B.2 接入 repair 循环（produce.ts）

在 `generateExplainerStoryboard`（`produce.ts` ~460-490，strict 分支 `assertPhraseExcerpts` 之后、`return result.data` 之前）插入 linter 调用：

- 新增可选入参 `narrativeThresholds?: Partial<NarrativeThresholds>`（挂在 `GenerateExplainerStoryboardParams`）。**仅当传入该参数时**才执行 narrative lint —— documentary 分支不传即完全跳过，零行为变化。
- 若 `violations.length > 0`：`throw new Error(...)`，把违规摘要拼进错误信息 → 走**同一条** `repairNote` 重试路径（与 schema 错误共用 `MAX_ATTEMPTS=3`）。
- 一轮修复后仍违规 → 自然落到最后的 `throw lastError`。**不新增任何 fallback、不 catch-and-continue、不静默接受**。
- 错误信息格式要可直接作为 repair 指令，例如：
  `"narrative too sparse: avg 12.1 words/line (max 9); only 28 lines (need 45-60); banned phrase 'one developer says' at line X. Shorten each narration to 5-9 words, split into more shots, remove banned openings."`

阈值默认值在 `narrative-lint.ts` 内定义（见 B.1），由 `video.ts` 的 fireship 分支显式传入；documentary 分支不传。

### B.3 `--narrative` 选项接线（CLI → execute → video）

链路（逐文件）：

1. **`src/pipelines/xhot/cli.ts`**：`attachXHotOptions` 新增
   `.option('--narrative <mode>', 'Script narrative style: fireship | documentary', 'fireship')`
   并在 `baseOptions` 增加 `narrative: opts.narrative || 'fireship'`（**xhot 默认 fireship**）。
   同时新增 `ttsInstruct` 透传（当前缺口）：`ttsInstruct: opts.ttsInstruct`（如需 CLI 覆盖再加 `--tts-instruct`，可选）。
2. **`src/pipelines/xhot/contracts.ts`**（`XHotPipelineOptions`）：新增 `narrative?: 'fireship' | 'documentary'`。
3. **`src/pipelines/xhot/execute.ts`** ~238 `createExplainerVideo(...)`：新增 `narrative: options.narrative`。
4. **`src/modules/explainer-video/contracts.ts`**（`CreateExplainerVideoOptions`）：新增 `narrative?: 'fireship' | 'documentary'`（默认 fireship）。
5. **`src/modules/explainer-video/video.ts`**：
   - `createExplainerVideo` 解构 `narrative = 'fireship'`，透传给 `generateExplainerStoryboardFromXHot(evalResult, harvestResult, assets, narrative)`。
   - `generateExplainerStoryboardFromXHot` 增加 `narrative` 入参：
     - `'documentary'` → 保持**今天的** `systemPrompt`/`userPrompt` 原文不变，且**不**传 `narrativeThresholds`（linter 关闭）。
     - `'fireship'` → 使用 A.1-A.5 的新文案，并把 fireship 阈值传入 `generateExplainerStoryboard`。

**文档明确**：documentary 模式保证字节级不变，是回滚与兼容保底路径。

### B.4 单元测试

**路径**：`tests/narrative-lint.test.ts`（与现有 `tests/*.test.ts` 风格一致，`tsx --test`）。

覆盖：
- 阈值边界：words/line 恰好 5 / 9 / 10；行数 44 / 45 / 60 / 61。
- banned openings：命中各条禁用短语。
- phrase-excerpt 交互：构造一个 phraseText 非逐字切片的 fixture → `phraseExcerptErrors > 0`。
- fixture：一个**必过** fixture storyboard（fireship 合规）与一个**必败** fixture（基线式稀疏/罗列），断言 violations 分别为空 / 非空。
- 纯函数性质：同输入多次调用结果一致。

---

## C. 表现力（content/effect 分离不变）

### C.1 新 preset：`src/libs/player/styles/fireship.json`

`extends: "preset:cyan-tech"`，仅覆盖节奏/特效相关 knob。骨架：

```jsonc
{
  "version": "1",
  "extends": "preset:cyan-tech",
  "timing": {
    "titleHold": 0.7,     // ↓ 标题停留更短 → 整体更赶
    "titleOut": 0.4,
    "lineGap": 0.07,      // ↓ 行间停顿更短 → 语流更密
    "shotGap": 0.10,      // ↓ shot 间停顿更短
    "clipTail": 0.3,      // ↓ 章节尾部留白更短
    "shotDur": 3.8,       // 单 shot 时长 3.6-4.0 区间 → 更快切换
    "shotTrans": 0.55,    // 0.5-0.6 → 转场更利落
    "clipTrans": 0.7      // 章节转场更快（phraseLead 不覆盖，沿用默认 0.1，避免破坏 PHRASE 同步）
  },
  "components": {
    "flash": {
      "interval": 0.11,   // 0.10-0.12 → 蒙太奇切得更快
      "punch": 0.06,      // ↑ 每切的缩放冲击更强
      "shutter": 0.18
    }
  },
  "camera": { "mode": "auto-drift", "zoomRange": [1.0, 1.08], "rollMax": 0.015, "driftPx": 24 },
  "transitions": {
    "clip": {
      "mode": "sequence",
      "pool": ["emberBurn", "lumaGlitch", "directionalWarp"],
      "seed": 7
    }
  },
  "post": {
    "chromaticAberration": 0.12,  // 轻微色散 → 数码锐利感
    "contrast": 1.12              // 略升对比 → 画面更"冲"
  }
}
```

**每个 knob 的感知作用**：
- `titleHold/lineGap/shotGap/clipTail` 下调：消除"喘气感"，让解说像连珠炮。
- `shotDur` 3.8 + `shotTrans` 0.55：视觉切换频率提高，匹配 5-9 词短句的语速。
- `flash.interval` 0.11 + `punch` 0.06：开场蒙太奇更"炸"，强化 hook。
- `camera.driftPx`/`zoomRange` 微增：画面持续微动，避免静态呆板（但 `rollMax` 控制在 0.015 以内防眩晕）。
- `clip.pool` 换入 `emberBurn/lumaGlitch/directionalWarp`：punchy shader，节奏感强。
- `chromaticAberration` 0.12 + `contrast` 1.12：轻度数码质感，不过度（避免和 WebGL post 冲突）。

> 这些**全部**在 style.json，storyboard JSON 不受影响。`ExplainerStyleSchema` 与 `deepMergeStyle` 已支持这些 key（cyan-tech.json 已证实含 timing/flash/camera/transitions/post 同名字段）。

### C.2 xhot 默认值调整

仅改 `src/modules/explainer-video/video.ts` 的 `createExplainerVideo` 默认（且只在 fireship 下）：

| 字段 | 当前 | fireship 默认 | 备注 |
|---|---|---|---|
| `stylePreset` | `preset:cyan-tech` | `preset:fireship` | |
| `ttsRate` | `+0%` | `+12%` | edge-tts 失真风险；**回退值 `+8%` 是显式配置**（通过 `--tts-rate +8%` 手动指定），不是 code fallback |
| `ttsInstruct` | authoritative tech news anchor ... broadcast-ready | 重写为：fast, deadpan, high-energy tech-blogger delivery — crisp, confident, slightly wry; never mumbling | |

> `ttsRate` 不在代码里做"若 +12% 失败就自动降 +8%"的逻辑（那是隐藏问题的 fallback）。失真由验证阶段（E.1/D）发现，由人显式改配置。

### C.3 明确**不改**的部分及原因

- **render pipeline / WebGL post stack / renderer 选择**：表现力已通过 style.json 的 post/timing 达成，改渲染器会与既有 render 计划冲突、放大回归面。
- **`src/libs/player/contracts.ts`（storyboard schema）**：改它会破坏内容/效果分离铁律与现有校验。
- **`collectStoryboardEffectFields` 的拒绝名单**：保持严格，防止 effect 字段渗入 storyboard。

### C.4 可选 / 需开关

- `subtitleBanner`：shorts 场景可开（cyan-tech 已 `enabled:true`，fireship 继承即可）。通过 `--explainer-subtitles` 控制。
- per-chapter pacing：**可选**，但只能通过 style.json 的全局/章节级 timing 表达，**绝不**在 storyboard 里加 per-shot 特效字段。

---

## D. 验收标准（可度量，当前 vs 目标）

| 指标 | 当前 | 目标 | 自动化检查 |
|---|---|---|---|
| 平均词/行 | 12.1 | 5-9 | linter `avgWordsPerLine` ∈ [5,9] 且 `linesOverMax===0` |
| narration 行数 | 28 | 45-60 | linter `lines` ∈ [45,60] |
| shots | 10 | 12-15 | linter `shots` ∈ [12,15] |
| chapters | 5 | 4-5 | linter `chapters` ∈ [4,5] |
| 开场 hook | 无 | 前 2 行含 hook | linter `hookFound===true`（定义见 B.1） |
| banned-phrase | 多 | 0 | linter `bannedHits.length===0` |
| phrase 逐字切片 | — | 0 error | `phraseExcerptErrors===0`（复用 phrase.ts） |
| storyboard 内含 effect 字段 | 0 | 0 | `collectStoryboardEffectFields()===[]`（既有） |
| 每章预览渲染时长 | 基线 | 低于基线 | A/B：同内容分别用 cyan-tech vs fireship 渲染 chapter 0-1，比较 player timeline 产出的 `totalDurationSec`（见 E.4） |
| +12% TTS 可懂度 | — | 可懂、不失真 | 人工试听；可选 ASR 抽检（转写回原文比对） |

---

## E. 验证计划（脚本指标未达标前，不整片渲染）

### E.1 脚本级回归 harness

**路径**：`tools/diag-xhot-storyboard-metrics.ts`
（注意：`.gitignore` 第 55 行忽略了整个 `scripts/`，所以 diag 工具必须放 `tools/` 才会入库；`scripts/tmux-reminder.sh` 属于本地运维脚本，保持不入库。）

- 从**已有产物**读取输入：`artifacts/xhot/<run>/` 下的 `eval-result.json`、`harvest-result.json` 及 assets（复用 `buildExplainerAssets` 的输入或直接读已打包 assets）。
- 调用 `generateExplainerStoryboardFromXHot(..., 'fireship')` **N=3** 次（不渲染、不 TTS、不抓取 X），对每次输出跑 `lintNarrative`，打印指标表（chapters/shots/lines/avgWords/hook/banned/phraseErrors）。
- 运行命令（示例）：
  `npx tsx tools/diag-xhot-storyboard-metrics.ts --run artifacts/xhot/xhot-1793936369904-35ibm1 --n 3 --narrative fireship`
- **保留策略**：作为 diag 工具**保留**；其输出写入 `.tmp/` 或 `artifacts/diag/`，并把这些输出路径加入 `.gitignore`（脚本本身入库，生成数据不入库）。

### E.2 单元测试

`npm run test:all`（`tsx --test`）须全绿，含 B.4 新增用例。

### E.3 chapter 0-1 短预览渲染（命名 tmux）

- 仅渲染前两章做人工观感/时长核对，**必须**在命名 tmux 会话中运行长任务：
  - 启动：`tmux new -s xhot-preview -d 'npx tsx tools/diag-xhot-storyboard-metrics.ts ... && <render chapter 0-1 的命令>'`
  - 查看：`tmux attach -t xhot-preview`
  - 结束：`tmux kill-session -t xhot-preview`
- 报告中必须写出 session name 与 attach/kill 命令。渲染完成后**立即 kill**，清理所有子进程。

### E.4 A/B 对比

- 同一份**已通过 linter 的 storyboard**，分别用 `--explainer-style preset:cyan-tech` 与 `preset:fireship` 渲染 chapter 0-1。
- 比较：player timeline 的 `totalDurationSec`（更短即更快）与人工感知节奏；记录 TTS `+12%` vs `+8%` 的可懂度差异。

---

## F. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| `+12%` edge-tts 失真 | E.4 试听 + 可选 ASR 抽检 | 显式 `--tts-rate +8%`；或把 fireship 默认改回 `+8%`（一行 revert） |
| phrase-sync 破坏 | linter 复用 `collectPhraseExcerptErrors`，与 `assertPhraseExcerpts` 同逻辑 | 若破坏来自 prompt 松动，收紧 userPrompt GOOD/BAD 示例 |
| LLM 忽视密度规则 | linter 进 repair 循环（核心保障） | 调整阈值或 repairNote 措辞；documentary 兜底 |
| 生成变慢 / repair 轮次增加 | `MAX_ATTEMPTS=3` 不变，一轮修复后硬失败 | 若频繁失败说明 prompt 不达标，回 documentary 并调 prompt |
| fireship.json 与 WebGL post 冲突 | 仅微调 post（CA 0.12 / contrast 1.12），不碰 renderer | revert `fireship.json` 新增文件 |
| 默认切换影响既有脚本 | documentary 模式字节级不变 | `git revert` preset 默认切换与 `--narrative` 默认；保留 documentary 分支 |

**整体回滚**：所有改动集中在新文件（`narrative-lint.ts`、`fireship.json`、测试、diag 脚本）+ 少量 prompt/默认/接线改动；`git revert` 相关 commit 即可恢复到纪录片行为。

---

## G. 实施顺序（分阶段，每阶段独立可验证）

> 编码前先把本计划写入 `Docs/`（已完成）。每阶段 DoD = Definition of Done。

**Phase 1 — Linter（纯函数 + 测试）**
- 文件：新增 `src/modules/explainer-video/narrative-lint.ts`、`tests/narrative-lint.test.ts`、`tools/diag-xhot-storyboard-metrics.ts`（Phase 1 先落 linter，diag 工具随 Phase 3 落地）。
- DoD：`npm run test:all` 全绿；linter 对必过/必败 fixture 判定正确；无副作用。

**Phase 2 — 接入 repair 循环**
- 文件：`src/modules/explainer-video/produce.ts`（新增可选 `narrativeThresholds`，strict 分支末尾调用 linter → 违规 throw 进 repairNote）。
- DoD：传入阈值时违规会触发重试并最终 throw（无 fallback）；不传阈值时行为与现在字节级一致（已有测试 + documentary 冒烟）。

**Phase 3 — Fireship prompt + `--narrative` 接线**
- 文件：`src/modules/explainer-video/video.ts`（systemPrompt/userPrompt fireship 分支 + 透传阈值）、`contracts.ts`（CreateExplainerVideoOptions.narrative）、`src/pipelines/xhot/{cli.ts,contracts.ts,execute.ts}`（`--narrative` 默认 fireship + ttsInstruct 透传）。
- DoD：`tools/diag-xhot-storyboard-metrics.ts --narrative fireship` 跑通，指标表达到 D 的目标；`--narrative documentary` 产出与基线同风格且 linter 关闭。

**Phase 4 — 表现力 preset + 默认值**
- 文件：新增 `src/libs/player/styles/fireship.json`；`video.ts` fireship 默认 `preset:fireship` / `ttsRate +12%` / 新 `ttsInstruct`。
- DoD：`loadStyle('preset:fireship')` 解析通过（`ExplainerStyleSchema`）；E.3 chapter 0-1 预览在命名 tmux 跑通并清理；E.4 A/B 显示 fireship 时长更短。

**Phase 5 — 全链路验收 + 文档/gitignore**
- 文件：`.gitignore`（加 diag 输出目录）；本计划勾选验收结果。
- DoD：D 表全部达标；无遗留 tmux/子进程；diag 输出不入库。

---

## H. 编码纪律（贯穿全程，必须遵守）

- **NO fallback that hides problems**：不加隐藏默认、不 catch-and-continue、不"失败就降级"。`ttsRate` 回退是**显式人工配置**而非代码兜底。
- **测试后清理所有进程**：预览/渲染/benchmark 一律在**命名 tmux 会话**内运行，完成后 `tmux kill-session`，报告 session 名与 attach/kill 命令。
- **先写计划再开发**：本 md 已先行落入 `Docs/`。
- **生成数据/输出加入 `.gitignore`**：diag 脚本入库，其输出（`.tmp/`、`artifacts/diag/`）不入库。
- **长任务必在命名 tmux 会话**：禁止在前台跑 dev server / watch / 整片渲染。
- **定时自检**：已安装 crontab `*/30 * * * * /mnt/share/VM/AIGC-pipeline/scripts/tmux-reminder.sh`，每 30 分钟把 `tmux ls` + 各会话 idle 秒数追加到 `.tmp/tmux-status.log`（仅提醒，不杀进程）。开发期间先 `tail -40 .tmp/tmux-status.log` 再决定是否 attach/kill。
