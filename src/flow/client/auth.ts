/**
 * Login and authentication flows for FlowClient.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { launchBrowser, releaseBrowser } from '../../browser/index.js';
import { exportCookies } from '../../browser/actions.js';
import {
  attemptGoogleAutoSignIn,
  detectHumanVerificationOrCaptcha,
  notifyCaptchaWebhook,
} from '../../browser/login-helper.js';
import { getProjectRootDir } from '../../utils/browser.js';
import { FLOW_HOME_URL } from '../config.js';
import {
  dismissCookieBanner,
  hasSignInPrompt,
  scrollToBottomToLoadAll,
  triggerFlowSignIn,
  tryEnterWorkspaceFromAbout,
} from '../dom.js';
import type { ClientContext } from './types.js';

export async function login(
  ctx: ClientContext,
  options?: {
    profileDir?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
  }
): Promise<{ loggedIn: boolean }> {
  const profileDir = options?.profileDir ? path.resolve(options.profileDir) : ctx.config.profileDir;

  console.log(pc.cyan(`\n[flow-cli] Launching browser for Google Flow authentication...`));
  console.log(pc.gray(`Profile directory: ${profileDir}`));

  const { browser, page } = await launchBrowser({
    profileDir,
    headless: false,
    url: FLOW_HOME_URL,
    stealth: false,
    keepAlive: true,
    reuseSession: true,
    viewport: options?.viewport,
  });

  try {
    if (!page.url().includes('flow.google.com')) {
      await page.goto(FLOW_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }
    await dismissCookieBanner(page).catch(() => {});
    if (page.url().includes('/about')) {
      await tryEnterWorkspaceFromAbout(page).catch(() => {});
    }

    let unauthenticated = await hasSignInPrompt(page);
    if (unauthenticated) {
      await page.bringToFront().catch(() => {});
      console.log(pc.yellow(`\n[action required] Google Flow authentication required.`));
      console.log(pc.cyan(`🤖 Attempting automated Google Flow sign-in...`));

      // If currently on Flow landing page, click Sign in button to transition to accounts.google.com
      if (!page.url().includes('accounts.google.com')) {
        await triggerFlowSignIn(page).catch(() => {});
      }

      // If navigated to Google Login, attempt automated sign-in immediately
      if (page.url().includes('accounts.google.com')) {
        await attemptGoogleAutoSignIn(page).catch((e) => {
          console.log(pc.yellow(`  [flow-login] Warning: Automated sign-in failed: ${e?.message || e}`));
        });
      }

      const pollIntervalMs = 2000;
      const maxWaitMs = 300_000;
      const startTime = Date.now();
      let enterPressed = false;
      let rl: readline.Interface | null = null;
      let lastAutoSignInAttempt = 0;
      let lastSignInClickAttempt = 0;

      if (input.isTTY) {
        rl = readline.createInterface({ input, output });
        rl.question(pc.bold('\nPress [ENTER] here once you have finished signing in: ')).then(() => {
          enterPressed = true;
        }).catch(() => {});
      } else {
        console.log(pc.gray(`Non-interactive terminal: polling browser for sign-in completion (up to 300s)...`));
      }

      try {
        while (Date.now() - startTime < maxWaitMs) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          const currentUrl = page.url();

          // If we are on accounts.google.com, periodically attempt automated sign-in
          if (currentUrl.includes('accounts.google.com') && Date.now() - lastAutoSignInAttempt > 5000) {
            lastAutoSignInAttempt = Date.now();
            const autoRes = await attemptGoogleAutoSignIn(page).catch(() => null);
            if (autoRes?.captchaDetected) {
              // CAPTCHA is already notified inside notifyCaptchaWebhook
            } else {
              const captchaCheck = await detectHumanVerificationOrCaptcha(page);
              if (captchaCheck.detected) {
                await notifyCaptchaWebhook({ url: page.url(), reason: captchaCheck.reason });
              }
            }
          }

          // If on Flow landing page and still unauthenticated, periodically click Sign In
          if (currentUrl.includes('flow.google.com') && Date.now() - lastSignInClickAttempt > 6000) {
            const stillPrompt = await hasSignInPrompt(page).catch(() => true);
            if (stillPrompt) {
              lastSignInClickAttempt = Date.now();
              await triggerFlowSignIn(page).catch(() => {});
            } else {
              unauthenticated = false;
              break;
            }
          }

          if (currentUrl.includes('flow.google.com') && !currentUrl.includes('/about') && !currentUrl.includes('/signin')) {
            const stillPrompt = await hasSignInPrompt(page).catch(() => true);
            if (!stillPrompt) {
              unauthenticated = false;
              break;
            }
          }
          if (enterPressed) break;
        }
      } finally {
        if (rl) rl.close();
      }
    }

    // Re-verify login status
    if (unauthenticated) {
      await page.goto(FLOW_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await dismissCookieBanner(page).catch(() => {});
      if (page.url().includes('/about')) {
        await tryEnterWorkspaceFromAbout(page).catch(() => {});
      }
      unauthenticated = await hasSignInPrompt(page);
    }

    if (unauthenticated) {
      throw new Error('Google Flow sign-in was not completed. Please run "flow-cli login" and try again.');
    }

    console.log(pc.green(`\n✓ Google Flow authentication session verified and saved!`));
    await scrollToBottomToLoadAll(page).catch(() => {});

    // Persist the latest authenticated cookies directly to project cookies.txt
    try {
      const targetCookiePath = path.join(getProjectRootDir(), 'cookies.txt');
      await exportCookies(page, {
        outputPath: targetCookiePath,
        domains: ['google.com', 'flow.google.com', 'youtube.com'],
      });
      console.log(pc.gray(`[flow-cli] Synced active session tokens to ${targetCookiePath}`));
    } catch (err: any) {
      console.warn(pc.yellow(`[flow-cli] Failed to auto-sync cookies to file: ${err.message}`));
    }

    return { loggedIn: true };
  } finally {
    await releaseBrowser(browser, { keepAlive: true, profileDir });
  }
}
