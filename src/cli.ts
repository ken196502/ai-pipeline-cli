#!/usr/bin/env node
import { Command } from 'commander';
import { attachXHotOptions, handleXHotCommand } from './pipelines/xhot/cli.js';

async function main() {
  const program = new Command();
  program
    .name('xhot')
    .description('Xhot Pipeline: Discover hot topics on X, rank with VL grid, harvest materials, and render explainer video')
    .version('1.0.0');

  attachXHotOptions(program);

  program.action(async (query, opts) => {
    await handleXHotCommand(query, opts);
  });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('xhot'))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
