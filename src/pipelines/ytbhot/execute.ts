import fs from 'node:fs/promises';
import path from 'node:path';

import { loadEnvFile } from '../../env.js';

loadEnvFile();

import { FlowClient } from '../../flow/client.js';
import { FlowClientExt } from '../../flow/client-ext.js';
import type { BatchClipResult, BatchResult, FlowProject } from '../../flow/contracts.js';
import { AppError, ErrorCodes } from '../../research/errors.js';
import { FLOW_VIDEO_SCRIPT_FILENAME, runResearchPipeline, validateExtractedPrompts } from '../../research/index.js';
import type { FastEvalResult } from '../../research/fasteval/types.js';
import { runFastEvalFromRun } from '../../research/fasteval/run.js';
import { generateFlowFromRun } from '../../flow/run.js';
import type { FlowVideoScript } from '../../research/script/contracts.js';
import { resolveProfileDir } from '../../utils/index.js';
import { sendMsg, formatDetailedErrorMessage } from '../../utils/send_msg.js';
import { parseViewport } from '../../browser/launcher.js';
import type { Pipeline, PipelineContext, PipelineStageDef } from '../core/contracts.js';
import { createDefaultExecutionContext } from '../core/context.js';
import {
  type EnvCheckSummary,
  type EvaluationSummary,
  type ExtractedPromptsSummary,
  type FlowGenerationSummary,
  type FlowProjectSummary,
  type GeneratedScriptSummary,
  type SearchSummary,
  type PipelineStage,
  type StageResult,
  type StandardSummary,
  type ViralPipelineInput,
  type ViralPipelineOptions,
  type ViralPipelineResult,
  type YtbCheckSummary,
  ViralPipelineOptionsSchema,
} from './contracts.js';
import {
  generateFinalReportJson,
  generateFinalReportMarkdown,
  printExecutiveSummary,
  saveFinalReports,
} from './report.js';
import {
  checkEnvStage,
  checkYtbStage,
  persistStandardForReuse,
  refreshYtbCookiesIfNeeded,
  resolveReusableStandard,
  slugifyTopic,
} from '../core/stages.js';
import { getPipelineStorage } from '../core/storage.js';
import { createTutorialFromRun } from '../../tutorial/run.js';
import type { TutorialGenerationSummary } from '../../tutorial/contracts.js';
import { isAntiAbuseError } from '../../flow/client.js';

import { DEFAULT_CREATIVE_EVALUATION_FOCUS, VIRAL_VIDEO_EVALUATION_REQUIREMENTS } from './evaluation-requirements.js';
import { isFlowTargetingMismatch, tagTokenStageFailure } from './failure-policy.js';

export const VIRAL_PIPELINE_STAGES: readonly PipelineStageDef[] = [
  { id: 'check-env', name: 'Environment Check', description: 'Check LLM, Chromium, yt-dlp, and ffmpeg' },
  { id: 'check-ytb', name: 'YouTube Auth Check', description: 'Verify YouTube cookies and authentication' },
  { id: 'browser-refresh', name: 'Browser Cookie Refresh', description: 'Refresh cookies via Chromium if needed', optional: true },
  { id: 'search-ytb', name: 'Search YouTube', description: 'Search YouTube for candidate videos' },
  { id: 'standard-load', name: 'Load Standard', description: 'Load cached evaluation standard', optional: true },
  { id: 'standard-gen', name: 'Generate Standard', description: 'Distill LLM evaluation standard', optional: true },
  { id: 'standard-save', name: 'Save Standard', description: 'Persist evaluation standard for reuse' },
  { id: 'evaluate', name: 'Evaluate Candidates', description: 'Evaluate candidates with standard rubric' },
  { id: 'extract-prompts', name: 'Extract Prompts', description: 'Extract narrative scenes from transcript' },
  { id: 'gen-prompts', name: 'Generate Script Prompts', description: 'Generate Veo-optimized prompts and script' },
  { id: 'flow-login', name: 'Flow Login', description: 'Verify Google Flow authentication', optional: true },
  { id: 'flow-project', name: 'Flow Project', description: 'Allocate or verify workspace project on Google Flow' },
  { id: 'flow-generate', name: 'Flow Generate', description: 'Batch video generation with Google Flow Veo' },
  {
    id: 'tutorial-gen',
    name: 'Tutorial Video',
    description: 'AI commentary tutorial video (LLM storyboard + edge-tts narration + headless frame render)',
    optional: true,
  },
  { id: 'report', name: 'Generate Reports', description: 'Compile Markdown and JSON execution reports' },
] as const;

