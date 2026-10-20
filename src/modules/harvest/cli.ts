#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import pc from 'picocolors';
import { launchBrowser } from '../../libs/browser/launcher.js';
import { harvestWinnerTopicMaterials } from './harvest.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:harvest')
    .description('Harvest Module: Deep search winner topic, collecting tweets, images, and video clips')
    .argument('<topic-name>', 'Winner topic or model name to harvest')
    .option('-o, --out-dir <path>', 'Destination output directory', './artifacts/harvest')
    .option('-c, --count <number>', 'Number of target tweets to collect', (v) => parseInt(v, 10), 6)
    .option('--headed', 'Run browser in headful mode', false)
    .option('--headless', 'Force headless mode', true)
    .action(async (topicName, opts) => {
      const outDir = path.resolve(opts.outDir);
      console.log(pc.cyan(`\n🌾 Harvesting rich materials for winner topic: "${topicName}"...`));

      const session = await launchBrowser({
        headless: opts.headless,
        reuseSession: true,
        keepAlive: true,
      });

      try {
        const harvestResult = await harvestWinnerTopicMaterials(session.page, {
          winnerName: topicName,
          targetCount: opts.count,
          outDir,
          onProgress: (m) => console.log(pc.dim(`[harvest] ${m}`)),
        });

        console.log(pc.green(`✓ Harvested ${harvestResult.items.length} tweets and ${harvestResult.harvestedMediaCount} media items.`));
        console.log(pc.green(`📁 Materials dir: ${harvestResult.materialsDir}`));

        await exitAfterFlush(0, 'module:harvest');
      } catch (err: any) {
        console.error(pc.red(`❌ Harvest module failed: ${err.message}`));
        await exitAfterFlush(1, 'module:harvest');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && process.argv[1].includes('harvest/cli')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
