import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chat, imagePartFromBase64 } from '../../libs/llm/client.js';
import { extractJsonObject } from '../../libs/llm/json.js';
import { getEnvConfig } from '../../utils/env.js';
import { maskProfanity } from '../../utils/text.js';
import { buildXHotGrid } from '../discovery/grid.js';
import type { XHotCandidate } from '../discovery/contracts.js';
import { z } from 'zod';

export const TweetRichnessSelectionSchema = z.object({
  topIndices: z.array(z.number().int().positive()),
  rankings: z.array(
    z.object({
      rank: z.number().int().positive(),
      index: z.number().int().positive(),
      reason: z.string().default(''),
    })
  ).default([]),
  reasoning: z.string().default(''),
});

export type TweetRichnessSelection = z.infer<typeof TweetRichnessSelectionSchema>;

export interface EvaluateTweetRichnessOptions {
  topicName: string;
  candidates: Array<{
    index: number;
    tweetId: string;
    authorName: string;
    authorHandle: string;
    text: string;
    screenshotPath: string;
    metrics?: {
      replies: number;
      reposts: number;
      likes: number;
      views: number;
    };
  }>;
  targetCount?: number;
  outDir: string;
  onProgress?: (msg: string) => void;
}

/**
 * Evaluates candidate tweets using VL model to pick the Top N most informative tweets.
 */
export async function evaluateTweetRichnessWithVL(
  options: EvaluateTweetRichnessOptions
): Promise<number[]> {
  const { topicName, candidates, targetCount = 10, outDir, onProgress } = options;

  if (candidates.length <= targetCount) {
    onProgress?.(
      `Candidate count (${candidates.length}) is <= target count (${targetCount}), selecting all.`
    );
    return candidates.map((c) => c.index);
  }

  onProgress?.(`Building contact grid for ${candidates.length} candidate tweets to evaluate richness...`);

  // Build grid image for VL model
  const gridPath = path.join(outDir, 'harvest-candidates-grid.png');
  const xhotCandidates: XHotCandidate[] = candidates.map((c) => ({
    index: c.index,
    id: c.tweetId,
    authorName: c.authorName,
    authorHandle: c.authorHandle,
    text: c.text,
    screenshotPath: c.screenshotPath,
    metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
    mediaUrls: [],
    hasVideo: false,
  }));

  const { buffer: gridBuffer } = await buildXHotGrid({
    candidates: xhotCandidates,
    outputPath: gridPath,
  });

  const env = getEnvConfig();
  const vlModel = env.vlModel || 'gemini-3.5-flash-lite';

  onProgress?.(`Submitting candidate grid to VL model (${vlModel}) to pick Top ${targetCount} richest tweets...`);

  const candidateListText = candidates
    .map((c) => {
      const { text: safeText } = maskProfanity(c.text || '(Image/Video only)');
      const m = c.metrics;
      const metricsInfo = m ? ` [Views: ${m.views}, Likes: ${m.likes}, Reposts: ${m.reposts}, Replies: ${m.replies}]` : '';
      return `#${c.index} [${c.authorName} (${c.authorHandle})]${metricsInfo}:\n${safeText}`;
    })
    .join('\n\n');

  const systemPrompt = `你是一位专业的内容研究员和多媒体素材总监。
你的任务是从搜索话题 "${topicName}" 获取的候选推文截图矩阵中，评估推文的信息丰富度，并挑选出信息最充实、最具实质报道价值和多媒体展示效果的前 ${targetCount} 条推文。

信息丰富度评估维度：
1. 实质性内容深度：包含技术细节、实测结果、原理解析、架构分析或详细解读，而非简单的转发、纯表情或单句吹捧。
2. 视觉与多媒体呈现：推文包含高质量图表、界面截图、对比测试图、架构图或演示视频等直观证据。
3. 论据与信息密度：具有客观事实支撑、参数对比或关键要点列举，能够为视频解说提供扎实素材。`;

  const userPrompt = `【研究话题】
- 主题: ${topicName}

【推文拼图说明】
拼图包含编号从 #1 到 #${candidates.length} 的推文卡片真实截图（每张卡片左上角均带有蓝色编号如 #1, #2 ...）。

【候选推文文本】
${candidateListText}

【评审要求】
1. 结合每条推文的截图内容和文本深度，综合评估每条推文的信息丰富度。
2. 挑选出信息最丰富、最适合作为视频深度解说素材的 ${targetCount} 条推文编号（例如 [1, 3, 5, ...]）。
3. 严格按信息丰富度从高到低排序。

【严格 JSON 输出格式】
请直接输出纯 JSON 对象，格式如下：
{
  "topIndices": [1, 4, 7, ...],
  "rankings": [
    {
      "rank": 1,
      "index": 1,
      "reason": "包含详细测试结果与架构图对比，信息密度极高"
    }
  ],
  "reasoning": "整体筛选逻辑概述"
}`;

  const imagePart = imagePartFromBase64(gridBuffer.toString('base64'), 'image/png');
  const response = await chat(
    {
      model: vlModel,
      context: { stage: 'xhot', task: 'harvest-tweet-richness' },
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
    },
    env
  );

  const jsonExtraction = extractJsonObject(response.content);
  if (!jsonExtraction.ok || !jsonExtraction.value) {
    throw new Error(`Failed to extract valid JSON from VL richness evaluation response: ${response.content.slice(0, 300)}`);
  }
  const validated = TweetRichnessSelectionSchema.parse(jsonExtraction.value);

  // Validate selected indices
  const validIndices = new Set(candidates.map((c) => c.index));
  const filteredIndices: number[] = [];
  for (const idx of validated.topIndices) {
    if (validIndices.has(idx) && !filteredIndices.includes(idx)) {
      filteredIndices.push(idx);
    }
  }

  // If VL missed some or returned fewer than targetCount, fill with remaining candidates in original order
  if (filteredIndices.length < targetCount) {
    for (const c of candidates) {
      if (!filteredIndices.includes(c.index)) {
        filteredIndices.push(c.index);
        if (filteredIndices.length >= targetCount) break;
      }
    }
  }

  const selected = filteredIndices.slice(0, targetCount);
  onProgress?.(
    `VL evaluated richness. Selected Top ${selected.length} tweets: [${selected.map((i) => `#${i}`).join(', ')}]`
  );

  return selected;
}
