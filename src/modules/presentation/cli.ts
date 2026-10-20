#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import pc from 'picocolors';
import { createXHotPresentationVideo } from './video.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:presentation')
    .description('Presentation Module: Generate OpusVideo storyboard, TTS narration, and render presentation video')
    .argument('<eval-result-json>', 'Path to eval-result.json')
    .argument('<harvest-result-json>', 'Path to harvest-result.json')
    .option('-o, --out-dir <path>', 'Output directory for presentation video', './artifacts/presentation')
    .option('-q, --query <string>', 'Topic query', 'new model')
    .option('--fps <number>', 'Video frame rate', (v) => parseInt(v, 10), 30)
    .option('--engine <engine>', 'Render engine (chromium, firefox)', 'chromium')
    .action(async (evalJsonPath, harvestJsonPath, opts) => {
      const outDir = path.resolve(opts.outDir);
      console.log(pc.cyan(`\n🎬 Generating presentation video in: ${outDir}...`));

      try {
        const evalResult = JSON.parse(await fs.readFile(path.resolve(evalJsonPath), 'utf-8'));
        const harvestResult = JSON.parse(await fs.readFile(path.resolve(harvestJsonPath), 'utf-8'));

        const summary = await createXHotPresentationVideo({
          query: opts.query,
          evalResult,
          harvestResult,
          outDir,
          fps: opts.fps,
          engine: opts.engine,
          onProgress: (stage, msg) => console.log(pc.dim(`[presentation] [${stage}] ${msg}`)),
        });

        console.log(pc.green(`✓ Video rendered successfully! Output: ${summary.videoPath}`));
        console.log(`Duration: ${summary.totalDurationSec}s (${summary.sceneCount} scenes)`);

        await exitAfterFlush(0, 'module:presentation');
      } catch (err: any) {
        console.error(pc.red(`❌ Presentation module failed: ${err.message}`));
        await exitAfterFlush(1, 'module:presentation');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && process.argv[1].includes('presentation/cli')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
