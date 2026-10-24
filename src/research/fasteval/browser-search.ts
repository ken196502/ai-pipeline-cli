import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { toVisionPng } from '../media/frames.js';
import { launchBrowser } from '../../browser/launcher.js';
import { listBrowserPages } from '../../browser/cdp.js';
import { releaseBrowser } from '../../browser/session.js';
import { AppError, ErrorCodes } from '../errors.js';
import type { FastEvalCandidate } from './types.js';
import {
  parseViewCount,
  parsePublishedDaysAgo,
  parseFlexibleDurationSeconds,
  parseYouTubeAriaLabel,
} from '../youtube/view-count.js';

export interface SearchCandidatesOptions {
  query: string;
  candidateCount?: number;
  profileDir?: string;
  browserPath?: string;
  viewport?: { width: number; height: number } | null;
  /** When set, failure diagnostics (screenshot + HTML + page state) are written here. */
  debugDir?: string;
  /** Whether to run browser in headless mode (default: true). */
  headless?: boolean | 'shell';
  /** Total search attempts (reload + backoff between attempts). Default 3. */
  maxAttempts?: number;
  /** Minimum video duration in seconds (default 300 = 5 minutes). */
  minDurationSec?: number;
  /** Maximum published age in days (default 183 ≈ half a year). */
  maxAgeDays?: number;
  onProgress?: (stage: string, detail?: string) => void;
}

/** A search result extracted from either the DOM or the `ytInitialData` JSON. */
export interface RawSearchVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  url: string;
  durationText?: string;
  durationSec?: number;
  viewCountText?: string;
  viewCount?: number;
  publishedTimeText?: string;
  publishedDaysAgo?: number;
  thumbnailUrl?: string;
}

/** Minimum bar a result must clear before its cover is captured. */
export interface MinimumBar {
  minDurationSec: number;
  maxAgeDays: number;
}

export const DEFAULT_MIN_DURATION_SEC = 300; // 5 minutes
export const DEFAULT_MAX_AGE_DAYS = 183; // ~ half a year

/** Parses "10:54" / "1:02:33" into total seconds (null when not a clock value). */
export function parseDurationSeconds(durationText?: string): number | null {
  if (!durationText) return null;
  const m = durationText.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  return hours * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, second: 1, seconds: 1,
  m: 60, min: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
  mo: 2629800, month: 2629800, months: 2629800,
  y: 31557600, year: 31557600, years: 31557600,
};

/** Parses "19h ago" / "2 weeks ago" / "Streamed 4 months ago" into age seconds. */
export function parseRelativeAgeSeconds(text?: string): number | null {
  if (!text) return null;
  const m = text
    .toLowerCase()
    .match(/(\d+)\s*(sec|second|seconds|min|minute|minutes|hr|hour|hours|day|days|week|weeks|month|months|year|years|mo|y|w|d|h|m|s)\s*ago/);
  if (!m) return null;
  const unit = UNIT_SECONDS[m[2]];
  return unit === undefined ? null : parseInt(m[1], 10) * unit;
}

export type MinimumBarVerdict =
  | { pass: true }
  | { pass: false; category: 'too-short' | 'too-old' | 'unknown-duration' | 'unknown-age'; reason: string };

/** Applies the minimum bar (duration ≥ min, published within maxAge) to a result. */
export function meetsMinimumBar(
  video: { durationText?: string; publishedText?: string },
  bar: Partial<MinimumBar> = {},
): MinimumBarVerdict {
  const minDurationSec = bar.minDurationSec ?? DEFAULT_MIN_DURATION_SEC;
  const maxAgeDays = bar.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;

  const durationSec = parseDurationSeconds(video.durationText);
  if (durationSec === null) {
    return { pass: false, category: 'unknown-duration', reason: 'duration unknown' };
  }
  if (durationSec < minDurationSec) {
    return { pass: false, category: 'too-short', reason: `too short (${video.durationText})` };
  }
  const ageSec = parseRelativeAgeSeconds(video.publishedText);
  if (ageSec === null) {
    return { pass: false, category: 'unknown-age', reason: 'publish date unknown' };
  }
  if (ageSec > maxAgeDays * 86_400) {
    return { pass: false, category: 'too-old', reason: `too old (${video.publishedText})` };
  }
  return { pass: true };
}

export function describeMinimumBar(bar: Partial<MinimumBar> = {}): string {
  const minDurationSec = bar.minDurationSec ?? DEFAULT_MIN_DURATION_SEC;
  const maxAgeDays = bar.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  return `minimum bar: duration ≥ ${Math.round(minDurationSec / 60)}min, published ≤ ${maxAgeDays}d ago`;
}

const WATCH_HREF_RE = /[?&]v=([A-Za-z0-9_-]{6,})/;

/**
 * Builds a YouTube search URL. `videosOnly` adds YouTube's protobuf "type: video"
 * filter (`sp=EgIQAQ==`) — the same thing the "Videos" chip on the results page does.
 */
export function buildYouTubeSearchUrl(query: string, videosOnly = false): string {
  const base = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  return videosOnly ? `${base}&sp=${encodeURIComponent('EgIQAQ==')}` : base;
}

/** Extracts the YouTube videoId from a `/watch?v=...` href (null for shorts/other links). */
export function extractVideoIdFromWatchHref(href: string | null | undefined): string | null {
  if (!href) return null;
  if (href.includes('/shorts/') || href.includes('/live/')) return null;
  const match = href.match(WATCH_HREF_RE);
  return match ? match[1] : null;
}

