import { chat, imagePartFromBase64 } from '../../llm/client.js';
import { extractJsonObject } from '../../llm/json.js';
import { getEnvConfig } from '../../env.js';
import { AppError, ErrorCodes } from '../errors.js';
import type {
  FastEvalCandidate,
  FastEvalLlmOutput,
  FastEvalResult,
} from './types.js';
import { FastEvalLlmOutputSchema } from './types.js';
import type { VideoCandidate } from '../contracts.js';
import { parseDurationSeconds } from './browser-search.js';
import {
  parseViewCount,
  parsePublishedDaysAgo,
  parseFlexibleDurationSeconds,
} from '../youtube/view-count.js';

export interface EvaluateCandidatesOptions {
  query: string;
  topic?: string;
  candidates: FastEvalCandidate[];
  gridBuffer: Buffer;
  gridImagePath: string;
  model?: string;
  onProgress?: (stage: string, detail?: string) => void;
}

/**
 * Builds the parameterized user prompt without hardcoded values.
 */
function buildFastEvalPrompt(params: {
  query: string;
  topic?: string;
  candidateListText: string;
  minIndex: number;
  maxIndex: number;
  dimensions: Array<{ name: string; description: string }>;
}): string {
  const { query, topic, candidateListText, minIndex, maxIndex, dimensions } = params;

  const dimText = dimensions
    .map((d, i) => `${i + 1}. **${d.name}**: ${d.description}`)
    .join('\n');

  return `你是一位全球顶尖的爆款短视频策划总监与封面视觉专家。
请仔细观察所附带的 YouTube 视频候选封面拼接图（包含编号 #${minIndex} 到 #${maxIndex} 的候选封面），并根据搜索主题选择最具爆款潜力的最佳视频封面。

【搜索关键词 / 话题】
- Query: ${query}
${topic ? `- Topic: ${topic}\n` : ''}

【候选视频列表】
${candidateListText}

【评审维度（每项 0-10 分，等权）】
${dimText}

【判定原则】
1. 观察封面图片的视觉构图、色彩对比、主体吸引力与第一眼点击欲（CTR）。
2. 识别并输出每个封面的视觉媒介艺术风格分类（如：电影质感 Cinematic Film、卡通/2D动画 2D Cartoon Animation、3D动画 3D Animation、手机拍摄 Smartphone UGC Video、定格/粘土动画 Stop-motion Claymation、写实纪录片 Realistic Documentary等）。特别注意：若封面是卡通、漫画、3D模型或粘土定格等动画形态，必须明确标注为对应的动画风格（如 2D Cartoon Animation 或 3D Animation），严禁将动画作品误判为现实写实实拍。风格名称请统一使用规范英文短语输出（例如 "2D Cartoon Animation", "3D Animation", "Cinematic Film", "Smartphone UGC Video" 等）。
3. 结合标题分析封面是否能够唤起强烈的好奇心或情绪共鸣。
4. 五维等权综合评判，不得由单一维度（尤其播放量/热度）主导结论；热度只是维度之一。
5. 高播放量/高热度 ≠ 最佳选题：若某题材在同屏已高度同质化（多个候选扎堆、封面套路雷同），即使数据亮眼也属红海拥挤，应优先考虑差异化空间大、复刻后能形成自身辨识度的候选。
6. 综合评估商业变现与爆款潜质，选出综合最有吸引力、最值得参考制作的唯一获胜视频。

【输出要求】
请严格输出纯 JSON 对象，格式如下（只需给出前三名，禁止输出全部候选的逐项打分）：
{
  "winnerIndex": <获胜候选编号，范围 ${minIndex} 到 ${maxIndex}>,
  "winnerVideoId": "<获胜候选对应的 YouTube videoId>",
  "winnerStyle": "<获胜候选的视觉风格（英文短语，例如：'2D Cartoon Animation', '3D Animation', 'Cinematic Film', 'Smartphone UGC Video', 'Stop-motion Claymation', 'Realistic Documentary'>",
  "topCandidates": [
    {
      "index": <候选编号>,
      "videoId": "<YouTube videoId>",
      "title": "<视频标题>",
      "style": "<该封面的艺术风格分类（英文短语，例如：'2D Cartoon Animation', '3D Animation', 'Cinematic Film', 'Smartphone UGC Video'等）>",
      "reason": "<一句话入选理由：该候选为何进入前三>"
    }
  ],
  "reasoning": "<详细说明为何第 1 名在风格化、戏剧性、趣味性、盈利性、独特性/差异化等方面综合胜出，并说明热度与差异化之间如何权衡、为何不是单纯追最流行>"
}
说明：topCandidates 恰好按名次从高到低排列（第 1 名即获胜者），固定输出 3 名（若候选总数不足 3 个则输出实际数量）；除这 3 名外不要输出其他候选的任何信息。`;
}