export async function executeViralVideo(
  options: ViralPipelineOptions,
  ctx: PipelineContext
): Promise<ViralPipelineResult> {
  const { runId, outDir, startTime, logger, stages, notify, recordStage } = ctx;
  const profileDir = resolveProfileDir(options.profileDir);
  await ctx.run.configure({
    ...options, profileDir,
    evaluationFocus: options.evaluationFocus || DEFAULT_CREATIVE_EVALUATION_FOCUS,
    evaluationRequirements: options.evaluationRequirements || VIRAL_VIDEO_EVALUATION_REQUIREMENTS,
    skipMediaDownload: false,
  });
  const storage = getPipelineStorage('ytbhot', options.storageDir);

  logger.info('Ytbhot viral video pipeline initialized', {
    runId,
    query: options.query,
    outDir,
    dryRun: options.dryRun,
    flowModel: options.flowModel,
    clipDuration: options.clipDuration,
  });

  // Stage 1: check-env
  notify('check-env', 'Stage 1/12: Verifying environment configuration, LLM, Chromium, yt-dlp, and ffmpeg');
  const stage1Start = Date.now();
  let envSummary: EnvCheckSummary;
  try {
    envSummary = await checkEnvStage({ profileDir, storageDir: options.storageDir, pipelineId: 'ytbhot' }, logger);
    recordStage('check-env', 'completed', Date.now() - stage1Start, 'Environment checks passed', undefined, {
      ...envSummary,
    });
  } catch (err: any) {
    const errMsg = `Environment check failed: ${err.message}`;
    recordStage('check-env', 'failed', Date.now() - stage1Start, errMsg, err.message);
    throw new Error(errMsg);
  }

  // Stage 2: check-ytb
  notify('check-ytb', 'Stage 2/12: Checking YouTube cookies statically and dynamically via yt-dlp');
  const stage2Start = Date.now();
  let ytbSummary: YtbCheckSummary;
  try {
    ytbSummary = await checkYtbStage(options.cookiePath, { proxyUrl: options.proxyUrl }, logger);
    recordStage(
      'check-ytb',
      ytbSummary.valid ? 'completed' : 'failed',
      Date.now() - stage2Start,
      ytbSummary.valid ? 'YouTube authentication cookies valid' : 'Cookies missing or expired',
      ytbSummary.valid ? undefined : 'YouTube cookies invalid',
      { valid: ytbSummary.valid, stage: ytbSummary.stage }
    );
  } catch (err: any) {
    recordStage('check-ytb', 'failed', Date.now() - stage2Start, 'Cookie check error', err.message);
    ytbSummary = {
      cookieFileExists: false,
      valid: false,
      stage: 'file_check',
      refreshedViaBrowser: false,
      cookiePath: path.resolve(options.cookiePath),
    };
  }

  // Stage 3: use browser if needed (browser-refresh)
  if (!ytbSummary.valid) {
    notify('browser-refresh', 'Stage 3/12: Launching Ungoogled Chromium to refresh YouTube cookies');
    const stage3Start = Date.now();
    try {
      ytbSummary = await refreshYtbCookiesIfNeeded(
        options.cookiePath,
        profileDir,
        options.browserPath,
        logger,
        options.viewport
      );
      recordStage(
        'browser-refresh',
        ytbSummary.valid ? 'completed' : 'failed',
        Date.now() - stage3Start,
        ytbSummary.valid ? 'Refreshed cookies successfully via browser' : 'Cookie refresh failed validation',
        ytbSummary.valid ? undefined : 'Cookies invalid after browser refresh'
      );
    } catch (err: any) {
      recordStage('browser-refresh', 'failed', Date.now() - stage3Start, 'Browser refresh failed', err.message);
      ytbSummary = { ...ytbSummary, valid: false };
    }
  } else {
    recordStage('browser-refresh', 'skipped', 0, 'Existing YouTube cookies are valid; browser launch skipped');
  }
  if (!ytbSummary.valid) {
    throw new Error(
      'YouTube authentication failed: cookies missing/expired and browser refresh could not restore a valid session. Sign in (npm run flow:login / refresh-cookies) and retry. Aborting pipeline.'
    );
  }

  // Initialize persistent storage for ytbhot pipeline
  await storage.init();

  if (ytbSummary.valid && stages['check-ytb']?.status === 'failed') {
    recordStage('check-ytb', 'completed', Date.now() - stage2Start, 'YouTube authentication restored by browser refresh');
  }

  // Stage 5 & 6 Prep: Standard Reusability Check
  const effectiveTopic = options.topic || options.query;
  const topicSlug = slugifyTopic(effectiveTopic);
  const shouldRemoveAllStandards = Boolean(options.removeAllStandards);
  const shouldRemoveStandard = Boolean(shouldRemoveAllStandards || options.removeExistingStandard || options.removeStandard);
  if (shouldRemoveAllStandards) {
    notify('standard-gen', 'Stage 5/12: Removing all evaluation standards in directory as requested (--remove-all-standards)');
  } else if (shouldRemoveStandard) {
    notify('standard-gen', 'Stage 5/12: Removing existing evaluation standard on disk as requested');
  }

  const reusableCheck = await resolveReusableStandard(
    topicSlug,
    {
      standardPath: options.standardPath,
      standardsDir: options.standardsDir || storage.standardsDir,
      reuseStandard: shouldRemoveStandard ? false : options.reuseStandard,
      forceNewStandard: shouldRemoveStandard ? true : options.forceNewStandard,
      removeExistingStandard: shouldRemoveStandard,
      removeStandard: shouldRemoveStandard,
      removeAllStandards: shouldRemoveAllStandards,
    },
    logger
  );

  if (shouldRemoveStandard && reusableCheck.removedPaths && reusableCheck.removedPaths.length > 0) {
    recordStage(
      'standard-gen',
      'in_progress',
      5,
      `Removed ${reusableCheck.removedPaths.length} standard file(s): ${reusableCheck.removedPaths.map((p) => path.basename(p)).join(', ')}`
    );
  }

  if (reusableCheck.reused && reusableCheck.standard) {
    await ctx.run.write('standard', reusableCheck.standard);
    notify(
      'standard-load',
      `Stage 5/12: Reusing verified evaluation standard (${reusableCheck.standard.meta.standardHash.slice(0, 12)}...)`
    );
    recordStage(
      'standard-load',
      'completed',
      10,
      `Reused evaluation standard for topic "${reusableCheck.standard.meta.topic}"`,
      undefined,
      { standardHash: reusableCheck.standard.meta.standardHash, source: reusableCheck.sourcePath }
    );
  } else {
    notify('standard-gen', 'Stage 5/12: Will distill fresh 3-round LLM evaluation standard during research');
  }

  // Stage 4, 7, 8, 9: Research Engine
  notify('search-ytb', `Stage 4/12: [FastEval] Searching YouTube via browser for "${options.query}"`);
  const fastEvalResult: FastEvalResult = await runFastEvalFromRun(ctx.run, (stage, detail) => {
    notify('search-ytb', `FastEval [${stage}]: ${detail || ''}`);
  });

  notify('search-ytb', `Stage 4/12: Researching candidates matching "${options.query}"`);
  const researchStart = Date.now();

  const researchExecution = await runResearchPipeline(ctx.run, {
    transcriptStorage: storage,
    videoStorage: storage,
    refreshCookies: async () => {
      try {
        logger?.info('Refreshing YouTube cookies via CDP browser...');
        const result = await refreshYtbCookiesIfNeeded(
          options.cookiePath,
          profileDir,
          options.browserPath,
          logger,
          options.viewport
        );
        if (result.valid) {
          ytbSummary = result;
          return options.cookiePath;
        }
        return null;
      } catch (err: any) {
        logger?.warn(`CDP cookie refresh failed: ${err.message}`);
        return null;
      }
    },
    onProgress: (stage, detail) => {
      notify('search-ytb', `Research Subsystem [${stage}]: ${detail || ''}`);
    },
  });

  const { search, filtered, standard, selection, segments, flowScript, evaluations, frameEvidence, framesResult } = researchExecution;
  const researchDurationMs = Date.now() - researchStart;

  // Record Stage 4: search-ytb
  recordStage(
    'search-ytb',
    'completed',
    Math.round(researchDurationMs * 0.2),
    `Discovered ${search.candidates.length} candidates (${filtered.kept.length} eligible, ${filtered.rejected.length} filtered)`
  );

  // Record Stage 5: standard generation (if not reused)
  if (!reusableCheck.reused) {
    recordStage(
      'standard-gen',
      'completed',
      Math.round(researchDurationMs * 0.25),
      `Distilled 3-round LLM evaluation standard (${standard.meta.standardHash.slice(0, 12)}...)`,
      undefined,
      { standardHash: standard.meta.standardHash, topic: standard.meta.topic }
    );
  }

  // Stage 6: saved evaluation standard for reuse
  notify('standard-save', 'Stage 6/12: Persisting canonical evaluation standard for future pipeline runs');
  const stage6Start = Date.now();
  const savedStandardPath = await persistStandardForReuse(
    standard,
    reusableCheck.targetSavePath,
    options.saveStandardPath,
    logger
  );
  recordStage(
    'standard-save',
    'completed',
    Date.now() - stage6Start,
    `Standard saved for topic "${standard.meta.topic}" to ${savedStandardPath}`,
    undefined,
    { savedPath: savedStandardPath, hash: standard.meta.standardHash }
  );

  // Record Stage 7: evaluate
  notify('evaluate', `Stage 7/12: Scored candidates and selected winner "${selection.selected.video.title}"`);
  recordStage(
    'evaluate',
    'completed',
    Math.round(researchDurationMs * 0.3),
    `Winner: ${selection.selected.video.videoId} (${selection.selected.video.title}) with score ${
      selection.selected.evaluation?.compositeScore.toFixed(2) || 'N/A'
    }/5.00`,
    undefined,
    {
      winnerVideoId: selection.selected.video.videoId,
      compositeScore: selection.selected.evaluation?.compositeScore,
      decision: selection.decision,
    }
  );

  // Verify frame evidence was successfully extracted before proceeding to Flow generation
  const extractedFramesCount = framesResult?.frames?.length
    ?? frameEvidence?.segments?.reduce((acc, s) => acc + (s.grid?.frames?.length || 0), 0)
    ?? 0;

  if (!frameEvidence || extractedFramesCount === 0) {
    const errMsg = `Frame extraction failed or produced 0 frames for winner video ${selection.selected.video.videoId} — aborting pipeline immediately to protect Google Flow generation credits.`;
    recordStage(
      'extract-prompts',
      'failed',
      Math.round(researchDurationMs * 0.1),
      errMsg,
      errMsg
    );
    throw new Error(errMsg);
  }

  // Record Stage 8: extract-prompts
  const scriptClipsCount = flowScript?.clips?.length || 0;
  notify('extract-prompts', `Stage 8/12: Segmented winner transcript into ${segments.length} narrative scenes`);

  // Validate candidate video extracted prompts
  const promptValidation = validateExtractedPrompts(
    researchExecution.result.vlPrompts,
    {
      videoId: selection.selected.video.videoId,
      title: selection.selected.video.title,
    }
  );

  logger.info('Candidate video prompt validation:', {
    hasVideoPrompts: promptValidation.hasVideoPrompts,
    hasImagePrompts: promptValidation.hasImagePrompts,
    videoPromptsCount: promptValidation.videoPrompts.length,
    imagePromptsCount: promptValidation.imagePrompts.length,
    diagnostics: promptValidation.diagnosticMessage,
  });

  // Strict enforcement: if requireVideoPrompt is enabled and no video generation prompts were found, abort immediately
  if (options.requireVideoPrompt && !promptValidation.hasVideoPrompts) {
    const errMsg = `Candidate video ${selection.selected.video.videoId} ("${selection.selected.video.title}") contains NO AI video generation prompts (视频制作提示词). Pipeline aborted at Stage 8 [extract-prompts] to protect Google Flow generation credits. Run with --no-require-video-prompt to allow synthetic prompts from transcript.`;
    recordStage(
      'extract-prompts',
      'failed',
      Math.round(researchDurationMs * 0.1),
      errMsg,
      errMsg,
      {
        videoId: selection.selected.video.videoId,
        requireVideoPrompt: true,
        videoPromptsCount: 0,
        imagePromptsCount: promptValidation.imagePrompts.length,
        diagnostics: promptValidation.diagnosticMessage,
      }
    );
    throw new AppError({
      code: ErrorCodes.NO_VIDEO_PROMPT_FOUND,
      message: errMsg,
      stage: 'pipeline',
      task: 'extract-prompts',
      retryable: false,
    });
  }

  if (segments.length === 0 && scriptClipsCount === 0) {
    const errMsg = 'Segment extraction produced 0 scenes and no flow-script clips — cannot generate video prompts. Aborting to save Flow credits.';
    recordStage(
      'extract-prompts',
      'failed',
      Math.round(researchDurationMs * 0.1),
      errMsg,
      errMsg
    );
    throw new Error(errMsg);
  }

  const promptDetail = promptValidation.hasVideoPrompts
    ? `Extracted ${promptValidation.videoPrompts.length} video prompt(s), ${
        promptValidation.hasImagePrompts
          ? `${promptValidation.imagePrompts.length} image prompt(s)`
          : 'supplemented static keyframe image prompts via LLM'
      }`
    : `Transcript-synthesized prompts (${segments.length} scenes)`;

  if (segments.length === 0 && scriptClipsCount > 0) {
    recordStage(
      'extract-prompts',
      'completed',
      Math.round(researchDurationMs * 0.1),
      `No transcript scenes available; using flow-script with ${scriptClipsCount} clips. ${promptDetail}`,
      undefined,
      {
        hasVideoPrompts: promptValidation.hasVideoPrompts,
        hasImagePrompts: promptValidation.hasImagePrompts,
        videoPromptsCount: promptValidation.videoPrompts.length,
        imagePromptsCount: promptValidation.imagePrompts.length,
      }
    );
  } else {
    recordStage(
      'extract-prompts',
      'completed',
      Math.round(researchDurationMs * 0.1),
      `Extracted ${segments.length} narrative scenes. ${promptDetail}`,
      undefined,
      {
        hasVideoPrompts: promptValidation.hasVideoPrompts,
        hasImagePrompts: promptValidation.hasImagePrompts,
        videoPromptsCount: promptValidation.videoPrompts.length,
        imagePromptsCount: promptValidation.imagePrompts.length,
      }
    );
  }

  // Record Stage 9: gen-prompts
  notify('gen-prompts', `Stage 9/12: Generated Veo-optimized video script with ${scriptClipsCount} clips`);
  recordStage(
    'gen-prompts',
    flowScript ? 'completed' : 'failed',
    Math.round(researchDurationMs * 0.15),
    `Generated ${scriptClipsCount} Veo-optimized clip prompts in flow-video-script.json`
  );

  // Prepare Subsystem Summaries
  const searchSummary: SearchSummary = {
    query: options.query,
    totalDiscovered: search.candidates.length,
    eligibleCount: filtered.kept.length,
    rejectedCount: filtered.rejected.length,
    candidates: search.candidates,
  };

  const standardSummary: StandardSummary = {
    standard,
    standardHash: standard.meta.standardHash,
    reused: reusableCheck.reused,
    sourcePath: reusableCheck.sourcePath,
    savedPath: savedStandardPath,
    topic: standard.meta.topic,
  };

  const evaluationSummary: EvaluationSummary = {
    evaluations: evaluations?.evaluations || [],
    decision: selection.decision,
    winner: selection.selected.video,
    compositeScore: selection.selected.evaluation?.compositeScore || selection.selected.score.total,
    displayBand: selection.selected.evaluation?.displayBand || 'Selected',
    isSelectable: selection.selected.evaluation?.selectable ?? true,
    reason: selection.decision.reason,
    fasteval: {
      enabled: true,
      gridImagePath: fastEvalResult.gridImagePath,
      winnerIndex: fastEvalResult.winnerIndex,
      winnerVideoId: fastEvalResult.winner.videoId,
      winnerTitle: fastEvalResult.winner.title,
      winnerStyle: fastEvalResult.style,
      reasoning: fastEvalResult.reasoning,
      candidatesCount: fastEvalResult.candidates.length,
      topCandidates: fastEvalResult.topCandidates,
    },
  };

  const extractedPromptsSummary: ExtractedPromptsSummary = {
    scenesCount: segments.length,
    sourcePromptsCount: (researchExecution.result.vlPrompts || []).length,
    videoPromptsCount: promptValidation.videoPrompts.length,
    imagePromptsCount: promptValidation.imagePrompts.length,
    hasVideoPrompts: promptValidation.hasVideoPrompts,
    hasImagePrompts: promptValidation.hasImagePrompts,
    supplementedImagePrompts: promptValidation.hasVideoPrompts && !promptValidation.hasImagePrompts,
    diagnostics: promptValidation.diagnosticMessage,
    segments: segments.map((seg, idx) => ({
      segmentId: seg.segmentId || `scene-${String(idx + 1).padStart(3, '0')}`,
      title: seg.title || `Scene ${idx + 1}`,
      startSec: seg.startSec,
      endSec: seg.endSec,
      narration: seg.summary || '',
    })),
  };

  if (researchExecution.result.detectedOrientation) {
    const votes = researchExecution.result.orientationVotes;
    logger.info(
      `Detected orientation from reference YouTube video: ${researchExecution.result.detectedOrientation} ` +
      `(${votes?.portrait ?? 0} portrait vs ${votes?.landscape ?? 0} landscape recognitions)`
    );
  }

  const effectiveAspectRatio = researchExecution.result.detectedOrientation || flowScript?.aspectRatio || options.aspectRatio;

  const scriptPath = await ctx.run.pathFor('script');
  const generatedScriptSummary: GeneratedScriptSummary = {
    script: flowScript as FlowVideoScript,
    scriptPath,
    totalClips: flowScript?.totalClips || 0,
    totalDurationSec: flowScript?.totalDurationSec || 0,
    aspectRatio: effectiveAspectRatio,
    clips: flowScript?.clips || [],
  };

  // Google Flow Stages (10, 11, 12)
  let flowProjectSummary: FlowProjectSummary | undefined;
  let flowGenerationSummary: FlowGenerationSummary | undefined;

  if (options.skipFlowGen || options.stopBeforeGen) {
    const reason = options.stopBeforeGen
      ? 'Pipeline stopped before generation — review artifacts below, then re-run without --stop-before-gen to proceed'
      : 'Flow generation skipped per options';
    notify('flow-login', `Stage 10/12: ${reason}`);
    recordStage('flow-login', 'skipped', 0, `Flow login skipped (${options.stopBeforeGen ? '--stop-before-gen' : '--skip-flow-gen'})`);
    recordStage('flow-project', 'skipped', 0, `Flow project creation skipped (${options.stopBeforeGen ? '--stop-before-gen' : '--skip-flow-gen'})`);
    recordStage('flow-generate', 'skipped', 0, `Flow video generation skipped (${options.stopBeforeGen ? '--stop-before-gen' : '--skip-flow-gen'})`);

    flowGenerationSummary = {
      totalClips: generatedScriptSummary.totalClips,
      completedClips: 0,
      failedClips: 0,
      skippedClips: generatedScriptSummary.totalClips,
      dryRun: options.dryRun,
      clipOutputs: generatedScriptSummary.clips.map((c) => ({
        clipIndex: c.clipIndex,
        title: c.title,
        imagePrompt: c.imagePrompt,
        visualPrompt: c.visualPrompt,
        status: 'skipped',
      })),
    };
  } else {
    const useExt = options.useExt || process.env.FLOW_USE_EXT === '1';
    const flowClient = useExt ? new FlowClientExt() : new FlowClient();

    try {
      // Stage 10: login flow.google.com
      if (!options.skipFlowLogin) {
        notify('flow-login', 'Stage 10/12: Verifying Google Flow authentication in persistent profile');
        const stage10Start = Date.now();
        try {
          await flowClient.login({ profileDir, headed: options.headed, viewport: options.viewport });
          recordStage('flow-login', 'completed', Date.now() - stage10Start, 'Authenticated with Google Flow');
        } catch (err: any) {
          recordStage('flow-login', 'failed', Date.now() - stage10Start, 'Flow login failed', err.message);
          throw new Error(`Google Flow authentication failed: ${err.message}`);
        }
      } else {
        recordStage('flow-login', 'skipped', 0, 'Flow login verification skipped (--skip-flow-login)');
      }

      // Stage 11: create-new-project
      notify('flow-project', 'Stage 11/12: Opening or creating workspace project on Google Flow');
      const stage11Start = Date.now();
      try {
        let project: FlowProject;
        if (options.dryRun) {
          project = {
            projectId: options.flowProjectId || 'dry-run-project',
            url: `https://flow.google.com/project/${options.flowProjectId || 'dry-run-project'}`,
          };
        } else {
          project = await flowClient.checkOrCreateProject(options.flowProjectId, {
            profileDir,
            headed: options.headed,
            viewport: options.viewport,
          });
        }

        await ctx.run.write('flowProject', project);
        flowProjectSummary = {
          projectId: project.projectId,
          url: project.url,
          isNew: !options.flowProjectId,
        };

        recordStage(
          'flow-project',
          'completed',
          Date.now() - stage11Start,
          `Project ready: ${project.projectId || 'New Project'} (${project.url})`,
          undefined,
          flowProjectSummary as unknown as Record<string, unknown>
        );
      } catch (err: any) {
        recordStage('flow-project', 'failed', Date.now() - stage11Start, 'Failed to create Flow project', err.message);
        throw new Error(`Google Flow project allocation failed: ${err.message}`);
      }

      // Stage 12: use new prompts to gen video
      notify(
        'flow-generate',
        `Stage 12/12: Batch generating ${options.dryRun ? '[DRY RUN] ' : ''}${generatedScriptSummary.totalClips} video clips with model "${options.flowModel}"`
      );
      const stage12Start = Date.now();
      const videoOutDir = path.join(outDir, 'generated-clips');
      await fs.mkdir(videoOutDir, { recursive: true });

      try {
        const batchResult: BatchResult = await generateFlowFromRun(ctx.run, flowClient);

        flowGenerationSummary = {
          totalClips: batchResult.totalClips,
          completedClips: batchResult.completedClips,
          failedClips: batchResult.failedClips,
          skippedClips: batchResult.skippedClips,
          dryRun: options.dryRun,
          batchResult,
          clipOutputs: batchResult.results.map((c: BatchClipResult) => ({
            clipIndex: c.clipIndex,
            title: c.title,
            imagePrompt: c.imagePrompt,
            imageUrl: c.imageUrl,
            localImagePath: c.localImagePath,
            visualPrompt: c.visualPrompt || '',
            status: c.status,
            videoUrl: c.videoUrl,
            localVideoPath: c.outputPath,
            error: c.error,
          })),
        };

        if (batchResult.failedClips > 0) {
          const firstFailed = batchResult.results.find((c: BatchClipResult) => c.status === 'failed');
          const failReason = firstFailed?.error || `${batchResult.failedClips} clip(s) failed generation`;
          const errMsg = `Flow video synthesis failed on clip ${firstFailed?.clipIndex ?? 1} ("${firstFailed?.title || 'clip'}"): ${failReason}`;
          recordStage('flow-generate', 'failed', Date.now() - stage12Start, errMsg, firstFailed?.error);
          // ANY clip failure is terminal: abort the pipeline so the CLI catch-block sends
          // the failure alert via webhook immediately. Continuing would waste tokens on
          // downstream stages (tutorial video) that depend on the missing clips.
          const terminalErr: any = new Error(
            firstFailed?.error && isAntiAbuseError(firstFailed.error)
              ? `Google Flow anti-abuse risk control triggered — pipeline aborted. ${errMsg}`
              : `Pipeline aborted: ${errMsg}`
          );
          if (isFlowTargetingMismatch(firstFailed?.error)) {
            terminalErr.code = ErrorCodes.FLOW_TARGETING_MISMATCH;
          }
          terminalErr.flowProjectId = flowProjectSummary?.projectId;
          terminalErr.flowProjectUrl = flowProjectSummary?.url;
          throw terminalErr;
        } else {
          recordStage(
            'flow-generate',
            'completed',
            Date.now() - stage12Start,
            `Generated ${batchResult.completedClips}/${batchResult.totalClips} clips`,
            undefined,
            { completed: batchResult.completedClips, failed: 0, dryRun: options.dryRun }
          );
        }
      } catch (err: any) {
        recordStage('flow-generate', 'failed', Date.now() - stage12Start, 'Batch generation failed', err.message);
        // Re-throw: aborting is the whole point. Swallowing here let the pipeline run the
        // tutorial stage after Flow generation had already failed.
        throw err;
      }
    } finally {
      // Flow stage completed all tasks and downloads — keep persistent browser alive for subsequent pipeline runs
      notify('flow-generate', 'Flow tasks and downloads finished — maintaining persistent browser session');
    }
  }

  // Stage 13: tutorial-gen — AI commentary tutorial video (解说视频)
  // Skip when Flow generation produced no clips: burning LLM/TTS/render tokens on a
  // commentary video about clips that were never generated is pure waste.
  let tutorialSummary: TutorialGenerationSummary | undefined;
  const generatedClipCount = flowGenerationSummary?.completedClips ?? 0;
  if (options.skipTutorial) {
    recordStage('tutorial-gen', 'skipped', 0, 'Tutorial video generation skipped (--skip-tutorial)');
  } else if (options.dryRun) {
    recordStage('tutorial-gen', 'skipped', 0, 'Tutorial video generation skipped in dry-run mode (--dry-run)');
  } else if (options.stopBeforeGen) {
    recordStage('tutorial-gen', 'skipped', 0, 'Tutorial video generation skipped when stopped before generation (--stop-before-gen)');
  } else if (generatedClipCount === 0 || (flowGenerationSummary?.failedClips ?? 0) > 0) {
    recordStage('tutorial-gen', 'skipped', 0, 'Tutorial video generation skipped: Flow generation failed or produced no clips');
    notify('tutorial-gen', 'Skipping tutorial video: Flow generation failed or produced no clips, skipping to save tokens');
  } else {
    notify('tutorial-gen', 'Stage 13/14: Generating AI commentary tutorial video (storyboard + edge-tts + headless render)');
    const stageTutorialStart = Date.now();
    try {
      tutorialSummary = await createTutorialFromRun(ctx.run, {
        logger,
        onProgress: (stage, message) => notify('tutorial-gen', `Tutorial Subsystem [${stage}]: ${message}`),
      });
      recordStage(
        'tutorial-gen',
        'completed',
        Date.now() - stageTutorialStart,
        `Tutorial video ready: ${tutorialSummary.sceneCount} scenes, ${tutorialSummary.totalDurationSec.toFixed(1)}s, ${tutorialSummary.framesRendered} frames`,
        undefined,
        {
          videoPath: tutorialSummary.videoPath,
          playerPath: tutorialSummary.playerPath,
          storyboardPath: tutorialSummary.storyboardPath,
          voice: tutorialSummary.voice,
        }
      );
    } catch (err: any) {
      recordStage('tutorial-gen', 'failed', Date.now() - stageTutorialStart, 'Tutorial video generation failed', err.message);
      logger.warn(`Tutorial video generation failed: ${err.message}`);
    }
  }

  // Stage 14: gen final report
  notify('report', 'Stage 14/14: Compiling comprehensive Markdown and JSON execution reports');
  const stage13Start = Date.now();
  const completedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startTime;

  const intermediateResult: ViralPipelineResult = {
    runId,
    query: options.query,
    topic: standard.meta.topic,
    startedAt: new Date(startTime).toISOString(),
    completedAt,
    totalDurationMs,
    stages,
    envCheck: envSummary,
    ytbCheck: ytbSummary,
    search: searchSummary,
    standard: standardSummary,
    evaluation: evaluationSummary,
    fasteval: evaluationSummary.fasteval,
    extractedPrompts: extractedPromptsSummary,
    generatedScript: generatedScriptSummary,
    flowProject: flowProjectSummary,
    flowGeneration: flowGenerationSummary,
    tutorial: tutorialSummary,
    reportJsonPath: path.join(outDir, 'final-report.json'),
    reportMarkdownPath: path.join(outDir, 'FINAL_REPORT.md'),
    reportHtmlPath: path.join(outDir, 'FINAL_REPORT.html'),
    outDir,
  };

  const { jsonPath, markdownPath, htmlPath } = await saveFinalReports(intermediateResult, outDir);
  recordStage('report', 'completed', Date.now() - stage13Start, 'Generated FINAL_REPORT.md, FINAL_REPORT.html and final-report.json');

  intermediateResult.reportJsonPath = jsonPath;
  intermediateResult.reportMarkdownPath = markdownPath;
  intermediateResult.reportHtmlPath = htmlPath;

  const manifestPath = path.join(outDir, 'manifest.json');
  intermediateResult.manifestPath = manifestPath;
  intermediateResult.logFilePath = logger.logFilePath;
  intermediateResult.jsonlLogFilePath = logger.jsonlLogFilePath;

  // Persist latest Flow credits upon run completion if available
  if (flowGenerationSummary?.batchResult?.finalCredits !== undefined) {
    const finalCredits = flowGenerationSummary.batchResult.finalCredits;
    await storage.updateFlowCredits(finalCredits, {
      source: 'flow.google.com',
      runId,
      profileDir,
    }).catch(() => {});
    logger.info(`Updated ytbhot pipeline config Flow credits: ${finalCredits} credits remaining`);
  }

  notify('complete', `Pipeline execution finished successfully in ${(totalDurationMs / 1000).toFixed(1)}s!`);
  logger.event('pipeline:complete', {
    runId,
    outDir,
    totalDurationMs,
    winner: selection.selected.video.videoId,
    clips: generatedScriptSummary.totalClips,
    manifestPath,
  });

  return intermediateResult;
}

