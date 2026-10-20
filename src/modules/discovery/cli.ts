#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import pc from 'picocolors';
import { launchBrowser } from '../../libs/browser/launcher.js';
import { resolveProfileDir } from '../../utils/browser.js';
import { searchXCandidates } from './search.js';
import { buildXHotGrid } from './grid.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:discovery')
    .description('Discovery Module: Search X trending candidates and construct NxN contact grid')
    .argument('[query]', 'Topic keyword to search', 'new model')
    .option('-o, --out-dir <path>', 'Output directory for screenshots and grid', './artifacts/discovery')
    .option('-c, --candidate-count <number>', 'Number of candidates to gather', (v) => parseInt(v, 10), 12)
    .option('--headed', 'Run browser in headful mode', false)
    .option('--headless', 'Force headless mode', true)
    .action(async (query, opts) => {
      const outDir = path.resolve(opts.outDir);
      console.log(pc.cyan(`\n🔍 Searching X for candidates: "${query}" (count: ${opts.candidateCount})...`));

      const session = await launchBrowser({
        headless: opts.headless,
        reuseSession: true,
        keepAlive: true,
      });

      try {
        const candidates = await searchXCandidates(session.page, {
          query,
          candidateCount: opts.candidateCount,
          outDir,
        });

        console.log(pc.green(`✓ Gathered ${candidates.length} candidates.`));
        const gridPath = path.join(outDir, 'candidates-grid.png');
        await buildXHotGrid({ candidates, outputPath: gridPath });
        console.log(pc.green(`✓ Assembled grid: ${gridPath}`));

        await exitAfterFlush(0, 'module:discovery');
      } catch (err: any) {
        console.error(pc.red(`❌ Discovery module failed: ${err.message}`));
        await exitAfterFlush(1, 'module:discovery');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && process.argv[1].includes('discovery/cli')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
