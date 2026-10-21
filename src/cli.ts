#!/usr/bin/env node
/**
 * AIGC Pipeline Platform — Multi-pipeline CLI entry point.
 *
 * Usage:
 *   aigc xhot [options] [query]      # Run the Xhot trending video pipeline
 *   aigc <pipeline-id> [options]     # Run any registered pipeline (future)
 *
 * Backward-compatible: when invoked as `xhot` binary, it auto-delegates to the xhot sub-command.
 */
import { Command } from 'commander';
import pc from 'picocolors';
import { attachXHotOptions, handleXHotCommand } from './pipelines/xhot/cli.js';

/**
 * Normalize em-dash/en-dash flags (e.g. —24h or –topics copied from chat/docs)
 * to standard double-dash.
 */
function normalizeArgv(argv: string[]): string[] {
  return argv.map((arg) => {
    if (arg.startsWith('\u2014') || arg.startsWith('\u2013')) {
      return '--' + arg.slice(1);
    }
    return arg;
  });
}

async function main() {
  const program = new Command();
  program
    .name('aigc')
    .description('AIGC Pipeline Platform — Multi-pipeline AIGC automation framework')
    .version('2.0.0');

  // ── Xhot Sub-command ──────────────────────────────────────────
  const xhotCmd = program
    .command('xhot')
    .description('Xhot: Discover trending topics on X, rank with VL grid, harvest materials, and render explainer video');

  attachXHotOptions(xhotCmd);

  xhotCmd.action(async (query: string, opts: any) => {
    await handleXHotCommand(query, opts);
  });

  // ── Future pipelines will be registered here ──────────────────
  // e.g.:
  // const ytCmd = program.command('yt-shorts').description('...');
  // attachYTOptions(ytCmd);
  // ytCmd.action(async (opts) => { ... });

  // ── Default action (no sub-command) ───────────────────────────
  program.action(() => {
    console.log(pc.bold(pc.cyan('\n🚀 AIGC Pipeline Platform v2.0.0\n')));
    console.log('Available pipelines:\n');
    console.log(`  ${pc.bold('xhot')}    Xhot Trending Video — discover hot topics on X, evaluate, harvest, and render explainer video`);
    console.log();
    console.log(`Run ${pc.cyan('aigc <pipeline> --help')} for pipeline-specific options.\n`);
    console.log('Examples:');
    console.log(`  ${pc.dim('$')} aigc xhot "new model"`);
    console.log(`  ${pc.dim('$')} aigc xhot --topics "AI;deepseek r1" --24h`);
    console.log(`  ${pc.dim('$')} aigc xhot --dry-run\n`);
  });

  const normalizedArgv = normalizeArgv(process.argv);

  // Backward compatibility: if invoked as the "xhot" binary (symlink or npx xhot),
  // and no sub-command is provided, auto-inject the "xhot" sub-command.
  const binName = normalizedArgv[1] ? normalizedArgv[1].split('/').pop() : '';
  const firstUserArg = normalizedArgv[2];
  const registeredSubCommands = program.commands.map((c) => c.name());

  if (
    binName === 'xhot' &&
    (!firstUserArg || !registeredSubCommands.includes(firstUserArg))
  ) {
    normalizedArgv.splice(2, 0, 'xhot');
  }

  await program.parseAsync(normalizedArgv);
}

// Support being called directly via tsx/node/npx
const scriptName = process.argv[1]?.split('/').pop() ?? '';
if (
  scriptName.endsWith('cli.ts') ||
  scriptName.endsWith('cli.js') ||
  scriptName === 'xhot' ||
  scriptName === 'aigc'
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
