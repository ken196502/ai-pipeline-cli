import { z } from 'zod';
import {
  XHotPipelineOptionsSchema,
  type XHotPipelineOptions,
  XHotPipelineResultSchema,
  type XHotPipelineResult,
  type XHotTopCandidate,
  type XHotHarvestResult,
} from '../xhot/contracts.js';
import type { TutorialGenerationSummary } from '../tutorial/contracts.js';

export {
  XHotPipelineOptionsSchema,
  type XHotPipelineOptions,
  XHotPipelineResultSchema,
  type XHotPipelineResult,
};

export interface PipelineStageDef {
  id: string;
  name: string;
  description: string;
  optional?: boolean;
}

export const StageResultSchema = z.object({
  stage: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped', 'failed']),
  durationMs: z.number().nonnegative(),
  summary: z.string().optional(),
  error: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type StageResult = z.infer<typeof StageResultSchema>;
export type StageStatus = StageResult['status'];

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

export const XHOT_STAGES: PipelineStageDef[] = [
  { id: 'check-env', name: 'Environment Check', description: 'Verify Chromium, profile, LLM, yt-dlp, and ffmpeg' },
  { id: 'x-login', name: 'X Persistent Auth', description: 'Authenticate on X (x.com) with persistent session' },
  { id: 'x-search-grid', name: 'Topic Search & Grid', description: 'Search X topic, collect candidate cards and build NxN grid' },
  { id: 'x-eval', name: 'VL Top 3 Evaluation', description: 'Evaluate candidates with Vision-Language model and pick top 3 & winner' },
  { id: 'x-harvest', name: 'Harvest Winner Materials', description: 'Deep search winner name and harvest tweets, images & videos' },
  { id: 'x-video', name: 'Presentation Video', description: 'Generate storyboard, TTS narration, and render presentation video', optional: true },
  { id: 'report', name: 'Generate Reports', description: 'Compile Markdown and JSON pipeline reports' },
];

export interface XHotFullResult extends XHotPipelineResult {
  stages: Record<string, StageResult>;
  envCheck?: EnvCheckSummary;
}
