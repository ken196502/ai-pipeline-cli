/**
 * Standalone Production YouTube Research Pipeline.
 *
 * Orchestrates multi-stage video candidate research:
 * 1. Candidate Adoption from the FastEval browser search + VL top-3 shortlist
 * 2. Metric Pre-Filtering (pass-through under FastEval)
 * 3. Evaluation Standard Generation with SHA-256 Digest
 * 4. Evaluation Pool Selection (transcript fallback candidates)
 * 5. FastEval Shortlist Incorporation (VL-ranked top 3 → contract evaluations)
 * 6. Winner Transcript Resolution via persistent-profile browser
 * 7. Transcript Segmentation (~120s Contiguous Scenes)
 * 8. Video Media Download, ffprobe Probe, & ffmpeg Scene Frame Grids
 * 9. Complete ResearchResult Assembly and Artifact Persistence
 *
 * The legacy per-candidate rubric scoring path (subtitle evidence + LLM scorer +
 * deterministic selector) has been removed: FastEval IS the evaluation.
 */
import fs from 'node:fs/promises';
import { RunContext, artifactFilenames } from '../run/index.js';
import { researchOptionsFromRun, type ResearchServices } from './run-options.js';
import path from 'node:path';
import {
  type CandidateEvaluation,
  type CandidateEvaluations,
  type CandidateEvidence,
  type EvaluationRequirements,
  type EvaluationStandard,
  type FrameEvidence,
  type FramesResult,
  type MetricFilterResult,
  type PromptFrameLocator,
  type PromptFrameRecognition,
  type ResearchResult,
  type ResearchScore,
  type SearchResult,
  type Segment,
  type SelectedVideo,
  type SelectionDecision,
  type Transcript,
  type VideoCandidate,
  type VlExtractedPrompt,
  ResearchResultSchema,
} from './contracts.js';
import { AppError, ErrorCodes } from './errors.js';
import {
  generateEvaluationStandard,
  verifyStandardHash,
  resolveLlmModel,
  formatEvaluationRequirements,
} from './evaluation/standard.js';
import { buildSegments } from './media/segments.js';
import { collectFrameEvidence, probeVideo } from './media/frames.js';
import { locateAndRecognizePrompts } from './media/locator.js';
import { runPromptDetector } from './media/prompt-detector.js';
import { generateScriptFromRun } from './script/run.js';
import { type FlowVideoScript } from './script/contracts.js';
import { nowIso } from './utils/time.js';
import { getEnvConfig } from '../env.js';
import { createRunLogger, RunLogger } from '../utils/logger.js';
import { isLlmUnavailableError, notifyLlmUnavailableAndExit } from '../utils/send_msg.js';
import { chooseEvaluationPool } from './youtube/evidence.js';
import {
  parseViewCount,
  parsePublishedDaysAgo,
  parseFlexibleDurationSeconds,
} from './youtube/view-count.js';
import { DEFAULT_THRESHOLDS, type MetricThresholds } from './youtube/filter.js';
import { downloadVideo } from './youtube/ytdlp.js';
import { downloadTranscriptViaBrowser } from './youtube/browser-transcript.js';
import { downloadTranscriptViaYtDlpCdp } from './youtube/ytdlp-cdp.js';
import { validateReferenceVideoQuality } from './youtube/reference-validation.js';
import type { FastEvalData } from './fasteval/types.js';
import { parseDurationSeconds } from './fasteval/browser-search.js';
export * from './fasteval/index.js';

export interface ResearchPipelineOptions {
  query: string;
  topic?: string;
  language?: string;
  maxCandidates?: number;
  outputDir?: string;
  cookiePath?: string | null;
  proxyUrl?: string | null;
  model?: string;
  metricThresholds?: Partial<MetricThresholds>;
  evaluationPoolSize?: number;
  evaluationFocus?: string;
  evaluationRequirements?: EvaluationRequirements | string;
  skipMediaDownload?: boolean;
  minFrames?: number;
  maxFrames?: number;
  sceneThreshold?: number;
  locatePrompts?: boolean;
  generateFlowScript?: boolean;
  /**
   * When true, abort with NO_VIDEO_PROMPT_FOUND if no AI generation prompts could be
   * extracted from any candidate video. When false (default), continue with
   * transcript-synthesized prompts so the pipeline layer can apply its own policy.
   */
  requireVideoPrompt?: boolean;
  clipDuration?: 4 | 6 | 8 | 10;
  aspectRatio?: 'landscape' | 'portrait';
  scriptModel?: string;
  useLlmForScript?: boolean;
  existingStandard?: EvaluationStandard;
  /** Mandatory FastEval output (browser search + VL top-3 shortlist). Run FastEval before this pipeline. */
  fastEvalResult: FastEvalData;
  now?: () => Date;
  onProgress?: (stage: string, detail?: string) => void;
  /** Called when yt-dlp hits bot detection or cookie errors. Should refresh cookies via CDP browser and return the new cookie file path, or null if refresh failed. */
  refreshCookies?: () => Promise<string | null>;
  /** Optional stage-prefixed artifact filenames (e.g. { 'segments.json': '8-segments.json' }) */
  artifactPrefixes?: Record<string, string>;
  /** Optional persistent transcript storage for caching and reusing cleaned transcripts across runs */
  transcriptStorage?: {
    loadTranscript: (videoId: string, language?: string) => Promise<Transcript | null>;
    saveTranscript: (transcript: Transcript) => Promise<string | void>;
  };
  /** Optional persistent video media storage for caching and reusing yt-dlp downloaded candidate videos */
  videoStorage?: {
    findVideo: (videoId: string) => Promise<string | null>;
    saveVideo: (videoId: string, sourcePath: string) => Promise<string | void>;
    removeVideo?: (videoId: string) => Promise<boolean>;
  };
}

export interface ResearchPipelineExecution {
  runId: string;
  outputDir: string;
  logPath: string;
  jsonlLogPath: string;
  search: SearchResult;
  filtered: MetricFilterResult;
  standard: EvaluationStandard;
  evidence: CandidateEvidence[];
  evaluations: CandidateEvaluations;
  selection: { selected: SelectedVideo; decision: SelectionDecision };
  transcript: Transcript;
  segments: Segment[];
  frameEvidence?: FrameEvidence;
  framesResult?: FramesResult;
  promptLocator?: PromptFrameLocator;
  promptRecognition?: PromptFrameRecognition;
  result: ResearchResult;
  flowScript?: FlowVideoScript;
}