/** Renders a `simpleText` / `runs[]` text object (YouTube's two text shapes) to a plain string. */
function textOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as { simpleText?: string; runs?: Array<{ text?: string }>; content?: string };
  if (typeof v.content === 'string') return v.content.trim();
  if (typeof v.simpleText === 'string') return v.simpleText.trim();
  if (Array.isArray(v.runs)) return v.runs.map((r) => r?.text ?? '').join('').trim();
  return '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textOf(value);
    if (text) return text;
  }
  return '';
}

/** Best-effort recursive search for the first value under `key` anywhere in the subtree. */
function findValueByKey(node: unknown, key: string, depth = 0): unknown {
  if (!node || typeof node !== 'object' || depth > 12) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findValueByKey(item, key, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (key in record) return record[key];
  for (const child of Object.values(record)) {
    const hit = findValueByKey(child, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function thumbnailUrlOf(thumbnails: unknown): string | undefined {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return undefined;
  const last = thumbnails[thumbnails.length - 1] as { url?: string };
  return typeof last?.url === 'string' && last.url ? last.url : undefined;
}

function rawFromVideoRenderer(node: Record<string, unknown>): RawSearchVideo | null {
  const videoId = typeof node.videoId === 'string' ? node.videoId : '';
  const title = firstText(node.title);
  if (!videoId || !title) return null;
  const durationText = firstText(node.lengthText) || undefined;
  const durationSec = durationText ? (parseDurationSeconds(durationText) ?? parseFlexibleDurationSeconds(durationText) ?? undefined) : undefined;
  const viewCountText = firstText(node.viewCountText, node.shortViewCountText) || undefined;
  const viewCount = viewCountText ? (parseViewCount(viewCountText) ?? undefined) : undefined;
  const publishedTimeText = firstText(node.publishedTimeText) || undefined;
  const publishedDaysAgo = publishedTimeText ? (parsePublishedDaysAgo(publishedTimeText) ?? undefined) : undefined;

  return {
    videoId,
    title,
    channelTitle: firstText(node.longBylineText, node.ownerText, node.shortBylineText),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    durationText,
    durationSec,
    viewCountText,
    viewCount,
    publishedTimeText,
    publishedDaysAgo,
    thumbnailUrl: thumbnailUrlOf((node.thumbnail as { thumbnails?: unknown } | undefined)?.thumbnails),
  };
}

function rawFromLockupViewModel(node: Record<string, unknown>): RawSearchVideo | null {
  // Shorts lockups (e.g. LOCKUP_CONTENT_TYPE_VIDEO_SHORTS) are not usable candidates.
  if (typeof node.contentType === 'string' && /SHORT/i.test(node.contentType)) return null;
  const videoId = typeof node.contentId === 'string' ? node.contentId : '';
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const lockupMeta = metadata?.lockupMetadataViewModel as Record<string, unknown> | undefined;
  const title = firstText(lockupMeta?.title);
  if (!videoId || !title) return null;

  const durationOverlay = findValueByKey(node.thumbnail, 'thumbnailOverlayTimeStatusViewModel');
  const durationText = firstText((durationOverlay as Record<string, unknown> | undefined)?.text);
  const durationSec = durationText ? (parseDurationSeconds(durationText) ?? parseFlexibleDurationSeconds(durationText) ?? undefined) : undefined;

  const metadataRows = findValueByKey(lockupMeta?.metadata, 'metadataContentMetadataViewModel');
  const parts = (metadataRows as { metadataRows?: unknown } | undefined)?.metadataRows;
  const rowTexts: string[] = [];
  if (Array.isArray(parts)) {
    for (const row of parts) {
      const nestedParts = (row as { metadataParts?: unknown }).metadataParts;
      if (!Array.isArray(nestedParts)) continue;
      for (const part of nestedParts) {
        const t = textOf((part as { text?: unknown }).text);
        if (t) rowTexts.push(t);
      }
    }
  }

  const viewCountPart = rowTexts.find((t) => parseViewCount(t) !== null && !/(?:ago|前)/i.test(t));
  const publishedPart = rowTexts.find((t) => /(?:ago|前)/i.test(t) || parsePublishedDaysAgo(t) !== null);
  const viewCountText = viewCountPart || (rowTexts.length > 2 ? rowTexts[1] : undefined);
  const viewCount = viewCountText ? (parseViewCount(viewCountText) ?? undefined) : undefined;
  const publishedTimeText = publishedPart || (rowTexts.length > 1 ? rowTexts[rowTexts.length - 1] : undefined);
  const publishedDaysAgo = publishedTimeText ? (parsePublishedDaysAgo(publishedTimeText) ?? undefined) : undefined;
  const channelTitle = rowTexts.find((t) => t !== durationText && t !== viewCountText && t !== publishedTimeText) ?? '';

  const imageSources = findValueByKey(node.contentImage, 'sources');
  const thumbnailUrl = thumbnailUrlOf(imageSources);

  return {
    videoId,
    title,
    channelTitle,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    durationText: durationText || undefined,
    durationSec,
    viewCountText,
    viewCount,
    publishedTimeText,
    publishedDaysAgo,
    thumbnailUrl,
  };
}

/**
 * Pure extractor: walks the `ytInitialData` tree and collects search-result videos
 * from every renderer shape YouTube currently uses
 * (`videoRenderer`, `compactVideoRenderer`, `videoWithContextRenderer`, `lockupViewModel`).
 */
export function collectVideosFromYtInitialData(data: unknown, limit = 50): RawSearchVideo[] {
  const videos: RawSearchVideo[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number): void => {
    if (videos.length >= limit || !node || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    let raw: RawSearchVideo | null = null;
    for (const key of ['videoRenderer', 'compactVideoRenderer', 'videoWithContextRenderer']) {
      if (record[key] && typeof record[key] === 'object') {
        raw = rawFromVideoRenderer(record[key] as Record<string, unknown>);
        break;
      }
    }
    if (!raw && record.lockupViewModel && typeof record.lockupViewModel === 'object') {
      raw = rawFromLockupViewModel(record.lockupViewModel as Record<string, unknown>);
    }
    if (raw && !seen.has(raw.videoId)) {
      seen.add(raw.videoId);
      videos.push(raw);
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };

  visit(data, 0);
  return videos;
}

/**
 * Vision-ready thumbnail bytes: PNG → sharpen → 256-colour palette. Also normalises
 * any input codec (i.ytimg.com serves AVIF/WebP/JPEG depending on Accept).
 */
async function normalizeToVisionPng(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await toVisionPng(buffer);
  } catch {
    return null;
  }
}

/** Fetches thumbnail bytes through the browser page (Node-side fetch has no egress here). */
async function fetchThumbnailInPage(page: Page, urls: string[]): Promise<Buffer | null> {
  for (const url of urls) {
    if (!url) continue;
    const base64 = await page
      .evaluate(async (u: string) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(u, {
            credentials: 'omit',
            headers: { accept: 'image/jpeg,image/*' },
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length === 0) return null;
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          return btoa(binary);
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }, url)
      .catch(() => null);
    if (!base64) continue;
    const normalized = await normalizeToVisionPng(Buffer.from(base64, 'base64'));
    if (normalized) return normalized;
  }
  return null;
}

function thumbnailUrlFallbacks(videoId: string, preferred?: string): string[] {
  return [
    preferred || '',
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ].filter(Boolean);
}

interface PageProbe {
  url: string;
  bodyText: string;
  domResultCount: number;
  hasYtInitialData: boolean;
  jsonResultCount: number;
}

/** Detects consent / bot-check interstitials. Returns 'ok' | 'consent' | 'bot'. */
export function classifyPageState(probe: Pick<PageProbe, 'url' | 'bodyText'>): 'ok' | 'consent' | 'bot' {
  const url = probe.url.toLowerCase();
  const text = probe.bodyText.toLowerCase();
  if (
    url.includes('consent.youtube.com') ||
    url.includes('consent.google.com') ||
    text.includes('before you continue to youtube') ||
    text.includes('before you continue to google')
  ) {
    return 'consent';
  }
  if (
    text.includes('sign in to confirm you') ||
    text.includes('sign in to confirm that you') ||
    text.includes('unusual traffic') ||
    text.includes('are not a bot')
  ) {
    return 'bot';
  }
  return 'ok';
}

async function probePage(page: Page): Promise<PageProbe> {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').slice(0, 3000);
    const domResultCount =
      document.querySelectorAll('ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model, yt-video-lockup-view-model').length;
    const initialData = (window as unknown as { ytInitialData?: unknown }).ytInitialData;
    let jsonResultCount = 0;
    const count = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object' || depth > 25 || jsonResultCount > 200) return;
      if (Array.isArray(node)) {
        for (const item of node) count(item, depth + 1);
        return;
      }
      const record = node as Record<string, unknown>;
      for (const key of ['videoRenderer', 'compactVideoRenderer', 'videoWithContextRenderer', 'lockupViewModel']) {
        if (record[key]) jsonResultCount++;
      }
      for (const child of Object.values(record)) {
        if (child && typeof child === 'object') count(child, depth + 1);
      }
    };
    count(initialData, 0);
    return {
      url: location.href,
      bodyText,
      domResultCount,
      hasYtInitialData: typeof initialData === 'object' && initialData !== null,
      jsonResultCount,
    };
  });
}

const DOM_RESULT_SELECTOR =
  'ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model, yt-video-lockup-view-model';

async function autoScrollResults(page: Page, targetCount: number): Promise<number> {
  const desired = Math.max(24, targetCount);
  let previousCount = -1;
  let stagnantSteps = 0;
  let loaded = 0;
  for (let step = 0; step < 12; step++) {
    loaded = await page
      .evaluate((sel: string) => document.querySelectorAll(sel).length, DOM_RESULT_SELECTOR)
      .catch(() => 0);
    if (loaded >= desired) break;
    if (loaded === previousCount) {
      stagnantSteps++;
      if (stagnantSteps >= 2) break;
    } else {
      stagnantSteps = 0;
    }
    previousCount = loaded;
    await page.evaluate(() => window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'instant' }));
    await new Promise((r) => setTimeout(r, 700));
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  return loaded;
}

async function extractCandidatesFromDom(
  page: Page,
  targetCount: number,
  bar: MinimumBar,
  onProgress?: (stage: string, detail?: string) => void
): Promise<FastEvalCandidate[]> {
  const containers = await page.$$(DOM_RESULT_SELECTOR);
  const candidates: FastEvalCandidate[] = [];
  const skipped: Partial<Record<'too-short' | 'too-old' | 'unknown-duration' | 'unknown-age', number>> = {};

  for (const el of containers) {
    if (candidates.length >= targetCount) break;

    try {
    const meta = await el.evaluate((node) => {
      const titleAnchor =
        (node.querySelector('a#video-title') as HTMLAnchorElement | null) ||
        (node.querySelector('a[href*="/watch?v="]') as HTMLAnchorElement | null);
      const href = titleAnchor?.getAttribute('href') || '';
      const directTitle =
        node.querySelector('a#video-title')?.getAttribute('title')?.trim() ||
        node.querySelector('a#video-title')?.textContent?.trim() ||
        node.querySelector('h3')?.textContent?.trim() ||
        titleAnchor?.textContent?.trim() ||
        '';
      const ariaLabel =
        titleAnchor?.getAttribute('aria-label') ||
        node.querySelector('a#video-title')?.getAttribute('aria-label') ||
        '';
      const channelEl =
        node.querySelector('ytd-channel-name') ||
        node.querySelector('yt-content-metadata-view-model');
      const durationEl = node.querySelector(
        'ytd-thumbnail-overlay-time-status-renderer, .yt-thumbnail-overlay-time-status-view-model, badge-shape--thumbnail-overlay, .badge-shape--thumbnail-overlay'
      );
      const metaLine = node.querySelector('#metadata-line') || node.querySelector('yt-content-metadata-view-model');
      const rawDuration = durationEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const durationText = rawDuration.match(/\d{1,3}:\d{2}(?::\d{2})?/)?.[0];
      const rawMeta = metaLine?.textContent?.replace(/\s+/g, ' ').trim() || '';

      return {
        href,
        directTitle,
        ariaLabel,
        channelTitle: channelEl?.textContent?.replace(/\s+/g, ' ').trim() || '',
        durationText,
        rawMeta,
      };
    });

    const videoId = extractVideoIdFromWatchHref(meta.href);
    if (!videoId) continue;

    // Parse rich YouTube aria-label if present
    const parsedAria = parseYouTubeAriaLabel(meta.ariaLabel);
    const cleanTitle =
      (meta.directTitle && !GENERIC_TITLES.has(meta.directTitle.toLowerCase()))
        ? meta.directTitle
        : parsedAria.cleanTitle || meta.directTitle || '';
    if (!cleanTitle) continue;

    const durationText = meta.durationText || parsedAria.durationText;
    const durationSec = durationText
      ? (parseDurationSeconds(durationText) ?? parseFlexibleDurationSeconds(durationText) ?? parsedAria.durationSec)
      : parsedAria.durationSec;

    // View count resolution
    const viewCountFromMeta = parseViewCount(meta.rawMeta);
    const viewCount = viewCountFromMeta ?? parsedAria.viewCount;
    const viewCountText = viewCountFromMeta
      ? `${viewCountFromMeta.toLocaleString()} views`
      : (parsedAria.viewCountText || (meta.rawMeta ? meta.rawMeta : undefined));

    // Published age resolution
    const publishedTimeText = parsedAria.publishedTimeText || (/(?:ago|前)/i.test(meta.rawMeta) ? meta.rawMeta : undefined);
    const publishedDaysAgo = publishedTimeText ? parsePublishedDaysAgo(publishedTimeText) ?? undefined : undefined;
    const viewsPerDay = viewCount && publishedDaysAgo ? Math.round(viewCount / publishedDaysAgo) : undefined;

    // Minimum bar first — never spend screenshot time on results that cannot qualify.
    const verdict = meetsMinimumBar(
      { durationText, publishedText: publishedTimeText || meta.rawMeta },
      bar
    );
    if (!verdict.pass) {
      skipped[verdict.category] = (skipped[verdict.category] ?? 0) + 1;
      continue;
    }

    // Scroll into view so the thumbnail is lazy-loaded before capture.
    await el.evaluate((node) => {
      node.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await new Promise((r) => setTimeout(r, 250));

    let buffer: Buffer | null = null;
    let thumbEl =
      (await el.$('ytd-thumbnail')) ||
      (await el.$('yt-thumbnail-view-model')) ||
      (await el.$('.yt-thumbnail-view-model')) ||
      null;
    if (!thumbEl) {
      // Generic img fallback: pick a real thumbnail-sized image, never a channel avatar.
      for (const img of await el.$$('img')) {
        const dims = await img
          .evaluate((n) => ({
            w: (n as HTMLImageElement).naturalWidth,
            h: (n as HTMLImageElement).naturalHeight,
          }))
          .catch(() => ({ w: 0, h: 0 }));
        if (dims.w >= 160 && dims.h >= 90) {
          thumbEl = img;
          break;
        }
      }
    }
    if (thumbEl) {
      // Skip hidden/zero-size (skeleton) tiles and never let a screenshot hang the stage.
      const box = await thumbEl.boundingBox().catch(() => null);
      if (box && box.width >= 4 && box.height >= 4) {
        const rawScreenshot = await Promise.race([
          thumbEl.screenshot({ type: 'png' }).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
        ]);
        if (rawScreenshot) {
          buffer = await normalizeToVisionPng(
            Buffer.isBuffer(rawScreenshot) ? rawScreenshot : Buffer.from(rawScreenshot),
          );
        }
      }
    }
    if (!buffer) continue;

    candidates.push({
      index: candidates.length + 1,
      videoId,
      title: cleanTitle,
      channelTitle: meta.channelTitle || parsedAria.channelTitle || 'Unknown Channel',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      durationText,
      durationSec,
      viewCountText,
      viewCount,
      publishedTimeText,
      publishedDaysAgo,
      viewsPerDay,
      thumbnailBuffer: buffer,
    });
    } catch {
      // Lazy re-renders can detach an element handle mid-loop — skip it, keep going.
      continue;
    }
  }

  const skippedTotal = Object.values(skipped).reduce((a, b) => a + (b ?? 0), 0);
  if (skippedTotal > 0) {
    onProgress?.(
      'browser-search',
      `DOM extraction skipped ${skippedTotal} result(s) below ${describeMinimumBar(bar)}: ${JSON.stringify(skipped)}`
    );
  }

  return candidates;
}

/** Titles that indicate the DOM extraction picked up a UI label instead of the real title. */
const GENERIC_TITLES = new Set(['watch', 'shorts', 'live', 'play', 'video']);

async function fetchJsonVideos(page: Page, limit: number): Promise<RawSearchVideo[]> {
  const initialData = await Promise.race([
    page.evaluate(() => {
      const data = (window as unknown as { ytInitialData?: unknown }).ytInitialData;
      return data ?? null;
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000)),
  ]);
  if (!initialData) return [];
  return collectVideosFromYtInitialData(initialData, limit);
}

/**
 * Tops up candidates from `ytInitialData` (covering un-rendered skeleton pages) and
 * repairs DOM-extracted metadata that came out empty or as UI labels.
 */
async function topUpCandidatesFromJson(
  page: Page,
  candidates: FastEvalCandidate[],
  targetCount: number,
  bar: MinimumBar,
  onProgress?: (stage: string, detail?: string) => void
): Promise<void> {
  const jsonVideos = await fetchJsonVideos(page, Math.max(50, targetCount * 8));
  if (jsonVideos.length === 0) return;

  const skipped: Partial<Record<'too-short' | 'too-old' | 'unknown-duration' | 'unknown-age', number>> = {};
  const qualifying = jsonVideos.filter((raw) => {
    const verdict = meetsMinimumBar(
      { durationText: raw.durationText, publishedText: raw.publishedTimeText },
      bar
    );
    if (!verdict.pass) {
      skipped[verdict.category] = (skipped[verdict.category] ?? 0) + 1;
      return false;
    }
    return true;
  });
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + (b ?? 0), 0);
  if (skippedTotal > 0) {
    onProgress?.(
      'browser-search',
      `JSON results skipped ${skippedTotal} below ${describeMinimumBar(bar)}: ${JSON.stringify(skipped)}`
    );
  }
  if (qualifying.length === 0) return;

  const byId = new Map(qualifying.map((v) => [v.videoId, v]));
  for (const candidate of candidates) {
    const raw = byId.get(candidate.videoId);
    if (!raw) continue;
    if (!candidate.title || GENERIC_TITLES.has(candidate.title.toLowerCase())) candidate.title = raw.title;
    if (!candidate.channelTitle) candidate.channelTitle = raw.channelTitle;
    if (!candidate.durationText && raw.durationText) candidate.durationText = raw.durationText;
    if (!candidate.durationSec && raw.durationSec) candidate.durationSec = raw.durationSec;
    if (!candidate.viewCountText && raw.viewCountText) candidate.viewCountText = raw.viewCountText;
    if (candidate.viewCount == null && raw.viewCount != null) candidate.viewCount = raw.viewCount;
    if (!candidate.publishedTimeText && raw.publishedTimeText) candidate.publishedTimeText = raw.publishedTimeText;
    if (candidate.publishedDaysAgo == null && raw.publishedDaysAgo != null) candidate.publishedDaysAgo = raw.publishedDaysAgo;
    if (candidate.viewsPerDay == null) {
      const v = candidate.viewCount ?? raw.viewCount;
      const d = candidate.publishedDaysAgo ?? raw.publishedDaysAgo;
      if (v != null && d != null && d > 0) candidate.viewsPerDay = Math.round(v / d);
    }
  }

  // Drop DOM candidates whose title still is a UI label (e.g. "Watch") — they are
  // usually non-video tiles; the top-up below replaces them with real results.
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!candidates[i].title || GENERIC_TITLES.has(candidates[i].title.toLowerCase())) {
      const dropped = candidates[i];
      candidates.splice(i, 1);
      onProgress?.(
        'browser-search',
        `Dropped non-video tile: [${dropped.videoId}] title="${dropped.title}"`
      );
    }
  }

  const seen = new Set(candidates.map((c) => c.videoId));
  for (const raw of qualifying) {
    if (candidates.length >= targetCount) break;
    if (seen.has(raw.videoId)) continue;
    seen.add(raw.videoId);
    const buffer = await fetchThumbnailInPage(page, thumbnailUrlFallbacks(raw.videoId, raw.thumbnailUrl));
    if (!buffer) continue;
    const views = raw.viewCount ?? (raw.viewCountText ? parseViewCount(raw.viewCountText) ?? undefined : undefined);
    const daysAgo = raw.publishedDaysAgo ?? (raw.publishedTimeText ? parsePublishedDaysAgo(raw.publishedTimeText) ?? undefined : undefined);
    const viewsPerDay = views && daysAgo ? Math.round(views / daysAgo) : undefined;
    candidates.push({
      index: candidates.length + 1,
      videoId: raw.videoId,
      title: raw.title,
      channelTitle: raw.channelTitle,
      url: raw.url,
      durationText: raw.durationText,
      durationSec: raw.durationSec,
      viewCountText: raw.viewCountText,
      viewCount: views,
      publishedTimeText: raw.publishedTimeText,
      publishedDaysAgo: daysAgo,
      viewsPerDay,
      thumbnailBuffer: buffer,
    });
    onProgress?.(
      'browser-search',
      `Captured candidate #${candidates.length} via ytInitialData: [${raw.videoId}] ${raw.title.slice(0, 45)}...`
    );
  }
}

