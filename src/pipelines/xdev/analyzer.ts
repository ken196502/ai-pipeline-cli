import pc from 'picocolors';
import path from 'node:path';
import { chat } from '../../libs/llm/client.js';

import { OperationalWarningError, type ExtractedTweet } from './contracts.js';
import type { FirefoxBiDiDriver } from './bidi-driver.js';
import { formatHistoryForPrompt, type XDevHistoryEntry } from './history.js';
import { buildHeaderBannerSvg, buildArchitectureSvg, buildSequenceSvg } from './svg-builder.js';

export { buildHeaderBannerSvg, buildArchitectureSvg, buildSequenceSvg };

export interface SelectedTopicAnalysis {
  tweet: ExtractedTweet;
  topicTitle: string;
  topicTitleEn?: string;
  sourceIdentityZh: string;
  corePerspectiveZh: string;
  articleSummaryZh?: string;
}

export interface CandidateScore {
  index: number;
  score: number;
  verdictZh: string;
}

export interface TweetEvaluationResult {
  selectedTopics: SelectedTopicAnalysis[];
  executiveSummaryZh: string;
  articleTitle: string;
  crossTopicTransitionZh?: string;
  rejectionNotesZh: string[];
  /** Per-candidate scores emitted by the reviewer (may be absent for older runs). */
  candidateScores?: CandidateScore[];
  /**
   * `scored`: the reviewer picked a candidate on the first scoring pass.
   * `forced-best-available`: the first pass returned no selection, so a second
   * pass was required to rank the batch and take the most informative tweet.
   */
  selectionMode: 'scored' | 'forced-best-available';
  selectionNoteZh?: string;
}

/** Renders the candidate pool handed to the reviewer. */
export function buildCandidateList(tweets: ExtractedTweet[]): string {
  return tweets
    .map((t, idx) => {
      return `[候选 #${idx}]
作者: ${t.authorName} (${t.authorHandle})
推文链接: ${t.url}
阅读量: ${t.views != null ? t.views.toLocaleString() : '未知'}
外链: ${t.externalLinks.join(', ') || '无'}
推文原句:
${t.text.replace(/\n+/g, ' ').slice(0, 2000)}
---`;
    })
    .join('\n\n');
}

/**
 * Hard disqualifiers. Only these may justify selecting nothing at all —
 * "not hardcore enough" is explicitly NOT a reason to reject a whole batch
 * (that rule is what made two consecutive runs die with no artifacts).
 */
const HARD_DISQUALIFIER_RULES = `仅以下四类内容判为 0 分并淘汰（除此之外不得整条否决）：
   A. 发币 / 空投 / Token 带单 / 收益或财富承诺；
   B. 纯产品公测或招募广告，全文没有任何机制、数据或失败经验说明；
   C. 纯单一模型的版本发布、改名、API 字段、计费调整、输出水印、合规声明，且不含任何 Agent 工程内容；
   D. 与 AI / 软件工程完全无关的内容（娱乐、时政、生活日常）。`;

const SCORING_RUBRIC = `评分维度（总分 100，按权重打分后排序）：
   1. 工程实质（40 分）：是否给出可复用的机制、协议、数据结构、调度/状态方案、失败模式或量化数据；只有口号与形容词的给低分。
   2. 题材相关性（30 分）：与 AI Agent 工程直接相关，包括多智能体协同与编排、工具调用、上下文与记忆管理、任务分发与调度、评测与回归、沙箱与容错、成本与延迟优化、生产落地复盘。宽口径接收，不要求必须是“硬核多智能体”。
   3. 可验证性（20 分）：是否附带外链长文、论文、GitHub 仓库、benchmark 或可查证的一手数据。
   4. 新颖度（10 分）：是否提供往期清单里没有出现过的具体机制、问题或数据。`;

