/**
 * Browser-based YouTube transcript retrieval.
 *
 * Why this exists: the shared proxy exit IP (PROXY_URL) is bot-flagged by
 * YouTube for watch-page/player endpoints, so yt-dlp cannot reliably fetch
 * subtitles for candidate videos through the proxy — anonymous requests hit
 * "Sign in to confirm you're not a bot", and routing the logged-in Google
 * session through the same exit IP gets the account session revoked.
 *
 * The persistent-profile browser connects through the shared egress proxy
 * (BROWSER_PROXY_URL; this box has no direct internet access) with the trusted
 * Google session, which is the environment's designed path for authenticated
 * YouTube traffic. This module opens the watch page in that browser, reads the
 * caption track list from ytInitialPlayerResponse, and downloads the chosen
 * track as VTT from within the page context.
 *
 * Egress rate-limit awareness: when the proxy exit IP is flagged by Google,
 * watch-page requests are answered with HTTP 302 → google.com/sorry (HTTP 429,
 * "unusual traffic") and ytInitialPlayerResponse never exists. That must be
 * reported as YOUTUBE_RATE_LIMITED (egress-wide, retryable after backoff), not
 * misreported as a video-level SUBTITLE_NOT_AVAILABLE.
 */
import type { Page } from 'playwright-core';
import { launchBrowser } from '../../browser/launcher.js';
import { releaseBrowser } from '../../browser/session.js';
import type { Browser } from 'playwright-core';
import type { Transcript } from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import { selectBestSubtitleTrack, type SubtitleTrack } from './subtitles.js';
import { parseVtt } from './vtt.js';
import { toWatchUrl, extractVideoId } from './urls.js';
import { probeEgressRateLimited } from './egress-probe.js';

export interface BrowserTranscriptOptions {
  videoId: string;
  preferredLanguages?: readonly string[];
  /** Profile dir for the persistent browser session (defaults to launcher default). */
  profileDir?: string;
  /** Run headless (default false — keep the resident headful session alive so the
   *  user's login survives; headless transitions restart the browser and drop it). */
  headless?: boolean | 'shell';
  /** Release the browser afterwards; default false — matches pipeline keep-alive policy. */
  closeBrowser?: boolean;
  /** Timeout per page operation in ms (default 60s). */
  timeoutMs?: number;
}

interface PagePlayerCaptions {
  loggedIn: boolean | null;
  status: string | null;
  reason: string | null;
  captchaForm: boolean;
  sorryPage: boolean;
  trackCount: number;
  tracks: SubtitleTrack[];
}

/**
 * Downloads a transcript by driving the persistent-profile browser.
 * Throws AppError on bot walls / session loss (YOUTUBE_BOT_DETECTED) so the
 * caller can trigger an interactive cookie refresh and retry.
 */
