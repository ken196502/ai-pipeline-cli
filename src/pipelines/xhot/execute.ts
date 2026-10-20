import path from 'node:path';
import { launchBrowser } from '../../libs/browser/launcher.js';
import { resolveProfileDir } from '../../utils/browser.js';
import { checkEnvStage } from './stages/check-env.js';
import { createDefaultExecutionContext, type PipelineExecutionContext } from '../core/context.js';
import {
  XHOT_STAGES,
  XHotPipelineOptionsSchema,
  type XHotPipelineOptions,
  type XHotFullResult,
  type EnvCheckSummary,
} from './contracts.js';
import { ensureXLogin } from '../../modules/auth/auth.js';
import { searchXCandidates, buildXHotGrid, type XHotCandidate } from '../../modules/discovery/index.js';
import { evaluateXHotCandidatesWithVL, type XHotEvalResult } from '../../modules/evaluation/index.js';
import { harvestWinnerTopicMaterials, type XHotHarvestResult } from '../../modules/harvest/index.js';
import { createXHotPresentationVideo } from '../../modules/presentation/index.js';
import { generateXHotMarkdown, generateXHotJson, printXHotSummary } from './report.js';
import type { Pipeline } from '../core/contracts.js';

export async function executeXHotPipeline(
  options: XHotPipelineOptions,
  customCtx?: PipelineExecutionContext
): Promise<XHotFullResult> {
  const ctx = customCtx || (await createDefaultExecutionContext('xhot', options.outDir));
  const { runId, outDir, startTime, logger, stages, notify, recordStage } = ctx;
  const profileDir = resolveProfileDir(options.profileDir);

  // Stage 1: Check Env
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
    // Stage 2: X Persistent Login (Auth Module)
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

    // Stage 3: Topic Search & Grid (Discovery Module)
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

    // Stage 4: VL Model Top 3 Evaluation (Evaluation Module)
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

    // Stage 5: Deep Search & Harvest Winner Topic Materials (Harvest Module)
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

  // Stage 6: Video Generation (Presentation Module)
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

export const xhotPipeline: Pipeline<XHotPipelineOptions, XHotFullResult> = {
  id: 'xhot',
  name: 'Xhot Trending Video Pipeline',
  description: 'Search trending topics on X, rank with VL grid evaluation, harvest materials, and render presentation video',
  schema: XHotPipelineOptionsSchema,
  stages: XHOT_STAGES,
  execute: executeXHotPipeline,
  reports: {
    generateMarkdownReport: generateXHotMarkdown,
    generateJsonReport: generateXHotJson,
    printSummary: printXHotSummary,
  },
};
