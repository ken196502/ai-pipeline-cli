import pc from 'picocolors';
import path from 'node:path';
import { chat } from '../../libs/llm/client.js';

import { OperationalWarningError, type ExtractedTweet } from './contracts.js';
import type { FirefoxBiDiDriver } from './bidi-driver.js';
import { formatHistoryForPrompt, type XDevHistoryEntry } from './history.js';
import {
  buildHeaderBannerSvg,
  buildArchitectureSvg,
  buildSequenceSvg,
  generateArchitectureSvgFromArticle,
  generateSequenceSvgFromArticle,
} from './svg-builder.js';
import {
  PRACTICE_COLLISION_POINTS,
  getCollisionPoint,
  selectCollisionPointId,
  DEFAULT_COLLISION_POINT_ID,
} from './practice-collision.js';

export {
  buildHeaderBannerSvg,
  buildArchitectureSvg,
  buildSequenceSvg,
  generateArchitectureSvgFromArticle,
  generateSequenceSvgFromArticle,
};

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

/**
 * Weights of the final selection score.
 *
 * Views are the audience's verdict, so they carry the same weight as content:
 * `final = 0.5 × content(0-100) + 0.5 × views(0-100, log-scaled)`.
 * Change these two constants to re-balance the policy — nothing else encodes it.
 */
export const CONTENT_WEIGHT = 0.5;
export const VIEW_WEIGHT = 0.5;

export interface RankedCandidate {
  index: number;
  /** Reviewer's content score (0-100). */
  contentScore: number;
  /** Log-scaled views, 0-100 relative to the batch maximum. */
  viewScore: number;
  finalScore: number;
}

/**
 * Log-scaled 0-100 view score relative to the batch maximum.
 *
 * Linear scaling would let a single outlier flatten everyone else to ~0;
 * log10 keeps 25k vs 3.1M meaningful (~68 vs 100) while still rewarding
 * order-of-magnitude gaps.
 */
export function viewScoreOf(views: number, maxViews: number): number {
  if (!(views > 0) || !(maxViews > 0)) return 0;
  const denom = Math.log10(1 + maxViews);
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(100, (100 * Math.log10(1 + views)) / denom));
}

/**
 * Combines the reviewer's content scores with audience reach and ranks the pool.
 *
 * Candidates the reviewer scored 0 (hard disqualifiers: shilling, pure ads,
 * unrelated) are excluded; candidates the reviewer did not score are left out
 * rather than being treated as zero.
 */
export function rankCandidates(
  tweets: ExtractedTweet[],
  candidateScores: CandidateScore[],
  weights: { content?: number; views?: number } = {}
): RankedCandidate[] {
  const contentWeight = weights.content ?? CONTENT_WEIGHT;
  const viewWeight = weights.views ?? VIEW_WEIGHT;
  const maxViews = tweets.reduce((max, t) => Math.max(max, t.views ?? 0), 0);
  const scored = new Map(candidateScores.map((s) => [s.index, s.score]));

  return tweets
    .map((tweet, index) => {
      const contentScore = scored.get(index);
      if (contentScore === undefined || contentScore <= 0) return null;
      const viewScore = viewScoreOf(tweet.views ?? 0, maxViews);
      return {
        index,
        contentScore,
        viewScore,
        finalScore: contentWeight * contentScore + viewWeight * viewScore,
      };
    })
    .filter((row): row is RankedCandidate => row !== null)
    .sort((a, b) => b.finalScore - a.finalScore);
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
  selectionMode: 'scored' | 'forced-best-available' | 'view-weighted';
  selectionNoteZh?: string;
}