async function saveDiagnostics(
  page: Page,
  debugDir: string,
  probe: PageProbe | null,
  reason: string
): Promise<void> {
  try {
    await fs.mkdir(debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(debugDir, `browser-search-debug-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) await fs.writeFile(`${base}.html`, html);
    await fs.writeFile(
      `${base}.state.json`,
      JSON.stringify({ reason, probe, savedAt: new Date().toISOString() }, null, 2)
    );
    console.log(`[browser-search] Diagnostics saved: ${base}.{png,html,state.json}`);
  } catch {
    // Diagnostics must never mask the original failure.
  }
}

/** Page-side predicate: is the "Videos" filter active (URL param or chip selected)? */
const VIDEOS_FILTER_ACTIVE_FN = () => {
  if (location.href.includes('sp=')) return true;
  const labels = ['videos', '视频', '影片'];
  const chips = Array.from(
    document.querySelectorAll('yt-chip-cloud-chip-renderer, yt-chip-cloud-chip-view-model')
  );
  return chips.some((chip) => {
    const label = (chip.textContent || '').trim().toLowerCase();
    if (!labels.includes(label)) return false;
    return (
      chip.getAttribute('aria-selected') === 'true' ||
      !!chip.querySelector('[aria-selected="true"]')
    );
  });
};

/**
 * Clicks the "Videos" filter chip on the search results page so the capture pool is
 * real videos instead of Shorts shelves. The chip re-filters in place (this UI does
 * not rewrite the URL), so success is "URL has sp= OR the chip is selected"; the
 * filtered URL navigation is the deterministic completion when neither lands.
 */
async function applyVideosFilter(
  page: Page,
  query: string,
  onProgress?: (stage: string, detail?: string) => void
): Promise<void> {
  if (await page.evaluate(VIDEOS_FILTER_ACTIVE_FN).catch(() => false)) return;

  // The chip cloud renders with the results — wait for it before hunting the chip.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll(
          'yt-chip-cloud-chip-renderer, yt-chip-cloud-chip-view-model, ytSearchFilterChipCloudView button'
        ).length > 0,
      undefined,
      { timeout: 8000 }
    )
    .catch(() => null);
  // Chips are custom elements — give YouTube a beat to hydrate their handlers.
  await new Promise((r) => setTimeout(r, 2000));

  const chipHandle = await page
    .evaluateHandle(() => {
      // Only the chip cloud row — hidden "Filters" menu items also match loose labels.
      const chips = Array.from(
        document.querySelectorAll(
          'yt-chip-cloud-chip-renderer, yt-chip-cloud-chip-view-model, ytSearchFilterChipCloudView button'
        )
      );
      const labelOf = (el: Element) => (el.textContent || '').trim().toLowerCase();
      for (const label of ['videos', '视频', '影片', 'video']) {
        const hit = chips.find((c) => labelOf(c) === label);
        if (hit) return hit;
      }
      return chips.find((c) => labelOf(c).startsWith('video')) || null;
    })
    .catch(() => null);
  const chipEl = chipHandle?.asElement() ?? null;

  const dispatchChipClick = async (): Promise<void> => {
    if (!chipEl) return;
    // A plain mouse click is ignored by YouTube's chip handlers here; a full
    // pointer/mouse event sequence does activate the filter (verified live).
    await chipEl
      .evaluate((n) => {
        const el = n as HTMLElement;
        el.scrollIntoView({ block: 'center' });
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      })
      .catch(() => {});
  };

  if (chipEl) {
    onProgress?.('browser-search', 'Clicking "Videos" filter tab — waiting for filtered results');
    await dispatchChipClick();
    await page.waitForFunction(VIDEOS_FILTER_ACTIVE_FN, undefined, { timeout: 10_000 }).catch(() => null);
    if (!(await page.evaluate(VIDEOS_FILTER_ACTIVE_FN).catch(() => false))) {
      // Retry once — the first click can land before the handler is hydrated.
      await new Promise((r) => setTimeout(r, 2000));
      await dispatchChipClick();
      await page.waitForFunction(VIDEOS_FILTER_ACTIVE_FN, undefined, { timeout: 8_000 }).catch(() => null);
    }
  }
  await chipHandle?.dispose?.().catch(() => {});

  if (!(await page.evaluate(VIDEOS_FILTER_ACTIVE_FN).catch(() => false))) {
    onProgress?.(
      'browser-search',
      '"Videos" filter chip did not apply — navigating to the Videos-filtered search URL directly'
    );
    try {
      await page.goto(buildYouTubeSearchUrl(query, true), {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
    } catch (err) {
      const isFiltered = await page.evaluate(VIDEOS_FILTER_ACTIVE_FN).catch(() => false);
      if (!isFiltered) {
        throw err;
      }
      onProgress?.(
        'browser-search',
        'Navigation domcontentloaded timed out, but filtered page state is active — proceeding'
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
    return;
  }

  // Soft navigation swaps the result list in place — give it a moment to re-render.
  await new Promise((r) => setTimeout(r, 2000));
  await page
    .waitForFunction(
      (sel: string) => document.querySelectorAll(sel).length > 0,
      DOM_RESULT_SELECTOR,
      { timeout: 8000 }
    )
    .catch(() => null);
  onProgress?.('browser-search', 'Videos filter active — capturing from the Videos tab only');
}

async function attemptAcceptConsent(page: Page, onProgress?: (stage: string, detail?: string) => void): Promise<void> {
  onProgress?.('browser-search', 'Cookie consent interstitial detected — attempting to accept');
  const clicked = await page
    .evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const patterns = [/^accept all$/i, /^i agree$/i, /^agree to all$/i, /^accept all cookies$/i, /^reject all$/i];
      for (const pattern of patterns) {
        const match = buttons.find((b) => pattern.test(((b as HTMLElement).innerText || (b as HTMLInputElement).value || '').trim()));
        if (match) {
          (match as HTMLElement).click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);

  if (!clicked) {
    // Deterministic fallback: set the consent cookies and reload.
    const cookieBase = { domain: '.youtube.com', path: '/' };
    await page.context().addCookies([
      { ...cookieBase, name: 'SOCS', value: 'CAI' },
      { ...cookieBase, name: 'CONSENT', value: 'YES+' },
    ]);
  }
  await new Promise((r) => setTimeout(r, 2500));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
}

/**
 * Searches YouTube in the browser and captures candidate cover thumbnails.
 *
 * Resilience notes (see plan-fix-browser-search.md):
 * - YouTube intermittently serves the results page as an un-rendered skeleton where
 *   `ytd-video-renderer` never appears (reused persistent sessions). In that case the
 *   results are still present in the `ytInitialData` JSON, which is used as fallback.
 * - Multiple DOM layouts are supported (legacy `ytd-video-renderer`, new lockup view
 *   models, rich item renderers).
 * - Consent / bot-check interstitials are detected and reported precisely (or accepted).
 * - The search is retried with reload + backoff; on final failure diagnostics are saved.
 */
export async function searchYouTubeInBrowser(
  options: SearchCandidatesOptions
): Promise<FastEvalCandidate[]> {
  const {
    query,
    candidateCount = 25,
    profileDir = './.chromium-profile',
    browserPath,
    viewport,
    debugDir,
    maxAttempts = 3,
    minDurationSec = DEFAULT_MIN_DURATION_SEC,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    onProgress,
  } = options;

  const isHeadless = options.headless !== false;
  // If a persistent profileDir is provided (e.g. ./.chromium-profile), preserve it!
  // Throwaway profiles must ONLY be used when no profileDir is specified.
  // Using throwaway profiles on headless runs previously wiped the user's logged-in session.
  const effectiveProfileDir = profileDir ? path.resolve(profileDir) : await fs.mkdtemp(path.join(os.tmpdir(), 'fasteval-search-'));
  const isTemporaryProfile = !profileDir;

  const bar: MinimumBar = { minDurationSec, maxAgeDays };
  onProgress?.(
    'browser-search',
    `Opening YouTube search in ${isHeadless ? 'headless' : 'headed'} browser for "${query}" (${describeMinimumBar(bar)})`
  );

  let browser: import('playwright-core').Browser;
  try {
    browser = (
      await launchBrowser({
        profileDir: effectiveProfileDir,
        executablePath: browserPath,
        reuseSession: true,
        keepAlive: true,
        headless: isHeadless ? (options.headless ?? true) : false,
        viewport,
      })
    ).browser;
  } catch (err) {
    // launch failed: drop the throwaway profile so it does not accumulate in tmp
    if (isTemporaryProfile) await fs.rm(effectiveProfileDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // Reuse default browser context when available to preserve logged-in YouTube / Google auth state,
  // falling back to a new context only if none exist.
  const defaultContext = browser.contexts()[0];
  const searchContext = defaultContext || (await browser.newContext());
  const page = await searchContext.newPage();
  try {
    // Sweep leftover YouTube search tabs from previous (possibly crashed) runs — the
    // search tab is closed right after capture and never needs to survive the stage.
    const staleTabs = listBrowserPages(browser).filter((p) =>
      p.url().includes('youtube.com/results?search_query=')
    );
    for (const stale of staleTabs) {
      await stale.close().catch(() => {});
    }
    if (staleTabs.length > 0) {
      onProgress?.('browser-search', `Closed ${staleTabs.length} leftover YouTube search tab(s) from previous runs`);
    }
    if (viewport && viewport.width && viewport.height) {
      await page.setViewportSize(viewport);
    } else {
      await page.setViewportSize({ width: 1600, height: 900 });
    }

    // Check if auth cookies already exist in this context before adding consent cookies,
    // so we never overwrite an active logged-in YouTube session with guest consent tokens.
    const existingCookies = await searchContext.cookies(['https://www.youtube.com']).catch(() => []);
    const hasAuthCookie = existingCookies.some((c) => /LOGIN_INFO|SAPISID|__Secure-3PAPISID/i.test(c.name));
    if (!hasAuthCookie) {
      // Suppress the consent interstitial up front for non-logged-in contexts.
      await page.context()
        .addCookies([
          { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' },
          { name: 'CONSENT', value: 'YES+', domain: '.youtube.com', path: '/' },
        ])
        .catch(() => {});
    }

    const searchUrl = buildYouTubeSearchUrl(query, true);
    const targetCount = Math.max(1, candidateCount);
    let lastProbe: PageProbe | null = null;
    let lastReason = 'unknown';

    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      try {
        if (attempt === 1) {
          onProgress?.('browser-search', `Navigating to ${searchUrl}`);
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(async (err) => {
            const hasData = await page
              .evaluate(() => typeof (window as any).ytInitialData === 'object' || location.href.includes('search_query='))
              .catch(() => false);
            if (!hasData) throw err;
            onProgress?.(
              'browser-search',
              'Initial navigation domcontentloaded timed out but search page content is present — proceeding'
            );
          });
        } else {
          onProgress?.('browser-search', `Retry ${attempt}/${maxAttempts}: reloading search results page`);
          await new Promise((r) => setTimeout(r, 1500 * (attempt - 1)));
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(async () => {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          });
        }

        let probe = await probePage(page);
        const state = classifyPageState(probe);

        if (state === 'bot') {
          throw new AppError({
            code: ErrorCodes.YOUTUBE_BOT_DETECTED,
            message: `YouTube bot-check interstitial while searching for "${query}" (cookies may need refresh)`,
            stage: 'fasteval',
            task: 'browser-search',
            retryable: true,
          });
        }
        if (state === 'consent') {
          await attemptAcceptConsent(page, onProgress);
          probe = await probePage(page);
        }
        lastProbe = probe;

        // Click the "Videos" filter tab before capturing — otherwise the results are
        // dominated by Shorts shelves and only a couple of real videos are capturable.
        await applyVideosFilter(page, query, onProgress);
        probe = await probePage(page);
        lastProbe = probe;

        // Give the DOM a short window to render results, then scroll through several
        // screens so YouTube lazy-renders more than the 2-3 tiles on the first screen.
        await page
          .waitForFunction(
            (sel: string) => document.querySelectorAll(sel).length > 0,
            DOM_RESULT_SELECTOR,
            { timeout: 8000 }
          )
          .catch(() => null);
        const loadedElements = await autoScrollResults(page, targetCount);
        onProgress?.(
          'browser-search',
          `Scrolled search results: ${loadedElements} video element(s) loaded across screens`
        );
        probe = await probePage(page);
        lastProbe = probe;

        // 1) DOM path (thumbnails captured exactly as rendered).
        const domCandidates = await extractCandidatesFromDom(page, targetCount, bar, onProgress);
        onProgress?.(
          'browser-search',
          `DOM extraction: ${domCandidates.length} candidate(s) from ${probe.domResultCount} rendered element(s)`
        );

        // 2) ytInitialData JSON path — repairs DOM metadata and covers un-rendered
        //    skeleton pages / new layouts where no DOM results exist at all.
        const candidates = domCandidates;
        await topUpCandidatesFromJson(page, candidates, targetCount, bar, onProgress);
        onProgress?.('browser-search', `Candidate pool ready: ${candidates.length}/${targetCount} candidate(s)`);

        if (candidates.length > 0) {
          candidates.forEach((c, i) => {
            c.index = i + 1;
          });
          // Close the search tab immediately after capture — no reason to keep it around.
          await page.close().catch(() => {});
          if (searchContext !== defaultContext) {
            await searchContext.close().catch(() => {});
          }
          onProgress?.(
            'browser-search',
            `Captured ${candidates.length} candidate cover(s) — closed YouTube search tab. Handing off to VL evaluation.`
          );
          return candidates;
        }

        lastReason =
          probe.hasYtInitialData && probe.jsonResultCount === 0
            ? 'search page loaded but ytInitialData contains 0 video results (unexpected/empty result set)'
            : probe.hasYtInitialData
              ? 'ytInitialData has results but candidate extraction/thumbnail capture failed'
              : 'search page never produced ytInitialData or rendered results';
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCodes.YOUTUBE_BOT_DETECTED) {
          throw err;
        }
        const errMessage = err instanceof Error ? err.message : String(err);
        lastReason = `Attempt ${attempt}/${maxAttempts} failed: ${errMessage}`;
        onProgress?.(
          'browser-search',
          `Search attempt ${attempt}/${maxAttempts} encountered error: ${errMessage}`
        );
        if (attempt >= maxAttempts) {
          break;
        }
      }
    }

    if (debugDir) {
      await saveDiagnostics(page, debugDir, lastProbe, lastReason);
    }

    throw new AppError({
      code: ErrorCodes.NO_CANDIDATES,
      message:
        `YouTube search returned 0 usable candidates for query: "${query}" after ${Math.max(1, maxAttempts)} attempt(s) ` +
        `(${describeMinimumBar(bar)}). ` +
        `Reason: ${lastReason}` +
        (lastProbe
          ? ` | page: ${lastProbe.url} | domResults=${lastProbe.domResultCount} jsonResults=${lastProbe.jsonResultCount} ytInitialData=${lastProbe.hasYtInitialData}`
          : ''),
      stage: 'fasteval',
      task: 'browser-search',
      retryable: false,
    });
  } finally {
    await page.close().catch(() => {});
    if (searchContext !== defaultContext) {
      await searchContext.close().catch(() => {});
    }
    // ALWAYS release the CDP connection: keep the persistent browser session alive.
    await releaseBrowser(browser, { keepAlive: true, profileDir: effectiveProfileDir }).catch(() => {});
    // remove the throwaway headless profile if it was temporary
    if (isTemporaryProfile) await fs.rm(effectiveProfileDir, { recursive: true, force: true }).catch(() => {});
  }
}
