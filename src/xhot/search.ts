import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Page, ElementHandle } from 'playwright-core';
import pc from 'picocolors';
import type { XHotCandidate } from './contracts.js';

export interface SearchXOptions {
  query: string;
  candidateCount?: number;
  maxAgeHours?: number;
  outDir: string;
  onProgress?: (msg: string) => void;
}

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const MIN_SHOT_BYTES = 8_000;

/**
 * Checks if a tweet element is a promoted ad or sponsored post.
 */
export async function isPromotedTweet(tweetEl: ElementHandle): Promise<boolean> {
  try {
    const isAd = await tweetEl.evaluate((node) => {
      const el = node as HTMLElement;
      const text = el.innerText || el.textContent || '';
      // 1. Direct text regex for isolated or line-start 'Ad', 'Promoted', '赞助', '广告'
      const adPatterns = [
        /(?:^|\n)\s*(?:Ad|Promoted|Sponsored|赞助|廣告|广告)\s*(?:\n|$)/i,
        /\b(Promoted by|Sponsored by)\b/i,
      ];
      for (const pattern of adPatterns) {
        if (pattern.test(text)) return true;
      }

      // 2. DOM selectors often used by X for promoted placements
      if (el.querySelector?.('[data-testid="placementTracking"]')) return true;
      if (el.querySelector?.('svg[aria-label="Ad"], svg[aria-label="Promoted"]')) return true;

      // 3. Inspect user header metadata spans for explicit 'Ad' label
      const spans = Array.from(el.querySelectorAll?.('span') || []);
      for (const span of spans) {
        const t = (span.textContent || '').trim();
        if (t === 'Ad' || t === 'Promoted' || t === 'Sponsored' || t === '赞助' || t === '广告') {
          return true;
        }
      }

      return false;
    });

    return isAd;
  } catch {
    return false;
  }
}

