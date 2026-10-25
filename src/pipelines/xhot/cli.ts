import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import pc from 'picocolors';
import { executeXHotPipeline } from './execute.js';
import { printExecutiveSummary } from './report.js';
import { exitAfterFlush } from '../../utils/shutdown.js';
import {
  sendMsg,
  notifyError,
  formatDetailedErrorMessage,
  isLlmUnavailableError,
  notifyLlmUnavailableAndExit,
} from '../../utils/send_msg.js';
import { formatDurationMs } from '../../utils/time.js';
import { acquirePipelineLock, parseTopics, runPipeline24h } from '../core/index.js';
import type { XHotPipelineOptions, XHotFullResult } from './contracts.js';

/**
 * Pipelines that share this project's persistent Chromium profile — a second
 * concurrent run would hijack the first one's browser session.
 */
const PIPELINE_IDS = ['xhot', 'flowTutor'];

export function attachXHotOptions(cmd: Command): Command {
  return cmd
    .argument('[query]', 'Topic to search on X (e.g. "AI agents")')
    .option('-q, --query <string>', 'Topic to search on X')
    .option('--topics <topics>', 'Semicolon-separated list of topics for sequential/24h execution (e.g. "AI;new model;deepseek r1")')
    .option('--24h [limit]', 'Run continuously in 24-hour cycle mode. Max runs per topic per 24 hours (default: 1)', (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? true : n;
    })
    .option('-o, --out-dir <path>', 'Custom directory to store run artifacts')
    .option('--candidate-count <number>', 'Number of X candidates to evaluate in grid (default: 12)', (v) => parseInt(v, 10), 12)
    .option('--max-age-hours <number>', 'Max tweet age in hours for candidates (default: 72)', (v) => parseInt(v, 10), 72)
    .option('--profile-dir <path>', 'Custom Chromium profile directory (defaults to ./.chromium-profile)')
    .option('--headed', 'Run browser in headful mode for visible interaction', true)
    .option('--headless', 'Force browser headless mode', false)
    .option('--skip-video', 'Skip explainer video generation', false)
    .option('--explainer-engine <engine>', 'Explainer video render engine (chromium, firefox)', 'chromium')
    .option('--explainer-fps <n>', 'Frame rate of explainer video', (v) => parseInt(v, 10), 30)
    .option('--explainer-subtitles', 'Enable narration subtitles / captions', false)
    .option('--tutorial-engine <engine>', 'Legacy alias for --explainer-engine')
    .option('--tutorial-fps <n>', 'Legacy alias for --explainer-fps', (v) => parseInt(v, 10))
    .option('--tutorial-subtitles', 'Legacy alias for --explainer-subtitles')
    .option('--tts-voice <name>', 'edge-tts voice name for narration')
    .option('--tts-rate <rate>', 'edge-tts speech rate adjustment (e.g. +10%)', '+0%')
    .option('--dry-run', 'Run pipeline in dry-run mode without live network/generation calls', false);
}

/**
 * Sends rich success notifications via Telegram/Webhook including stats and media attachment.
 */
