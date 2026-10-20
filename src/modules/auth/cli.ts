#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { launchBrowser } from '../../libs/browser/launcher.js';
import { resolveProfileDir } from '../../utils/browser.js';
import { ensureXLogin, isXLoggedIn } from './auth.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:auth')
    .description('X Auth Module: Verify or perform automated sign-in on X (x.com)')
    .option('--headed', 'Run browser in headful mode for visible interaction', true)
    .option('--headless', 'Force browser headless mode', false)
    .option('--profile-dir <path>', 'Custom profile directory')
    .action(async (opts) => {
      const profileDir = resolveProfileDir(opts.profileDir);
      console.log(pc.cyan(`\n🔑 Checking X.com authentication using profile: ${profileDir}`));

      const session = await launchBrowser({
        profileDir,
        headless: opts.headless,
        reuseSession: true,
        keepAlive: true,
      });

      try {
        const alreadyIn = await isXLoggedIn(session.context, session.page);
        if (alreadyIn) {
          console.log(pc.green('✓ X.com session is already authenticated!'));
        } else {
          console.log(pc.yellow('Not currently logged in. Performing login...'));
          await ensureXLogin(session.page);
          console.log(pc.green('✓ X.com login succeeded!'));
        }
        await exitAfterFlush(0, 'module:auth');
      } catch (err: any) {
        console.error(pc.red(`❌ X.com auth failed: ${err.message}`));
        await exitAfterFlush(1, 'module:auth');
      }
    });

  await program.parseAsync(process.argv);
}

if (process.argv[1] && process.argv[1].includes('auth/cli')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
