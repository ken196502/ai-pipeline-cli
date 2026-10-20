/**
 * Chrome DevTools Protocol (CDP) Connection and Session Utilities.
 *
 * Implemented over playwright-core. All persistent-profile callers keep using
 * the same Ungoogled Chromium binary and profile directories as before — only
 * the driving library changed (puppeteer-core → playwright-core).
 */
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import type { CDPConnectOptions, CDPCookie } from './types.js';

/**
 * Ensures loopback hosts bypass the HTTP proxy for playwright connections.
 *
 * This machine exports `http_proxy`, and `NO_PROXY` uses the CIDR form
 * `127.0.0.0/8`, which playwright's proxy matcher does not understand — so
 * playwright would route CDP/BiDi loopback connections through the proxy and
 * fail with a 502. Appending plain `127.0.0.1` / `localhost` entries fixes the
 * match while leaving the original value intact for other tools.
 */
export function ensureLoopbackNoProxy(): void {
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const current = process.env[key];
    if (!current) {
      process.env[key] = 'localhost,127.0.0.1,::1';
      continue;
    }
    const items = current
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of ['localhost', '127.0.0.1', '::1']) {
      if (!items.includes(entry)) {
        items.push(entry);
      }
    }
    process.env[key] = items.join(',');
  }
}

/**
 * Connects to an active Chromium instance via Chrome DevTools Protocol.
 */
export async function connectViaCDP(options: CDPConnectOptions = {}): Promise<{
  browser: Browser;
  pages: Page[];
  activePage: Page;
}> {
  ensureLoopbackNoProxy();

  let endpointURL = options.browserURL;

  if (!endpointURL && !options.browserWSEndpoint) {
    const host = options.host || '127.0.0.1';
    const port = options.port || 9222;
    endpointURL = `http://${host}:${port}`;
  }

  if (options.browserWSEndpoint) {
    endpointURL = options.browserWSEndpoint;
  }

  const browser = await chromium.connectOverCDP({ endpointURL: endpointURL! });
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('CDP-connected browser reported no browser contexts');
  }
  const pages = listBrowserPages(browser);
  const activePage = pages.length > 0 ? pages[0] : await contexts[0].newPage();

  return {
    browser,
    pages,
    activePage,
  };
}

/**
 * Lists all regular pages across every browser context (playwright's Browser
 * has no pages() — contexts must be enumerated).
 */
export function listBrowserPages(browser: Browser): Page[] {
  return browser.contexts().flatMap((context) => context.pages());
}

/**
 * Creates a raw CDP Session attached to a Page (Chromium only).
 */
export async function createCDPSession(page: Page): Promise<CDPSession> {
  return await page.context().newCDPSession(page);
}

/**
 * Fetches all cookies across all domains using CDP Network domain.
 */
export async function getAllCookiesViaCDP(client: CDPSession): Promise<CDPCookie[]> {
  const result = (await client.send('Network.getAllCookies')) as {
    cookies: CDPCookie[];
  };
  return result.cookies || [];
}

/**
 * Sets one or more cookies in the browser cookie jar using CDP.
 */
export async function setCookiesViaCDP(
  client: CDPSession,
  cookies: Array<Partial<CDPCookie> & { name: string; value: string; domain: string }>
): Promise<void> {
  await client.send('Network.setCookies', { cookies });
}

/**
 * Clears all browser cookies using CDP.
 */
export async function clearCookiesViaCDP(client: CDPSession): Promise<void> {
  await client.send('Network.clearBrowserCookies');
}

/**
 * Sends an arbitrary CDP command to the session.
 */
export async function sendCDPCommand<T = any>(
  client: CDPSession,
  method: string,
  params?: Record<string, any>
): Promise<T> {
  return (await client.send(method as any, params)) as T;
}
