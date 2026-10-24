/**
 * CDP Network and Response Observer for Google Flow Video Generation.
 *
 * Intercepts Flow API traffic (batchexecute, aisandbox-pa, trpc media redirects)
 * and sniffs signed Google Cloud Storage and Flow Content MP4 URLs.
 */
import type { CDPSession, Page, Response } from 'playwright-core';
import pc from 'picocolors';
import {
  hasActiveGenerationProgressOnPage,
  hasNewFlowFailure,
  readFlowFailureState,
  type FlowFailureState,
} from './dom.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const VIDEO_URL_REGEX = /https?:\/\/[^\s"'<>\\]+/gi;
const FLOW_GENERATION_API = /aisandbox-pa\.googleapis\.com\/v1\/video:(?:batchAsyncGenerateVideo|batchCheckAsyncVideoGenerationStatus)|getMediaUrlRedirect|media\.getMedia/i;

export interface CapturedApiResponse {
  url: string;
  status: number;
  body: string;
  capturedAt: string;
}

export interface WaitForVideoOptions {
  refreshIntervalMs?: number;
  failureBaseline?: FlowFailureState;
}

/**
 * Decodes Flow's batchexecute Unicode and URL escape characters.
 */
export function decodeEscapedResponseText(value: string): string {
  return value
    .replace(/\\+u([0-9a-fA-F]{4})/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
    .replace(/\\+\//g, '/')
    .replace(/\\+=/g, '=')
    .replace(/\\+&/g, '&')
    .replace(/\\+</g, '<')
    .replace(/\\+>/g, '>');
}

/**
 * Verifies whether a candidate URL is a generated Google Flow video.
 */
export function isFlowVideoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    if (/\.mp4(?:$|\?)/i.test(parsed.pathname + parsed.search)) return true;
    if (/\/image\/|\/thumbnail\/|\/thumb\//i.test(parsed.pathname)) return false;
    return (
      (parsed.hostname === 'storage.googleapis.com' &&
        /ai-sandbox-videofx|flow-content/i.test(parsed.pathname)) ||
      /^flow-content\.google(?:usercontent)?(?:\.com)?$/i.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Canonical identity of a Flow video URL: host + path WITHOUT the signed query.
 * Flow re-signs media URLs on every page load (Expires/Signature change each
 * time), so comparing full URLs makes an already-known video look "new" after
 * a refresh and the observer happily returns a stale duplicate. Identity must
 * be compared on host+path only.
 */
export function canonicalFlowVideoId(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return value;
  }
}

/**
 * Checks if a signed Google Cloud Storage or Google CDN URL has expired.
 */
export function isExpiredUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const expiresParam = parsed.searchParams.get('Expires');
    if (expiresParam) {
      const expiresSec = parseInt(expiresParam, 10);
      if (!isNaN(expiresSec) && expiresSec * 1000 < Date.now() - 5_000) {
        return true;
      }
    }
    const googDate = parsed.searchParams.get('X-Goog-Date');
    const googExpires = parsed.searchParams.get('X-Goog-Expires');
    if (googDate && googExpires) {
      const year = parseInt(googDate.substring(0, 4), 10);
      const month = parseInt(googDate.substring(4, 6), 10) - 1;
      const day = parseInt(googDate.substring(6, 8), 10);
      const hour = parseInt(googDate.substring(9, 11), 10);
      const min = parseInt(googDate.substring(11, 13), 10);
      const sec = parseInt(googDate.substring(13, 15), 10);
      const createdMs = Date.UTC(year, month, day, hour, min, sec);
      const durationMs = parseInt(googExpires, 10) * 1000;
      if (!isNaN(createdMs) && !isNaN(durationMs) && createdMs + durationMs < Date.now() - 5_000) {
        return true;
      }
    }
  } catch {
    // Malformed URL or no expiration params
  }
  return false;
}

/**
 * Identifies demo / sample videos bundled with the Flow UI.
 */
export function isDemoVideo(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.includes('gstatic.com')) return true;
    return (
      (parsed.hostname === 'storage.googleapis.com' &&
        /agent-skills|product-demo|demo|banners|banner/i.test(parsed.pathname)) ||
      /banners?|io2026/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Extracts candidate video URLs from an arbitrary text string.
 */
export function extractVideoUrls(text: string): string[] {
  if (!text) return [];
  const decoded = decodeEscapedResponseText(text);
  const found: string[] = [];
  for (const match of decoded.matchAll(VIDEO_URL_REGEX)) {
    const candidate = match[0].replace(/[),.;]+$/, '');
    if (isFlowVideoUrl(candidate) && !isDemoVideo(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * Observes page network traffic and DOM video elements to detect generated videos.
 */
export class FlowVideoObserver {
  private readonly candidates = new Set<string>();
  private readonly mediaIds = new Set<string>();
  private readonly baseline = new Set<string>();
  private readonly responseTasks = new Set<Promise<void>>();
  private readonly capturedApiResponses: CapturedApiResponse[] = [];
  private cdpSession: CDPSession | null = null;
  private upstreamError: string | undefined;
  private attached = false;
  /** Clean project canvas URL, captured so the observer can return after opening a tile. */
  private projectUrl: string | null = null;
  /** Round-robin index for clicking video tiles (newest → oldest across attempts). */
  private tileClickIndex = 0;
  /** Throttle so a tile click / navigation settles before the next attempt. */
  private lastTileClickAt = 0;

  /**
   * Clears per-generation transient state so the same observer instance can watch
   * a fresh attempt after a risk-control refresh/retry (listeners stay attached).
   */
  reset(): void {
    this.upstreamError = undefined;
    this.candidates.clear();
    this.mediaIds.clear();
    this.baseline.clear();
    this.capturedApiResponses.length = 0;
    this.responseTasks.clear();
    this.tileClickIndex = 0;
    this.lastTileClickAt = 0;
  }

  /**
   * Attaches network and CDP listeners to the Playwright Page.
   * Idempotent: re-attaching on a retry attempt must not stack listeners.
   */
  async attach(page: Page): Promise<void> {
    if (this.attached) return;
    this.attached = true;

    // 1. High-level Playwright response listener
    page.on('response', (response: Response) => {
      const task = this.inspectResponse(response).finally(() =>
        this.responseTasks.delete(task)
      );
      this.responseTasks.add(task);
    });

    // 2. CDP Network session for raw batchexecute responses
    await this.attachCdpSession(page);
  }

  /**
   * Initializes or re-initializes the CDP session on the page.
   * On Chromium navigation/reload, CDP sessions are terminated by the browser,
   * so this method detaches any dead session and binds a fresh one.
   */
  private async attachCdpSession(page: Page): Promise<void> {
    try {
      if (this.cdpSession) {
        await this.cdpSession.detach().catch(() => {});
        this.cdpSession = null;
      }
      this.cdpSession = await page.context().newCDPSession(page);
      await this.cdpSession.send('Network.enable');

      const pendingBodies = new Map<string, { requestId: string; url: string; status: number }>();

      this.cdpSession.on('Network.responseReceived', (event: any) => {
        const url: string = event.response?.url || '';
        if (
          (url.includes('batchexecute') || url.includes('StreamChat') || url.includes('FlowCreationAgentService')) &&
          url.includes('flow.google.com')
        ) {
          pendingBodies.set(event.requestId, {
            requestId: event.requestId,
            url,
            status: event.response.status,
          });
        }
      });

      this.cdpSession.on('Network.loadingFinished', async (event: any) => {
        const pending = pendingBodies.get(event.requestId);
        if (!pending || !this.cdpSession) return;
        pendingBodies.delete(event.requestId);
        try {
          const result = await this.cdpSession.send('Network.getResponseBody', {
            requestId: event.requestId,
          });
          if (result?.body) {
            this.capturedApiResponses.push({
              url: pending.url,
              status: pending.status,
              body: result.body,
              capturedAt: new Date().toISOString(),
            });

            // Check for backend error codes like PUBLIC_ERROR_UNUSUAL_ACTIVITY
            if (result.body.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY')) {
              this.upstreamError = 'Google Flow backend error: PUBLIC_ERROR_UNUSUAL_ACTIVITY (Google reCAPTCHA flagged unusual activity / rate limit on current proxy IP)';
            }

            this.addMatches(result.body);
          }
        } catch {
          // Request aborted or superseded
        }
      });
    } catch {
      // CDP session creation failed; high-level response listener serves as fallback
    }
  }

  /**
   * Records existing baseline URLs manually (stored by canonical identity —
   * re-signed variants of the same video collapse into one entry).
   */
  recordExisting(urls: string[]): void {
    for (const url of urls) {
      this.baseline.add(canonicalFlowVideoId(url));
    }
  }

  /**
   * Checks if a URL is recorded in the baseline (canonical identity compare).
   */
  isRecorded(url: string): boolean {
    return this.baseline.has(canonicalFlowVideoId(url));
  }

  /**
   * Captures existing media elements in DOM prior to triggering generation.
   */
  async markExistingMedia(page: Page): Promise<void> {
    try {
      // Remember the clean project URL (strip any /edit/<id> suffix) so the
      // observer can return to the canvas after opening a tile detail view.
      if (/\/project\//.test(page.url())) {
        this.projectUrl = page.url().split('/edit/')[0];
      }
      const urls = await page.$$eval('video', (videos) =>
        videos.flatMap((v) => {
          const el = v as HTMLVideoElement;
          const sources = Array.from(el.querySelectorAll('source')).map((s) => s.src);
          return [el.currentSrc, el.src, ...sources].filter(Boolean);
        })
      );
      for (const u of urls) {
        this.addMatches(u, this.baseline);
      }

      // Also baseline any candidate URLs or API response URLs already present before generation
      for (const candidate of this.candidates) {
        this.baseline.add(canonicalFlowVideoId(candidate));
      }
      for (const resp of this.capturedApiResponses) {
        for (const u of extractVideoUrls(resp.body)) {
          this.baseline.add(canonicalFlowVideoId(u));
        }
      }

      // Clear any pre-existing media IDs on canvas from discovery pool
      const existingMediaIds = await page.evaluate(() => {
        const els = document.querySelectorAll(
          '[data-media-id], [data-name], [data-id], flow-image-tile, [class*="video-tile"], [class*="grid-tile"]'
        );
        return Array.from(els)
          .map((el) => el.getAttribute('data-media-id') || el.getAttribute('data-name') || el.getAttribute('data-id'))
          .filter(Boolean) as string[];
      }).catch(() => []);

      for (const id of existingMediaIds) {
        this.mediaIds.delete(id);
      }
    } catch {
      // Page might still be loading
    }
  }

  /**
   * Probes candidate video URL to verify it is not expired or returning 401/403/404.
   */
  private async verifyUrlAccessible(url: string, userAgent?: string): Promise<boolean> {
    if (isExpiredUrl(url)) {
      return false;
    }
    try {
      // Use GET with Range: bytes=0-1023 because GCS signed URLs sign the GET HTTP method
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-1023',
          'User-Agent': userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          Referer: 'https://flow.google.com/',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 403 || res.status === 401 || res.status === 404) {
        return false;
      }
      return res.ok || res.status === 206;
    } catch {
      return true; // Don't discard on temporary local connection error
    }
  }

  /**
   * Scans DOM for newly rendered video elements.
   */
  async captureVideoElements(page: Page): Promise<void> {
    try {
      const urls = await page.$$eval('video', (videos) =>
        videos.flatMap((v) => {
          const el = v as HTMLVideoElement;
          const sources = Array.from(el.querySelectorAll('source')).map((s) => s.src);
          return [el.currentSrc, el.src, ...sources].filter(Boolean);
        })
      );
      for (const u of urls) {
        this.addMatches(u);
      }
    } catch {
      // Ignore DOM evaluation errors during navigation
    }
  }

  /**
   * Resolves discovered media names to signed URLs via in-page redirect fetch.
   */
  async resolveMediaIds(page: Page): Promise<void> {
    for (const mediaId of this.mediaIds) {
      try {
        const resolved = await page.evaluate(async (name) => {
          const endpoint = `/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(name)}`;
          const res = await fetch(endpoint, { credentials: 'include', redirect: 'follow' });
          return res.ok ? res.url : '';
        }, mediaId);
        if (resolved) {
          this.addMatches(resolved);
        }
      } catch {
        // Redirect may not be available yet while video is processing
      }
    }
  }

  /**
   * Detects whether video generation is still in progress on the canvas
   * (pending tiles with percentage progress, "Generating" state, Stop button,
   * or queued banner). While this returns true, clicking newly rendered video
   * cards must be avoided - they are still generating and clicking them opens
   * the video detail/player view prematurely.
   */
  async hasActiveGenerationProgress(page: Page): Promise<boolean> {
    return hasActiveGenerationProgressOnPage(page);
  }

  /**
   * Polls network traffic, CDP responses, and DOM video elements until a video URL is obtained.
   * Periodically reloads the page (default every 60s) to synchronize with server-side generation
   * state in case the frontend WebSocket or DOM state becomes stale.
   */
  async waitForVideo(
    page: Page,
    timeoutMs: number,
    options?: WaitForVideoOptions
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const refreshIntervalMs = options?.refreshIntervalMs ?? 60_000;
    let lastRefresh = Date.now();
    let sawQueued = false;
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);

    while (Date.now() < deadline) {
      if (this.upstreamError) {
        throw new Error(this.upstreamError);
      }

      // Check for in-page chat error card
      const pageError = await page.evaluate(() => {
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
        // Google anti-abuse rejection tiles ("We noticed some unusual activity")
        if (/noticed some unusual activity|unusual activity.*help center/i.test(bodyText)) {
          return 'Google Flow anti-abuse: We noticed some unusual activity. Please visit the Help Center for more information.';
        }
        return null;
      }).catch(() => null);

      if (pageError) {
        throw new Error(`Google Flow generation error: ${pageError}`);
      }

      // Check failure baseline diff if provided
      if (options?.failureBaseline) {
        const failureState = await readFlowFailureState(page);
        if (hasNewFlowFailure(failureState, options.failureBaseline)) {
          const errMsg =
            failureState.errorTileTexts[0] ||
            (failureState.riskBodyText
              ? 'Google Flow anti-abuse: We noticed some unusual activity. Please visit the Help Center for more information.'
              : 'Google Flow canvas generation failed.');
          throw new Error(`Google Flow generation error: ${errMsg}`);
        }
      }

      // Check if queued banner is visible
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/scheduled and is waiting in the queue/i.test(bodyText)) {
        sawQueued = true;
      }

      await this.captureVideoElements(page);
      await this.resolveMediaIds(page);

      const found = await this.findNewVideoUrl(userAgent);
      if (found) return found;

      // If no video URL captured yet, attempt to activate newly rendered video
      // cards on the canvas - but ONLY after generation has had enough time to mount (>= 8s)
      // and when no active progress is running. Clicking prematurely opens stale cards.
      // CRITICAL: MUST exclude buttons/triggers inside the prompt input box or ingredient bars
      // (e.g. .frame-trigger, flow-ingredient-chip, [class*="prompt-box"]) which contain
      // "play_circle" icons for Start/End frame buttons. Clicking those would open file upload
      // or asset overlays instead of opening the generated video on the canvas!
      const elapsedSinceStart = Date.now() - (deadline - timeoutMs);
      if (
        elapsedSinceStart >= 8_000 &&
        !(await this.hasActiveGenerationProgress(page)) &&
        Date.now() - this.lastTileClickAt >= 12_000
      ) {
        this.lastTileClickAt = Date.now();
        const onProjectCanvas = /\/project\//.test(page.url()) && !page.url().includes('/edit/');
        if (!onProjectCanvas && this.projectUrl) {
          // A previous click opened a generation detail view without yielding a
          // new URL — return to the canvas to try another tile.
          await page
            .goto(this.projectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => {});
          await this.attachCdpSession(page);
          await new Promise((r) => setTimeout(r, 4_000));
        } else {
          // PREFERRED: click a completed VIDEO tile's preview overlay. That opens the
          // generation detail view, which fetches the signed video URL
          // (flow-content.google/video/<id>) that inspectResponse captures. Clicking a
          // tile FOOTER play icon (the old `playIcons[last]` behaviour) does nothing and
          // left the observer waiting for the full timeout. Tiles are tried newest→oldest
          // so an already-known clip can never block detection of the fresh one.
          const idx = this.tileClickIndex++;
          await page
            .evaluate((i) => {
              const tiles = Array.from(document.querySelectorAll('flow-video-tile')) as HTMLElement[];
              if (tiles.length > 0) {
                const pos = (tiles.length - 1 - (i % tiles.length) + tiles.length) % tiles.length;
                const tile = tiles[pos];
                const target =
                  (tile.querySelector(
                    '.type-icon-container mat-icon, .pre-hover-overlay mat-icon, img.thumbnail'
                  ) as HTMLElement | null) || tile;
                target.click();
                return;
              }
              // Fallback: legacy play-icon scan (excluding prompt/frame controls).
              const playIcons = Array.from(document.querySelectorAll('*')).filter((el) => {
                if (el.children.length !== 0) return false;
                const text = (el.textContent || '').trim();
                if (!/^(?:play_arrow|play_circle)$/i.test(text)) return false;
                if (el.closest('.frame-trigger, flow-ingredient-chip, flow-image-ingredient-chip, [class*="prompt-box"], flow-prompt-box, .prompt-top-row')) {
                  return false;
                }
                return true;
              });
              if (playIcons.length > 0) {
                (playIcons[playIcons.length - 1] as HTMLElement).click();
              }
            }, idx)
            .catch(() => {});
        }
      }

      // Periodic force-refresh: video generation is an asynchronous server-side task.
      // If frontend DOM or WebSocket state has stalled, refreshing re-fetches the latest
      // project media from Google's server without cancelling the background task.
      if (refreshIntervalMs > 0 && Date.now() - lastRefresh >= refreshIntervalMs && Date.now() + 3_000 < deadline) {
        const elapsedSec = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
        console.log(
          pc.yellow(
            `[flow-observer] Waited ${elapsedSec}s without video URL; refreshing page to synchronize server-side generation status...`
          )
        );
        lastRefresh = Date.now();
        const currentUrl = page.url();
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {
          if (currentUrl && currentUrl.startsWith('http')) {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          }
        }
        // Re-attach fresh CDP session after page reload to ensure raw response bodies continue streaming
        await this.attachCdpSession(page);
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    await Promise.race([
      Promise.allSettled([...this.responseTasks]),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    if (this.upstreamError) {
      throw new Error(this.upstreamError);
    }

    // Final rescue: server-side generation keeps running past the deadline and
    // videos have been observed landing MINUTES after a wait gave up (the old
    // 600s timeout aborted rounds whose videos completed shortly after).
    // Reload once, let the media list stream in, and rescan before failing.
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.attachCdpSession(page);
      await new Promise((r) => setTimeout(r, 15_000));
      await this.captureVideoElements(page);
      await this.resolveMediaIds(page);
      const rescued = await this.findNewVideoUrl(userAgent);
      if (rescued) {
        console.log(
          pc.green(`[flow-observer] Rescued freshly completed video URL after final refresh: ${rescued.slice(0, 90)}...`)
        );
        return rescued;
      }
    } catch {
      // Page may be gone; fall through to the timeout error below.
    }

    throw new Error(
      sawQueued
        ? `Flow accepted the video request, but it remained queued for ${Math.round(timeoutMs / 1000)}s without completing.`
        : `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a Flow video URL. ` +
          `Server-side synthesis can exceed this under load — raise FLOW_TIMEOUT_SEC to wait longer, or verify generation status with --headed.`
    );
  }

  /**
   * Returns the first newly-discovered, accessible video URL, or null.
   * Inaccessible candidates are folded into the baseline so they are never retried.
   */
  private async findNewVideoUrl(userAgent?: string): Promise<string | null> {
    // Check captured API responses
    for (const resp of this.capturedApiResponses) {
      const urls = extractVideoUrls(resp.body);
      for (const u of urls) {
        if (!this.baseline.has(canonicalFlowVideoId(u))) {
          const accessible = await this.verifyUrlAccessible(u, userAgent);
          if (accessible) {
            return u;
          }
          this.baseline.add(canonicalFlowVideoId(u));
          this.candidates.delete(u);
        }
      }
    }

    const candidate = this.bestCandidate();
    if (candidate) {
      const accessible = await this.verifyUrlAccessible(candidate, userAgent);
      if (accessible) {
        return candidate;
      }
      this.baseline.add(canonicalFlowVideoId(candidate));
      this.candidates.delete(candidate);
    }
    return null;
  }

  /**
   * Returns all captured API responses for debugging snapshots.
   */
  getCapturedApiResponses(): CapturedApiResponse[] {
    return [...this.capturedApiResponses];
  }

  /**
   * Detaches CDP session and clears event listeners.
   */
  async detach(): Promise<void> {
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
    this.attached = false;
  }

  private async inspectResponse(response: Response): Promise<void> {
    const url = response.url();
    // The signed media URL is delivered as the RESPONSE URL when a completed
    // video is opened (the /edit view fetches flow-content.google/video/<id>
    // directly). Flow does not echo it in a JSON body, and the content-type is
    // video/*, so body inspection alone never sees it. Capture the URL itself.
    if (isFlowVideoUrl(url)) {
      this.addMatches(url);
    }
    const headers = response.headers();
    const location = headers.location;
    if (location) {
      this.addMatches(location);
    }

    if (FLOW_GENERATION_API.test(url) && response.status() >= 400) {
      const errorText = await response.text().catch(() => '');
      this.upstreamError = `Flow video generation API returned HTTP ${response.status()}: ${errorText.slice(0, 200)}`;
    }

    const contentType = headers['content-type']?.toLowerCase() || '';
    if (!contentType.includes('json') && !contentType.includes('text') && !FLOW_GENERATION_API.test(url)) {
      return;
    }

    try {
      const text = await response.text();
      if (text && text.length <= MAX_RESPONSE_BYTES) {
        this.addMatches(text);
        for (const match of text.matchAll(/(?:"name"|"mediaId"|"media_id")\s*:\s*"([^"]+)"/g)) {
          if (/^(?:media|projects\/[^/]+\/media)\//i.test(match[1])) {
            this.mediaIds.add(match[1]);
          }
        }
      }
    } catch {
      // Ignored if navigation aborted
    }
  }

  private addMatches(value: string, target = this.candidates): void {
    if (!value) return;
    const urls = extractVideoUrls(value);
    for (const url of urls) {
      target.add(url);
    }
  }

  private bestCandidate(): string | undefined {
    // Canonical identity compare: a re-signed URL of an already-known video is
    // NOT eligible — it would be a stale duplicate (see canonicalFlowVideoId).
    const eligible = [...this.candidates].filter((u) => !this.baseline.has(canonicalFlowVideoId(u)));
    return (
      eligible.find((u) => /\.mp4(?:\?|$)/i.test(u)) ||
      eligible[0]
    );
  }
}
