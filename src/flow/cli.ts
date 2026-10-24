#!/usr/bin/env node
/**
 * Google Flow Video Generation CLI.
 *
 * Provides commands to authenticate with Google Flow, read the live credit
 * balance, inspect/create projects, generate videos from visual prompts, and
 * batch-render multi-clip research scripts.
 */
import { Command } from 'commander';
import { runFlowBatchCommand } from './run.js';
import { RunContext } from '../run/index.js';
import pc from 'picocolors';
import path from 'node:path';
import { FlowClient } from './client.js';
import { parseViewport } from '../browser/launcher.js';
import { sendMsg, formatDetailedErrorMessage } from '../utils/send_msg.js';

const program = new Command();
const client = new FlowClient();

program
  .name('flow-cli')
  .description('Google Flow VideoGen Automation CLI with Anti-Bot and Quota Management')
  .version('1.0.0');

/**
 * Command: login
 */
program
  .command('login')
  .description('Launch browser to authenticate with Google Flow and persist login cookies')
  .option('--profile-dir <path>', 'Custom Chromium user data profile directory')
  .option('--viewport <resolution>', 'Browser viewport resolution as WIDTHxHEIGHT or "null" (default: auto-detect screen)')
  .action(async (opts) => {
    try {
      const parsedViewport = opts.viewport !== undefined ? parseViewport(opts.viewport) : undefined;
      await client.login({ profileDir: opts.profileDir, viewport: parsedViewport });
    } catch (err: any) {
      console.error(pc.red(`\nLogin failed: ${err.message}`));
      process.exit(1);
    }
  });

/**
 * Command: quota
 */
program
  .command('quota')
  .description('Read the live Google Flow credit balance (top-right avatar panel)')
  .option('--profile-dir <path>', 'Custom Chromium user data profile directory')
  .option('--headed', 'Launch browser headed for debugging')
  .action(async (opts) => {
    try {
      const quota = await client.checkQuota({
        profileDir: opts.profileDir,
        headed: opts.headed,
      });

      console.log(pc.cyan(`\n=== Google Flow Live Credit Balance (${quota.date}) ===`));
      console.log(`Flow Credits:      ${pc.bold(pc.green(String(quota.actualCredits)))} (live from flow.google.com)`);
      console.log(`Cost per Video:    ${quota.costPerVideo} credits`);
      console.log();
    } catch (err: any) {
      console.error(pc.red(`\nQuota query failed: ${err.message}`));
      process.exit(1);
    }
  });

/**
 * Command: project
 */
program
  .command('project')
  .description('Verify, list, or create a Google Flow project')
  .option('-p, --project-id <id>', 'Existing Flow project UUID to verify')
  .option('-l, --list', 'Scroll to bottom of flow.google.com and list all displayed projects', false)
  .option('--profile-dir <path>', 'Custom Chromium user data profile directory')
  .option('--headed', 'Launch browser headed for debugging')
  .action(async (opts) => {
    try {
      if (opts.list) {
        const projects = await client.listProjects({
          profileDir: opts.profileDir,
          headed: opts.headed,
        });

        console.log(pc.cyan(`\n=== Flow Projects (${projects.length} found) ===`));
        if (projects.length === 0) {
          console.log(pc.yellow('No existing projects discovered on flow.google.com.'));
        } else {
          for (let i = 0; i < projects.length; i++) {
            const p = projects[i];
            console.log(
              `${pc.bold(String(i + 1).padStart(2, ' '))}. ${pc.green(p.projectId)} ${p.title ? pc.white(`("${p.title}")`) : ''}\n    ↳ ${pc.gray(p.url)}`
            );
          }
        }
        console.log();
        return;
      }

      const project = await client.checkOrCreateProject(opts.projectId, {
        profileDir: opts.profileDir,
        headed: opts.headed,
      });

      console.log(pc.cyan(`\n=== Flow Project Details ===`));
      console.log(`Project ID: ${pc.bold(project.projectId || 'Default/Auto')}`);
      console.log(`URL:        ${project.url}`);
      console.log();
    } catch (err: any) {
      console.error(pc.red(`\nProject check failed: ${err.message}`));
      process.exit(1);
    }
  });

/**
 * Command: generate
 */