function buildScoringPrompt(candidateList: string, history: XDevHistoryEntry[]): string {
  return `你是一名资深的 AI Agent 系统架构师与技术审稿人，负责为技术专栏挑选本期唯一主选题。

任务：对下面从 X (Twitter) 抓取的候选推文逐条打分排序，并选出信息量与工程价值最高的 1 条（若第二条高度互补且分数接近，最多再选 1 条）。

${SCORING_RUBRIC}

${HARD_DISQUALIFIER_RULES}

【强制：必须择优】
   - 只要存在任何一条未被上述 A/B/C/D 命中的候选，就【必须】选出其中得分最高者作为主选题，禁止输出空选，禁止使用停止词。
   - “不够硬核”“不够完美”“角度不够颠覆”都不是否决理由；本期只需要当前候选中工程信息量最高的那一条。
   - 只有在全部候选都被 A/B/C/D 命中时，才允许输出 {"selectedIndices": []}。

【关键：主标题必须高度概括核心工程机制与结论，拒绝长流水账】：
   - 标题必须具备清晰的逻辑结构与概括性，兼顾“核心技术/机制/痛点”与“关键解法/工程结论”。
   - 严禁写成毫无概括性的流水账报菜名（例如错误示例：“某某的 A 用某某清单退回 B，八轮未清就转人工”）。
   - 正确示范结构：“多智能体协同的返工闭环：结构化退回清单与有限重试熔断” 或 “规避 Agent 虚假通过：基于 Must-fix 清单的收敛协议”。
   - 只能概括被选中推文及其外链文章真正涉及的工程事实：推文里没有的大厂、论文、数字一律不得出现在标题里。严禁使用“告别黑盒利维坦”、“从 X 一线看”等泛化套路标题，也严禁套用「已写过清单」里的标题句式。严禁机翻直译外文法律/合规名词。
【风格与小标题规范】：
   - 小标题务必简炼干脆：直接概括该章节的核心工程动作或机制（例如“任务分发采用优先级队列”、“状态验证要求结构化清单闭环”），拒绝冗长拖沓的流水账。
   - 严禁前置否定与辩白套话：禁止通篇使用“它解决的不是……而是……”、“这并非……而是……”等句式，小标题中也绝对禁止出现此类辩白。
   - 有问题直接说问题机制，有方案直接描述实现与约束，直截了当。
   - 拒绝“正如大家所知”、“毫无疑问”等虚词套话。
全文所有解析、观点剖析必须全部使用纯地道专业【中文】输出！
【历史去重（强制）】：「已写过清单」里的推文禁止再次选择；清单里的标题句式、论证结构与结论禁止复用；同一个信源的同一个论点不得换个说法再写一遍。
【与历史区隔（强制）】：本期必须给出一个清单里没出现过的具体工程问题、机制或数据，而不是复述旧结论。

已写过清单（最近 8 期，禁止重复）：
${formatHistoryForPrompt(history)}

候选列表：
${candidateList}

输出格式必须为合法 JSON（不要包含 markdown 代码块包裹）：
{
  "selectedIndices": [0],
  "candidateScores": [{"index": 0, "score": 78, "verdictZh": "该候选的工程实质与淘汰/入选理由（中文，一句话）"}],
  "articleTitle": "高度概括的核心技术博文主标题（直击机制与解法，结构清晰有逻辑，拒绝流水账，不套大厂）",
  "executiveSummaryZh": "精炼生动的中文核心观点提要",
  "topics": [
    {
      "index": 0,
      "topicTitle": "该议题的核心技术论断（中文）",
      "topicTitleEn": "Concise engineering topic phrase in English (for diagrams and visual asset generation)",
      "sourceIdentityZh": "客观中立的信源身份定位",
      "corePerspectiveZh": "作者的核心工程主张与深入拆解（纯中文，绝不包含'其背后的工程分析非常尖锐'等废话，直接说事实、机制与数据）"
    }
  ],
  "rejectionSummaryZh": ["未入选推文的具体原因（中文）"]
}`;
}

/**
 * Second-chance prompt: the batch already failed the scoring pass, so this one
 * removes the "reject everything" escape hatch entirely and demands a ranking.
 */
