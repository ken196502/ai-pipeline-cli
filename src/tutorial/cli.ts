/**
 * Standalone CLI for AI commentary / tutorial video generation (解说视频).
 *
 * Reads one pipeline run directory (artifacts) and rebuilds the tutorial video
 * from its materials:
 *   - 4-transcript.json           original video subtitles (LLM input)
 *   - 8-segments.json             transcript segmentation
 *   - 9-flow-video-script.json    generation prompts per clip
 *   - generated-clips/            generated videos and images
 *   - 9-research-result.json      VL-extracted prompts (optional)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import pc from 'picocolors';

import { loadEnvFile } from '../env.js';

loadEnvFile();

import type { Segment, Transcript, VlExtractedPrompt } from '../research/contracts.js';
import type { FlowVideoScript } from '../research/script/contracts.js';
import { createTutorialVideo, rebuildTutorialBundle } from './index.js';
import { RunContext } from '../run/index.js';
import { tutorialParamsFromRun, createTutorialFromRun } from './run.js';
import { captureBrowserStepShots, parseBrowserStepScript } from './step-shots.js';
import { captureGeminiShots } from './ui-shots.js';
import { runTutorialVisualQa } from './qa.js';
import { exitAfterFlush } from '../utils/shutdown.js';
import { sendMsg, notifyError, formatDetailedErrorMessage } from '../utils/send_msg.js';
import type { TutorialClipOutputRef } from './assets.js';
import { parseViewport } from '../browser/launcher.js';
import type { TutorialGenerationSummary } from './contracts.js';

export interface TutorialRunInputs {
  transcript: Pick<Transcript, 'language' | 'cues'>;
  segments: Segment[];
  clips: FlowVideoScript['clips'];
  clipOutputs: TutorialClipOutputRef[];
  vlPrompts: VlExtractedPrompt[];
  videoId: string;
  topic: string;
  title: string;
  generatedClipsDir: string;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Loads VL-extracted UI descriptions (sidebar menu + main content) from the
 * research artifacts of a run (prompt-frame-recognition.json / research-result).
 */
export async function loadUiDescriptions(
  artifactsDir: string
): Promise<Array<{ uiContext?: string; summary?: string; sidebar?: string[]; mainContent?: string }>> {
  const dir = path.resolve(artifactsDir);
  const out: Array<{ uiContext?: string; summary?: string; sidebar?: string[]; mainContent?: string }> = [];

  const recognition = await readFirstJson<{ frames?: Array<{ uiContext?: string; uiDescription?: any }> }>(dir, [
    'prompt-frame-recognition.json',
  ]);
  for (const frame of recognition?.value?.frames || []) {
    const ui = frame.uiDescription;
    if (ui && (ui.summary || ui.mainContent || (ui.sidebar || []).length > 0)) {
      out.push({ uiContext: frame.uiContext, ...ui });
    }
  }

  const research = await readFirstJson<{ vlPrompts?: Array<{ uiContext?: string; uiDescription?: any }> }>(dir, [
    '9-research-result.json',
    'research-result.json',
  ]);
  for (const prompt of research?.value?.vlPrompts || []) {
    const ui = prompt.uiDescription;
    if (ui && (ui.summary || ui.mainContent || (ui.sidebar || []).length > 0)) {
      out.push({ uiContext: prompt.uiContext, ...ui });
    }
  }

  return out;
}

async function readFirstJson<T>(dir: string, names: string[]): Promise<{ value: T; file: string } | null> {
  for (const name of names) {
    const value = await readJsonIfExists<T>(path.join(dir, name));
    if (value !== null) return { value, file: name };
  }
  return null;
}

/**
 * Resolves all tutorial inputs from a run artifacts directory.
 * Throws descriptive errors when required inputs are missing.
 */