/**
 * Tracks the stage that was ACTIVE when a failure occurred and tags token-spending
 * failures as systemic-fatal, so the continuous runner stops instead of re-running
 * the round (and re-burning the same LLM/Flow tokens). Runs the real pipeline body
 * with a context Proxy so no stage-identification plumbing is needed in the body.
 */
async function executeViralVideoWithFailurePolicy(
  options: ViralPipelineOptions,
  ctx: PipelineContext
): Promise<ViralPipelineResult> {
  let activeStage: string | undefined;
  const trackedCtx = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'notify') {
        return (stage: string, message: string, data?: unknown) => {
          activeStage = stage;
          target.notify(stage, message, data);
        };
      }
      if (prop === 'recordStage') {
        return (...args: Parameters<PipelineContext['recordStage']>) => {
          activeStage = args[0];
          return target.recordStage(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as PipelineContext;

  try {
    return await executeViralVideo(options, trackedCtx);
  } catch (err) {
    tagTokenStageFailure(err, activeStage, ErrorCodes.TOKEN_STAGE_FAILED);
    throw err;
  }
}

export const ytbhotPipeline: Pipeline<ViralPipelineInput, ViralPipelineResult> = {
  id: 'ytbhot',
  name: 'YouTube Hot Viral Video Generation',
  description: 'Autonomous end-to-end YouTube viral video discovery, research evaluation, and Veo generation',
  schema: ViralPipelineOptionsSchema,
  stages: VIRAL_PIPELINE_STAGES,
  execute: async (rawOptions: ViralPipelineInput, customCtx?: any) => {
    const validated = ViralPipelineOptionsSchema.parse(rawOptions) as ViralPipelineOptions;
    const ctx = customCtx || (await createDefaultExecutionContext('ytbhot', validated.outDir, { config: validated }));
    return executeViralVideoWithFailurePolicy(validated, ctx);
  },
  reports: {
    generateMarkdownReport: generateFinalReportMarkdown,
    generateJsonReport: generateFinalReportJson,
    saveReports: saveFinalReports,
    printSummary: printExecutiveSummary,
  },
};
export const viralVideoPipeline = ytbhotPipeline;

export const DEFAULT_VIRAL_QUERY = 'AI make Niche Viral Video';