function buildForcedChoicePrompt(
  candidateList: string,
  history: XDevHistoryEntry[],
  firstPassReason: string
): string {
  return `你是一名资深 AI Agent 系统架构师与技术审稿人。上一轮评审因为「${firstPassReason}」没有产出选题，本期必须从候选池中强制择优，产出 1 条主选题（最多 2 条互补）。

【强制择优规则】
   1. 对每条候选按下列维度打分，然后选出总分最高者：
${SCORING_RUBRIC}
   2. ${HARD_DISQUALIFIER_RULES}
   3. 只有全部候选都命中 A/B/C/D 时，才允许 selectedIndices 为空；否则【必须】给出 selectedIndices 与完整 topics。
   4. 即使候选整体质量一般，也要选出信息量最高、最能写出具体机制与失败细节的那一条；用工程细节把文章写扎实，而不是靠拒绝来回避。

文章标题与小标题规范（强制）：
   - 主标题必须概括被选推文真正涉及的核心机制与工程结论，严禁流水账报菜名，严禁泛化套路标题，严禁出现推文里没有的大厂、论文或数字。
   - 小标题直接说机制与动作，禁止“它不是……而是……”这类辩白句式。
   - 全文解析必须使用纯地道专业中文。
   - 「已写过清单」里的推文禁止再次选择，标题句式与结论禁止复用。

已写过清单（最近 8 期，禁止重复）：
${formatHistoryForPrompt(history)}

候选列表：
${candidateList}

输出格式必须为合法 JSON（不要包含 markdown 代码块包裹）：
{
  "selectedIndices": [0],
  "candidateScores": [{"index": 0, "score": 65, "verdictZh": "打分与理由（中文，一句话）"}],
  "articleTitle": "概括核心机制与解法的主标题",
  "executiveSummaryZh": "精炼的中文核心观点提要",
  "topics": [
    {
      "index": 0,
      "topicTitle": "该议题的核心技术论断（中文）",
      "topicTitleEn": "Concise engineering topic phrase in English (for diagrams and visual asset generation)",
      "sourceIdentityZh": "客观中立的信源身份定位",
      "corePerspectiveZh": "核心工程主张与拆解（中文，直接说事实、机制与数据）"
    }
  ],
  "rejectionSummaryZh": ["未入选推文的具体原因（中文）"]
}`;
}

interface SelectionAttempt {
  parsed: any | null;
  rejected: boolean;
  raw: string;
}

/** One reviewer round-trip. Malformed JSON is a hard error (not a policy rejection). */
async function requestSelection(prompt: string, task: string): Promise<SelectionAttempt> {
  const res = await chat({
    messages: [{ role: 'user', content: prompt }],
    context: { stage: 'xdev', task },
    timeoutMs: 120_000,
    // Selection is mechanical ranking over an already-filtered pool; letting the
    // model think here cost 13 minutes and ~1 MB of reasoning per round-trip.
    thinking: false,
  });

  const raw = res.content.trim();
  if (/STOP:\s*NO_SUITABLE_CANDIDATES/i.test(raw)) {
    return { parsed: null, rejected: true, raw };
  }

  const cleanJson = raw.replace(/```json\n?|\n?```/g, '').trim();
  const parsed = JSON.parse(cleanJson);
  return { parsed, rejected: false, raw };
}

function isEmptySelection(parsed: any): boolean {
  return !parsed || !Array.isArray(parsed.selectedIndices) || parsed.selectedIndices.length === 0;
}

function parseCandidateScores(parsed: any): CandidateScore[] | undefined {
  if (!Array.isArray(parsed?.candidateScores)) return undefined;
  const scores: CandidateScore[] = [];
  for (const item of parsed.candidateScores) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0) continue;
    const score = Number(item?.score);
    scores.push({
      index,
      score: Number.isFinite(score) ? score : 0,
      verdictZh: typeof item?.verdictZh === 'string' ? item.verdictZh.trim() : '',
    });
  }
  return scores.length ? scores : undefined;
}

/**
 * Stage 2: LLM Reviewer Evaluation
 *
 * Policy: score-and-rank, then take the best candidate. A whole-batch rejection
 * is only legitimate when every candidate is spam/coin-shilling/unrelated; if
 * the first pass still returns nothing, one forced-choice pass runs before the
 * pipeline gives up, and the run records `selectionMode` so the choice is never
 * silently downgraded.
 */
