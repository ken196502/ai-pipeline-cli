/**
 * Contracts, Zod schemas, and TypeScript definitions for the
 * "AI make Niche Viral Video" end-to-end pipeline.
 */
import { z } from 'zod';
import type {
  CandidateEvaluation,
  EvaluationRequirements,
  EvaluationStandard,
  ResearchResult,
  SelectionDecision,
  VideoCandidate,
} from '../../research/contracts.js';
import {
  EvaluationRequirementsSchema,
} from '../../research/contracts.js';
import type { FlowClipPrompt, FlowVideoScript } from '../../research/script/contracts.js';
import type { BatchResult, FlowProject, QuotaSnapshot } from '../../flow/contracts.js';
import type { TutorialGenerationSummary } from '../../tutorial/contracts.js';

export type { TutorialGenerationSummary };

export type PipelineStage =
  | 'check-env'
  | 'check-ytb'
  | 'browser-refresh'
  | 'search-ytb'
  | 'standard-load'
  | 'standard-gen'
  | 'standard-save'
  | 'evaluate'
  | 'extract-prompts'
  | 'gen-prompts'
  | 'flow-login'
  | 'flow-project'
  | 'flow-generate'
  | 'tutorial-gen'
  | 'report'
  | 'complete';

import type { StageResult } from '../../run/contracts.js';
export type { StageResult, StageStatus } from '../../run/contracts.js';

export const FlowTutorPipelineOptionsSchema = z.object({
  query: z.string().min(1, 'Search query or viral topic is required').default('AI make Niche Viral Video'),
  topic: z.string().optional(),
  standardPath: z.string().optional(),
  saveStandardPath: z.string().optional(),
  standardsDir: z.string().optional(),
  storageDir: z.string().optional(),
  reuseStandard: z.boolean().default(true),
  forceNewStandard: z.boolean().default(false),
  removeExistingStandard: z.boolean().default(false),
  removeStandard: z.boolean().default(false),
  removeAllStandards: z.boolean().default(false),
  evaluationFocus: z.string().optional(),
  evaluationRequirements: z.union([EvaluationRequirementsSchema, z.string()]).optional(),
  maxCandidates: z.number().int().positive().default(15),
  poolSize: z.number().int().positive().default(5),
  language: z.string().default('en'),
  cookiePath: z.string().default('./cookies.txt'),
  profileDir: z.string().default('./.chromium-profile'),
  browserPath: z.string().optional(),
  proxyUrl: z.string().optional(),
  model: z.string().optional(),
  flowModel: z.string().default('lite'),
  clipDuration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(4),
  aspectRatio: z.enum(['landscape', 'portrait']).default('landscape'),
  flowProjectId: z.string().optional(),
  createNewProject: z.boolean().default(true),
  useExt: z.boolean().default(false),
  maxClips: z.number().int().positive().optional(),
  dryRun: z.boolean().default(false),
  skipFlowGen: z.boolean().default(false),
  stopBeforeGen: z.boolean().default(false),
  skipFlowLogin: z.boolean().default(false),
  skipMediaDownload: z.boolean().default(false),
  skipTutorial: z.boolean().default(false),
  ttsVoice: z.string().optional(),
  ttsRate: z.string().default('+0%'),
  tutorialEngine: z.enum(['firefox', 'chromium']).default('chromium'),
  tutorialFps: z.number().int().positive().max(60).default(30),
  tutorialSize: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  maxTutorialScenes: z.number().int().positive().max(40).default(10),
  tutorialSubtitles: z.boolean().default(false),
  narrationLang: z.string().optional(),
  headed: z.boolean().default(false),
  viewport: z.union([
    z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    z.null(),
  ]).optional(),
  locatePrompts: z.boolean().default(true),
  requireVideoPrompt: z.boolean().default(true),
  fastevalCandidates: z.number().int().positive().default(25),
  minDurationSec: z.number().int().positive().default(300),
  maxAgeDays: z.number().int().positive().default(183),
  outDir: z.string().optional(),
});