/** Renders the candidate pool handed to the reviewer. */
export function buildCandidateList(tweets: ExtractedTweet[]): string {
  return tweets
    .map((t, idx) => {
      const articleBody = (t.blogs?.[0]?.content || '').trim();
      const typeLine = t.isXArticle
        ? `类型: X 原生长文（Article）${articleBody ? '，正文已预取' : '，正文未预取（仅标题）'}`
        : '类型: 普通推文';
      const linkLine = t.externalLinks.join(', ') || (t.isXArticle ? `无（原生长文: ${t.articleUrl || t.url}）` : '无');
      const bodyBlock = articleBody
        ? `\n长文正文（前 1500 字）:\n${articleBody.slice(0, 1500)}`
        : '';
      return `[候选 #${idx}]
作者: ${t.authorName} (${t.authorHandle})
推文链接: ${t.url}
${typeLine}
阅读量: ${t.views != null ? t.views.toLocaleString() : '未知'}
外链: ${linkLine}
推文原句:
${t.text.replace(/\n+/g, ' ').slice(0, 2000)}${bodyBlock}
---`;
    })
    .join('\n\n');
}

/** Minimal shape needed to pre-fetch an article body (browser driver or a test double). */
export interface ArticleFetcher {
  fetchArticleContent(url: string): Promise<{ title: string; content: string; excerpt: string }>;
}

/**
 * Pre-fetches the body of native X Article candidates BEFORE the reviewer scores
 * them.
 *
 * The timeline card carries only the article title, so a 3.1M-view deep dive and
 * a one-line post looked identical to the reviewer — measured 2026-11-06, the
 * highest-view candidate of "Agent system" lost the scoring pass for exactly
 * that reason. Bodies are fetched newest-engagement-first and bounded, so the
 * stage cost stays predictable.
 */
export async function hydrateArticleCandidates(
  tweets: ExtractedTweet[],
  fetcher: ArticleFetcher,
  options: { limit?: number; minChars?: number } = {}
): Promise<{ hydrated: number; failed: number; skipped: number }> {
  const limit = options.limit ?? 8;
  const minChars = options.minChars ?? 200;
  const candidates = tweets.filter((t) => t.isXArticle && t.articleUrl);
  const targets = candidates
    .filter((t) => (t.blogs?.length ?? 0) === 0)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, limit);
  const skipped = candidates.length - targets.length;

  if (targets.length === 0) return { hydrated: 0, failed: 0, skipped };

  console.log(
    pc.cyan(
      `  • 预取 ${targets.length} 条 X 原生长文正文（供审稿人评分，按阅读量取前 ${limit} 条${skipped > 0 ? `，${skipped} 条超出预算` : ''}）...`
    )
  );

  let hydrated = 0;
  let failed = 0;
  for (const tweet of targets) {
    const url = tweet.articleUrl!;
    try {
      console.log(pc.dim(`    🔗 ${url} (${(tweet.views ?? 0).toLocaleString()} views)`));
      const article = await fetcher.fetchArticleContent(url);
      const content = (article.content || '').trim();
      if (content.length < minChars) {
        failed += 1;
        console.warn(pc.yellow(`      ⚠ 正文仅 ${content.length} 字符（< ${minChars}），该候选仍以标题参与评分`));
        continue;
      }
      // The X article page <title> is just "X"; fall back to the post text
      // (which is the article headline on Article cards).
      const pageTitle = (article.title || '').trim();
      const title = pageTitle && pageTitle.toLowerCase() !== 'x' ? pageTitle : tweet.text.replace(/^Article\s*/i, '').slice(0, 120);
      tweet.blogs.push({
        url,
        title: title || undefined,
        content: content.slice(0, 4000),
        excerpt: article.excerpt || content.slice(0, 300),
      });
      hydrated += 1;
      console.log(pc.green(`      ✔ ${content.length} 字符: "${title.slice(0, 60)}"`));
    } catch (err) {
      failed += 1;
      console.warn(pc.yellow(`      ⚠ 预取失败 ${url}: ${(err as Error).message}`));
    }
  }
  console.log(pc.dim(`  • 长文正文预取结果: ${hydrated} 成功 / ${failed} 失败 / ${skipped} 超预算`));
  return { hydrated, failed, skipped };
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
   3. 可验证性（20 分）：是否附带外链长文、X 原生长文正文（已预取时计入）、论文、GitHub 仓库、benchmark 或可查证的一手数据。
   4. 新颖度（10 分）：是否提供往期清单里没有出现过的具体机制、问题或数据。`;

function buildScoringPrompt(candidateList: string, history: XDevHistoryEntry[]): string {
  return `你是一名资深的 AI Agent 系统架构师与技术审稿人，负责为技术专栏挑选本期唯一主选题。