export async function evaluateCandidatesWithVL(
  options: EvaluateCandidatesOptions
): Promise<FastEvalResult> {
  const {
    query,
    topic,
    candidates,
    gridBuffer,
    gridImagePath,
    model,
    onProgress,
  } = options;

  if (candidates.length === 0) {
    throw new AppError({
      code: ErrorCodes.EVALUATION_FAILED,
      message: 'FastEval cannot evaluate empty candidate list',
      stage: 'fasteval',
      task: 'vl-evaluate',
      retryable: false,
    });
  }

  const env = getEnvConfig();
  const vlModel = model || env.vlModel || 'gemini-3.6-flash';

  onProgress?.('fasteval', `Submitting ${candidates.length} candidates grid to VL model (${vlModel})...`);

  // Build dynamic candidate text block
  const candidateListText = candidates
    .map(
      (c) =>
        `- [#${c.index}] [ID: ${c.videoId}] "${c.title}" (Channel: ${c.channelTitle}${
          c.viewCountText ? `, ${c.viewCountText}` : ''
        })`
    )
    .join('\n');

  const dimensions = [
    {
      name: '风格化 (Stylization)',
      description: '画面的视觉风格、色彩饱和度、设计质感与艺术张力，能否在海量信息流中一眼脱颖而出。',
    },
    {
      name: '戏剧性 (Dramatic)',
      description: '封面人物神态、情节冲突、悬念感与视觉钩子，是否产生强烈的点击欲望与探索欲。',
    },
    {
      name: '趣味性 (Entertainment)',
      description: '画面元素的趣味度、新奇感、脑洞或情绪价值，能否引发用户的愉悦与分享欲。',
    },
    {
      name: '盈利性 (Monetization & Virality)',
      description: '对应主题的商业变现潜力、知识付费/带货转化率及利基爆款（Viral Niche）复刻价值。',
    },
    {
      name: '独特性/差异化 (Uniqueness & Differentiation)',
      description:
        '与同屏其他候选相比，该选题与呈现是否具备差异化辨识度与蓝海空间：题材同质化/红海拥挤度低，封面套路不落俗，复刻后仍能形成自己的辨识度而非又一个跟风复制品。',
    },
  ];

  const minIndex = 1;
  const maxIndex = candidates.length;

  const promptText = buildFastEvalPrompt({
    query,
    topic,
    candidateListText,
    minIndex,
    maxIndex,
    dimensions,
  });

  const base64Image = gridBuffer.toString('base64');

  const chatResponse = await chat(
    {
      model: vlModel,
      context: { stage: 'fasteval', task: 'vl-evaluate' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            imagePartFromBase64(base64Image),
          ],
        },
      ],
      temperature: 0.1,
      timeoutMs: 180_000,
      responseFormat: 'json_object',
    },
    env
  );

  const jsonResult = extractJsonObject(chatResponse.content);
  if (!jsonResult.ok || !jsonResult.value) {
    throw new AppError({
      code: ErrorCodes.EVALUATION_FAILED,
      message: `FastEval VL model did not return valid JSON: ${jsonResult.ok ? 'Missing value' : jsonResult.reason}`,
      stage: 'fasteval',
      task: 'vl-evaluate',
      retryable: false,
    });
  }

  const parsed = FastEvalLlmOutputSchema.safeParse(jsonResult.value);
  if (!parsed.success) {
    throw new AppError({
      code: ErrorCodes.EVALUATION_FAILED,
      message: `FastEval VL model response failed schema validation: ${parsed.error.message}`,
      stage: 'fasteval',
      task: 'vl-evaluate',
      retryable: false,
    });
  }

  const output: FastEvalLlmOutput = parsed.data;

  // Validate winner index is strictly within range
  const winnerCandidate = candidates.find(
    (c) => c.index === output.winnerIndex || c.videoId === output.winnerVideoId
  );

  // The winner must come from the VL shortlist (topCandidates rank #1).
  const shortlist = output.topCandidates;
  if (!winnerCandidate || shortlist[0]?.videoId !== winnerCandidate.videoId) {
    throw new AppError({
      code: ErrorCodes.EVALUATION_FAILED,
      message: `FastEval VL model selected invalid winner index #${output.winnerIndex} (videoId: ${output.winnerVideoId}); winner must be topCandidates[1], valid range is 1..${candidates.length}`,
      stage: 'fasteval',
      task: 'vl-evaluate',
      retryable: false,
    });
  }

  const winnerDurationSec =
    winnerCandidate.durationSec ||
    parseDurationSeconds(winnerCandidate.durationText) ||
    parseFlexibleDurationSeconds(winnerCandidate.durationText) ||
    180;
  const winnerViewCount =
    winnerCandidate.viewCount ??
    (winnerCandidate.viewCountText ? parseViewCount(winnerCandidate.viewCountText) : null) ??
    0;
  const winnerDaysAgo =
    winnerCandidate.publishedDaysAgo ??
    (winnerCandidate.publishedTimeText ? parsePublishedDaysAgo(winnerCandidate.publishedTimeText) : null) ??
    30;
  const publishedAt = new Date(Date.now() - winnerDaysAgo * 86_400_000).toISOString();
  const viewsPerDay =
    winnerCandidate.viewsPerDay ??
    (winnerViewCount > 0 && winnerDaysAgo > 0 ? Math.round(winnerViewCount / winnerDaysAgo) : 0);

  const matchedTop = shortlist.find(
    (e) => e.videoId === winnerCandidate.videoId
  );
  const resolvedWinnerStyle = output.winnerStyle || matchedTop?.style || 'cinematic';

  // Map to VideoCandidate schema for seamless pipeline downstream integration
  const canonicalWinner: VideoCandidate = {
    videoId: winnerCandidate.videoId,
    title: winnerCandidate.title,
    description: `Discovered via browser FastEval search for query: "${query}"`,
    url: winnerCandidate.url,
    channelId: winnerCandidate.channelTitle.toLowerCase().replace(/[^a-z0-9]/g, '_') || 'unknown',
    channelTitle: winnerCandidate.channelTitle,
    tags: [query, 'viral', 'fasteval'],
    language: 'en',
    visualStyle: resolvedWinnerStyle,
    metrics: {
      viewCount: winnerViewCount,
      likeCount: 0,
      commentCount: 0,
      durationSec: winnerDurationSec,
      publishedAt,
      viewsPerDay,
      engagementRate: 0,
    },
    metricsConfidence: {
      views: winnerViewCount > 0,
      likes: false,
      comments: false,
    },
    discovery: {
      origin: 'search',
      rank: winnerCandidate.index,
    },
  };

  return {
    query,
    gridImagePath,
    gridBuffer,
    candidates,
    winnerIndex: winnerCandidate.index,
    winner: winnerCandidate,
    winnerCandidate: canonicalWinner,
    style: resolvedWinnerStyle,
    topCandidates: output.topCandidates,
    reasoning: output.reasoning,
    evaluatedAt: new Date().toISOString(),
  };
}
