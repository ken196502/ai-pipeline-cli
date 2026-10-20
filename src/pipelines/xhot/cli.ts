import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import pc from 'picocolors';
import { executeXHotPipeline } from './execute.js';
import { exitAfterFlush } from '../../utils/shutdown.js';
import {
  sendMsg,
  notifyError,
  formatDetailedErrorMessage,
  isLlmUnavailableError,
  notifyLlmUnavailableAndExit,
} from '../../utils/send_msg.js';
import type { XHotPipelineOptions } from './contracts.js';

export const DEFAULT_XHOT_QUERY = 'new model';

export function attachXHotOptions(cmd: Command): Command {
  return cmd
    .argument('[query]', 'Topic to search on X (e.g. "new model")', DEFAULT_XHOT_QUERY)
    .option('-q, --query <string>', 'Topic to search on X')
    .option('-o, --out-dir <path>', 'Custom directory to store run artifacts')
    .option('--candidate-count <number>', 'Number of X candidates to evaluate in grid (default: 12)', (v) => parseInt(v, 10), 12)
    .option('--max-age-hours <number>', 'Max tweet age in hours for candidates (default: 72)', (v) => parseInt(v, 10), 72)
    .option('--profile-dir <path>', 'Custom Chromium profile directory (defaults to ./.chromium-profile)')
    .option('--headed', 'Run browser in headful mode for visible interaction', false)
    .option('--headless', 'Force browser headless mode', true)
    .option('--skip-video', 'Skip OpusVideo presentation generation', false)
    .option('--tutorial-engine <engine>', 'Tutorial video render engine (chromium, firefox)', 'chromium')
    .option('--tutorial-fps <n>', 'Frame rate of presentation video', (v) => parseInt(v, 10), 30)
    .option('--tutorial-subtitles', 'Enable narration subtitles / captions', false)
    .option('--tts-voice <name>', 'edge-tts voice name for narration')
    .option('--tts-rate <rate>', 'edge-tts speech rate adjustment (e.g. +10%)', '+0%')
    .option('--dry-run', 'Run pipeline in dry-run mode without live network/generation calls', false);
}

export async function handleXHotCommand(queryArg?: string, opts: any = {}): Promise<void> {
  const query = opts.query || queryArg || DEFAULT_XHOT_QUERY;
  console.log(pc.bold(pc.cyan(`\n🔥 XHOT TRENDING PIPELINE: "${query}"\n`)));

  const options: XHotPipelineOptions = {
    query,
    outDir: opts.outDir ? path.resolve(opts.outDir) : undefined,
    candidateCount: opts.candidateCount ?? 12,
    maxCandidateAgeHours: opts.maxAgeHours ?? 72,
    profileDir: opts.profileDir,
    headed: Boolean(opts.headed),
    headless: opts.headless !== undefined ? Boolean(opts.headless) : !opts.headed,
    skipVideo: Boolean(opts.skipVideo),
    tutorialEngine: opts.tutorialEngine || 'chromium',
    tutorialFps: opts.tutorialFps ?? 30,
    tutorialSubtitles: Boolean(opts.tutorialSubtitles),
    ttsVoice: opts.ttsVoice,
    ttsRate: opts.ttsRate || '+0%',
    dryRun: Boolean(opts.dryRun),
  };

  try {
    const result = await executeXHotPipeline(options);
    console.log(pc.green(`\n✓ Xhot pipeline completed successfully!`));
    if (result.winner) {
      console.log(`🏆 Winner: ${pc.bold(result.winner.name)}`);
      console.log(`📝 Summary: ${result.winner.summary}`);
    }
    if (result.tutorial?.videoPath) {
      console.log(`🎬 Video: ${result.tutorial.videoPath}`);
    }
    console.log(`📁 Artifacts: ${result.outDir}\n`);

    // --- Telegram / Webhook Notification on Success ---
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

    if (result.tutorial?.videoPath) {
      msgLines.push(`• Video: ${path.basename(result.tutorial.videoPath)} (${result.tutorial.totalDurationSec.toFixed(1)}s @ ${result.tutorial.fps}fps)`);
    }

    msgLines.push(`• Output Dir: ${result.outDir}`);

    const caption = msgLines.join('\n').slice(0, 1000);

    // Best attachment: video > grid preview > candidate grid > markdown report
    let attachment: { filePath: string; fileName?: string; mimetype?: string } | undefined;
    if (result.tutorial?.videoPath && fs.existsSync(result.tutorial.videoPath)) {
      attachment = {
        filePath: result.tutorial.videoPath,
        fileName: path.basename(result.tutorial.videoPath),
        mimetype: 'video/mp4',
      };
    } else if (result.tutorial?.gridPath && fs.existsSync(result.tutorial.gridPath)) {
      attachment = {
        filePath: result.tutorial.gridPath,
        fileName: 'tutorial-grid.jpg',
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

    await exitAfterFlush(0, 'xhot');
  } catch (err: any) {
    const outDirResolved = err?.outDir ? path.resolve(err.outDir) : path.resolve(opts.outDir || './output');
    const logPath = err?.logPath ? path.resolve(err.logPath) : path.join(outDirResolved, 'pipeline.log');

    if (isLlmUnavailableError(err)) {
      await notifyLlmUnavailableAndExit(err, {
        stage: 'xhot',
        task: 'pipeline-execution',
        context: 'Xhot Pipeline',
        shouldExit: true,
        logPath,
        outDir: outDirResolved,
      });
    }

    console.error(pc.red(`\n❌ Xhot pipeline failed: ${err.message}`));
    if (err.stack) {
      console.error(pc.dim(err.stack));
    }

    const detailedMsg = formatDetailedErrorMessage(err, '❌ Xhot pipeline failed', {
      logPath,
      outDir: outDirResolved,
    });

    await notifyError(detailedMsg).catch(() => {});
    await exitAfterFlush(1, 'xhot');
  }
}