任务：对下面从 X (Twitter) 抓取的候选推文逐条打分排序，并选出信息量与工程价值最高的 1 条（若第二条高度互补且分数接近，最多再选 1 条）。

${SCORING_RUBRIC}

【计分口径】你只负责内容分（0–100）。最终选题由系统按「内容 ${Math.round(
    CONTENT_WEIGHT * 100
  )}% + 阅读量热度 ${Math.round(VIEW_WEIGHT * 100)}%」加权决定：阅读量已在候选列表中给出，你无需自行换算，
selectedIndices 仅作参考（系统会取加权后综合分最高者）。所以请把内容分打准——尤其不要把
「只有标题的 X 原生长文」当成无内容（长文正文已随候选附上）。

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

/**
 * Prints the content/view/final breakdown so the choice is auditable from the
 * run log ("why was this tweet the source?").
 */
function logRanking(tweets: ExtractedTweet[], ranking: RankedCandidate[]): void {
  console.log(
    pc.cyan(
      `  • 综合得分（内容 ${Math.round(CONTENT_WEIGHT * 100)}% + 阅读量热度 ${Math.round(VIEW_WEIGHT * 100)}%）前五名：`
    )
  );
  for (const row of ranking.slice(0, 5)) {
    const tweet = tweets[row.index];
    console.log(
      pc.dim(
        `    - #${row.index} 综合 ${row.finalScore.toFixed(1)}（内容 ${row.contentScore.toFixed(0)} / 热度 ${row.viewScore.toFixed(0)} / ${(tweet?.views ?? 0).toLocaleString()} views）@${tweet?.authorHandle ?? '?'}`
      )
    );
  }
}

/**
 * Second pass used when the view-weighted ranking disagrees with the reviewer's
 * own pick: the winner is already decided by the stated formula, so the model
 * only writes the topic fields for that candidate. It must not re-select.
 */
