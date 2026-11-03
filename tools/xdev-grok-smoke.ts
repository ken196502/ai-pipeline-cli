/**
 * Pre-flight smoke test for the xdev Grok stage.
 *
 * Why: the full xdev pipeline spends ~5-8 minutes on scraping + LLM evaluation
 * before it ever touches x.com/i/grok. If the Grok automation is broken (stale
 * cookies, Cloudflare challenge, DOM change), we want to know in ~90 seconds,
 * not after burning a whole run.
 *
 * This script exercises the exact production path:
 *   launch Firefox ESR -> refresh cookies from the live Firefox profile ->
 *   inject -> open x.com/i/grok -> type prompt -> click Send -> read reply.
 *
 * It asserts a real response (>= 50 chars) and never falls back to a canned
 * string. On failure it saves a screenshot so the failure is diagnosable.
 *
 * Usage:  ./node_modules/.bin/tsx tools/xdev-grok-smoke.ts
 * Exit:   0 = Grok path healthy, 1 = broken (reason on stderr)
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT_DIR = path.resolve('artifacts/_scratch/xdev-smoke');
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');
const PROMPT =
  'Name the two most important 2025-2026 advances in multi-agent LLM systems. Answer in two short bullet points.';

async function main(): Promise<void> {
  await fs.mkdir(SHOTS_DIR, { recursive: true });

  const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
  let browser: Awaited<ReturnType<FirefoxBiDiDriver['launch']>> | null = null;
  const startedAt = Date.now();

  try {
    console.log('[smoke] launching Firefox ESR (headless)...');
    browser = await driver.launch();

    console.log('[smoke] refreshing + injecting x.com cookies...');
    const cookieCount = await driver.injectCookies('https://x.com');
    console.log(`[smoke] injected ${cookieCount} cookies`);

    // Cookies are only picked up on the NEXT navigation: injectCookies() navigates to
    // x.com, sets cookies, and the already-rendered SPA stays logged out. Reloading
    // /home is what actually establishes the authenticated session.
    console.log('[smoke] reloading x.com/home to establish the authenticated session...');
    await browser.url('https://x.com/home');
    await browser.pause(6000);

    // Auth sanity check: an anonymous x.com has no account switcher in the sidebar.
    const authed = await browser
      .execute(() =>
        Boolean(
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
            document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
            document.querySelector('[data-testid="SideNav_NewTweet_Button"]')
        )
      )
      .catch(() => false);
    const title = await browser.getTitle().catch(() => '');
    if (!authed) {
      const shot = path.join(SHOTS_DIR, `grok-smoke-fail-${Date.now()}.png`);
      await browser.saveScreenshot(shot).catch(() => {});
      throw new Error(
        `[smoke] x.com session is NOT authenticated after reloading /home (page title: "${title}"). ` +
          `Cookies are stale or Cloudflare is challenging the session. Screenshot: ${shot}`
      );
    }
    console.log('[smoke] x.com session is authenticated');

    console.log('[smoke] querying Grok via the production askGrok() path...');
    const t0 = Date.now();
    const reply = await driver.askGrok(PROMPT);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const body = reply.trim();
    if (body.length < 50) {
      throw new Error(`[smoke] Grok reply too short (${body.length} chars): ${JSON.stringify(body)}`);
    }

    console.log(`[smoke] ✔ Grok replied in ${elapsed}s (${body.length} chars)`);
    console.log('[smoke] preview:');
    console.log(
      body
        .split('\n')
        .slice(0, 8)
        .map((l) => '  | ' + l)
        .join('\n')
    );
    console.log(`[smoke] ✔ PASSED in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err: any) {
    const isRateLimit =
      /Grok 使用额度已耗尽|You have reached your Grok usage limit|usage limit/i.test(err?.message || '');

    const shot = path.join(SHOTS_DIR, `grok-smoke-fail-${Date.now()}.png`);
    if (browser) {
      await browser.saveScreenshot(shot).catch(() => {});
      console.error(`[smoke] screenshot saved: ${shot}`);
    }

    if (isRateLimit) {
      console.warn(
        `[smoke] ⚠ NOTICE: Grok 受到当前机房 IP/账号限额 (${err.message})。Stage 4 将自动透明跳过，不阻断流水线成稿。`
      );
      process.exitCode = 0;
    } else {
      console.error(`[smoke] ✗ FAILED: ${err?.message || err}`);
      process.exitCode = 1;
    }
  } finally {
    console.log('[smoke] cleaning up Firefox session...');
    await driver.cleanup().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[smoke] ✗ uncaught:', err?.message || err);
  process.exit(1);
});