export const RESEARCH_RESULT_FILENAME = 'research-result.json';
export const FLOW_VIDEO_SCRIPT_FILENAME = 'flow-video-script.json';
export const EVALUATION_STANDARD_FILENAME = 'evaluation-standard.json';
export const CANDIDATE_EVALUATIONS_FILENAME = 'candidate-evaluations.json';
export const SELECTION_DECISION_FILENAME = 'selection-decision.json';
export const CANDIDATE_EVIDENCE_FILENAME = 'candidate-evidence.json';
export const FRAME_EVIDENCE_FILENAME = 'frame-evidence.json';
export const PROMPT_FRAME_LOCATOR_FILENAME = 'prompt-frame-locator.json';
export const PROMPT_FRAME_RECOGNITION_FILENAME = 'prompt-frame-recognition.json';
export const TRANSCRIPT_FILENAME = 'transcript.json';
export const SEGMENTS_FILENAME = 'segments.json';
export const RUN_LOG_FILENAME = 'run.log';
export const RUN_JSONL_FILENAME = 'run.jsonl';

/**
 * Projects a 1-5 composite FastEval evaluation onto the legacy 0-100 ResearchScore.
 * FastEval dimensions carry the VL shortlist reason, so every sub-score uses the
 * composite projection (dimension names are not English relevance/clarity keys).
 */
function fastEvalToLegacyScore(evaluation: CandidateEvaluation): ResearchScore {
  const composite = evaluation.compositeScore;
  const sub = Math.min(10, Math.max(0, Math.round(composite * 2)));
  return {
    videoId: evaluation.videoId,
    relevance: sub,
    clarity: sub,
    structure: sub,
    reusability: sub,
    total: Math.round(((composite - 1) / 4) * 100),
    rationale: evaluation.dimensionScores[0]?.rationale || `FastEval composite ${composite}/5`,
  };
}

/**
 * Runs the complete research pipeline end-to-end.
 */
