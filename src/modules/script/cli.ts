#!/usr/bin/env node
/**
 * Video Script Module CLI Script.
 * Supports generating Flow video scripts from research results and --test mode for isolated verification.
 */
import { Command } from 'commander';
import pc from 'picocolors';
import { testScriptModule } from './index.js';
import { runGenerateScriptCli } from '../../research/cli/script.js';

const program = new Command();

program
  .name('module-script')
  .description('Veo Video Script & Prompt Generation Module Script')
  .version('1.0.0')
  .option('--test', 'Run standalone script module self-test and exit')
  .option('-i, --input <path>', 'Path to research-result.json or extracted scenes')
  .option('-o, --output <path>', 'Path to write flow-video-script.json')
  .option('-d, --duration <sec>', 'Clip duration: 4, 6, 8, or 10', '6')
  .option('-a, --aspect <ratio>', 'Aspect ratio: landscape or portrait', 'landscape')
  .action(async (options) => {
    if (options.test) {
      console.log(pc.bold(pc.cyan('=== Testing Script Generator Module Script in Isolation ===')));
      const result = await testScriptModule();
      if (result.success) {
        console.log(pc.green(`✓ Generated ${result.totalClips} Veo clips (${result.totalDurationSec}s total duration)`));
        console.log(pc.green('✓ FlowVideoScriptSchema validation passed'));
        console.log(pc.bold(pc.green('=== Script Module Script Test Passed ===')));
        process.exit(0);
      } else {
        console.error(pc.red(`✗ Script module test failed: ${result.errors.join(', ')}`));
        process.exit(1);
      }
    }

    if (!options.input) {
      console.error(pc.red('Error: --input <path> is required to generate a video script.'));
      process.exit(1);
    }

    await runGenerateScriptCli({
      input: options.input,
      output: options.output,
      duration: parseInt(options.duration, 10) as 4 | 6 | 8 | 10,
      aspect: options.aspect,
    });
  });

program.parse(process.argv);