export async function evaluateAndSelectCoreThemes(
  tweets: ExtractedTweet[],
  history: XDevHistoryEntry[] = []
): Promise<TweetEvaluationResult> {
  console.log(pc.cyan(`\n[Stage 2/7] LLM 审稿人正在对 ${tweets.length} 条候选推文打分排序...`));

  const candidateList = buildCandidateList(tweets);

  try {
    let selectionMode: TweetEvaluationResult['selectionMode'] = 'scored';
    let selectionNoteZh: string | undefined;

    const firstPass = await requestSelection(buildScoringPrompt(candidateList, history), 'tweet-eval-selection');
    let parsed = firstPass.parsed;

    if (firstPass.rejected || isEmptySelection(parsed)) {
      const firstPassReason = firstPass.rejected ? '输出停止词 STOP: NO_SUITABLE_CANDIDATES' : 'selectedIndices 为空';
      console.warn(
        pc.yellow(`\n⚠ 首轮评审未产出选题（${firstPassReason}），改用强制择优提示词重试一次...`)
      );
      const forcedPass = await requestSelection(
        buildForcedChoicePrompt(candidateList, history, firstPassReason),
        'tweet-eval-selection-forced'
      );
      parsed = forcedPass.parsed;
      selectionMode = 'forced-best-available';
      selectionNoteZh = `首轮评审${firstPassReason}，已用强制择优提示词重试`;

      if (forcedPass.rejected || isEmptySelection(parsed)) {
        const reasons = parsed?.rejectionSummaryZh?.join('；') || '未给出详细原因';
        console.warn(pc.yellow(`\n🛑 强制择优后仍未选出主题（候选 ${tweets.length} 条全部被判无价值）: ${reasons}`));
        throw new OperationalWarningError(
          `LLM 审稿人判定当期 ${tweets.length} 条候选全部无价值（发币/纯广告/与 AI 无关）: ${reasons}`
        );
      }
    }

    const validIndices: number[] = Array.isArray(parsed.selectedIndices) ? parsed.selectedIndices.slice(0, 2) : [];
    const candidateScores = parseCandidateScores(parsed);
    const selectedTopics: SelectedTopicAnalysis[] = [];
    if (!parsed.articleTitle || !String(parsed.articleTitle).trim()) {
      throw new Error('LLM 选题结果缺少 articleTitle');
    }
    if (!parsed.executiveSummaryZh || !String(parsed.executiveSummaryZh).trim()) {
      throw new Error('LLM 选题结果缺少 executiveSummaryZh');
    }

    // No fallbacks: a missing field used to be silently replaced with canned
    // Anthropic prose, which is exactly how every article ended up "about
    // Anthropic" regardless of the selected tweet.
    const REQUIRED_TOPIC_FIELDS = [
      'topicTitle',
      'sourceIdentityZh',
      'corePerspectiveZh',
    ] as const;

    for (const idx of validIndices) {
      const tweet = tweets[idx];
      if (!tweet) throw new Error(`LLM 返回的 selectedIndices 含越界索引 ${idx}（候选共 ${tweets.length} 条）`);

      const topicInfo = parsed.topics?.find((t: any) => t.index === idx) || parsed.topics?.[0];
      if (!topicInfo) throw new Error(`LLM 未给出索引 ${idx} 的议题内容`);

      const missing = REQUIRED_TOPIC_FIELDS.filter(
        (field) => typeof topicInfo[field] !== 'string' || !topicInfo[field].trim()
      );
      if (missing.length) {
        throw new Error(`LLM 选题结果缺少必需字段: ${missing.join(', ')}（禁止兜底填充）`);
      }

      const topicTitleEn = typeof topicInfo.topicTitleEn === 'string' && topicInfo.topicTitleEn.trim()
        ? topicInfo.topicTitleEn.trim()
        : undefined;

      selectedTopics.push({
        tweet,
        topicTitle: topicInfo.topicTitle.trim(),
        topicTitleEn,
        sourceIdentityZh: topicInfo.sourceIdentityZh.trim(),
        corePerspectiveZh: topicInfo.corePerspectiveZh.trim(),
      });
    }

    // One article, one source tweet. The reviewer may return two indices, but the
    // second topic only fed `crossTopicTransitionZh` (no consumer) while letting
    // the title/summary blend two unrelated theses. Keep the higher-view tweet.
    if (selectedTopics.length > 1) {
      const ranked = [...selectedTopics].sort((a, b) => (b.tweet.views ?? 0) - (a.tweet.views ?? 0));
      const keep = ranked[0];
      for (const dropped of ranked.slice(1)) {
        console.log(
          pc.dim(
            `  • 丢弃次要选题 [${dropped.tweet.authorHandle}] views=${dropped.tweet.views ?? '?'}（保留 [${keep.tweet.authorHandle}] views=${keep.tweet.views ?? '?'}）`
          )
        );
      }
      selectedTopics.length = 0;
      selectedTopics.push(keep);
    }

    if (candidateScores) {
      const ranked = [...candidateScores].sort((a, b) => b.score - a.score).slice(0, 5);
      console.log(pc.dim('  • 打分前五名：'));
      for (const s of ranked) {
        const tweet = tweets[s.index];
        console.log(
          pc.dim(`    - #${s.index} ${s.score} 分 @${tweet?.authorHandle || '?'}: ${s.verdictZh.slice(0, 80)}`)
        );
      }
    }

    console.log(pc.green(`  ✔ LLM 选定 ${selectedTopics.length} 个核心研讨主题（${selectionMode}）:`));
    for (const t of selectedTopics) {
      console.log(pc.dim(`    • [${t.tweet.authorHandle}] ${t.topicTitle}`));
    }

    return {
      selectedTopics,
      articleTitle: parsed.articleTitle,
      executiveSummaryZh: parsed.executiveSummaryZh,
      crossTopicTransitionZh: parsed.crossTopicTransitionZh,
      rejectionNotesZh: parsed.rejectionSummaryZh || [],
      candidateScores,
      selectionMode,
      selectionNoteZh,
    };
  } catch (err: any) {
    if (err instanceof OperationalWarningError) throw err;
    console.error(pc.red(`  ✗ LLM 候选推文评审解析失败，严格 Fail-Fast: ${err?.message || err}`));
    throw new Error(`LLM evaluation failed to produce valid structure: ${err?.message || err}`);
  }
}


