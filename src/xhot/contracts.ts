import { z } from 'zod';
import type { TutorialGenerationSummary } from '../tutorial/contracts.js';

export const XHotCandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string(),
  url: z.string().url().optional(),
  authorName: z.string().default(''),
  authorHandle: z.string().default(''),
  avatarUrl: z.string().optional(),
  text: z.string().default(''),
  timestamp: z.string().optional(),
  ageHours: z.number().optional(),
  metrics: z.object({
    replies: z.number().default(0),
    reposts: z.number().default(0),
    likes: z.number().default(0),
    views: z.number().default(0),
  }).default({}),
  mediaUrls: z.array(z.string()).default([]),
  screenshotPath: z.string().optional(),
  thumbnailBuffer: z.instanceof(Buffer).optional(),
});
export type XHotCandidate = z.infer<typeof XHotCandidateSchema>;

export const XHotTopCandidateSchema = z.object({
  rank: z.number().int().min(1).max(3),
  index: z.number().int().nonnegative(),
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  reason: z.string(),
  score: z.number().optional(),
});
export type XHotTopCandidate = z.infer<typeof XHotTopCandidateSchema>;

export const XHotEvalResultSchema = z.object({
  query: z.string(),
  evaluatedAt: z.string(),
  gridImagePath: z.string(),
  winner: XHotTopCandidateSchema,
  topCandidates: z.array(XHotTopCandidateSchema).min(1).max(3),
  reasoning: z.string(),
});
export type XHotEvalResult = z.infer<typeof XHotEvalResultSchema>;

export const XHotHarvestItemSchema = z.object({
  tweetId: z.string(),
  url: z.string().optional(),
  authorName: z.string().default(''),
  authorHandle: z.string().default(''),
  text: z.string().default(''),
  mediaFiles: z.array(z.object({
    kind: z.enum(['image', 'video']),
    localPath: z.string(),
    url: z.string().optional(),
  })).default([]),
  screenshotPath: z.string().optional(),
});
export type XHotHarvestItem = z.infer<typeof XHotHarvestItemSchema>;

export const XHotHarvestResultSchema = z.object({
  topicName: z.string(),
  items: z.array(XHotHarvestItemSchema),
  harvestedMediaCount: z.number().int().nonnegative(),
  materialsDir: z.string(),
});
export type XHotHarvestResult = z.infer<typeof XHotHarvestResultSchema>;

export const XHotPipelineOptionsSchema = z.object({
  query: z.string().min(1, 'Search topic or query is required').default('new model'),
  outDir: z.string().optional(),
  storageDir: z.string().optional(),
  profileDir: z.string().optional(),
  candidateCount: z.number().int().positive().default(12),
  maxCandidateAgeHours: z.number().positive().default(72),
  headed: z.boolean().default(false),
  headless: z.boolean().optional(),
  dryRun: z.boolean().default(false),
  skipVideo: z.boolean().default(false),
  tutorialEngine: z.enum(['firefox', 'chromium']).default('chromium'),
  tutorialFps: z.number().int().positive().max(60).default(30),
  tutorialSubtitles: z.boolean().default(false),
  ttsVoice: z.string().optional(),
  ttsRate: z.string().default('+0%'),
});
export type XHotPipelineOptions = z.infer<typeof XHotPipelineOptionsSchema>;

export const XHotPipelineResultSchema = z.object({
  runId: z.string(),
  pipelineId: z.literal('xhot'),
  query: z.string(),
  outDir: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  totalDurationMs: z.number(),
  winner: XHotTopCandidateSchema.optional(),
  topCandidates: z.array(XHotTopCandidateSchema).optional(),
  gridImagePath: z.string().optional(),
  harvestResult: XHotHarvestResultSchema.optional(),
  tutorial: z.any().optional(),
});
export type XHotPipelineResult = z.infer<typeof XHotPipelineResultSchema>;
