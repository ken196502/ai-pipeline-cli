#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import pc from 'picocolors';
import { createExplainerVideo } from './video.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:explainer-video')
    .description('Explainer Video Module: Generate OpusVideo storyboard, TTS narration, and render explainer video')
    .argument('<eval-result-json>', 'Path to eval-result.json')
    .argument('<harvest-result-json>', 'Path to harvest-result.json')
    .option('-o, --out-dir <path>', 'Output directory for explainer video', './artifacts/explainer')
    .option('-q, --query <string>', 'Topic query', 'new model')
    .option('--fps <number>', 'Video frame rate', (v) => parseInt(v, 10), 30)
    .option('--engine <engine>', 'Render engine (chromium, firefox)', 'chromium')
    .action(async (evalJsonPath, harvestJsonPath, opts) => {
      const outDir = path.resolve(opts.outDir);
      console.log(pc.cyan(`\n🎬 Generating explainer video in: ${outDir}...`));

      try {
        const evalResult = JSON.parse(await fs.readFile(path.resolve(evalJsonPath), 'utf-8'));
        const harvestResult = JSON.parse(await fs.readFile(path.resolve(harvestJsonPath), 'utf-8'));

        const summary = await createExplainerVideo({
          query: opts.query,
          evalResult,
          harvestResult,
          outDir,
          fps: opts.fps,
          engine: opts.engine,
          onProgress: (stage, msg) => console.log(pc.dim(`[explainer-video] [${stage}] ${msg}`)),
        });

        console.log(pc.green(`✓ Video rendered successfully! Output: ${summary.videoPath}`));
        console.log(`Duration: ${summary.totalDurationSec}s (${summary.sceneCount} scenes)`);

        await exitAfterFlush(0, 'module:explainer-video');
      } catch (err: any) {
        console.error(pc.red(`❌ Explainer video module failed: ${err.message}`));
        await exitAfterFlush(1, 'module:explainer-video');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && (process.argv[1].includes('explainer-video/cli') || process.argv[1].includes('explainer/cli') || process.argv[1].includes('presentation/cli'))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
