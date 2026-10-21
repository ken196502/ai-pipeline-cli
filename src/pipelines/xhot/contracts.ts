import { z } from 'zod';
import type { PipelineStageDef, StageResult } from '../core/contracts.js';
import type { XHotTopCandidate } from '../../modules/evaluation/contracts.js';
import type { XHotHarvestResult } from '../../modules/harvest/contracts.js';
import type { ExplainerVideoSummary } from '../../libs/player/contracts.js';

export const XHotPipelineOptionsSchema = z.object({
  query: z.string().min(1, 'Query keyword is required'),
  candidateCount: z.number().int().min(1).max(36).default(12),
  maxCandidateAgeHours: z.number().int().min(1).max(720).default(72),
  outDir: z.string().optional(),
  profileDir: z.string().optional(),
  storageDir: z.string().optional(),
  headed: z.boolean().default(false),
  headless: z.boolean().default(true),
  skipVideo: z.boolean().default(false),
  explainerEngine: z.enum(['firefox', 'chromium']).default('chromium'),
  explainerFps: z.number().int().min(10).max(60).default(30),
  explainerSubtitles: z.boolean().default(false),
  // Backward compatibility options
  tutorialEngine: z.enum(['firefox', 'chromium']).optional(),
  tutorialFps: z.number().int().min(10).max(60).optional(),
  tutorialSubtitles: z.boolean().optional(),
  ttsVoice: z.string().optional(),
  ttsRate: z.string().default('+0%'),
  dryRun: z.boolean().default(false),
  twentyFourHour: z.union([z.boolean(), z.number().int().min(1)]).optional(),
  topics: z.union([z.string(), z.array(z.string())]).optional(),
});
export type XHotPipelineOptions = z.infer<typeof XHotPipelineOptionsSchema>;

export const XHOT_STAGES: PipelineStageDef[] = [
  { id: 'check-env', name: 'Environment Check', description: 'Verify Chromium, persistent profile, LLM, yt-dlp, and ffmpeg' },
  { id: 'x-login', name: 'X Persistent Auth', description: 'Authenticate on X (x.com) with persistent session' },
  { id: 'x-search-grid', name: 'Topic Search & Grid', description: 'Search X topic, collect candidate cards and build NxN grid' },
  { id: 'x-eval', name: 'VL Top 3 Evaluation', description: 'Evaluate candidates with Vision-Language model and pick top 3 & winner' },
  { id: 'x-harvest', name: 'Harvest Winner Materials', description: 'Deep search winner name and harvest tweets, images & videos' },
  { id: 'x-video', name: 'Explainer Video', description: 'Generate storyboard, TTS narration, and render explainer video', optional: true },
  { id: 'report', name: 'Generate Reports', description: 'Compile Markdown and JSON pipeline reports' },
];

export interface EnvCheckSummary {
  llmConfigured: boolean;
  llmEndpoint?: string;
  llmModel?: string;
  vlModel?: string;
  chromiumInstalled: boolean;
  chromiumPath?: string;
  chromiumVersion?: string;
  ytDlpInstalled: boolean;
  ytDlpPath?: string;
  ffmpegInstalled: boolean;
  profileDir: string;
}

export interface XHotFullResult {
  runId: string;
  pipelineId: 'xhot';
  query: string;
  outDir: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  winner?: XHotTopCandidate;
  topCandidates?: XHotTopCandidate[];
  gridImagePath?: string;
  harvestResult?: XHotHarvestResult;
  explainer?: ExplainerVideoSummary;
  tutorial?: ExplainerVideoSummary;
  stages: Record<string, StageResult>;
  envCheck?: EnvCheckSummary;
}