/**
 * Stage 3: Targeted deep fetch of articles for the selected tweet.
 */
export async function fetchSelectedArticles(
  selectedTopics: SelectedTopicAnalysis[],
  driver: FirefoxBiDiDriver
): Promise<void> {
  console.log(pc.cyan(`\n[Stage 3/7] 定向深度抓取已选推文的长文内容...`));

  for (const item of selectedTopics) {
    const urls = item.tweet.externalLinks;
    if (!urls || urls.length === 0) continue;

    for (const link of urls.slice(0, 2)) {
      try {
        console.log(`  🔗 定向解析外链: ${link}...`);
        const article = await driver.fetchArticleContent(link);
        if (article.content && article.content.length > 50) {
          item.tweet.blogs.push({
            url: link,
            title: article.title,
            content: article.content,
            excerpt: article.excerpt,
          });
          item.articleSummaryZh = article.excerpt || article.content.slice(0, 300);
          console.log(pc.green(`    ✔ 成功提取文章: "${article.title}" (${article.content.length} 字)`));
          break;
        }
      } catch (err: any) {
        console.warn(pc.yellow(`    ⚠ 解析失败 ${link}: ${err?.message || err}`));
      }
    }
  }
}

/**
 * Stage 5: Deterministic SVG diagram wrappers
 */
export async function generateSvgArchitectureDiagram(topicTitle: string): Promise<string> {
  return buildArchitectureSvg(topicTitle);
}

export async function generateSvgSequenceDiagram(topicTitle: string): Promise<string> {
  return buildSequenceSvg(topicTitle);
}

/**
 * Stage 6: LLM-written technical article, grounded strictly in the material that
 * was actually collected for the selected tweet.
 *
 * History note: this function used to be a hardcoded Anthropic essay with a few
 * string interpolations, so every run produced an "Anthropic" article no matter
 * which tweet was selected (the LLM's own headings were never used). Any static
 * prose here is a bug — the only things this function may contribute are the
 * collected material, the assets, and the front matter.
 */
