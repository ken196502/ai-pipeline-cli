#!/usr/bin/env node
/**
 * Research Search Module CLI Script.
 * Supports standalone discovery, pre-filtering, and --test mode for isolated verification.
 */
import { Command } from 'commander';
import pc from 'picocolors';
import { testResearchModule } from './index.js';
import { runSearchCli } from '../../research/cli/search.js';

const program = new Command();

program
  .name('module-research')
  .description('YouTube Research & Candidate Discovery Module Script')
  .version('1.0.0')
  .option('--test', 'Run standalone research module self-test and exit')
  .option('-q, --query <text>', 'YouTube search query')
  .option('-n, --max-candidates <num>', 'Maximum candidate videos to discover', '15')
  .option('-o, --output <path>', 'Custom path to write candidates.json')
  .option('-f, --format <type>', 'Output format: table, json, or both', 'both')
  .action(async (options) => {
    if (options.test) {
      console.log(pc.bold(pc.cyan('=== Testing Research Module Script in Isolation ===')));
      const result = await testResearchModule();
      if (result.success) {
        console.log(pc.green(`✓ Candidate filtering passed (${result.passedCount} kept, ${result.rejectedCount} rejected)`));
        console.log(pc.bold(pc.green('=== Research Module Script Test Passed ===')));
        process.exit(0);
      } else {
        console.error(pc.red(`✗ Research module test failed: ${result.errors.join(', ')}`));
        process.exit(1);
      }
    }

    if (!options.query) {
      console.error(pc.red('Error: Required option -q, --query <text> missing.'));
      program.help();
      process.exit(1);
    }

    await runSearchCli({
      query: options.query,
      maxCandidates: parseInt(options.maxCandidates, 10),
      output: options.output,
      format: options.format,
    });
  });

program.parse(process.argv);
