#!/usr/bin/env node
/**
 * Standalone Browser-Use CLI Utility.
 *
 * Provides command-line management for:
 * - Chromium & Ungoogled Chromium installation check & install
 * - Persistent profile browser launch with CDP and extension support
 * - Multi-mode screenshot capture (full-page, viewport, CSS selector, clip)
 * - Netscape format cookie export for yt-dlp
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  detectChromiumInstallation,
  installUngoogledChromium,
} from './installer.js';
import { launchBrowser } from './launcher.js';
import { takeScreenshot } from './screenshots.js';
import { exportCookies } from './actions.js';
import { createRunLogger } from '../../utils/logger.js';
import { generateRunId, ensureOutputDir } from '../../utils/run.js';

const program = new Command();

program
  .name('browser-use')
  .description('Production-grade browser automation, CDP management, and cookie export utility')
  .version('1.0.0');

/**
 * Command: check-install
 */
program
  .command('check-install')
  .description('Check Ungoogled Chromium / Chromium installation and version')
  .option('-o, --out-dir <path>', 'Output directory for run artifacts')
  .action(async (opts) => {
    const runId = generateRunId('browser-check');
    const outDir = await ensureOutputDir(opts.outDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'BROWSER INSTALLATION CHECK RUN LOG',
    });

    try {
      logger.stage('check', 'Checking Chromium installation');
      console.log(pc.bold(pc.cyan('\n=== Chromium Installation Check ===\n')));
      const info = await detectChromiumInstallation();

      logger.info('Installation check complete', {
        platform: info.platform,
        found: info.found,
        path: info.path,
        version: info.version,
        isUngoogled: info.isUngoogled,
      });

      console.log(`${pc.bold('Platform:')}      ${info.platform}`);
      console.log(`${pc.bold('Status:')}        ${info.found ? pc.green('Found') : pc.red('Not Found')}`);

      if (info.found) {
        console.log(`${pc.bold('Path:')}          ${info.path}`);
        console.log(`${pc.bold('Version:')}       ${info.version || 'Unknown'}`);
        console.log(`${pc.bold('Flavor:')}        ${info.isUngoogled ? pc.green('Ungoogled Chromium') : pc.yellow('Standard Chromium')}`);
        console.log(`${pc.bold('Notes:')}         ${info.notes}\n`);
      } else {
        console.log(`${pc.bold('Notes:')}         ${info.notes}`);
        console.log(pc.yellow('\nTip: Run "browser-use install" to attempt automated installation via Homebrew (macOS).\n'));
        process.exit(1);
      }
    } finally {
      await logger.close();
    }
  });

/**
 * Command: install
 */
program
  .command('install')
  .description('Attempt automated installation of Ungoogled Chromium')
  .option('-o, --out-dir <path>', 'Output directory for run artifacts')
  .action(async (opts) => {
    const runId = generateRunId('browser-install');
    const outDir = await ensureOutputDir(opts.outDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'BROWSER INSTALL RUN LOG',
    });

    try {
      logger.stage('install', 'Starting Ungoogled Chromium installation');
      console.log(pc.bold(pc.cyan('\n=== Ungoogled Chromium Installer ===\n')));
      const result = await installUngoogledChromium();

      logger.info('Installation result', { success: result.success, message: result.message });

      if (result.success) {
        console.log(pc.green(`✓ ${result.message}\n`));
      } else {
        console.log(pc.yellow(`! ${result.message}\n`));
        process.exit(1);
      }
    } finally {
      await logger.close();
    }
  });

/**
 * Command: launch
 */
