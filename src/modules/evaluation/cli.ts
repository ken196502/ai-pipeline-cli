#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import pc from 'picocolors';
import { evaluateXHotCandidatesWithVL } from './eval.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:evaluation')
    .description('Evaluation Module: Run multimodal VL evaluation on candidate cards')
    .argument('<grid-path>', 'Path to candidate grid image (PNG/JPG)')
    .option('-q, --query <string>', 'Topic search query', 'new model')
    .option('-c, --candidates-json <path>', 'Path to candidates metadata JSON')
    .action(async (gridPathArg, opts) => {
      const gridPath = path.resolve(gridPathArg);
      console.log(pc.cyan(`\n🧠 Running VL evaluation for grid: ${gridPath}...`));

      try {
        const gridBuffer = await fs.readFile(gridPath);
        let candidates: any[] = [];
        if (opts.candidatesJson) {
          const jsonStr = await fs.readFile(path.resolve(opts.candidatesJson), 'utf-8');
          candidates = JSON.parse(jsonStr);
        }

        const result = await evaluateXHotCandidatesWithVL({
          query: opts.query,
          candidates,
          gridBuffer,
          gridImagePath: gridPath,
          onProgress: (m) => console.log(pc.dim(`[eval] ${m}`)),
        });

        console.log(pc.green(`✓ Evaluation complete! Winner: ${result.winner.name}`));
        console.log(JSON.stringify(result, null, 2));

        await exitAfterFlush(0, 'module:evaluation');
      } catch (err: any) {
        console.error(pc.red(`❌ Evaluation module failed: ${err.message}`));
        await exitAfterFlush(1, 'module:evaluation');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && process.argv[1].includes('evaluation/cli')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