export async function synthesizeFocusedArticle(options: {
  evalResult: TweetEvaluationResult;
  svgArchitecture: string;
  svgSequence: string;
  headerImagePath?: string;
  grokEnrichmentText?: string;
  history?: XDevHistoryEntry[];
}): Promise<string> {
  const primary = options.evalResult.selectedTopics[0];
  if (!primary) throw new Error('[article] 没有选中的议题，无法成稿');

  const material = buildArticleMaterial(primary, options.grokEnrichmentText);
  const historyBlock = formatHistoryForPrompt(options.history || []);

  const prompt = `You are a distinguished distributed systems architect and technical writer. Based strictly on the provided technical materials, write a deep, rigorous, logical, and beautifully crafted technical analysis essay.

## CRITICAL LANGUAGE REQUIREMENT:
- The ENTIRE article MUST be written 100% in fluent, professional, idiomatically natural ENGLISH.
- Every section heading, body paragraph, and analytical argument must be in English.

## Main Title
# ${options.evalResult.articleTitle}

## Core Topic & Primary Source
- Topic: ${primary.topicTitle}
- Tweet Author: ${primary.tweet.authorName} (@${primary.tweet.authorHandle})
- Tweet Source URL: ${primary.tweet.url}
- Core Thesis: ${primary.corePerspectiveZh}

## Material (Sole source of factual truth, do not fabricate outside this material)
${material}

## Structure & Narrative Guidelines:
1. **Opening: Context, Hook & Problem Intro (Executive Lead)**
   - The publisher automatically places an initial quote block, but in your lead introduction paragraph, explicitly introduce the problem space and cite the source author's observation along with their original tweet link as Markdown.
   - Example citation format: "As pointed out by [${primary.tweet.authorName} (@${primary.tweet.authorHandle})](${primary.tweet.url}), ...".
   - Ground the reader immediately in the engineering scenario: who is building what, where does the architecture choke or drift, and what fundamental constraint forces a redesign.
2. **Body: Friction → Root-Cause Mechanisms → Architectural Solution & Trade-offs**
   - Use at least 3 distinct H2 headings (## Heading). Keep headings crisp, informative, and engineering-driven.
   - For every section, build a causal chain: describe the real system symptom, isolate the exact failure mode (which state component, retry loop, or consistency boundary breaks), analyze the underlying constraint, and explain the architecture solution with its technical trade-offs.
   - Whenever referring to insights, findings, or code from the source tweet or linked reports, naturally embed markdown hyperlinks back to the source (e.g. [${primary.tweet.authorName}'s post](${primary.tweet.url}) or relevant linked articles).
   - Avoid hand-wavy statements like "the problem is obvious" or "it faces huge challenges" without immediately specifying the exact data, throughput, or concurrency failure mode.
3. **Closing: Synthesis & Engineering Takeaways**
   - Provide a final H2 section (e.g. "## Architectural Takeaways and Pragmatic Rollout") that synthesizes lessons learned, operational invariants, and practical advice for engineering teams.
   - Close cohesively without introducing disjointed new facts.

## Formatting & Style:
- **Tone**: Authoritative, pragmatic, clear, and direct. Avoid hollow corporate fluff, buzzwords, or defensive clichés (e.g., avoid "it's not X, but rather Y").
- **Visuals Layout**: Naturally place the following layout placeholders within the article body:
  - After the lead introduction: \`{{HEADER_IMAGE}}\`
  - In the core architectural mechanism section: \`{{SVG_ARCH}}\`
  - In the execution flow or sequence interaction section: \`{{SVG_SEQ}}\`
- **Source Links**: Do not append a separate standalone reference list at the very end; the publisher generates the final bibliography block automatically. However, **inline citations in the prose MUST include markdown links to the original tweet: [${primary.tweet.authorName} on X](${primary.tweet.url})**.

Output ONLY the markdown content of the article (no markdown code fence wrapper around the whole document).

## FINAL REMINDER (violations fail validation and force a rewrite)
1. Every sentence — including the H1 title, every H2 heading and every quote — must be ENGLISH. Chinese characters anywhere in the output are rejected.
2. Cite exactly ONE tweet: [${primary.tweet.authorName} on X](${primary.tweet.url}). Do not introduce, mention or link any other tweet or author handle.
3. The first line must be an English H1 title starting with a single hash and a space.`;

  const problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await chat({
      messages: [
        {
          role: 'user',
          content:
            attempt === 1
              ? prompt
              : `${prompt}\n\n（上一次输出未通过校验：${problems.join('；')}。请严格按结构与素材重写。）`,
        },
      ],
      context: { stage: 'xdev', task: 'article-synthesis' },
      timeoutMs: 180_000,
      // Thinking is off here on purpose. `reasoning_effort` cannot bound it:
      // measured over 3 samples each, "low" ranged 402-2776 reasoning chars
      // while the no-parameter baseline ranged 757-1439, i.e. variance swamps
      // the setting. With thinking left on, this single call once ran 26 minutes
      // / 138k reasoning chars auditing its own draft sentence by sentence
      // ("Potential issue: … Good.") and never converged.
      thinking: false,
    });

    const body = stripCodeFence(res.content);
    const issues = validateArticleBody(body, material);
    if (issues.length === 0) {
      return assembleArticle(body, {
        articleTitle: options.evalResult.articleTitle,
        summary: options.evalResult.executiveSummaryZh,
        headerImagePath: options.headerImagePath,
        svgArchitecture: options.svgArchitecture,
        svgSequence: options.svgSequence,
      });
    }
    problems.push(`第 ${attempt} 次: ${issues.join('、')}`);
    console.warn(pc.yellow(`  ⚠ [article] 第 ${attempt} 次成稿不合规: ${issues.join('、')}`));
  }

  throw new Error(`[article] LLM 连续两次未产出合规正文（禁止用模板兜底）: ${problems.join(' | ')}`);
}

