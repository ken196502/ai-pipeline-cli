#!/usr/bin/env node
/**
 * Google Flow Video Generation CLI — Extension Mode (Anti-Detection)
 *
 * Uses Real Chrome + Extension + Native Messaging + xdotool.
 * NO CDP, NO Playwright, NO Puppeteer — fully undetectable.
 */
import { Command } from 'commander';
import { runFlowBatchCommand } from './run.js';
import { RunContext } from '../run/index.js';
import pc from 'picocolors';
import path from 'node:path';
import { FlowClientExt } from './client-ext.js';
import { checkNativeHostInstallation } from '../browser/real-chrome-launcher.js';
import { isXdotoolAvailable } from '../input/system-input.js';

const program = new Command();
const client = new FlowClientExt();

program
  .name('flow-ext')
  .description('Google Flow VideoGen — Extension Mode (Anti-Detection, No CDP)')
  .version('1.0.0');

/**
 * Command: setup
 */
program
  .command('setup')
  .description('Check prerequisites and install Native Messaging Host')
  .action(async () => {
    console.log(pc.cyan('\n=== VideoGen Extension Mode Setup Check ===\n'));

    // 1. xdotool
    const hasXdotool = await isXdotoolAvailable();
    console.log(
      hasXdotool
        ? pc.green('✓ xdotool is available')
        : pc.red('✗ xdotool not found — install with: sudo apt-get install xdotool')
    );

    // 2. Extension directory
    const extPath = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '../../extension'));
    const { existsSync } = await import('node:fs');
    const hasExt = existsSync(path.join(extPath, 'manifest.json'));
    console.log(
      hasExt
        ? pc.green(`✓ Extension found: ${extPath}`)
        : pc.red(`✗ Extension not found at: ${extPath}`)
    );

    // 3. Native Messaging Host
    const nmCheck = await checkNativeHostInstallation();
    if (nmCheck.installed) {
      console.log(pc.green(`✓ Native Messaging Host installed:`));
      for (const p of nmCheck.paths) console.log(pc.gray(`    ${p}`));
    } else {
      console.log(pc.yellow(`⚠ Native Messaging Host not fully installed`));
      if (nmCheck.paths.length > 0) {
        for (const p of nmCheck.paths) console.log(pc.gray(`  Found: ${p}`));
      }
      for (const e of nmCheck.errors) console.log(pc.red(`  Error: ${e}`));
      console.log(pc.yellow(`\n  Run: bash native-host/install.sh`));
    }

    // 4. Python3
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    let hasPython = false;
    try {
      await exec('python3', ['--version']);
      hasPython = true;
    } catch {}
    console.log(
      hasPython
        ? pc.green('✓ python3 is available')
        : pc.red('✗ python3 not found')
    );

    // 5. DISPLAY
    const hasDisplay = !!process.env.DISPLAY;
    console.log(
      hasDisplay
        ? pc.green(`✓ DISPLAY=${process.env.DISPLAY}`)
        : pc.red('✗ DISPLAY not set — xdotool requires X11')
    );

    const allGood = hasXdotool && hasExt && nmCheck.installed && hasPython && hasDisplay;
    console.log(allGood
      ? pc.green('\n✓ All prerequisites met! Ready to use flow-ext.')
      : pc.yellow('\n⚠ Some prerequisites missing. Fix the issues above and re-run setup.')
    );
  });

/**
 * Command: login
 */
program
  .command('login')
  .description('Open Chrome for Google Flow authentication')
  .option('--profile-dir <path>', 'Chromium profile directory')
  .action(async (opts) => {
    try {
      await client.login({ profileDir: opts.profileDir });
    } catch (err: any) {
      console.error(pc.red(`\nLogin failed: ${err.message}`));
      process.exit(1);
    }
  });

/**
 * Command: project
 */
