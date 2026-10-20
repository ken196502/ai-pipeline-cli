import type { Page, BrowserContext } from 'playwright-core';
import pc from 'picocolors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from '../../utils/env.js';
import { getProjectRootDir } from '../../utils/browser.js';
import type { XLoginOptions, XAuthStatus } from './contracts.js';

/**
 * Hydrates X.com cookies from x_cookies.json if available.
 */
export async function hydrateXCookiesFromDisk(context: BrowserContext): Promise<boolean> {
  try {
    const cookieFile = path.join(getProjectRootDir(), 'x_cookies.json');
    let content = await fs.readFile(cookieFile, 'utf-8').catch(() => null);
    if (!content) {
      const fallbackFile = path.resolve(getProjectRootDir(), '../VideoGen/x_cookies.json');
      content = await fs.readFile(fallbackFile, 'utf-8').catch(() => null);
    }
    if (!content) return false;
    const cookies = JSON.parse(content);
    if (Array.isArray(cookies) && cookies.length > 0) {
      const playwrightCookies = cookies.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: Boolean(c.httpOnly),
        sameSite: 'Lax' as const,
      }));
      await context.addCookies(playwrightCookies);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Checks if the browser session already has valid X.com / Twitter.com authentication.
 */
export async function isXLoggedIn(context: BrowserContext, page?: Page): Promise<boolean> {
  try {
    const cookies = await context.cookies(['https://x.com', 'https://twitter.com']);
    const hasAuthToken = cookies.some((c) => c.name === 'auth_token' && c.value && c.value.length > 5);
    if (hasAuthToken) return true;

    // Try hydrating from disk if not present in memory
    const hydrated = await hydrateXCookiesFromDisk(context);
    if (hydrated) {
      const refreshedCookies = await context.cookies(['https://x.com', 'https://twitter.com']);
      if (refreshedCookies.some((c) => c.name === 'auth_token' && c.value && c.value.length > 5)) {
        return true;
      }
    }

    if (page) {
      const currentUrl = page.url();
      if (currentUrl.includes('x.com') || currentUrl.includes('twitter.com')) {
        const loggedInIndicator = await page.$(
          '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], a[href="/home"]'
        );
        if (loggedInIndicator) return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Ensures user is logged in to X (x.com), using credentials from process.env (X_USERNAME, X_PWD).
 * Reuses the persistent Chromium session and cookies.
 */
export async function ensureXLogin(
  page: Page,
  options: XLoginOptions = {}
): Promise<boolean> {
  loadEnvFile();

  const username = options.username || process.env.X_USERNAME?.trim();
  const password = options.password || process.env.X_PWD?.trim();

  const report = (msg: string) => {
    console.log(pc.cyan(`[x-login] ${msg}`));
    options.onProgress?.(msg);
  };

  report('Checking existing X login session in persistent profile...');
  const loggedIn = await isXLoggedIn(page.context(), page);
  if (loggedIn) {
    report('Already authenticated on X (auth_token found).');
    return true;
  }

  if (!username || !password) {
    throw new Error(
      'Missing X credentials. Please configure X_USERNAME and X_PWD in .env or environment variables.'
    );
  }

  report(`Initiating automated sign-in on X for user: ${username}`);
  await page.goto('https://x.com/i/flow/login', {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs ?? 30_000,
  }).catch(() => {});

  await page.waitForTimeout(3000);

  // Check if we got redirected to home directly
  if (await isXLoggedIn(page.context(), page)) {
    report('Landed on home; session active.');
    return true;
  }

  // 1. Enter username / email / phone
  const usernameSelector = 'input[autocomplete="username"], input[name="text"]';
  await page.waitForSelector(usernameSelector, { state: 'visible', timeout: 15_000 }).catch(() => {});
  const userInput = await page.$(usernameSelector);

  if (userInput && (await userInput.isVisible())) {
    report(`Entering username/handle: ${username}`);
    await userInput.fill(username);
    await page.waitForTimeout(500);

    const nextBtn = await page.$('button:has-text("Next"), role=button[name="Next"]');
    if (nextBtn) {
      await nextBtn.click();
    } else {
      await userInput.press('Enter');
    }
    await page.waitForTimeout(2500);
  }

  // Check for suspicious login / unusual activity prompt
  const verifySelector = 'input[data-testid="ocfEnterTextTextInput"]';
  const verifyInput = await page.$(verifySelector);
  if (verifyInput && (await verifyInput.isVisible())) {
    report('Handling additional identity check prompt...');
    await verifyInput.fill(username);
    await page.waitForTimeout(500);
    const nextBtn = await page.$('button:has-text("Next")');
    if (nextBtn) {
      await nextBtn.click();
    } else {
      await verifyInput.press('Enter');
    }
    await page.waitForTimeout(2500);
  }

  // 2. Enter password
  const pwdSelector = 'input[name="password"], input[type="password"]';
  await page.waitForSelector(pwdSelector, { state: 'visible', timeout: 15_000 }).catch(() => {});
  const pwdInput = await page.$(pwdSelector);

  if (pwdInput && (await pwdInput.isVisible())) {
    report('Entering password...');
    await pwdInput.fill(password);
    await page.waitForTimeout(500);

    const loginBtn = await page.$(
      'button[data-testid="LoginForm_Login_Button"], button:has-text("Log in"), button:has-text("Sign in")'
    );
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await pwdInput.press('Enter');
    }
    report('Submitted credentials, awaiting home page landing...');
  }

  // Wait for login settlement
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (await isXLoggedIn(page.context(), page)) {
      report('✓ Login successful! Persistent session active.');
      return true;
    }
    if (page.url().includes('/home')) {
      report('✓ Landed on /home. Session active.');
      return true;
    }
  }

  // Final check
  const success = await isXLoggedIn(page.context(), page);
  if (!success) {
    throw new Error(
      `Automated X login timed out or failed. Current URL: ${page.url()}`
    );
  }
  return true;
}