program
  .command('launch')
  .description('Launch Chromium with persistent profile, extensions, and optional CDP port')
  .option('-u, --url <url>', 'Initial URL to open', 'https://www.youtube.com')
  .option('-p, --profile-dir <path>', 'Persistent profile directory', './.chromium-profile')
  .option('-b, --browser-path <path>', 'Path to Chromium executable')
  .option('-e, --extension <paths...>', 'Unpacked extension directory paths to load')
  .option('--port <number>', 'CDP remote debugging port', (v) => parseInt(v, 10))
  .option('--headless', 'Launch in headless mode', false)
  .option('-o, --out-dir <path>', 'Output directory for run artifacts')
  .action(async (opts) => {
    const runId = generateRunId('browser-launch');
    const outDir = await ensureOutputDir(opts.outDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'BROWSER LAUNCH RUN LOG',
    });

    try {
      logger.stage('launch', 'Launching browser', {
        url: opts.url,
        profileDir: opts.profileDir,
        port: opts.port,
        extensions: opts.extension,
        headless: opts.headless,
      });

      console.log(pc.bold(pc.cyan('\n=== Launching Browser ===\n')));
      console.log(`${pc.bold('URL:')}          ${opts.url}`);
      console.log(`${pc.bold('Profile:')}      ${opts.profileDir}`);
      if (opts.port) console.log(`${pc.bold('CDP Port:')}     ${opts.port}`);
      if (opts.extension?.length) console.log(`${pc.bold('Extensions:')}   ${opts.extension.join(', ')}`);

      const { browser, page, executablePath, userDataDir } = await launchBrowser({
        url: opts.url,
        profileDir: opts.profileDir,
        executablePath: opts.browserPath,
        extensions: opts.extension,
        remoteDebuggingPort: opts.port,
        headless: opts.headless,
      });

      logger.info('Browser launched', { executablePath, userDataDir });

      console.log(pc.green('\n✓ Browser launched successfully!'));
      console.log(`${pc.dim('  Executable: ')}${executablePath}`);
      console.log(`${pc.dim('  User Data:  ')}${userDataDir}`);
      console.log(pc.yellow('\nBrowser session is active. Press Ctrl+C in this terminal to close.\n'));

      // Keep process running until browser disconnects
      await new Promise<void>((resolve) => {
        browser.on('disconnected', () => {
          logger.info('Browser disconnected');
          console.log(pc.dim('Browser closed by user.'));
          resolve();
        });
      });
    } catch (err: any) {
      logger.error('Browser launch failed', err);
      console.error(pc.red(`\nLaunch failed: ${err.message}`));
      process.exit(1);
    } finally {
      await logger.close();
    }
  });

/**
 * Command: screenshot
 */
program
  .command('screenshot')
  .description('Navigate to a URL and capture full-page, element, or clip screenshot')
  .requiredOption('-u, --url <url>', 'Target URL to capture')
  .option('-o, --output <path>', 'Output image file path (relative to artifact dir)', 'screenshot.png')
  .option('--full-page', 'Capture full scrollable page', false)
  .option('-s, --selector <css>', 'Capture specific element matching CSS selector')
  .option('--clip <coords>', 'Clip region as x,y,width,height (e.g. 0,0,800,600)')
  .option('--format <type>', 'Image format (png, jpeg, webp)', 'png')
  .option('--quality <number>', 'Image quality (1-100) for jpeg/webp', (v) => parseInt(v, 10))
  .option('-p, --profile-dir <path>', 'Persistent profile directory', './.chromium-profile')
  .option('-b, --browser-path <path>', 'Path to Chromium executable')
  .option('--no-headless', 'Show browser window during capture')
  .option('--artifacts-dir <path>', 'Output directory for run artifacts (default: artifacts/screenshot-<runId>/)')
  .action(async (opts) => {
    const runId = generateRunId('screenshot');
    const outDir = await ensureOutputDir(opts.artifactsDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'BROWSER SCREENSHOT RUN LOG',
    });

    try {
      logger.stage('screenshot', 'Capturing screenshot', {
        url: opts.url,
        fullPage: opts.fullPage,
        selector: opts.selector,
        format: opts.format,
      });

      console.log(pc.bold(pc.cyan('\n=== Capturing Screenshot ===\n')));
      console.log(`${pc.bold('Target URL:')}    ${opts.url}`);
      console.log(`${pc.bold('Format:')}        ${opts.format}`);
      console.log(`${pc.bold('Artifacts Dir:')} ${outDir}`);

      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (opts.clip) {
        const parts = opts.clip.split(',').map((p: string) => parseFloat(p.trim()));
        if (parts.length === 4 && parts.every((n: number) => !isNaN(n))) {
          clip = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        } else {
          logger.error('Invalid clip coordinates', undefined, { clip: opts.clip });
          console.error(pc.red('Error: --clip must be formatted as x,y,width,height (e.g. 0,0,800,600)'));
          process.exit(1);
        }
      }

      const { browser, page } = await launchBrowser({
        url: opts.url,
        profileDir: opts.profileDir,
        executablePath: opts.browserPath,
        headless: opts.headless,
      });

      try {
        logger.info('Waiting for page network idle');
        console.log(pc.dim('Waiting for page network idle...'));
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        // Place screenshot in artifact directory
        const screenshotPath = path.join(outDir, opts.output);
        const result = await takeScreenshot(page, {
          path: screenshotPath,
          fullPage: opts.fullPage,
          selector: opts.selector,
          clip,
          type: opts.format,
          quality: opts.quality,
        });

        logger.info('Screenshot captured', { path: result.path, sizeBytes: result.buffer.length });

        console.log(pc.green(`\n✓ Screenshot saved successfully: ${result.path}`));
        console.log(`${pc.dim('  Size: ')}${Math.round(result.buffer.length / 1024)} KB\n`);
      } finally {
        await browser.close().catch(() => {});
      }

      console.log(pc.dim(`Run artifacts: ${outDir}`));
      console.log(pc.dim(`  run.log   - Human-readable log`));
      console.log(pc.dim(`  run.jsonl - Structured JSON-lines log\n`));
    } catch (err: any) {
      logger.error('Screenshot capture failed', err);
      console.error(pc.red(`\nScreenshot capture failed: ${err.message}`));
      process.exit(1);
    } finally {
      await logger.close();
    }
  });

