import path from 'node:path';
import fs from 'node:fs/promises';
import { launchBrowser } from '../browser/launcher.js';
import { resolveProfileDir } from '../utils/browser.js';
import { createRunLogger, type RunLogger } from '../utils/logger.js';
import { generateRunId, ensureOutputDir } from '../utils/run.js';
import { checkEnvStage } from './stages/check-env.js';
import {
  XHOT_STAGES,
  XHotPipelineOptionsSchema,
  type XHotPipelineOptions,
  type XHotFullResult,
  type StageResult,
  type StageStatus,
  type EnvCheckSummary,
} from './contracts.js';
import {
  ensureXLogin,
  searchXCandidates,
  buildXHotGrid,
  evaluateXHotCandidatesWithVL,
  harvestWinnerTopicMaterials,
  createXHotPresentationVideo,
  type XHotCandidate,
  type XHotEvalResult,
  type XHotHarvestResult,
} from '../xhot/index.js';
import {
  generateXHotMarkdown,
  generateXHotJson,
  printXHotSummary,
} from './report.js';

export interface PipelineExecutionContext {
  runId: string;
  outDir: string;
  startTime: number;
  logger: RunLogger;
  stages: Record<string, StageResult>;
  notify: (stage: string, message: string) => void;
  recordStage: (
    stage: string,
    status: StageStatus,
    durationMs: number,
    summary?: string,
    error?: string,
    details?: Record<string, unknown>
  ) => void;
  saveReports: (md: string, json: string) => Promise<void>;
}

export async function createDefaultExecutionContext(
  options: XHotPipelineOptions
): Promise<PipelineExecutionContext> {
  const runId = generateRunId('xhot');
  const outDir = await ensureOutputDir(options.outDir, runId);
  const logger = createRunLogger({ runId, logDir: outDir });
  const startTime = Date.now();
  const stages: Record<string, StageResult> = {};

  const recordStage = (
    stage: string,
    status: StageStatus,
    durationMs: number,
    summary?: string,
    error?: string,
    details?: Record<string, unknown>
  ) => {
    stages[stage] = { stage, status, durationMs, summary, error, details };
    if (status === 'failed') {
      logger.error(`[${stage}] FAILED (${(durationMs / 1000).toFixed(1)}s): ${error || summary}`);
    } else {
      logger.info(`[${stage}] ${status.toUpperCase()} (${(durationMs / 1000).toFixed(1)}s): ${summary || ''}`);
    }
  };

  const notify = (stage: string, message: string) => {
    logger.info(`[${stage}] ${message}`);
  };

  const saveReports = async (md: string, json: string) => {
    await fs.writeFile(path.join(outDir, 'report.md'), md, 'utf-8');
    await fs.writeFile(path.join(outDir, 'result.json'), json, 'utf-8');
  };

  return {
    runId,
    outDir,
    startTime,
    logger,
    stages,
    notify,
    recordStage,
    saveReports,
  };
}

