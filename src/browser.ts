/**
 * Backward-compatible facade for Browser Automation and YouTube Cookie Refresh.
 *
 * Delegates core browser mechanics to the modular src/browser/ engine.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import type { Browser, Page } from 'playwright-core';
import {
  launchBrowser,
  closeBrowserSession,
  resolveChromiumPath,
  createCDPSession,
  getAllCookiesViaCDP,
  type BrowserLaunchOptions,
  type CDPCookie,
} from './browser/index.js';
import { validateYouTubeAuthCookies } from './cookie-formatter.js';
import { sendMsg } from './utils/send_msg.js';
import {
  attemptGoogleAutoSignIn,
  detectHumanVerificationOrCaptcha,
  notifyCaptchaWebhook,
} from './browser/login-helper.js';

// Re-export all browser engine utilities for backward compatibility
export * from './browser/index.js';
export { attemptGoogleAutoSignIn, detectHumanVerificationOrCaptcha, notifyCaptchaWebhook } from './browser/login-helper.js';
export type { BrowserLaunchOptions };

/**
 * Auto-detects local Ungoogled Chromium / Chromium executable path on macOS / Linux.
 */
export async function detectChromiumPath(): Promise<string> {
  return await resolveChromiumPath();
}

/**
 * Launches Chromium with a persistent profile via CDP and extracts YouTube cookies.
 */