export type FlowTutorPipelineOptions = z.infer<typeof FlowTutorPipelineOptionsSchema> & {
  onProgress?: (stage: PipelineStage, message: string, data?: unknown) => void;
};

export type FlowTutorPipelineInput = z.input<typeof FlowTutorPipelineOptionsSchema> & {
  onProgress?: (stage: PipelineStage, message: string, data?: unknown) => void;
};
import type { EnvCheckSummary, YtbCheckSummary } from '../core/stages.js';
export type { EnvCheckSummary, YtbCheckSummary };

export interface SearchSummary {
  query: string;
  totalDiscovered: number;
  eligibleCount: number;
  rejectedCount: number;
  candidates: VideoCandidate[];
}

export interface StandardSummary {
  standard: EvaluationStandard;
  standardHash: string;
  reused: boolean;
  sourcePath?: string;
  savedPath: string;
  topic: string;
}

export interface EvaluationSummary {
  evaluations: CandidateEvaluation[];
  decision: SelectionDecision;
  winner: VideoCandidate;
  compositeScore: number;
  displayBand: string;
  isSelectable: boolean;
  reason: string;
  fasteval?: FastEvalSummary;
}

export interface FastEvalSummary {
  enabled: boolean;
  gridImagePath: string;
  winnerIndex: number;
  winnerVideoId: string;
  winnerTitle: string;
  winnerStyle?: string;
  reasoning: string;
  candidatesCount: number;
  topCandidates: Array<{
    index: number;
    videoId: string;
    title: string;
    style: string;
    reason: string;
  }>;
}

export interface ExtractedPromptsSummary {
  scenesCount: number;
  sourcePromptsCount?: number;
  videoPromptsCount?: number;
  imagePromptsCount?: number;
  hasVideoPrompts?: boolean;
  hasImagePrompts?: boolean;
  supplementedImagePrompts?: boolean;
  diagnostics?: string;
  segments: Array<{
    segmentId: string;
    title: string;
    startSec: number;
    endSec: number;
    narration: string;
  }>;
}

export interface GeneratedScriptSummary {
  script: FlowVideoScript;
  scriptPath: string;
  totalClips: number;
  totalDurationSec: number;
  aspectRatio: string;
  clips: FlowClipPrompt[];
}

export interface FlowProjectSummary {
  projectId: string | null;
  url: string;
  isNew: boolean;
}

export interface FlowGenerationSummary {
  totalClips: number;
  completedClips: number;
  failedClips: number;
  skippedClips: number;
  dryRun: boolean;
  batchResult?: BatchResult;
  quota?: QuotaSnapshot;
  clipOutputs: Array<{
    clipIndex: number;
    title?: string;
    imagePrompt?: string;
    imageUrl?: string | null;
    localImagePath?: string | null;
    visualPrompt: string;
    status: string;
    videoUrl?: string;
    localVideoPath?: string;
    error?: string;
  }>;
}

export interface FlowTutorPipelineResult {
  runId: string;
  query: string;
  topic: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  stages: Record<string, StageResult>;
  envCheck: EnvCheckSummary;
  ytbCheck: YtbCheckSummary;
  search: SearchSummary;
  standard: StandardSummary;
  evaluation: EvaluationSummary;
  fasteval?: FastEvalSummary;
  extractedPrompts: ExtractedPromptsSummary;
  generatedScript: GeneratedScriptSummary;
  flowProject?: FlowProjectSummary;
  flowGeneration?: FlowGenerationSummary;
  tutorial?: TutorialGenerationSummary;
  reportJsonPath: string;
  reportMarkdownPath: string;
  reportHtmlPath: string;
  manifestPath?: string;
  logFilePath?: string;
  jsonlLogFilePath?: string;
  outDir: string;
}