export async function executeXHotPipeline(
  options: XHotPipelineOptions,
  customCtx?: PipelineExecutionContext
): Promise<XHotFullResult> {
  const ctx = customCtx || (await createDefaultExecutionContext(options));
  const { runId, outDir, startTime, logger, stages, notify, recordStage } = ctx;
  const profileDir = resolveProfileDir(options.profileDir);

  // 1. Check Env
  notify('check-env', 'Stage 1/7: Verifying Chromium, persistent profile, LLM, yt-dlp, and ffmpeg');
  const stage1Start = Date.now();
  let envCheck: EnvCheckSummary;
  try {
    envCheck = await checkEnvStage({ profileDir }, logger);
    recordStage(
      'check-env',
      'completed',
      Date.now() - stage1Start,
      `Environment verified (Chromium: ${envCheck.chromiumInstalled ? 'OK' : 'MISSING'})`,
      undefined,
      envCheck as unknown as Record<string, unknown>
    );
  } catch (err: any) {
    recordStage('check-env', 'failed', Date.now() - stage1Start, 'Environment check failed', err.message);
    throw err;
  }

  // Dry-run mode
  if (options.dryRun) {
    notify('x-login', '[DRY RUN] Simulating X login and pipeline stages...');
    recordStage('x-login', 'completed', 50, '[DRY RUN] X login skipped');
    recordStage('x-search-grid', 'completed', 50, '[DRY RUN] Search grid skipped');
    recordStage('x-eval', 'completed', 50, '[DRY RUN] VL evaluation skipped');
    recordStage('x-harvest', 'completed', 50, '[DRY RUN] Harvesting skipped');
    recordStage('x-video', 'skipped', 0, '[DRY RUN] Video generation skipped');

    const dryResult: XHotFullResult = {
      runId,
      pipelineId: 'xhot',
      query: options.query,
      outDir,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      totalDurationMs: Date.now() - startTime,
      winner: {
        rank: 1,
        index: 1,
        id: 'dry-run-001',
        name: `${options.query} Alpha`,
        summary: 'Dry run breakthrough topic',
        reason: 'Leading discussion in simulation',
      },
      topCandidates: [
        { rank: 1, index: 1, id: 'dry-1', name: `${options.query} Alpha`, summary: 'Model breakthrough', reason: 'High impact' },
        { rank: 2, index: 2, id: 'dry-2', name: `${options.query} Beta`, summary: 'Speed optimization', reason: 'Fast inference' },
        { rank: 3, index: 3, id: 'dry-3', name: `${options.query} Gamma`, summary: 'Open weights release', reason: 'Community buzz' },
      ],
      stages,
      envCheck,
    };
    const md = generateXHotMarkdown(dryResult);
    const json = generateXHotJson(dryResult);
    await ctx.saveReports(md, json);
    recordStage('report', 'completed', 10, 'Dry-run report generated');
    return dryResult;
  }

  let browserSession: any = null;
  let candidates: XHotCandidate[] = [];
  let gridPath = '';
  let evalResult: XHotEvalResult | undefined;
  let harvestResult: XHotHarvestResult | undefined;
  let tutorialSummary: any = undefined;

  try {
    notify('x-login', 'Stage 2/7: Connecting to Chromium and ensuring X persistent login');
    const stage2Start = Date.now();
    browserSession = await launchBrowser({
      profileDir,
      headless: options.headless ?? !options.headed,
      reuseSession: true,
      keepAlive: true,
    });

    await ensureXLogin(browserSession.page, {
      onProgress: (m) => notify('x-login', m),
    });
    recordStage('x-login', 'completed', Date.now() - stage2Start, 'Logged into X with persistent session');

    // Stage 3: Topic Search & Grid
    notify('x-search-grid', `Stage 3/7: Searching X for "${options.query}" and assembling screenshot grid`);
    const stage3Start = Date.now();
    candidates = await searchXCandidates(browserSession.page, {
      query: options.query,
      candidateCount: options.candidateCount,
      maxAgeHours: options.maxCandidateAgeHours,
      outDir,
      onProgress: (m) => notify('x-search-grid', m),
    });

    if (candidates.length === 0) {
      throw new Error(`No tweets found on X for query "${options.query}"`);
    }

    gridPath = path.join(outDir, 'xhot-grid.png');
    const { buffer: gridBuffer } = await buildXHotGrid({
      candidates,
      outputPath: gridPath,
    });
    recordStage(
      'x-search-grid',
      'completed',
      Date.now() - stage3Start,
      `Captured ${candidates.length} candidate cards and created ${path.basename(gridPath)}`
    );

    // Stage 4: VL Model Top 3 Evaluation
    notify('x-eval', 'Stage 4/7: Evaluating candidates via Multimodal VL model to pick Top 3 and Winner');
    const stage4Start = Date.now();
    evalResult = await evaluateXHotCandidatesWithVL({
      query: options.query,
      candidates,
      gridBuffer,
      gridImagePath: gridPath,
      onProgress: (m) => notify('x-eval', m),
    });
    recordStage(
      'x-eval',
      'completed',
      Date.now() - stage4Start,
      `VL evaluated candidates: Winner is "${evalResult.winner.name}" (#${evalResult.winner.index})`
    );

    // Stage 5: Deep Search & Harvest Winner Topic Materials
    const winnerName = evalResult.winner.name;
    notify('x-harvest', `Stage 5/7: Searching X for winner "${winnerName}" to harvest tweets and media`);
    const stage5Start = Date.now();
    harvestResult = await harvestWinnerTopicMaterials(browserSession.page, {
      winnerName,
      targetCount: 6,
      outDir,
      onProgress: (m) => notify('x-harvest', m),
    });
    recordStage(
      'x-harvest',
      'completed',
      Date.now() - stage5Start,
      `Harvested ${harvestResult.items.length} tweets and ${harvestResult.harvestedMediaCount} media items`
    );
  } finally {
    if (browserSession?.browser) {
      try {
        await browserSession.page.close().catch(() => {});
      } catch {}
    }
  }

  // Stage 6: Video Generation
  if (!options.skipVideo && evalResult && harvestResult) {
    notify('x-video', 'Stage 6/7: Generating presentation video via OpusVideo tutorial canvas engine');
    const stage6Start = Date.now();
    try {
      tutorialSummary = await createXHotPresentationVideo({
        query: options.query,
        evalResult,
        harvestResult,
        outDir,
        fps: options.tutorialFps,
        engine: options.tutorialEngine,
        subtitles: options.tutorialSubtitles,
        ttsVoice: options.ttsVoice,
        ttsRate: options.ttsRate,
        profileDir,
        onProgress: (stg, msg) => notify('x-video', `[${stg}] ${msg}`),
      });
      recordStage(
        'x-video',
        'completed',
        Date.now() - stage6Start,
        `Rendered presentation video (${tutorialSummary.totalDurationSec.toFixed(1)}s, ${tutorialSummary.sceneCount} scenes)`
      );
    } catch (err: any) {
      recordStage('x-video', 'failed', Date.now() - stage6Start, 'Presentation video rendering failed', err.message);
      logger.error('Failed to render presentation video:', err);
    }
  } else {
    recordStage('x-video', 'skipped', 0, 'Presentation video stage skipped (--skip-video)');
  }

  // Stage 7: Report Generation
  notify('report', 'Stage 7/7: Compiling Markdown and JSON reports');
  const stage7Start = Date.now();
  const completedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startTime;

  const fullResult: XHotFullResult = {
    runId,
    pipelineId: 'xhot',
    query: options.query,
    outDir,
    startedAt: new Date(startTime).toISOString(),
    completedAt,
    totalDurationMs,
    winner: evalResult?.winner,
    topCandidates: evalResult?.topCandidates,
    gridImagePath: gridPath,
    harvestResult,
    tutorial: tutorialSummary,
    stages,
    envCheck,
  };

  const mdReport = generateXHotMarkdown(fullResult);
  const jsonReport = generateXHotJson(fullResult);
  await ctx.saveReports(mdReport, jsonReport);
  recordStage('report', 'completed', Date.now() - stage7Start, 'Reports saved');

  return fullResult;
}
