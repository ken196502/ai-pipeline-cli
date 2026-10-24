#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { launchBrowser } from '../../libs/browser/launcher.js';
import { resolveProfileDir } from '../../utils/browser.js';
import { ensureXLogin, isXLoggedIn, persistXCookiesToDisk } from './auth.js';
import { resetProfileFromSystemAndLogin } from './relogin.js';
import { exitAfterFlush } from '../../utils/shutdown.js';

async function main() {
  const program = new Command();
  program
    .name('module:auth')
    .description('X Auth Module: reset the profile from the system Chromium profile, launch a headed CDP browser and sign in')
    .option('--headed', 'Run browser in headful mode for visible interaction', true)
    .option('--headless', 'Force browser headless mode', false)
    .option('--profile-dir <path>', 'Custom profile directory')
    .option(
      '--reset-from-system',
      'Delete the persistent profile, copy the system Chromium profile, launch a headed CDP browser and sign in with credentials'
    )
    .option(
      '--password-store <store>',
      'Chromium password store used to decrypt the copied cookies (default: gnome-libsecret)',
      'gnome-libsecret'
    )
    .option(
      '--allow-recovery',
      'Allow the interactive manual-login recovery path when a verification blocker is detected',
      false
    )
    .action(async (opts) => {
      const profileDir = resolveProfileDir(opts.profileDir);
      const headless = Boolean(opts.headless);
      console.log(pc.cyan(`\n🔑 X auth using profile: ${profileDir}`));

      try {
        if (opts.resetFromSystem) {
          const session = await resetProfileFromSystemAndLogin({
            profileDir,
            headless,
            passwordStore: opts.passwordStore,
            onProgress: (m) => console.log(pc.gray(`  ${m}`)),
          });
          console.log(pc.green(`✓ X.com login succeeded! (page: ${session.page.url()})`));
        } else {
          const session = await launchBrowser({
            profileDir,
            headless,
            reuseSession: true,
            keepAlive: true,
            extraArgs: [`--password-store=${opts.passwordStore}`],
          });
          if (session.remoteDebuggingPort) {
            console.log(pc.gray(`      CDP endpoint: http://127.0.0.1:${session.remoteDebuggingPort}`));
          }

          if (await isXLoggedIn(session.context, session.page)) {
            console.log(pc.green('✓ X.com session is already authenticated!'));
            const file = await persistXCookiesToDisk(session.context).catch(() => null);
            if (file) console.log(pc.green(`✓ Persisted session cookies: ${file}`));
          } else {
            console.log(pc.yellow('Not currently logged in. Performing login...'));
            const result = await ensureXLogin(session.page, {
              profileDir,
              allowInteractiveRecovery: Boolean(opts.allowRecovery),
              onProgress: (m) => console.log(pc.gray(`  ${m}`)),
            });
            if (result.recovered) {
              console.log(pc.yellow(`↻ Interactive recovery was used (${result.reason || 'verification blocker'}).`));
            }
            console.log(pc.green(`✓ X.com login succeeded! (page: ${result.page.url()})`));
          }
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