export async function downloadTranscriptViaBrowser(
  options: BrowserTranscriptOptions,
): Promise<Transcript> {
  const {
    videoId,
    preferredLanguages = ['en', 'en-US', 'en-GB', 'en.*'],
    profileDir,
    headless = false,
    closeBrowser = false,
    timeoutMs = 60_000,
  } = options;

  const validId = extractVideoId(videoId);
  if (!validId) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: `Invalid video ID: "${videoId}"`,
      stage: 'research',
      task: 'transcript',
      retryable: false,
    });
  }

  let browser: Browser | null = null;
  let watchPage: Page | null = null;

  try {
    const launched = await launchBrowser({
      headless,
      ...(profileDir ? { profileDir } : {}),
    });
    browser = launched.browser;

    // Open a dedicated page so we never disturb existing tabs (e.g. Flow SSO).
    const ctx = browser.contexts()[0];
    if (!ctx) {
      throw new AppError({
        code: ErrorCodes.UNEXPECTED_ERROR,
        message: 'Browser launched without any browser context',
        stage: 'research',
        task: 'transcript',
        retryable: true,
      });
    }
    watchPage = await ctx.newPage();

    let captchaInfo = '';
    try {
      const navResp = await watchPage.goto(toWatchUrl(validId), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Fast-fail on egress IP rate limiting: Google answers flagged-IP watch
      // requests with 302 → google.com/sorry (HTTP 429). No player response
      // will ever appear, so polling would only waste the full timeout.
      if (
        watchPage.url().includes('google.com/sorry') ||
        navResp?.status() === 429
      ) {
        throw new AppError({
          code: ErrorCodes.YOUTUBE_RATE_LIMITED,
          message:
            `Google egress rate limit for ${validId}: watch page answered ` +
            `HTTP ${navResp?.status() ?? 'n/a'} via ${watchPage.url()} ` +
            '(proxy exit IP flagged; switch proxy node or retry after backoff)',
          stage: 'research',
          task: 'transcript',
          retryable: true,
        });
      }

      // Poll until the player response (or an interstitial wall) appears.
      const deadline = Date.now() + timeoutMs;
      let captured: PagePlayerCaptions | null = null;
      while (Date.now() < deadline) {
        captured = await watchPage.evaluate(() => {
          const w = window as any;
          const playerResponse: any =
            w.ytInitialPlayerResponse || w.ytplayer?.bootstrapPlayerResponse || null;
          const playability = playerResponse?.playabilityStatus;
          const trackList: any[] =
            playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
          const captchaForm = document.querySelector('form[action*="captcha"]') !== null;
          const bodyText = document.body?.innerText || '';
          return {
            loggedIn: w.ytcfg?.data_?.LOGGED_IN ?? null,
            status: playability?.status ?? null,
            reason: playability?.reason ?? null,
            captchaForm,
            sorryPage: bodyText.includes('unusual traffic') || /google\.com\/sorry/.test(location.href),
            trackCount: trackList.length,
            tracks: trackList.map((t: any) => ({
              language: t.languageCode || 'und',
              ext: 'vtt',
              kind: t.kind === 'asr' ? ('auto' as const) : ('manual' as const),
              url: t.baseUrl || '',
              name: t.name?.simpleText || t.name?.runs?.map((r: any) => r.text).join(''),
            })),
          };
        });

        if (captured?.sorryPage) {
          throw new AppError({
            code: ErrorCodes.YOUTUBE_RATE_LIMITED,
            message:
              `Google egress rate limit for ${validId}: ` +
              'watch page served the "unusual traffic" interstitial ' +
              '(proxy exit IP flagged; switch proxy node or retry after backoff)',
            stage: 'research',
            task: 'transcript',
            retryable: true,
          });
        }

        const botWalled =
          captured?.status === 'LOGIN_REQUIRED' ||
          captured?.status === 'CHECK_REQUIRED' ||
          captured?.captchaForm === true;
        if (botWalled) {
          captchaInfo = captured?.reason || 'bot wall';
          // LOGIN_REQUIRED can be session-level (refreshable cookies) or a
          // disguised egress rate limit. Probe anonymously to discriminate:
          // if the anonymous request is blocked too, no cookie refresh will help.
          if (captured?.status === 'LOGIN_REQUIRED') {
            const egressBlocked = await probeEgressRateLimited(validId);
            if (egressBlocked === true) {
              throw new AppError({
                code: ErrorCodes.YOUTUBE_RATE_LIMITED,
                message:
                  `Google egress rate limit for ${validId}: logged-in watch page shows ` +
                  `LOGIN_REQUIRED (${captchaInfo}) and an anonymous probe through the ` +
                  'same egress is also blocked — IP-level flag, cookie refresh cannot help; ' +
                  'switch proxy node or retry after backoff',
                stage: 'research',
                task: 'transcript',
                retryable: true,
              });
            }
          }
          throw new AppError({
            code: ErrorCodes.YOUTUBE_BOT_DETECTED,
            message: `YouTube bot wall on watch page for ${validId}: ${captchaInfo}`,
            stage: 'research',
            task: 'transcript',
            retryable: false,
          });
        }

        if (captured && captured.trackCount > 0) {
          break;
        }

        // Once any playability status is present the player response is final —
        // a video that loads without captions will never grow caption tracks.
        if (captured?.status) {
          break;
        }

        // Player response may still be bootstrapping; wait and retry.
        await watchPage.waitForTimeout(1_500);
      }

      if (!captured || captured.trackCount === 0) {
        throw new AppError({
          code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
          message: `Video ${validId} exposes no caption tracks (player status: ${
            captured?.status ?? 'unknown'
          }${captured?.reason ? ` — ${captured.reason}` : ''})`,
          stage: 'research',
          task: 'transcript',
          retryable: false,
        });
      }

      const selected = selectBestSubtitleTrack(captured.tracks, preferredLanguages);
      if (!selected || !selected.url) {
        throw new AppError({
          code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
          message: `No usable caption track for ${validId} among ${captured.tracks.length} track(s)`,
          stage: 'research',
          task: 'transcript',
          retryable: false,
        });
      }

      // YouTube gates timedtext behind PO tokens for videos in the exp=xpe
      // experiment: plain baseUrl fetches return HTTP 200 with an empty body.
      // Fast-path the plain fetch for ungated tracks; on empty/gated tracks,
      // let the real player fetch captions and replay its pot-bearing request.
      const isPotGated = selected.url.includes('exp=xpe');
      let vttBody: string | null = null;
      if (!isPotGated) {
        try {
          vttBody = await fetchSubtitleInPage(watchPage, selected.url, timeoutMs);
        } catch {
          vttBody = null; // fall through to PO-token capture below
        }
      }
      if (vttBody === null) {
        vttBody = await fetchSubtitleWithPlayerPot(watchPage, validId, selected, timeoutMs);
      }

      const transcript = parseVtt(vttBody, {
        videoId: validId,
        language: selected.language,
        source: selected.kind,
      });

      if (transcript.cues.length === 0) {
        throw new AppError({
          code: ErrorCodes.SUBTITLE_PARSE_FAILED,
          message: `Caption track "${selected.language}" for ${validId} parsed to 0 cues`,
          stage: 'research',
          task: 'transcript',
          retryable: true,
        });
      }

      return transcript;
    } finally {
      if (watchPage) {
        await watchPage.close().catch(() => {});
      }
    }
  } catch (error: any) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError({
      code: ErrorCodes.UNEXPECTED_ERROR,
      message: `Browser transcript retrieval failed for ${validId}: ${error?.message || error}`,
      stage: 'research',
      task: 'transcript',
      retryable: true,
      cause: error,
    });
  } finally {
    if (browser) {
      await releaseBrowser(browser, { keepAlive: !closeBrowser });
    }
  }
}