function parseMetricNumber(text?: string | null): number {
  if (!text) return 0;
  const cleaned = text.trim().replace(/,/g, '');
  const match = cleaned.match(/^([\d.]+)\s*([KkMmBb])?$/);
  if (!match) {
    const direct = parseInt(cleaned, 10);
    return isNaN(direct) ? 0 : direct;
  }
  const num = parseFloat(match[1]);
  const mult = match[2]?.toUpperCase();
  if (mult === 'K') return Math.round(num * 1_000);
  if (mult === 'M') return Math.round(num * 1_000_000);
  if (mult === 'B') return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

/**
 * Captures a single candidate tweet via a freshly resolved locator.
 *
 * X virtualizes its timeline: element handles captured before scrolling can go
 * stale and screenshot the wrong region. Resolving the locator by status id at
 * capture time, waiting for media, and validating geometry keeps the evidence
 * chain intact. There is intentionally NO whole-page fallback: a bad capture
 * must be skipped, never silently replaced with an unrelated screenshot.
 */
type CaptureResult =
  | { status: 'ok'; candidate: XHotCandidate }
  | { status: 'stale'; ageHours: number; handle: string; text: string }
  | { status: 'invalid'; reason: string };

async function captureCandidate(
  page: Page,
  id: string,
  href: string | null,
  shotPath: string,
  index: number,
  maxAgeHours?: number
): Promise<CaptureResult> {
  const locator = page
    .locator(`article[data-testid="tweet"]:has(a[href*="/status/${id}"])`)
    .first();

  // An external window manager periodically flaps the window size (observed
  // 1439 -> 1 -> 1439 on an 800x600 screen), which leaves the page rendering in
  // a narrow condensed layout. Force-normalize before any capture geometry math.
  const preWin = await page
    .evaluate(() => ({ iw: window.innerWidth, ih: window.innerHeight }))
    .catch(() => ({ iw: 1440, ih: 900 }));
  if (preWin.iw < 1000 || preWin.ih < 500) {
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await locator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  // Precise post time from the <time datetime> element (ISO 8601)
  const postedAtIso =
    (await locator
      .locator('time')
      .first()
      .getAttribute('datetime')
      .catch(() => null)) || null;
  let ageHours: number | undefined;
  if (postedAtIso) {
    const postedMs = Date.parse(postedAtIso);
    if (!Number.isNaN(postedMs)) {
      ageHours = Math.max(0, Math.round(((Date.now() - postedMs) / 3_600_000) * 10) / 10);
    }
  }

  // Recency gate BEFORE any screenshot work: stale tweets never enter the grid
  if (maxAgeHours !== undefined && ageHours !== undefined && ageHours > maxAgeHours) {
    const handleLine =
      (await locator.locator('[data-testid="User-Name"]').innerText().catch(() => '')) || '';
    return { status: 'stale', ageHours, handle: handleLine.split('\n')[0] || '', text: id };
  }

  // Wait for lazy media inside the card to finish loading before shooting
  await locator
    .evaluate((el) => {
      const root = el as HTMLElement;
      return Promise.all(
        Array.from(root.querySelectorAll('img')).map((img) =>
          img.complete && img.naturalWidth > 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              })
        )
      );
    })
    .catch(() => {});
  await page.waitForTimeout(350);

  // Robust geometry-verified capture: take a full viewport screenshot and crop
  // the card region with sharp. The crop is scaled by (shot width / innerWidth)
  // so it stays correct under any devicePixelRatio or window-size fluctuation.
  // X's sticky stack (header + tabs) is ~115px tall; cards must sit below it.
  // The window can be resized externally mid-capture (observed resize flaps),
  // so measure -> shoot -> re-measure and retry until geometry is self-consistent.
  const HEADER_SAFE = 125;
  const readWin = () =>
    page.evaluate(() => ({ iw: window.innerWidth, ih: window.innerHeight }));

  let win = await readWin();
  let box = await locator.boundingBox().catch(() => null);
  if (box && Math.abs(box.y - HEADER_SAFE) > 4) {
    await page.evaluate((d) => window.scrollBy(0, d), box.y - HEADER_SAFE).catch(() => {});
    await page.waitForTimeout(500);
    box = await locator.boundingBox().catch(() => null);
  }
  if (
    !box ||
    box.y < HEADER_SAFE - 8 ||
    box.x < 0 ||
    box.width < 200 ||
    box.height < 120 ||
    box.y + 150 > win.ih
  ) {
    return { status: 'invalid', reason: 'card not renderable below sticky header' };
  }

  let thumbBuffer: Buffer | null = null;
  let lastReason = 'capture unstable after retries';
  for (let attempt = 0; attempt < 3; attempt++) {
    let fullShot: Buffer;
    try {
      fullShot = (await page.screenshot({ type: 'png', timeout: 10_000 })) as Buffer;
    } catch {
      lastReason = 'viewport screenshot failed';
      continue;
    }
    // Geometry must be identical before AND after the shot, and the shot must
    // cover the current window — otherwise the window resized mid-capture.
    const boxAfter = await locator.boundingBox().catch(() => null);
    win = await readWin();
    const meta = await sharp(fullShot).metadata();
    if (!boxAfter || !box) {
      lastReason = 'card element vanished mid-capture';
      box = boxAfter;
      await page.waitForTimeout(600);
      continue;
    }
    const stable =
      boxAfter &&
      box &&
      Math.abs(boxAfter.x - box.x) <= 2 &&
      Math.abs(boxAfter.y - box.y) <= 2 &&
      Math.abs(boxAfter.width - box.width) <= 2;
    const shotMatchesWindow =
      !!meta.width && meta.width >= win.iw * 0.95 && meta.width <= win.iw * 2.2 &&
      !!meta.height && meta.height >= win.ih * 0.95;
    if (!stable || !shotMatchesWindow) {
      lastReason = 'window geometry shifted mid-capture';
      box = boxAfter;
      await page.waitForTimeout(600);
      continue;
    }
    const scale = win.iw > 0 ? (meta.width as number) / win.iw : 1;
    const cropH = Math.min(box.height, win.ih - box.y - 4);
    if (cropH < 120) {
      lastReason = 'card clipped by viewport bottom';
      break;
    }
    const left = Math.max(0, Math.round(box.x * scale));
    const top = Math.max(0, Math.round(box.y * scale));
    const width = Math.min(Math.round(box.width * scale), (meta.width as number) - left);
    const height = Math.min(Math.round(cropH * scale), (meta.height as number) - top);
    if (width < 200 || height < 120) {
      lastReason = 'crop region degenerate';
      break;
    }
    try {
      thumbBuffer = await sharp(fullShot)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
    } catch {
      lastReason = 'sharp crop failed';
      break;
    }
    break;
  }
  if (!thumbBuffer) {
    return { status: 'invalid', reason: lastReason };
  }
  if (!thumbBuffer || thumbBuffer.length < MIN_SHOT_BYTES) {
    return { status: 'invalid', reason: 'screenshot suspiciously small' };
  }
  await fs.writeFile(shotPath, thumbBuffer).catch(() => {});

  // Extract content from the same fresh locator so text matches the screenshot
  const authorText =
    (await locator.locator('[data-testid="User-Name"]').innerText().catch(() => '')) || '';
  const authorLines = authorText.split('\n');
  const authorName = authorLines[0] || 'Unknown';
  const authorHandle = authorLines.find((t) => t.startsWith('@')) || '';
  const text = (
    (await locator.locator('[data-testid="tweetText"]').innerText().catch(() => '')) || ''
  ).trim();

  const metricOf = async (sel: string) =>
    parseMetricNumber(await locator.locator(sel).innerText().catch(() => '0'));
  const replies = await metricOf('[data-testid="reply"]');
  const reposts = await metricOf('[data-testid="retweet"]');
  const likes = await metricOf('[data-testid="like"]');
  const views = parseMetricNumber(
    await locator.locator('a[href*="/analytics"]').innerText().catch(() => '0')
  );

  const mediaUrls = await locator
    .locator('img[src*="pbs.twimg.com/media/"]')
    .evaluateAll((els) =>
      els
        .map((el) => (el as Element).getAttribute('src') || '')
        .filter((src) => src.length > 0)
    )
    .catch(() => [] as string[]);

  return {
    status: 'ok',
    candidate: {
      index,
      id,
      url: href ? (href.startsWith('http') ? href : `https://x.com${href}`) : undefined,
      authorName,
      authorHandle,
      text,
      timestamp: postedAtIso ?? undefined,
      ageHours,
      metrics: { replies, reposts, likes, views },
      mediaUrls,
      screenshotPath: shotPath,
      thumbnailBuffer: thumbBuffer,
    },
  };
}

