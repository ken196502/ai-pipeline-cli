import { z } from 'zod';
import { VideoCandidateSchema, type VideoCandidate } from '../contracts.js';

export const FastEvalTopCandidateSchema = z.object({
  index: z.number().int().positive(),
  videoId: z.string().min(1),
  title: z.string().min(1),
  style: z.string().min(1).describe('视觉艺术风格分类（如：2D Cartoon Animation / 3D Animation / Cinematic Film / Smartphone UGC Video 等）'),
  reason: z.string().min(1).describe('一句话入选理由（为何进入前三）'),
});
export type FastEvalTopCandidate = z.infer<typeof FastEvalTopCandidateSchema>;

export const FastEvalLlmOutputSchema = z.object({
  winnerIndex: z.number().int().positive().describe('获胜候选视频的编号 (1-based index)'),
  winnerVideoId: z.string().min(1).describe('获胜视频的 YouTube videoId'),
  winnerStyle: z.string().describe('获胜候选的视觉艺术风格（如：电影/卡通/3D/手机拍摄等）'),
  topCandidates: z.array(FastEvalTopCandidateSchema).min(1).max(3)
    .describe('综合评审后选出的前三名候选，按排名降序（第 1 名即获胜者）'),
  reasoning: z.string().describe('为什么第 1 名在风格化、戏剧性、趣味性、盈利性、独特性上综合胜出的详细判定依据'),
});
export type FastEvalLlmOutput = z.infer<typeof FastEvalLlmOutputSchema>;

export interface FastEvalCandidate {
  index: number;
  videoId: string;
  title: string;
  channelTitle: string;
  url: string;
  durationText?: string;
  durationSec?: number;
  viewCountText?: string;
  viewCount?: number;
  publishedTimeText?: string;
  publishedDaysAgo?: number;
  viewsPerDay?: number;
  thumbnailBuffer: Buffer;
}

export interface FastEvalResult {
  query: string;
  gridImagePath: string;
  gridBuffer: Buffer;
  candidates: FastEvalCandidate[];
  winnerIndex: number;
  winner: FastEvalCandidate;
  winnerCandidate: VideoCandidate;
  style: string;
  topCandidates: FastEvalTopCandidate[];
  reasoning: string;
  evaluatedAt: string;
}

/** Durable FastEval output; binary thumbnails/grid stay in their image files. */
const FastEvalCandidateDataSchema = z.object({
  index: z.number(), videoId: z.string(), title: z.string(), channelTitle: z.string(), url: z.string(),
  durationText: z.string().optional(), durationSec: z.number().optional(),
  viewCountText: z.string().optional(), viewCount: z.number().optional(),
  publishedTimeText: z.string().optional(), publishedDaysAgo: z.number().optional(), viewsPerDay: z.number().optional(),
});
export const FastEvalDataSchema = z.object({
  query: z.string(), gridImagePath: z.string(), candidates: z.array(FastEvalCandidateDataSchema),
  winnerIndex: z.number(), winner: FastEvalCandidateDataSchema, winnerCandidate: VideoCandidateSchema,
  style: z.string(), topCandidates: z.array(FastEvalTopCandidateSchema).min(1), reasoning: z.string(), evaluatedAt: z.string(),
});
export type FastEvalData = z.infer<typeof FastEvalDataSchema>;

export interface FastEvalOptions {
  query: string;
  topic?: string;
  candidateCount?: number;
  profileDir?: string;
  browserPath?: string;
  viewport?: { width: number; height: number } | null;
  model?: string;
  outDir: string;
  /** Whether to run browser in headless mode (default: true). */
  headless?: boolean | 'shell';
  /** Minimum video duration in seconds before a cover is captured (default 300). */
  minDurationSec?: number;
  /** Maximum published age in days before a cover is captured (default 183). */
  maxAgeDays?: number;
  onProgress?: (stage: string, detail?: string) => void;
}
