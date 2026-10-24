/**
 * Resilient DOM Locators, RPC Credit Inspection, and User Interaction Utilities for Google Flow.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import picocolors from 'picocolors';
import type { ElementHandle, Page } from 'playwright-core';
import { VIDEO_CREDIT_COST, RISK_RETRY_ATTEMPTS, RISK_RETRY_DELAY_MIN_SEC, RISK_RETRY_DELAY_MAX_SEC } from './config.js';
import { setClipboardVerified } from '../input/system-input.js';
import { STALE_EMULATION_DIVERGENCE_PX } from '../browser/launcher.js';
import type { FlowProjectItem } from './contracts.js';

export const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export interface ScrollToBottomOptions {
  stepPx?: number;
  delayMs?: number;
  maxScrolls?: number;
  timeoutMs?: number;
}

/**
 * Robustly scrolls the window and all scrollable containers on the page to the very bottom,
 * waiting for dynamic / lazy content to render, until no new content or scroll height appears.
 */
export async function scrollToBottomToLoadAll(
  page: Page,
  options?: ScrollToBottomOptions
): Promise<{ totalScrolls: number; finalHeight: number }> {
  const stepPx = options?.stepPx ?? 800;
  const delayMs = options?.delayMs ?? 400;
  const maxScrolls = options?.maxScrolls ?? 50;
  const timeoutMs = options?.timeoutMs ?? 30_000;

  const deadline = Date.now() + timeoutMs;
  let totalScrolls = 0;
  let stagnantCount = 0;
  let previousHeight = 0;

  // Locate the primary internal scrollable container (Flow renders its feed in
  // a <main> element, not the window). Returns null when the window itself scrolls.
  const findScrollContainer = async (): Promise<{ selector: string; cx: number; cy: number } | null> => {
    return await page.evaluate(() => {
      const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
      });
      // Prefer semantic containers; pick the one with the most scrollable content
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = scrollables[0];
      if (!target) return null;
      const tag = target.tagName.toLowerCase();
      const cls = (target.className && typeof target.className === 'string')
        ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      // Wheel events only scroll the element under the pointer — aim at the
      // container's center, clamped to the viewport.
      const rect = target.getBoundingClientRect();
      const cx = Math.min(Math.max(rect.x + rect.width / 2, 10), window.innerWidth - 10);
      const cy = Math.min(Math.max(rect.y + rect.height / 2, 10), window.innerHeight - 10);
      return { selector: `${tag}${cls}`, cx, cy };
    });
  };

  const jsScrollStep = async (step: number): Promise<void> => {
    await page.evaluate((s) => {
      const docHeight = Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      );
      const currentScrollY = window.scrollY || window.pageYOffset || 0;
      const clientH = window.innerHeight || document.documentElement?.clientHeight || 0;
      if (currentScrollY + clientH < docHeight) {
        window.scrollBy({ top: s, behavior: 'smooth' });
        window.dispatchEvent(new Event('scroll'));
      }
      const scrollableElements = Array.from(document.querySelectorAll('*')).filter((el) => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      for (const el of scrollableElements) {
        if (el.scrollTop + el.clientHeight < el.scrollHeight) {
          el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + s);
          el.dispatchEvent(new Event('scroll'));
        }
      }
    }, step);
  };

  const readScrollState = async (): Promise<{ st: number; sh: number; ch: number } | null> => {
    return await page.evaluate(() => {
      const docSh = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      const winSt = window.scrollY || window.pageYOffset || 0;
      const winCh = window.innerHeight || 0;
      if (docSh > winCh + 10) return { st: winSt, sh: docSh, ch: winCh };
      const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
      });
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = scrollables[0] as HTMLElement | undefined;
      if (!target) return { st: winSt, sh: docSh, ch: winCh };
      return { st: target.scrollTop, sh: target.scrollHeight, ch: target.clientHeight };
    });
  };

  while (Date.now() < deadline && totalScrolls < maxScrolls) {
    const before = await readScrollState();

    // Preferred path: trusted wheel input via CDP (real Input.dispatchMouseEvent).
    // Pure JS scrollBy/scrollTop assignments produce untrusted scroll events with
    // no matching input events — a signal reCAPTCHA Enterprise can detect.
    // The wheel must land on the scroll container itself: a wheel event only
    // scrolls the element under the pointer.
    const container = await findScrollContainer();
    let usedTrustedWheel = false;
    try {
      await page.mouse.move(container?.cx ?? 760, container?.cy ?? 400, { steps: 3 });
      await page.mouse.wheel(0, stepPx);
      usedTrustedWheel = true;
    } catch {
      // Wheel dispatch can time out when the page is busy (reCAPTCHA worker);
      // fall back to JS scrolling for this step.
    }

    // If the wheel moved nothing (pointer over a non-scrolling region), fall
    // back to JS scrolling for this step so the loop still makes progress.
    if (usedTrustedWheel) {
      await new Promise((r) => setTimeout(r, 100));
      const mid = await readScrollState();
      const progressed = before && mid ? mid.st > before.st : true;
      if (!progressed) await jsScrollStep(stepPx);
    } else {
      await jsScrollStep(stepPx);
    }

    // Randomized human-like pause between wheel ticks
    const jitter = delayMs + Math.floor(Math.random() * delayMs);
    await new Promise((r) => setTimeout(r, jitter));
    totalScrolls++;

    const after = await readScrollState();

    const maxHeight = Math.max(after?.sh ?? 0, before?.sh ?? 0);
    const atBottom = after ? after.st + after.ch >= after.sh - 5 : true;

    if (maxHeight === previousHeight) {
      stagnantCount++;
      if (stagnantCount >= 3 && atBottom) break;
    } else {
      stagnantCount = 0;
      previousHeight = maxHeight;
    }
  }

  const finalHeight = (await readScrollState())?.sh ?? 0;

  return { totalScrolls, finalHeight };
}

/**
 * Scans the current DOM to extract all displayed Google Flow project links and metadata.
 */
export async function extractDisplayedProjects(page: Page): Promise<FlowProjectItem[]> {
  const uuidRegexSource = UUID_REGEX.source;

  return await page.evaluate((uuidPattern) => {
    const regex = new RegExp(uuidPattern, 'i');
    const items: Array<{ projectId: string; url: string; title?: string }> = [];
    const seenIds = new Set<string>();

    // 1. Check all anchor tags linking to /project/<uuid>
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(regex);
      if (match) {
        const projectId = match[0];
        if (!seenIds.has(projectId)) {
          seenIds.add(projectId);

          // Find card title or text
          let heading = link.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], [class*="title" i], [class*="name" i]');
          if (!heading) {
            const card = link.closest('[role="listitem"], [role="article"], [class*="card" i], [class*="project" i]') || link.parentElement;
            heading = card?.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], [class*="title" i], [class*="name" i]') || null;
          }
          const text = (heading?.textContent || link.textContent || '').trim().replace(/\s+/g, ' ');
          const title = text && !text.toLowerCase().includes('http') ? text : undefined;

          const absoluteUrl = href.startsWith('http') ? href : `https://flow.google.com${href.startsWith('/') ? '' : '/'}${href}`;
          items.push({
            projectId,
            url: absoluteUrl,
            title,
          });
        }
      }
    }

    // 2. Check any element with data-project-id or aria attributes
    const candidateElements = Array.from(document.querySelectorAll('[data-project-id], [aria-label*="project" i]'));
    for (const el of candidateElements) {
      const idAttr = el.getAttribute('data-project-id') || el.getAttribute('aria-label') || '';
      const match = idAttr.match(regex);
      if (match) {
        const projectId = match[0];
        if (!seenIds.has(projectId)) {
          seenIds.add(projectId);
          const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
          const title = (heading?.textContent || el.getAttribute('aria-label') || '').trim();
          items.push({
            projectId,
            url: `https://flow.google.com/project/${projectId}`,
            title: title || undefined,
          });
        }
      }
    }

    return items;
  }, uuidRegexSource);
}

/**
 * Scrolls flow.google.com to the very bottom to trigger dynamic loading of all project cards,
 * then extracts and returns all displayed projects.
 */
export async function scrollToDisplayAllProjects(
  page: Page,
  options?: ScrollToBottomOptions
): Promise<FlowProjectItem[]> {
  let authError: string | null = null;
  const onResponse = (res: any) => {
    if (res.url().includes('flow.google.com') && (res.status() === 401 || res.status() === 403)) {
      authError = `Google Flow session expired (HTTP ${res.status()} on ${res.url()}). Please re-authenticate.`;
    }
  };

  page.on('response', onResponse);
  try {
    await scrollToBottomToLoadAll(page, options);
    if (authError) {
      throw new Error(authError);
    }
    return await extractDisplayedProjects(page);
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Extracts a project UUID from a URL or arbitrary text string.
 */
export function extractProjectId(value: string): string | null {
  return value.match(UUID_REGEX)?.[0] ?? null;
}

/**
 * Checks if the page is showing a Google sign-in prompt or unauthenticated state.
 */
export async function hasSignInPrompt(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes('accounts.google.com') || currentUrl.includes('ServiceLogin')) {
    return true;
  }

  // Dismiss any cookie consent banner that might be overlaying the UI
  await dismissCookieBanner(page).catch(() => {});

  if (currentUrl.includes('flow.google.com/about')) {
    // On the about landing page, try clicking into workspace before concluding unauthenticated
    await tryEnterWorkspaceFromAbout(page).catch(() => {});
    const updatedUrl = page.url();
    if (updatedUrl.includes('accounts.google.com') || updatedUrl.includes('ServiceLogin')) {
      return true;
    }
    if (updatedUrl.includes('flow.google.com') && !updatedUrl.includes('/about')) {
      return false;
    }
  }

  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    if (/sign in to google|choose an account|use your google account/i.test(text)) {
      return true;
    }
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return buttons.some((b) => {
      const label = (b.textContent || b.getAttribute('aria-label') || '').trim();
      return /^sign in$|^log in$/i.test(label);
    });
  });
}

/**
 * Waits for the "New project" or "Create project" button and clicks it.
 *
 * The Flow home page renders multiple create-style buttons: a promotional
 * "Start Creating" button (which navigates to the broken route
 * /404?reason=project) and the real "New project" card at the end of the
 * project list. Candidates are therefore filtered to visible, enabled
 * elements, prioritized (exact "new project" text first), and rotated:
 * a click that dead-ends on a non-project page triggers a recovery
 * navigation back to the home URL before trying the next candidate.
 */
export async function createNewProject(
  page: Page,
  timeoutMs: number = 20_000,
  options?: { homeUrl?: string }
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const homeUrl = options?.homeUrl;
  const PROJECT_URL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

  let authError: string | null = null;
  const onResponse = (res: any) => {
    if (res.url().includes('flow.google.com') && (res.status() === 401 || res.status() === 403)) {
      authError = `Google Flow session expired (HTTP ${res.status()} Unauthorized). Backend rejected request. Please re-authenticate via "flow-cli login".`;
    }
  };
  page.on('response', onResponse);

  try {
    // If already inside a project page, return immediately
    if (extractProjectId(page.url())) {
      return true;
    }

    // Try primary Playwright native click on "New project" button first
    const primaryBtn = page.locator('button:has-text("New project"), [role="button"]:has-text("New project")').first();
    const primaryExists = await primaryBtn.count().catch(() => 0);
    if (primaryExists > 0 && await primaryBtn.isVisible().catch(() => false)) {
      await primaryBtn.click({ timeout: 5_000 }).catch(() => {});
      try {
        await page.waitForFunction(
          (re: string) => new RegExp(re, 'i').test(window.location.href),
          PROJECT_URL_RE.source,
          { timeout: 8_000 }
        );
        return true;
      } catch {
        if (extractProjectId(page.url())) {
          return true;
        }
      }
    }

    while (Date.now() < deadline) {
      if (authError) {
        throw new Error(authError);
      }

      if (extractProjectId(page.url())) {
        return true;
      }

      // Find the best visible candidate coordinate
      const bestCoords = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('button, [role="button"], a')
        ) as HTMLElement[];
        let best: { cx: number; cy: number; score: number } | null = null;
        for (const el of candidates) {
          const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
          if (!/new project|create project|start a project|start creating/i.test(text)) {
            continue;
          }
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const visible =
            rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
          if (!visible || el.hasAttribute('disabled')) {
            continue;
          }
          let score = 1;
          if (/new project/i.test(text)) score = 3;
          else if (/create project/i.test(text)) score = 2;

          if (!best || score > best.score) {
            best = { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, score };
          }
        }
        return best;
      });

      if (bestCoords) {
        // Use real Playwright mouse click instead of synthetic element.click()
        await page.mouse.click(bestCoords.cx, bestCoords.cy).catch(() => {});
        try {
          await page.waitForFunction(
            (re: string) => new RegExp(re, 'i').test(window.location.href),
            PROJECT_URL_RE.source,
            { timeout: 6_000 }
          );
          return true;
        } catch {
          if (extractProjectId(page.url())) {
            return true;
          }
        }
      }

      // Check if a new project link appeared on the page and navigate directly
      const firstProjectHref = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/project/"]');
        return link ? link.getAttribute('href') : null;
      });
      if (firstProjectHref) {
        const targetUrl = firstProjectHref.startsWith('http')
          ? firstProjectHref
          : `https://flow.google.com${firstProjectHref.startsWith('/') ? '' : '/'}${firstProjectHref}`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        if (extractProjectId(page.url())) {
          return true;
        }
      }

      // If editor is already visible, we are already inside a project
      const editorPresent = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('textarea, [contenteditable="true"].ProseMirror, [contenteditable="true"]')
        ) as HTMLElement[];
        return candidates.some((el) => {
          if (el.classList.contains('g-recaptcha-response') || el.getAttribute('name') === 'g-recaptcha-response') return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width >= 5 && rect.height >= 5;
        });
      });
      if (editorPresent || extractProjectId(page.url())) {
        return true;
      }

      // Recovery: navigate back if off-home
      const currentUrl = page.url();
      const offHome = !currentUrl.includes('flow.google.com') || currentUrl.includes('/404');
      if (offHome) {
        const recoverUrl =
          homeUrl ||
          (() => {
            try {
              return new URL('/', currentUrl).toString();
            } catch {
              return 'https://flow.google.com';
            }
          })();
        await page.goto(recoverUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (authError) {
      throw new Error(authError);
    }
    return false;
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Waits for the prompt input / editor to become ready.
 */
export async function waitForEditor(page: Page, timeoutMs: number = 30_000): Promise<void> {
  await dismissCookieBanner(page).catch(() => {});
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await dismissCookieBanner(page).catch(() => {});
    const isReady = await page.evaluate((selector: string) => {
      const candidates = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      return candidates.some((el) => {
        if (el.classList.contains('g-recaptcha-response') || el.getAttribute('name') === 'g-recaptcha-response') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 5 && rect.height >= 5;
      });
    }, PROMPT_EDITOR_SELECTOR);

    if (isReady) return;
    await new Promise((r) => setTimeout(r, 400));
  }

  throw new Error('Flow prompt editor did not become ready. The UI may have changed; verify with --headed.');
}

export interface ConfigureAgentSettingsOptions {
  imageCount?: number;
  videoCount?: number;
  imageModelSuffix?: string;
  videoModelSuffix?: string;
  aspectRatio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | 'portrait' | 'landscape' | string;
  timeoutMs?: number;
}

/**
 * Ensures Google Flow's experimental Agent chat mode is disabled so prompt submissions
 * synthesize directly onto the canvas instead of entering an interactive chat conversation.
 */
export async function disableAgentModeIfNeeded(page: Page): Promise<boolean> {
  await dismissCookieBanner(page);

  // 1. Close any open session panel if present
  await page.evaluate(() => {
    const sessionCloseBtns = Array.from(document.querySelectorAll('button')).filter((b) => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.textContent || '').trim().toLowerCase();
      return (aria === 'close' || text === 'close') && b.closest('.session-header, header, flow-agent-panel, [class*="session"]');
    });
    for (const btn of sessionCloseBtns) {
      (btn as HTMLElement).click();
    }
  });

  await new Promise((r) => setTimeout(r, 300));

  // 2. Check and toggle off Agent mode chip if active
  const toggled = await page.evaluate(() => {
    const chip = document.querySelector('button.agent-mode-chip, flow-agent-mode-toggle-chip button') as HTMLElement | null;
    if (!chip) return false;
    const isChecked = chip.getAttribute('aria-pressed') === 'true' || chip.classList.contains('agent-mode-chip-checked');
    if (isChecked) {
      chip.click();
      return true;
    }
    return false;
  });

  if (toggled) {
    await new Promise((r) => setTimeout(r, 500));
  }

  return toggled;
}

/**
 * Ensures the account-level "Return silent videos" preference is enabled.
 *
 * Root cause of the recurring Flow video-synthesis hangs: while this toggle is
 * OFF, Flow attempts to synthesize an audio track for every clip and
 * intermittently fails ("Audio generation failed … You can update your settings
 * to return silent videos"), leaving the server-side task hanging indefinitely so
 * no video URL ever appears and the observer times out. Silent videos avoid that
 * failure mode entirely (the pipeline adds its own narration/music downstream).
 *
 * The preference is account-level and sticky, so this only needs to run once per
 * browser session — memoized by context scope to avoid needless overlay churn.
 */
export async function ensureSilentVideosEnabled(page: Page): Promise<boolean> {
  // Memoize per ORIGIN (account), not per browser-context object: the pipeline
  // reconnects over CDP for every clip and each reconnect yields a fresh context
  // wrapper, which would otherwise re-open the settings overlay on every clip
  // (needless overlay churn → reCAPTCHA risk). The preference is account-level.
  const scope = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return page.url();
    }
  })();
  if (silentVideosEnsuredScope === scope) return true;

  const readState = () =>
    page
      .evaluate(() => {
        const b = document.querySelector('button[name="return-silent-videos"]');
        return b ? b.getAttribute('aria-checked') : null;
      })
      .catch(() => null);

  try {
    await dismissCookieBanner(page).catch(() => {});

    let state = await readState();
    if (state === null) {
      // Open the header app-settings (gear) menu where the toggle lives.
      await page
        .evaluate(() => {
          const cands = Array.from(document.querySelectorAll('button,[role="button"]')) as HTMLElement[];
          const gear =
            cands.find((e) => (e.getAttribute('aria-label') || '') === 'Settings') ||
            cands.find((e) => /^settings?$/i.test((e.getAttribute('aria-label') || '').trim()));
          gear?.click();
        })
        .catch(() => {});
      for (let i = 0; i < 10 && state === null; i++) {
        await new Promise((r) => setTimeout(r, 500));
        state = await readState();
      }
    }

    let confirmed = state;
    if (state === 'false') {
      await page
        .evaluate(() => {
          const b = document.querySelector('button[name="return-silent-videos"]') as HTMLElement | null;
          if (b && b.getAttribute('aria-checked') !== 'true') b.click();
        })
        .catch(() => {});
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 400));
        confirmed = await readState();
        if (confirmed === 'true') break;
      }
    }

    // Close the settings overlay so it never blocks the prompt box.
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    const ok = confirmed === 'true';
    if (ok) {
      silentVideosEnsuredScope = scope;
      console.log(
        picocolors.green('[flow-dom] ✓ "Return silent videos" confirmed ON (account-level; no audio synthesis → avoids the audio-failure hang)')
      );
    }
    return ok;
  } catch {
    return false;
  }
}

/** Memo scope for which browser session has "Return silent videos" verified. */
let silentVideosEnsuredScope: string | null = null;

export interface DirectGenerationSettingsOptions {
  mode?: 'image' | 'video';
  subMode?: 'frames' | 'ingredients' | string;
  count?: number;
  durationSec?: number;
  aspectRatio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | 'portrait' | 'landscape' | string;
  modelSuffix?: string;
  timeoutMs?: number;
}

/**
 * Checks whether the current settings summary displayed on the trigger button
 * already matches the requested options (e.g. mode, aspect ratio, count, model).
 */
