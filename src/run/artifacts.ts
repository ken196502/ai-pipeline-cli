import { z } from 'zod';
import {
  ResearchResultSchema, TranscriptSchema, SegmentSchema, EvaluationStandardSchema, SearchResultSchema, MetricFilterResultSchema,
  CandidateEvaluationsSchema, CandidateEvidenceSchema, SelectionDecisionSchema,
  FrameEvidenceSchema, PromptFrameLocatorSchema, PromptFrameRecognitionSchema, PromptRecognitionSchema,
} from '../research/contracts.js';
import { FlowVideoScriptSchema } from '../research/script/contracts.js';
import { BatchResultSchema, FlowProjectSchema } from '../flow/contracts.js';
import { FastEvalDataSchema } from '../research/fasteval/types.js';
import { TutorialStoryboardSchema } from '../tutorial/contracts.js';

// Targeted prompt detection records individual frames without a contact grid.
// The older grid locator still emits PromptFrameLocatorSchema. Retain both formats.
const DetectorLocatorSchema = z.object({
  videoId: z.string().min(1), hasPromptFrame: z.boolean(), analyzedAt: z.string(),
  totalGridsAnalyzed: z.number().int().nonnegative(),
  selectedFrames: z.array(z.object({
    segmentId: z.string().min(1), frameIndex: z.number().int().nonnegative(),
    timestampSec: z.number().nonnegative(), relativeSec: z.number().nonnegative(),
    framePath: z.string().min(1), gridPath: z.string(), confidence: z.number().min(0).max(1), reason: z.string(),
  })),
});

// Contracts only: importing a run never loads a CLI, registry, browser, or executor.
export const artifactSchemas = {
  search: SearchResultSchema,
  filtered: MetricFilterResultSchema,
  research: ResearchResultSchema,
  transcript: TranscriptSchema,
  segments: z.array(SegmentSchema),
  standard: EvaluationStandardSchema,
  evaluations: CandidateEvaluationsSchema,
  evidence: z.array(CandidateEvidenceSchema),
  selection: SelectionDecisionSchema,
  frames: FrameEvidenceSchema,
  promptLocator: z.union([PromptFrameLocatorSchema, DetectorLocatorSchema]),
  // A cached OCR result makes zero new recognition attempts.
  promptRecognition: PromptFrameRecognitionSchema.extend({
    frames: z.array(PromptRecognitionSchema.extend({ attempts: z.number().int().nonnegative() })),
  }),
  script: FlowVideoScriptSchema,
  flow: BatchResultSchema,
  flowProject: FlowProjectSchema,
  storyboard: TutorialStoryboardSchema.passthrough(),
  tutorial: z.object({
    status: z.enum(['completed', 'failed']),
    sceneCount: z.number(), totalDurationSec: z.number(), fps: z.number(),
    resolution: z.object({ width: z.number(), height: z.number() }),
    voice: z.string(), rate: z.string(), narrationLanguage: z.string(), assetsCount: z.number(),
    storyboardPath: z.string(), gridPath: z.string(), timelinePath: z.string(),
    playerPath: z.string(), narrationPath: z.string(), hostScriptPath: z.string(),
    videoPath: z.string(), framesRendered: z.number(), model: z.string().optional(),
    error: z.string().optional(), sceneOutline: z.array(z.any()).optional(),
    clipOutline: z.array(z.any()).optional(),
  }),
  fastEval: FastEvalDataSchema,
};
export type ArtifactKey = keyof typeof artifactSchemas;
export type RunArtifacts = { [K in ArtifactKey]: z.output<(typeof artifactSchemas)[K]> };

export const artifactFilenames: Record<ArtifactKey, string> = {
  search: 'search-result.json', filtered: 'filtered-candidates.json',
  research: 'research-result.json', transcript: 'transcript.json', segments: 'segments.json',
  standard: 'evaluation-standard.json', evaluations: 'candidate-evaluations.json',
  evidence: 'candidate-evidence.json', selection: 'selection-decision.json',
  frames: 'frame-evidence.json', promptLocator: 'prompt-frame-locator.json',
  promptRecognition: 'prompt-frame-recognition.json', script: 'flow-video-script.json',
  flow: 'flow-result.json', flowProject: 'flow-project.json',
  storyboard: '10-tutorial-storyboard.json', tutorial: 'tutorial-result.json',
  fastEval: 'fasteval-data.json',
};

/** Existing report/CLI filenames remain valid during migration. */
export const pipelineArtifactFilenames: Partial<Record<ArtifactKey, string>> = {
  transcript: '4-transcript.json', standard: '5-evaluation-standard.json',
  evaluations: '7-candidate-evaluations.json', evidence: '7-candidate-evidence.json',
  selection: '7-selection-decision.json', segments: '8-segments.json',
  frames: '8-frame-evidence.json', research: '9-research-result.json', script: '9-flow-video-script.json',
};