function buildLockedSelectionPrompt(
  candidateList: string,
  history: XDevHistoryEntry[],
  winner: RankedCandidate,
  ranking: RankedCandidate[],
  tweets: ExtractedTweet[]
): string {
  const tweet = tweets[winner.index];
  const table = ranking
    .slice(0, 8)
    .map(
      (row) =>
        `#${row.index} @${tweets[row.index]?.authorHandle ?? '?'} 内容 ${row.contentScore.toFixed(0)} / 热度 ${row.viewScore.toFixed(0)} / 综合 ${row.finalScore.toFixed(1)}`
    )
    .join('\n');

  return `你是一名资深 AI Agent 系统架构师与技术审稿人。本期主选题已由系统按「内容 ${Math.round(
    CONTENT_WEIGHT * 100
  )}% + 阅读量热度 ${Math.round(VIEW_WEIGHT * 100)}%」加权锁定，禁止改选。

【已锁定主选题】候选 #${winner.index} —— ${tweet?.authorName ?? ''} (${tweet?.authorHandle ?? ''})，${(
    tweet?.views ?? 0
  ).toLocaleString()} views

【综合得分表】
${table}

你的任务：只为候选 #${winner.index} 产出 articleTitle / executiveSummaryZh / topics。
   - selectedIndices 必须是 [${winner.index}]，topics[0].index 必须是 ${winner.index}。
   - candidateScores 可省略；若给出，索引与分数必须与上表一致。
   - 标题必须概括该候选（含已附长文正文）真正涉及的机制与结论；推文与正文里没有的大厂、论文、数字一律不得出现。
   - 小标题直接说机制与动作，禁止“它不是……而是……”这类辩白句式。
   - 全文解析必须使用纯地道专业中文。
   - 「已写过清单」里的推文禁止选择，标题句式与结论禁止复用。

已写过清单（最近 8 期，禁止重复）：
${formatHistoryForPrompt(history)}

候选列表：
${candidateList}

输出格式必须为合法 JSON（不要包含 markdown 代码块包裹）：
{
  "selectedIndices": [${winner.index}],
  "articleTitle": "概括核心机制与解法的主标题",
  "executiveSummaryZh": "精炼的中文核心观点提要",
  "topics": [
    {
      "index": ${winner.index},
      "topicTitle": "该议题的核心技术论断（中文）",
      "topicTitleEn": "Concise engineering topic phrase in English (for diagrams and visual asset generation)",
      "sourceIdentityZh": "客观中立的信源身份定位",
      "corePerspectiveZh": "核心工程主张与拆解（中文，直接说事实、机制与数据）"
    }
  ]
}`;
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

    let validIndices: number[] = Array.isArray(parsed.selectedIndices) ? parsed.selectedIndices.slice(0, 2) : [];
    let candidateScores = parseCandidateScores(parsed);

    // Views are the audience's verdict: the final pick is the content score
    // combined with reach, not the reviewer's raw favourite. When the reviewer
    // disagrees with that formula, the winner is locked and the reviewer only
    // writes the topic fields for it (no silent downgrade to a cold post).
    if (candidateScores) {
      const ranking = rankCandidates(tweets, candidateScores);
      if (ranking.length > 0) {
        logRanking(tweets, ranking);
        const winner = ranking[0];
        const llmPick = validIndices[0];
        if (winner.index !== llmPick) {
          console.log(
            pc.yellow(
              `  • 阅读量加权改判：LLM 初选 #${llmPick} → 综合最高 #${winner.index}` +
                `（内容 ${winner.contentScore.toFixed(0)} / 热度 ${winner.viewScore.toFixed(0)} / 综合 ${winner.finalScore.toFixed(1)}）`
            )
          );
          const locked = await requestSelection(
            buildLockedSelectionPrompt(candidateList, history, winner, ranking, tweets),
            'tweet-eval-selection-view-weighted'
          );
          const lockedIndex = Array.isArray(locked.parsed?.selectedIndices)
            ? Number(locked.parsed.selectedIndices[0])
            : NaN;
          if (locked.rejected || lockedIndex !== winner.index) {
            throw new Error(
              `阅读量加权锁定候选 #${winner.index}（综合 ${winner.finalScore.toFixed(1)}）后，` +
                `LLM 未按锁定索引产出选题（返回 selectedIndices=${JSON.stringify(locked.parsed?.selectedIndices ?? null)}）；` +
                '拒绝静默回退到低热度候选'
            );
          }
          parsed = locked.parsed;
          validIndices = [winner.index];
          selectionMode = 'view-weighted';
          selectionNoteZh =
            `阅读量加权改判：候选 #${winner.index}（内容 ${winner.contentScore.toFixed(0)} + 热度 ${winner.viewScore.toFixed(0)} = ${winner.finalScore.toFixed(1)}）` +
            ` 取代 LLM 初选 #${llmPick}`;
        }
      }
    }

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
 * Stage 5: Contextually generated SVG diagram wrappers.
 * Now derived directly from the synthesized article body for 100% semantic grounding.
 */
export async function generateSvgArchitectureDiagram(context: {
  topicTitle: string;
  articleTitle: string;
  articleBody: string;
  creativeSparks?: string;
}): Promise<string> {
  return generateArchitectureSvgFromArticle(context);
}

export async function generateSvgSequenceDiagram(context: {
  topicTitle: string;
  articleTitle: string;
  articleBody: string;
  creativeSparks?: string;
}): Promise<string> {
  return generateSequenceSvgFromArticle(context);
}

export interface CreativeSparkAnalysis {
  hasMeaningfulFit: boolean;
  /** Id of the single practice-collision point chosen for this article. */
  selectedCollisionPointId: string;
  fitPoints: string;
  tweetRelevance: string;
  conflictOrAlignment: string;
  resolutionOrSynergy: string;
  rawText: string;
}

/**
 * Stage 3.5: Sparks & Practice Collision Pass (Pre-Grok)
 * Because reasoning/thinking is turned off for throughput and convergence,
 * this pass explicitly executes structured thinking by colliding the selected tweet
 * with the author's real-world engineering practice (see `practice-collision.ts` POOL).
 *
 * IMPORTANT: the collision points are the operator's PERSONAL experience/recommendation,
 * never a claim made by the source tweet. The LLM must select the SINGLE most relevant
 * point for this tweet (not pile them all on) and clearly separate "what the tweet says"
 * from "what I have learned in practice".
 *
 * If the topic is an independent or isolated area where genuine synergy is absent,
 * the reviewer explicitly marks `hasMeaningfulFit: false`, allowing the pipeline to
 * gracefully proceed based purely on the original tweet and materials without forced analogies.
 *
 * Four analytical dimensions:
 * 1. 是否有契合点 (Alignment / Intersection Points)
 * 2. 推文相关内容 (Direct Tweet & Material Relevance)
 * 3. 跟所选实践是否冲突或合拍 (Tension or Harmony with Selected Practice Collision Point)
 * 4. 如何解决冲突或结合提升 (Conflict Resolution, Architectural Synthesis & Synergy)
 */
export async function generateCreativeSparkInsights(options: {
  topicTitle: string;
  corePerspectiveZh: string;
  tweetAuthor: string;
  tweetUrl: string;
  material: string;
}): Promise<CreativeSparkAnalysis> {
  const sparkPrompt = `你是一名顶级分布式与多智能体系统（Multi-Agent System）架构师。
由于推理引擎未开启内部深思考，你需要显式执行结构化深度思考，评估并将以下选定的核心议题与推文素材，同「作者（我）的工程实践经验」进行碰撞。

【重要框定】以下候选实践碰撞点全部是作者（我）在多个生产流水线里沉淀下来的个人工程经验与建议，**绝不是**源推文本身的主张。你在碰撞时必须明确区分"推文讲了什么"与"我的实践心得是什么"。

【候选实践碰撞点池】请先通读全部候选点，再为本期推文/议题选取【唯一一个】最契合的碰撞点（输出其 id），并只针对该点做四维碰撞——不要堆砌全部。
${PRACTICE_COLLISION_POINTS.map((p) => `• [${p.id}] ${p.titleZh}\n  ${p.experienceStatementZh}`).join('\n')}

【待碰撞的选题与素材】
议题: ${options.topicTitle}
核心观点: ${options.corePerspectiveZh}
信源推文: ${options.tweetAuthor} (${options.tweetUrl})

素材内容:
${options.material}

【实事求是碰撞原则（严禁生搬硬套）】：
- 如果本期推文主题与该实践确有深刻的底层机制交集（例如涉及多智能体协同、状态管理、注意力衰减、工具调度、回归测试、执行漂移等），请深入碰撞，提炼出真正的架构灵感。
- **如果没有明显的契合点或强行联系显得牵强，请实事求是判定为“无显著契合点”，绝不要强行拉郎配或生搬硬套，流水线将完全遵循推文本身的事实与技术逻辑正常推进。**

【输出格式规范】：
第一行必须明确输出结论标识：
\`契合度结论: [有契合点] 或 [无显著契合点]\`

第二行必须明确输出你选定的碰撞点 id（取自上述点池，例如 git-cli-repo / existing-infra / shared-workspace-not-memory）：
\`selectedCollisionPointId: <id>\`

随后根据实际情况输出以下四个维度的剖析（若无显著契合点，简要说明推文本身关注的核心技术领域，并说明为何不宜强行牵扯）：
## 1. 契合点分析 (Core Intersection Points)
## 2. 推文核心技术映射 (Tweet Technical Substance)
## 3. 实践冲突与合拍度辨析 (Tension & Harmony with Selected Practice Collision Point)
## 4. 冲突解决与结合提升方案 (Architectural Synergy & Elevation)`;

  try {
    const res = await chat({
      messages: [{ role: "user", content: sparkPrompt }],
      context: { stage: "xdev", task: "creative-spark-pre-grok" },
      timeoutMs: 120_000,
      thinking: false,
    });
    const text = res.content.trim();

    const hasMeaningfulFit =
      !/契合度结论\s*:\s*\[?无显著契合点\]?/i.test(text) &&
      !/没有契合点|缺乏直接关联|无需强行结合|无需强行拉郎配/i.test(text.slice(0, 200));

    const extractSection = (headingRegex: RegExp, nextHeadingRegex: RegExp): string => {
      const start = text.search(headingRegex);
      if (start === -1) return "";
      const slice = text.slice(start);
      const next = slice.search(nextHeadingRegex);
      return (next !== -1 ? slice.slice(0, next) : slice).replace(headingRegex, "").trim();
    };

    const fitPoints = extractSection(/##\s*1\..*?\n/i, /##\s*2\./i);
    const tweetRelevance = extractSection(/##\s*2\..*?\n/i, /##\s*3\./i);
    const conflictOrAlignment = extractSection(/##\s*3\..*?\n/i, /##\s*4\./i);
    const resolutionOrSynergy = extractSection(/##\s*4\..*?\n/i, /$/);

    const selectedCollisionPointId = hasMeaningfulFit
      ? selectCollisionPointId(text, options.topicTitle)
      : DEFAULT_COLLISION_POINT_ID;

    return {
      hasMeaningfulFit,
      selectedCollisionPointId,
      fitPoints: fitPoints || text.slice(0, 300),
      tweetRelevance: tweetRelevance || "",
      conflictOrAlignment: conflictOrAlignment || "",
      resolutionOrSynergy: resolutionOrSynergy || "",
      rawText: text,
    };
  } catch (err: any) {
    console.warn(pc.yellow(`  ⚠ [spark] 灵感碰撞阶段调用异常 (${err?.message || err})，将完全按推文原始素材推进`));
    return {
      hasMeaningfulFit: false,
      selectedCollisionPointId: DEFAULT_COLLISION_POINT_ID,
      fitPoints: "",
      tweetRelevance: "",
      conflictOrAlignment: "",
      resolutionOrSynergy: "",
      rawText: "",
    };
  }
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
  creativeSparks?: CreativeSparkAnalysis;
  grokEnrichmentText?: string;
  history?: XDevHistoryEntry[];
}): Promise<string> {
  const primary = options.evalResult.selectedTopics[0];
  if (!primary) throw new Error('[article] 没有选中的议题，无法成稿');

  const material = buildArticleMaterial(primary, options.grokEnrichmentText);
  const historyBlock = formatHistoryForPrompt(options.history || []);

  const hasSparks = Boolean(options.creativeSparks?.hasMeaningfulFit && options.creativeSparks?.rawText);
  const selectedPoint = getCollisionPoint(options.creativeSparks?.selectedCollisionPointId || DEFAULT_COLLISION_POINT_ID);
  const creativeSparksBlock = hasSparks
    ? `## Architectural Insights & Practice Collision (${selectedPoint?.titleEn ?? 'Engineering Practice'}):
${options.creativeSparks!.rawText}
`
    : '';

  const collisionInstruction = hasSparks
    ? `   - **Crucial Creative Collision — Author's Personal Engineering Practice (Anchor & Pivot)**: ${selectedPoint ? selectedPoint.synthesisLensEn.replace('{{EXPERIENCE_EN}}', selectedPoint.experienceStatementEn) : ''}
     * Contrast the tweet's mechanisms directly against this practice.
     * Frame the entire engineering resolution through your hands-on experience (e.g., 'In my own production architectures, I found...').
     * The entire second half of the essay must progressively build toward this practice collision as the definitive architectural solution.`
    : `   - **Critical Engineering Critique — The Trap of LLM Omnipresence & Structured Sandbox Execution**:
     * Approach the topic with sharp technical skepticism: critique the widespread industry anti-pattern of attempting to let an LLM dynamically orchestrate and arbitrate everything. When a single LLM model or unconstrained conversational loop attempts to handle brainstorming, multi-step planning, tool selection, and code execution simultaneously, it invariably collapses into state corruption, context bloat, hallucination spirals, and chaotic failure modes.
     * Frame your authoritative personal engineering stance:
       1. **Strict Context Isolation**: Decouple ideation/brainstorming/planning entirely from concrete execution.
       2. **AI Workflow/Pipeline & Structured Context**: Concrete execution must be governed by an explicit **AI workflow/pipeline** feeding **strictly structured context** (typed schemas, isolated state contracts, explicit step inputs/outputs).
       3. **Sandbox Execution**: Code and tool invocations must execute inside an **isolated sandbox environment** with zero leak of conversational noise or ephemeral intermediate prompt clutter.
     * Articulate this from your personal stance as an architect: 'In my production architectures, I strictly reject letting an LLM orchestrate everything. I enforce context isolation between ideation and execution, driving implementation through deterministic AI pipelines and structured context within an isolated sandbox...'`;

  const closingInstruction = hasSparks
    ? `   - **STRICT REQUIREMENT — Converge and Close on the Practice Collision**: The final concluding section MUST anchor and finish exclusively on this practice collision point (${selectedPoint?.titleEn ?? 'Author\'s Practice'}).
     * DO NOT diverge, introduce new speculative topics, or drift into generic platitudes.
     * Explain why this specific engineering practice is the decisive architectural anchor that turns fragile prototypes into durable production systems.
     * Deliver your authoritative verdict as an individual expert and state the concrete first step teams must take to adopt this exact pattern.`
    : `   - **STRICT REQUIREMENT — Converge and Close on AI Pipeline, Structured Context & Sandbox Execution**:
     * The final concluding section MUST definitively converge and finish on the architecture of **Strict Context Isolation + Deterministic AI Pipelines with Structured Context running in an Isolated Sandbox**.
     * DO NOT diverge or drift into generic platitudes or unrelated tooling trivia.
     * Reiterate your sharp verdict: letting LLMs orchestrate all system boundaries dynamically is doomed to chaotic failure; deterministic AI workflows, typed structured context, and sandbox execution are the only viable path to production reliability.
     * Deliver your concrete verdict as an individual architect and state the single first step engineering teams should take to enforce this boundary (e.g., replace freeform agentic loops with structured pipeline stages running inside isolated execution sandboxes).`;

  const prompt = `You are a distinguished solo software architect and individual technical practitioner writing an authoritative personal technical essay. Based strictly on the provided technical materials${hasSparks ? ' and your personal engineering practice' : ''}, write a deep, rigorous, logical, and beautifully crafted technical analysis essay.

## CRITICAL NARRATIVE VOICE & PERSONA (Strict Rule: Solo Practitioner):
- **You are a solo expert engineer, NOT a corporate committee, research institute, or editorial board.**
- **Use singular first-person pronouns ("I", "my", "in my testing", "my recommendation") whenever expressing opinions, engineering decisions, or architectural analyses.**
- **STRICTLY FORBIDDEN: Do NOT use the editorial "we", "our", or "us" to refer to yourself or your thoughts.** (Only use "we" if quoting an external company like "Anthropic states that 'we built...'").
- Write with the authentic, sharp, grounded voice of a veteran builder who has actually shipped production code.

## CRITICAL LANGUAGE REQUIREMENT:
- The ENTIRE article MUST be written 100% in fluent, professional, idiomatically natural ENGLISH.
- Every section heading, body paragraph, and analytical argument must be in English.

## Main Title
# ${options.evalResult.articleTitle}

## Core Topic & Sources
- Topic: ${primary.topicTitle}
- Core Thesis: ${primary.corePerspectiveZh}
${
  primary.tweet.blogs && primary.tweet.blogs.length > 0
    ? `- Primary Canonical Source/Article: "${primary.tweet.blogs[0].title || 'Original Engineering Guide'}" at ${primary.tweet.blogs[0].url}`
    : ''
}
- Industry Discussion Trigger: Tweet by ${primary.tweet.authorName} (@${primary.tweet.authorHandle}) at ${primary.tweet.url}

## Material (Sole source of factual truth, do not fabricate outside this material)
${material}

${creativeSparksBlock}
## Structure & Narrative Guidelines:
1. **Opening: Ultra-Concise Executive Hook (Strictly 2 Sentences Maximum)**
   - **DO NOT write a long essay or bloated block of text for the introduction.** The lead intro before {{HEADER_IMAGE}} / the first H2 section MUST be concise and to the point.
   - **Sentence 1 (Problem & Attribution)**: In exactly one crisp sentence, articulate the core technical problem/thesis and ground it with proper canonical attribution (linking the primary guide/paper and noting the trigger tweet by [${primary.tweet.authorName} (@${primary.tweet.authorHandle})](${primary.tweet.url})).
   - **Sentence 2 (Immediate Transition)**: In exactly one punchy sentence, state what this analysis dissects and launch directly into the technical deep-dive below.
   - **Total intro length**: Maximum 2 sentences. No filler, no rambling background padding.
2. **Body: Friction → Root-Cause Mechanisms → Architectural Solution & Trade-offs**
   - Use at least 3 distinct H2 headings (## Heading). Keep headings crisp, informative, and engineering-driven.
   - For every section, build a causal chain: describe the real system symptom, isolate the exact failure mode (which state component, retry loop, or consistency boundary breaks), analyze the underlying constraint, and explain the architecture solution with its technical trade-offs.
   - Whenever referring to insights, findings, or benchmarks from the primary source or reports, embed markdown hyperlinks directly to the source article.
${collisionInstruction}
   - Avoid hand-wavy statements like "the problem is obvious" or "it faces huge challenges" without immediately specifying the exact data, throughput, or concurrency failure mode.
3. **Closing: Synthesis & Engineering Takeaways**
   - Provide a final H2 section (e.g. "## Architectural Takeaways and Pragmatic Rollout") that synthesizes lessons learned, operational invariants, and practical advice for engineering teams.
${closingInstruction}
   - Close cohesively without introducing disjointed new facts.

## Formatting & Style:
- **Tone**: Authoritative, pragmatic, clear, and direct. Avoid hollow corporate fluff, buzzwords, or defensive clichés (e.g., avoid "it's not X, but rather Y").
- **Visuals Layout**: Naturally place the following layout placeholders within the article body:
  - After the lead introduction: \`{{HEADER_IMAGE}}\`
  - In the core architectural mechanism section: \`{{SVG_ARCH}}\`
  - In the execution flow or sequence interaction section: \`{{SVG_SEQ}}\`
- **Source Links**: Do not append a separate standalone reference list at the very end; the publisher generates the final bibliography block automatically. Always link primary canonical articles and the discussing tweet inline where appropriate.

Output ONLY the markdown content of the article (no markdown code fence wrapper around the whole document).

## FINAL REMINDER (violations fail validation and force a rewrite)
1. Every sentence — including the H1 title, every H2 heading and every quote — must be ENGLISH. Chinese characters anywhere in the output are rejected.
2. The primary thesis must be credited to its original source / author (e.g. Anthropic/Claude canonical guide if discussing Claude's article), while treating the tweet as practitioner commentary.
3. The first line must be an English H1 title starting with a single hash and a space.
4. Voice: Speak as an individual technical expert ("I", "my"). NEVER use the editorial "we" or "our" when discussing your viewpoints, analysis, or solutions.
5. Practice collision convergence: If a practice collision point is provided, the article must converge and definitively conclude on this exact point without digressing into unrelated tangents.
6. The practice-collision lens (if present) represents your own personal engineering experience and recommendation, NOT a claim made by the source tweet. Attribute it in the first person, e.g. 'Based on my own production experience, I strongly recommend...', and clearly separate it from the tweet's argument; never phrase it as if the tweet itself asserted it.`;

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
      thinking: false,
    });

    const body = stripCodeFence(res.content);
    const issues = validateArticleBody(body, material);
    if (issues.length === 0) {
      return body;
    }
    problems.push(`第 ${attempt} 次: ${issues.join('、')}`);
    console.warn(pc.yellow(`  ⚠ [article] 第 ${attempt} 次成稿不合规: ${issues.join('、')}`));
  }

  throw new Error(`[article] LLM 连续两次未产出合规正文（禁止用模板兜底）: ${problems.join(' | ')}`);
}

/**
 * Assemble final article markdown with header image and newly generated SVGs.
 */
export function assembleArticle(
  rawBody: string,
  meta: {
    articleTitle: string;
    headerImagePath?: string;
    svgArchitecture: string;
    svgSequence: string;
  }
): string {
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

  // Anti-template gate: only flag Anthropic if neither material nor primary perspective mentions it
  if (!/anthropic|claude/i.test(material) && /anthropic/i.test(body)) {
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
    if (intro.length < 30) {
      issues.push('首段导读过短：标题之后、第一个小标题之前必须有交代背景与问题的导读段落');
    }
  }

  return issues;
}