/**
 * Fetches a caption track (WebVTT) via the page's real video player.
 *
 * Why: YouTube's PO-token experiment (exp=xpe in the track baseUrl) makes
 * anonymous timedtext fetches return empty 200s. The player itself obtains
 * stream authorization, so we let it prepare playback, enable captions on
 * it, capture the timedtext requests it issues, and replay them with
 * fmt=vtt until one returns real cues.
 *
 * Capture notes (verified against the live player, Oct 2026):
 * - The player issues BOTH `signature`-only requests (empty 200 — gated)
 *   and `pot=`-bearing requests (real content), varying per page load.
 *   Filtering on `pot=` alone therefore deadlocks; every request for the
 *   target video must be collected and replayed until one yields cues.
 * - The ambient feed player fires timedtext requests for OTHER videos, so
 *   the filter must pin the target video id.
 * - Pot attachment appears tied to the player having prepared its stream;
 *   triggers therefore escalate: wait for player ready → muted playback →
 *   enable captions (setOption + CC button). If the whole window only
 *   produces gated variants, the page is reloaded once (fresh experiment
 *   bucket) and the sequence repeats.
 */
async function fetchSubtitleWithPlayerPot(
  page: Page,
  videoId: string,
  track: SubtitleTrack,
  timeoutMs: number,
): Promise<string> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const outerDeadline = Date.now() + timeoutMs;
  let removeListener: () => void = () => {};
  let settled = false;

  // Collect EVERY timedtext request for this video; the consumer replays
  // them one by one (signature-only variants reply empty and are skipped).
  const pendingUrls: string[] = [];
  let urlWaiter: ((url: string) => void) | null = null;
  const handler = (req: { url: () => string }) => {
    const url = req.url();
    if (!url.includes('timedtext') || !url.includes(`v=${videoId}`)) return;
    if (urlWaiter) {
      const w = urlWaiter;
      urlWaiter = null;
      w(url);
    } else {
      pendingUrls.push(url);
    }
  };
  page.on('request', handler);
  removeListener = () => {
    page.off('request', handler);
  };

  const nextCapturedUrl = (msLeft: number): Promise<string | null> => {
    if (pendingUrls.length > 0) return Promise.resolve(pendingUrls.shift()!);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        urlWaiter = null;
        resolve(null);
      }, Math.max(msLeft, 0));
      urlWaiter = (url) => {
        clearTimeout(t);
        resolve(url);
      };
    });
  };

  const replayAsVtt = async (capturedUrl: string): Promise<string | null> => {
    const vttUrl = /([?&])fmt=[^&]+/.test(capturedUrl)
      ? capturedUrl.replace(/([?&])fmt=[^&]+/, '$1fmt=vtt')
      : `${capturedUrl}${capturedUrl.includes('?') ? '&' : '?'}fmt=vtt`;
    const result = await page.evaluate(
      async ({ fetchUrl, timeout }) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await fetch(fetchUrl, { signal: controller.signal });
          const text = await resp.text();
          return { status: resp.status, len: text.length, body: text };
        } finally {
          clearTimeout(t);
        }
      },
      { fetchUrl: vttUrl, timeout: Math.min(20_000, Math.max(outerDeadline - Date.now(), 1000)) },
    );
    if (result.status === 200 && result.len > 0 && result.body.includes('-->')) {
      return result.body;
    }
    return null;
  };

  /** Escalating trigger sequence; sets stream up before enabling captions. */
  const fireTriggers = async (): Promise<void> => {
    // 1. Wait for the player API to be ready (setOption no-ops before that).
    for (let i = 0; i < 16 && !settled; i += 1) {
      const ready = await page
        .evaluate(() => {
          const player: any = document.querySelector('#movie_player');
          return !!player && (typeof player.isReady !== 'function' || player.isReady());
        })
        .catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    if (settled) return;

    // 2. Muted playback — prepares the stream; pot is attached to caption
    //    fetches once the player holds stream authorization.
    await page
      .evaluate(() => {
        const player: any = document.querySelector('#movie_player');
        player?.mute?.();
        player?.playVideo?.();
      })
      .catch(() => {});
    await sleep(4000);
    if (settled) return;

    // 3. Enable the caption track (kind matters for ASR).
    await page
      .evaluate(
        ({ languageCode, isAuto }) => {
          const player: any = document.querySelector('#movie_player');
          if (!player) return;
          if (typeof player.loadModule === 'function') {
            player.loadModule('captions');
          }
          player.setOption(
            'captions',
            'track',
            isAuto ? { languageCode, kind: 'asr' } : { languageCode }
          );
        },
        { languageCode: track.language, isAuto: track.kind === 'auto' }
      )
      .catch(() => {});

    // 4. Click the real CC button as well when captions are still off.
    await sleep(1500);
    if (settled) return;
    await page
      .evaluate(() => {
        const btn: any = document.querySelector('.ytp-subtitles-button');
        if (btn && btn.getAttribute('aria-pressed') === 'false') {
          btn.click();
        }
      })
      .catch(() => {});
  };

  try {
    const maxAttempts = 2; // second attempt = fresh page load (new player bucket)
    let lastProbe = 'no timedtext request captured';
    let emptyReplays = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptDeadline = Math.min(
        Date.now() + (attempt === 1 ? Math.min(Math.max(timeoutMs / 2, 15_000), 30_000) : 20_000),
        outerDeadline
      );
      if (attemptDeadline - Date.now() < 5000) break;

      if (attempt > 1) {
        // Fresh page load: pot attachment is bucketed per load, so a reload
        // re-rolls the dice when the first load only produced gated variants.
        pendingUrls.length = 0;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        // Wait for caption tracks to reappear in the fresh player response.
        for (let i = 0; i < 20; i += 1) {
          const trackCount = await page
            .evaluate(() => {
              const w = window as any;
              const pr = w.ytInitialPlayerResponse || w.ytplayer?.bootstrapPlayerResponse;
              return pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ?? 0;
            })
            .catch(() => 0);
          if (trackCount > 0) break;
          await sleep(1000);
        }
      }

      void fireTriggers();

      while (Date.now() < attemptDeadline) {
        const url = await nextCapturedUrl(attemptDeadline - Date.now());
        if (!url) break;
        const flags = `pot=${url.includes('pot=')},signature=${url.includes('signature=')}`;
        const body = await replayAsVtt(url);
        if (body) {
          settled = true;
          console.log(
            `[transcript] ${videoId}: replay OK (${flags}, ${body.length} bytes, attempt ${attempt})`
          );
          return body;
        }
        emptyReplays += 1;
        lastProbe = `${flags} -> HTTP 200 empty body (PO-gated variant)`;
        if (emptyReplays <= 3 || emptyReplays % 10 === 0) {
          console.log(`[transcript] ${videoId}: replay empty (${flags}), waiting for next request...`);
        }
      }

      await page
        .evaluate(() => {
          const player: any = document.querySelector('#movie_player');
          player?.pauseVideo?.();
        })
        .catch(() => {});
      if (settled) break;
    }

    throw new AppError({
      code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
      message:
        `No usable player timedtext request for ${videoId} ` +
        `(track: ${track.language}/${track.kind}; ${emptyReplays} gated replays; last: ${lastProbe})`,
      stage: 'research',
      task: 'transcript',
      retryable: true,
    });
  } catch (error: any) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError({
      code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
      message: `PO-token caption capture failed: ${error?.message || error}`,
      stage: 'research',
      task: 'transcript',
      retryable: true,
      cause: error,
    });
  } finally {
    settled = true;
    removeListener();
  }
}

/**
 * Fetches a caption track (WebVTT) from within the page context.
 * Retries once without fmt=vtt when the timedtext endpoint ignores it.
 */
async function fetchSubtitleInPage(page: Page, baseUrl: string, timeoutMs: number): Promise<string> {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const candidates = [`${baseUrl}${sep}fmt=vtt`, baseUrl];

  let lastProbe: { status: number; len: number; head: string } | null = null;
  for (const url of candidates) {
    const result = await page.evaluate(
      async ({ fetchUrl, timeout }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await fetch(fetchUrl, { signal: controller.signal });
          const text = await resp.text();
          return { status: resp.status, len: text.length, head: text.slice(0, 200), body: text };
        } finally {
          clearTimeout(timer);
        }
      },
      { fetchUrl: url, timeout: Math.min(timeoutMs, 60_000) }
    );

    lastProbe = { status: result.status, len: result.len, head: result.head };
    if (result.status === 200 && result.len > 0 && result.body.includes('-->')) {
      return result.body;
    }
  }

  throw new AppError({
    code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
    message: `Caption track download failed (last attempt: HTTP ${lastProbe?.status}, ${lastProbe?.len} bytes)`,
    stage: 'research',
    task: 'transcript',
    retryable: true,
  });
}
