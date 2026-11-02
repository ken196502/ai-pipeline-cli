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
import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { attachXHotOptions, handleXHotCommand } from './pipelines/xhot/cli.js';
import { attachFlowTutorOptions, handleFlowTutorCommand } from './pipelines/flowtutor/cli.js';
import { attachXDevOptions, handleXDevCommand } from './pipelines/xdev/cli.js';
import { PIPELINE_CONFLICT_CODE, PIPELINE_CONFLICT_EXIT_CODE } from './pipelines/core/lock.js';
import { pruneProfile, dirSizeBytes, formatBytes } from './libs/browser/profile-cache.js';
import { resolveProfileDir } from './utils/browser.js';
import { describeNotifyTargets, setNotifyTargets } from './utils/send_msg.js';

/**
 * Shared notification-target flags for every pipeline sub-command.
 *
 * Delivery is project-level (`src/utils/notify-defaults.ts`, default bot `main`).
 * These flags only exist so one run can be pointed somewhere else, e.g.
 * `aigc xdev --notify inspilot`. Nothing about bots is read from env.
 */
function attachNotifyOptions(cmd: Command): Command {
  return cmd
    .option(
      '--notify <bots>',
      "Send this run's results AND errors to these bot(s) instead of the project default " +
        '(comma-separated: inspilot | main,inspilot)'
    )
    .option(
      '--notify-error <bots>',
      'Send only errors/alerts to these bot(s); defaults to the --notify target(s) when omitted'
    );
}

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

  attachNotifyOptions(program);

  // Resolve `--notify` / `--notify-error` before any pipeline starts, so a typo
  // fails in a second instead of after an hour of work with alerts misrouted.
  program.hook('preAction', (thisCommand, actionCommand) => {
    const opts = { ...thisCommand.opts?.(), ...actionCommand.opts?.() };
    if (opts.notify === undefined && opts.notifyError === undefined) return;

    try {
      setNotifyTargets({ result: opts.notify, error: opts.notifyError });
    } catch (err: any) {
      console.error(pc.red(`\n⛔ Notification target rejected: ${err.message}\n`));
      process.exit(78);
    }

    console.log(
      pc.cyan(
        `\n📨 Notification targets — results: ${describeNotifyTargets('result')} | ` +
          `errors: ${describeNotifyTargets('error')}`
      )
    );
  });

  // ── Xhot Sub-command ──────────────────────────────────────────
  const xhotCmd = program
    .command('xhot')
    .description('Xhot: Discover trending topics on X, rank with VL grid, harvest materials, and render explainer video');

  attachXHotOptions(xhotCmd);
  attachNotifyOptions(xhotCmd);

  xhotCmd.action(async (query: string, opts: any) => {
    await handleXHotCommand(query, opts);
  });

  // ── flowTutor (YouTube AI video tutorial research) Sub-command ─
  const flowTutorCmd = program
    .command('flowTutor')
    .description(
      'FlowTutor: YouTube AI video tutorial research, Flow Veo synthesis, and tutorial video'
    );

  attachFlowTutorOptions(flowTutorCmd);
  attachNotifyOptions(flowTutorCmd);

  flowTutorCmd.action(async (query: string, opts: any) => {
    await handleFlowTutorCommand(query, opts);
  });

  // ── xdev (X Developer List & Multi-Agent Research) Sub-command ──
  const xdevCmd = program
    .command('xdev')
    .description('xdev: Scrape X developer list using Firefox ESR & WebDriver BiDi, analyze multi-agent insights');

  attachXDevOptions(xdevCmd);
  attachNotifyOptions(xdevCmd);

  xdevCmd.action(async (opts: any) => {
    await handleXDevCommand(opts);
  });

  // ── Profile maintenance Sub-command ───────────────────────────
  const profileCmd = program
    .command('profile')
    .description('Chromium persistent-profile maintenance (cache cleanup, size report)');

  profileCmd
    .command('clean')
    .description('Delete cache/telemetry dirs from the persistent profile (login is kept)')
    .option('-p, --profile-dir <path>', 'Persistent profile directory')
    .option('--force', 'Clean even when a Chromium is running on the profile', false)
    .option('--dry-run', 'Only report what would be removed', false)
    .action(async (opts: any) => {
      const profileDir = resolveProfileDir(opts.profileDir);
      console.log(pc.bold(pc.cyan('\n=== Chromium Profile Cache Cleanup ===\n')));
      console.log(`${pc.bold('Profile Dir:')} ${profileDir}`);

      const result = await pruneProfile(profileDir, { force: opts.force, dryRun: opts.dryRun });

      if (result.skipped) {
        console.log(
          pc.yellow(`\nSkipped: a Chromium is still running on this profile (pid ${result.pid}).`)
        );
        console.log(
          pc.dim(`Profile is ${formatBytes(result.remainingBytes)}. Close the browser, or re-run with --force.\n`)
        );
        process.exitCode = 2;
        return;
      }

      if (result.removedDirs.length === 0 && result.removedFiles === 0) {
        console.log(pc.green(`\nNothing to clean (${formatBytes(result.remainingBytes)}).\n`));
        return;
      }

      for (const dir of result.removedDirs) {
        console.log(pc.dim(`  ${opts.dryRun ? 'would remove' : '-'} ${dir}`));
      }
      if (result.removedFiles > 0) {
        console.log(pc.dim(`  ${opts.dryRun ? 'would remove' : '-'} ${result.removedFiles} junk file(s)`));
      }
      console.log('');
      console.log(
        (opts.dryRun ? pc.yellow('Would free ') : pc.green('Freed ')) +
          pc.bold(formatBytes(result.freedBytes)) +
          pc.dim(`  (remains ${formatBytes(result.remainingBytes)})`)
      );
      console.log(pc.dim('Cookies / Local Storage / IndexedDB kept — the login survives.\n'));
    });

  profileCmd
    .command('size')
    .description('Report profile size and its biggest cache directories')
    .option('-p, --profile-dir <path>', 'Persistent profile directory')
    .action(async (opts: any) => {
      const profileDir = resolveProfileDir(opts.profileDir);
      const total = await dirSizeBytes(profileDir);
      console.log(pc.bold(pc.cyan('\n=== Chromium Profile Size ===\n')));
      console.log(`${pc.bold('Profile Dir:')} ${profileDir}`);
      console.log(`${pc.bold('Total:')}       ${formatBytes(total)}\n`);
      const rows: Array<{ name: string; bytes: number }> = [];
      for (const parent of ['', 'Default']) {
        const dir = path.join(profileDir, parent);
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          rows.push({ name: path.join(parent, entry.name), bytes: await dirSizeBytes(full) });
        }
      }
      rows.sort((a, b) => b.bytes - a.bytes);
      for (const row of rows.slice(0, 12)) {
        console.log(`  ${formatBytes(row.bytes).padStart(10)}  ${pc.dim(row.name)}`);
      }
      console.log('');
    });

  // ── Default action (no sub-command) ───────────────────────────
  program.action(() => {
    console.log(pc.bold(pc.cyan('\n🚀 AIGC Pipeline Platform v2.0.0\n')));
    console.log('Available pipelines:\n');
    console.log(`  ${pc.bold('xhot')}      Xhot Trending Video — discover hot topics on X, evaluate, harvest, and render explainer video`);
    console.log(`  ${pc.bold('flowTutor')}  YouTube AI video tutorial research, Flow Veo synthesis, and tutorial video`);
    console.log(`  ${pc.bold('xdev')}       X Developer List & Multi-Agent Research via Firefox ESR & WebDriver BiDi`);
    console.log(`  ${pc.bold('profile')}    Chromium profile maintenance — ${pc.cyan('profile size')} / ${pc.cyan('profile clean')}`);
    console.log();
    console.log(`Run ${pc.cyan('aigc <pipeline> --help')} for pipeline-specific options.\n`);
    console.log('Examples:');
    console.log(`  ${pc.dim('$')} aigc xhot "new model"`);
    console.log(`  ${pc.dim('$')} aigc flowTutor "AI make Niche Viral Video"`);
    console.log(`  ${pc.dim('$')} aigc xhot --topics "AI;deepseek r1" --24h\n`);
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
    // Concurrent pipelines would corrupt the shared Chromium profile: report the
    // conflict plainly (no stack, no alerts) and exit with a dedicated code.
    if (err?.code === PIPELINE_CONFLICT_CODE || err?.name === 'PipelineConflictError') {
      console.error(pc.red(err.message));
      process.exitCode = PIPELINE_CONFLICT_EXIT_CODE;
      return;
    }
    console.error(err);
    process.exit(1);
  });
}
