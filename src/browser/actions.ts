/**
 * Reusable High-Level Page Actions: Navigation, Human Typing, Clicks, and Cookie Export.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import {
  formatCookiesToNetscape,
  saveCookiesToFile,
  validateYouTubeAuthCookies,
  type CDPCookie,
} from '../utils/cookies.js';
import { createCDPSession, getAllCookiesViaCDP } from './cdp.js';
import type {
  ClickOptions,
  CookieExportOptions,
  NavigateOptions,
  TypeOptions,
} from './types.js';

/**
 * Navigates a page to a URL with configurable wait condition and error resilience.
 */
export async function navigate(
  page: Page,
  url: string,
  options: NavigateOptions = {}
): Promise<void> {
  // Puppeteer's networkidle0/networkidle2 both map onto playwright's 'networkidle'.
  const requested = options.waitUntil || 'domcontentloaded';
  const waitUntil =
    requested === 'networkidle0' || requested === 'networkidle2' ? 'networkidle' : requested;
  const timeout = options.timeout ?? 45000;
  const referer = options.referer;

  await page.goto(url, {
    waitUntil,
    timeout,
    referer,
  });
}

/**
 * Clicks a page element with optional visibility waiting and configurable mouse buttons.
 */
export async function click(
  page: Page,
  selector: string,
  options: ClickOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 15000;
  if (options.waitForSelector !== false) {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
  }

  await page.click(selector, {
    delay: options.delay,
    button: options.button || 'left',
    clickCount: options.clickCount || 1,
  });
}

/**
 * Types text into an element with human-like jitter delays to mitigate anti-bot heuristic detection.
 */
export async function type(
  page: Page,
  selector: string,
  text: string,
  options: TypeOptions = {}
): Promise<void> {
  await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });

  if (options.clear) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
  } else {
    await page.focus(selector);
  }

  const humanize = options.humanize !== false;
  const minDelay = options.minDelay ?? 25;
  const maxDelay = options.maxDelay ?? 95;

  if (humanize) {
    for (const char of text) {
      const jitter = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await page.keyboard.type(char, { delay: jitter });
    }
  } else {
    await page.type(selector, text, { delay: options.delay ?? 30 });
  }
}

/**
 * Waits for a specific duration in ms, a CSS selector, or an in-page predicate function.
 */
export async function wait(
  page: Page,
  target: string | number | (() => boolean),
  options: { timeout?: number } = {}
): Promise<void> {
  if (typeof target === 'number') {
    await new Promise((resolve) => setTimeout(resolve, target));
  } else if (typeof target === 'string') {
    await page.waitForSelector(target, { timeout: options.timeout ?? 30000 });
  } else if (typeof target === 'function') {
    await page.waitForFunction(target, { timeout: options.timeout ?? 30000 });
  }
}

/**
 * Evaluates JavaScript within the page context and returns the typed result.
 */
export async function evaluate<R = any>(
  page: Page,
  pageFunction: (...args: any[]) => R,
  ...args: any[]
): Promise<R> {
  return (await page.evaluate(pageFunction as any, ...args)) as R;
}

/**
 * Exports cookies from an active Page or CDPSession into Netscape format compatible with yt-dlp.
 */
export async function exportCookies(
  pageOrClient: Page | CDPSession,
  options: CookieExportOptions = {}
): Promise<{
  cookies: CDPCookie[];
  netscapeText: string;
  savedPath?: string;
  youTubeValidation?: ReturnType<typeof validateYouTubeAuthCookies>;
}> {
  let client: CDPSession;
  // Playwright Page exposes context(); CDPSession does not — discriminates the union.
  if ('context' in pageOrClient) {
    client = await createCDPSession(pageOrClient);
  } else {
    client = pageOrClient;
  }

  const allCookies = await getAllCookiesViaCDP(client);

  let filteredCookies = allCookies;
  if (options.domains && options.domains.length > 0) {
    const domainFilters = options.domains.map((d) => d.toLowerCase());
    filteredCookies = allCookies.filter((c) => {
      const cookieDomain = c.domain.toLowerCase();
      return domainFilters.some((f) => cookieDomain.includes(f));
    });
  }

  const netscapeText = formatCookiesToNetscape(filteredCookies);

  let savedPath: string | undefined;
  if (options.outputPath) {
    savedPath = path.resolve(options.outputPath);
    // Merging write: an export captured before YouTube lazily issued
    // LOGIN_INFO must not wipe still-valid auth tokens from the old file.
    await saveCookiesToFile(savedPath, filteredCookies);
  }

  let youTubeValidation: ReturnType<typeof validateYouTubeAuthCookies> | undefined;
  if (options.validateYouTube) {
    youTubeValidation = validateYouTubeAuthCookies(allCookies);
  }

  return {
    cookies: filteredCookies,
    netscapeText,
    savedPath,
    youTubeValidation,
  };
}
