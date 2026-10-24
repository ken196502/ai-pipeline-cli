import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import pc from 'picocolors';
import { parseViewport } from '../../browser/launcher.js';
import { sendMsg, formatDetailedErrorMessage, isLlmUnavailableError, notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';
import { pipelineRegistry } from '../core/registry.js';
import { ytbhotPipeline } from './execute.js';

export async function runYtbHotPipeline(rawOptions: ViralPipelineInput) {
  if (!pipelineRegistry.get('ytbhot')) {
    pipelineRegistry.register(ytbhotPipeline);
  }
  return pipelineRegistry.run<ViralPipelineInput, any>('ytbhot', rawOptions);
}
export const runViralVideoPipeline = runYtbHotPipeline;
import { printExecutiveSummary } from './report.js';
import { exitAfterFlush } from '../../utils/shutdown.js';
import type { PipelineStage, ViralPipelineInput } from './contracts.js';
import { DEFAULT_VIRAL_QUERY } from './execute.js';
import { isTokenConsumingStage } from './failure-policy.js';
export { DEFAULT_VIRAL_QUERY };

/**
 * Systemic failures that reproduce identically on every retry — the continuous
 * runner maps exit code 3 to a full stop instead of its self-healing retry loop.
 * See plan-fix-degenerate-video-and-prompt-fallback.md.
 */
const SYSTEMIC_FATAL_CODES = new Set([
  'MEDIA_DEGENERATE', // frozen/dead-frame reference video (truncated/stuck capture)
  'MEDIA_DOWNLOAD_FAILED', // media egress systematically blocked (SABR/IP-binding)
  'NO_VIDEO_PROMPT_FOUND', // strict prompt extraction found nothing usable
  'FLOW_TARGETING_MISMATCH', // Flow card identity cannot be aimed at (deterministic canvas/targeting drift)
  'TOKEN_STAGE_FAILED', // an LLM/VL/Flow-credit stage failed — stop instead of re-burning tokens
]);

/**
 * Attaches common options for the viral video pipeline to a commander instance.
 */
export function attachViralOptions(cmd: Command): Command {
  cmd
    .argument('[query]', 'Search query or viral topic', DEFAULT_VIRAL_QUERY)
    .option('-q, --query <string>', 'Search query or viral topic')
    .option('-t, --topic <string>', 'Override canonical evaluation topic')
    .option('--standard <path>', 'Path to custom evaluation standard JSON file')
    .option('--save-standard <path>', 'Custom destination path to save evaluation standard')
    .option('--standards-dir <path>', 'Custom directory containing reusable evaluation standards (defaults to storage/viral-video-maker/standards)')
    .option('--force-new-standard', 'Ignore existing standard and distill new 3-round LLM standard', false)
    .option('--remove-standard', 'Remove existing evaluation standard file on disk and distill a fresh one', false)
    .option('--remove-existing-standard', 'Remove existing evaluation standard file on disk and distill a fresh one', false)
    .option('--remove-all-standards', 'Remove all cached evaluation standard files in the standards directory', false)
    .option('--clean-standard', 'Alias for --remove-standard', false)
    .option('--clean-all-standards', 'Alias for --remove-all-standards', false)
    .option('--no-reuse-standard', 'Do not reuse cached evaluation standards')
    .option('-n, --max-candidates <number>', 'Maximum candidates to discover', (v) => parseInt(v, 10), 15)
    .option('-p, --pool-size <number>', 'Candidate evaluation pool size', (v) => parseInt(v, 10), 5)
    .option('-l, --language <string>', 'Preferred caption / transcript language', 'en')
    .option('--cookie-path <path>', 'Path to cookies.txt for yt-dlp authentication', './cookies.txt')
    .option('--profile-dir <path>', 'Persistent Chromium user data directory', './.chromium-profile')
    .option('--browser-path <path>', 'Custom Ungoogled Chromium executable path')
    .option('--proxy-url <url>', 'Proxy URL (HTTP/SOCKS5) for yt-dlp requests')
    .option('--no-proxy', 'Disable proxy for yt-dlp requests and connect directly')
    .option('--model <string>', 'LLM model identifier for research evaluation')
    .option('--flow-model <model>', 'Google Flow model (fast, lite, standard)', 'lite')
    .option('--clip-duration <number>', 'Duration per clip in seconds (4, 6, 8, 10)', (v) => parseInt(v, 10), 4)
    .option('--aspect <ratio>', 'Aspect ratio for video generation (landscape or portrait)', 'landscape')
    .option('--project-id <id>', 'Existing Google Flow project UUID to reuse')
    .option('--max-clips <number>', 'Limit maximum number of clips to generate', (v) => parseInt(v, 10))
    .option('--use-ext', 'Use Real Chrome + Extension + Native Messaging + xdotool mode for Flow generation', false)
    .option('--skip-tutorial', 'Skip the AI commentary tutorial video stage (tutorial-gen)', false)
    .option('--tutorial-engine <engine>', 'Tutorial video render engine (firefox, chromium)', 'chromium')
    .option('--tts-voice <name>', 'edge-tts voice name for tutorial narration (defaults per narration language)')
    .option('--tts-rate <rate>', 'edge-tts speech rate adjustment for tutorial narration (e.g. +10%)', '+0%')
    .option('--tutorial-fps <n>', 'Frame rate of the rendered tutorial video', (v) => parseInt(v, 10), 30)
    .option('--tutorial-size <resolution>', 'Tutorial video resolution as WIDTHxHEIGHT', '1920x1080')
    .option('--max-tutorial-scenes <n>', 'Maximum number of tutorial storyboard scenes', (v) => parseInt(v, 10), 10)
    .option('--tutorial-subtitles', 'Enable narration subtitles / captions in the tutorial video (default: off)', false)
    .option('--narration-lang <code>', 'Tutorial narration language code (defaults to --language)')
    .option('--dry-run', 'Perform pipeline dry run without spending Google Flow generation credits', false)
    .option('--skip-flow-gen', 'Skip Google Flow video generation stage', false)
    .option('--stop-before-gen', 'Stop pipeline before Flow video generation — review results first, then resume (or set STOP_BEFORE_GEN=1)', false)
    .option('--skip-flow-login', 'Skip Google Flow login verification stage', false)
    .option('--headed', 'Launch browser in headed mode for visual observation', false)
    .option('--viewport <resolution>', 'Browser viewport resolution as WIDTHxHEIGHT or "null" (default: auto-detect screen)')
    .option('--browser-resolution <resolution>', 'Alias for --viewport')
    .option('--fasteval-candidates <number>', 'Max candidates to evaluate in fasteval mode — every scrolled search result up to this cap gets its cover captured and stitched into the NxN grid', (v) => parseInt(v, 10), 25)
    .option('--min-duration <seconds>', 'Minimum video duration in seconds before its cover is captured (default 300 = 5 min)', (v) => parseInt(v, 10), 300)
    .option('--max-age-days <days>', 'Maximum published age in days before its cover is captured (default 183 = half a year)', (v) => parseInt(v, 10), 183)
    .option('-o, --out-dir <path>', 'Destination directory for all run artifacts and reports')
    .option('--storage-dir <dir>', 'Root persistent storage directory for pipelines (defaults to ./storage)');
  cmd
    .option('--require-video-prompt', 'Abort pipeline if candidate video has no extracted AI video generation prompts', false)
    .option('--no-require-video-prompt', 'Allow pipeline to continue using synthesized prompts even if no video prompts exist')
    .option('--locate-prompts', 'Enable multi-stage vision-language prompt detection (default: true)', true)
    .option('--no-locate-prompts', 'Disable vision-language prompt detection')
    .option('-f, --evaluation-focus <prompt>', 'Custom guidance prompt for distilling evaluation standards')
    .option('--focus <prompt>', 'Alias for --evaluation-focus');
  return cmd;
}

/**
 * Executes the viral video pipeline CLI handler with formatted progress output and summary.
 */
export async function handleViralCommand(queryArg: string | undefined, opts: any): Promise<void> {
  const query = opts.query || queryArg || DEFAULT_VIRAL_QUERY;
  const removeAllStandards = Boolean(opts.removeAllStandards || opts.cleanAllStandards);
  const removeExistingStandard = Boolean(
    removeAllStandards || opts.removeExistingStandard || opts.removeStandard || opts.cleanStandard || opts.deleteStandard
  );
  const stopBeforeGen = Boolean(opts.stopBeforeGen || process.env.STOP_BEFORE_GEN === '1' || process.env.STOP_BEFORE_GEN === 'true');
  const viewportArg = opts.viewport ?? opts.browserResolution;
  const parsedViewport = viewportArg !== undefined ? parseViewport(viewportArg) : undefined;
  const tutorialSize = opts.tutorialSize ? parseViewport(opts.tutorialSize) : undefined;
  if (opts.tutorialSize && !tutorialSize) {
    throw new Error(`Invalid --tutorial-size resolution "${opts.tutorialSize}" — expected WIDTHxHEIGHT`);
  }

  console.log(pc.bold(pc.cyan('\n🎬 ====================================================== 🎬')));
  console.log(pc.bold(pc.cyan('      AI VIRAL VIDEO GENERATION AUTONOMOUS PIPELINE      ')));
  console.log(pc.bold(pc.cyan('🎬 ====================================================== 🎬\n')));

  console.log(`${pc.bold('Target Query:')}      ${pc.green(query)}`);
  if (opts.topic) console.log(`${pc.bold('Topic Override:')}    ${pc.green(opts.topic)}`);
  console.log(`${pc.bold('Evaluation:')}        ${pc.green('FastEval (browser YouTube NxN cover VL, top-3)')}`);
  console.log(`${pc.bold('Flow Model:')}        ${pc.cyan(opts.flowModel)} (lowest-quota profile)`);
  console.log(`${pc.bold('Clip Duration:')}     ${opts.clipDuration}s per clip (${opts.aspect})`);
  console.log(`${pc.bold('Mode:')}              ${stopBeforeGen ? pc.yellow('STOP BEFORE GEN (review & resume)') : opts.dryRun ? pc.yellow('DRY RUN (zero credits spent)') : pc.green('LIVE GENERATION')}`);
  const standardStatus = removeAllStandards
    ? pc.red('Purging ALL cached standards in directory')
    : removeExistingStandard
    ? pc.red('Removed existing & distilling fresh')
    : opts.reuseStandard && !opts.forceNewStandard
    ? pc.green('Enabled')
    : pc.yellow('Force New Standard');
  console.log(`${pc.bold('Standard Reuse:')}    ${standardStatus}`);
  console.log(`${pc.bold('Chromium Profile:')}  ${opts.profileDir}\n`);

  const stageNames: Record<PipelineStage, string> = {
    'check-env': '1/12 [check-env] Environment diagnostics',
    'check-ytb': '2/12 [check-ytb] YouTube cookie verification',
    'browser-refresh': '3/12 [browser-refresh] Ungoogled Chromium cookie refresh',
    'search-ytb': '4/12 [search-ytb] YouTube candidate discovery',
    'standard-load': '5a/12 [standard-load] Reusable standard resolution',
    'standard-gen': '5b/12 [standard-gen] 3-round LLM standard distillation',
    'standard-save': '6/12 [standard-save] Persisting standard for reuse',
    evaluate: '7/12 [evaluate] Multi-candidate rubric evaluation',
    'extract-prompts': '8/12 [extract-prompts] Transcript scene segmentation',
    'gen-prompts': '9/12 [gen-prompts] Veo-optimized video script generation',
    'flow-login': '10/12 [flow-login] Google Flow SSO authentication',
    'flow-project': '11/12 [flow-project] Google Flow project allocation',
    'flow-generate': '12/12 [flow-generate] Batch Veo video synthesis',
    'tutorial-gen': '13/14 [tutorial-gen] AI commentary tutorial video',
    report: '14/14 [report] Compiling execution reports',
    complete: 'Pipeline Finished',
  };

  let lastStage: string | null = null;

  const pipelineOptions: ViralPipelineInput = {
    query,
    topic: opts.topic,
    standardPath: opts.standard,
    saveStandardPath: opts.saveStandard,
    standardsDir: opts.standardsDir,
    reuseStandard: removeExistingStandard ? false : opts.reuseStandard,
    forceNewStandard: removeExistingStandard ? true : opts.forceNewStandard,
    removeExistingStandard,
    removeStandard: removeExistingStandard,
    removeAllStandards,
    evaluationFocus: opts.evaluationFocus || opts.focus,
    evaluationRequirements: opts.evaluationRequirements,
    maxCandidates: opts.maxCandidates,
    poolSize: opts.poolSize,
    language: opts.language,
    cookiePath: opts.cookiePath,
    profileDir: opts.profileDir,
    browserPath: opts.browserPath,
    proxyUrl: opts.proxy === false ? 'none' : opts.proxyUrl,
    model: opts.model,
    flowModel: opts.flowModel,
    clipDuration: opts.clipDuration,
    aspectRatio: opts.aspect,
    flowProjectId: opts.projectId,
    maxClips: opts.maxClips,
    dryRun: opts.dryRun,
    skipFlowGen: opts.skipFlowGen || stopBeforeGen,
    stopBeforeGen,
    skipFlowLogin: opts.skipFlowLogin,
    skipMediaDownload: false,
    skipTutorial: opts.skipTutorial,
    ttsVoice: opts.ttsVoice,
    ttsRate: opts.ttsRate,
    tutorialEngine: opts.tutorialEngine || 'firefox',
    tutorialFps: opts.tutorialFps,
    tutorialSize: tutorialSize || undefined,
    maxTutorialScenes: opts.maxTutorialScenes,
    tutorialSubtitles: Boolean(opts.tutorialSubtitles),
    narrationLang: opts.narrationLang,
    headed: opts.headed,
    viewport: parsedViewport,
    fastevalCandidates: opts.fastevalCandidates,
    minDurationSec: opts.minDuration,
    maxAgeDays: opts.maxAgeDays,
    outDir: opts.outDir,
    storageDir: opts.storageDir,
    onProgress: (stage, message) => {
      const stageLabel = stageNames[stage] || stage;
      if (stage !== lastStage) {
        console.log(pc.bold(pc.cyan(`\n>> ${stageLabel}`)));
        lastStage = stage;
      }
      if (message) {
        console.log(`   ${pc.dim('•')} ${message}`);
      }
    },
  };

  try {
    const result = await runYtbHotPipeline(pipelineOptions);
    printExecutiveSummary(result);

    if (stopBeforeGen) {
      const scriptPath = path.join(result.outDir, '9-flow-video-script.json');
      const reportPath = result.reportMarkdownPath || path.join(result.outDir, 'FINAL_REPORT.md');
      console.log(pc.bold(pc.yellow('\n⏸  PIPELINE STOPPED BEFORE VIDEO GENERATION (--stop-before-gen)\n')));
      console.log(pc.bold('Review these artifacts:'));
      console.log(`   ${pc.cyan('Flow Script:')}     ${scriptPath}`);
      console.log(`   ${pc.cyan('Full Report:')}     ${reportPath}`);
      console.log(`   ${pc.cyan('Output Dir:')}      ${result.outDir}`);
      console.log(`\n${pc.bold('To generate video after review, re-run without --stop-before-gen:')}`);
      console.log(`   ${pc.dim('npx tsx src/pipeline/pipelines/viral-video-maker.ts')} "${query}" ${pc.dim('--out-dir ' + result.outDir)}`);
      console.log('');
      return;
    }

    // Notify on partial failures (e.g. failed clips or failed stages)
    const failedStages = Object.values(result.stages || {}).filter((s: any) => s && s.status === 'failed') as any[];
    const failedClips = result.flowGeneration?.failedClips ?? 0;
    if (failedClips > 0 || failedStages.length > 0) {
      const issues: string[] = [];
      if (failedClips > 0) {
        issues.push(`${failedClips} clip(s) failed generation`);
      }
      for (const s of failedStages) {
        if (s.stage !== 'flow-generate' || failedClips === 0) {
          issues.push(`stage [${s.stage}] failed: ${s.error || s.summary || 'unknown error'}`);
        }
      }      const logPath = path.join(result.outDir, 'pipeline.log');
      const reportPath = path.join(result.outDir, 'FINAL_REPORT.md');
      const flowProjectId = result.flowProject?.projectId;
      const flowProjectUrl =
        result.flowProject?.url || (flowProjectId ? `https://flow.google.com/project/${flowProjectId}` : undefined);
      const msgLines = [
        `⚠️ Viral pipeline completed with partial failure: ${issues.join('; ')}`,
        ...(flowProjectId ? [`• Flow Project ID: ${flowProjectId}`] : []),
        ...(flowProjectUrl ? [`• Flow Project URL: ${flowProjectUrl}`] : []),
        `\n• Log: ${logPath}`,
        `• Report: ${reportPath}`,
        `• Output Dir: ${result.outDir}`,
      ];
      await sendMsg(msgLines.join('\n')).catch((e) => {
        console.error(pc.yellow(`[webhook] Warning: Failed to send notification: ${e.message}`));
      });
      // A token/credit-spending stage failing (e.g. the caught tutorial-gen) must stop
      // the runner, not trigger a round retry that re-burns the same LLM/Flow tokens.
      const failedTokenStage = failedStages.find((s) => isTokenConsumingStage(s.stage));
      if (failedTokenStage) {
        console.warn(
          pc.yellow(
            `⛔ Token-spending stage [${failedTokenStage.stage}] failed — exit code 3 so the runner stops instead of re-burning tokens.`
          )
        );
        process.exitCode = 3;
      } else {
        process.exitCode = 1;
      }
    } else {
      // Notify on success: summary message + self-contained HTML report attachment
      const winner = result.evaluation.winner;
      const minutes = (result.totalDurationMs / 60000).toFixed(1);
      const msgLines = [
        `✅ Viral pipeline completed successfully in ${minutes} min`,
        `• Query: ${result.query}`,
        `• Winner: ${winner.title} (${winner.videoId})`,
        `• Score: ${result.evaluation.compositeScore.toFixed(2)}/5.00`,
        `• Clips: ${result.flowGeneration?.completedClips ?? 0}/${result.flowGeneration?.totalClips ?? 0} completed`,
        ...(result.tutorial
          ? [
              `• Tutorial: ${result.tutorial.totalDurationSec.toFixed(0)}s @ ${result.tutorial.fps}fps (${result.tutorial.resolution.width}x${result.tutorial.resolution.height})`,
            ]
          : []),
        `• Output: ${result.outDir}`,
      ];
      // Telegram captions are limited to 1024 chars — truncate deterministically.
      const caption = msgLines.join('\n').slice(0, 1000);
      await sendMsg(caption, undefined, {
        filePath: result.reportHtmlPath,
        fileName: 'FINAL_REPORT.html',
        mimetype: 'text/html',
      }).catch((e) => {
        console.error(pc.yellow(`[webhook] Warning: Failed to send success notification: ${e.message}`));
      });
    }
  } catch (err: any) {
    // The registry enriches fatal errors with the real run directory — prefer it
    // over the pre-run --out-dir guess so the alert points at an existing log.
    const outDirResolved = err?.outDir ? path.resolve(err.outDir) : path.resolve(opts.outDir || './artifacts');
    const logPath = err?.logPath ? path.resolve(err.logPath) : path.join(outDirResolved, 'pipeline.log');
    if (isLlmUnavailableError(err)) {
      await notifyLlmUnavailableAndExit(err, {
        stage: 'viral-video-maker',
        task: 'pipeline-execution',
        context: 'Viral Video Maker Pipeline',
        shouldExit: true,
        logPath,
        outDir: outDirResolved,
      });
    }
    console.error(pc.bold(pc.red(`\n❌ Pipeline execution failed: ${err.message}`)));
    if (err.stack) {
      console.error(pc.dim(err.stack));
    }
    const flowProjectId = err.flowProjectId || opts.projectId;
    const flowProjectUrl =
      err.flowProjectUrl || (flowProjectId ? `https://flow.google.com/project/${flowProjectId}` : undefined);
    const detailedMsg = formatDetailedErrorMessage(err, '❌ Viral pipeline failed', {
      logPath,
      outDir: outDirResolved,
      flowProjectId,
      flowProjectUrl,
    });
    await sendMsg(detailedMsg).catch((e) => {
      console.error(pc.yellow(`[webhook] Warning: Failed to send notification: ${e.message}`));
    });
    // Systemic media/prompt failures exit with a dedicated code (3) so the
    // continuous runner stops instead of pointlessly retrying: a degenerate
    // (dead-frame) download, a fully blocked media egress, or a strict
    // prompt-extraction miss will reproduce identically on every retry.
    process.exit(SYSTEMIC_FATAL_CODES.has(err?.code) ? 3 : 1);
  }
}

// Auto-run if executed directly via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const program = new Command();
  program
    .name('ytbhot')
    .alias('viral-video-maker')
    .description('Autonomous "AI make Niche Viral Video" YouTube End-to-End Pipeline')
    .version('1.0.0');

  attachViralOptions(program);
  program.action(async (queryArg, opts) => {
    await handleViralCommand(queryArg, opts);
    await exitAfterFlush(process.exitCode ?? 0, 'ytbhot');
  });

  program.parseAsync(process.argv).catch(async (err) => {
    console.error(err);
    await exitAfterFlush(1, 'ytbhot');
  });
}
