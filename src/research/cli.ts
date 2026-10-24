#!/usr/bin/env node
/**
 * Standalone YouTube Research Pipeline CLI.
 *
 * Runs end-to-end multi-stage research:
 * 1. FastEval: browser YouTube search, cover grid capture, VL top-3 selection
 * 2. Candidate Adoption & Metric Pre-Filtering (pass-through)
 * 3. Evaluation Standard Generation & SHA-256 Digest
 * 4. Fallback Pool Selection (transcript fallback candidates)
 * 5. FastEval Shortlist Incorporation (VL-ranked top 3)
 * 6. Winner Transcript Resolution via persistent-profile browser
 * 7. Transcript Scene Segmentation (~120s)
 * 8. Video Media Probing & ffmpeg Scene Frame Grids
 * 9. Artifact Persistence
 *
 * The legacy rubric-scoring evaluation (subtitle evidence + LLM scorer +
 * deterministic selector) was removed: FastEval IS the evaluation.
 */
import { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import {
  runResearchPipeline,
  RESEARCH_RESULT_FILENAME,
  EVALUATION_STANDARD_FILENAME,
  CANDIDATE_EVALUATIONS_FILENAME,
  SELECTION_DECISION_FILENAME,
  CANDIDATE_EVIDENCE_FILENAME,
  FRAME_EVIDENCE_FILENAME,
  TRANSCRIPT_FILENAME,
  SEGMENTS_FILENAME,
  FLOW_VIDEO_SCRIPT_FILENAME,
  RUN_LOG_FILENAME,
  RUN_JSONL_FILENAME,
} from './index.js';
import { AppError } from './errors.js';
import { isLlmUnavailableError, notifyLlmUnavailableAndExit } from '../utils/send_msg.js';
import { attachMetricThresholdOptions, parseMetricThresholdOptions } from './cli/options.js';
import { runFastEval, toFastEvalData } from './fasteval/index.js';

const program = new Command();

program
  .name('youtube-research')
  .description('Production-ready multi-stage YouTube video research pipeline')
  .version('1.0.0')
  .requiredOption('-q, --query <string>', 'Search query or YouTube video URL/ID')
  .option('-t, --topic <string>', 'Override canonical research topic')
  .option('-o, --out-dir <path>', 'Destination directory for artifacts')
  .option('-m, --model <string>', 'LLM model identifier for evaluation')
  .option('-l, --language <string>', 'Preferred caption and transcript language', 'en')
  .option('-n, --max-candidates <number>', 'Maximum candidates to discover', (v) => parseInt(v, 10), 15)
  .option('-p, --pool-size <number>', 'Bounded candidate evaluation pool size', (v) => parseInt(v, 10), 5)
  .option('--cookie-path <path>', 'Path to cookies.txt for yt-dlp authentication')
  .option('--proxy-url <url>', 'Proxy URL (HTTP/HTTPS/SOCKS5) for yt-dlp')
  .option('--no-proxy', 'Disable proxy for yt-dlp requests and connect directly');
attachMetricThresholdOptions(program);
program
  .option('--scene-threshold <number>', 'ffmpeg scene detection sensitivity (0-1)', (v) => parseFloat(v), 0.3)
  .option('--flow-script', 'Generate Veo-optimized Flow video script (default: true)', true)
  .option('--no-flow-script', 'Disable Flow video script generation')
  .option('--clip-duration <number>', 'Default clip duration for script (4, 6, 8, 10)', (v) => parseInt(v, 10), 4)
  .option('--aspect <ratio>', 'Aspect ratio for video script (landscape or portrait)', 'landscape')
  .action(async (opts) => {
    const startTime = Date.now();
    console.log(pc.bold(pc.cyan('\n=== YouTube Research Pipeline ===\n')));
    console.log(`${pc.bold('Query:')} ${opts.query}`);
    if (opts.topic) console.log(`${pc.bold('Topic Override:')} ${opts.topic}`);
    console.log(`${pc.bold('Max Candidates:')} ${opts.maxCandidates}`);
    console.log(`${pc.bold('Evaluation Pool:')} ${opts.poolSize}\n`);

    const stageSpinners: Record<string, string> = {
      'fasteval-search': '1/10 FastEval Browser Search & Cover Capture',
      'fasteval-grid': '1/10 FastEval Contact Grid Assembly',
      'fasteval-eval': '1/10 FastEval VL Top-3 Selection',
      search: '2/10 Candidate Adoption (FastEval)',
      filter: '2/10 Metric Pre-Filtering (pass-through)',
      standard: '3/10 Evaluation Standard Distillation (LLM)',
      'evidence-pool': '4/10 Fallback Pool Selection',
      evaluate: '5/10 FastEval VL Top-3 Incorporation',
      segments: '7/10 Transcript Segmentation (~120s scenes)',
      'media-download': '8a/10 Media Stream Download',
      frames: '8b/10 Probing & Scene Frame Extraction',
      compose: '9/10 Assembling ResearchResult Contract',
      persist: '9b/10 Persisting JSON Artifacts',
      'flow-script': '10/10 Veo-Optimized Flow Video Script Generation',
      complete: 'Pipeline Execution Complete',
    };

    try {
      const metricThresholds = parseMetricThresholdOptions(opts);

      const fastEvalResult = await runFastEval({
        query: opts.query,
        topic: opts.topic,
        candidateCount: opts.maxCandidates,
        outDir: path.resolve(opts.outDir || 'artifacts', 'fasteval'),
        onProgress: (stage, detail) => {
          const label = stageSpinners[stage] || stage;
          console.log(`${pc.green('✔')} [${pc.bold(label)}] ${detail || ''}`);
        },
      });

      const execution = await runResearchPipeline({
        query: opts.query,
        topic: opts.topic,
        language: opts.language,
        maxCandidates: opts.maxCandidates,
        outputDir: opts.outDir,
        cookiePath: opts.cookiePath,
        proxyUrl: opts.proxy === false ? 'none' : opts.proxyUrl,
        model: opts.model,
        evaluationPoolSize: opts.poolSize,
        fastEvalResult: toFastEvalData(fastEvalResult),
        skipMediaDownload: false,
        sceneThreshold: opts.sceneThreshold,
        generateFlowScript: opts.flowScript,
        clipDuration: opts.clipDuration,
        aspectRatio: opts.aspect,
        metricThresholds: Object.keys(metricThresholds).length > 0 ? metricThresholds : undefined,
        onProgress: (stage, detail) => {
          const label = stageSpinners[stage] || stage;
          console.log(`${pc.green('✔')} [${pc.bold(label)}] ${detail || ''}`);
        },
      });

      const { selected, decision } = execution.selection;
      const winner = selected.video;

      console.log(pc.bold(pc.green('\n=== Research Winner Selected ===\n')));
      console.log(`${pc.bold('Title:')}       ${winner.title}`);
      console.log(`${pc.bold('Video ID:')}    ${winner.videoId}`);
      console.log(`${pc.bold('Channel:')}     ${winner.channelTitle}`);
      console.log(`${pc.bold('URL:')}         ${winner.url}`);
      console.log(`${pc.bold('Duration:')}    ${Math.floor(winner.metrics.durationSec / 60)}m ${winner.metrics.durationSec % 60}s`);
      console.log(`${pc.bold('Views:')}       ${winner.metrics.viewCount.toLocaleString()}`);
      console.log(`${pc.bold('Velocity:')}    ${winner.metrics.viewsPerDay.toLocaleString()} views/day`);
      console.log(`${pc.bold('Engagement:')}  ${(winner.metrics.engagementRate * 100).toFixed(2)}%`);
      const compScore = selected.evaluation ? selected.evaluation.compositeScore.toFixed(2) : selected.score.total.toFixed(2);
      const isSelectable = selected.evaluation ? selected.evaluation.selectable : true;
      console.log(`${pc.bold('Comp Score:')}  ${compScore} / 5.00`);
      console.log(`${pc.bold('Selectable:')}  ${isSelectable ? pc.green('Yes') : pc.red('No')}`);
      console.log(`${pc.bold('Reasoning:')}   ${decision.reason}`);

      if (decision.runnersUp.length > 0) {
        console.log(pc.bold('\nRunners Up:'));
        for (const runner of decision.runnersUp) {
          console.log(` - [${runner.videoId}] Score: ${runner.compositeScore.toFixed(2)} (${runner.displayBand})`);
        }
      }

      console.log(pc.bold('\nArtifacts Persisted:'));
      const outDir = opts.outDir || path.resolve('artifacts', execution.result.runId);
      const artifacts = [
        RESEARCH_RESULT_FILENAME,
        EVALUATION_STANDARD_FILENAME,
        CANDIDATE_EVALUATIONS_FILENAME,
        SELECTION_DECISION_FILENAME,
        CANDIDATE_EVIDENCE_FILENAME,
        FRAME_EVIDENCE_FILENAME,
        TRANSCRIPT_FILENAME,
        SEGMENTS_FILENAME,
        ...(execution.flowScript ? [FLOW_VIDEO_SCRIPT_FILENAME] : []),
        RUN_LOG_FILENAME,
        RUN_JSONL_FILENAME,
      ];
      for (const file of artifacts) {
        console.log(` ${pc.dim('•')} ${path.join(outDir, file)}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(pc.cyan(`\nCompleted in ${elapsed}s\n`));
    } catch (err: any) {
      if (isLlmUnavailableError(err)) {
        await notifyLlmUnavailableAndExit(err, {
          stage: err.stage || 'research-cli',
          task: err.task || 'run-pipeline',
          context: 'YouTube Research CLI',
          shouldExit: true,
        });
      }
      console.error(pc.bold(pc.red('\n[Pipeline Failure]')));
      if (err instanceof AppError) {
        console.error(`${pc.red('Code:')}    ${err.code}`);
        console.error(`${pc.red('Stage:')}   ${err.stage || 'unknown'}`);
        console.error(`${pc.red('Message:')} ${err.message}`);
        if (err.cause) {
          console.error(pc.dim(`Cause: ${JSON.stringify(err.cause, null, 2)}`));
        }
      } else {
        console.error(err.stack || err.message || err);
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