/**
 * Searches X for a query and collects candidate tweets with verified screenshots.
 *
 * Strategy: sweep the Top (f=top) feed first; if the feed is exhausted (ads /
 * duplicates) before reaching candidateCount, explicitly extend the sweep with
 * the Latest (f=live) feed. Candidates are deduplicated by tweet id across feeds.
 */
export async function searchXCandidates(
  page: Page,
  options: SearchXOptions
): Promise<XHotCandidate[]> {
  const { query, candidateCount = 12, maxAgeHours, outDir, onProgress } = options;
  const shotsDir = path.join(outDir, 'candidate-shots');
  await fs.mkdir(shotsDir, { recursive: true });

  const report = (msg: string) => {
    console.log(pc.cyan(`[x-search] ${msg}`));
    onProgress?.(msg);
  };

  const candidates: XHotCandidate[] = [];
  const seenIds = new Set<string>();

  const sweepFeed = async (rank: 'top' | 'live'): Promise<void> => {
    const feedLabel = rank === 'top' ? 'Top' : 'Latest';
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&f=${rank}`;
    report(`Navigating to ${feedLabel} feed: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.waitForSelector(TWEET_SELECTOR, { state: 'visible', timeout: 20_000 }).catch(() => {});

    let scrollAttempts = 0;
    const maxScrollAttempts = 24;
    let adSkips = 0;

    while (candidates.length < candidateCount && scrollAttempts < maxScrollAttempts) {
      scrollAttempts++;
      const tweetElements = await page.$$(TWEET_SELECTOR);

      for (const tweetEl of tweetElements) {
        if (candidates.length >= candidateCount) break;

        try {
          if (await isPromotedTweet(tweetEl)) {
            adSkips++;
            continue;
          }

          // Extract tweet link / ID
          const linkEl = await tweetEl.$('a[href*="/status/"]');
          const href = linkEl ? await linkEl.getAttribute('href') : null;
          let id = '';
          if (href) {
            const match = href.match(/\/status\/(\d+)/);
            id = match ? match[1] : '';
          }
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);

          const shotPath = path.join(
            shotsDir,
            `candidate-${String(candidates.length + 1).padStart(2, '0')}.png`
          );

          const result = await captureCandidate(
            page,
            id,
            href,
            shotPath,
            candidates.length + 1,
            maxAgeHours
          );
          if (result.status === 'stale') {
            report(
              `Tweet ${result.text} skipped: too old (${result.ageHours}h > ${maxAgeHours}h limit) [@${result.handle}]`
            );
            continue;
          }
          if (result.status === 'invalid') {
            report(
              `Tweet ${id} skipped: ${result.reason} (no fallback shot is taken)`
            );
            continue;
          }

          const candidate = result.candidate;
          candidates.push(candidate);
          report(
            `Collected candidate #${candidate.index}: [${candidate.authorHandle}] ${candidate.text
              .slice(0, 50)
              .replace(/\n/g, ' ')}...`
          );
        } catch {
          // Continue sweep on individual tweet parsing error
        }
      }

      if (candidates.length < candidateCount) {
        report(
          `Scrolling ${feedLabel} feed for more tweets (${candidates.length}/${candidateCount}, ads skipped: ${adSkips})...`
        );
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(1800);
      }
    }

    report(
      `${feedLabel} feed sweep done: ${candidates.length}/${candidateCount} candidates so far (ads skipped: ${adSkips}, scroll attempts: ${scrollAttempts}).`
    );
  };

  await sweepFeed('top');
  if (candidates.length < candidateCount) {
    report(
      `Top feed exhausted with ${candidates.length} candidates — extending search with Latest feed to reach ${candidateCount}.`
    );
    await sweepFeed('live');
  }

  report(`Finished topic search: captured ${candidates.length} candidates.`);
  return candidates;
}
