import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chat, imagePartFromBase64 } from '../../libs/llm/client.js';
import { extractJsonObject } from '../../libs/llm/json.js';
import { getEnvConfig } from '../../utils/env.js';
import { maskProfanity } from '../../utils/text.js';
import type { XHotCandidate } from '../discovery/contracts.js';
import type {
  XHotEvalResult,
  XHotTopCandidate,
  EvaluateXHotCandidatesOptions,
} from './contracts.js';
import { XHotEvalResultSchema } from './contracts.js';
import { verifyWinnerName } from './winner-name-check.js';

export async function evaluateXHotCandidatesWithVL(
  options: EvaluateXHotCandidatesOptions
): Promise<XHotEvalResult> {
  const { query, candidates, gridBuffer, gridImagePath, onProgress } = options;
  const env = getEnvConfig();
  const vlModel = options.model || env.vlModel || 'gemini-3.5-flash-lite';

  onProgress?.(`Submitting candidate grid (${candidates.length} tweets) to VL model ${vlModel}`);

  let maskedTextCount = 0;
  const candidateListText = candidates
    .map((c) => {
      const posted = c.timestamp
        ? `${c.timestamp.slice(0, 10)}${c.ageHours !== undefined ? `（约 ${c.ageHours} 小时前发布）` : ''}`
        : '未知时间';
      const { text: safeText, maskedCount } = maskProfanity(c.text || '(Image/Video only)');
      if (maskedCount > 0) maskedTextCount += 1;
      return `#${c.index} [${c.authorName} (${c.authorHandle})] (发布: ${posted}, Likes: ${c.metrics.likes}, Reposts: ${c.metrics.reposts}, Views: ${c.metrics.views}):\n${safeText}`;
    })
    .join('\n\n');
  if (maskedTextCount > 0) {
    onProgress?.(
      `Masked profanity in ${maskedTextCount} candidate text(s) for content-filter compliance`
    );
  }

  const systemPrompt = `你是一位敏锐的全球科技前沿与社交媒体热点分析总监。
你的任务是通过分析 X (Twitter) 热门推文截图矩阵图，评估并挑选出该搜索主题下当前最新鲜、讨论最广、且最具备报道和视频解说价值的前三名热点项目/模型（Top 3）。
两条硬性准则：
1. 时效性优先：热点必须是最近爆发的话题（优先 72 小时内）；发布已久的旧闻（如早期模型发布、往期事件）即使互动量很高也必须降权，除非没有更新的话题。
2. 讨论广度优先：同一模型/项目被越多不同作者的推文讨论，说明讨论越病毒式，越优先；单条高互动但孤立讨论的推文次之。`;

  const userPrompt = `【搜索关键词 / 话题】
- Query: ${query}

【所附候选拼图说明】
拼图包含编号从 #1 到 #${candidates.length} 的推文卡片真实截图（每张卡片左上角均带有蓝色编号如 #1, #2 ...）。

【候选推文文本及数据】
${candidateListText}

【评审要求】
1. 仔细查看拼图矩阵，结合每条推文的发布时间、文本、作者公信力、发布内容亮点、互动数据以及多媒体图文展示。
2. 识别出推文中具体讨论的核心模型/技术/项目名称（例如若是搜 "new model"，识别是哪个具体的大模型如 Claude 3.7, DeepSeek-V3, Llama 3, Sora 还是其他具体模型）。
3. 统计每个具体模型/项目被多少条不同作者的推文讨论（讨论条数 = 讨论广度），讨论广度是热度最直接的证据，必须作为首要权重。
4. 时效性硬权重：对比每条推文的发布时间，优先最近 72 小时内发布/引爆的话题；发布已久的旧闻必须降权，除非候选中没有更新的话题。
5. 选出「讨论广度 × 时效性 × 报道价值」综合最高的前三名（Top 3），按名次由高到低严格排布（第 1 名即 Winner）。
6. 给出最终获胜者（第 1 名）的详细入选逻辑与综合分析（必须包含讨论条数统计与时间新鲜度判断）。

【严格 JSON 输出格式】
请直接输出纯 JSON 对象，格式如下：
{
  "topCandidates": [
    {
      "rank": 1,
      "index": <对应的拼图编号数字，例如 1>,
      "id": "<推文 ID 或标识>",
      "name": "<该项目/模型的确切名称，如 DeepSeek-V3 / Claude 3.5 Sonnet / Sora 等>",
      "summary": "<1-2句话概述其核心亮点与发布内容>",
      "reason": "<为何入选第 1 名理由>"
    },
    {
      "rank": 2,
      "index": <编号数字>,
      "id": "<推文 ID>",
      "name": "<第 2 名项目/模型名称>",
      "summary": "<简要概述>",
      "reason": "<入选理由>"
    },
    {
      "rank": 3,
      "index": <编号数字>,
      "id": "<推文 ID>",
      "name": "<第 3 名项目/模型名称>",
      "summary": "<简要概述>",
      "reason": "<入选理由>"
    }
  ],
  "winner": {
    "rank": 1,
    "index": <第 1 名编号数字>,
    "id": "<推文 ID>",
    "name": "<获胜项目/模型的确切名称>",
    "summary": "<核心亮点>",
    "reason": "<入选理由>"
  },
  "reasoning": "<详细说明为何第 1 名能在热度、技术突破、社区讨论爆发力以及多媒体展示丰富度上全面胜出>"
}`;

  const imagePart = imagePartFromBase64(gridBuffer.toString('base64'), 'image/png');

  const response = await chat({
    model: vlModel,
    context: { stage: 'xhot', task: 'vl-evaluate' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          imagePart,
        ],
      },
    ],
    temperature: 0.2,
    responseFormat: 'json_object',
    timeoutMs: 300_000,
  }, env);

  const jsonExtraction = extractJsonObject(response.content);
  if (!jsonExtraction.ok || !jsonExtraction.value) {
    throw new Error(`Failed to extract valid JSON from VL evaluation response: ${response.content.slice(0, 300)}`);
  }
  const parsedJson = jsonExtraction.value as any;

  // Normalize structure
  let topCandidates: XHotTopCandidate[] = Array.isArray(parsedJson.topCandidates)
    ? parsedJson.topCandidates.map((c: any, idx: number) => ({
        rank: c.rank || idx + 1,
        index: c.index !== undefined ? Number(c.index) : idx + 1,
        id: String(c.id || `candidate-${idx + 1}`),
        name: String(c.name || `Topic #${idx + 1}`),
        summary: String(c.summary || ''),
        reason: String(c.reason || ''),
        score: c.score !== undefined ? Number(c.score) : undefined,
      }))
    : [];

  if (topCandidates.length === 0 && candidates.length > 0) {
    topCandidates.push({
      rank: 1,
      index: candidates[0].index,
      id: candidates[0].id,
      name: candidates[0].authorName || query,
      summary: candidates[0].text.slice(0, 80),
      reason: 'Top engagement candidate',
    });
  }

  const winner: XHotTopCandidate = parsedJson.winner
    ? {
        rank: 1,
        index: Number(parsedJson.winner.index ?? topCandidates[0].index),
        id: String(parsedJson.winner.id ?? topCandidates[0].id),
        name: String(parsedJson.winner.name ?? topCandidates[0].name),
        summary: String(parsedJson.winner.summary ?? topCandidates[0].summary),
        reason: String(parsedJson.winner.reason ?? topCandidates[0].reason),
      }
    : topCandidates[0];

  // --- Strict consistency validation: refuse hallucinated winner mappings ---
  const winnerCandidate = candidates.find((c) => c.index === winner.index);

  // Image-only cards (no/empty tweet text) cannot be text-verified; the name lives in the image.
  const winnerCardIsImageOnly =
    !winnerCandidate || winnerCandidate.text.replace(/\s/g, '').length < 8;

  // Token-tolerant grounding check. The VL model returns a *cluster* name (e.g.
  // "Anthropic New Model (Claude/Fable)") anchored to one representative tweet, so the
  // name is rarely a contiguous substring. Author name/handle and the model's own
  // reasoning are also accepted as grounding evidence when the tweet itself is terse.
  const nameCheck = verifyWinnerName({
    name: winner.name,
    tweetText: winnerCandidate
      ? `${winnerCandidate.authorName} ${winnerCandidate.authorHandle} ${winnerCandidate.text}`
      : '',
    extraHaystacks: [
      topCandidates.map((c) => `${c.name} ${c.summary} ${c.reason}`).join(' '),
      String(parsedJson.reasoning || ''),
    ],
  });
  const winnerNameMatches = nameCheck.matches;
  const nameCheckApplicable =
    !winnerCardIsImageOnly && nameCheck.applicable && nameCheck.tokens.length > 0;

  if (winnerNameMatches && nameCheck.strategy === 'single-token') {
    onProgress?.(
      `Winner name "${winner.name}" grounded only partially (missing: ${nameCheck.missingTokens.join(', ')}) - accepted on cluster-level evidence`
    );
  }

  // Audit dump: raw response + parsed result + validation outcome, always on disk
  const auditPath = path.join(path.dirname(gridImagePath), 'eval-result.json');
  await fs
    .writeFile(
      auditPath,
      JSON.stringify(
        {
          query,
          model: vlModel,
          evaluatedAt: new Date().toISOString(),
          candidateCount: candidates.length,
          winner,
          topCandidates: topCandidates.slice(0, 3),
          winnerNameMatches,
          nameCheckApplicable,
          winnerCardIsImageOnly,
          winnerNameStrategy: nameCheck.strategy,
          winnerNameTokens: nameCheck.tokens,
          winnerNameMissingTokens: nameCheck.missingTokens,
          winnerCandidateText: winnerCandidate?.text ?? null,
          rawResponse: response.content,
        },
        null,
        2
      ),
      'utf8'
    )
    .catch(() => {});

  if (!winnerCandidate) {
    throw new Error(
      `VL evaluation inconsistent: winner.index ${winner.index} does not map to any captured candidate (1..${candidates.length}). Raw response saved to ${auditPath}`
    );
  }
  if (!winnerNameMatches && nameCheckApplicable) {
    throw new Error(
      `VL evaluation inconsistent: winner "${winner.name}" (#${winner.index}) not found in that candidate's text (@${winnerCandidate.authorHandle}: "${winnerCandidate.text.slice(0, 120)}..."). Refusing to proceed on a hallucinated mapping. Raw response saved to ${auditPath}`
    );
  }

  const evalResult: XHotEvalResult = {
    query,
    evaluatedAt: new Date().toISOString(),
    gridImagePath,
    winner,
    topCandidates: topCandidates.slice(0, 3),
    reasoning: String(parsedJson.reasoning || winner.reason || 'Evaluated via VL model.'),
  };

  XHotEvalResultSchema.parse(evalResult);
  onProgress?.(`VL Evaluation complete. Winner: "${evalResult.winner.name}" (#${evalResult.winner.index})`);
  return evalResult;
}
