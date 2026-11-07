/**
 * Resumes a failed Xhot run at Stage 6/7 (explainer video + report).
 *
 * The expensive, non-deterministic half of the pipeline (X search, VL evaluation,
 * harvest, LLM storyboard, edge-tts narration) is already on disk, and
 * `renderExplainerVideo` keeps committed `.render-chunks` segments. Re-rendering
 * from the bundle therefore costs only the frames that never made it, instead of
 * redoing the whole run (2026-11-05: a stalled frame at 64% threw away 66 minutes
 * of rendering and would have re-run every earlier stage).
 *
 * Nothing here is a fallback: a missing bundle or a corrupt timeline throws, and
 * the caller re-runs the pipeline instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { RunContext } from '../../run/index.js';
import { ExplainerTimelineSchema, type ExplainerVideoSummary } from '../../libs/player/contracts.js';
import { renderExplainerVideo } from '../../libs/player/render.js';
import type { RenderServiceRouteConfig } from '../../libs/player/render.js';
import { createExplainerGrid } from '../../libs/player/grid.js';
import type { StageResult } from '../core/contracts.js';
import { saveFinalReports } from './report.js';
import type { XHotFullResult } from './contracts.js';

export interface ResumeXHotVideoOptions {
  /** Run directory (or its run.json). */
  runDir: string;
  engine?: 'chromium' | 'firefox';
  concurrency?: number;
  crf?: number;
  preset?: string;
  profileDir?: string;
  /** Host render service routing (same semantics as the full pipeline). */
  renderService?: RenderServiceRouteConfig;
  /** Explicitly bypass the render service and render on this machine. */
  forceLocalRender?: boolean;
  onProgress?: (stage: string, message: string) => void;
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function resumeXHotVideo(options: ResumeXHotVideoOptions): Promise<XHotFullResult> {
  const outDir = path.resolve(options.runDir);
  const explainerDir = path.join(outDir, 'explainer');
  const progress =
    options.onProgress ?? ((stage: string, message: string) => console.log(pc.cyan(`[resume] [${stage}] ${message}`)));

  const required = {
    'run.json': path.join(outDir, 'run.json'),
    'final-report.json': path.join(outDir, 'final-report.json'),
    'explainer/explainer.json': path.join(explainerDir, 'explainer.json'),
    'explainer/assets/narration.wav': path.join(explainerDir, 'assets', 'narration.wav'),
  };
  for (const [label, filePath] of Object.entries(required)) {
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    if (!exists) {
      throw new Error(
        `cannot resume ${outDir}: ${label} is missing (${filePath}). ` +
          'Resume only works on a run that already produced its storyboard, narration and player bundle — re-run the pipeline.'
      );
    }
  }

  const previous = (await readJson(required['final-report.json'])) as XHotFullResult;
  const timeline = ExplainerTimelineSchema.parse(await readJson(required['explainer/explainer.json']));
  const run = await RunContext.open(required['run.json']);

  const resumeStartedAt = Date.now();
  const totalFrames = Math.max(1, Math.round(timeline.totalDurationSec * timeline.fps));
  progress(
    'render',
    `Re-rendering ${totalFrames} frames from the existing bundle (committed .render-chunks segments are reused)`
  );

  const renderResult = await renderExplainerVideo({
    explainerDir,
    timeline,
    narrationWavPath: required['explainer/assets/narration.wav'],
    outVideoPath: path.join(explainerDir, 'explainer-video.mp4'),
    engine: options.engine ?? 'chromium',
    crf: options.crf,
    preset: options.preset,
    profileDir: options.profileDir,
    concurrency: options.concurrency,
    renderService: options.renderService,
    forceLocalRender: options.forceLocalRender,
    onProgress: (rendered, total) => {
      const step = Math.max(1, Math.floor(total / 20));
      if (rendered % step === 0 || rendered === total) {
        progress('render', `${rendered}/${total} frames (${Math.round((rendered / total) * 100)}%)`);
      }
    },
  });

  const gridPath = path.join(explainerDir, 'explainer-grid.jpg');
  progress('grid', 'Building the contact-sheet grid from the rendered video');
  await createExplainerGrid({ videoPath: renderResult.videoPath, outPath: gridPath, count: 9 });

  const explainer: ExplainerVideoSummary = {
    status: 'completed',
    sceneCount: (timeline.clips || []).reduce((acc, clip) => acc + (clip.shots?.length ?? 0), 0),
    totalDurationSec: timeline.totalDurationSec,
    fps: timeline.fps,
    resolution: timeline.resolution,
    voice: timeline.voice?.voice ?? 'unknown',
    // The speech rate lives in the pipeline options, not in the bundle; keep the
    // value the previous summary recorded instead of inventing one.
    rate: previous.explainer?.rate ?? previous.tutorial?.rate ?? '+0%',
    narrationLanguage: timeline.narrationLanguage ?? 'en',
    assetsCount: timeline.assets?.length ?? 0,
    storyboardPath: path.join(outDir, '10-explainer-storyboard.json'),
    gridPath,
    timelinePath: path.join(explainerDir, 'explainer.json'),
    playerPath: path.join(explainerDir, 'explainer-player.html'),
    narrationPath: path.join(explainerDir, 'assets', 'narration.mp3'),
    hostScriptPath: path.join(explainerDir, 'render-on-host.command'),
    videoPath: renderResult.videoPath,
    framesRendered: renderResult.framesRendered,
  };

  await fs.writeFile(
    path.join(outDir, 'explainer-result.json'),
    JSON.stringify(explainer, null, 2) + '\n',
    'utf8'
  );

  const renderDurationMs = Date.now() - resumeStartedAt;
  await run.recordStage({
    stage: 'x-video',
    status: 'completed',
    durationMs: renderDurationMs,
    summary: `Re-rendered explainer video from the existing bundle (${timeline.totalDurationSec.toFixed(1)}s, ${explainer.sceneCount} scenes)`,
    details: { resumed: true, videoPath: renderResult.videoPath, framesRendered: renderResult.framesRendered },
  });
  progress('render', `Video ready: ${path.basename(renderResult.videoPath)}`);

  const snapshot = await run.snapshot();
  const result: XHotFullResult = {
    ...previous,
    runId: snapshot.runId,
    pipelineId: 'xhot',
    outDir,
    completedAt: new Date().toISOString(),
    totalDurationMs: (previous.totalDurationMs ?? 0) + renderDurationMs,
    stages: snapshot.stages as Record<string, StageResult>,
    explainer,
    tutorial: explainer,
  };

  const reportPaths = await saveFinalReports(result, outDir);
  result.reportMarkdownPath = reportPaths.markdownPath;
  result.reportHtmlPath = reportPaths.htmlPath;
  result.reportJsonPath = reportPaths.jsonPath;

  await run.recordStage({
    stage: 'report',
    status: 'completed',
    durationMs: 0,
    summary: 'Reports rebuilt after the resumed render',
  });
  await run.finish();
  progress('report', 'Reports rebuilt');

  return result;
}