async function sendSuccessNotification(result: XHotFullResult): Promise<void> {
  const explainer = result.explainer || result.tutorial;
  const minutes = (result.totalDurationMs / 60000).toFixed(1);
  const msgLines = [
    `🔥 Xhot pipeline completed successfully in ${minutes} min`,
    `• Query Topic: ${result.query}`,
  ];

  if (result.winner) {
    msgLines.push(`• Winner (Top 1): ${result.winner.name}`);
    msgLines.push(`• Summary: ${result.winner.summary}`);
  }

  if (result.topCandidates && result.topCandidates.length > 0) {
    msgLines.push(`• Top 3 Rankings:`);
    for (const tc of result.topCandidates) {
      msgLines.push(`  #${tc.rank} ${tc.name}`);
    }
  }

  if (result.harvestResult) {
    msgLines.push(`• Materials: ${result.harvestResult.items.length} tweets, ${result.harvestResult.harvestedMediaCount} media files`);
  }

  if (explainer?.videoPath) {
    msgLines.push(`• Video: ${path.basename(explainer.videoPath)} (${explainer.totalDurationSec.toFixed(1)}s @ ${explainer.fps}fps)`);
  }

  msgLines.push(`• Output Dir: ${result.outDir}`);

  const caption = msgLines.join('\n').slice(0, 1000);

  // If explainer video was generated, deliver the video first
  if (explainer?.videoPath && fs.existsSync(explainer.videoPath)) {
    await sendMsg(`🎬 Explainer Video: ${result.query}`, undefined, {
      filePath: explainer.videoPath,
      fileName: path.basename(explainer.videoPath),
      mimetype: 'video/mp4',
    }).catch((e) => {
      console.error(pc.yellow(`[webhook] Warning: Failed to send explainer video: ${e.message}`));
    });
  }

  // Deliver the main summary notification with FINAL_REPORT.html (matching VideoGen)
  let attachment: { filePath: string; fileName?: string; mimetype?: string } | undefined;
  const htmlReportPath = result.reportHtmlPath || path.join(result.outDir, 'FINAL_REPORT.html');
  if (fs.existsSync(htmlReportPath)) {
    attachment = {
      filePath: htmlReportPath,
      fileName: 'FINAL_REPORT.html',
      mimetype: 'text/html',
    };
  } else if (explainer?.gridPath && fs.existsSync(explainer.gridPath)) {
    attachment = {
      filePath: explainer.gridPath,
      fileName: 'explainer-grid.jpg',
      mimetype: 'image/jpeg',
    };
  } else if (result.gridImagePath && fs.existsSync(result.gridImagePath)) {
    attachment = {
      filePath: result.gridImagePath,
      fileName: 'xhot-grid.png',
      mimetype: 'image/png',
    };
  }

  await sendMsg(caption, undefined, attachment).catch((e) => {
    console.error(pc.yellow(`[webhook] Warning: Failed to send success notification: ${e.message}`));
  });
}

/**
 * Handles error reporting via Telegram/Webhook without abruptly crashing the runner if in 24h mode.
 */
async function reportPipelineError(err: any, topic: string, defaultOutDir?: string, shouldExit = true): Promise<void> {
  const outDirResolved = err?.outDir ? path.resolve(err.outDir) : path.resolve(defaultOutDir || './output');
  const logPath = err?.logPath ? path.resolve(err.logPath) : path.join(outDirResolved, 'pipeline.log');

  if (isLlmUnavailableError(err)) {
    await notifyLlmUnavailableAndExit(err, {
      stage: 'xhot',
      task: 'pipeline-execution',
      context: `Xhot Pipeline [${topic}]`,
      shouldExit,
      logPath,
      outDir: outDirResolved,
    });
  }

  console.error(pc.red(`\n❌ Xhot pipeline failed for topic "${topic}": ${err.message}`));
  if (err.stack) {
    console.error(pc.dim(err.stack));
  }

  const detailedMsg = formatDetailedErrorMessage(err, `❌ Xhot pipeline failed [${topic}]`, {
    logPath,
    outDir: outDirResolved,
  });

  await notifyError(detailedMsg).catch(() => {});
  if (shouldExit) {
    await exitAfterFlush(1, 'xhot');
  }
}