export async function loadTutorialRunInputs(artifactsDir: string): Promise<TutorialRunInputs> {
  const dir = path.resolve(artifactsDir);
  const run = await RunContext.openIfExists(dir);
  if (run && (await run.snapshot()).artifacts.research && (await run.snapshot()).artifacts.script) {
    const inputs = await tutorialParamsFromRun(run);
    return { transcript: inputs.transcript, segments: inputs.segments || [], clips: inputs.clips || [],
      clipOutputs: inputs.clipOutputs || [], vlPrompts: inputs.vlPrompts || [], videoId: inputs.videoId,
      topic: inputs.topic, title: inputs.title, generatedClipsDir: inputs.generatedClipsDir! };
  }

  const transcriptEntry = await readFirstJson<Pick<Transcript, 'language' | 'cues' | 'videoId'>>(dir, [
    '4-transcript.json',
    'transcript.json',
  ]);
  if (!transcriptEntry) {
    throw new Error(`No transcript found in ${dir} (expected 4-transcript.json) — original video subtitles are required`);
  }

  const segmentsEntry = await readFirstJson<{ segments?: Segment[] } | Segment[]>(dir, [
    '8-segments.json',
    'segments.json',
  ]);
  const segmentsRaw = Array.isArray(segmentsEntry?.value) ? segmentsEntry!.value : (segmentsEntry?.value as any)?.segments || [];

  const scriptEntry = await readFirstJson<FlowVideoScript>(dir, [
    '9-flow-video-script.json',
    'flow-video-script.json',
  ]);
  const clips = scriptEntry?.value?.clips || [];

  const researchEntry = await readFirstJson<{ vlPrompts?: VlExtractedPrompt[]; topic?: string; selected?: { title?: string; videoId?: string } }>(
    dir,
    ['9-research-result.json', 'research-result.json']
  );

  const generatedClipsDir = path.join(dir, 'generated-clips');
  const clipOutputs: TutorialClipOutputRef[] = [];
  let clipDirEntries: string[] = [];
  try {
    clipDirEntries = await fs.readdir(generatedClipsDir);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  for (const name of clipDirEntries.sort()) {
    const match = /^clip-(\d+)\.(mp4|webm|mov|jpg|jpeg|png)$/i.exec(name);
    if (!match) continue;
    const clipIndex = parseInt(match[1], 10);
    const ext = match[2].toLowerCase();
    const abs = path.join(generatedClipsDir, name);
    let entry = clipOutputs.find((c) => c.clipIndex === clipIndex);
    if (!entry) {
      entry = { clipIndex };
      clipOutputs.push(entry);
    }
    if (['mp4', 'webm', 'mov'].includes(ext)) entry.localVideoPath = abs;
    else entry.localImagePath = abs;
  }

  // Media paths recorded in the flow script itself take precedence.
  for (const clip of clips) {
    let entry = clipOutputs.find((c) => c.clipIndex === clip.clipIndex);
    if (!entry) {
      entry = { clipIndex: clip.clipIndex };
      clipOutputs.push(entry);
    }
    if (!entry.localVideoPath && clip.localVideoPath) entry.localVideoPath = clip.localVideoPath;
    if (!entry.localImagePath && clip.localImagePath) entry.localImagePath = clip.localImagePath;
    entry.title = entry.title || clip.title;
  }

  return {
    transcript: { language: transcriptEntry.value.language, cues: transcriptEntry.value.cues },
    segments: segmentsRaw as Segment[],
    clips,
    clipOutputs,
    vlPrompts: researchEntry?.value?.vlPrompts || [],
    videoId: scriptEntry?.value?.videoId || transcriptEntry.value.videoId || 'unknown',
    topic: scriptEntry?.value?.topic || researchEntry?.value?.topic || 'AI video tutorial',
    title: researchEntry?.value?.selected?.title || scriptEntry?.value?.topic || 'AI video tutorial',
    generatedClipsDir,
  };
}

function printSummary(summary: TutorialGenerationSummary): void {
  console.log(pc.bold(pc.green(summary.videoPath ? '\n✅ TUTORIAL VIDEO GENERATED\n' : '\n✅ TUTORIAL PREVIEW GENERATED\n')));
  console.log(`${pc.bold('Video:')}        ${pc.cyan(summary.videoPath)}`);
  console.log(`${pc.bold('Player:')}       ${summary.playerPath}`);
  console.log(`${pc.bold('Storyboard:')}   ${summary.storyboardPath}`);
  console.log(`${pc.bold('Narration:')}    ${summary.narrationPath}`);
  console.log(`${pc.bold('Grid Preview:')}  ${summary.gridPath}`);
  console.log(`${pc.bold('Scenes:')}       ${summary.sceneCount} (${(summary.sceneOutline || []).filter((s) => s.type === 'title' || s.titleCard).length} title cards)`);
  console.log(`${pc.bold('Duration:')}     ${summary.totalDurationSec.toFixed(2)}s @ ${summary.fps}fps (${summary.resolution.width}x${summary.resolution.height})`);
  console.log(`${pc.bold('Voice:')}        ${summary.voice} (${summary.rate})`);
  console.log(`${pc.bold('Materials:')}    ${summary.assetsCount} assets\n`);
}

/**
 * Builds the tutorial video from one run directory and returns the summary.
 */
export async function handleTutorialCommand(opts: any): Promise<TutorialGenerationSummary> {
  if (opts.run) {
    const run = await RunContext.open(opts.run);
    if (opts.outDir && path.resolve(opts.outDir) !== run.outDir) throw new Error('--run saves tutorial outputs in its run directory; omit --out-dir.');
    if (opts.runId && opts.runId !== run.runId) throw new Error('--run preserves the run ID; omit --run-id.');
    const size = opts.size ? parseViewport(opts.size) : undefined;
    if (opts.size && !size) throw new Error(`Invalid --size resolution "${opts.size}"`);
    await run.configure({ narrationLang: opts.lang, ttsVoice: opts.voice, ttsRate: opts.rate,
      tutorialFps: opts.fps, tutorialSize: size, maxTutorialScenes: opts.maxScenes,
      tutorialSubtitles: opts.subtitles, tutorialEngine: opts.engine,
      cookiePath: opts.cookiePath, model: opts.model, browserPath: opts.browserPath });
    try {
      const summary = await createTutorialFromRun(run, {
        previewOnly: opts.previewOnly, skipChannelLookup: opts.skipChannelLookup,
        browserStepsDir: opts.browserSteps, geminiShotsDir: opts.geminiShots,
        crf: opts.crf, preset: opts.preset,
        onProgress: (stage, message) => console.log(`   ${stage}: ${message}`),
      });
      await run.finish();
      return summary;
    } catch (error) { await run.finish(error); throw error; }
  }
  if (!opts.artifacts) throw new Error('Provide --artifacts <dir> or --run <run.json>');
  const inputs = await loadTutorialRunInputs(opts.artifacts);
  const outDir = path.resolve(opts.outDir || opts.artifacts);
  const size = opts.size ? parseViewport(opts.size) : undefined;
  if (!size) {
    throw new Error(`Invalid --size resolution "${opts.size}" — expected WIDTHxHEIGHT`);
  }

  console.log(pc.bold(pc.cyan('\n🎥 ================================ 🎥')));
  console.log(pc.bold(pc.cyan('   AI COMMENTARY / TUTORIAL VIDEO    ')));
  console.log(pc.bold(pc.cyan('🎥 ================================ 🎥\n')));
  console.log(`${pc.bold('Artifacts:')}  ${pc.cyan(path.resolve(opts.artifacts))}`);
  console.log(`${pc.bold('Video ID:')}   ${inputs.videoId}`);
  console.log(`${pc.bold('Topic:')}      ${inputs.topic}`);
  console.log(`${pc.bold('Materials:')}  ${inputs.clipOutputs.length} generated clips, ${inputs.clips.length} prompts\n`);

  const run = await RunContext.openIfExists(outDir) || await RunContext.create({
    pipelineId: 'tutorial', runId: opts.runId, outDir, config: opts,
  });
  try {
    const summary = await run.step('tutorial-gen', () => createTutorialVideo({
      run,
      runId: run.runId,
      videoId: inputs.videoId,
      topic: inputs.topic,
      title: inputs.title,
      transcript: inputs.transcript,
      segments: inputs.segments,
      clips: inputs.clips,
      clipOutputs: inputs.clipOutputs,
      vlPrompts: inputs.vlPrompts,
      generatedClipsDir: inputs.generatedClipsDir,
      browserStepsDir: opts.browserSteps,
      outDir,
      narrationLanguage: opts.lang || inputs.transcript.language || 'en',
      ttsVoice: opts.voice,
      ttsRate: opts.rate,
      fps: opts.fps,
      width: size.width,
      height: size.height,
      maxScenes: opts.maxScenes,
      subtitles: Boolean(opts.subtitles),
      previewOnly: opts.previewOnly,
      skipChannelLookup: opts.skipChannelLookup,
      cookiePath: opts.cookiePath,
      crf: opts.crf,
      preset: opts.preset,
      model: opts.model,
      engine: opts.engine || 'firefox',
      browserPath: opts.browserPath,
      onProgress: (stage, message) => {
        console.log(`   ${pc.dim('•')} ${pc.bold(stage)}: ${message}`);
      },
    }));
    await run.finish();
    return summary;
  } catch (error) { await run.finish(error); throw error; }
}

export function buildTutorialCommand(): Command {
  const program = new Command();
  program
    .name('tutorial-video')
    .description('Generate an AI commentary / tutorial video (解说视频) from one pipeline run directory')
    .option('--run <path>', 'Run directory or run.json; use registered inputs and settings')
    .option('--artifacts <dir>', 'Pipeline run directory containing transcript, prompts and generated-clips')
    .option('--out-dir <dir>', 'Output directory (defaults to the artifacts directory)')
    .option('--run-id <id>', 'Run identifier recorded in the storyboard')
    .option('--lang <code>', 'Narration language code (defaults to the transcript language)')
    .option('--voice <name>', 'edge-tts voice name (defaults to the voice mapped from the narration language)')
    .option('--rate <rate>', 'edge-tts speech rate adjustment (e.g. +10%, -5%)', '+0%')
    .option('--fps <n>', 'Rendered video frame rate', (v) => parseInt(v, 10), 30)
    .option('--size <resolution>', 'Rendered video resolution as WIDTHxHEIGHT', '1920x1080')
    .option('--max-scenes <n>', 'Maximum number of storyboard scenes', (v) => parseInt(v, 10), 10)
    .option('--skip-channel-lookup', 'Skip the yt-dlp channel lookup (followers/avatar opening material)', false)
    .option('--browser-steps <dir>', 'Directory of browser operation step screenshots (step-NNN.png + steps.json) used as tutorial material')
    .option('--gemini-shots <dir>', 'Directory of Gemini chat page screenshots (gemini-NNN.png + gemini-shots.json) used as chatbot UI material')
    .option('--capture-gemini <prompt>', 'Drive the real Gemini page (open / type the prompt / send) and capture page screenshots into <out-dir>/gemini-shots before generating')
    .option('--capture-steps <steps.json>', 'Drive the browser through the operation step script and capture step screenshots into <out-dir>/browser-steps before generating')
    .option('--cookie-path <path>', 'Path to cookies.txt for the yt-dlp channel lookup', './cookies.txt')
    .option('--crf <n>', 'x264 CRF quality', (v) => parseInt(v, 10), 20)
    .option('--preset <name>', 'x264 encoder preset', 'medium')
    .option('--model <string>', 'LLM model identifier for storyboard generation')
    .option('--subtitles', 'Enable narration subtitles / captions in the tutorial video (default: off)', false)
    .option('--no-subtitles', 'Disable subtitles, overriding the saved setting')
    .option('--engine <engine>', 'Render engine for tutorial video (firefox, chromium)', 'chromium')
    .option('--browser-path <path>', 'Custom Ungoogled Chromium executable path (when engine is chromium)')
    .option('--preview-only', 'Generate narration and HTML preview without rendering video', false)
    .option('--rebuild', 'Rebuild the player bundle and re-render from an existing tutorial/tutorial.json (no LLM/TTS)', false)
    .option('--qa', 'Run the automated visual QA on an existing tutorial bundle (screenshots + layout checks)', false)
    .option('--qa-samples <n>', 'QA sample frames per scene', (v) => parseInt(v, 10), 4)
    .action(async (opts, command) => {
      if (opts.run) {
        if (opts.artifacts) throw new Error('Choose --run or --artifacts.');
        const run = await RunContext.open(opts.run);
        opts.artifacts = run.outDir;
        // Commander defaults must not override settings already stored in the run.
        for (const key of ['rate', 'fps', 'size', 'maxScenes', 'cookiePath', 'subtitles', 'engine']) {
          if (command.getOptionValueSource(key) === 'default') delete opts[key];
        }
      }
      if (!opts.artifacts) throw new Error('Provide --artifacts <dir> or --run <run.json>');
      const artifactsDir = path.resolve(opts.artifacts);
      if (opts.qa) {
        const tutorialDir = path.join(artifactsDir, 'tutorial');
        console.log(pc.bold(pc.cyan('\n🔍 TUTORIAL VISUAL QA\n')));
        const result = await runTutorialVisualQa({
          tutorialDir,
          engine: opts.engine || 'firefox',
          browserPath: opts.browserPath,
          samplesPerScene: opts.qaSamples,
        });
        console.log(`${pc.bold('Frames checked:')} ${result.checksRun}`);
        console.log(`${pc.bold('Screenshots:')}   ${path.join(tutorialDir, 'qa')}/`);
        if (result.issues.length === 0) {
          console.log(pc.bold(pc.green('\n✅ Visual QA passed — no cropping, clipping or blank frames\n')));
          return;
        }
        console.log(pc.bold(pc.red(`\n❌ Visual QA found ${result.issues.length} issue(s):`)));
        for (const issue of result.issues) {
          console.log(`   ${pc.red('•')} [${issue.kind}] ${issue.detail} ${pc.dim(`(t=${issue.tSec.toFixed(2)}s)`)}`);
        }
        console.log('');
        process.exitCode = 1;
        return;
      }
      if (opts.rebuild && opts.previewOnly) {
        throw new Error('--preview-only cannot be combined with --rebuild');
      }
      if (opts.rebuild) {
        const tutorialDir = path.join(artifactsDir, 'tutorial');
        const result = await rebuildTutorialBundle({
          tutorialDir,
          engine: opts.engine || 'firefox',
          crf: opts.crf,
          preset: opts.preset,
          browserPath: opts.browserPath,
          onProgress: (stage, message) => {
            console.log(`   ${pc.dim('•')} ${pc.bold(stage)}: ${message}`);
          },
        });
        console.log(pc.bold(pc.green('\n✅ TUTORIAL VIDEO REBUILT\n')));
        console.log(`${pc.bold('Video:')}   ${pc.cyan(result.videoPath)}`);
        console.log(`${pc.bold('Scenes:')}  ${result.timeline.scenes?.length ?? result.timeline.clips?.length ?? 0}`);
        console.log(`${pc.bold('Frames:')}  ${result.framesRendered}`);
        console.log(`${pc.bold('Host script:')}  ${result.hostScriptPath}\n`);
        return;
      }
      if (opts.captureGemini) {
        const captureOutDir = path.join(path.resolve(opts.outDir || opts.artifacts), 'gemini-shots');
        console.log(pc.bold(pc.cyan('\n📸 CAPTURING REAL GEMINI CHAT PAGE SCREENSHOTS\n')));
        console.log(`${pc.bold('Prompt:')}   ${pc.cyan(String(opts.captureGemini).slice(0, 120))}${String(opts.captureGemini).length > 120 ? '…' : ''}`);
        console.log(`${pc.bold('Output:')}   ${pc.cyan(captureOutDir)}\n`);
        const captured = await captureGeminiShots({
          prompt: String(opts.captureGemini),
          outDir: captureOutDir,
          browserPath: opts.browserPath,
          onProgress: (stage, message) => {
            console.log(`   ${pc.dim('•')} ${pc.bold(stage)}: ${message}`);
          },
        });
        console.log(
          pc.bold(pc.green(`\n✅ ${captured.shots.length} GEMINI PAGE SCREENSHOT(S) CAPTURED → ${captured.outDir}\n`))
        );
      }
      if (opts.captureSteps) {
        const captureOutDir = path.join(path.resolve(opts.outDir || opts.artifacts), 'browser-steps');
        const stepsFile = path.resolve(opts.captureSteps);
        const steps = parseBrowserStepScript(JSON.parse(await fs.readFile(stepsFile, 'utf-8')));
        console.log(pc.bold(pc.cyan('\n📸 CAPTURING BROWSER OPERATION STEPS\n')));
        console.log(`${pc.bold('Script:')}  ${pc.cyan(stepsFile)}`);
        console.log(`${pc.bold('Output:')}  ${pc.cyan(captureOutDir)}\n`);
        const captured = await captureBrowserStepShots({
          steps,
          outDir: captureOutDir,
          browserPath: opts.browserPath,
          onProgress: (stage, message) => {
            console.log(`   ${pc.dim('•')} ${pc.bold(stage)}: ${message}`);
          },
        });
        console.log(
          pc.bold(pc.green(`\n✅ ${captured.steps.length} BROWSER STEP SCREENSHOT(S) CAPTURED → ${captured.outDir}\n`))
        );
      }
      const summary = await handleTutorialCommand(opts);
      printSummary(summary);

      // Send completion alert with tutorial grid preview if available
      try {
        const caption = [
          '🎬 <b>【Tutorial Video Generated】</b>',
          '',
          `• Scenes: ${summary.sceneCount} (${summary.totalDurationSec.toFixed(1)}s)`,
          `• Frames: ${summary.framesRendered} @ ${summary.fps}fps`,
          `• Path: ${summary.videoPath}`,
        ].join('\n');
        await sendMsg(caption, undefined, summary.gridPath ? {
          filePath: summary.gridPath,
          fileName: 'tutorial-grid.jpg',
          mimetype: 'image/jpeg',
        } : undefined);
      } catch (e: any) {
        console.warn(pc.yellow(`[webhook] Notice: Failed to send tutorial completion alert: ${e.message}`));
      }
    });
  return program;
}

// Auto-run if executed directly via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildTutorialCommand()
    .parseAsync(process.argv)
    .then(async () => {
      // Work is done — terminate deterministically (plan-fix-pipeline-hang-on-exit.md).
      await exitAfterFlush(process.exitCode ?? 0, 'tutorial-video');
    })
    .catch(async (err: any) => {
      console.error(pc.bold(pc.red(`\n❌ Tutorial video generation failed: ${err.message}`)));
      if (err.stack) console.error(pc.dim(err.stack));
      try {
        const alertMsg = formatDetailedErrorMessage(err, '❌ Tutorial video generation failed');
        await notifyError(alertMsg);
      } catch {}
      await exitAfterFlush(1, 'tutorial-video');
    });
}