/** Everything the writer is allowed to know about. */
export function buildArticleMaterial(topic: SelectedTopicAnalysis, grokEnrichmentText?: string): string {
  const parts: string[] = [];
  parts.push(
    `### 推文原文\n作者: ${topic.tweet.authorName} (${topic.tweet.authorHandle})\n链接: ${topic.tweet.url}\n${topic.tweet.text}`
  );

  topic.tweet.blogs.forEach((blog, i) => {
    parts.push(
      `### 外链文章 ${i + 1}: ${blog.title || blog.url}\nURL: ${blog.url}\n${(blog.content || '').slice(0, 6000)}`
    );
  });

  if (grokEnrichmentText && grokEnrichmentText.trim()) {
    const rawGrok = grokEnrichmentText.trim();
    const isDegradedGrok =
      /Shared links could not be loaded/i.test(rawGrok) ||
      /Try again\s+Ask anything/i.test(rawGrok) ||
      /upgrade your account/i.test(rawGrok) ||
      rawGrok.length < 60;
    if (!isDegradedGrok) {
      parts.push(`### Grok 联网研究补充\n${rawGrok.slice(0, 4000)}`);
    }
  }
  return parts.join('\n\n');
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** Grounding and basic safety check. Keeps rules minimal and non-intrusive. */
export function validateArticleBody(body: string, material: string): string[] {
  const issues: string[] = [];

  if (!body || body.trim().length < 80) {
    issues.push('正文内容过少或为空 (Article body too short or empty)');
  }

  // Anti-template gate: if the material never mentions Anthropic, the article must not hallucinate it
  if (!/anthropic/i.test(material) && /anthropic/i.test(body)) {
    issues.push('正文出现素材中不存在的 Anthropic 引用（疑似套用旧模板）');
  }

  // Anti-false-dichotomy gate: detect excessive "not X but Y" clichés in either language
  const notInsteadMatches = body.match(
    /不是[^，。\n]+，?而是|并非[^，。\n]+，?而是|it is not[^,\.\n]+,\s*but rather/gi
  );
  if (notInsteadMatches && notInsteadMatches.length > 2) {
    issues.push(
      `正文包含过多“不是…而是…”前置否定套话（共发现 ${notInsteadMatches.length} 处：${notInsteadMatches.slice(0, 3).join('、')}）。请直接正面陈述事实。`
    );
  }

  // Vague-assertion gate
  const vagueAssertionPattern =
    /[^。！？\n]*?(?:痛点|难点|问题|挑战|矛盾|瓶颈)(?:很|非常|极其|十分|相当)(?:直接|明确|明显|突出|巨大|尖锐|清楚|扎手|典型)[^。！？\n]*[。！？]/g;
  const vagueAssertions = Array.from(body.matchAll(vagueAssertionPattern))
    .map((m) => m[0].trim())
    .filter((s) => s.replace(/\s/g, '').length <= 20);
  if (vagueAssertions.length > 0) {
    issues.push(
      `正文出现谜语式空断言（${vagueAssertions.slice(0, 3).join('、')}）：提到痛点/难点必须当场说清具体是什么（哪个环节、哪份状态、什么后果），禁止只下一句评语就翻篇。`
    );
  }

  // Structure gate: the article must be sectioned and must close with a
  // conclusion.
  const headingMatches = Array.from(body.matchAll(/^##\s+(.+)$/gm));
  if (headingMatches.length < 2) {
    issues.push(`小标题过少（${headingMatches.length} 个），必须至少 3 个 H2 分节`);
  } else {
    const lastHeading = headingMatches[headingMatches.length - 1];
    const lastHeadingAt = (lastHeading.index || 0) / Math.max(1, body.length);
    if (lastHeadingAt < 0.55) {
      issues.push('缺少独立的收尾小节：最后一个 H2 出现过早，正文后半段没有总结收敛');
    }
  }

  // Language gate: the article must be English. The prompt already demands it, but
  // one run still produced a fully Chinese article (11-26) because nothing
  // verified the output language. Measured on CJK ratio so a stray Chinese quote
  // of a source term does not fail the run.
  const cjkChars = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonSpaceChars = body.replace(/\s/g, '').length;
  if (nonSpaceChars > 0 && cjkChars / nonSpaceChars > 0.05) {
    issues.push(
      `正文不是英文（CJK 字符 ${cjkChars}/${nonSpaceChars}，占比 ${((cjkChars / nonSpaceChars) * 100).toFixed(1)}%）：全文含标题与小标题必须为英文`
    );
  }

  const firstHeadingIdx = body.search(/^##\s+/m);
  if (firstHeadingIdx > 0) {
    const intro = body.slice(0, firstHeadingIdx).replace(/^#\s+.*$/m, '').trim();
    if (intro.length < 60) {
      issues.push('首段导读过短：标题之后、第一个小标题之前必须有交代背景与问题的导读段落');
    }
  }

  return issues;
}

function assembleArticle(
  rawBody: string,
  meta: {
    articleTitle: string;
    summary: string;
    headerImagePath?: string;
    svgArchitecture: string;
    svgSequence: string;
  }
): string {
  const dateStr = new Date().toISOString().split('T')[0];
  let body = rawBody.trim();

  // Ensure title at the beginning
  if (!body.startsWith('# ')) {
    body = `# ${meta.articleTitle}\n\n${body}`;
  }

  const headerMd = meta.headerImagePath
    ? `![Multi-Agent Architecture Header](./${path.basename(meta.headerImagePath)})`
    : '';

  // Header image placeholder
  if (body.includes('{{HEADER_IMAGE}}')) {
    body = body.replace('{{HEADER_IMAGE}}', headerMd);
  }

  // Insert clean header without rigid academic metadata
  const lines = body.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('# '));
  const frontMatter: string[] = [''];
  if (meta.headerImagePath && !body.includes(path.basename(meta.headerImagePath))) {
    frontMatter.push(headerMd, '');
  }
  if (frontMatter.length > 1) {
    lines.splice(titleIdx + 1, 0, ...frontMatter);
  }
  body = lines.join('\n');

  // Insert SVG diagrams (replace placeholder or append naturally)
  if (body.includes('{{SVG_ARCH}}')) {
    body = body.replace('{{SVG_ARCH}}', `\n\n${meta.svgArchitecture}\n\n`);
  } else {
    const h2Idx = body.indexOf('## ');
    if (h2Idx !== -1) {
      const nextLine = body.indexOf('\n', h2Idx);
      body = body.slice(0, nextLine) + `\n\n${meta.svgArchitecture}\n\n` + body.slice(nextLine);
    } else {
      body += `\n\n${meta.svgArchitecture}\n\n`;
    }
  }

  if (body.includes('{{SVG_SEQ}}')) {
    body = body.replace('{{SVG_SEQ}}', `\n\n${meta.svgSequence}\n\n`);
  } else {
    body += `\n\n${meta.svgSequence}\n\n`;
  }

  return body.replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}