export async function refreshCookiesViaBrowser(
  options: BrowserLaunchOptions = {}
): Promise<CDPCookie[]> {
  const profileDir = path.resolve(options.userDataDir || options.profileDir || './.chromium-profile');
  const targetUrl = options.url || 'https://www.youtube.com';
  const pollIntervalMs = options.pollIntervalMs || 2000;

  console.log(pc.cyan(`\n🚀 Launching Ungoogled Chromium via CDP...`));
  console.log(pc.dim(`  Profile Dir: ${profileDir}`));

  await fs.mkdir(profileDir, { recursive: true });

  let browser: Browser | null = null;
  let rl: readline.Interface | null = null;
  let wasReused = false;

  try {
    const launched = await launchBrowser({
      ...options,
      url: targetUrl,
      profileDir,
      headless: false,
    });

    browser = launched.browser;
    wasReused = !!launched.reused;
    const page: Page = launched.page;

    console.log(pc.dim(`  Executable: ${launched.executablePath}`));

    const client = await createCDPSession(page);

    const readAuthState = async () => {
      const currentCookies = await getAllCookiesViaCDP(client);
      return { cookies: currentCookies, auth: validateYouTubeAuthCookies(currentCookies) };
    };

    // LOGIN_INFO is issued lazily by YouTube (rotated per page load). A single
    // navigation to the account-scoped feed forces (re)issuance within seconds
    // whenever the account session itself is still alive.
    const nudgeLoginInfoIssuance = async (): Promise<void> => {
      await page
        .goto('https://www.youtube.com/feed/history', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        })
        .catch(() => {});
    };

    // 1. Fast path: persistent profile already carries a fully valid session.
    const initial = await readAuthState();
    if (initial.auth.valid) {
      console.log(
        pc.green(
          `✓ Already logged in with persistent profile! (Found: ${initial.auth.foundAuthCookies.join(', ')})`
        )
      );
      await new Promise((r) => setTimeout(r, 2000));
      return await getAllCookiesViaCDP(client);
    }

    // 2. Silent self-heal: the profile session is frequently still alive while
    //    LOGIN_INFO is mid-rotation (Google rotates/revokes it aggressively).
    //    Force re-issuance and re-check BEFORE bothering the user with a login
    //    prompt — this removes most repeated manual logins.
    console.log(
      pc.yellow(
        '\n⚠ LOGIN_INFO missing/expired in browser profile — attempting silent session heal...'
      )
    );
    await nudgeLoginInfoIssuance();
    let healed = false;
    for (let i = 0; i < 15 && browser.isConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const cur = await readAuthState().catch(() => null);
      if (cur?.auth.valid) {
        healed = true;
        break;
      }
    }
    if (healed) {
      console.log(pc.green('✓ Session healed — LOGIN_INFO re-issued without manual login.'));
      await new Promise((r) => setTimeout(r, 1500));
      return await getAllCookiesViaCDP(client);
    }
    console.log(pc.yellow('Silent heal failed — profile session is genuinely logged out.'));

    // 3. Automated or manual login flow.
    console.log(pc.yellow('\n🔑 YouTube login required!'));
    console.log(
      pc.bold(
        pc.cyan(
          '👉 Automated sign-in will attempt to log in using GOOGLE_LOGIN_PWD.\n' +
            '   If CAPTCHA or 2FA verification appears, you can complete it in the opened Chromium window.\n' +
            '   The CLI will automatically detect when login succeeds,\n' +
            '   or you can press [Enter] in this terminal when finished.'
        )
      )
    );

    // Attempt automated Google / YouTube sign in
    const autoSignInPromise = attemptGoogleAutoSignIn(page).catch((e) => {
      console.log(pc.yellow(`  [auto-signin] Warning: Automated sign-in failed: ${e?.message || e}`));
      return null;
    });

    // Set up manual Enter listener
    let manualTriggered = false;
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const manualPromise = new Promise<void>((resolve) => {
      rl?.on('line', () => {
        manualTriggered = true;
        resolve();
      });
    });

    // Polling loop to detect login. STRICT detection: the avatar button alone
    // is NOT sufficient — LOGIN_INFO must be present. It is issued lazily, so
    // when the avatar is already visible but LOGIN_INFO has not arrived yet,
    // nudge YouTube via a navigation and keep polling instead of exporting an
    // incomplete cookie set.
    let loginDetected = false;
    let lastNudgeAt = 0;
    let captchaAlertSent = false;
    let lastCaptchaCheckAt = 0;
    const loginDeadline = Date.now() + 10 * 60 * 1000;
    const pollPromise = new Promise<void>(async (resolve) => {
      while (!loginDetected && !manualTriggered && browser?.isConnected() && Date.now() < loginDeadline) {
        try {
          const { auth } = await readAuthState();

          if (auth.valid) {
            console.log(pc.green('\n✓ Login detected successfully!'));
            loginDetected = true;
            console.log(pc.dim('  Synchronizing session tokens...'));
            await new Promise((r) => setTimeout(r, 3000));
            resolve();
            return;
          }

          // Check for CAPTCHA / human verification during polling
          if (!captchaAlertSent && Date.now() - lastCaptchaCheckAt > 5000) {
            lastCaptchaCheckAt = Date.now();
            const captchaCheck = await detectHumanVerificationOrCaptcha(page);
            if (captchaCheck.detected) {
              captchaAlertSent = true;
              await notifyCaptchaWebhook({ url: page.url(), reason: captchaCheck.reason });
            }
          }

          // Avatar visible but LOGIN_INFO not issued yet — nudge issuance.
          const avatar = await page.$('#avatar-btn, ytd-topbar-menu-button-renderer img').catch(() => null);
          if (avatar && Date.now() - lastNudgeAt > 10000) {
            lastNudgeAt = Date.now();
            await nudgeLoginInfoIssuance();
          }
        } catch {
          if (!browser?.isConnected()) break;
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      resolve();
    });

    await Promise.race([pollPromise, manualPromise]);
    await autoSignInPromise.catch(() => {});

    rl.close();
    rl = null;

    console.log(pc.cyan('📥 Exporting session cookies via CDP...'));
    const allCookies = await getAllCookiesViaCDP(client);

    // Filter relevant cookies (youtube and google domains)
    const ytAndGoogleCookies = allCookies.filter((c) => {
      const d = c.domain.toLowerCase();
      return (
        d.includes('youtube.com') ||
        d.includes('google.com') ||
        d.includes('googlevideo.com') ||
        d.includes('ytimg.com')
      );
    });

    console.log(
      pc.green(
        `✓ Retrieved ${ytAndGoogleCookies.length} YouTube/Google cookies (${allCookies.length} total in browser).`
      )
    );

    return ytAndGoogleCookies.length > 0 ? ytAndGoogleCookies : allCookies;
  } finally {
    if (rl) {
      rl.close();
    }
    if (browser) {
      if (wasReused) {
        console.log(pc.dim('Disconnecting from reused browser session...'));
        try {
          // For a CDP-connected browser this only drops the connection,
          // leaving the detached Chromium running.
          await browser.close();
        } catch {
          // Ignore disconnect error
        }
      } else {
        console.log(pc.dim('Closing browser session...'));
        try {
          await closeBrowserSession({ browser, profileDir });
        } catch {
          // Ignore close error
        }
      }
    }
  }
}