program
  .command('generate')
  .description('Generate a video clip on Google Flow from a prompt')
  .requiredOption('-p, --prompt <text>', 'Visual prompt describing the scene and camera action')
  .option('-o, --output <path>', 'Destination file path for the downloaded MP4')
  .option('--project-id <id>', 'Target Flow project UUID')
  .option('-d, --duration <seconds>', 'Clip duration (4, 6, 8, 10)', (v) => parseInt(v, 10), 4)
  .option('-a, --aspect <ratio>', 'Aspect ratio (landscape or portrait)', 'landscape')
  .option('-m, --model <name>', 'Model tier ("lite" / "fast")', 'lite')
  .option('--timeout <seconds>', 'Timeout in seconds waiting for video synthesis', (v) => parseInt(v, 10), 1800)
  .option('--profile-dir <path>', 'Custom Chromium user data profile directory')
  .option('--headed', 'Launch browser headed for visual inspection')
  .option('--viewport <resolution>', 'Browser viewport resolution as WIDTHxHEIGHT or "null" (default: auto-detect screen)')
  .action(async (opts) => {
    try {
      const parsedViewport = opts.viewport !== undefined ? parseViewport(opts.viewport) : undefined;
      const result = await client.generateVideo({
        prompt: opts.prompt,
        outputPath: opts.output,
        projectId: opts.projectId,
        duration: opts.duration as 4 | 6 | 8 | 10,
        aspect: opts.aspect as 'landscape' | 'portrait',
        model: opts.model,
        timeoutMs: opts.timeout * 1000,
        profileDir: opts.profileDir,
        headed: Boolean(opts.headed),
        viewport: parsedViewport,
      });

      console.log(pc.cyan(`\n=== Flow Video Generation Succeeded ===`));
      console.log(`Project:   ${result.project.projectId || 'Default'}`);
      console.log(`Video URL: ${result.videoUrl}`);
      if (result.outputPath) {
        console.log(`Saved To:  ${pc.bold(pc.green(result.outputPath))}`);
      }
      const delta =
        typeof result.quota.creditsBefore === 'number' && typeof result.quota.creditsAfter === 'number'
          ? ` (Δ ${result.quota.creditsAfter > result.quota.creditsBefore ? '+' : ''}${result.quota.creditsAfter - result.quota.creditsBefore})`
          : '';
      console.log(`Credits:  ${result.quota.actualCredits} remaining after task${delta}\n`);
    } catch (err: any) {
      console.error(pc.red(`\nGeneration failed: ${err.message}`));
      process.exit(1);
    }
  });

/**
 * Command: batch
 */
program
  .command('batch')
  .description('Batch-generate video clips from a Flow video script JSON file')
  .option('--run <path>', 'Run directory or run.json; use its script, settings and stage outputs')
  .option('-s, --script <path>', 'Path to flow-video-script.json file')
  .option('-o, --out-dir <path>', 'Directory where downloaded video clips will be stored')
  .option('--project-id <id>', 'Target Flow project UUID')
  .option('--max-clips <number>', 'Limit number of clips to generate in this run', (v) => parseInt(v, 10))
  .option('--dry-run', 'Preview clip prompts without submitting to Flow backend')
  .option('--no-dry-run', 'Submit generation even if this run previously used dry-run')
  .option('--profile-dir <path>', 'Custom Chromium user data profile directory')
  .option('--headed', 'Launch browser headed for visual inspection')
  .option('--viewport <resolution>', 'Browser viewport resolution as WIDTHxHEIGHT or "null" (default: auto-detect screen)')
  .action(async (opts) => {
    if (opts.run && !opts.profileDir) {
      const run = await RunContext.open(opts.run);
      opts.profileDir = (await run.snapshot()).config.profileDir;
    }
    try {
      const parsedViewport = opts.viewport !== undefined ? parseViewport(opts.viewport) : undefined;
      const batchResult = await runFlowBatchCommand({
        run: opts.run,
        script: opts.script,
        outDir: opts.outDir,
        projectId: opts.projectId,
        maxClips: opts.maxClips,
        dryRun: opts.dryRun,
        profileDir: opts.profileDir,
        headed: opts.headed,
        viewport: parsedViewport,
      }, client);

      console.log(pc.cyan(`\n=== Batch Generation Summary ===`));
      console.log(`Total Clips:     ${batchResult.totalClips}`);
      console.log(`Completed:       ${pc.green(String(batchResult.completedClips))}`);
      console.log(`Failed:          ${pc.red(String(batchResult.failedClips))}`);
      console.log(`Skipped:         ${pc.yellow(String(batchResult.skippedClips))}`);
      console.log(`Output Folder:   ${batchResult.outDir}\n`);

      if (batchResult.failedClips > 0) {
        process.exitCode = 1;
        try {
          const firstFailed = batchResult.results.find((c: any) => c.status === 'failed');
          const alertMsg = [
            '❌ <b>【Flow Batch Generation Failed】</b>',
            '',
            `• Failed Clip: Clip ${firstFailed?.clipIndex ?? '?'} ("${firstFailed?.title || ''}")`,
            `• Reason: ${firstFailed?.error || 'Unknown error'}`,
            `• Completed: ${batchResult.completedClips}/${batchResult.totalClips}`,
            `• Output Folder: ${batchResult.outDir}`,
          ].join('\n');
          await sendMsg(alertMsg);
        } catch {}
      }
    } catch (err: any) {
      console.error(pc.red(`\nBatch run failed: ${err.message}`));
      process.exitCode = 1;
      // Do not send Telegram alert for missing CLI argument validation errors
      const isCliArgValidationError = err.message?.includes('required option') || err.message?.includes('specify --run or both');
      if (!isCliArgValidationError) {
        try {
          const detailedMsg = formatDetailedErrorMessage(err, '❌ Flow batch generation failed');
          await sendMsg(detailedMsg);
        } catch {}
      }
    } finally {
      await client.close({ profileDir: opts.profileDir });
    }
  });

program.parseAsync(process.argv);