/**
 * Command: export-cookies
 */
program
  .command('export-cookies')
  .description('Export Netscape cookies from active Chromium profile')
  .option('-u, --url <url>', 'Target URL for session', 'https://www.youtube.com')
  .option('-o, --output <path>', 'Destination cookies.txt file path (relative to artifact dir)', './cookies.txt')
  .option('-d, --domain <domains...>', 'Filter specific cookie domains (e.g. youtube.com google.com)')
  .option('--validate-youtube', 'Validate YouTube authentication tokens', false)
  .option('-p, --profile-dir <path>', 'Persistent profile directory', './.chromium-profile')
  .option('-b, --browser-path <path>', 'Path to Chromium executable')
  .option('--headless', 'Run headless without UI', false)
  .option('--artifacts-dir <path>', 'Output directory for run artifacts (default: artifacts/browser-cookies-<runId>/)')
  .action(async (opts) => {
    const runId = generateRunId('browser-cookies');
    const outDir = await ensureOutputDir(opts.artifactsDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'BROWSER COOKIE EXPORT RUN LOG',
    });

    try {
      logger.stage('export-cookies', 'Exporting browser cookies', {
        url: opts.url,
        domains: opts.domain,
        validateYouTube: opts.validateYoutube,
      });

      console.log(pc.bold(pc.cyan('\n=== Exporting Browser Cookies ===\n')));
      console.log(`${pc.bold('Artifacts Dir:')}  ${outDir}`);
      console.log(`${pc.bold('Profile Dir:')}    ${opts.profileDir}`);
      if (opts.domain?.length) console.log(`${pc.bold('Domain Filters:')} ${opts.domain.join(', ')}`);

      const { browser, page } = await launchBrowser({
        url: opts.url,
        profileDir: opts.profileDir,
        executablePath: opts.browserPath,
        headless: opts.headless,
      });

      try {
        // Place cookies in artifact directory
        const cookiePath = path.join(outDir, opts.output);
        const result = await exportCookies(page, {
          outputPath: cookiePath,
          domains: opts.domain,
          validateYouTube: opts.validateYoutube,
        });

        logger.info('Cookies exported', {
          count: result.cookies.length,
          path: result.savedPath,
          youTubeValidation: result.youTubeValidation,
        });

        console.log(pc.green(`\n✓ Exported ${result.cookies.length} cookies to: ${result.savedPath}`));

        if (opts.validateYoutube && result.youTubeValidation) {
          const auth = result.youTubeValidation;
          console.log(`\n${pc.bold('YouTube Auth Check:')} ${auth.valid ? pc.green('Valid') : pc.yellow('Not Logged In')}`);
          if (auth.foundAuthCookies.length > 0) {
            console.log(`  Found Auth Cookies: ${auth.foundAuthCookies.join(', ')}`);
          }
          if (auth.missingAuthCookies.length > 0) {
            console.log(`  Missing Auth Cookies: ${auth.missingAuthCookies.join(', ')}`);
          }
        }
        console.log('');
      } finally {
        await browser.close().catch(() => {});
      }

      console.log(pc.dim(`Run artifacts: ${outDir}`));
      console.log(pc.dim(`  run.log     - Human-readable log`));
      console.log(pc.dim(`  run.jsonl   - Structured JSON-lines log`));
      console.log(pc.dim(`  cookies.txt - Exported cookies\n`));
    } catch (err: any) {
      logger.error('Cookie export failed', err);
      console.error(pc.red(`\nCookie export failed: ${err.message}`));
      process.exit(1);
    } finally {
      await logger.close();
    }
  });

program.parse(process.argv);