export async function handleXHotCommand(queryArg?: string, opts: any = {}): Promise<void> {
  // Refuse to start while another pipeline holds the shared browser profile.
  // Throws PipelineConflictError (handled by src/cli.ts → exit 2) before any
  // banner output, stage execution, browser launch, or Telegram alert.
  await acquirePipelineLock({
    pipelineId: 'xhot',
    profileDir: opts.profileDir,
    pipelineIds: PIPELINE_IDS,
  });

  // Normalize --24h flag value
  const is24hMode = opts['24h'] !== undefined;
  let maxRunsPer24h = 1;
  if (typeof opts['24h'] === 'number' && !isNaN(opts['24h'])) {
    maxRunsPer24h = Math.max(1, opts['24h']);
  } else if (typeof opts['24h'] === 'string') {
    const parsed = parseInt(opts['24h'], 10);
    maxRunsPer24h = isNaN(parsed) ? 1 : Math.max(1, parsed);
  }

  // Resolve topics from:
  // 1. CLI options: --topics or --query / queryArg
  // 2. Environment variables: XHOT_TOPICS or XHOT_TOPIC
  const rawTopics = opts.topics || opts.query || queryArg || process.env.XHOT_TOPICS || process.env.XHOT_TOPIC;
  const topics = parseTopics(rawTopics);

  if (!topics || topics.length === 0) {
    console.error(pc.red('\n❌ Xhot pipeline configuration error: No search topic specified.'));
    console.error(pc.yellow('Please provide a topic via:'));
    console.error(pc.dim('  • CLI argument:      aigc xhot "your topic"'));
    console.error(pc.dim('  • CLI option:        aigc xhot -q "your topic" or --topics "topic1;topic2"'));
    console.error(pc.dim('  • Environment var:   XHOT_TOPICS="topic1;topic2" or XHOT_TOPIC="your topic" in .env\n'));
    await exitAfterFlush(1, 'xhot');
    return;
  }

  const baseOptions: Omit<XHotPipelineOptions, 'query'> = {
    outDir: opts.outDir ? path.resolve(opts.outDir) : undefined,
    candidateCount: opts.candidateCount ?? 12,
    maxCandidateAgeHours: opts.maxAgeHours ?? 72,
    profileDir: opts.profileDir,
    headed: opts.headed !== undefined ? Boolean(opts.headed) : true,
    headless: opts.headless !== undefined ? Boolean(opts.headless) : false,
    skipVideo: Boolean(opts.skipVideo),
    explainerEngine: opts.explainerEngine || opts.tutorialEngine || 'chromium',
    explainerFps: opts.explainerFps ?? opts.tutorialFps ?? 30,
    explainerSubtitles: Boolean(opts.explainerSubtitles || opts.tutorialSubtitles),
    ttsVoice: opts.ttsVoice,
    ttsRate: opts.ttsRate || '+0%',
    dryRun: Boolean(opts.dryRun),
  };

  if (is24hMode) {
    // -------------------------------------------------------------
    // 24H CONTINUOUS RUNNER MODE (顺序执行，永不停止)
    // -------------------------------------------------------------
    console.log(pc.bold(pc.magenta('\n🔄 XHOT 24H CONTINUOUS PIPELINE RUNNER ACTIVATED\n')));
    console.log(`• Topics (${topics.length}): ${topics.map((t) => pc.cyan(t)).join(', ')}`);
    console.log(`• Rate Limit: max ${pc.bold(pc.yellow(String(maxRunsPer24h)))} run(s) per topic per 24 hours`);
    console.log(`• Mode: Sequential, non-stop loop (永不停止)`);
    console.log(`• State File: artifacts/runner-24h-state.json\n`);

    const abortController = new AbortController();
    const onSignal = () => {
      console.log(pc.yellow('\n[24h Runner] Shutdown signal received. Exiting runner loop gracefully...'));
      abortController.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const stateFilePath = path.resolve(process.cwd(), 'artifacts', 'runner-24h-state.json');

    await runPipeline24h({
      topics,
      maxRunsPer24h,
      signal: abortController.signal,
      stateFilePath,
      onSleep: async (topic, waitMs, reason) => {
        console.log(pc.yellow(`⏳ [24h Runner] ${reason}`));
      },
      onRoundStart: async (topic, round, countIn24h) => {
        console.log(pc.bold(pc.cyan(`\n🔥 [24h Runner] Round #${round} | Topic: "${topic}" (${countIn24h + 1}/${maxRunsPer24h} in 24h)\n`)));
      },
      executeFn: async (topic, round) => {
        const runOptions: XHotPipelineOptions = {
          ...baseOptions,
          query: topic,
        };
        return await executeXHotPipeline(runOptions);
      },
      onRoundSuccess: async (topic, result, round) => {
        printExecutiveSummary(result);
        await sendSuccessNotification(result);
      },
      onRoundError: async (topic, err: any, round) => {
        await reportPipelineError(err, topic, opts.outDir, false);
      },
    });

    console.log(pc.cyan('\n[24h Runner] Exited continuous loop cleanly.'));
    await exitAfterFlush(0, 'xhot');
    return;
  }

  // -------------------------------------------------------------
  // STANDARD SEQUENTIAL EXECUTION (Single-pass for all topics)
  // -------------------------------------------------------------
  for (let i = 0; i < topics.length; i++) {
    const currentTopic = topics[i];
    if (topics.length > 1) {
      console.log(pc.bold(pc.cyan(`\n🔥 XHOT PIPELINE [${i + 1}/${topics.length}]: "${currentTopic}"\n`)));
    } else {
      console.log(pc.bold(pc.cyan(`\n🔥 XHOT TRENDING PIPELINE: "${currentTopic}"\n`)));
    }

    const options: XHotPipelineOptions = {
      ...baseOptions,
      query: currentTopic,
    };

    try {
      const result = await executeXHotPipeline(options);
      printExecutiveSummary(result);
      await sendSuccessNotification(result);
    } catch (err: any) {
      await reportPipelineError(err, currentTopic, opts.outDir, true);
    }
  }

  await exitAfterFlush(0, 'xhot');
}