export function isDirectSettingsSatisfied(
  currentSummary: string,
  options: DirectGenerationSettingsOptions,
  isCachedSignature?: boolean
): boolean {
  if (!currentSummary) return false;
  const s = currentSummary.toLowerCase();

  const targetMode = options.mode ?? 'image';
  if (targetMode === 'image') {
    // If it mentions video or veo or duration (e.g. "8s"), it is NOT image mode
    if (s.includes('video') || s.includes('veo') || /\b\d+s\b/.test(s)) {
      return false;
    }
  } else if (targetMode === 'video') {
    // If it does not mention video or veo, it is NOT video mode
    if (!s.includes('video') && !s.includes('veo')) {
      return false;
    }
  }

  // Model suffix check. The IMAGE summary renders the model name
  // (e.g. "🍌 Nano Banana 2 Lite crop_9_16 x1") but the VIDEO summary often does not
  // ("Video · 720p · 8s crop_16_9 x1").
  // If the video summary does not render the model name, it can ONLY pass if this
  // browser session has already configured this signature (isCachedSignature === true).
  // Without a cached signature, it MUST open the settings overlay to actively select
  // the lite model tier.
  const targetModelSuffix = (options.modelSuffix ?? 'lite').toLowerCase();
  if (targetModelSuffix) {
    if (s.includes(targetModelSuffix)) {
      // Model suffix rendered in summary and matches
    } else if (targetMode === 'video') {
      if (!isCachedSignature) {
        return false;
      }
    } else {
      return false;
    }
  }

  // Count check
  const targetCount = options.count ?? 1;
  if (!s.includes(`x${targetCount}`)) {
    return false;
  }

  // Duration check (if in video mode)
  if (targetMode === 'video' && options.durationSec) {
    if (!s.includes(`${options.durationSec}s`)) {
      return false;
    }
  }

  // Aspect ratio check
  if (options.aspectRatio) {
    const raw = options.aspectRatio.toLowerCase();
    const isPortrait = raw === 'portrait' || raw === '9:16' || raw === '3:4';
    const isLandscape = raw === 'landscape' || raw === '16:9' || raw === '4:3';
    const isSquare = raw === '1:1' || raw === 'square';

    if (isPortrait) {
      if (
        !s.includes('9:16') &&
        !s.includes('9_16') &&
        !s.includes('3:4') &&
        !s.includes('3_4') &&
        !s.includes('portrait')
      ) {
        return false;
      }
    } else if (isLandscape) {
      if (
        !s.includes('16:9') &&
        !s.includes('16_9') &&
        !s.includes('4:3') &&
        !s.includes('4_3') &&
        !s.includes('landscape')
      ) {
        return false;
      }
    } else if (isSquare) {
      if (!s.includes('1:1') && !s.includes('1_1') && !s.includes('square')) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Per-browser direct-settings cache. Flow's direct-canvas settings are sticky at the
 * account level, but each pipeline step reconnects to the shared browser (fresh Page
 * wrappers), so a Page-keyed WeakMap would never survive between steps. Keyed by
 * browser websocket endpoint + page origin instead, so different Chromium profiles
 * never share state.
 *
 * Purpose: the strict satisfaction check cannot always pass (the video summary never
 * renders the model name; the selected model may not offer the requested duration),
 * and re-opening the settings overlay before EVERY generation step fires a burst of
 * 6-8 mouse clicks that reCAPTCHA Enterprise scores as automation
 * (PUBLIC_ERROR_UNUSUAL_ACTIVITY — see plan-progress-paced-cooldown-and-settings-cache.md).
 * Once a signature has been configured and Flow's resulting summary recorded, an
 * unchanged summary proves Flow kept that state: skip the overlay entirely. If the
 * summary drifts (server-side state change), the check misses and the overlay path
 * runs once, refreshing the cache.
 */
const directSettingsCache = new Map<string, Map<string, string>>();

// Playwright has no wsEndpoint on the Browser object (and persistent contexts
// have no public endpoint at all), so each BrowserContext gets a process-local
// id — combined with the origin it preserves the old cache scoping semantics
// (per connected browser endpoint + per origin).
const browserContextScopeIds = new WeakMap<object, number>();
let nextBrowserContextScopeId = 1;

function browserContextScope(ctx: object): number {
  let id = browserContextScopeIds.get(ctx);
  if (!id) {
    id = nextBrowserContextScopeId++;
    browserContextScopeIds.set(ctx, id);
  }
  return id;
}

function directSettingsCacheScope(page: Page): string {
  let origin = page.url();
  try {
    origin = new URL(page.url()).origin;
  } catch {
    // keep raw url
  }
  return `${browserContextScope(page.context())}|${origin}`;
}

function directSettingsSignature(options: DirectGenerationSettingsOptions): string {
  return JSON.stringify({
    mode: options.mode ?? 'image',
    count: options.count ?? 1,
    modelSuffix: (options.modelSuffix ?? 'lite').toLowerCase(),
    aspectRatio: options.aspectRatio ?? null,
    durationSec: options.durationSec ?? null,
  });
}

/**
 * Opens Google Flow's Direct Canvas Generation settings overlay (triggered by
 * the settings trigger button in the prompt box, e.g. "Image · x1" or "Video · 720p · 8s").
 */
export async function configureDirectGenerationSettings(
  page: Page,
  options: DirectGenerationSettingsOptions = {}
): Promise<{ mode: string; count: number; model?: string; summary: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const targetMode = options.mode ?? 'image';
  const targetCount = options.count ?? 1;
  const targetModelSuffix = options.modelSuffix ?? 'lite';

  // Ensure cookie banner is dismissed so settings trigger button is clickable
  await dismissCookieBanner(page).catch(() => {});

  // Ensure Agent mode is deactivated so the settings trigger button is active
  await disableAgentModeIfNeeded(page);

  // Root-cause fix for Flow audio-generation hangs: guarantee the account-level
  // "Return silent videos" preference is ON before any generation is submitted.
  await ensureSilentVideosEnabled(page).catch(() => {});

  // 0. Fast-path check: wait up to 6s for settings trigger button to render its summary text.
  // After page reload / navigation, the Angular settings component takes ~1.5-2s to mount.
  // Checking too early reads "" and falsely assumes settings are unsatisfied, causing
  // an unnecessary overlay open + synthetic clicks burst that triggers reCAPTCHA.
  let initialSummary = '';
  const waitDeadline = Date.now() + 6_000;
  while (Date.now() < waitDeadline) {
    initialSummary = await page.evaluate(() => {
      return (
        document.querySelector('.settings-summary, .settings-trigger-button')?.textContent?.trim().replace(/\s+/g, ' ') || ''
      );
    });
    if (initialSummary) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const cacheScope = directSettingsCacheScope(page);
  const settingsSignature = directSettingsSignature(options);
  const cachedSummary = directSettingsCache.get(cacheScope)?.get(settingsSignature);

  const isFramesRequested = options.subMode === 'frames' || options.modelSuffix?.toLowerCase().includes('frames');

  // 0a. Cache fast-path: this exact signature was already configured on this browser
  // and Flow still shows the same summary — the settings are sticky, so re-opening
  // the overlay would only fire a bot-like click burst without changing anything.
  if (cachedSummary && initialSummary && initialSummary === cachedSummary) {
    const framesReady = !isFramesRequested || (await page.evaluate(() => document.querySelectorAll('.frame-trigger').length > 0).catch(() => false));
    if (framesReady) {
      return {
        mode: targetMode,
        count: targetCount,
        model: targetModelSuffix,
        summary: initialSummary,
      };
    }
  }

  // 0b. Strict satisfaction check for initial / un-cached state
  if (isDirectSettingsSatisfied(initialSummary, options, false)) {
    const framesReady = !isFramesRequested || (await page.evaluate(() => document.querySelectorAll('.frame-trigger').length > 0).catch(() => false));
    if (framesReady) {
      return {
        mode: targetMode,
        count: targetCount,
        model: targetModelSuffix,
        summary: initialSummary,
      };
    }
  }

  // 1. Open direct settings overlay via settings-trigger-button
  const deadline = Date.now() + timeoutMs;
  let overlayOpened = false;

  while (Date.now() < deadline) {
    const isOverlayOpen = await page.evaluate(() => {
      const overlay = document.querySelector('flow-prompt-box-settings, .settings-content-overlay, .cdk-overlay-pane:has(flow-prompt-box-settings)');
      return Boolean(overlay && (overlay as HTMLElement).offsetParent !== null);
    });
    if (isOverlayOpen) {
      overlayOpened = true;
      break;
    }

    await page.evaluate(() => {
      const triggerBtn = document.querySelector('.settings-trigger-button, button[aria-label="Settings trigger"]') as HTMLElement | null;
      if (triggerBtn) triggerBtn.click();
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 500));

    const hasOverlay = await page.evaluate(() => {
      const el = document.querySelector('flow-prompt-box-settings, .settings-content-overlay, .cdk-overlay-pane:has(flow-prompt-box-settings)');
      return Boolean(el && (el as HTMLElement).offsetParent !== null);
    });
    if (hasOverlay) {
      overlayOpened = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 2. Select Mode (Image or Video)
  const modeClicked = await page.evaluate((mode) => {
    const overlay = document.querySelector('flow-prompt-box-settings, .settings-content-overlay, .cdk-overlay-pane:has(flow-prompt-box-settings)') || document.body;
    const toggles = Array.from(overlay.querySelectorAll('mat-button-toggle, [role="radio"], button'));
    const targetToggle = toggles.find((t) => {
      const text = (t.textContent || '').toLowerCase();
      return mode === 'image' ? text.includes('image') : text.includes('video');
    });
    if (targetToggle) {
      const btn = (targetToggle.querySelector('button') || targetToggle) as HTMLElement;
      btn.click();
      return true;
    }
    return false;
  }, targetMode);
  await new Promise((r) => setTimeout(r, 600));

  // 2b. Select Sub-Mode (e.g. Frames mode) if requested
  const isFramesMode = options.subMode === 'frames' || options.modelSuffix?.toLowerCase().includes('frames');
  if (targetMode === 'video' && isFramesMode) {
    let framesClicked = false;
    const framesToggleDeadline = Date.now() + 6_000;
    while (Date.now() < framesToggleDeadline) {
      framesClicked = await page.evaluate(() => {
        const overlay = document.querySelector('flow-prompt-box-settings, .settings-content-overlay, .cdk-overlay-pane:has(flow-prompt-box-settings)') || document.body;
        const toggles = Array.from(overlay.querySelectorAll('mat-button-toggle, [role="radio"], button'));
        const targetToggle = toggles.find((t) => (t.textContent || '').toLowerCase().includes('frames'));
        if (targetToggle) {
          const btn = (targetToggle.querySelector('button') || targetToggle) as HTMLElement;
          btn.click();
          return true;
        }
        return false;
      });

      if (framesClicked) {
        await new Promise((r) => setTimeout(r, 600));
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!framesClicked) {
      console.warn(picocolors.yellow(`[flow-dom] Warning: Frames sub-mode toggle not found in settings overlay`));
    }
  }

  // 3. Select Model ending with modelSuffix (e.g. 'lite') via real mouse clicks (skip for Frames mode)
  const effectiveModelSuffix = isFramesMode ? undefined : targetModelSuffix;
  let selectedModel: string | undefined;
  if (effectiveModelSuffix) {
    const modelTriggerPt = await page.evaluate(() => {
      const btn = document.querySelector(
        'button[aria-label="Select model family"], button[aria-label*="model" i], .model-select-trigger-content, button:has(.model-select-trigger-content), .direct-model-picker-button, .video-model-picker-button, .image-model-picker-button'
      ) as HTMLElement | null;
      if (btn) {
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });

    if (modelTriggerPt) {
      await page.mouse.click(modelTriggerPt.x, modelTriggerPt.y);
      await new Promise((r) => setTimeout(r, 500));

      const itemInfo = await page.evaluate((suffix) => {
        const regexEnd = new RegExp(`(?:^|[\\s_-])${suffix}\\s*$`, 'i');
        const items = Array.from(document.querySelectorAll(
          '.cdk-overlay-pane button, [role="menu"] button, [role="menuitem"], .mat-mdc-menu-item, mat-option, [role="option"], .mat-mdc-option'
        ));

        // First pass: strictly ends with suffix (e.g. "Veo 3.1 - Lite")
        for (const item of items) {
          const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
          if (regexEnd.test(text)) {
            const r = item.getBoundingClientRect();
            return { text, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }

        // Second pass: contains suffix
        const regexContains = new RegExp(suffix, 'i');
        for (const item of items) {
          const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
          if (regexContains.test(text)) {
            const r = item.getBoundingClientRect();
            return { text, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, effectiveModelSuffix);

      if (itemInfo) {
        selectedModel = itemInfo.text;
        await page.mouse.click(itemInfo.x, itemInfo.y);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  // 4. Select Count (e.g. x1) via real mouse click
  const countPt = await page.evaluate((count) => {
    const overlay = document.querySelector('.settings-content-overlay, flow-prompt-box-settings, .cdk-overlay-pane') || document.body;
    const toggles = Array.from(overlay.querySelectorAll('mat-button-toggle'));
    const countToggle = toggles.find((t) => (t.textContent || '').trim().toLowerCase() === `x${count}`);
    if (countToggle) {
      const btn = countToggle.querySelector('button') || (countToggle as HTMLElement);
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, targetCount);

  if (countPt) {
    await page.mouse.click(countPt.x, countPt.y);
    await new Promise((r) => setTimeout(r, 300));
  }

  // 5. Select Duration (if Video mode) via real mouse click
  if (targetMode === 'video' && options.durationSec) {
    const durPt = await page.evaluate((sec) => {
      const overlay = document.querySelector('.settings-content-overlay, flow-prompt-box-settings, .cdk-overlay-pane') || document.body;
      const toggles = Array.from(overlay.querySelectorAll('mat-button-toggle'));
      const durToggle = toggles.find((t) => (t.textContent || '').trim().toLowerCase() === `${sec}s`);
      if (durToggle) {
        const btn = durToggle.querySelector('button') || (durToggle as HTMLElement);
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    }, options.durationSec);

    if (durPt) {
      await page.mouse.click(durPt.x, durPt.y);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 6. Select Aspect Ratio if specified via real mouse click
  if (options.aspectRatio) {
    const aspectPt = await page.evaluate((targetRatio) => {
      const overlay = document.querySelector('.settings-content-overlay, flow-prompt-box-settings, .cdk-overlay-pane') || document.body;
      const toggles = Array.from(overlay.querySelectorAll('mat-button-toggle, button, [role="radio"], [role="menuitem"]'));

      const lower = targetRatio.toLowerCase();
      let preferences: string[] = [];
      if (lower === 'portrait' || lower === '9:16') {
        preferences = ['9:16', '3:4', 'portrait'];
      } else if (lower === '3:4') {
        preferences = ['3:4', '9:16', 'portrait'];
      } else if (lower === 'landscape' || lower === '16:9') {
        preferences = ['16:9', '4:3', 'landscape'];
      } else if (lower === '4:3') {
        preferences = ['4:3', '16:9', 'landscape'];
      } else {
        preferences = [targetRatio];
      }

      for (const pref of preferences) {
        const match = toggles.find((el) => {
          const text = (el.textContent || '').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          return text.includes(pref.toLowerCase()) || aria.includes(pref.toLowerCase());
        });
        if (match) {
          const btn = (match.querySelector('button') || match) as HTMLElement;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, options.aspectRatio);

    if (aspectPt) {
      await page.mouse.click(aspectPt.x, aspectPt.y);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // 7. Dismiss overlay cleanly: click backdrop, toggle trigger button, or Escape as fallback.
  // Do NOT press 'Escape' directly on Flow canvas as it triggers canvas hotkeys
  // (e.g. move-to-trash, undo), corrupting canvas elements.
  const backdropPt = await page.evaluate(() => {
    const backdrop = document.querySelector('.cdk-overlay-backdrop') as HTMLElement | null;
    if (backdrop) {
      const r = backdrop.getBoundingClientRect();
      return { x: Math.max(r.x + 10, 10), y: Math.max(r.y + 10, 10) };
    }
    const pane = document.querySelector('.cdk-overlay-pane, .settings-content-overlay');
    if (pane && (pane as HTMLElement).offsetParent !== null) {
      const triggerBtn = document.querySelector('.settings-trigger-button') as HTMLElement | null;
      if (triggerBtn) {
        const r = triggerBtn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });

  if (backdropPt) {
    await page.mouse.click(backdropPt.x, backdropPt.y);
  }
  await new Promise((r) => setTimeout(r, 300));

  const stillOpen = await page.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane, .settings-content-overlay');
    return Boolean(pane && (pane as HTMLElement).offsetParent !== null);
  });
  if (stillOpen) {
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
  }

  // If Frames sub-mode was requested, wait up to 8s for .frame-trigger to mount in prompt box
  if (targetMode === 'video' && isFramesMode) {
    const framesReadyDeadline = Date.now() + 8_000;
    while (Date.now() < framesReadyDeadline) {
      const ready = await page.evaluate(() => {
        const triggers = document.querySelectorAll(
          '.frame-trigger, button.empty-chip, flow-image-ingredient-chip, [aria-label*="start" i], [aria-label*="end" i], button:has(mat-icon[fonticon*="image" i])'
        );
        return triggers.length > 0;
      });
      if (ready) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Read final settings summary
  const summary = await page.evaluate(() => {
    return document.querySelector('.settings-summary, .settings-trigger-button')?.textContent?.trim().replace(/\s+/g, ' ') || '';
  });

  // Record the configured state: an unchanged summary on later calls proves the
  // settings are still in effect, letting them skip the overlay entirely.
  if (summary) {
    let scoped = directSettingsCache.get(cacheScope);
    if (!scoped) {
      scoped = new Map<string, string>();
      directSettingsCache.set(cacheScope, scoped);
    }
    if (scoped.size >= 20) scoped.clear();
    scoped.set(settingsSignature, summary);
  }

  return {
    mode: targetMode,
    count: targetCount,
    model: selectedModel,
    summary,
  };
}

/**
 * Opens the Agent Settings panel from the prompt input's adjustment/tune icon,
 * and configures:
 * 1. Image generation default count: 1 (x1)
 * 2. Image generation default model: model ending with "lite" (e.g. Nano Banana 2 Lite)
 * 3. Video generation default count: 1 (x1)
 * 4. Video generation default model: model ending with "lite" (e.g. Veo 3.1 - Lite)
 * 5. Saves settings via the Save button.
 */
export async function configureAgentSettings(
  page: Page,
  options: ConfigureAgentSettingsOptions = {}
): Promise<{ imageModel?: string; videoModel?: string; imageCount?: number; videoCount?: number }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  const targetImageCount = options.imageCount ?? 1;
  const targetVideoCount = options.videoCount ?? 1;
  const imageModelSuffix = options.imageModelSuffix ?? 'lite';
  const videoModelSuffix = options.videoModelSuffix ?? 'lite';

  await dismissCookieBanner(page);

  // 1. Open Agent Settings panel by clicking tune/settings icon
  let panelOpened = false;
  while (Date.now() < deadline) {
    panelOpened = await page.evaluate(() => {
      if (document.querySelector('flow-settings-view')) return true;
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const tuneBtn = btns.find(
        (b) => b.getAttribute('aria-label') === 'Settings' || b.textContent?.trim() === 'tune'
      ) as HTMLElement | null;
      if (tuneBtn) {
        tuneBtn.click();
        return true;
      }
      return false;
    });

    if (panelOpened) {
      await new Promise((r) => setTimeout(r, 600));
      const hasView = await page.evaluate(() => !!document.querySelector('flow-settings-view'));
      if (hasView) break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // 2. Configure Image generation default
  // 2a. Set image count (e.g. x1)
  await page.evaluate((count) => {
    const sections = Array.from(document.querySelectorAll('.settings-section'));
    const imgSec = sections.find((s) => /image generation default/i.test(s.textContent || ''));
    if (imgSec) {
      const toggle = Array.from(imgSec.querySelectorAll('button, [role="radio"]')).find(
        (b) => b.textContent?.trim().toLowerCase() === `x${count}`
      ) as HTMLElement | null;
      if (toggle) toggle.click();
    }
  }, targetImageCount);

  await new Promise((r) => setTimeout(r, 400));

  // 2b. Pick Image Model ending with "lite"
  let selectedImageModel: string | undefined;
  const imgModelBtnClicked = await page.evaluate(() => {
    const btn = document.querySelector('.image-model-picker-button') as HTMLElement | null;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (imgModelBtnClicked) {
    await new Promise((r) => setTimeout(r, 600));
    selectedImageModel = (await page.evaluate((suffix) => {
      const regex = new RegExp(`(?:^|[\\s_-])${suffix}\\s*$`, 'i');
      const items = Array.from(document.querySelectorAll(
        '.cdk-overlay-pane button, [role="menu"] button, [role="menuitem"], .mat-mdc-menu-item, mat-option, [role="option"], .mat-mdc-option'
      ));
      for (const item of items) {
        const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
        if (regex.test(text)) {
          (item as HTMLElement).click();
          return text;
        }
      }
      for (const item of items) {
        const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
        if (new RegExp(suffix, 'i').test(text)) {
          (item as HTMLElement).click();
          return text;
        }
      }
      return undefined;
    }, imageModelSuffix)) || undefined;
    await new Promise((r) => setTimeout(r, 600));
  }

  // 3. Configure Video generation default
  // 3a. Set video count (e.g. x1)
  await page.evaluate((count) => {
    const sections = Array.from(document.querySelectorAll('.settings-section'));
    const vidSec = sections.find((s) => /video generation default/i.test(s.textContent || ''));
    if (vidSec) {
      const toggle = Array.from(vidSec.querySelectorAll('button, [role="radio"]')).find(
        (b) => b.textContent?.trim().toLowerCase() === `x${count}`
      ) as HTMLElement | null;
      if (toggle) toggle.click();
    }
  }, targetVideoCount);

  await new Promise((r) => setTimeout(r, 400));

  // 3b. Pick Video Model ending with "lite"
  let selectedVideoModel: string | undefined;
  const vidModelBtnClicked = await page.evaluate(() => {
    const btn = document.querySelector('.video-model-picker-button') as HTMLElement | null;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (vidModelBtnClicked) {
    await new Promise((r) => setTimeout(r, 600));
    selectedVideoModel = (await page.evaluate((suffix) => {
      const regex = new RegExp(`(?:^|[\\s_-])${suffix}\\s*$`, 'i');
      const items = Array.from(document.querySelectorAll(
        '.cdk-overlay-pane button, [role="menu"] button, [role="menuitem"], .mat-mdc-menu-item, mat-option, [role="option"], .mat-mdc-option'
      ));
      for (const item of items) {
        const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
        if (regex.test(text)) {
          (item as HTMLElement).click();
          return text;
        }
      }
      for (const item of items) {
        const text = (item.textContent || '').trim().replace(/\s+/g, ' ');
        if (new RegExp(suffix, 'i').test(text)) {
          (item as HTMLElement).click();
          return text;
        }
      }
      return undefined;
    }, videoModelSuffix)) || undefined;
    await new Promise((r) => setTimeout(r, 600));
  }

  // 3c. Configure Aspect Ratio if specified in agent settings
  if (options.aspectRatio) {
    await page.evaluate((targetRatio) => {
      const view = document.querySelector('flow-settings-view') || document.body;
      const toggles = Array.from(view.querySelectorAll('mat-button-toggle, button, [role="radio"], [role="menuitem"]'));
      const lower = targetRatio.toLowerCase();
      let preferences: string[] = [];
      if (lower === 'portrait' || lower === '9:16') {
        preferences = ['9:16', '3:4', 'portrait'];
      } else if (lower === '3:4') {
        preferences = ['3:4', '9:16', 'portrait'];
      } else if (lower === 'landscape' || lower === '16:9') {
        preferences = ['16:9', '4:3', 'landscape'];
      } else if (lower === '4:3') {
        preferences = ['4:3', '16:9', 'landscape'];
      } else {
        preferences = [targetRatio];
      }
      for (const pref of preferences) {
        const match = toggles.find((el) => {
          const text = (el.textContent || '').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          return text.includes(pref.toLowerCase()) || aria.includes(pref.toLowerCase());
        });
        if (match) {
          const btn = (match.querySelector('button') || match) as HTMLElement;
          btn.click();
          return pref;
        }
      }
      return null;
    }, options.aspectRatio);
    await new Promise((r) => setTimeout(r, 400));
  }

  // 4. Click Save button
  await page.evaluate(() => {
    const saveBtn = document.querySelector('.settings-save-button') as HTMLElement | null;
    if (saveBtn) {
      saveBtn.click();
    }
  });

  await new Promise((r) => setTimeout(r, 800));

  return {
    imageModel: selectedImageModel,
    videoModel: selectedVideoModel,
    imageCount: targetImageCount,
    videoCount: targetVideoCount,
  };
}

/**
 * Enforces models ending with 'lite' to conserve daily credits and maintain consistent quality.
 */
export async function chooseLowestModel(
  page: Page,
  requestedModel: string = 'lite',
  aspectRatio?: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | 'portrait' | 'landscape' | string,
): Promise<void> {
  try {
    await configureAgentSettings(page, {
      imageModelSuffix: requestedModel || 'lite',
      videoModelSuffix: requestedModel || 'lite',
      aspectRatio,
    });
  } catch {
    // Fallback: Proceed with current selection
  }
}

/**
 * Dismisses cookie consent overlay if present on the page.
 */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // 1. Classic glue notification bar
      const cookieBtn = document.querySelector(
        'button.glue-cookie-notification-bar__accept, button.glue-cookie-notification-bar__reject'
      ) as HTMLElement | null;
      if (cookieBtn) {
        cookieBtn.click();
        return true;
      }

      // 2. Modern Google / Flow cookie consent banner ("Agree" / "No thanks" / "Accept all" / "I agree")
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
      const agreeBtn = buttons.find((b) => {
        const text = (b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
        return (
          text === 'agree' ||
          text === 'accept all' ||
          text === 'i agree' ||
          text === 'accept' ||
          text === '同意' ||
          text === '全部接受'
        );
      });
      if (agreeBtn) {
        agreeBtn.click();
        return true;
      }

      // 3. Fallback: Check if glue-cookie-notification-bar or similar container is still in DOM and remove or hide it
      const banner = document.querySelector('.glue-cookie-notification-bar, [class*="cookie-notification"], [class*="cookie-consent"]') as HTMLElement | null;
      if (banner) {
        const anyButton = banner.querySelector('button') as HTMLElement | null;
        if (anyButton) {
          anyButton.click();
          return true;
        }
        banner.remove();
        return true;
      }

      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Attempts to transition into the Google Flow workspace if currently on flow.google.com/about.
 */
export async function tryEnterWorkspaceFromAbout(page: Page): Promise<boolean> {
  if (!page.url().includes('flow.google.com/about')) {
    return false;
  }
  await dismissCookieBanner(page);
  try {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
      const c = candidates.find((el) => {
        const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
        return /create with google flow|try in google flow|try google flow|get started/i.test(text);
      });
      if (c) {
        c.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      return true;
    }
  } catch {
    // Best effort
  }
  return false;
}

/**
 * Attempts to trigger the sign-in flow on Google Flow (flow.google.com).
 * Clicks the primary "Sign in" or "Create with Google Flow" / "Get started" button to reach accounts.google.com.
 */
export async function triggerFlowSignIn(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes('accounts.google.com')) {
    return true;
  }
  await dismissCookieBanner(page).catch(() => {});

  const selectors = [
    'a[href*="ServiceLogin"]',
    'a[href*="accounts.google.com"]',
    'a:has-text("Sign in")',
    'button:has-text("Sign in")',
    'a[aria-label*="Sign in" i]',
    'button[aria-label*="Sign in" i]',
    'button:has-text("Create with Google Flow")',
    'button:has-text("Try in Google Flow")',
    'button:has-text("Get started")',
  ];

  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      const isVis = await el.isVisible().catch(() => false);
      if (isVis) {
        console.log(picocolors.dim(`  [flow-signin] Clicking Flow sign-in element (${sel})...`));
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {}),
          el.click().catch(() => {}),
        ]);
        await page.waitForTimeout(1000);
        return true;
      }
    }
  }

  // Fallback evaluate click
  return await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
    const c = candidates.find((el) => {
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
      const href = el.getAttribute('href') || '';
      return /^sign in$|^log in$/i.test(text) || href.includes('ServiceLogin') || /create with google flow/i.test(text);
    });
    if (c) {
      c.click();
      return true;
    }
    return false;
  }).catch(() => false);
}

const PROMPT_EDITOR_SELECTOR =
  'textarea[placeholder*="describe" i], textarea[aria-label*="prompt" i], textarea, [contenteditable="true"].ProseMirror, [contenteditable="true"], input[placeholder*="describe" i]';

/**
 * The prompt-box container. Used to keep every upload/attach trigger and
 * `input[type=file]` lookup INSIDE the prompt area — global matches (e.g. the
 * canvas header's `+` upload flow) must never be touched.
 */
const PROMPT_AREA_SELECTOR =
  'flow-prompt-box, [class*="prompt-box"], .prompt-box-container, #prompt-area';

/**
 * Normalizes editor/prompt text for verification comparison (NBSP + whitespace).
 */
function normalizeForCompare(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Reads the current text content of the prompt editor (value for inputs,
 * textContent for contenteditable).
 *
 * Locator contract (shared by every editor interaction):
 * `document.querySelector` with a bare `textarea` alternative matches Google's
 * hidden `g-recaptcha-response` injection when it precedes the real editor in
 * DOM order — input and readback would silently operate on the wrong element.
 * Always scan ALL selector matches and take the first VISIBLE non-recaptcha one.
 */
export async function readEditorText(page: Page): Promise<string> {
  return await page.evaluate((selector: string) => {
    const candidates = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    let editor: HTMLElement | null = null;
    for (const el of candidates) {
      if (el.classList.contains('g-recaptcha-response') || el.getAttribute('name') === 'g-recaptcha-response') continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;
      editor = el;
      break;
    }
    if (!editor) return '';
    const value = (editor as HTMLInputElement).value;
    return typeof value === 'string' ? value : editor.textContent || '';
  }, PROMPT_EDITOR_SELECTOR);
}

interface EditorReadResult {
  text: string;
  matched: boolean;
}

/**
 * Polls the editor content until it matches `expect` (normalized) or settles
 * unchanged. ProseMirror processes clipboard paste ASYNCHRONOUSLY (observed
 * ~400ms after the keystroke on the real Flow editor) — a fixed short wait
 * reads a half-applied intermediate state and falsely reports a failed paste.
 */
async function pollEditorText(page: Page, expect: string, timeoutMs: number): Promise<EditorReadResult> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  let stableCount = 0;
  let text = '';

  while (Date.now() < deadline) {
    text = await readEditorText(page);
    if (normalizeForCompare(text) === normalizeForCompare(expect)) {
      return { text, matched: true };
    }
    if (text === last) {
      stableCount++;
    } else {
      stableCount = 0;
      last = text;
    }
    // Unchanged for ~900ms and still not matching — no point waiting longer.
    if (stableCount >= 6) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  return { text, matched: false };
}

/**
 * Ensures the target origin has clipboard read/write permissions via CDP.
 */
async function ensureClipboardPermissions(page: Page): Promise<void> {
  const url = page.url();
  const origin = url.startsWith('http') ? new URL(url).origin : 'https://flow.google.com';
  const permissions: Array<'clipboardReadWrite' | 'clipboardSanitizedWrite'> = [
    'clipboardReadWrite',
    'clipboardSanitizedWrite',
  ];

  // Browser-level grant: survives page reloads and applies to the whole profile.
  try {
    const browser = page.context().browser();
    if (!browser) throw new Error('no browser handle on context');
    const browserSession = await browser.newBrowserCDPSession();
    await browserSession.send('Browser.grantPermissions', { permissions, origin });
    await browserSession.detach().catch(() => {});
  } catch {
    // Fall through to the page-level grant below
  }

  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Page.bringToFront').catch(() => {});
    await client.send('Browser.grantPermissions', { permissions, origin });
    await client.detach().catch(() => {});
  } catch {
    // Non-CDP or environments without grantPermissions support
  }
}

interface ClipboardWriteResult {
  method: string;
  /** True only when the written text was read back and equals the prompt. */
  verified: boolean;
  readbackLength: number;
}

/**
 * Writes text to the system clipboard via modern navigator.clipboard or
 * synchronous document.execCommand('copy') fallback, then VERIFIES the write by
 * reading the clipboard back.
 *
 * Verification is mandatory because a silently failed write makes Ctrl+V paste
 * whatever stale content the clipboard already held (observed on run
 * viral-1790520467551: a 935-char prompt from a previous pipeline run landed
 * instead of the current 145-char prompt). Callers must never paste on an
 * unverified clipboard.
 *
 * Runs BEFORE focusing the editor so that any temporary element or selection
 * manipulation does not steal focus/caret from the editor.
 */
async function copyTextToSystemClipboard(page: Page, text: string): Promise<void> {
  // 1. OS-level clipboard (X11: xsel/xclip), verified by read-back. This is the
  //    only write path that actually reaches the system clipboard in this browser
  //    build — `navigator.clipboard.writeText()` and `document.execCommand('copy')`
  //    both silently no-op here, so Ctrl+V pasted stale content of earlier runs
  //    (observed: a 935-char prompt of a previous pipeline run landed instead of
  //    the current prompt).
  if (process.env.DISPLAY) {
    try {
      await setClipboardVerified(text);
      return;
    } catch (err: any) {
      console.warn(
        picocolors.yellow(
          `[flow-dom] OS clipboard write unavailable (${(err?.message || '').slice(0, 120)}) — trying the browser clipboard API`
        )
      );
    }
  }

  // 2. Browser clipboard API (platforms where the browser owns the clipboard)
  await ensureClipboardPermissions(page);

  const result = await page.evaluate(async (t: string): Promise<ClipboardWriteResult> => {
    // navigator.clipboard.readText()/writeText() can pend FOREVER when the clipboard
    // permission cannot be resolved (observed: Runtime.callFunctionOn timed out after
    // 310s) — every clipboard promise is raced against a timeout.
    const withTimeout = <V,>(p: Promise<V>, ms: number, fallback: V): Promise<V> =>
      Promise.race([p, new Promise<V>((resolve) => setTimeout(() => resolve(fallback), ms))]);

    const readback = async (): Promise<string | null> => {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return null;
      try {
        return await withTimeout(navigator.clipboard.readText(), 1_500, null);
      } catch {
        return null; // reading not permitted — cannot verify, but the write may be fine
      }
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      let method = 'none';
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          const written = await withTimeout(
            navigator.clipboard.writeText(t).then(() => true),
            2_500,
            false
          );
          if (written) method = 'navigator.clipboard.writeText';
        }
      } catch {
        // Fall through to execCommand
      }

      if (method === 'none') {
        const holder = document.createElement('textarea');
        holder.value = t;
        holder.setAttribute('readonly', '');
        holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;z-index:-9999;';
        document.body.appendChild(holder);
        holder.select();
        const ok = document.execCommand('copy');
        holder.remove();
        if (ok) method = 'execCommand(copy)';
      }

      const seen = await readback();
      const verified = seen === null || seen === t;
      if (method !== 'none' && verified) {
        return { method, verified: true, readbackLength: seen === null ? -1 : seen.length };
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const seen = await readback();
    return {
      method: 'unverified',
      verified: false,
      readbackLength: seen === null ? -1 : seen.length,
    };
  }, text);

  if (!result.verified) {
    throw new Error(
      `Could not write the prompt to the system clipboard (verified readback mismatch: ` +
        `clipboard holds ${result.readbackLength} char(s), expected ${text.length}). ` +
        `Refusing to paste stale clipboard content.`
    );
  }
}

/**
 * Restores focus AND the document selection inside the editor after the
 * clipboard-copy step steals it. Paste and CDP insertText insert at the current
 * selection — for contenteditable editors a lost selection means the inserted
 * text lands nowhere (textarea/input keep an internal caret and are immune).
 */
async function restoreEditorFocusAndCaret(page: Page): Promise<void> {
  await page.evaluate((selector: string) => {
    const candidates = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    let editor: HTMLElement | null = null;
    for (const el of candidates) {
      if (el.classList.contains('g-recaptcha-response') || el.getAttribute('name') === 'g-recaptcha-response') continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;
      editor = el;
      break;
    }
    if (!editor) return;
    editor.focus();
    const inputLike = editor as HTMLInputElement;
    if (typeof inputLike.setSelectionRange === 'function') {
      inputLike.setSelectionRange(0, 0);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, PROMPT_EDITOR_SELECTOR);
}

/**
 * Human-like mouse gesture: the pointer travels to the target along a short
 * approach path with pauses instead of teleporting onto it. A click with zero
 * pointer history is a behavioral red flag for client-side risk analysis.
 */
export async function humanClick(page: Page, x: number, y: number): Promise<void> {
  const bounds = await page
    .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    .catch(() => ({ w: 1600, h: 900 }));
  const startX = Math.min(Math.max(x - 60 - Math.random() * 120, 5), bounds.w - 5);
  const startY = Math.min(Math.max(y - 40 - Math.random() * 90, 5), bounds.h - 5);
  await page.mouse.move(startX, startY, { steps: 6 });
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
  await page.mouse.move(x, y, { steps: 18 });
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 110));
  await page.mouse.click(x, y);
}

/** Locate the visible editor without changing focus, selection or page state. */
async function getPromptEditor(page: Page): Promise<ElementHandle<Element>> {
  const candidates = await page.$$(PROMPT_EDITOR_SELECTOR);
  let editor: ElementHandle<Element> | null = null;
  try {
    for (const candidate of candidates) {
      if (!(await candidate.isVisible())) continue;
      const usable = await candidate.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return !el.matches('.g-recaptcha-response, [name="g-recaptcha-response"], :disabled') &&
          r.width >= 5 && r.height >= 5;
      });
      if (usable) { editor = candidate; break; }
    }
    if (!editor) throw new Error('Could not locate prompt input element in Flow editor.');
    return editor;
  } finally {
    await Promise.all(candidates.filter((candidate) => candidate !== editor).map((candidate) => candidate.dispose()));
  }
}

/**
 * Fills the Flow prompt input using pure browser mechanisms:
 * 1. Focuses the editor via click/focus.
 * 2. Uses ProseMirror-native `document.execCommand('insertText')` or DataTransfer paste event.
 * 3. Falls back to Playwright typing if necessary.
 * Completely eliminates dependence on flaky OS-level xclip/xsel processes.
 */
export async function fillPromptInput(page: Page, promptText: string): Promise<void> {
  await dismissCookieBanner(page);
  await page.bringToFront();

  let read = { text: await readEditorText(page), matched: false };
  if (normalizeForCompare(read.text) === normalizeForCompare(promptText)) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const editor = await getPromptEditor(page);
    try {
      const box = await editor.boundingBox();
      if (box) {
        await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await editor.click();
      }

      // Clear existing content if any
      if ((await readEditorText(page)).trim()) {
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await pollEditorText(page, '', 1_000);
      }

      // Method 1: ProseMirror / DOM native insertText (pure browser, 0 external deps)
      const inserted = await page.evaluate((text) => {
        const pm = document.querySelector('.ProseMirror, [contenteditable="true"]') as HTMLElement | null;
        if (!pm) return false;
        pm.focus();
        document.execCommand('selectAll', false);
        const ok = document.execCommand('insertText', false, text);
        if (!ok || !pm.innerText.includes(text.slice(0, 20))) {
          // Method 2: In-browser synthetic ClipboardEvent with DataTransfer
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          pm.dispatchEvent(pasteEvent);
        }
        return true;
      }, promptText).catch(() => false);

      read = await pollEditorText(page, promptText, 2_000);
      if (read.matched) return;

      // Method 3: Browser clipboard API + keyboard Ctrl+V
      await page.evaluate(async (text) => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text).catch(() => {});
        }
      }, promptText).catch(() => {});

      await page.keyboard.down('Control');
      await page.keyboard.press('v');
      await page.keyboard.up('Control');

      read = await pollEditorText(page, promptText, 2_000);
      if (read.matched) return;

      console.warn(picocolors.yellow(`[flow-dom] Pure browser paste attempt ${attempt} did not match; retrying...`));
    } finally {
      await editor.dispose();
    }
  }

  throw new Error(`Prompt input verification failed: editor holds ${read.text.length} char(s), expected ${promptText.length}.`);
}

/**
 * Detects that a generation request has actually been submitted: confirmation
 * approve control surfaced, queue acknowledgement, in-progress Stop button,
 * or the generate button is disabled while the job runs.
 */
export async function isGenerationSubmitted(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (bodyText.includes('scheduled and is waiting in the queue')) return true;
    if (/noticed some unusual activity|unusual activity.*help center/i.test(bodyText)) return true;
    if (/\b\d+%\b/.test(bodyText)) return true;
    if (document.querySelector('flow-pending-tile, [class*="pending-tile"]')) return true;
    const stopBtn = Array.from(document.querySelectorAll('button, [role="button"]')).some(
      (b) => {
        if (b.closest('.frame-trigger, flow-ingredient-chip, [class*="chip"], [class*="attachment"]')) {
          return false;
        }
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (/remove|delete|clear|dismiss/i.test(aria)) return false;
        const text = (b.textContent || '').trim().toLowerCase();
        return text === 'stop' || /stop generation/i.test(aria) || /cancel generation/i.test(aria);
      }
    );
    if (stopBtn) return true;
    const approveControl = document.querySelector(
      '[role="radio"][aria-label*="Always approve" i], [role="radio"][aria-label*="Approve" i]'
    );
    if (approveControl) return true;
    const genBtn = document.querySelector(
      'button.generate-icon-button, button[aria-label*="generation" i]'
    ) as HTMLButtonElement | null;
    const editor = document.querySelector('textarea, [contenteditable="true"], flow-prompt-editor');
    const editorHasText = Boolean(editor?.textContent?.trim() || (editor as HTMLTextAreaElement)?.value?.trim());
    if (genBtn && (genBtn.disabled || genBtn.getAttribute('aria-disabled') === 'true')) {
      // If editor has no text and no pending indicator is present, genBtn is disabled simply because prompt is empty
      if (!editorHasText && !bodyText.includes('scheduled')) {
        return false;
      }
      return true;
    }
    return false;
  });
}

/**
 * Submits the filled prompt.
 *
 * Primary path: Enter key (the natural gesture after pasting a prompt).
 * Confirms the submission actually started via DOM signals; if Enter only
 * edited the text (e.g. inserted a newline) or did nothing, logs a WARN and
 * falls back to one Generate button click.
 *
 * Returns which path was used so callers can surface it in run logs.
 */
export async function submitPrompt(page: Page): Promise<'enter' | 'click'> {
  await dismissCookieBanner(page);

  // Paste leaves the caret in the editor. Preserve it and press Enter directly;
  // only click when the user or another UI action has actually moved focus away.
  const editor = await getPromptEditor(page);
  try {
    const focused = await editor.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
    if (!focused) {
      const box = await editor.boundingBox();
      if (box) {
        await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await editor.click();
      }
    }
  } finally {
    await editor.dispose();
  }

  const textBefore = await readEditorText(page);
  if (!textBefore.trim()) {
    console.warn(
      picocolors.yellow('[flow-dom] submitPrompt called but editor is currently empty')
    );
  }
  await page.keyboard.press('Enter');

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await isGenerationSubmitted(page)) return 'enter';

    const textNow = await readEditorText(page);
    // Editor cleared ⇒ prompt accepted and submitted.
    if (textBefore.trim() !== '' && textNow.trim() === '') return 'enter';
  }

  console.warn(
    picocolors.yellow('[flow-dom] Enter did not start generation — falling back to Generate button click')
  );
  await clickGenerateButton(page);
  return 'click';
}

/**
 * Locates and clicks the "Generate" or "Create Video" button.
 */
export async function clickGenerateButton(page: Page): Promise<void> {
  await dismissCookieBanner(page);

  // Poll up to 10s waiting for generate button to become enabled
  const deadline = Date.now() + 10_000;
  let clicked = false;

  while (Date.now() < deadline) {
    const pt = await page.evaluate(() => {
      const isEnabled = (el: HTMLElement | null) => {
        if (!el) return false;
        const btn = el as HTMLButtonElement;
        return !btn.disabled &&
          !btn.classList.contains('mat-mdc-button-disabled') &&
          btn.getAttribute('aria-disabled') !== 'true';
      };

      const flowGenBtn = document.querySelector(
        'button.generate-icon-button, button[aria-label*="generation" i]'
      ) as HTMLButtonElement | null;
      if (isEnabled(flowGenBtn)) {
        const r = flowGenBtn!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }

      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of candidates) {
        const text = (btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        if (
          isEnabled(btn as HTMLElement) &&
          (/^generate$|^create video$|generate video|^start generation$/i.test(text) ||
          /^generate$|^create video$|generate video|^start generation$/i.test(aria) ||
          btn.classList.contains('generate-icon-button') ||
          (text.includes('arrow_forward') && aria.toLowerCase().includes('generation')))
        ) {
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });

    if (pt) {
      try {
        await page.mouse.move(pt.x - 40, pt.y - 20);
        await new Promise((r) => setTimeout(r, 80));
        await page.mouse.move(pt.x, pt.y, { steps: 5 });
        await new Promise((r) => setTimeout(r, 150));
        await page.mouse.click(pt.x, pt.y);
        clicked = true;
      } catch {
        clicked = await page.evaluate(() => {
          const btn = document.querySelector('button.generate-icon-button, button[aria-label*="generation" i]') as HTMLButtonElement | null;
          if (btn && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });
      }
    }

    if (clicked) return;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!clicked) {
    throw new Error('Generate button not found or remained disabled in Flow UI. Use --headed to inspect.');
  }
}

/**
 * Handles the generation confirmation / terms approval modal if presented.
 */
export async function approveGenerationModal(page: Page, timeoutMs: number = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const handled = await page.evaluate(() => {
      // 1. Check radio "Always approve"
      const alwaysRadio = document.querySelector('[role="radio"][aria-label*="Always approve" i]') as HTMLElement | null;
      if (alwaysRadio && !alwaysRadio.classList.contains('read-only')) {
        alwaysRadio.click();
      }

      // 2. Check radio "Approve"
      const approveRadio = document.querySelector('[role="radio"][aria-label*="Approve" i]') as HTMLElement | null;
      if (approveRadio && !approveRadio.classList.contains('read-only')) {
        approveRadio.click();
      }

      // 3. Check button containing "Approve" (e.g. "Approve", "checkApprove", "Always approve")
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of buttons) {
        const text = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
        if (/approve/i.test(text) && !/reject/i.test(text)) {
          const el = btn as HTMLElement;
          if (!el.hasAttribute('disabled') && !el.classList.contains('mat-mdc-button-disabled')) {
            el.click();
            return true;
          }
        }
      }

      return false;
    });

    if (handled) {
      await new Promise((r) => setTimeout(r, 500));
      return true;
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return false;
}

/**
 * Reads real-time Flow credits from in-page WIZ_global_data batchexecute RPC (ID: nzlxg).
 */
export async function readCreditsFromFlowRpc(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(async () => {
      const data = (window as unknown as { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data;
      const base = typeof data?.Im6cmf === 'string' ? data.Im6cmf : null;
      const build = typeof data?.cfb2h === 'string' ? data.cfb2h : null;
      const sessionId = typeof data?.FdrFJe === 'string' ? data.FdrFJe : null;
      const antiCsrf = typeof data?.SNlM0e === 'string' ? data.SNlM0e : null;

      if (!base || !build || !sessionId || !antiCsrf) return null;

      const query = new URLSearchParams({
        rpcids: 'nzlxg',
        'source-path': location.pathname || '/',
        bl: build,
        'f.sid': sessionId,
        hl: document.documentElement.lang || 'en',
        _reqid: String(Date.now() % 1_000_000),
        rt: 'c',
      });

      const request = new URLSearchParams({
        'f.req': '[[["nzlxg","[]",null,"generic"]]]',
        at: antiCsrf,
      });

      const response = await fetch(`${base}/data/batchexecute?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: request,
      });

      if (!response.ok) return null;
      const text = await response.text();
      const match = text.match(/"nzlxg","(\[[^"]+\])"/);
      if (!match) return null;

      const values = JSON.parse(match[1]) as unknown;
      if (!Array.isArray(values) || !Number.isFinite(values[0])) return null;
      return Number(values[0]);
    });
  } catch {
    return null;
  }
}

/**
 * Reads the REAL credit balance from the top-right avatar panel
 * ("Account details" → ".credits-count" → "N Google Flow credits").
 *
 * Opens the panel by clicking the avatar, polls up to 8s for the balance
 * element, closes the panel again so the canvas is left untouched, and THROWS
 * on any failure — a balance that cannot be read must never be guessed.
 */
export async function readCreditsFromDom(page: Page): Promise<number> {
  const balance = await page.evaluate(async () => {
    const accountBtn = document.querySelector('[aria-label="Account details"]') as HTMLElement | null;
    if (!accountBtn) {
      throw new Error('Account details (top-right avatar) button not found on the page');
    }

    accountBtn.click();

    const deadline = Date.now() + 8000;
    let balanceEl: Element | null = null;
    while (Date.now() < deadline) {
      balanceEl = document.querySelector('.credits-count');
      if (balanceEl && /\d/.test(balanceEl.textContent || '')) break;
      balanceEl = null;
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!balanceEl) {
      throw new Error('credits-count element did not appear after clicking the avatar');
    }
    const text = (balanceEl.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d[\d,]*)\s+Google Flow credits/i) || text.match(/(\d[\d,]*)/);
    if (!match) {
      throw new Error(`could not parse the credit balance from panel text: "${text}"`);
    }
    return Number(match[1].replace(/,/g, ''));
  });

  // Close the panel again so the page is left exactly as it was — and VERIFY it.
  // The previous single toggle-click could leave the account panel open with its
  // TRANSPARENT CDK backdrop covering the whole page; every later pointer event /
  // elementFromPoint hit that backdrop instead of the canvas cards, so the very
  // next right-click aim check failed with "hit unknown card" and aborted the
  // pipeline (verified live on run viral-1790819690913-6lmef4, clip 1 Animate).
  await ensureAccountPanelClosed(page);
  return balance;
}

/**
 * True while the account-details popover (or its backdrop) is still on the page.
 */
async function isAccountPanelOpen(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const backdrop = document.querySelector('.cdk-overlay-backdrop-showing');
    if (backdrop) return true;
    const pane = document.querySelector('.cdk-overlay-pane.flow-account-panel-overlay');
    return !!(pane && (pane as HTMLElement).offsetParent !== null);
  });
}

/**
 * Closes the account-details popover and verifies it is gone. Escalates through
 * the gestures that close it: real backdrop click (the user's close gesture,
 * verified working live) → avatar toggle click → Escape. Throws when the panel
 * cannot be closed: leaving it open would break every subsequent interaction.
 */
async function ensureAccountPanelClosed(page: Page): Promise<void> {
  if (!(await isAccountPanelOpen(page))) return;

  // Gesture 1: real mouse click on the transparent backdrop.
  await dismissTransparentOverlayBackdrop(page).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  if (!(await isAccountPanelOpen(page))) return;

  // Gesture 2: synthetic click on the avatar toggle (old behaviour).
  await page
    .evaluate(() => {
      const toggleBtn = document.querySelector('[aria-label="Account details"]') as HTMLElement | null;
      toggleBtn?.click();
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  if (!(await isAccountPanelOpen(page))) return;

  // Gesture 3: Escape key.
  await page.keyboard.press('Escape').catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  if (!(await isAccountPanelOpen(page))) return;

  throw new Error(
    'Flow account panel (credits popover) could not be closed after reading the balance — ' +
      'its transparent backdrop would intercept every later click on this page. ' +
      'The next pipeline run starts from a fresh page load and recovers.'
  );
}

/**
 * Reads the actual Flow credit balance: the avatar panel first (the
 * user-visible source of truth on flow.google.com), the internal batchexecute
 * RPC as a secondary read of the same number. Throws when both fail — never
 * silently fabricates or falls back to a local guess.
 */
export async function readActualFlowCredits(page: Page): Promise<number> {
  let avatarError: unknown;
  try {
    return await readCreditsFromDom(page);
  } catch (err) {
    avatarError = err;
  }

  const rpc = await readCreditsFromFlowRpc(page);
  if (rpc !== null) return rpc;

  throw new Error(
    `Could not read the Google Flow credit balance — avatar panel: ` +
      `${(avatarError as Error)?.message ?? 'unknown error'}; RPC fallback: returned no balance`
  );
}

/** True when the current page is Google Flow's "Project not found" (404) page. */
export async function isProjectNotFound(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      if (/\/404\?reason=project/.test(location.pathname + location.search)) return true;
      return /project not found/i.test(document.body?.innerText || '');
    });
  } catch {
    return false;
  }
}

/**
 * ── Google anti-abuse risk control: detection, refresh recovery, retry loop ──
 *
 * A rejected generation renders a "Failed / We noticed some unusual activity" tile
 * on the canvas (backend code PUBLIC_ERROR_UNUSUAL_ACTIVITY). That tile is transient
 * client state: a page refresh makes it disappear (user-verified). Until it is gone
 * every whole-page error scan would instantly abort later — otherwise healthy —
 * generations, and the demonstrated-working recovery gesture (refresh → click the
 * input box → Ctrl+V → Enter) was never retried.
 * See plan-fix-risk-control-refresh-retry.md.
 */
export const RISK_CONTROL_ERROR_RE =
  /noticed some unusual activity|unusual activity.*help center|PUBLIC_ERROR_UNUSUAL_ACTIVITY|UNUSUAL_ACTIVITY|anti[-\s]?abuse|rate[-\s.?]?limit/i;

/** Tight wording used when scanning rendered DOM text (avoids false positives). */
export const RISK_CONTROL_TEXT_RE =
  /noticed some unusual activity|unusual activity.*help center|PUBLIC_ERROR_UNUSUAL_ACTIVITY/i;

/** True when a message carries Google anti-abuse / risk-control wording. */
export function isRiskControlError(message: string): boolean {
  return RISK_CONTROL_ERROR_RE.test(message || '');
}

export interface FlowFailureState {
  /** Normalized texts of all canvas error tiles currently rendered. */
  errorTileTexts: string[];
  /** Whole-page body text carries the anti-abuse wording. */
  riskBodyText: boolean;
}

/**
 * Snapshots the failure state of the canvas (error tiles + risk wording).
 * Used both to decide when to refresh and as a BASELINE so stale failure tiles
 * can never abort a later generation.
 */
export async function readFlowFailureState(page: Page): Promise<FlowFailureState> {
  try {
    return await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('flow-error-tile, [class*="error-tile"]'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0);
      const bodyText = document.body?.innerText || '';
      return {
        errorTileTexts: tiles,
        riskBodyText: /noticed some unusual activity|unusual activity.*help center|PUBLIC_ERROR_UNUSUAL_ACTIVITY/i.test(bodyText),
      };
    });
  } catch {
    return { errorTileTexts: [], riskBodyText: false };
  }
}

/**
 * True when the current failure state is NEWER than the baseline (freshly failed
 * generation), false for failures that already existed before the attempt started.
 */
export function hasNewFlowFailure(current: FlowFailureState, baseline?: FlowFailureState): boolean {
  const known = new Set(baseline?.errorTileTexts ?? []);
  const knownCount = baseline?.errorTileTexts.length ?? 0;
  const newTile =
    current.errorTileTexts.length > knownCount ||
    current.errorTileTexts.some((t) => !known.has(t));
  const newBodyRisk = current.riskBodyText && !baseline?.riskBodyText;
  return newTile || newBodyRisk;
}

/** True when a Google risk-control failure tile / warning is currently rendered. */
export async function hasRiskControlTile(page: Page): Promise<boolean> {
  const state = await readFlowFailureState(page);
  return state.riskBodyText || state.errorTileTexts.some((t) => RISK_CONTROL_TEXT_RE.test(t));
}

/** True when the page currently shows a Chromium network error page. */
export async function isBrowserErrorPage(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const text = `${document.title || ''} ${document.body?.innerText || ''}`;
      return /this site can'?t be reached|took too long to respond|err_(timed_out|connection_refused|network_changed|internet_disconnected|address_unreachable)|no internet/i.test(
        text
      );
    });
  } catch {
    return false;
  }
}

/** True when an error is a transient generation failure (backend glitch, queue reject) worth refreshing and retrying. */
export function isTransientGenerationError(message: string): boolean {
  // The frame-picker / video-mode-control errors are transient UI states: the
  // prompt box may still render (or still be recovering from the previous step)
  // when the code looks for them — a page refresh re-renders the controls.
  return (/something went wrong|failed to generate|generation rejected|try again|could not find "(?:start|end)" frame button|asset picker overlay did not open|could not click matching asset|video mode controls did not render/i.test(
    message || ''
  ));
}

/**
 * Waits for the Frames-mode Start/End triggers to mount in the prompt box after
 * video settings were configured. Flow's prompt box renders asynchronously; when
 * the controls never appear (stale UI state), selecting frames would fail later
 * with a cryptic error — fail fast here instead.
 */
export async function waitForFramesControls(page: Page, label: string, timeoutMs: number = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const triggers = document.querySelectorAll(
          '.frame-trigger, flow-ingredient-bar button.empty-chip, flow-ingredient-bar flow-image-ingredient-chip'
        );
        return triggers.length > 0;
      })
      .catch(() => false);
    if (ready) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label}: video mode controls did not render (.frame-trigger missing after settings)`);
}

/** True when an error is a transient page/navigation condition worth retrying. */
export function isTransientPageError(message: string): boolean {
  return /Execution context was destroyed|most likely because of a navigation|net::ERR_|ERR_TIMED_OUT|could not be restored/i.test(
    message || ''
  );
}

/**
 * Refreshes the Flow page so the transient risk-control tile disappears (and any
 * stale client / reCAPTCHA state is dropped), then waits for the prompt editor to
 * come back — the user-verified first step before re-trying the paste + Enter.
 *
 * Network hiccups are absorbed here (up to `maxReloads` navigations with pauses):
 * a Chromium error page or a destroyed execution context must not permanently
 * break the generation attempt.
 */
export async function refreshToClearRiskControl(
  page: Page,
  options?: { timeoutMs?: number; note?: string; maxReloads?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const maxReloads = Math.max(1, options?.maxReloads ?? 3);
  const hadRiskTile = await hasRiskControlTile(page).catch(() => false);
  console.log(
    picocolors.gray(
      `[flow-dom] ${options?.note ?? 'Refreshing Flow page'} (clears the risk-control tile before click → Ctrl+V → Enter)...`
    )
  );

  const url = page.url();
  for (let reload = 1; reload <= maxReloads; reload++) {
    try {
      if (/^https?:/i.test(url)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      }
    } catch (err: any) {
      if (reload >= maxReloads) {
        throw new Error(
          `Flow page could not be refreshed after ${maxReloads} attempt(s): ${err?.message || err}`
        );
      }
      console.warn(
        picocolors.yellow(
          `[flow-dom] Refresh attempt ${reload}/${maxReloads} failed (${(err?.message || '').slice(0, 100)}) — retrying in 5s`
        )
      );
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    if (await isBrowserErrorPage(page).catch(() => false)) {
      if (reload >= maxReloads) {
        throw new Error(
          `Flow page could not be restored after ${maxReloads} refresh attempt(s): browser network error page (ERR_TIMED_OUT / offline?)`
        );
      }
      console.warn(
        picocolors.yellow(
          `[flow-dom] Refresh attempt ${reload}/${maxReloads} landed on a network error page — retrying in 8s`
        )
      );
      await new Promise((r) => setTimeout(r, 8_000));
      continue;
    }

    try {
      await waitForEditor(page, timeoutMs);
      await dismissCookieBanner(page).catch(() => {});
      // Wait for settings trigger button to render so isDirectSettingsSatisfied can read it
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.settings-summary, .settings-trigger-button');
          return el && (el.textContent || '').trim().length > 0;
        },
        undefined,
        { timeout: 8_000 }
      ).catch(() => {});
    } catch (err: any) {
      if (reload >= maxReloads) {
        throw new Error(
          `Flow page could not be restored after ${maxReloads} refresh attempt(s): ${err?.message || err}`
        );
      }
      console.warn(
        picocolors.yellow(
          `[flow-dom] Editor not ready after refresh attempt ${reload}/${maxReloads} — retrying in 5s`
        )
      );
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    const stillAtRisk = await hasRiskControlTile(page).catch(() => false);
    if (hadRiskTile && !stillAtRisk) {
      console.log(picocolors.green('[flow-dom] ✓ Risk-control tile cleared by page refresh'));
    } else if (stillAtRisk) {
      console.warn(
        picocolors.yellow(
          '[flow-dom] Risk-control tile still rendered after refresh — continuing (failure detection is baseline-scoped)'
        )
      );
    }
    return;
  }
}

export interface RiskRetryOptions {
  label: string;
  /** Preserve a ready project on the first attempt; failures still refresh before retry. */
  refreshFirstAttempt?: boolean;
  /** Total attempts including the first one (env FLOW_RISK_RETRY_ATTEMPTS when omitted). */
  maxAttempts?: number;
  /** Randomized backoff window between attempts in seconds. */
  retryDelaySec?: [number, number];
}

/**
 * Runs one generation attempt (click input box → Ctrl+V → Enter → await result),
 * recovering from Google risk control exactly the way the user verified manually:
 * retries start with a page refresh that clears the risk tile; a rejected
 * attempt is retried after a human-like randomized pause — until it passes risk
 * control or the attempt budget is exhausted. Non-risk errors are never retried.
 */
export async function withRiskControlRetry<T>(
  page: Page,
  options: RiskRetryOptions,
  attempt: (attemptNo: number) => Promise<T>
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? RISK_RETRY_ATTEMPTS);
  const [minSec, maxSec] = options.retryDelaySec ?? [RISK_RETRY_DELAY_MIN_SEC, RISK_RETRY_DELAY_MAX_SEC];

  let lastError: unknown = null;
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    try {
      if (attemptNo > 1 || options.refreshFirstAttempt !== false || await hasRiskControlTile(page)) {
        await refreshToClearRiskControl(page, {
          note:
            attemptNo === 1
              ? 'Refreshing Flow page before generation attempt'
              : `Refreshing Flow page before retry attempt ${attemptNo}/${maxAttempts}`,
        });
      }

      return await attempt(attemptNo);
    } catch (err: any) {
      lastError = err;
      const message = err?.message || String(err);
      const retryable =
        isRiskControlError(message) ||
        isTransientGenerationError(message) ||
        isTransientPageError(message);
      if (!retryable || attemptNo >= maxAttempts) throw err;

      const delaySec = minSec + Math.random() * Math.max(maxSec - minSec, 0);
      const reasonKind = isRiskControlError(message)
        ? 'Google risk control'
        : isTransientGenerationError(message)
        ? 'transient backend/generation error'
        : 'transient page error';
      console.warn(
        picocolors.yellow(
          `[flow-dom] ${options.label}: ${reasonKind} ` +
            `on attempt ${attemptNo}/${maxAttempts} — refreshing and retrying the click → Ctrl+V → Enter gesture in ${delaySec.toFixed(0)}s. ` +
            `Cause: ${message.slice(0, 160)}`
        )
      );
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Waits for generation request to be queued by Flow backend.
 *
 * `failureBaseline` scopes failure detection to failures that appeared AFTER the
 * attempt started — stale risk tiles on the canvas must not abort a new generation.
 */
export async function waitForGenerationQueued(
  page: Page,
  timeoutMs: number = 15_000,
  failureBaseline?: FlowFailureState
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check for explicit error card on page first
    const errorMsg = await page.evaluate(() => {
      const errCard = document.querySelector('.chat-error-card, .error-header, mat-error');
      if (errCard) {
        const text = errCard.textContent?.trim() || '';
        if (/something went wrong/i.test(text) || /error/i.test(text)) {
          return text;
        }
      }
      const bodyText = document.body?.innerText || '';
      if (/something went wrong\. please try again/i.test(bodyText)) {
        return 'Something went wrong. Please try again.';
      }
      return null;
    });

    if (errorMsg) {
      throw new Error(`Google Flow generation rejected: ${errorMsg}`);
    }

    const failure = await readFlowFailureState(page);
    if (hasNewFlowFailure(failure, failureBaseline)) {
      const riskText =
        failure.errorTileTexts.find((t) => RISK_CONTROL_TEXT_RE.test(t)) ||
        (failure.riskBodyText
          ? 'Google Flow anti-abuse: We noticed some unusual activity. Please visit the Help Center for more information.'
          : null);
      throw new Error(`Google Flow generation rejected: ${riskText ?? failure.errorTileTexts[0]}`);
    }

    const queued = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const stopBtn = Array.from(document.querySelectorAll('button, [role="button"]')).some(
        (b) => /^stop$/i.test((b.textContent || '').trim())
      );
      return text.includes('scheduled and is waiting in the queue') || stopBtn;
    });

    if (queued) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export interface GenerationProgressSignals {
  busy: boolean;
  /** Human-readable descriptions of which signals reported "busy" (for diagnostics). */
  reasons: string[];
}

/**
 * Reads the individual in-progress generation signals on the Flow canvas.
 *
 * IMPORTANT (learned from live debugging, see plan-fix-canvas-idle-false-positive.md):
 * a COMPLETED video tile keeps visible player chrome in the DOM —
 * `div.progress-bar`, `div.hover-overlay-has-progress-bar`,
 * `div.footer-overlay-has-progress-bar`. A broad `[class*="progress"]` /
 * `[class*="pending"]` selector therefore reports "busy" forever after a video
 * finishes and stalled every inter-step pacing for the full 10-minute timeout.
 * Only signals that genuinely disappear on completion are used here:
 * the `.loading-percentage` overlay, percentage text, an active ARIA
 * progressbar, a visible Stop button, the queued banner, and tile state text.
 */
export async function readGenerationProgressSignals(page: Page): Promise<GenerationProgressSignals> {
  return page
    .evaluate(() => {
      const reasons: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      const bodyText = document.body?.innerText || '';

      // 1) Generation progress overlay: Flow renders `.loading-percentage` on a
      //    tile ONLY while it is generating; it is removed once the tile completes.
      for (const el of document.querySelectorAll('[class*="loading-percentage"]')) {
        if (isVisible(el)) {
          reasons.push(`loading-percentage overlay "${(el.textContent || '').trim().slice(0, 16)}"`);
          break;
        }
      }

      // 2) Percentage progress text anywhere, e.g. "45%" (generation indicator;
      //    never observed on an idle/completed canvas).
      const pct = bodyText.match(/\b\d{1,3}\s*%\b/);
      if (pct) reasons.push(`percentage text "${pct[0]}"`);

      // 3) Active ARIA progressbar (visible and not finished). Completed bars
      //    pinned at 100% are ignored; visible indeterminate bars count.
      for (const el of document.querySelectorAll('[role="progressbar"]')) {
        if (!isVisible(el)) continue;
        const now = el.getAttribute('aria-valuenow');
        if (now !== null && Number(now) >= 100) continue;
        reasons.push('active ARIA progressbar');
        break;
      }

      // 4) Stop button visible => generation still running.
      //    Must exclude ingredient / frame chip remove buttons (e.g. material icon "cancel").
      const stopBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
        if (!isVisible(b)) return false;
        if (b.closest('.frame-trigger, flow-ingredient-chip, [class*="chip"], [class*="attachment"]')) {
          return false;
        }
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (/remove|delete|clear|dismiss/i.test(aria)) return false;
        const text = (b.textContent || '').trim().toLowerCase();
        return text === 'stop' || /stop generation/i.test(aria) || /cancel generation/i.test(aria);
      });
      if (stopBtn) reasons.push('Stop generation button');

      // 5) Queued banner
      if (/scheduled and is waiting in the queue/i.test(bodyText)) reasons.push('queued banner');

      // 6) Generating/processing text on visible video tiles
      const genText = /\b(generating|processing|queued|pending)\b/i;
      for (const t of document.querySelectorAll('flow-video-tile, [class*="video-tile"], [class*="grid-tile"]')) {
        if (isVisible(t) && genText.test(t.textContent || '')) {
          reasons.push(
            `tile state text "${(t.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48)}"`
          );
          break;
        }
      }

      return { busy: reasons.length > 0, reasons };
    })
    .catch(() => ({ busy: false, reasons: [] as string[] }));
}

/**
 * Detects whether ANY generation is still in progress on the canvas
 * (percentage progress overlay, "Generating" state, Stop button, or queued
 * banner). Shared by FlowVideoObserver and the inter-step pacing logic —
 * while this returns true, no new generation should be submitted.
 */
export async function hasActiveGenerationProgressOnPage(page: Page): Promise<boolean> {
  return (await readGenerationProgressSignals(page)).busy;
}

export interface CanvasIdleWaitOptions {
  /** Max time to wait for the canvas to become idle (default 10 min). */
  timeoutMs?: number;
  /** Delay between progress polls (default 3s). */
  pollIntervalMs?: number;
  /** Consecutive idle polls required before the canvas is considered settled (default 2). */
  idlePollsRequired?: number;
  /** Label used in progress logs. */
  label?: string;
}

/**
 * Progress-driven pacing primitive: waits until the Flow canvas reports NO
 * in-progress generation (previous image/video fully settled). Returns true
 * when the canvas is idle, false when the timeout was hit while still busy.
 * Pure DOM observation — no clicks, no keystrokes, no page reloads.
 */
export async function waitForCanvasIdle(page: Page, options: CanvasIdleWaitOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const idlePollsRequired = Math.max(1, options.idlePollsRequired ?? 2);
  const label = options.label ?? 'canvas idle check';
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let idleStreak = 0;
  let busyPolls = 0;
  let lastLogAt = 0;

  let lastReasons = '';
  while (Date.now() < deadline) {
    const signals = await readGenerationProgressSignals(page);
    if (!signals.busy) {
      idleStreak++;
      if (idleStreak >= idlePollsRequired) {
        const waitedSec = Math.round((Date.now() - startedAt) / 1000);
        if (busyPolls > 0) {
          console.log(
            picocolors.green(`[flow-dom] ${label}: canvas idle (generation settled) after ${waitedSec}s`)
          );
        }
        return true;
      }
    } else {
      idleStreak = 0;
      busyPolls++;
      const now = Date.now();
      const reasonText = signals.reasons.join('; ') || 'unknown signal';
      // Log on a 15s cadence, and immediately whenever the busy reason changes
      // (e.g. a new false-positive source) so stalls are diagnosable from logs.
      if (now - lastLogAt >= 15_000 || reasonText !== lastReasons) {
        lastLogAt = now;
        lastReasons = reasonText;
        console.log(
          picocolors.gray(
            `[flow-dom] ${label}: generation in progress — waiting for completion before the next step ` +
              `(${Math.round((now - startedAt) / 1000)}s elapsed) [${reasonText}]`
          )
        );
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  console.warn(
    picocolors.yellow(
      `[flow-dom] ${label}: canvas still busy after ${Math.round(timeoutMs / 1000)}s idle wait`
    )
  );
  return false;
}

/**
 * Captures textual DOM and screenshot evidence to debug directory.
 */
export async function captureEvidence(page: Page, label: string, debugDir?: string): Promise<void> {
  if (!debugDir) return;
  try {
    await mkdir(debugDir, { recursive: true, mode: 0o700 });
    const dom = await page.evaluate(() => document.body?.innerText || '');
    await writeFile(path.join(debugDir, `${label}.dom.txt`), dom, { mode: 0o600 });
    // fullPage MUST stay false:
    // In Puppeteer, `fullPage: true` internally calls CDP `Emulation.setDeviceMetricsOverride`
    // to resize the viewport to the page's scroll size (exceeding screen dimensions like 1600x900)
    // and fires window resize events. This causes visible flickering/resolution jumping
    // right before and after prompt paste and trips Google anti-abuse risk control.
    await page.screenshot({
      path: path.join(debugDir, `${label}.png`),
      fullPage: false,
    });
  } catch {
    // Best-effort debug capture
  }
}

/**
 * Counts ALL grid tiles (image + video + pending) currently visible in the Flow project grid.
 * Note: `waitForNewImageTile` now detects new image cards by identity (card keys from
 * `listMediaTiles` / `getImageTiles`), not by this broad count.
 */
export async function countAllGridTiles(page: Page): Promise<number> {
  return await page.evaluate(() => {
    return document.querySelectorAll(
      'flow-image-tile, flow-video-tile, flow-grid-tile-container, [class*="image-tile"], [class*="video-tile"], [class*="grid-tile"], [data-type="image"], [data-type="video"]'
    ).length;
  });
}

/**
 * Counts the number of image-only cards currently visible in the Flow project grid
 * (video cards and video-card poster wrappers are excluded by classification).
 * Pairs with the numeric baseline of `waitForNewImageTile`; prefer passing card keys.
 */
export async function countImageTiles(page: Page): Promise<number> {
  const tiles = await listMediaTiles(page);
  return tiles.filter((t) => t.kind === 'image').length;
}

/**
 * Extracts image tile metadata from the Flow project grid.
 */
export interface FlowImageTile {
  index: number;
  mediaId: string | null;
  src: string | null;
  alt: string | null;
  rect: { x: number; y: number; width: number; height: number };
  /** Stable card identity (data-media-id / img src / element id). */
  key?: string | null;
  /** Card classification. */
  kind?: 'image' | 'video';
}

/** A classified canvas card (image or video) resolved to its card root. */
export interface MediaTileInfo extends FlowImageTile {
  kind: 'image' | 'video';
  key: string | null;
}

/**
 * In-page helpers shared by all media-tile routines.
 *
 * Card classification is deliberately defensive: ANY element nested inside a video
 * card (`flow-video-tile`, `[class*="video-tile"]`, `[data-type="video"]`, or a card
 * containing a <video>) is classified as VIDEO. This prevents poster/thumb wrappers
 * inside video cards (e.g. `<div class="...image-tile...">`) from being mistaken for
 * image cards — which previously made right-clicks land on video cards when
 * referencing the previous image or triggering "Animate".
 *
 * Nested candidates also collapse into a single outermost "card root", so every card
 * has exactly one stable identity (`data-media-id` / `img.src` / `id`).
 */
const MEDIA_TILE_HELPERS = `
  const CANDIDATE_SEL = 'flow-image-tile, flow-video-tile, [class*="image-tile"], [class*="video-tile"], [data-type="image"], [data-type="video"]';
  const VIDEO_SEL = 'flow-video-tile, [class*="video-tile"], [data-type="video"]';
  const IMAGE_SEL = 'flow-image-tile, [data-type="image"]';

  function classify(el) {
    if (el.closest(VIDEO_SEL)) return 'video';
    if (el.matches(IMAGE_SEL)) return 'image';
    if (el.querySelector('video')) return 'video';
    if (el.querySelector('img')) return 'image';
    return 'unknown';
  }

  function tileKey(el) {
    const img = el.querySelector('img');
    // The stable media UUID lives on the inner <img data-media-id>; the img src is a
    // volatile signed/proxy URL that changes across page refreshes.
    return el.getAttribute('data-media-id') || el.getAttribute('data-name') || el.id ||
      (img && (img.getAttribute('data-media-id') || img.getAttribute('data-name'))) ||
      (img && img.src) || null;
  }

  // Identity tokens for a media reference: raw value, query-less form, URL
  // origin+path and any embedded media UUID — so a card recorded as
  // https://flow-content.google/image/<uuid>?... still matches the same card after a
  // page refresh re-issues its signed/proxy URLs.
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  function identityTokens(u) {
    if (!u) return [];
    const s = String(u);
    const out = [s, s.split('?')[0]];
    if (/^(https?:)?\\/\\//i.test(s)) {
      try {
        const p = new URL(s, location.href);
        out.push(p.origin + p.pathname);
      } catch {}
    }
    const m = s.match(UUID_RE);
    if (m) out.push(m[0].toLowerCase());
    return out;
  }

  // Collapse nested candidates of the same kind into the outermost card element.
  function collapse(el, kind) {
    const SEL = kind === 'video' ? VIDEO_SEL : CANDIDATE_SEL;
    let node = el;
    let p = node.parentElement && node.parentElement.closest(SEL);
    while (p && (kind === 'video' || classify(p) === 'image')) {
      node = p;
      p = node.parentElement && node.parentElement.closest(SEL);
    }
    return node;
  }

  // Resolve any element (candidate or arbitrary hit element) to its owning card.
  function resolveCard(el) {
    const node = el.closest(CANDIDATE_SEL) || el;
    const kind = classify(node);
    const root = kind === 'unknown' ? node : collapse(node, kind);
    return { el: root, kind: classify(root), key: tileKey(root) };
  }

  function collectCards() {
    const seen = new Set();
    const cards = [];
    for (const el of Array.from(document.querySelectorAll(CANDIDATE_SEL))) {
      const card = resolveCard(el);
      if (card.kind === 'unknown' || seen.has(card.el)) continue;
      seen.add(card.el);
      cards.push(card);
    }
    return cards;
  }

  // Classification-independent identity search across the WHOLE document: a card
  // whose media identity is present but whose element sits outside the known tile
  // selectors (Flow DOM churn) or whose tile is still a skeleton can still be found.
  // Callers MUST re-classify via resolveCard before aiming — identity alone never
  // justifies a click.
  function findIdentityElement(matchIds) {
    if (!matchIds || matchIds.length === 0) return null;
    const nodes = Array.from(document.querySelectorAll('[data-media-id], [data-name], img[src], [id]'));
    for (const el of nodes) {
      const values = [
        el.getAttribute('data-media-id'),
        el.getAttribute('data-name'),
        el.id || null,
        el.tagName === 'IMG' ? el.getAttribute('src') : null,
      ].filter(Boolean);
      const ids = values.flatMap((v) => identityTokens(v));
      if (matchIds.some((m) => ids.includes(m))) return el;
    }
    return null;
  }
`;

/**
 * Lists all classified canvas cards (image + video) in DOM order.
 */
export async function listMediaTiles(page: Page): Promise<MediaTileInfo[]> {
  return (await page.evaluate(`(() => {
    ${MEDIA_TILE_HELPERS}
    return collectCards().map((card, index) => {
      const img = card.el.querySelector('img');
      const r = card.el.getBoundingClientRect();
      return {
        index,
        kind: card.kind,
        key: card.key,
        mediaId: card.el.getAttribute('data-media-id') || null,
        src: (img && img.src) || null,
        alt: (img && img.alt) || card.el.getAttribute('aria-label') || null,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      };
    });
  })()`)) as MediaTileInfo[];
}

export async function getImageTiles(page: Page): Promise<FlowImageTile[]> {
  const tiles = await listMediaTiles(page);
  return tiles.filter((t) => t.kind === 'image');
}

export interface RightClickTileOptions {
  /** Which card kind may be right-clicked. Defaults to 'image'. */
  expect?: 'image' | 'video';
  /** Target one exact card by its stable identity (MediaTileInfo.key). */
  matchKey?: string | null;
  /** Target one exact card by its image src. */
  matchSrc?: string | null;
}

/**
 * Dismisses a leftover TRANSPARENT CDK overlay backdrop (popover-style overlay,
 * e.g. the account-details panel) that intercepts every pointer event on the
 * page: with it showing, `elementFromPoint` resolves every point to the backdrop
 * and no canvas card can be aimed at or clicked (observed live: run
 * viral-1790819690913-6lmef4 — the aim check hit "unknown" everywhere).
 *
 * Uses a REAL mouse click near the backdrop's top-left — the user's close
 * gesture for popovers — verified working against the live Flow UI. Only
 * TRANSPARENT backdrops are targeted; visible dialog backdrops (approval modals
 * etc.) have their own handling and are deliberately left alone.
 *
 * Returns true when a backdrop was found and is gone after the click.
 */
export async function dismissTransparentOverlayBackdrop(page: Page): Promise<boolean> {
  const pt = await page.evaluate(() => {
    const backdrop = document.querySelector(
      '.cdk-overlay-backdrop.cdk-overlay-transparent-backdrop.cdk-overlay-backdrop-showing'
    ) as HTMLElement | null;
    if (!backdrop) return null;
    const r = backdrop.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    // A point in the backdrop's top-left region, away from the typical popover
    // positions (top-right for the account panel), so the click lands on empty
    // backdrop and cannot touch the pane itself.
    return { x: Math.max(8, r.left + 40), y: Math.max(8, r.top + 40) };
  });
  if (!pt) return false;

  await page.mouse.click(pt.x, pt.y);
  await new Promise((r) => setTimeout(r, 600));

  return await page.evaluate(() => {
    return !document.querySelector(
      '.cdk-overlay-backdrop.cdk-overlay-transparent-backdrop.cdk-overlay-backdrop-showing'
    );
  });
}

export interface SweepForCardOptions {
  /** Which card kind may be matched. Defaults to 'image'. */
  expect?: 'image' | 'video';
  /** Target one exact card by its stable identity (MediaTileInfo.key). */
  matchKey?: string | null;
  /** Target one exact card by its image src. */
  matchSrc?: string | null;
  /** Scroll step in px. Defaults to ~0.75 viewport height. */
  stepPx?: number;
  /** Safety cap on scroll steps. */
  maxSteps?: number;
  /** Settle time after each scroll step, letting newly revealed cards render. */
  settleMs?: number;
}

/**
 * Incremental viewport-by-viewport sweep of the project canvas to surface ONE
 * identity-matched card. Unlike scrollToBottomToLoadAll (which scrolls to the end
 * and only then re-checks), this probes the DOM after EVERY scroll step and stops
 * the moment the target card mounts — with a virtualized feed a full scroll would
 * mount the card transiently and unmount it again before the check runs.
 *
 * The sweep restarts from the very top of the feed and walks down; scrolling uses
 * trusted CDP wheel events first (JS scrollTop assignment as fallback, same
 * rationale as scrollToBottomToLoadAll). When the card is found the sweep stops
 * immediately, leaving it mounted in the viewport for a subsequent aim check.
 */
export async function sweepCanvasForTargetCard(
  page: Page,
  options: SweepForCardOptions
): Promise<{ found: boolean; steps: number; mountedKeys: string[] }> {
  const expectKind = options.expect ?? 'image';
  const settleMs = options.settleMs ?? 700;
  const maxSteps = options.maxSteps ?? 40;

  const probe = async (): Promise<{ found: boolean; keys: string[] }> => {
    return (await page.evaluate(`(() => {
      ${MEDIA_TILE_HELPERS}
      const expectKind = ${JSON.stringify(expectKind)};
      const matchKey = ${JSON.stringify(options.matchKey ?? null)};
      const matchSrc = ${JSON.stringify(options.matchSrc ?? null)};
      const matchIds = [matchKey, matchSrc].filter(Boolean).flatMap((v) => identityTokens(v));

      const cards = collectCards().filter((c) => c.kind === expectKind);
      let hit = cards.find((c) => {
        const img = c.el.querySelector('img');
        const ids = [c.key, (img && img.src) || null, (img && img.getAttribute('data-media-id')) || null]
          .filter(Boolean).flatMap((v) => identityTokens(v));
        return matchIds.some((m) => ids.includes(m));
      }) || null;
      if (!hit) {
        const stray = findIdentityElement(matchIds);
        const strayCard = stray ? resolveCard(stray) : null;
        if (strayCard && strayCard.kind === expectKind) hit = strayCard;
      }
      return { found: !!hit, keys: cards.map((c) => c.key).filter(Boolean).slice(0, 12) };
    })()`)) as { found: boolean; keys: string[] };
  };

  const readScrollState = async (): Promise<{ st: number; sh: number; ch: number } | null> => {
    return await page.evaluate(() => {
      const docSh = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      const winSt = window.scrollY || window.pageYOffset || 0;
      const winCh = window.innerHeight || 0;
      if (docSh > winCh + 10) return { st: winSt, sh: docSh, ch: winCh };
      const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
      });
      scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = scrollables[0] as HTMLElement | undefined;
      if (!target) return { st: winSt, sh: docSh, ch: winCh };
      return { st: target.scrollTop, sh: target.scrollHeight, ch: target.clientHeight };
    }).catch(() => null);
  };

  // Probe first — the card may already be mounted right where the canvas is.
  let lastKeys: string[] = [];
  const initial = await probe().catch(() => ({ found: false, keys: [] as string[] }));
  if (initial.found) return { found: true, steps: 0, mountedKeys: initial.keys };
  lastKeys = initial.keys;

  // Viewport metrics + the primary scroll container's centre (a wheel event only
  // scrolls the element under the pointer).
  const metrics = await page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
      const style = window.getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10;
    });
    scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const target = scrollables[0];
    const rect = target ? target.getBoundingClientRect() : null;
    return {
      vh: window.innerHeight || 800,
      cx: rect ? Math.min(Math.max(rect.x + rect.width / 2, 10), window.innerWidth - 10) : 760,
      cy: rect ? Math.min(Math.max(rect.y + rect.height / 2, 10), window.innerHeight - 10) : 400,
    };
  }).catch(() => ({ vh: 800, cx: 760, cy: 400 }));
  const stepPx = options.stepPx ?? Math.max(400, Math.round(metrics.vh * 0.75));

  // Restart from the very top so one pass covers the whole feed.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
      const style = window.getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    });
    for (const el of scrollables) el.scrollTop = 0;
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, settleMs));

  let steps = 0;
  let stagnant = 0;
  while (steps < maxSteps) {
    const before = await readScrollState();

    let usedTrustedWheel = false;
    try {
      await page.mouse.move(metrics.cx, metrics.cy, { steps: 3 });
      await page.mouse.wheel(0, stepPx);
      usedTrustedWheel = true;
    } catch {
      // Wheel dispatch can time out on a busy page — the JS step below still runs.
    }
    await new Promise((r) => setTimeout(r, 150));

    const mid = await readScrollState();
    const progressed = before && mid ? mid.st > before.st : !usedTrustedWheel;
    if (!progressed) {
      await page.evaluate((s) => {
        window.scrollBy(0, s);
        const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        for (const el of scrollables) {
          if (el.scrollTop + el.clientHeight < el.scrollHeight) {
            el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + s);
          }
        }
      }, stepPx).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, settleMs));
    steps++;

    const hit = await probe().catch(() => ({ found: false, keys: [] as string[] }));
    if (hit.found) return { found: true, steps, mountedKeys: hit.keys };
    lastKeys = hit.keys;

    const after = await readScrollState();
    const atBottom = after ? after.st + after.ch >= after.sh - 5 : true;
    stagnant = before && after && Math.abs(after.st - before.st) < 2 ? stagnant + 1 : 0;
    if (stagnant >= 2 && atBottom) break;
  }

  return { found: false, steps, mountedKeys: lastKeys };
}

/**
 * Locates a classified media card on the Flow project canvas and right-clicks it using
 * Puppeteer synthetic events. Angular / Material event bindings strictly require
 * Puppeteer's mouse.click({ button: 'right' }).
 *
 * Targeting is verified BEFORE the click: a set of probe points inside the card
 * (the actual <img> surface first, then the card root — centre first, then
 * spreading toward the edges) is hit-tested (`elementFromPoint`) and the click is
 * dispatched at the FIRST point that resolves to the very same card root of the
 * expected kind. A right-click can therefore never silently land on a video card
 * when an image card was requested (and vice versa), while a card whose centre is
 * covered (sticky prompt box, leftover transparent overlay backdrop, wrapper
 * larger than the visible tile) is still clicked on a genuinely visible point.
 *
 * When a leftover TRANSPARENT overlay backdrop covers the page, it is dismissed
 * with a real click (see dismissTransparentOverlayBackdrop) before retrying.
 */
export async function rightClickImageTile(
  page: Page,
  tileIndex?: number,
  options?: RightClickTileOptions
): Promise<{ x: number; y: number }> {
  await dismissCookieBanner(page).catch(() => {});
  const expectKind = options?.expect ?? 'image';
  const targetDesc =
    options?.matchKey ? `${expectKind} card "${options.matchKey}"`
    : options?.matchSrc ? `${expectKind} card "${options.matchSrc}"`
    : tileIndex !== undefined ? `${expectKind} card #${tileIndex}`
    : `latest ${expectKind} card`;

  // Wait a moment for any DOM transitions
  await new Promise((r) => setTimeout(r, 500));

  // Dismiss any open menus or overlays first
  await page.keyboard.press('Escape').catch(() => {});
  await new Promise((r) => setTimeout(r, 300));

  let lastProblem = 'target card not found on the canvas';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const point = (await page.evaluate(`(async () => {
      ${MEDIA_TILE_HELPERS}
      const expectKind = ${JSON.stringify(expectKind)};
      const targetIdx = ${tileIndex === undefined ? 'undefined' : Number(tileIndex)};
      const matchKey = ${JSON.stringify(options?.matchKey ?? null)};
      const matchSrc = ${JSON.stringify(options?.matchSrc ?? null)};

      const matchIds = [matchKey, matchSrc].filter(Boolean).flatMap((v) => identityTokens(v));

      const cards = collectCards().filter((c) => c.kind === expectKind);
      let target = null;
      if (matchKey || matchSrc) {
        target = cards.find((c) => {
          const img = c.el.querySelector('img');
          const src = (img && img.src) || null;
          const mediaId = (img && img.getAttribute('data-media-id')) || null;
          const ids = [c.key, src, mediaId].filter(Boolean).flatMap((v) => identityTokens(v));
          return matchIds.some((m) => ids.includes(m));
        }) || null;
        // Classification-independent fallback: the identity may sit on an element
        // outside the known tile selectors. resolveCard must still classify it as
        // the expected kind before it can ever be aimed at.
        if (!target) {
          const stray = findIdentityElement(matchIds);
          const strayCard = stray ? resolveCard(stray) : null;
          if (strayCard && strayCard.kind === expectKind) target = strayCard;
        }
      } else if (targetIdx !== undefined && targetIdx >= 0 && targetIdx < cards.length) {
        target = cards[targetIdx];
      } else if (cards.length > 0) {
        target = cards[cards.length - 1];
      }
      if (!target) {
        const stray = (matchKey || matchSrc) ? findIdentityElement(matchIds) : null;
        const strayCard = stray ? resolveCard(stray) : null;
        // Identity mounted as a DIFFERENT definite card kind (e.g. an image
        // action targeting a video card): sweeping/reloading can never convert
        // one kind into the other — report it so the caller refuses immediately
        // instead of burning six sweep/reload rounds and risking a wrong click.
        // 'unknown' stays on the retry path: the element exists but its tile may
        // still be a skeleton that renders into the expected kind later.
        return {
          found: false,
          totalCards: cards.length,
          imageKeys: cards.map((c) => c.key).filter(Boolean).slice(0, 12),
          presentUnclassified: !!stray,
          wrongKind: strayCard && strayCard.kind !== 'unknown' && strayCard.kind !== expectKind ? strayCard.kind : null,
        };
      }

      function describeEl(el) {
        if (!el) return 'null';
        const cls = (typeof el.className === 'string' && el.className.trim())
          ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
          : '';
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
      }

      // Instant (non-animated) scroll, then wait for the card rect to SETTLE:
      // with CSS scroll-behavior: smooth the rect is otherwise measured
      // mid-animation. rAF is raced against a timeout so a throttled background
      // tab cannot stall the loop.
      target.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      let prev = target.el.getBoundingClientRect();
      for (let i = 0; i < 10; i++) {
        await Promise.race([
          new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
          new Promise((res) => setTimeout(res, 100)),
        ]);
        const now = target.el.getBoundingClientRect();
        if (Math.abs(now.left - prev.left) < 1 && Math.abs(now.top - prev.top) < 1 &&
            Math.abs(now.width - prev.width) < 1 && Math.abs(now.height - prev.height) < 1) break;
        prev = now;
      }

      const rootRect = target.el.getBoundingClientRect();
      const img = target.el.querySelector('img');
      const imgRect = img ? img.getBoundingClientRect() : null;

      // Probe surfaces: the actual media (<img>) first — the card root may be a
      // wrapper larger than the visible tile, whose centre can fall outside the
      // visible surface (onto the grid background → "unknown").
      const surfaces = [];
      if (imgRect && imgRect.width >= 10 && imgRect.height >= 10) surfaces.push(imgRect);
      if (rootRect.width >= 10 && rootRect.height >= 10) surfaces.push(rootRect);

      // Ordered probe fractions: centre first, then spreading toward the edges —
      // a partially covered card (e.g. behind the sticky prompt box) is clicked
      // on a genuinely visible point. Every candidate point MUST hit-test to the
      // exact target card root before it is used.
      const FRACTIONS = [
        [0.5, 0.5], [0.5, 0.3], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5],
        [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
        [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5],
        [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85],
        [0.5, 0.07], [0.5, 0.93], [0.07, 0.5], [0.93, 0.5],
      ];

      let probes = 0;
      let firstCoverEl = null;
      for (const surface of surfaces) {
        for (const pair of FRACTIONS) {
          const x = surface.left + surface.width * pair[0];
          const y = surface.top + surface.height * pair[1];
          if (x < 2 || y < 2 || x >= window.innerWidth - 2 || y >= window.innerHeight - 2) continue;
          probes++;
          const hitEl = document.elementFromPoint(x, y);
          if (!hitEl) continue;
          if (!firstCoverEl) firstCoverEl = hitEl;
          const hit = resolveCard(hitEl);
          if (hit && hit.el === target.el) {
            return { found: true, aimOk: true, x, y, key: target.key, probes, via: surface === imgRect ? 'img' : 'card' };
          }
        }
      }

      // No point inside the card is clickable → report exactly WHAT covers it.
      const cx = rootRect.left + rootRect.width / 2;
      const cy = rootRect.top + rootRect.height / 2;
      const coverEl = document.elementFromPoint(cx, cy);
      const coverHit = coverEl ? resolveCard(coverEl) : null;
      return {
        found: true,
        aimOk: false,
        key: target.key,
        probes,
        coverDesc: coverEl ? describeEl(coverEl) : (firstCoverEl ? describeEl(firstCoverEl) : 'nothing'),
        coverKind: coverHit ? coverHit.kind : 'none',
        coverKey: coverHit ? coverHit.key : null,
        cardRect: { x: Math.round(rootRect.left), y: Math.round(rootRect.top), w: Math.round(rootRect.width), h: Math.round(rootRect.height) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    })()`)) as {
      found: boolean;
      aimOk?: boolean;
      x?: number;
      y?: number;
      key?: string | null;
      probes?: number;
      via?: 'img' | 'card';
      coverDesc?: string;
      coverKind?: string;
      coverKey?: string | null;
      cardRect?: { x: number; y: number; w: number; h: number };
      viewport?: { w: number; h: number };
      totalCards?: number;
      imageKeys?: string[];
      presentUnclassified?: boolean;
      wrongKind?: string | null;
    };

    if (!point.found) {
      // Identity mounted as a different DEFINITE card kind: this is a targeting
      // mismatch (e.g. an image action aimed at a video card), not a rendering
      // delay — refuse immediately instead of sweeping/reloading (which would
      // also discard transient page state and can never change the card kind).
      if (point.wrongKind) {
        throw new Error(
          `Refusing to right-click the wrong card: ${targetDesc} identity is mounted as a ${point.wrongKind} card ` +
          `— an ${expectKind} card is required. This is a pipeline/targeting mismatch, not a rendering delay.`
        );
      }
      const mounted = (point.imageKeys ?? []).map((k) => String(k).slice(0, 8));
      const mountedDesc = mounted.length > 0 ? `; mounted ${expectKind} keys: ${mounted.join(', ')}` : '';
      const pendingNote = point.presentUnclassified
        ? ' — the card identity IS present in the DOM but its tile is not classified/rendered yet'
        : '';
      lastProblem = `no ${targetDesc} found on the canvas (${point.totalCards ?? 0} card(s) total${mountedDesc})${pendingNote}`;
      if (attempt < 6) {
        // The canvas may virtualize/lazy-render cards outside the viewport: sweep
        // the full feed viewport-by-viewport, probing for the identity after every
        // scroll step, and stop the moment the card mounts (it stays in view for
        // the next attempt's aim check).
        const sweep = await sweepCanvasForTargetCard(page, {
          expect: expectKind,
          matchKey: options?.matchKey ?? null,
          matchSrc: options?.matchSrc ?? null,
        }).catch(() => ({ found: false, steps: 0, mountedKeys: [] as string[] }));
        if (sweep.found) {
          console.log(
            picocolors.gray(
              `[flow-dom] ${targetDesc} surfaced after ${sweep.steps} canvas scroll step(s) — aiming again`
            )
          );
          continue;
        }
        // Still absent after a full sweep: the card is not merely off-screen — a
        // freshly generated card may not have persisted into the project media
        // list this page loaded. Reload to re-sync the server-side media, then
        // sweep again on the next attempt.
        if (attempt % 2 === 0) {
          console.log(
            picocolors.gray(
              `[flow-dom] ${targetDesc} still absent after a full canvas sweep — reloading the project page to re-sync server-side media`
            )
          );
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
          await waitForEditor(page, 20_000).catch(() => {});
          await new Promise((r) => setTimeout(r, 2_000));
        }
        continue;
      }
      break;
    }

    if (!point.aimOk) {
      lastProblem =
        `aim check failed: no clickable point inside ${targetDesc} — its centre is covered by ` +
        `${point.coverDesc} (${point.coverKind} card${point.coverKey ? ` "${point.coverKey}"` : ''}); ` +
        `card rect ${JSON.stringify(point.cardRect)} in viewport ${JSON.stringify(point.viewport)}, ` +
        `${point.probes ?? 0} point(s) probed`;
      // A leftover transparent overlay backdrop intercepts every pointer event on
      // the page — dismiss it with a real click so the next attempt can aim at
      // the card (verified live: this is what broke run viral-1790819690913-6lmef4).
      const dismissed = await dismissTransparentOverlayBackdrop(page).catch(() => false);
      if (dismissed) {
        console.log(
          picocolors.gray(
            `[flow-dom] dismissed a leftover transparent overlay backdrop that covered the canvas`
          )
        );
      }
      await new Promise((r) => setTimeout(r, 500 + attempt * 250));
      continue;
    }

    const x = point.x as number;
    const y = point.y as number;
    await page.mouse.click(x, y, { button: 'right' });
    await new Promise((r) => setTimeout(r, 800));
    return { x, y };
  }

  throw new Error(
    `Refusing to right-click the wrong card: could not aim at ${targetDesc} — ${lastProblem}. ` +
    `Ensure the card exists and is fully rendered (use --headed to inspect the Flow UI).`
  );
}

/**
 * Searches the active CDK overlay or document for the "Add to prompt" context menu action and clicks it.
 */
export async function clickAddToPromptMenuItem(
  page: Page,
  timeoutMs: number = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate(() => {
      // Look within CDK overlay panes or any popup menu
      const items = Array.from(document.querySelectorAll(
        '.cdk-overlay-pane button, [role="menu"] button, [role="menu"] [role="menuitem"], .mat-mdc-menu-item, button[role="menuitem"]'
      ));

      for (const item of items) {
        const text = (item.textContent || '').trim();
        const icon = item.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '';
        if (
          /add to prompt/i.test(text) ||
          icon === 'add_2'
        ) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error('Timed out waiting for "Add to prompt" menu item in image context menu. Verify viewport >= 1400px with --headed.');
}

/**
 * Dismisses any existing reference / ingredient chips currently in the prompt box,
 * or clears video-mode start/end frame slots.
 */
export async function clearExistingIngredientChips(page: Page): Promise<number> {
  let count = 0;
  const selectors = [
    'button[aria-label="Ingredient"], flow-ingredient-chip button:has(mat-icon[data-icon="cancel"])',
    '.prompt-top-row .clear-button, flow-ingredient-bar .clear-button, button[aria-label="Clear prompt"]',
    '.frame-trigger .hover-icon-overlay, .frame-trigger mat-icon.hover-icon',
  ];
  for (const selector of selectors) {
    const controls = await page.$$(selector);
    try {
      for (const control of controls) {
        if (!(await control.isVisible())) continue;
        if (!(await control.evaluate((el) => el.isConnected && !el.matches(':disabled, [aria-disabled="true"]')))) continue;
        await control.click();
        count++;
      }
    } finally {
      await Promise.all(controls.map((control) => control.dispose()));
    }
  }
  return count;
}

/**
 * Counts the attachments currently in the Flow prompt box.
 *
 * In Image mode, renders as `flow-ingredient-chip` elements in `flow-ingredient-bar`.
 * In Video mode, renders as `.frame-trigger` with `flow-image-ingredient-chip` (Start/End).
 * Used as the success signal of `attachImageToPrompt`: count must INCREASE after upload.
 */
export async function countPromptAttachments(page: Page): Promise<number> {
  return (await readPromptAttachmentKinds(page)).total;
}

export interface PromptAttachments {
  /** Chips holding an `<img>` — the starting-frame candidates. */
  image: number;
  /** Chips holding a `<video>` — never a valid starting frame. */
  video: number;
  total: number;
}

/**
 * Classifies the prompt-box attachments. A 连续/continuous starting frame must show up
 * as an IMAGE chip; a video chip means the wrong asset was attached.
 */
export async function readPromptAttachmentKinds(page: Page): Promise<PromptAttachments> {
  return await page.evaluate(() => {
    const chips = new Set<Element>();

    // 1. Video mode frame triggers containing an image (Start/End frames)
    for (const el of Array.from(document.querySelectorAll('.frame-trigger:has(img)'))) {
      chips.add(el);
    }

    // 2. Ingredient chips (both flow-ingredient-chip and flow-image-ingredient-chip)
    for (const el of Array.from(
      document.querySelectorAll('flow-ingredient-chip, flow-image-ingredient-chip')
    )) {
      if (!el.closest('.frame-trigger')) {
        chips.add(el);
      }
    }

    // 3. Any leftover chip-containers not already covered
    for (const el of Array.from(
      document.querySelectorAll('button[aria-label*="ingredient" i], [class*="chip-container"]')
    )) {
      if (
        !el.closest('.frame-trigger') &&
        !el.closest('flow-ingredient-chip') &&
        !el.closest('flow-image-ingredient-chip')
      ) {
        chips.add(el);
      }
    }

    // 4. Inlined img elements in contenteditable editors
    for (const el of Array.from(document.querySelectorAll('[contenteditable="true"] img'))) {
      chips.add(el);
    }

    let image = 0;
    let video = 0;
    for (const chip of chips) {
      if (chip.querySelector('video')) video++;
      else image++;
    }
    return { image, video, total: chips.size };
  });
}

export interface AttachImageResult {
  method: 'flow-existing' | 'flow-upload' | 'file-input' | 'clipboard-paste';
  attachmentsBefore: number;
  attachmentsAfter: number;
  imageBytes: number;
  imageChips: number;
  videoChips: number;
}

interface ControlInfo {
  text: string;
  ariaLabel: string;
  icon: string;
}

/**
 * Clicks the first control matching `match` with TRUSTED input events.
 *
 * Untrusted in-page `el.click()` never opens a native file chooser — the browser
 * requires real input events (user activation) for that.
 */
async function trustedClickControl(
  page: Page,
  match: (info: ControlInfo) => boolean,
  label: string,
  selector = 'button, [role="button"], [role="menuitem"], .mat-mdc-menu-item'
): Promise<boolean> {
  const candidates = await page.$$(selector);
  try {
    for (const el of candidates) {
      if (!(await el.isVisible())) continue;
      if (!(await el.evaluate((node) => !node.matches(':disabled, [aria-disabled="true"]')))) continue;
      const info = await el.evaluate((node) => ({
        text: (node.textContent || '').trim().replace(/\s+/g, ' '),
        ariaLabel: node.getAttribute('aria-label') || '',
        icon: node.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '',
      }));
      if (!match(info)) continue;
      console.log(picocolors.gray(`[flow-dom] click "${label}" → ${JSON.stringify(info)}`));
      await el.click();
      return true;
    }
  } finally {
    await Promise.all(candidates.map((el) => el.dispose()));
  }
  return false;
}

/**
 * Selects the freshly uploaded asset by its file name inside the assets overlay
 * (falling back to the project grid tile) and waits until it is ready.
 */
async function clickUploadedAsset(page: Page, fileName: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await page.evaluate((name: string) => {
      // The assets overlay lists the newest upload first (`button.asset-item`), so the
      // FIRST / most specific name match is the file just uploaded — a broad wrapper or
      // an older duplicate would hit a disabled "Add to prompt".
      const mostSpecific = (nodes: Element[]): Element | null => {
        const matches = nodes.filter((el) => el.children.length <= 3 && (el.textContent || '').includes(name));
        matches.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        return matches[0] || null;
      };
      const overlayLeaf =
        mostSpecific(Array.from(document.querySelectorAll('.cdk-overlay-pane button.asset-item, .cdk-overlay-pane flow-add-menu-asset-item'))) ||
        mostSpecific(Array.from(document.querySelectorAll('.cdk-overlay-pane *')));
      const leaf = overlayLeaf || mostSpecific(Array.from(document.querySelectorAll('flow-grid-tile-container, flow-tile-container')));
      if (!leaf) return null;
      const row = (leaf.closest(
        'button.asset-item, flow-add-menu-asset-item, flow-grid-tile-container, flow-tile-container, [class*="item"], [class*="card"], [class*="tile"], [class*="row"], button'
      ) || leaf) as HTMLElement;
      row.scrollIntoView({ block: 'center' });
      const r = row.getBoundingClientRect();
      return {
        desc: `${row.tagName.toLowerCase()}.${String(row.className).slice(0, 70)}`,
        inOverlay: Boolean(row.closest('.cdk-overlay-pane')),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      };
    }, fileName);

    if (target) {
      console.log(picocolors.gray(`[flow-dom] select uploaded asset "${fileName}" → ${JSON.stringify(target)}`));
      await page.mouse.click(target.x, target.y);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.log(picocolors.yellow(`[flow-dom] uploaded asset "${fileName}" never appeared for selection`));
  return false;
}

/**
 * Attaches a local image to the prompt box as the starting frame / ingredient of the
 * next generation. Success is verified by the attachment count increasing or the frame
 * trigger containing the image.
 *
 * Strategies (each verified, in order):
 *   1. **flow-existing**: reuse the matching image in the current project's picker;
 *   2. **flow-upload** (verified on live UI): Prompt box trigger (Video mode Start slot
 *      or Image mode Add ingredients) → "Upload media" → native FileChooser → optional
 *      "Rights to use this image" consent → select uploaded asset → "Add to prompt";
 *   3. `input[type=file]` upload scoped to the prompt area (generic pages / tests);
 *   4. clipboard image paste (xclip image/png target) + Ctrl+V.
 * Upload receipts beside the local image survive process restarts. A receipt is
 * scoped to the project URL and file contents. Changed image contents require a
 * new filename. A missing submitted asset is an error, never a retry upload.
 *
 * The uploaded asset is selected STRICTLY by file name — there is deliberately no
 * "first item" fallback: attaching the wrong asset as the starting frame is worse
 * than failing. Every dead end inside the Flow frame picker (missing upload
 * control, unselectable asset, missing "Add to prompt", attachment not registered)
 * throws with evidence instead of silently trying something else.
 *
 * Throws loudly when nothing attaches the image — it is never assumed.
 */
export async function attachImageToPrompt(
  page: Page,
  imagePath: string,
  options: {
    timeoutMs?: number;
    evidenceDir?: string;
    /** Set false when the image is known to exist in this project. */
    allowUpload?: boolean;
    /** Share across retries for this file/project so an accepted upload is never repeated. */
    uploadState?: { submitted: boolean };
  } = {}
): Promise<AttachImageResult> {
  const resolved = path.resolve(imagePath);
  const fileName = path.basename(resolved);
  const { stat } = await import('node:fs/promises');
  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isFile() || info.size <= 0) {
    throw new Error(`Cannot attach starting frame: image file missing or empty: ${resolved}`);
  }
  const imageBytes = info.size;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const projectUrl = page.url().split(/[?#]/)[0];
  const imageHash = createHash('sha256').update(await readFile(resolved)).digest('hex');
  const receiptPath = `${resolved}.flow-upload.json`;
  let receipt: { projectUrl?: string; imageHash?: string } | null = null;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (!receipt || typeof receipt.projectUrl !== 'string' ||
      typeof receipt.imageHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.imageHash)) {
      throw new Error('Invalid upload receipt');
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw new Error(`Cannot read upload receipt "${receiptPath}" — refusing to risk a duplicate upload: ${err?.message}`);
    }
  }
  if (receipt?.projectUrl === projectUrl && receipt.imageHash !== imageHash) {
    throw new Error(`Starting frame "${fileName}" changed since its recorded upload — use a new filename to avoid selecting the old image.`);
  }
  let previouslySubmitted = receipt?.projectUrl === projectUrl && receipt?.imageHash === imageHash;
  const recordUpload = async (): Promise<void> => {
    previouslySubmitted = true;
    if (options.uploadState) options.uploadState.submitted = true;
    const temp = `${receiptPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify({ projectUrl, imageHash, fileName, submittedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    await rename(temp, receiptPath);
  };

  // Flow's frame picker ("Select a frame image") renders a compact single-column
  // layout in narrow viewports: no asset preview and NO "Add to prompt" button,
  // so a starting frame can never be confirmed there. A stale
  // `Emulation.setDeviceMetricsOverride` (e.g. Puppeteer's 800x600 default left
  // behind by an external connection) renders exactly that layout even inside a
  // full-size window. Detect and SELF-HEAL before giving up.
  const geometry = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
  }));

  const hasStaleDivergence =
    geometry.outerWidth - geometry.innerWidth > STALE_EMULATION_DIVERGENCE_PX ||
    geometry.outerHeight - geometry.innerHeight > STALE_EMULATION_DIVERGENCE_PX;
  const tooSmall = geometry.innerWidth < 1024 || geometry.innerHeight < 600;

  if (hasStaleDivergence || tooSmall) {
    // Attempt self-healing: clear stale emulation via CDP before giving up.
    const healMsg =
      `[flow-dom] Detected ${hasStaleDivergence ? 'stale viewport emulation' : 'viewport too small'}: ` +
      `page renders ${geometry.innerWidth}x${geometry.innerHeight} ` +
      `inside a ${geometry.outerWidth}x${geometry.outerHeight} window — clearing Emulation.setDeviceMetricsOverride`;
    console.warn(picocolors.yellow(healMsg));

    const client = await page.context().newCDPSession(page).catch(() => null);
    if (client) {
      await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await client.detach().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }

    // Re-read geometry after clearing
    const after = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    }));

    const stillBad =
      after.outerWidth - after.innerWidth > STALE_EMULATION_DIVERGENCE_PX ||
      after.outerHeight - after.innerHeight > STALE_EMULATION_DIVERGENCE_PX ||
      after.innerWidth < 1024 || after.innerHeight < 600;

    if (stillBad) {
      throw new Error(
        `Could not attach starting frame "${resolved}": the page renders ${after.innerWidth}x${after.innerHeight} ` +
          `inside a ${after.outerWidth}x${after.outerHeight} window even after clearing viewport emulation. ` +
          `Flow's frame picker requires at least 1024x600. ` +
          `Check your Xvfb/VNC display resolution and ensure no external tool re-applies Emulation.setDeviceMetricsOverride.`
      );
    }
    console.log(
      picocolors.green(
        `[flow-dom] ✓ Viewport emulation cleared — page now renders at ${after.innerWidth}x${after.innerHeight}`
      )
    );
  }

  const attachmentsBefore = await countPromptAttachments(page);

  const shot = async (label: string): Promise<void> => {
    if (!options.evidenceDir) return;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(options.evidenceDir, { recursive: true }).catch(() => {});
    await page.screenshot({ path: path.join(options.evidenceDir, `${label}.png`) }).catch(() => {});
  };

  const pollIncrease = async (deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if ((await countPromptAttachments(page)) > attachmentsBefore) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };

  let reusedExisting = false;
  // ── Strategy 1: reuse the project asset, uploading only when it is absent ──
  const flowUpload = async (): Promise<boolean> => {
    let baseline = attachmentsBefore;
    try {
      // Clear existing ingredients / frames so attachment verification is unambiguous
      await clearExistingIngredientChips(page).catch(() => {});
      baseline = await countPromptAttachments(page);

      // Match the working manual sequence for an uploaded canvas image:
      // context menu → Add to prompt. Do not reopen the upload picker for it.
      const canvasTiles = await page.$$('flow-grid-tile-container');
      try {
        for (const tile of canvasTiles) {
          const matches = await tile.evaluate((el, name) =>
            el.getAttribute('aria-label') === name && !!el.querySelector('img') && !el.querySelector('video'), fileName);
          if (!matches || !(await tile.isVisible())) continue;
          await tile.click({ button: 'right' });
          let added = false;
          const menuDeadline = Date.now() + timeoutMs;
          while (!added && Date.now() < menuDeadline) {
            added = await trustedClickControl(page, (info) => /add to prompt/i.test(info.text),
              'Add to prompt', '.cdk-overlay-pane button, .cdk-overlay-pane [role="menuitem"]');
            if (!added) await new Promise((r) => setTimeout(r, 200));
          }
          if (!added) throw new Error(`Uploaded image "${fileName}" has no Add to prompt action.`);
          await page.waitForFunction(() =>
            !!document.querySelector('.frame-trigger img, flow-ingredient-chip img, flow-image-ingredient-chip img'),
            undefined,
            { timeout: timeoutMs });
          reusedExisting = true;
          await recordUpload();
          console.log(picocolors.green(`[flow-dom] Reusing canvas image "${fileName}" via Add to prompt — no upload`));
          await shot('s5-canvas-add-to-prompt');
          return true;
        }
      } finally {
        await Promise.all(canvasTiles.map((tile) => tile.dispose()));
      }

      // Locate the prompt-box trigger to open the asset selection overlay:
      // Priority A: Video mode frame triggers — the `Start` chip (empty or filled).
      // The wrapping `.frame-trigger` div carries the same "Start" text as its
      // button and `querySelectorAll` returns the container FIRST, so prefer the
      // inner <button> and only fall back to the container.
      let triggerHandle: ElementHandle | null = null;
      let containerFallback: ElementHandle | null = null;
      const frameTriggers = await page.$$('.frame-trigger button, .frame-trigger');
      for (const ft of frameTriggers) {
        const text = await ft.evaluate((el) => el.textContent?.trim().toLowerCase());
        const hasImg = await ft.evaluate((el) => !!el.querySelector('img'));
        const isButton = await ft.evaluate((el) => el.tagName === 'BUTTON');
        if (text === 'start' || text === 'cancel' || hasImg) {
          if (isButton) {
            triggerHandle = ft;
            break;
          }
          if (!containerFallback) containerFallback = ft;
        }
      }
      if (!triggerHandle) triggerHandle = containerFallback;

      // Priority B: Prompt-box ingredient button (strictly within prompt box, NEVER global header)
      if (!triggerHandle) {
        const promptBoxBtns = await page.$$(
          'flow-prompt-box button, [class*="prompt-box"] button, .prompt-box-container button'
        );
        for (const b of promptBoxBtns) {
          const info = await b.evaluate((el) => ({
            aria: el.getAttribute('aria-label') || '',
            icon: el.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '',
          }));
          if (/add ingredient/i.test(info.aria) || info.icon === 'add') {
            triggerHandle = b;
            break;
          }
        }
      }

      if (!triggerHandle) {
        console.log(picocolors.gray('[flow-dom] No prompt box frame trigger or ingredient button found'));
        return false;
      }

      console.log(picocolors.gray('[flow-dom] Clicking prompt box trigger to open asset overlay...'));
      await triggerHandle.click();
      await new Promise((r) => setTimeout(r, 1_200));
      await shot('s1-ingredients-overlay');

      // Notifications also live in CDK panes and can precede the picker. The
      // first pane may be "item moved to trash", not the asset picker at all.
      const overlay = await page.waitForSelector(
        '.cdk-overlay-pane:not(:has(mat-snack-bar-container, mat-tooltip-component))',
        { timeout: 8_000, state: 'visible' }
      ).catch(() => null);
      if (!overlay) {
        throw new Error('Flow frame picker did not open — refusing another upload through a fallback.');
      }

      // The project retains uploaded images after generation failure / refresh.
      // Search before opening a chooser, including a short wait for the asset list
      // to load. A known upload that is not yet visible must fail, never re-upload.
      const mustReuse = options.allowUpload === false || options.uploadState?.submitted === true || previouslySubmitted;
      const existingDeadline = Date.now() + (mustReuse ? timeoutMs : Math.min(timeoutMs, 5_000));
      while (Date.now() < existingDeadline) {
        reusedExisting = await page.evaluate((name: string) => {
          return Array.from(document.querySelectorAll(
            '.cdk-overlay-pane .asset-item, .cdk-overlay-pane flow-add-menu-asset-item'
          )).some((el) => (el.textContent || '').trim() === name ||
            Array.from(el.querySelectorAll('*')).some((child) => (child.textContent || '').trim() === name));
        }, fileName);
        if (reusedExisting) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (reusedExisting) {
        await recordUpload();
        console.log(picocolors.green(`[flow-dom] Reusing existing project image "${fileName}" — no upload`));
      } else if (mustReuse) {
        throw new Error(`Previously uploaded starting frame "${fileName}" is not visible in the picker — refusing to upload it again.`);
      }

      if (!reusedExisting) {
        // Locate "Upload media" button inside the overlay
        const overlayBtns = await overlay.$$('button, [role="button"]');
        let uploadBtnHandle: ElementHandle | null = null;
        for (const b of overlayBtns) {
          const info = await b.evaluate((el) => ({
            text: (el.textContent || '').trim().replace(/\s+/g, ' '),
            icon: el.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '',
          }));
          if (/upload media/i.test(info.text) || info.icon === 'upload') {
            uploadBtnHandle = b;
            break;
          }
        }
        if (!uploadBtnHandle) {
          await shot('s1b-overlay-without-upload');
          throw new Error(
            `Could not attach starting frame "${resolved}": the frame picker overlay opened but has no "Upload media" ` +
              `control — the Flow picker UI changed. See the evidence screenshots for the current overlay controls.`
          );
        }

        console.log(picocolors.gray('[flow-dom] Clicking "Upload media"...'));
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null);
        await uploadBtnHandle.click();
        const chooser = await chooserPromise;
        if (!chooser) {
          await shot('s2-no-file-chooser');
          throw new Error(
            `Could not attach starting frame "${resolved}": clicking "Upload media" did not open a native file chooser.`
          );
        }
        await chooser.setFiles([resolved]);
        await recordUpload();
        await new Promise((r) => setTimeout(r, 2_500));
        await shot('s2-file-accepted');

        // "Rights to use this image" consent — shown on first upload
        const consentDeadline = Date.now() + 5_000;
        while (Date.now() < consentDeadline) {
          const agreed = await trustedClickControl(
            page, (info) => info.text.toLowerCase() === 'i agree', 'I agree'
          );
          if (agreed) {
            console.log(picocolors.gray('[flow-dom] Clicked "I agree" consent'));
            await new Promise((r) => setTimeout(r, 1_500));
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        await shot('s3-after-consent');
      }

      // Select the uploaded asset inside the overlay — STRICTLY by file name.
      // There is deliberately no "first item" fallback: attaching a different
      // asset as the starting frame is worse than failing.
      const selectDeadline = Date.now() + 30_000;
      let selected = false;
      while (Date.now() < selectDeadline) {
        const items = await page.$$(
          '.cdk-overlay-pane button.asset-item, .cdk-overlay-pane .asset-item, .cdk-overlay-pane flow-add-menu-asset-item'
        );
        try {
          for (const item of items) {
            const ready = await item.evaluate((el, name) => {
              const nameMatches = (el.textContent || '').trim() === name ||
                Array.from(el.querySelectorAll('*')).some((child) => (child.textContent || '').trim() === name);
              return nameMatches && !el.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]') &&
                !el.querySelector('mat-progress-spinner, mat-spinner, [class*="spinner"], [class*="progress"]');
            }, fileName);
            if (!ready || !(await item.isVisible())) continue;
            await item.click();
            selected = true;
            break;
          }
        } finally {
          await Promise.all(items.map((item) => item.dispose()));
        }

        if (selected) {
          console.log(picocolors.gray(`[flow-dom] Selected uploaded asset "${fileName}" in overlay`));
          break;
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }

      if (!selected) {
        await shot('s4-asset-not-selectable');
        throw new Error(
          `Could not attach starting frame "${resolved}": the uploaded asset "${fileName}" never became selectable ` +
            `in the frame picker (no file-name match, or the upload is still in progress). ` +
            `See the evidence screenshots for the picker state.`
        );
      }
      await new Promise((r) => setTimeout(r, 1_000));
      await shot('s4-asset-selected');

      // Click "Add to prompt"
      let addClicked = false;
      const addDeadline = Date.now() + timeoutMs;
      while (!addClicked && Date.now() < addDeadline) {
        // Existing images may attach on selection and close the picker directly.
        // In that case there is no confirmation button to click (or wait for).
        const selectionState = await page.evaluate(() => {
          const start = document.querySelector('.frame-trigger');
          return {
            pickerClosed: !document.querySelector('.cdk-overlay-pane:not(:has(mat-snack-bar-container, mat-tooltip-component))'),
            startAttached: !!start?.querySelector('img') && !start.querySelector('[aria-busy="true"]'),
          };
        });
        if (selectionState.pickerClosed && (selectionState.startAttached ||
          (await countPromptAttachments(page)) > baseline)) {
          await shot('s5-attached-on-selection');
          return true;
        }
        addClicked = await trustedClickControl(
          page, (info) => /add to prompt/i.test(info.text), 'Add to prompt',
          '.cdk-overlay-pane button, .cdk-overlay-pane [role="button"]'
        );
        if (!addClicked) await new Promise((r) => setTimeout(r, 300));
      }

      if (!addClicked) {
        await shot('s5-no-add-to-prompt');
        throw new Error(
          `Could not attach starting frame "${resolved}": the frame picker offers no clickable "Add to prompt" ` +
            `and did not attach "${fileName}" after selection. See the evidence screenshots for the picker state.`
        );
      }
      await new Promise((r) => setTimeout(r, 1_500));
      await shot('s5-after-add-to-prompt');

      // Poll until attachments count increases or start frame is filled
      const pollDeadline = Date.now() + 6_000;
      while (Date.now() < pollDeadline) {
        const current = await countPromptAttachments(page);
        const hasStartImg = await page.evaluate(() => {
          const ft = document.querySelector('.frame-trigger');
          return !!ft?.querySelector('img');
        });
        if (current > baseline || hasStartImg) return true;
        await new Promise((r) => setTimeout(r, 300));
      }
      await shot('s6-attach-not-registered');
      throw new Error(
        `Could not attach starting frame "${resolved}": "Add to prompt" was clicked but no attachment appeared ` +
          `in the prompt box (attachments ${baseline} → ${await countPromptAttachments(page)}).`
      );
    } finally {
      // Successful attachment closes the picker itself. Escape here is delivered
      // to the canvas and may change its selection / prompt state. Only dismiss
      // an overlay that actually remains, using its own close control.
      await trustedClickControl(
        page, (info) => /^(close|cancel)$/i.test(info.ariaLabel || info.icon || info.text),
        'Close frame picker', '.cdk-overlay-pane button, .cdk-overlay-pane [role="button"]'
      ).catch(() => {});
    }
  };

  // ── Strategy 2: hidden file input upload (generic pages / tests) ──
  const uploadViaFileInput = async (): Promise<boolean> => {
    try {
      // ONLY file inputs inside the prompt area. A global / canvas
      // `input[type=file]` uploads the image as a CANVAS TILE instead of
      // attaching it to the prompt — that must never be mistaken for an
      // attachment attempt.
      const fileInputSelector = `${PROMPT_AREA_SELECTOR} input[type="file"]`;
      let inputs = (await page.$$(fileInputSelector)) as ElementHandle<HTMLInputElement>[];
      if (inputs.length === 0) {
        // Only click upload/attach trigger inside the prompt area — NEVER global header
        await page.evaluate((promptAreaSelector: string) => {
          const promptArea = document.querySelector(promptAreaSelector);
          if (!promptArea) return;
          const buttons = Array.from(promptArea.querySelectorAll('button, [role="button"]'));
          const trigger = buttons.find((b) => {
            const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`.toLowerCase();
            const icon = b.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '';
            return (
              /upload|attach|photo|image|add media|add file/i.test(label) ||
              ['upload', 'attach_file', 'add_photo_alternate', 'image', 'photo'].includes(icon)
            );
          });
          (trigger as HTMLElement | undefined)?.click();
        }, PROMPT_AREA_SELECTOR);
        await new Promise((r) => setTimeout(r, 800));
        inputs = (await page.$$(fileInputSelector)) as ElementHandle<HTMLInputElement>[];
      }

      for (const input of inputs) {
        try {
          // Reset first: re-selecting the very same file does not fire a change event.
          await input.evaluate((el) => {
            (el as HTMLInputElement).value = '';
          });
          await input.setInputFiles(resolved);
        } catch {
          continue;
        }
        if (await pollIncrease(4_000)) return true;

        // The file list IS set — dispatch the change event explicitly so the app
        // registers it even when the same file was chosen again.
        await input
          .evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })
          .catch(() => {});
        if (await pollIncrease(3_000)) return true;
      }
      return false;
    } catch (err: any) {
      console.warn(picocolors.yellow(`[flow-dom] File-input attach failed: ${err?.message || err}`));
      return false;
    }
  };

  // ── Strategy 3: clipboard image paste (xclip image/png) + Ctrl+V ──
  const pasteViaClipboard = async (): Promise<boolean> => {
    try {
      const { setClipboardImage } = await import('../input/system-input.js');
      await setClipboardImage(resolved);

      const editorRect = await page.evaluate((selector: string) => {
        const candidates = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
        const editor = candidates.find((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.getBoundingClientRect().width >= 5;
        });
        if (!editor) return null;
        editor.focus();
        const r = editor.getBoundingClientRect();
        return {
          x: Math.min(Math.max(r.x + r.width / 2, 10), window.innerWidth - 10),
          y: Math.min(Math.max(r.y + r.height / 2, 10), window.innerHeight - 10),
        };
      }, PROMPT_EDITOR_SELECTOR);
      if (!editorRect) return false;

      await humanClick(page, editorRect.x, editorRect.y);
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.down('Control');
      await page.keyboard.press('v');
      await page.keyboard.up('Control');
      return await pollIncrease(5_000);
    } catch (err: any) {
      console.warn(picocolors.yellow(`[flow-dom] Clipboard image paste failed: ${err?.message || err}`));
      return false;
    }
  };

  let method: AttachImageResult['method'] | null = null;
  if (await flowUpload()) method = reusedExisting ? 'flow-existing' : 'flow-upload';
  else if (options.allowUpload === false || options.uploadState?.submitted || previouslySubmitted) {
    throw new Error(`Cannot find the Flow frame picker for previously uploaded image "${fileName}" — refusing to upload it again.`);
  } else if (await uploadViaFileInput()) method = 'file-input';
  else if (await pasteViaClipboard()) method = 'clipboard-paste';

  const kinds = await readPromptAttachmentKinds(page);

  if (!method) {
    throw new Error(
      `Could not attach starting frame "${resolved}" to the Flow prompt box: ` +
        `no attachment appeared after the Flow upload flow, input[type=file] upload and clipboard paste ` +
        `(attachments before: ${attachmentsBefore}, image chips: ${kinds.image}, video chips: ${kinds.video}). ` +
        `Inspect the Flow UI with --headed to find the upload control.`
    );
  }

  return {
    method,
    attachmentsBefore,
    attachmentsAfter: kinds.total,
    imageBytes,
    imageChips: kinds.image,
    videoChips: kinds.video,
  };
}
/**
 * Searches the active CDK overlay or document for the "Animate" context menu action and clicks it.
 */
export async function clickAnimateMenuItem(
  page: Page,
  timeoutMs: number = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate(() => {
      // Look within CDK overlay panes or any popup menu
      const items = Array.from(document.querySelectorAll(
        '.cdk-overlay-pane button, [role="menu"] button, [role="menu"] [role="menuitem"], .mat-mdc-menu-item, button[role="menuitem"]'
      ));

      for (const item of items) {
        const text = (item.textContent || '').trim();
        const icon = item.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '';
        if (
          !/add to prompt/i.test(text) &&
          (/^animate$/i.test(text) || /animate/i.test(text) || icon === 'motion_blur')
        ) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error('Timed out waiting for "Animate" menu item in image context menu. Verify viewport >= 1400px with --headed.');
}

/**
 * Waits for the Google Flow UI to transition into video animation mode after clicking "Animate".
 * In video animation mode, Start/End frame chips appear and ProseMirror editor is ready.
 */
export async function waitForAnimateEditor(
  page: Page,
  timeoutMs: number = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const editor = document.querySelector(
        '[contenteditable="true"].ProseMirror, textarea, [contenteditable="true"]'
      ) as HTMLElement | null;

      if (editor) {
        editor.focus();
        return true;
      }
      return false;
    });

    if (ready) {
      await new Promise((r) => setTimeout(r, 400));
      return;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error('Timed out waiting for video animation editor to appear after clicking "Animate".');
}

/**
 * Waits for a new IMAGE card to appear in the Flow project grid after generation and
 * returns it. Prefer passing a `Set` of known card keys (see `listMediaTiles`) so the
 * new card is detected by identity; a plain number is treated as the baseline image
 * card count (see `countImageTiles`). Video cards are never returned — a right-click
 * on a video card must be impossible by construction.
 */
export async function waitForNewImageTile(
  page: Page,
  baseline: number | Set<string>,
  timeoutMs: number = 120_000,
  failureBaseline?: FlowFailureState
): Promise<FlowImageTile> {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    const errorText = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      if (/something went wrong/i.test(text) || /failed to generate/i.test(text)) {
        return 'Google Flow reported: Something went wrong. Please try again.';
      }
      return null;
    });

    if (errorText) {
      throw new Error(errorText);
    }

    // Baseline-scoped failure tiles: only a failure that appeared AFTER this attempt
    // started aborts it — a stale risk tile must never kill a healthy generation.
    const failure = await readFlowFailureState(page);
    if (hasNewFlowFailure(failure, failureBaseline)) {
      const riskText =
        failure.errorTileTexts.find((t) => RISK_CONTROL_TEXT_RE.test(t)) ||
        (failure.riskBodyText
          ? 'We noticed some unusual activity. Please visit the Help Center for more information.'
          : null);
      if (riskText) {
        throw new Error(`Google Flow canvas generation failed: ${riskText}`);
      }
      const tileText = failure.errorTileTexts[0];
      if (tileText) {
        throw new Error(`Google Flow canvas generation failed: ${tileText}`);
      }
    }

    // Periodically scroll down to reveal lazy-loaded tiles (every 3 polls ~4.5s)
    pollCount++;
    if (pollCount % 3 === 0) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight || document.documentElement.scrollHeight);
        const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        for (const el of scrollables) {
          el.scrollTop = el.scrollHeight;
        }
      }).catch(() => {});
    }

    const state = (await page.evaluate(`(() => {
      ${MEDIA_TILE_HELPERS}
      const baselineKeys = ${
        baseline instanceof Set
          ? `new Set(${JSON.stringify([...baseline])})`
          : 'null'
      };
      const baselineCount = ${baseline instanceof Set ? -1 : Number(baseline)};

      const pendingTiles = document.querySelectorAll('flow-pending-tile, [class*="pending-tile"]');
      const stopBtn = document.querySelector('.stop-icon-button, button[aria-label="Stop"]');
      const hasPending = pendingTiles.length > 0 || !!stopBtn;

      const cards = collectCards();
      const imageCards = cards.filter((c) => c.kind === 'image');

      // Fresh = image cards that appeared after the baseline was taken.
      // Identity is judged by CANONICAL tokens (media UUID / origin+path, query stripped):
      // the canvas recycles tile elements, so a wrapper's data-media-id attribute can
      // be STALE while the <img src> already shows a different (new) media. The actual
      // image displayed (<img src>) is the ground truth.
      const baselineTokens = new Set();
      if (baselineKeys) {
        for (const k of baselineKeys) {
          for (const t of identityTokens(k)) baselineTokens.add(String(t).toLowerCase());
        }
      }

      function isKnownCard(c) {
        if (!baselineKeys) return false;
        const img = c.el.querySelector('img');
        const src = img && img.src;
        // 1. Primary content signal: the actual image displayed inside the card.
        // If the card has a rendered <img>, its content identity (media UUID or URL)
        // trumps any wrapper attribute (virtualized lists recycle wrapper DOM elements).
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
          const m = src.match(UUID_RE);
          if (m) {
            return baselineTokens.has(m[0].toLowerCase());
          }
          try {
            const p = new URL(src, location.href);
            if (baselineTokens.has((p.origin + p.pathname).toLowerCase())) return true;
          } catch {}
          if (baselineTokens.has(src.split('?')[0].toLowerCase())) return true;
          return false;
        }
        // 2. Element key signal (if image src not yet available or has no UUID)
        if (c.key) {
          const m = String(c.key).match(UUID_RE);
          if (m && baselineTokens.has(m[0].toLowerCase())) return true;
          if (baselineTokens.has(String(c.key).toLowerCase())) return true;
        }
        const mediaId = c.el.getAttribute('data-media-id');
        if (mediaId && baselineTokens.has(mediaId.toLowerCase())) return true;
        return false;
      }

      const fresh = imageCards.filter((c) => {
        if (baselineKeys) {
          return !isKnownCard(c);
        }
        return imageCards.length > baselineCount;
      });

      // Check the fresh cards for completion (newest first).
      const readyCard = fresh.slice().reverse().find((c) => {
        const img = c.el.querySelector('img');
        const hasSrc = !!(img && img.src && (img.src.startsWith('http') || img.src.startsWith('data:')));
        const text = c.el.innerText || '';
        const hasProgress = /\\b\\d+%\\b/.test(text);
        return hasSrc && !hasProgress;
      }) || null;

      return {
        ready: !!readyCard && !hasPending,
        count: imageCards.length,
        totalCount: cards.length,
        hasPending,
        card: readyCard ? {
          index: imageCards.indexOf(readyCard),
          kind: 'image',
          key: readyCard.key,
          mediaId:
            readyCard.el.getAttribute('data-media-id') ||
            (readyCard.el.querySelector('img') || { getAttribute: () => null }).getAttribute('data-media-id') ||
            null,
          src: (readyCard.el.querySelector('img') || { src: null }).src || null,
          alt: (readyCard.el.querySelector('img') || { alt: null }).alt || readyCard.el.getAttribute('aria-label') || null,
          rect: (() => {
            const r = readyCard.el.getBoundingClientRect();
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          })(),
        } : null,
      };
    })()`)) as {
      ready: boolean;
      count: number;
      totalCount: number;
      hasPending: boolean;
      card: FlowImageTile | null;
    };

    if (state.ready && state.card) {
      return state.card as FlowImageTile;
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for new image tile. ` +
    `Baseline: ${
      baseline instanceof Set
        ? `${baseline.size} known image card(s)`
        : `${baseline} image card(s)`
    }. Use --headed to inspect the Flow UI.`
  );
}

/**
 * Downloads a generated image from a URL to a local file path.
 */
export async function downloadImage(
  page: Page,
  imageUrl: string,
  outputPath: string
): Promise<void> {
  let buffer: Buffer | null = null;
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() =>
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  // 1. Direct Node fetch with browser headers
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://flow.google.com/',
      },
    });
    if (response.ok) {
      buffer = Buffer.from(await response.arrayBuffer());
    }
  } catch {
    // Fallback to in-page fetch
  }

  // 2. In-page fetch (try without credentials first for GCS signed URLs to avoid CORS credential errors)
  if (!buffer) {
    try {
      const base64Data = await page.evaluate(async (url) => {
        let response: Response;
        try {
          response = await fetch(url, { redirect: 'follow' });
        } catch {
          response = await fetch(url, { credentials: 'include', redirect: 'follow' });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return btoa(binary);
      }, imageUrl);
      buffer = Buffer.from(base64Data, 'base64');
    } catch {
      // In-page fetch failed
    }
  }

  // 3. Fallback: Node fetch with page cookies (only if not a cross-origin signed storage URL)
  if (!buffer) {
    const parsed = new URL(imageUrl);
    const isSignedGcs = parsed.hostname === 'storage.googleapis.com' || parsed.searchParams.has('Signature');
    const headers: Record<string, string> = { 'User-Agent': userAgent, Referer: 'https://flow.google.com/' };

    if (!isSignedGcs) {
      const cookies = await page.context().cookies();
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    const response = await fetch(imageUrl, { headers });
    if (!response.ok) {
      throw new Error(`Failed to download image: HTTP ${response.status} ${response.statusText}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  }

  if (buffer.length < 100) {
    throw new Error(`Downloaded image is abnormally small (${buffer.length} bytes).`);
  }

  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, buffer, { mode: 0o600 });
  await rename(temporary, resolved);
}

/**
 * Downloads generated video using direct fetch with browser fallback.
 * Flow content signed URLs are served from flow-content.google or storage.googleapis.com
 * with query-string HMAC credentials.
 */
/**
 * Dismisses the video player overlay after downloading a video, returning to the
 * canvas view so the next clip can be generated.  The Flow video player shows a
 * "Done" button at the top-left; clicking it closes the player and reveals the
 * image-tile canvas underneath.
 */
export async function dismissVideoPlayer(page: Page): Promise<void> {
  console.log(picocolors.gray('[flow-dom] Dismissing video player to return to canvas...'));

  // 1. Try clicking the "Done" button (visible in video player mode)
  const dismissed = await page.evaluate(() => {
    // Find the "Done" button in the video player toolbar
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'done') {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (dismissed) {
    console.log(picocolors.green('[flow-dom] ✓ Video player dismissed via Done button'));
    await new Promise((r) => setTimeout(r, 1000));
    return;
  }

  // 2. Fallback: press Escape to close the video player
  console.log(picocolors.gray('[flow-dom] Done button not found, pressing Escape...'));
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 800));

  // 3. Verify we're back on canvas by checking for the prompt input
  const hasPrompt = await page.evaluate(() => {
    return !!document.querySelector(
      'textarea[placeholder*="describe" i], textarea[aria-label*="prompt" i], [contenteditable="true"].ProseMirror'
    );
  }).catch(() => false);

  if (hasPrompt) {
    console.log(picocolors.green('[flow-dom] ✓ Canvas view restored'));
  } else {
    console.log(picocolors.yellow('[flow-dom] ⚠ Canvas state uncertain after dismissing video player'));
  }
}

export async function downloadVideoInPage(
  page: Page,
  videoUrl: string,
  outputPath: string
): Promise<void> {
  let buffer: Buffer | null = null;
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() =>
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  // 1. Direct Node fetch with full browser headers (User-Agent, Accept, Referer)
  try {
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'video/mp4,video/*,*/*;q=0.9',
        Referer: 'https://flow.google.com/',
      },
    });
    if (response.ok) {
      buffer = Buffer.from(await response.arrayBuffer());
    }
  } catch {
    // Fallback to in-page or cookie-authenticated fetch
  }

  // 2. In-page fetch via browser context (try without credentials first for GCS signed URLs)
  if (!buffer) {
    try {
      const base64Data = await page.evaluate(async (url) => {
        let response: Response;
        try {
          // Standard CORS fetch without credentials (necessary for cross-origin GCS signed URLs)
          response = await fetch(url, { redirect: 'follow' });
        } catch {
          // Fallback to credentialed fetch for same-origin endpoints
          response = await fetch(url, { credentials: 'include', redirect: 'follow' });
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return btoa(binary);
      }, videoUrl);
      buffer = Buffer.from(base64Data, 'base64');
    } catch {
      // In-page fetch failed
    }
  }

  // 3. Fallback: Node fetch with page cookies (only if not a signed storage URL)
  if (!buffer) {
    const parsed = new URL(videoUrl);
    const isSignedGcs = parsed.hostname === 'storage.googleapis.com' || parsed.searchParams.has('Signature');
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'video/mp4,video/*,*/*;q=0.9',
      Referer: 'https://flow.google.com/',
    };

    // Sending cookies to GCS signed URLs breaks HMAC signature and triggers HTTP 403
    if (!isSignedGcs) {
      const cookies = await page.context().cookies();
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    const response = await fetch(videoUrl, { headers });
    if (!response.ok) {
      throw new Error(`Failed to download video: HTTP ${response.status} ${response.statusText}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  }

  if (buffer.length < 100) {
    throw new Error(`Downloaded video file is abnormally small (${buffer.length} bytes); likely an error payload.`);
  }

  // Validate MP4 header (magic bytes)
  const isMp4 =
    (buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x00, 0x1c])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x00, 0x20])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x00, 0x18]))) &&
    buffer.subarray(4, 8).equals(Buffer.from('ftyp'));

  if (!isMp4) {
    const headerSnippet = buffer.toString('utf8', 0, Math.min(200, buffer.length));
    if (headerSnippet.includes('<Error>') || headerSnippet.includes('AccessDenied')) {
      throw new Error(`Video download returned XML access error: ${headerSnippet}`);
    }
    throw new Error(`Downloaded payload is not a valid MP4 video container (size: ${buffer.length} bytes, header: ${buffer.subarray(0, 8).toString('hex')}).`);
  }

  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, buffer, { mode: 0o600 });
  await rename(temporary, resolved);
}

/**
 * Selects an existing project image asset for the Start or End frame slot in Frames mode.
 */
export async function selectProjectFrameAssetForSlot(
  page: Page,
  slot: 'start' | 'end',
  match: { prompt?: string; name?: string; mediaKey?: string | null; indexFromTop?: number },
  debugDir?: string
): Promise<boolean> {
  await dismissCookieBanner(page).catch(() => {});
  const target = slot.toLowerCase();
  console.log(picocolors.cyan(`[flow-dom] Selecting ${slot} frame image from project...`));

  // 0. Ensure Agent mode is off
  await disableAgentModeIfNeeded(page);

  // 0b. Check if target slot already contains the desired image
  if (match.mediaKey) {
    const alreadyMatched = await page.evaluate(
      ({ targetSlot, key }) => {
        const frameTriggers = Array.from(document.querySelectorAll('.frame-trigger'));
        const idx = targetSlot === 'start' ? 0 : 1;
        const trigger = frameTriggers[idx];
        if (!trigger) return false;
        const img = trigger.querySelector('img');
        return !!(img && img.src && img.src.includes(key));
      },
      { targetSlot: target, key: match.mediaKey }
    ).catch(() => false);

    if (alreadyMatched) {
      console.log(
        picocolors.green(`✓ [flow-dom] ${slot} frame image already selected in prompt box (${match.mediaKey})`)
      );
      return true;
    }
  }

  // 1. If the target slot already contains an image, clear it first so it resets to empty button
  await page.evaluate((targetSlot) => {
    const frameTriggers = Array.from(document.querySelectorAll('.frame-trigger'));
    const idx = targetSlot === 'start' ? 0 : 1;
    const trigger = frameTriggers[idx];
    if (trigger && trigger.querySelector('img')) {
      const cancelBtn = trigger.querySelector('.hover-icon-overlay, mat-icon, button[aria-label*="cancel" i], button') as HTMLElement | null;
      if (cancelBtn) cancelBtn.click();
    }
  }, target);
  await new Promise((r) => setTimeout(r, 600));

  // 2. Locate and click the Start or End frame trigger in prompt box with polling wait
  let triggerPt: { x: number; y: number } | null = null;
  const findDeadline = Date.now() + 10_000;

  while (Date.now() < findDeadline) {
    triggerPt = await page.evaluate((targetSlot) => {
      // Pass 1: exact or partial text matching on frame triggers or empty chips.
      // Prefer real <button> elements: a `.frame-trigger` container can be much wider
      // than its chip, so clicking the container's center misses the control entirely.
      const triggers = Array.from(document.querySelectorAll('.frame-trigger button, button.empty-chip, .frame-trigger'));
      triggers.sort((a, b) => Number(a.tagName !== 'BUTTON') - Number(b.tagName !== 'BUTTON'));
      for (const t of triggers) {
        const text = (t.textContent || '').trim().toLowerCase();
        if (text === targetSlot || (targetSlot === 'start' && text.includes('start')) || (targetSlot === 'end' && text.includes('end'))) {
          t.scrollIntoView({ block: 'center' });
          const r = t.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }

      // Pass 2: positional order within .frame-trigger or flow-ingredient-bar
      const frameTriggers = Array.from(document.querySelectorAll('.frame-trigger'));
      const idx = targetSlot === 'start' ? 0 : 1;
      if (frameTriggers[idx]) {
        const el = (frameTriggers[idx].querySelector('button') || frameTriggers[idx]) as HTMLElement;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }

      // Pass 3: search within flow-ingredient-bar for any button
      const bar = document.querySelector('flow-ingredient-bar');
      if (bar) {
        const barBtns = Array.from(bar.querySelectorAll('button.empty-chip, button'));
        const candidate = targetSlot === 'start' ? barBtns[0] : barBtns[barBtns.length - 1];
        if (candidate) {
          const r = candidate.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }

      return null;
    }, target);

    if (triggerPt) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!triggerPt) {
    const debugDOM = await page.evaluate(() => {
      const box = document.querySelector('flow-prompt-box, .prompt-box, flow-ingredient-bar');
      return box ? box.innerHTML.slice(0, 500) : 'no prompt box';
    });
    throw new Error(`Could not find "${slot}" frame button in prompt box. DOM snippet: ${debugDOM}`);
  }

  await page.mouse.click(triggerPt.x, triggerPt.y);
  await new Promise((r) => setTimeout(r, 1200));

  // 3+4. Wait for the ASSET PICKER pane and click the matching asset.
  //     Flow keeps several CDK panes alive at once (the Frames settings panel, popovers,
  //     leftovers from the previous clip). Picking "the first visible pane" is unreliable:
  //     it can be the settings panel, which contains no assets, and the asset list itself
  //     renders asynchronously. So we poll every visible pane for real asset cards and only
  //     accept the pane that actually contains them.
  const snippet = (match.prompt || match.name || '').slice(0, 30).trim().toLowerCase();
  type PickResult = { ok: true; matched: 'mediaKey' | 'snippet' | 'index' } | { ok: false };
  let clicked: PickResult | null = null;
  const pickDeadline = Date.now() + 15_000;
  while (Date.now() < pickDeadline) {
    clicked = (await page.evaluate(
      ({ snippetText, targetMediaKey, fallbackIdx }) => {
        const isVisible = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (el as HTMLElement).offsetParent !== null;
        };
        const panes = Array.from(
          document.querySelectorAll('.cdk-overlay-pane:not(:has(mat-snack-bar-container))')
        ).filter((p) => isVisible(p) && !p.querySelector('flow-prompt-box-settings'));
        // The just-opened picker is the topmost pane → last in document order.
        for (const pane of panes.reverse()) {
          // Prefer real asset cards, one element per card. The live picker renders
          // `flow-add-menu-asset-item` wrapping a `button.asset-item`; querying both would
          // yield two nodes per card and corrupt the positional fallback index.
          let items: Element[] = Array.from(pane.querySelectorAll('button.asset-item'));
          if (items.length === 0) items = Array.from(pane.querySelectorAll('flow-add-menu-asset-item, flow-asset-item'));
          if (items.length === 0) items = Array.from(pane.querySelectorAll('.asset-item:not(button)'));
          if (items.length === 0) {
            // Last resort: an image-bearing button that is not a frame trigger.
            items = Array.from(pane.querySelectorAll('button:has(img)')).filter((b) => !b.closest('.frame-trigger'));
          }
          if (items.length === 0) continue;

          // A. Match by media key in thumbnail image src if available
          if (targetMediaKey) {
            for (const item of items) {
              const img = item.querySelector('img');
              if (img && img.src.includes(targetMediaKey)) {
                (item as HTMLElement).click();
                return { ok: true as const, matched: 'mediaKey' as const };
              }
            }
          }

          // B. Match by snippet text if available
          if (snippetText && snippetText.length >= 6) {
            for (const item of items) {
              if ((item.textContent || '').toLowerCase().includes(snippetText)) {
                (item as HTMLElement).click();
                return { ok: true as const, matched: 'snippet' as const };
              }
            }
          }

          // C. Positional fallback — no identity confirmation; logged loudly below.
          const idx = Math.min(Math.max(fallbackIdx || 0, 0), items.length - 1);
          const chosen = items[idx] as HTMLElement | null;
          if (chosen) {
            chosen.click();
            return { ok: true as const, matched: 'index' as const };
          }
        }
        return { ok: false as const };
      },
      { snippetText: snippet, targetMediaKey: match.mediaKey || null, fallbackIdx: match.indexFromTop ?? 0 }
    )) as PickResult;
    if (clicked.ok) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!clicked?.ok) {
    // Capture what actually opened so the next occurrence is diagnosable, and report
    // the pane inventory + slot state in the error instead of a bare message.
    await captureEvidence(page, `frame-asset-${slot}-not-clickable`, debugDir).catch(() => {});
    const diagnostic = await page
      .evaluate((targetSlot) => {
        const panes = Array.from(document.querySelectorAll('.cdk-overlay-pane')).map((p) => ({
          cls: String((p as HTMLElement).className).slice(0, 60),
          visible: (p as HTMLElement).offsetParent !== null,
          assets: p.querySelectorAll('button.asset-item, .asset-item, flow-add-menu-asset-item, flow-asset-item').length,
          imgs: p.querySelectorAll('img').length,
          menuItems: p.querySelectorAll('[role="menuitem"]').length,
          text: (p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        }));
        const triggers = Array.from(document.querySelectorAll('.frame-trigger'));
        const idx = targetSlot === 'start' ? 0 : 1;
        const slotHasImage = Boolean(triggers[idx]?.querySelector('img'));
        return { panes, slotHasImage };
      }, target)
      .catch(() => ({ panes: [] as unknown[], slotHasImage: null as boolean | null }));
    throw new Error(
      `Could not click matching asset for ${slot} frame. ` +
        `slotHasImage=${diagnostic.slotHasImage} panes=${JSON.stringify(diagnostic.panes)}`
    );
  }
  if (clicked.matched === 'index') {
    console.warn(
      picocolors.yellow(
        `[flow-dom] ⚠ ${slot} frame: asset picked by POSITIONAL fallback (index ${match.indexFromTop ?? 0}) — ` +
          `no media-key/prompt identity match. Verify the attached frame before submitting.`
      )
    );
  }
  await new Promise((r) => setTimeout(r, 800));

  // Click Add to prompt if present
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.cdk-overlay-pane button'));
    for (const b of btns) {
      if (/add to prompt/i.test(b.textContent || '')) {
        (b as HTMLElement).click();
        return;
      }
    }
  });
  await new Promise((r) => setTimeout(r, 600));

  await page.keyboard.press('Escape').catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  return true;
}