export async function runResearchPipeline(
  input: ResearchPipelineOptions | RunContext,
  services: ResearchServices = {},
): Promise<ResearchPipelineExecution> {
  const parentRun = input instanceof RunContext ? input : undefined;
  const options = parentRun ? await researchOptionsFromRun(parentRun, services) : input as ResearchPipelineOptions;
  const {
    query,
    topic: requestedTopic,
    language = 'en',
    maxCandidates = 15,
    outputDir,
    cookiePath,
    proxyUrl,
    model,
    metricThresholds,
    evaluationPoolSize = 5,
    evaluationFocus,
    skipMediaDownload = false,
    minFrames,
    maxFrames,
    sceneThreshold,
    locatePrompts = true,
    generateFlowScript = true,
    requireVideoPrompt = true,
    clipDuration = 4,
    aspectRatio = 'landscape',
    scriptModel = 'lite',
    useLlmForScript = true,
    now = () => new Date(),
    onProgress,
    refreshCookies,
    artifactPrefixes,
  } = options;

  const resolveArtifactName = (baseName: string): string =>
    artifactPrefixes?.[baseName] ?? baseName;

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Query parameter cannot be empty',
      stage: 'research',
      task: 'validate-input',
      retryable: false,
    });
  }

  // FastEval is the evaluation: the pipeline cannot run without a VL shortlist.
  if (!options.fastEvalResult) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'FastEval result is required: run browser FastEval (search + VL top-3 selection) before the research pipeline',
      stage: 'research',
      task: 'validate-input',
      retryable: false,
    });
  }
  const fastEvalResult = options.fastEvalResult;

  const filenames = Object.fromEntries(Object.entries(artifactFilenames).map(([key, name]) => [key, resolveArtifactName(name)]));
  const { existingStandard: _standard, fastEvalResult: _fastEval, transcriptStorage: _transcripts, videoStorage: _videos, ...config } = options;
  const run = parentRun || await RunContext.create({
    pipelineId: 'research', outDir: outputDir, filenames,
    config: { ...config, query: trimmedQuery, language, maxCandidates, evaluationPoolSize,
      skipMediaDownload, locatePrompts, generateFlowScript, clipDuration, aspectRatio, scriptModel, useLlmForScript },
  });
  const runId = run.runId;
  const effectiveOutputDir = run.outDir;
  const researchStarted = Date.now();
  await run.recordStage({ stage: 'research', status: 'in_progress', durationMs: 0 });

  const logger = createRunLogger({
    runId,
    logDir: effectiveOutputDir,
    title: 'VIDEO RESEARCH PIPELINE RUN LOG',
    logFileName: RUN_LOG_FILENAME,
    jsonlFileName: RUN_JSONL_FILENAME,
    onLog: (entry) => {
      if (entry.level === 'STAGE' && onProgress) {
        onProgress(entry.stage || 'stage', entry.message);
      }
    },
  });

  const report = (stage: string, detail?: string) => {
    logger.stage(stage, detail || `Stage ${stage}`);
  };

  try {
    logger.info(`Starting YouTube Research Pipeline`, {
      runId,
      query: trimmedQuery,
      requestedTopic,
      language,
      maxCandidates,
      evaluationPoolSize,
      skipMediaDownload,
      outputDir: effectiveOutputDir,
    });

    // Pre-flight check: Verify LLM configuration upfront
    const envConfig = getEnvConfig();
    if (!envConfig.baseUrl || !envConfig.apiKey) {
      const err = new AppError({
        code: ErrorCodes.LLM_REQUEST_FAILED,
        message: 'LLM base URL or API key is not configured in environment (.env). Execution aborted immediately without fallbacks.',
        stage: 'research',
        task: 'verify-llm',
        retryable: false,
      });
      logger.error(err.message, err);
      await notifyLlmUnavailableAndExit(err, { stage: 'research', task: 'verify-llm', context: 'Pre-flight LLM Check' });
    }

    // 1. Sourcing & Discovery
    report('search', `Stage 1/10: Sourcing YouTube candidates for: "${trimmedQuery}"`);
    logger.info(`Initiating search with maxCandidates=${maxCandidates}`);

    let activeCookiePath = cookiePath;
    report('search', `Stage 1/10: [FastEval] Discovered ${fastEvalResult.candidates.length} candidates via browser YouTube search`);
    const search: SearchResult = {
      query: trimmedQuery,
      source: 'browser-fasteval',
      requestedAt: fastEvalResult.evaluatedAt,
      candidates: fastEvalResult.candidates.map((c) => {
          const views =
            c.viewCount ??
            (c.viewCountText ? parseViewCount(c.viewCountText) ?? undefined : undefined) ??
            0;
          const daysAgo =
            c.publishedDaysAgo ??
            (c.publishedTimeText ? parsePublishedDaysAgo(c.publishedTimeText) ?? undefined : undefined) ??
            30;
          const viewsPerDay =
            c.viewsPerDay ??
            (views > 0 && daysAgo > 0 ? Math.round(views / daysAgo) : 0);
          const durSec =
            c.durationSec ??
            parseDurationSeconds(c.durationText) ??
            parseFlexibleDurationSeconds(c.durationText) ??
            180;

          return {
            videoId: c.videoId,
            title: c.title,
            description: `Discovered via browser FastEval for "${trimmedQuery}"`,
            url: c.url,
            channelId: c.channelTitle.toLowerCase().replace(/[^a-z0-9]/g, '_') || 'unknown',
            channelTitle: c.channelTitle,
            tags: [trimmedQuery, 'viral', 'fasteval'],
            language: language || 'en',
            metrics: {
              viewCount: views,
              likeCount: 0,
              commentCount: 0,
              durationSec: durSec,
              publishedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
              viewsPerDay,
              engagementRate: 0,
            },
            metricsConfidence: {
              views: views > 0,
              likes: false,
              comments: false,
            },
            discovery: {
              origin: 'search' as const,
              rank: c.index,
            },
          };
        }),
      };

    logger.info(`Discovered ${search.candidates.length} candidates from YouTube`, {
      count: search.candidates.length,
      candidates: search.candidates.map((c) => ({
        videoId: c.videoId,
        title: c.title,
        channel: c.channelTitle,
        views: c.metrics.viewCount,
        durationSec: c.metrics.durationSec,
        viewsPerDay: Math.round(c.metrics.viewsPerDay),
      })),
    });

    // 2. Metric Pre-Filtering
    report('filter', `Stage 2/10: Metric Pre-Filtering across ${search.candidates.length} candidates`);
    const mergedThresholds: MetricThresholds = {
      ...DEFAULT_THRESHOLDS,
      ...metricThresholds,
    };

    logger.info('Applying metric filter thresholds', { thresholds: mergedThresholds });

    await run.write('search', search);
    // FastEval browser search already applies its own minimum bar
    // (duration / recency), so metric pre-filtering is a pass-through.
    const filtered: MetricFilterResult = {
      query: trimmedQuery,
      thresholds: {
        minDurationSec: mergedThresholds.minDurationSec ?? 30,
        maxAgeDays: mergedThresholds.maxAgeDays ?? 365,
      },
      kept: search.candidates,
      rejected: [],
    };
    logger.info(`FastEval candidates adopted: ${filtered.kept.length} kept`);

    await run.write('filtered', filtered);

    // 3. Evaluation Standard Generation or Adoption
    let standard: EvaluationStandard;
    if (options.existingStandard) {
      report('standard', 'Stage 3/10: Adopting and verifying existing evaluation standard');
      const valid = verifyStandardHash(options.existingStandard);
      if (!valid) {
        throw new AppError({
          code: ErrorCodes.EVALUATION_STANDARD_INVALID,
          message: 'Existing standard failed canonical SHA-256 hash verification',
          stage: 'research',
          task: 'standard-verify',
          retryable: false,
        });
      }
      standard = options.existingStandard;
      logger.info('Successfully verified and adopted existing evaluation standard', {
        standardHash: standard.meta.standardHash,
        topic: standard.meta.topic,
      });
    } else {
      report('standard', 'Stage 3/10: Distilling canonical evaluation standard and 1-5 scoring rubrics');
      standard = await generateEvaluationStandard({
        query: trimmedQuery,
        candidates: filtered.kept,
        language,
        model: resolveLlmModel(model),
        evaluationFocus,
        evaluationRequirements: options.evaluationRequirements,
        now,
      });
    }

    await run.write('standard', standard);
    const resolvedTopic = requestedTopic || standard.meta.topic;
    logger.info(`Evaluation standard distilled for topic: "${resolvedTopic}"`, {
      standardHash: standard.meta.standardHash,
      model: standard.meta.model,
      qualitativeDimensions: standard.qualitativeEvaluation.dimensions.map((d) => d.dimension),
      equalWeights: standard.qualitativeEvaluation.equalWeights,
      quantitativeDimensions: standard.quantitativeDimensions.map((d) => d.name),
    });

    // 4. Candidate Evidence Collection & Subtitle Track Selection
    report('evidence-pool', `Stage 4/10: Selecting bounded evaluation pool (max ${evaluationPoolSize})`);
    const poolResult = chooseEvaluationPool(filtered.kept, evaluationPoolSize);
    logger.info(`Evaluation pool selected: ${poolResult.pool.length} candidate(s)`, {
      pool: poolResult.pool.map((c) => `"${c.title}" by ${c.channelTitle} [${c.videoId}]`),
      notEvaluated: poolResult.notEvaluated,
    });

    // Evidence collection belonged to the removed rubric-scoring path; the
    // candidate-evidence artifact is kept as an empty contract entry.
    const evidenceList: CandidateEvidence[] = [];
    let evaluations: CandidateEvaluations;
    let selection: { selected: SelectedVideo; decision: SelectionDecision };
    let winnerVideo: VideoCandidate;

    report('evaluate', `Stage 5/10: [FastEval] Incorporating Vision-Language top-${options.fastEvalResult.topCandidates.length} shortlist`);
    const candidateByVideoId = new Map(search.candidates.map((c) => [c.videoId, c]));
    const unmatched = options.fastEvalResult.topCandidates.filter((c) => !candidateByVideoId.has(c.videoId));
    if (unmatched.length > 0) {
      throw new AppError({
        code: ErrorCodes.EVALUATION_FAILED,
        message: `FastEval shortlist references unknown candidate(s): ${unmatched.map((c) => `${c.videoId} (#${c.index})`).join(', ')}`,
        stage: 'research',
        task: 'fasteval-incorporate',
        retryable: false,
      });
    }

    // Rank-based projection onto the 1-5 contract scale. The VL model ranks the
    // shortlist; composite scores derive deterministically from rank order —
    // no per-candidate rubric scoring (that legacy path was removed).
    const RANK_COMPOSITE = [4.8, 4.5, 4.2];
    const RANK_BAND = ['S', 'A+', 'A'];
    const EVAL_DIMENSIONS = [
      '风格化 (Stylization)',
      '戏剧性 (Dramatic)',
      '趣味性 (Entertainment)',
      '盈利性 (Monetization)',
      '独特性/差异化 (Uniqueness & Differentiation)',
    ];
    const mappedEvaluations: CandidateEvaluation[] = options.fastEvalResult.topCandidates.map((c, rank) => {
      const compositeScore = RANK_COMPOSITE[rank] ?? 4.0;
      return {
        videoId: c.videoId,
        standardHash: standard.meta.standardHash,
        compositeScore,
        displayBand: RANK_BAND[rank] ?? 'B',
        evidenceCoverage: 1.0,
        selectable: true,
        model: 'fasteval-vl',
        evaluatedAt: options.fastEvalResult!.evaluatedAt,
        dimensionScores: EVAL_DIMENSIONS.map((dimension) => ({
          dimension,
          score: Math.min(5, Math.max(1, Math.round(compositeScore))),
          rationale: c.reason,
          evidence: [],
        })),
      };
    });

    evaluations = {
      standardHash: standard.meta.standardHash,
      model: options.fastEvalResult.winner.title,
      evaluatedAt: options.fastEvalResult.evaluatedAt,
      dimensionCount: 5,
      evaluations: mappedEvaluations,
      failures: [],
      notEvaluated: [],
    };

    const resolvedWinner = candidateByVideoId.get(options.fastEvalResult!.winner.videoId);
    if (!resolvedWinner) {
      throw new AppError({
        code: ErrorCodes.EVALUATION_FAILED,
        message: `FastEval winner ${options.fastEvalResult!.winner.videoId} is not among the research candidates`,
        stage: 'research',
        task: 'fasteval-incorporate',
        retryable: false,
      });
    }
    winnerVideo = resolvedWinner;
    if (options.fastEvalResult.style) {
      winnerVideo.visualStyle = options.fastEvalResult.style;
    }
    const winnerEvaluation = mappedEvaluations.find((e) => e.videoId === winnerVideo.videoId);

    selection = {
      selected: {
        video: winnerVideo,
        score: {
          videoId: winnerVideo.videoId,
          relevance: 9,
          clarity: 9,
          structure: 9,
          reusability: 9,
          total: Math.round((winnerEvaluation?.compositeScore ?? 4.8) * 20),
          rationale: options.fastEvalResult.reasoning,
        },
        runnersUp: search.candidates
          .filter((c) => c.videoId !== winnerVideo.videoId)
          .map((c) => ({ videoId: c.videoId, total: 80 })),
        standardHash: standard.meta.standardHash,
        evaluation: winnerEvaluation,
      },
      decision: {
        policyVersion: 'research-selection-v2',
        standardHash: standard.meta.standardHash,
        selectedVideoId: winnerVideo.videoId,
        reason: options.fastEvalResult.reasoning,
        ranking: mappedEvaluations.map((ev) => ({
          videoId: ev.videoId,
          compositeScore: ev.compositeScore,
          evidenceCoverage: 1.0,
          viewsPerDay: 1000,
          selectable: true,
        })),
        runnersUp: mappedEvaluations
          .filter((ev) => ev.videoId !== winnerVideo.videoId)
          .slice(0, 3)
          .map((ev) => ({
            videoId: ev.videoId,
            compositeScore: ev.compositeScore,
            displayBand: ev.displayBand,
          })),
        rejected: [],
        notEvaluated: [],
        decidedAt: options.fastEvalResult.evaluatedAt,
      },
    };

    logger.info(`[FastEval] Winner established: "${winnerVideo.title}" by ${winnerVideo.channelTitle} (${winnerVideo.videoId})`, {
      winnerVideoId: winnerVideo.videoId,
      reason: options.fastEvalResult.reasoning,
    });

    await run.write('evaluations', evaluations);
    await run.write('selection', selection.decision);

    // Resolve winner transcript — if the top pick has no transcript, try runners-up.
    // Primary path: yt-dlp driven by the RESIDENT logged-in browser session
    // (cookies dumped over CDP right before the call + exact UA match — see
    // ytdlp-cdp.ts). Fallback: the persistent-profile browser itself.
    const candidateIds = [
      winnerVideo.videoId,
      ...selection.decision.runnersUp.map((r) => r.videoId),
    ];
    let winnerTranscript: Transcript | undefined;
    let cookiesRefreshedForTranscripts = false;
    const candidateErrors: { videoId: string; error: any }[] = [];
    // Egress rate limiting (google.com/sorry "unusual traffic") blocks every
    // candidate identically, so on YOUTUBE_RATE_LIMITED we back off and re-probe
    // the same candidate instead of burning the remaining candidates against the
    // same flagged proxy exit IP.
    const rateLimitBackoffMs = Math.max(0, Number(process.env.YT_TRANSCRIPT_RATE_LIMIT_BACKOFF_MS ?? 90_000));
    const rateLimitMaxRetries = Math.max(0, Number(process.env.YT_TRANSCRIPT_RATE_LIMIT_RETRIES ?? 1));
    let rateLimitRetriesUsed = 0;
    let candidateIndex = 0;
    while (candidateIndex < candidateIds.length && !winnerTranscript) {
      const candidateId = candidateIds[candidateIndex];
      // Space out watch-page loads — burst requests from this egress IP trip
      // YouTube's rate limiter and bot-wall the session for all candidates.
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
      let transcript: Transcript | undefined;
      let rateLimited = false;
      let cdpDefinitiveNoSubs = false;
      {
        const attemptCdpTranscript = async (): Promise<void> => {
          try {
            transcript = await downloadTranscriptViaYtDlpCdp({
              videoId: candidateId,
              preferredLanguages: [language, 'en'],
            });
          } catch (err: any) {
            candidateErrors.push({ videoId: candidateId, error: err });
            if (err.code === ErrorCodes.YOUTUBE_RATE_LIMITED) {
              // Egress-wide block: cookie refresh cannot help and the remaining
              // candidates share the same exit IP.
              rateLimited = true;
              return;
            }
            if (err.code === ErrorCodes.SUBTITLE_NOT_AVAILABLE) {
              // Video has no track via yt-dlp. Fall back to browser page extraction
              // before giving up.
              cdpDefinitiveNoSubs = false;
            }
            logger.warn(`CDP yt-dlp transcript unavailable for ${candidateId}: ${err.message}`);
          }
        };
        const attemptBrowserTranscript = async (): Promise<Transcript | undefined> => {
          try {
            return await downloadTranscriptViaBrowser({
              videoId: candidateId,
              preferredLanguages: [language, 'en'],
            });
          } catch (err: any) {
            candidateErrors.push({ videoId: candidateId, error: err });
            if (err.code === ErrorCodes.YOUTUBE_RATE_LIMITED) {
              // Egress-wide block: cookie refresh cannot help and the remaining
              // candidates share the same exit IP.
              rateLimited = true;
              return undefined;
            }
            // Bot wall / revoked session: refresh cookies via interactive browser
            // login once, then retry through the restored direct session.
            if (err.code === ErrorCodes.YOUTUBE_BOT_DETECTED && refreshCookies && !cookiesRefreshedForTranscripts) {
              logger.warn(`Browser transcript blocked for ${candidateId} (${err.message}); refreshing cookies via CDP browser...`);
              const newPath = await refreshCookies();
              cookiesRefreshedForTranscripts = true;
              if (newPath) {
                activeCookiePath = newPath;
                try {
                  return await downloadTranscriptViaBrowser({
                    videoId: candidateId,
                    preferredLanguages: [language, 'en'],
                  });
                } catch (retryErr: any) {
                  candidateErrors.push({ videoId: candidateId, error: retryErr });
                  logger.warn(`Browser transcript retry failed for ${candidateId}: ${retryErr.message}`);
                  return undefined;
                }
              }
              return undefined;
            }
            logger.warn(`Browser transcript unavailable for ${candidateId}: ${err.message}`);
            return undefined;
          }
        };
        await attemptCdpTranscript();
        if (!transcript && !rateLimited && !cdpDefinitiveNoSubs) {
          transcript = await attemptBrowserTranscript();
        }
      }
      if (rateLimited) {
        if (rateLimitRetriesUsed < rateLimitMaxRetries) {
          rateLimitRetriesUsed += 1;
          logger.warn(`Google rate-limited the egress IP for ${candidateId}; backing off ${rateLimitBackoffMs}ms then re-probing (retry ${rateLimitRetriesUsed}/${rateLimitMaxRetries})`);
          await new Promise((r) => setTimeout(r, rateLimitBackoffMs));
          continue;
        }
        logger.warn(`Google rate limit persists on the egress IP; skipping remaining ${candidateIds.length - candidateIndex - 1} transcript candidate(s) that share the same exit`);
        break;
      }
      if (transcript && transcript.cues.length > 0) {
        winnerTranscript = transcript;
        if (candidateId !== winnerVideo.videoId) {
          // Switch winner to the candidate that actually has a transcript
          const fallbackCandidate = poolResult.pool.find((c) => c.videoId === candidateId);
          if (fallbackCandidate) {
            logger.info(`"${winnerVideo.title}" has no transcript; falling back to "${fallbackCandidate.title}" (${candidateId})`);
            winnerVideo = fallbackCandidate;
          }
        }
        break;
      }
      candidateIndex += 1;
    }
    if (!winnerTranscript || winnerTranscript.cues.length === 0) {
      // Precedence matters: YOUTUBE_RATE_LIMITED (google.com/sorry seen by the
      // LOGGED-IN browser) is definitive IP-level evidence on the shared egress —
      // no cookie refresh or re-login can help, and the bot-wall errors from the
      // yt-dlp/CDP transports are downstream symptoms of the same IP flag. Report
      // the rate limit first so the user gets "switch proxy node", not "log in".
      const rateLimitError = candidateErrors.find((e) => e.error?.code === ErrorCodes.YOUTUBE_RATE_LIMITED);
      if (rateLimitError) {
        const botWallDetail = candidateErrors.find((e) => e.error?.code === ErrorCodes.YOUTUBE_BOT_DETECTED);
        throw new AppError({
          code: ErrorCodes.YOUTUBE_RATE_LIMITED,
          message:
            `Google rate-limited the proxy egress while resolving transcripts for (${candidateIds.join(', ')}): ` +
            'the watch page was answered by google.com/sorry ("unusual traffic") in the logged-in browser. ' +
            'This is an IP-level block on the shared exit, not a missing-subtitles or login issue — ' +
            'switch the proxy exit node or retry after a cooldown.' +
            (botWallDetail ? ` (yt-dlp transport also bot-walled: ${botWallDetail.error.message})` : ''),
          stage: 'research',
          task: 'resolve-transcript',
          retryable: true,
          cause: rateLimitError.error,
        });
      }
      const botWallError = candidateErrors.find((e) => e.error?.code === ErrorCodes.YOUTUBE_BOT_DETECTED);
      if (botWallError) {
        throw new AppError({
          code: ErrorCodes.YOUTUBE_BOT_DETECTED,
          message: `YouTube bot wall encountered while resolving transcript for candidates (${candidateIds.join(', ')}): ${botWallError.error.message}`,
          stage: 'research',
          task: 'resolve-transcript',
          retryable: false,
          cause: botWallError.error,
        });
      }
      const failureDetails = candidateErrors
        .map((e) => `[${e.videoId}: ${e.error?.message || e.error}]`)
        .join(', ');
      throw new AppError({
        code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
        message: `Winner video "${winnerVideo.title}" (${winnerVideo.videoId}) and candidates have no usable transcript for scene segmentation. Failures: ${failureDetails || 'None available'}`,
        stage: 'research',
        task: 'resolve-transcript',
        retryable: false,
      });
    }

    // Reconcile winner duration if transcript provides a longer/more accurate duration
    const winnerTranscriptDuration = winnerTranscript.cues.length > 0
      ? winnerTranscript.cues[winnerTranscript.cues.length - 1][1]
      : 0;
    if (winnerTranscriptDuration > winnerVideo.metrics.durationSec) {
      winnerVideo.metrics.durationSec = Math.round(winnerTranscriptDuration);
    }

    // 7. Video Segmentation
    report('segments', `Stage 7/10: Building segments for "${winnerVideo.title}" by ${winnerVideo.channelTitle}`);
    const segmentsResult = await buildSegments({
      video: winnerVideo,
      transcript: winnerTranscript,
      useLlm: useLlmForScript,
      model,
    });
    let segments = segmentsResult.segments;
    await run.write('transcript', winnerTranscript);
    await run.write('segments', segments);

    logger.info(`Generated ${segments.length} segment(s) for winner`, {
      segmentCount: segments.length,
      segments: segments.map((s) => ({
        segmentId: s.segmentId,
        title: s.title,
        startSec: s.startSec,
        endSec: s.endSec,
        durationSec: s.durationSec,
      })),
    });

    // 8. Video Media Download, Frame Extraction & Prompt Detection (with up to 2 Runner-up Retries)
    if (skipMediaDownload) {
      throw new AppError({
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Cannot extract frame evidence with skipMediaDownload=true: video media is required for frame extraction',
        stage: 'research',
        task: 'extract-frames',
        retryable: false,
      });
    }

    const framesDir = path.join(effectiveOutputDir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });

    const refVideoDir = path.join(effectiveOutputDir, 'reference-video');
    await fs.mkdir(refVideoDir, { recursive: true });

    // Candidates to process: initial winner first, followed by up to 2 runner-ups if prompt extraction yields 0 prompts
    const runnerUpCandidates: VideoCandidate[] = (selection.decision.runnersUp || [])
      .map((r) => poolResult.pool.find((p) => p.videoId === r.videoId))
      .filter((v): v is VideoCandidate => Boolean(v && v.videoId !== winnerVideo.videoId));

    const candidateQueue = [
      { video: winnerVideo, isRetry: false, retryIndex: 0 },
      ...runnerUpCandidates.slice(0, 2).map((v, i) => ({ video: v, isRetry: true, retryIndex: i + 1 })),
    ];

    let frameEvidence: FrameEvidence | undefined;
    let framesResult: FramesResult | undefined;
    let videoFilePath: string | null = null;
    let promptLocator: PromptFrameLocator | undefined;
    let promptRecognition: PromptFrameRecognition | undefined;
    let vlPrompts: VlExtractedPrompt[] = [];
    let detectedOrientation: 'portrait' | 'landscape' | undefined;
    let orientationVotes: { portrait: number; landscape: number } | undefined;

    // Real root-cause record: every candidate that failed at the media-download
    // step (code + message). When the loop ends with no frame evidence, a
    // non-empty list proves the failure is a download failure, not frame
    // extraction — so the thrown error must surface these causes instead of
    // the misleading FRAME_EXTRACTION_FAILED blanket.
    const downloadFailures: Array<{ videoId: string; title: string; error: string }> = [];

    for (let cIdx = 0; cIdx < candidateQueue.length; cIdx++) {
      const item = candidateQueue[cIdx];
      const curVideo = item.video;

      if (item.isRetry) {
        report(
          'prompt-detector',
          `Previous candidate yielded 0 AI video prompts. Retrying candidate ${item.retryIndex}/2: "${curVideo.title}" by ${curVideo.channelTitle} (${curVideo.videoId})`
        );
        logger.info(`Retrying prompt extraction with runner-up candidate ${item.retryIndex}/2`, {
          videoId: curVideo.videoId,
          title: curVideo.title,
        });

        // Resolve transcript for runner-up candidate
        let curTranscript: Transcript | undefined;
        if (!curTranscript || curTranscript.cues.length === 0) {
          if (options.transcriptStorage) {
            try {
              const loaded = await options.transcriptStorage.loadTranscript(curVideo.videoId);
              if (loaded) {
                curTranscript = {
                  videoId: loaded.videoId,
                  language: loaded.language || language,
                  source: loaded.source || 'auto',
                  cues: loaded.cues || [],
                };
              }
            } catch {}
          }
          if (!curTranscript) {
            // Primary: yt-dlp driven by the resident browser's live CDP-dumped session.
            try {
              curTranscript = await downloadTranscriptViaYtDlpCdp({
                videoId: curVideo.videoId,
                preferredLanguages: [language, 'en'],
              });
            } catch (err: any) {
              if (err.code !== ErrorCodes.SUBTITLE_NOT_AVAILABLE) {
                logger.warn(`CDP yt-dlp transcript unavailable for runner-up ${curVideo.videoId}: ${err.message}`);
              }
            }
          }
          if (!curTranscript) {
            // Browser-direct path: proxy-routed yt-dlp is bot-walled for watch pages.
            try {
              curTranscript = await downloadTranscriptViaBrowser({
                videoId: curVideo.videoId,
                preferredLanguages: [language, 'en'],
              });
            } catch (err: any) {
              if (err.code === ErrorCodes.YOUTUBE_BOT_DETECTED && refreshCookies && !cookiesRefreshedForTranscripts) {
                logger.warn(`Browser transcript blocked for runner-up ${curVideo.videoId} (${err.message}); refreshing cookies via CDP browser...`);
                const newPath = await refreshCookies();
                cookiesRefreshedForTranscripts = true;
                if (newPath) {
                  activeCookiePath = newPath;
                  try {
                    curTranscript = await downloadTranscriptViaBrowser({
                      videoId: curVideo.videoId,
                      preferredLanguages: [language, 'en'],
                    });
                  } catch {}
                }
              }
            }
          }
        }

        if (!curTranscript || curTranscript.cues.length === 0) {
          logger.warn(`Runner-up candidate ${curVideo.videoId} has no transcript, skipping`);
          continue;
        }

        const runnerTranscriptDuration = curTranscript.cues.length > 0
          ? curTranscript.cues[curTranscript.cues.length - 1][1]
          : 0;
        if (runnerTranscriptDuration > curVideo.metrics.durationSec) {
          curVideo.metrics.durationSec = Math.round(runnerTranscriptDuration);
        }

        const segRes = await buildSegments({
          video: curVideo,
          transcript: curTranscript,
          useLlm: useLlmForScript,
          model,
        });

        winnerVideo = curVideo;
        winnerTranscript = curTranscript;
        segments = segRes.segments;
      }

      // 1. Check persistent video storage first
      let curVideoPath: string | null = null;
      if (options.videoStorage) {
        try {
          const cachedPath = await options.videoStorage.findVideo(curVideo.videoId);
          if (cachedPath) {
            const ext = path.extname(cachedPath) || '.mp4';
            const localTarget = path.join(refVideoDir, `${curVideo.videoId}${ext}`);
            try {
              await fs.copyFile(cachedPath, localTarget);
              curVideoPath = localTarget;
            } catch {
              curVideoPath = cachedPath;
            }
            logger.info(`Reused persistent video media for "${curVideo.title}" (${curVideo.videoId})`, {
              cachedSource: cachedPath,
              targetPath: curVideoPath,
              fromStorage: true,
            });

            // Cached videos were saved by an earlier, possibly buggier build —
            // validate BEFORE use so a corrupt/frozen file can never be reused
            // across runs. On failure: evict from storage and fall through to
            // a fresh download.
            try {
              await validateReferenceVideoQuality(curVideoPath, {
                expectedDurationSec: curVideo.metrics.durationSec,
              });
            } catch (cachedQualityErr: any) {
              logger.warn(`Cached video for ${curVideo.videoId} failed quality validation — evicting and re-downloading: ${cachedQualityErr?.message}`, {
                videoId: curVideo.videoId,
                error: cachedQualityErr?.code || 'ERROR',
              });
              try {
                await options.videoStorage.removeVideo?.(curVideo.videoId);
              } catch {}
              try {
                await fs.rm(curVideoPath, { force: true });
              } catch {}
              curVideoPath = null;
            }
          }
        } catch (storageErr: any) {
          logger.warn(`Failed to retrieve video from storage for ${curVideo.videoId}: ${storageErr.message}`);
        }
      }

      // 2. If not in persistent storage, download with yt-dlp.
      //
      // yt-dlp is the ONLY supported reference-video transport. All browser /
      // player-capture download paths were removed on purpose: the watch-page
      // progressive URLs are SABR/IP-bound and 403 from this egress, and the
      // MSE-capture alternative is corrupted by mid-roll ads and autoplay, is
      // bandwidth-bound, mixes containers, and can silently yield frozen
      // frames. See the policy note at the top of youtube/ytdlp.ts and
      // plan-fix-sabr-pot-download.md.
      if (!curVideoPath) {
        report('media-download', `Stage 8a/10: Downloading "${curVideo.title}" by ${curVideo.channelTitle} (${curVideo.videoId})`);
        const downloadWithActiveCookies = async () =>
          downloadVideo({
            videoId: curVideo.videoId,
            outputDir: refVideoDir,
            cookiePath: activeCookiePath ?? cookiePath ?? undefined,
            proxyUrl: proxyUrl ?? undefined,
            expectedDurationSec: curVideo.metrics.durationSec,
            timeoutMs: 600_000,
          });
        try {
          curVideoPath = await downloadWithActiveCookies();
        } catch (err: any) {
          downloadFailures.push({
            videoId: curVideo.videoId,
            title: curVideo.title,
            error: `${err?.code ?? 'ERROR'}: ${err?.message ?? String(err)}`,
          });
          if (refreshCookies && (err.code === ErrorCodes.YOUTUBE_BOT_DETECTED || err.code === ErrorCodes.COOKIE_INVALID)) {
            logger.warn(`Download failed (${err.code}), refreshing cookies via CDP browser...`);
            const newPath = await refreshCookies();
            if (newPath) {
              activeCookiePath = newPath;
              logger.info('Retrying download with refreshed cookies');
              try {
                curVideoPath = await downloadWithActiveCookies();
              } catch (retryErr: any) {
                downloadFailures.push({
                  videoId: curVideo.videoId,
                  title: curVideo.title,
                  error: `retry ${retryErr?.code ?? 'ERROR'}: ${retryErr?.message ?? String(retryErr)}`,
                });
                logger.warn(`Download retry failed for ${curVideo.videoId}: ${retryErr.message}`);
                continue;
              }
              // Retry succeeded — drop the failure recorded above for this candidate.
              for (let i = downloadFailures.length - 1; i >= 0; i -= 1) {
                if (downloadFailures[i].videoId === curVideo.videoId) downloadFailures.splice(i, 1);
              }
            } else {
              logger.warn(`Download failed for ${curVideo.videoId}: ${err.message}`);
              continue;
            }
          } else {
            logger.warn(`Download failed for ${curVideo.videoId}: ${err.message}`);
            continue;
          }
        }
        logger.info(`Media downloaded: "${curVideo.title}" by ${curVideo.channelTitle} → ${curVideoPath}`);
        // downloadVideo() already transcodes to H.264/720p and validates quality.

        // 3. Persist downloaded video to storage for future runs
        if (options.videoStorage && curVideoPath) {
          try {
            await options.videoStorage.saveVideo(curVideo.videoId, curVideoPath);
            logger.info(`Persisted candidate video to storage: ${curVideo.videoId}`);
          } catch (saveErr: any) {
            logger.warn(`Failed to persist video to storage for ${curVideo.videoId}: ${saveErr.message}`);
          }
        }
      }

      videoFilePath = curVideoPath;
      if (curVideoPath) {
        try {
          const probed = await probeVideo(curVideoPath);
          if (probed?.durationSeconds > 0) {
            curVideo.metrics.durationSec = Math.round(probed.durationSeconds);
          }
        } catch {}
      }

      report('frames', `Stage 8b/10: Extracting scene transition frames and building contact-sheet grids for "${curVideo.title}"`);
      try {
        const frameData = await collectFrameEvidence({
          video: curVideo,
          segments,
          transcript: winnerTranscript,
          videoPath: curVideoPath,
          outputDir: framesDir,
          minFrames,
          maxFrames,
          sceneThreshold,
          now,
        });

        if (frameData?.evidence && frameData?.frames && frameData.frames.frames.length > 0) {
          frameEvidence = frameData.evidence;
          framesResult = frameData.frames;
          logger.info(`Frame evidence extracted: ${framesResult.frames.length} frames, ${framesResult.strips.length} strips`);
        }
      } catch (frameErr: any) {
        logger.warn(`Frame extraction failed for ${curVideo.videoId}: ${frameErr.message}`);
        // A degenerate (frozen/dead-frame) video is a media failure, not an
        // extraction failure — record it so the end-of-loop error surfaces the
        // real root cause instead of the misleading FRAME_EXTRACTION_FAILED blanket.
        if (frameErr?.code === ErrorCodes.MEDIA_DEGENERATE) {
          downloadFailures.push({
            videoId: curVideo.videoId,
            title: curVideo.title,
            error: `${frameErr.code}: ${frameErr.message}`,
          });
        }
        continue;
      }

      // 8c. Targeted Prompt Detection (3-stage: LLM → low-res screen → high-res OCR)
      if (locatePrompts && curVideoPath) {
        report('prompt-detector', `Stage 8c/10: Detecting AI prompt frames for "${curVideo.title}"`);
        try {
          const detectorResult = await runPromptDetector({
            videoPath: curVideoPath,
            videoId: curVideo.videoId,
            videoTitle: curVideo.title,
            topic: resolvedTopic,
            videoDurationSec: curVideo.metrics.durationSec,
            transcript: winnerTranscript,
            outputDir: effectiveOutputDir,
            model,
            vlModel: model,
            targetLanguage: language,
          });
          promptLocator = detectorResult.locator;
          promptRecognition = detectorResult.recognition;
          detectedOrientation = detectorResult.detectedOrientation;
          orientationVotes = detectorResult.orientationVotes;
          const detected: VlExtractedPrompt[] = promptRecognition?.frames
            .filter((f) => f.found && f.prompt && (f.promptType === 'image' || f.promptType === 'video'))
            .map((f) => ({
              prompt: f.prompt,
              promptType: f.promptType,
              orientation: f.orientation || detectorResult.detectedOrientation,
              uiContext: f.uiContext,
              uiDescription: f.uiDescription,
              channel: f.channel,
              narration: f.narration || '',
              confidence: f.confidence,
              settings: f.settings,
            })) ?? [];

          logger.info('Prompt detection completed', {
            videoId: curVideo.videoId,
            rangesFound: detectorResult.ranges.length,
            screenedFrames: detectorResult.screened.length,
            recognizedPrompts: detected.length,
            promptTypes: detected.map((f) => f.promptType),
            detectedOrientation,
            orientationVotes,
          });

          if (detected.length > 0) {
            vlPrompts = detected;
            break; // Found prompts! Successfully selected candidate!
          }
        } catch (detectorErr: any) {
          // If VL model failed, abort pipeline immediately
          if (detectorErr instanceof AppError && detectorErr.code === ErrorCodes.VL_MODEL_FAILED) {
            throw detectorErr;
          }
          // For other errors, also abort
          throw new AppError({
            code: ErrorCodes.VL_MODEL_FAILED,
            message: `Prompt detection failed for ${curVideo.videoId}: ${detectorErr.message}`,
            stage: 'research',
            task: 'detect-prompts',
            retryable: false,
            cause: detectorErr,
          });
        }
      } else {
        break; // locatePrompts is false, proceed with winner
      }

      if (cIdx < candidateQueue.length - 1) {
        logger.warn(`Candidate ${curVideo.videoId} ("${curVideo.title}") yielded 0 AI prompts. Retrying with next runner-up candidate.`);
      }
    }

    // If no VL prompts extracted after trying all candidates, apply the configured policy
    // (prod hotfix 81d6152 ported into the RunContext architecture: the script stage
    // synthesizes prompts from the transcript unless requireVideoPrompt=true)
    if (vlPrompts.length === 0 && requireVideoPrompt) {
      throw new AppError({
        code: ErrorCodes.NO_VIDEO_PROMPT_FOUND,
        message: `No AI generation prompts were extracted from any candidate video after trying ${candidateQueue.length} candidates.`,
        stage: 'research',
        task: 'detect-prompts',
        retryable: false,
      });
    }
    if (vlPrompts.length === 0) {
      logger.warn('No AI generation prompts extracted from any candidate video; continuing with transcript-synthesized prompts (requireVideoPrompt=false). WARNING: transcript-synthesized prompts ignore the reference video\'s actual prompts and typically reproduce its opening narrative — pass --no-require-video-prompt only as an explicit fallback.', {
        candidatesTried: candidateQueue.length,
      });
    }

    if (!frameEvidence || !framesResult || framesResult.frames.length === 0) {
      // Root-cause surfacing: when every attempted candidate failed at the
      // media-download step, the missing frames are a download failure, not a
      // frame-extraction failure. Throwing FRAME_EXTRACTION_FAILED here masks
      // the actionable cause (e.g. googlevideo egress-IP mismatch → HTTP 403).
      if (downloadFailures.length > 0) {
        const summary = downloadFailures
          .map((f) => `${f.videoId} "${f.title}": ${f.error}`)
          .join(' ; ');
        throw new AppError({
          code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
          message: `Reference video download failed, so no frame evidence could be extracted. Failures: ${summary}`,
          stage: 'research',
          task: 'media-download',
          retryable: true,
        });
      }
      throw new AppError({
        code: ErrorCodes.FRAME_EXTRACTION_FAILED,
        message: `Frame extraction failed for candidate video ${winnerVideo.videoId}: no frames or contact-sheet evidence were extracted`,
        stage: 'research',
        task: 'extract-frames',
        retryable: false,
      });
    }

    // 9. ResearchResult Assembly
    report('compose', 'Stage 9/10: Assembling and validating final ResearchResult');

    const matchedEvaluation = evaluations.evaluations.find((e) => e.videoId === winnerVideo.videoId) || selection.selected.evaluation;
    const finalScore = matchedEvaluation
      ? fastEvalToLegacyScore(matchedEvaluation)
      : selection.selected.score;

    const result: ResearchResult = {
      runId,
      query: trimmedQuery,
      topic: resolvedTopic,
      candidateCount: search.candidates.length,
      filteredCount: filtered.kept.length,
      selected: winnerVideo,
      selectedScore: finalScore,
      transcript: winnerTranscript,
      hasNarration: segmentsResult.hasNarration ?? segments.some((s) => s.hasNarration),
      segments,
      frames: framesResult?.frames || [],
      strips: framesResult?.strips || [],
      vlPrompts: vlPrompts.length > 0 ? vlPrompts : undefined,
      detectedOrientation,
      orientationVotes,
      standardHash: standard.meta.standardHash,
      standard,
      selectedEvaluation: matchedEvaluation,
      selectionDecision: selection.decision,
      visualStyle: options.fastEvalResult.style || winnerVideo.visualStyle,
      createdAt: nowIso(),
    };

    // Validate output conforms strictly to ResearchResultSchema
    ResearchResultSchema.parse(result);
    logger.info('ResearchResult passed Zod schema validation');

    // 10. Artifact Persistence
    report('persist', `Stage 10/10: Writing pipeline artifacts to: ${effectiveOutputDir}`);
    await run.write('research', result);
    await run.write('evaluations', evaluations);
    await run.write('selection', selection.decision);
    await run.write('evidence', evidenceList);
    await run.write('frames', frameEvidence);
    await run.write('transcript', winnerTranscript);
    await run.write('segments', segments);
    if (promptLocator) await run.write('promptLocator', promptLocator);
    if (promptRecognition) await run.write('promptRecognition', promptRecognition);

    // 11. Flow Video Script Generation (Veo-Optimized)
    let flowScript: FlowVideoScript | undefined;
    if (generateFlowScript) {
      report('flow-script', 'Stage 11/11: Generating Veo-optimized Flow Video Script');
      const generated = await generateScriptFromRun(run);
      flowScript = generated.script;
      const scriptPath = generated.outputPath;
      const resolvedFlowScriptName = path.basename(scriptPath);
      logger.info(`Generated and persisted flow video script: ${resolvedFlowScriptName}`, {
        path: scriptPath,
        totalClips: flowScript.totalClips,
        totalDurationSec: flowScript.totalDurationSec,
        totalCreditsEstimate: flowScript.totalCreditsEstimate,
      });
    }

    await run.recordStage({ stage: 'research', status: 'completed', durationMs: Date.now() - researchStarted });
    if (!parentRun) await run.finish();
    report('complete', `Research pipeline completed successfully for run ${runId}`);
    logger.info(`Pipeline execution completed successfully`, {
      runId,
      outputDir: effectiveOutputDir,
      winnerId: winnerVideo.videoId,
    });

    return {
      runId,
      outputDir: effectiveOutputDir,
      logPath: logger.logFilePath,
      jsonlLogPath: logger.jsonlLogFilePath,
      search,
      filtered,
      standard,
      evidence: evidenceList,
      evaluations,
      selection,
      transcript: winnerTranscript,
      segments,
      frameEvidence,
      framesResult,
      promptLocator,
      promptRecognition,
      result,
      flowScript,
    };
  } catch (err: any) {
    await run.recordStage({ stage: 'research', status: 'failed', durationMs: Date.now() - researchStarted, error: err.message });
    if (!parentRun) await run.finish(err);
    logger.error('Pipeline execution encountered an unhandled error', err, {
      query: trimmedQuery,
      runId,
    });
    if (isLlmUnavailableError(err)) {
      await notifyLlmUnavailableAndExit(err, { stage: err.stage || 'research', context: 'YouTube Research Pipeline' });
    }
    throw err;
  } finally {
    await logger.close();
  }
}

// Modular CLI Runners & Utilities
export * from './cli/index.js';
export { validateExtractedPrompts, type VideoPromptValidationResult } from './media/prompt-detector.js';
export {
  reorchestrateExtractedPrompts,
  deterministicReorchestratePrompts,
  type ReorchestrateParams,
} from './script/generator.js';
export {
  buildReorchestrationSystemPrompt,
  buildReorchestrationUserPrompt,
  POLICY_AVOIDANCE_GUIDELINES,
  sanitizePromptForSafetyPolicy,
  sanitizeClipsForSafetyPolicy,
  type ReorchestrationPromptOptions,
} from './script/prompts.js';
export {
  formatEvaluationRequirements,
} from './evaluation/standard.js';
export type {
  EvaluationRequirements,
  EvaluationDimensionRequirement,
} from './contracts.js';