program
  .command('project')
  .description('Verify, list, or create a Google Flow project (anti-detection mode)')
  .option('-p, --project-id <id>', 'Existing Flow project UUID to verify')
  .option('-l, --list', 'Scroll to bottom of flow.google.com and list all displayed projects', false)
  .option('--profile-dir <path>', 'Custom Chromium user data profile directory')
  .action(async (opts) => {
    try {
      if (opts.list) {
        const projects = await client.listProjects({
          profileDir: opts.profileDir,
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
      });

      console.log(pc.cyan(`\n=== Flow Project Details ===`));
      console.log(`Project ID: ${pc.bold(project.projectId || 'Default/Auto')}`);
      console.log(`URL:        ${project.url}`);
      console.log();
    } catch (err: any) {
      console.error(pc.red(`\nProject check failed: ${err.message}`));
      process.exit(1);
    } finally {
      await client.release();
    }
  });

/**
 * Command: generate
 */
program
  .command('generate')
  .description('Generate a video on Google Flow (anti-detection mode)')
  .requiredOption('-p, --prompt <text>', 'Visual prompt for video animation')
  .option('--image-prompt <text>', 'Text-to-image prompt for keyframe')
  .option('-o, --output <path>', 'Output MP4 file path')
  .option('--image-output <path>', 'Output keyframe image path')
  .option('-d, --duration <seconds>', 'Duration (4, 6, 8, 10)', (v) => parseInt(v, 10), 4)
  .option('--timeout <seconds>', 'Video synthesis timeout', (v) => parseInt(v, 10), 1800)
  .option('--project-id <id>', 'Flow project UUID')
  .option('--profile-dir <path>', 'Chromium profile directory')
  .action(async (opts) => {
    try {
      const result = await client.generateVideo({
        prompt: opts.prompt,
        imagePrompt: opts.imagePrompt,
        outputPath: opts.output,
        imageOutputPath: opts.imageOutput,
        duration: opts.duration as 4 | 6 | 8 | 10,
        timeoutMs: opts.timeout * 1000,
        projectId: opts.projectId,
        profileDir: opts.profileDir,
      });

      console.log(pc.cyan('\n=== Generation Complete ==='));
      console.log(`Video URL: ${result.videoUrl}`);
      if (result.outputPath) console.log(`Saved: ${pc.green(result.outputPath)}`);
    } catch (err: any) {
      console.error(pc.red(`\nGeneration failed: ${err.message}`));
      process.exit(1);
    } finally {
      await client.release();
    }
  });

/**
 * Command: batch
 */
program
  .command('batch')
  .description('Batch-generate clips from a script (anti-detection mode)')
  .option('--run <path>', 'Run directory or run.json; use its script, settings and stage outputs')
  .option('-s, --script <path>', 'Path to flow-video-script.json')
  .option('-o, --out-dir <path>', 'Output directory for clips')
  .option('--project-id <id>', 'Flow project UUID')
  .option('--max-clips <n>', 'Max clips to generate', (v) => parseInt(v, 10))
  .option('--dry-run', 'Preview without generating')
  .option('--no-dry-run', 'Submit generation even if this run previously used dry-run')
  .option('--profile-dir <path>', 'Chromium profile directory')
  .action(async (opts) => {
    if (opts.run && !opts.profileDir) {
      const run = await RunContext.open(opts.run);
      opts.profileDir = (await run.snapshot()).config.profileDir;
    }
    try {
      const result = await runFlowBatchCommand({
        run: opts.run,
        script: opts.script,
        outDir: opts.outDir,
        projectId: opts.projectId,
        maxClips: opts.maxClips,
        dryRun: opts.dryRun,
        profileDir: opts.profileDir,
      }, client);

      console.log(pc.cyan('\n=== Batch Summary ==='));
      console.log(`Completed: ${pc.green(String(result.completedClips))}`);
      console.log(`Failed: ${pc.red(String(result.failedClips))}`);
      console.log(`Skipped: ${pc.yellow(String(result.skippedClips))}`);

      if (result.failedClips > 0) process.exitCode = 1;
    } catch (err: any) {
      console.error(pc.red(`\nBatch failed: ${err.message}`));
      process.exitCode = 1;
    } finally {
      await client.release();
    }
  });

program.parseAsync(process.argv);
