#!/usr/bin/env node
/**
 * Standalone YouTube Research Flow Video Script Generator CLI.
 *
 * Converts a research pipeline result (research-result.json) or extracted scenes
 * into a multi-clip, Veo-optimized FlowVideoScript suitable for batch generation
 * via flow-cli.
 */
import fs from 'node:fs/promises';
import { RunContext } from '../../run/index.js';
import { generateScriptFromRun } from '../script/run.js';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { ResearchResultSchema, type ResearchResult } from '../contracts.js';
import { generateFlowVideoScript } from '../script/generator.js';
import { FlowVideoScriptSchema, type FlowVideoScript } from '../script/contracts.js';
import { isLlmUnavailableError, notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';

export interface ScriptCliOptions {
  input?: string;
  run?: string;
  output?: string;
  duration?: 4 | 6 | 8 | 10;
  aspect?: 'landscape' | 'portrait';
  model?: string;
  llm?: boolean;
  clips?: number;
}

export interface ScriptCliResult {
  script: FlowVideoScript;
  outputPath: string;
}

/**
 * Programmatic execution runner for script generation CLI.
 */
export async function runGenerateScriptCli(options: ScriptCliOptions): Promise<ScriptCliResult> {
  if (options.run) {
    if (options.input || options.output) throw new Error('--run reads and writes registered artifacts; omit --input and --output.');
    const run = await RunContext.open(options.run);
    await run.configure({ clipDuration: options.duration, aspectRatio: options.aspect,
      flowModel: options.model, useLlmForScript: options.llm, scriptClipCount: options.clips });
    try {
      const result = await generateScriptFromRun(run);
      await run.finish();
      return result;
    } catch (error) { await run.finish(error); throw error; }
  }
  if (!options.input) throw new Error("required option: --input <path> or --run <run.json>");
  const inputPath = path.resolve(options.input);
  const rawData = await fs.readFile(inputPath, 'utf-8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawData);
  } catch (err: any) {
    throw new Error(`Failed to parse input JSON at ${inputPath}: ${err.message}`);
  }

  // Allow either full ResearchResult or partial object with segments
  let scriptInput: any = parsedJson;
  const rrParsed = ResearchResultSchema.safeParse(parsedJson);
  if (rrParsed.success) {
    scriptInput = rrParsed.data;
  }

  const duration = options.duration || 4;
  const aspect = options.aspect || 'landscape';
  const model = options.model || 'fast';
  const useLlm = options.llm !== false;
  const clipCount = options.clips && options.clips > 0 ? options.clips : undefined;

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(path.dirname(inputPath), 'flow-video-script.json');
  const config = { clipDuration: duration, aspectRatio: aspect, flowModel: model, useLlmForScript: useLlm, scriptClipCount: clipCount };
  const run = await RunContext.openIfExists(path.dirname(outputPath)) || await RunContext.create({
    pipelineId: 'script', outDir: path.dirname(outputPath), config,
  });
  try {
    await run.configure(config);
    if (rrParsed.success) {
      const registered = (await run.snapshot()).artifacts.research;
      if (!registered || path.resolve(run.outDir, registered.path) !== inputPath) {
        const importName = path.join(run.outDir, 'input-research-result.json') === inputPath
          ? 'imported-research-result.json' : 'input-research-result.json';
        await run.write('research', { ...rrParsed.data, runId: run.runId }, importName);
      }
    }
    const result = await run.step('script', async () => {
      const script = await generateFlowVideoScript({ ...scriptInput, runId: run.runId }, {
        clipDuration: duration, aspectRatio: aspect, model, useLlm, clipCount,
      });
      await run.write('script', script, path.basename(outputPath));
      return { script, outputPath };
    });
    await run.finish();
    return result;
  } catch (error) {
    await run.finish(error);
    throw error;
  }
}

export const scriptCommand = new Command()
  .name('yt-research-script')
  .description('Generate Veo-optimized Google Flow video scripts from YouTube research outputs')
  .version('1.0.0')
  .option('-i, --input <path>', 'Path to research-result.json file')
  .option('--run <path>', 'Run directory or run.json; read research and save the script in that run')
  .option('-o, --output <path>', 'Path for generated flow-video-script.json (defaults to input dir)')
  .option('-d, --duration <seconds>', 'Default clip duration (4, 6, 8, 10)', (v) => parseInt(v, 10), 4)
  .option('-n, --clips <count>', 'Target number of re-orchestrated scene clips (N)', (v) => parseInt(v, 10))
  .option('-a, --aspect <ratio>', 'Aspect ratio (landscape or portrait)', 'landscape')
  .option('-m, --model <name>', 'Flow model ("fast")', 'fast')
  .option('--llm', 'Enable LLM script generation, overriding the saved setting')
  .option('--no-llm', 'Disable LLM distillation and use deterministic prompt engineering')
  .action(async (opts, command) => {
    try {
      console.log(pc.cyan(`\n=== Flow Video Script Generator ===`));
      console.log(`Input:   ${opts.input}`);
      console.log(`Model:   ${opts.model} | Aspect: ${opts.aspect} | Duration: ${opts.duration}s`);
      console.log(`Engine:  ${opts.llm ? 'LLM Distillation + Veo Formula' : 'Deterministic Veo Formula'}`);

      const result = await runGenerateScriptCli({
        run: opts.run,
        input: opts.input,
        output: opts.output,
        duration: opts.run && command.getOptionValueSource('duration') === 'default' ? undefined : opts.duration,
        aspect: opts.run && command.getOptionValueSource('aspect') === 'default' ? undefined : opts.aspect,
        model: opts.run && command.getOptionValueSource('model') === 'default' ? undefined : opts.model,
        llm: opts.run && command.getOptionValueSource('llm') === 'default' ? undefined : opts.llm,
        clips: opts.clips,
      });

      console.log(pc.green(`\n✓ Generated ${result.script.totalClips} Veo Video Clips`));
      console.log(`Total Duration:   ${result.script.totalDurationSec} seconds`);
      console.log(`Estimated Quota:  ${result.script.totalCreditsEstimate} credits (${Math.ceil(result.script.totalCreditsEstimate / 15)} videos)`);
      console.log(`Saved To:         ${pc.bold(pc.green(result.outputPath))}\n`);

      console.log(pc.bold('Clips Preview:'));
      for (const clip of result.script.clips) {
        console.log(
          ` ${pc.cyan(`[Clip ${clip.clipIndex}]`)} ${pc.bold(clip.title)} ${pc.gray(`(${clip.durationSec}s · ${clip.transition === 'continuous' ? '连续' : '切分镜'})`)}`
        );
        if (clip.transitionNote) {
          console.log(`   ${pc.gray('备注:')}   ${clip.transitionNote}`);
        }
        console.log(`   ${pc.gray('Camera:')}  ${clip.cameraMovement}`);
        console.log(`   ${pc.gray('Prompt:')}  "${clip.visualPrompt.slice(0, 110)}..."\n`);
      }
    } catch (err: any) {
      console.error(pc.red(`\nScript generation failed: ${err.message}`));
      if (isLlmUnavailableError(err)) {
        await notifyLlmUnavailableAndExit(err, {
          stage: 'script-cli',
          task: 'generate-flow-script',
          context: 'Flow Script CLI',
          shouldExit: true,
        });
      }
      process.exit(1);
    }
  });

if (process.argv[1]?.endsWith('script.ts') || process.argv[1]?.endsWith('script.js')) {
  scriptCommand.parseAsync(process.argv);
}
