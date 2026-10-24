import { z } from 'zod';

export const IsoTimestampSchema = z.string();

export const VideoMetricSchema = z.object({
  viewCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  durationSec: z.number().positive(),
  publishedAt: IsoTimestampSchema,
  viewsPerDay: z.number().nonnegative(),
  engagementRate: z.number().min(0).max(1),
});
export type VideoMetric = z.infer<typeof VideoMetricSchema>;

export const VideoCandidateSchema = z.object({
  videoId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  url: z.string().url(),
  channelId: z.string().min(1),
  channelTitle: z.string().min(1),
  tags: z.array(z.string()),
  language: z.string().min(2),
  metrics: VideoMetricSchema,
  discovery: z
    .object({
      origin: z.enum(['search', 'recommended', 'subscriptions', 'fixture']),
      rank: z.number().int().nonnegative(),
      alsoFoundIn: z.array(z.enum(['search', 'recommended', 'subscriptions'])).optional(),
    })
    .optional(),
  metricsConfidence: z
    .object({
      views: z.boolean(),
      likes: z.boolean(),
      comments: z.boolean(),
    })
    .optional(),
  visualStyle: z.string().optional(),
});
export type VideoCandidate = z.infer<typeof VideoCandidateSchema>;

export const SearchResultSchema = z.object({
  query: z.string().min(1),
  source: z.string().min(1),
  requestedAt: IsoTimestampSchema,
  candidates: z.array(VideoCandidateSchema),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const DiscoverySourceSchema = z.object({
  origin: z.enum(['search', 'recommended', 'subscriptions']),
  url: z.string().url(),
  count: z.number().int().nonnegative(),
});

export const DiscoveryVideoSchema = z.object({
  videoId: z.string().min(1),
  title: z.string().nullable(),
  channelTitle: z.string().nullable(),
  origin: z.enum(['search', 'recommended', 'subscriptions']),
  rank: z.number().int().nonnegative(),
  alsoFoundIn: z.array(z.enum(['search', 'recommended', 'subscriptions'])).default([]),
  lengthText: z.string().nullable().optional(),
  durationSec: z.number().int().positive().nullable().optional(),
});

export const DiscoveryResultSchema = z.object({
  query: z.string().min(1),
  loggedIn: z.boolean(),
  account: z.string().nullable(),
  browser: z.string().min(1).optional(),
  collectedAt: IsoTimestampSchema,
  sources: z.array(DiscoverySourceSchema),
  videos: z.array(DiscoveryVideoSchema),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

export const SubtitleFileSchema = z.object({
  language: z.string().min(2),
  kind: z.enum(['manual', 'auto']),
  format: z.string().min(1),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64).optional(),
});
export type SubtitleFile = z.infer<typeof SubtitleFileSchema>;

export const SubtitleResultSchema = z.object({
  videoId: z.string().min(1),
  requestedLangs: z.array(z.string().min(1)),
  chosen: SubtitleFileSchema,
  available: z.array(SubtitleFileSchema),
  downloadedAt: IsoTimestampSchema,
});
export type SubtitleResult = z.infer<typeof SubtitleResultSchema>;

export const MetricThresholdsSchema = z.object({
  minDurationSec: z.number().nonnegative(),
  maxAgeDays: z.number().positive(),
});
export type MetricThresholds = z.infer<typeof MetricThresholdsSchema>;

export const DEFAULT_THRESHOLDS: MetricThresholds = {
  minDurationSec: 300, // 5 minutes
  maxAgeDays: 180, // half a year (approx. 6 months / 180 days)
};

export const MetricFilterResultSchema = z.object({
  query: z.string().min(1),
  thresholds: MetricThresholdsSchema,
  kept: z.array(VideoCandidateSchema),
  rejected: z.array(
    z.object({ videoId: z.string().min(1), reason: z.string().min(1) }),
  ),
});
export type MetricFilterResult = z.infer<typeof MetricFilterResultSchema>;

export const ResearchScoreSchema = z.object({
  videoId: z.string().min(1),
  relevance: z.number().min(0).max(10),
  clarity: z.number().min(0).max(10),
  structure: z.number().min(0).max(10),
  reusability: z.number().min(0).max(10),
  total: z.number().min(0).max(100),
  rationale: z.string().min(1),
});
export type ResearchScore = z.infer<typeof ResearchScoreSchema>;

export const ScoredVideosSchema = z.object({
  model: z.string().min(1),
  scoredAt: IsoTimestampSchema,
  scores: z.array(ResearchScoreSchema),
});
export type ScoredVideos = z.infer<typeof ScoredVideosSchema>;

export const TranscriptCueSchema = z.tuple([
  z.number().nonnegative(), // startSec
  z.number().nonnegative(), // endSec
  z.string().min(1), // text
]);
export type TranscriptCue = [startSec: number, endSec: number, text: string];

export const TranscriptSchema = z.object({
  videoId: z.string().min(1),
  language: z.string().min(2),
  source: z.enum(['manual', 'auto']),
  cues: z.array(TranscriptCueSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const SegmentSchema = z
  .object({
    segmentId: z.string().min(1),
    index: z.number().int().nonnegative(),
    title: z.string().min(1),
    summary: z.string().min(1),
    hasNarration: z.boolean().default(false),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    durationSec: z.number().positive(),
    cueStart: z.number().int().nonnegative(),
    cueEnd: z.number().int().nonnegative(),
  })
  .refine((s) => s.cueEnd >= s.cueStart, {
    message: 'cueEnd must be >= cueStart',
    path: ['cueEnd'],
  });
export type Segment = z.infer<typeof SegmentSchema>;

export const SegmentsResultSchema = z.object({
  videoId: z.string().min(1),
  targetSegmentSeconds: z.number().positive(),
  hasNarration: z.boolean().default(false),
  segments: z.array(SegmentSchema),
});
export type SegmentsResult = z.infer<typeof SegmentsResultSchema>;

export const FrameSchema = z.object({
  segmentId: z.string().min(1),
  timestampSec: z.number().nonnegative(),
});
export type Frame = z.infer<typeof FrameSchema>;

export const FrameStripSchema = z.object({
  segmentId: z.string().min(1),
  path: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});
export type FrameStrip = z.infer<typeof FrameStripSchema>;

export const FramesResultSchema = z.object({
  videoId: z.string().min(1),
  frames: z.array(FrameSchema),
  strips: z.array(FrameStripSchema),
});
export type FramesResult = z.infer<typeof FramesResultSchema>;

export const ScoringCriteriaSchema = z.object({
  '1': z.string().min(1),
  '2': z.string().min(1),
  '3': z.string().min(1),
  '4': z.string().min(1),
  '5': z.string().min(1),
});
export type ScoringCriteria = z.infer<typeof ScoringCriteriaSchema>;

export const QualitativeDimensionSchema = z.object({
  dimension: z.string().min(1),
  description: z.string(),
  scoringCriteria: ScoringCriteriaSchema,
});
export type QualitativeDimension = z.infer<typeof QualitativeDimensionSchema>;

export const EvaluationDimensionRequirementSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['critical', 'high', 'medium']).optional(),
  scoringGuidelines: z
    .object({
      high: z.string().optional(),
      low: z.string().optional(),
    })
    .optional(),
});
export type EvaluationDimensionRequirement = z.infer<typeof EvaluationDimensionRequirementSchema>;

export const EvaluationRequirementsSchema = z.object({
  pipelineId: z.string().optional(),
  coreObjective: z.string().optional(),
  requiredDimensions: z.array(EvaluationDimensionRequirementSchema).optional(),
  targetTraits: z.array(z.string()).optional(),
  negativeFilters: z.array(z.string()).optional(),
  customDirectives: z.string().optional(),
});
export type EvaluationRequirements = z.infer<typeof EvaluationRequirementsSchema>;

export const MetricKeySchema = z.enum([
  'viewCount',
  'likeCount',
  'commentCount',
  'durationSec',
  'viewsPerDay',
  'engagementRate',
]);
export type MetricKey = z.infer<typeof MetricKeySchema>;

export const QuantitativeDimensionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  metricKey: MetricKeySchema.nullable(),
  unit: z.string().nullable(),
  direction: z.enum(['higher-better', 'lower-better']).nullable(),
  resolved: z.boolean(),
});
export type QuantitativeDimension = z.infer<typeof QuantitativeDimensionSchema>;

export const ScoreBandSchema = z.object({
  band: z.string().min(1),
  range: z.string().min(1),
  min: z.number().min(1).max(5),
  max: z.number().min(1).max(5),
  description: z.string(),
});
export type ScoreBand = z.infer<typeof ScoreBandSchema>;

export const CompositeGuidanceSchema = z.object({
  overallInterpretation: z.array(ScoreBandSchema),
  evaluationPitfalls: z.array(z.string()),
});
export type CompositeGuidance = z.infer<typeof CompositeGuidanceSchema>;

export const EvaluationStandardSchema = z
  .object({
    meta: z.object({
      query: z.string().min(1),
      candidateContextHash: z.string().length(64),
      topic: z.string().min(1),
      language: z.string().min(2),
      generatedAt: IsoTimestampSchema,
      version: z.string().min(1),
      promptVersion: z.string().min(1),
      model: z.string().min(1),
      standardHash: z.string().length(64),
      source: z.enum(['generated', 'cache', 'fixture']),
      pipeline: z.array(z.string().min(1)).min(1),
    }),
    quantitativeDimensions: z.array(QuantitativeDimensionSchema),
    unresolvedQuantitativeDimensions: z.array(z.string()),
    qualitativeEvaluation: z.object({
      equalWeights: z.record(z.string(), z.number().int().min(0).max(100)),
      dimensions: z.array(QualitativeDimensionSchema).min(1),
      compositeGuidance: CompositeGuidanceSchema,
    }),
  });
export type EvaluationStandard = z.infer<typeof EvaluationStandardSchema>;

export const QuantitativeEvidenceSchema = z.object({
  metricKey: MetricKeySchema,
  label: z.string().min(1),
  value: z.number(),
  unit: z.string(),
  source: z.enum(['yt-dlp', 'derived', 'fixture']),
  confident: z.boolean(),
});
export type QuantitativeEvidence = z.infer<typeof QuantitativeEvidenceSchema>;

export const TranscriptEvidenceSchema = z.object({
  available: z.boolean(),
  language: z.string().nullable(),
  source: z.enum(['manual', 'auto']).nullable(),
  cueCount: z.number().int().nonnegative(),
  cues: z.array(TranscriptCueSchema),
  cachePath: z.string().nullable(),
  sha256: z.string().length(64).nullable(),
  failureReason: z.string().nullable(),
});
export type TranscriptEvidence = z.infer<typeof TranscriptEvidenceSchema>;

export const CandidateEvidenceSchema = z.object({
  videoId: z.string().min(1),
  title: z.string().min(1),
  channelTitle: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
  metrics: VideoMetricSchema,
  quantitative: z.array(QuantitativeEvidenceSchema),
  transcript: TranscriptEvidenceSchema,
  evidenceCoverage: z.number().min(0).max(1),
  missingReasons: z.array(z.string()),
  selectable: z.boolean(),
});
export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;

export const NotEvaluatedSchema = z.object({
  videoId: z.string().min(1),
  reason: z.enum(['pool_limit', 'evidence_failed', 'evaluation_failed']),
  detail: z.string(),
});
export type NotEvaluated = z.infer<typeof NotEvaluatedSchema>;

export const EvaluationPoolSchema = z.object({
  pool: z.array(VideoCandidateSchema),
  notEvaluated: z.array(NotEvaluatedSchema),
});
export type EvaluationPool = z.infer<typeof EvaluationPoolSchema>;

export const EvaluationEvidenceSchema = z.object({
  standardHash: z.string().length(64),
  collectedAt: IsoTimestampSchema,
  policy: z.object({
    poolSize: z.number().int().positive(),
    requireTranscript: z.boolean(),
    minEvidenceCoverage: z.number().min(0).max(1),
  }),
  candidates: z.array(CandidateEvidenceSchema),
  notEvaluated: z.array(NotEvaluatedSchema),
});
export type EvaluationEvidence = z.infer<typeof EvaluationEvidenceSchema>;

export const DimensionScoreSchema = z.object({
  dimension: z.string().min(1),
  score: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
  evidence: z.array(z.string()),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

export const CandidateEvaluationSchema = z.object({
  videoId: z.string().min(1),
  standardHash: z.string().length(64),
  dimensionScores: z.array(DimensionScoreSchema).min(1),
  compositeScore: z.number().min(1).max(5),
  displayBand: z.string().min(1),
  evidenceCoverage: z.number().min(0).max(1),
  selectable: z.boolean(),
  model: z.string().min(1),
  evaluatedAt: IsoTimestampSchema,
});
export type CandidateEvaluation = z.infer<typeof CandidateEvaluationSchema>;

export const CandidateEvaluationsSchema = z.object({
  standardHash: z.string().length(64),
  model: z.string().min(1),
  evaluatedAt: IsoTimestampSchema,
  dimensionCount: z.number().int().positive(),
  evaluations: z.array(CandidateEvaluationSchema),
  failures: z.array(
    z.object({
      videoId: z.string().min(1),
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
  notEvaluated: z.array(NotEvaluatedSchema),
});
export type CandidateEvaluations = z.infer<typeof CandidateEvaluationsSchema>;

export const SELECTION_POLICY_VERSION = 'research-selection-v2';

export const SelectionDecisionSchema = z.object({
  policyVersion: z.string().min(1),
  standardHash: z.string().length(64),
  selectedVideoId: z.string().min(1),
  reason: z.string().min(1),
  ranking: z.array(
    z.object({
      videoId: z.string().min(1),
      compositeScore: z.number().min(1).max(5),
      evidenceCoverage: z.number().min(0).max(1),
      viewsPerDay: z.number().nonnegative(),
      selectable: z.boolean(),
    }),
  ),
  runnersUp: z
    .array(
      z.object({
        videoId: z.string().min(1),
        compositeScore: z.number().min(1).max(5),
        displayBand: z.string().min(1),
      }),
    )
    .max(3),
  rejected: z.array(z.object({ videoId: z.string().min(1), reason: z.string().min(1) })),
  notEvaluated: z.array(NotEvaluatedSchema),
  decidedAt: IsoTimestampSchema,
});
export type SelectionDecision = z.infer<typeof SelectionDecisionSchema>;

export const SelectedVideoSchema = z.object({
  video: VideoCandidateSchema,
  score: ResearchScoreSchema,
  runnersUp: z.array(z.object({ videoId: z.string().min(1), total: z.number() })),
  standardHash: z.string().length(64).optional(),
  evaluation: CandidateEvaluationSchema.optional(),
  decision: SelectionDecisionSchema.optional(),
});
export type SelectedVideo = z.infer<typeof SelectedVideoSchema>;

export const SelectedVideoMediaSchema = z.object({
  videoId: z.string().min(1),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  container: z.string().min(1),
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  source: z.enum(['yt-dlp', 'cache', 'fixture']),
  downloadedAt: IsoTimestampSchema,
});
export type SelectedVideoMedia = z.infer<typeof SelectedVideoMediaSchema>;

export const SampleSourceSchema = z.enum(['scene', 'uniform', 'hint']);
export type SampleSource = z.infer<typeof SampleSourceSchema>;

export const FrameTableEntrySchema = z.object({
  frameIndex: z.number().int().nonnegative(),
  timestampSec: z.number().nonnegative(),
  relativeSec: z.number().nonnegative(),
  timestamp: z.string().min(1),
  sampleSource: SampleSourceSchema,
});
export type FrameTableEntry = z.infer<typeof FrameTableEntrySchema>;

export const FrameGridSchema = z.object({
  segmentId: z.string().min(1),
  path: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64).optional(),
  frames: z.array(FrameTableEntrySchema).min(1),
});
export type FrameGrid = z.infer<typeof FrameGridSchema>;

export const SegmentFrameEvidenceSchema = z.object({
  segmentId: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  sampledCount: z.number().int().nonnegative(),
  deduplicatedCount: z.number().int().nonnegative(),
  sceneFallback: z.boolean(),
  grid: FrameGridSchema,
});
export type SegmentFrameEvidence = z.infer<typeof SegmentFrameEvidenceSchema>;

export const FrameEvidenceSchema = z.object({
  videoId: z.string().min(1),
  provider: z.string().min(1),
  media: SelectedVideoMediaSchema.nullable(),
  sampling: z.object({
    maxFrames: z.number().int().positive(),
    minFrames: z.number().int().positive(),
    maxGridSize: z.number().int().positive(),
    sceneThreshold: z.number().min(0).max(1),
    sceneTimestamps: z.number().int().nonnegative(),
    sceneFallback: z.boolean(),
  }),
  segments: z.array(SegmentFrameEvidenceSchema).min(1),
  generatedAt: IsoTimestampSchema,
});
export type FrameEvidence = z.infer<typeof FrameEvidenceSchema>;

export const PromptFrameLocationSchema = z.object({
  segmentId: z.string().min(1),
  found: z.boolean(),
  frameIndex: z.number().int().nonnegative().nullable(),
  timestampSec: z.number().nonnegative().nullable(),
  relativeSec: z.number().nonnegative().nullable(),
  timestamp: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  visibleText: z.string(),
  reason: z.string(),
  gridPath: z.string().min(1),
  frameCount: z.number().int().positive(),
  attempts: z.number().int().positive(),
});
export type PromptFrameLocation = z.infer<typeof PromptFrameLocationSchema>;

export const PromptFrameLocatorSchema = z.object({
  videoId: z.string().min(1),
  model: z.string().min(1),
  locatedAt: IsoTimestampSchema,
  segments: z.array(PromptFrameLocationSchema),
  selectedFrames: z.array(
    z.object({
      segmentId: z.string().min(1),
      frameIndex: z.number().int().nonnegative(),
      timestampSec: z.number().nonnegative(),
      relativeSec: z.number().nonnegative(),
      timestamp: z.string().min(1),
      confidence: z.number().min(0).max(1),
      framePath: z.string().min(1),
      gridPath: z.string().min(1),
    }),
  ),
  hasPromptFrame: z.boolean(),
});
export type PromptFrameLocator = z.infer<typeof PromptFrameLocatorSchema>;

export const PromptTypeSchema = z.enum(['image', 'video']);
export type PromptType = z.infer<typeof PromptTypeSchema>;

/**
 * UI description extracted by the VL model alongside the prompt text:
 * the tool interface shown in the frame — sidebar / menu items and the main
 * content area — so downstream UI demos can model the real tool layout.
 */
export const UiDescriptionSchema = z.object({
  summary: z.string().default(''),
  /** Sidebar / navigation menu items visible in the interface. */
  sidebar: z.array(z.string()).default([]),
  /** Description of the main (center) content area of the interface. */
  mainContent: z.string().default(''),
});
export type UiDescription = z.infer<typeof UiDescriptionSchema>;

export const EMPTY_UI_DESCRIPTION: UiDescription = { summary: '', sidebar: [], mainContent: '' };

/** Channel / creator identity recognized by the VL model (频道识别). */
export const ChannelRefSchema = z.object({
  name: z.string().default(''),
  /** @handle when visible (without or with the @). */
  handle: z.string().default(''),
  /** youtube | tiktok | '' (unknown). */
  platform: z.string().default(''),
});
export type ChannelRef = z.infer<typeof ChannelRefSchema>;

export const EMPTY_CHANNEL_REF: ChannelRef = { name: '', handle: '', platform: '' };

export const OrientationSchema = z.enum(['portrait', 'landscape']);
export type Orientation = z.infer<typeof OrientationSchema>;

export const PromptRecognitionSchema = z.object({
  segmentId: z.string().min(1),
  frameIndex: z.number().int().nonnegative(),
  timestampSec: z.number().nonnegative(),
  relativeSec: z.number().nonnegative(),
  framePath: z.string().min(1),
  found: z.boolean(),
  prompt: z.string(),
  promptType: PromptTypeSchema.default('image'),
  orientation: OrientationSchema.optional(),
  language: z.string().min(1),
  confidence: z.number().min(0).max(1),
  isComplete: z.boolean(),
  visibleText: z.string(),
  uiContext: z.string(),
  uiDescription: UiDescriptionSchema.default(EMPTY_UI_DESCRIPTION),
  channel: ChannelRefSchema.default(EMPTY_CHANNEL_REF),
  /** Narration / voiceover script (旁白稿) extracted from the UI if present. */
  narration: z.string().default(''),
  settings: z.array(z.string()),
  notes: z.string(),
  attempts: z.number().int().positive(),
});
export type PromptRecognition = z.infer<typeof PromptRecognitionSchema>;

export const PromptFrameRecognitionSchema = z.object({
  videoId: z.string().min(1),
  model: z.string().min(1),
  recognizedAt: IsoTimestampSchema,
  frames: z.array(PromptRecognitionSchema),
});
export type PromptFrameRecognition = z.infer<typeof PromptFrameRecognitionSchema>;

export const ResearchRequestSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  query: z.string().min(1),
  topic: z.string().min(1),
  language: z.string().min(2),
  maxCandidates: z.number().int().positive(),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const VlExtractedPromptSchema = z.object({
  prompt: z.string().min(1),
  promptType: PromptTypeSchema,
  orientation: OrientationSchema.optional(),
  uiContext: z.string(),
  uiDescription: UiDescriptionSchema.optional(),
  channel: ChannelRefSchema.optional(),
  /** Narration / voiceover script (旁白稿) extracted from the UI if present. */
  narration: z.string().default(''),
  confidence: z.number().min(0).max(1),
  settings: z.array(z.string()),
});
export type VlExtractedPrompt = z.infer<typeof VlExtractedPromptSchema>;

export const ResearchResultSchema = z.object({
  runId: z.string().min(1),
  query: z.string().min(1),
  topic: z.string().min(1),
  candidateCount: z.number().int().nonnegative(),
  filteredCount: z.number().int().nonnegative(),
  selected: VideoCandidateSchema,
  selectedScore: ResearchScoreSchema,
  transcript: TranscriptSchema,
  hasNarration: z.boolean().default(false),
  segments: z.array(SegmentSchema),
  frames: z.array(FrameSchema),
  strips: z.array(FrameStripSchema),
  vlPrompts: z.array(VlExtractedPromptSchema).optional(),
  detectedOrientation: OrientationSchema.optional(),
  orientationVotes: z.object({
    portrait: z.number().int().nonnegative(),
    landscape: z.number().int().nonnegative(),
  }).optional(),
  standardHash: z.string().length(64).optional(),
  standard: EvaluationStandardSchema.optional(),
  selectedEvaluation: CandidateEvaluationSchema.optional(),
  selectionDecision: SelectionDecisionSchema.optional(),
  visualStyle: z.string().optional(),
  createdAt: IsoTimestampSchema,
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

// Flow Video Script Subsystem Contracts
export * from './script/contracts.js';
