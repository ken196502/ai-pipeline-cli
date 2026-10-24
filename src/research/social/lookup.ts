/**
 * Channel spotlight lookup (频道查证): takes a VL-recognized channel identity
 * and uses yt-dlp to find it on YouTube and TikTok, collecting follower counts
 * and avatar images as opening material (开篇素材) for the tutorial video.
 *
 * Everything is best-effort but never fabricates: when a platform lookup fails
 * the result simply carries found=false and the storyboard LLM is told to use
 * generalized claims instead of specific numbers.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureStandardBinaryPaths } from '../../utils/ytdlp.js';
import type { ChannelRef } from '../contracts.js';

const execFileAsync = promisify(execFile);

export interface ChannelPlatformSpotlight {
  platform: 'youtube' | 'tiktok';
  handle: string;
  url: string;
  followerCount?: number;
  avatarUrl?: string;
  /** Local path of the downloaded avatar image (开篇素材). */
  avatarPath?: string;
}

export interface ChannelSpotlightResult {
  /** True when at least one platform resolved with a follower count or avatar. */
  found: boolean;
  /** Display name (from the VL recognition or the resolved platform). */
  displayName: string;
  channels: ChannelPlatformSpotlight[];
  /** Highest known follower count across platforms (for the opening card). */
  followerCount?: number;
  /** Set when nothing could be verified — the LLM must avoid specific numbers. */
  missingNumbers: boolean;
}

export interface LookupChannelSpotlightParams {
  channel?: ChannelRef;
  /** Directory where the avatar (开篇素材) is saved. */
  outDir: string;
  cookiePath?: string | null;
  proxyUrl?: string | null;
  timeoutMs?: number;
}

/** Normalizes a channel name into a candidate social handle (kebab-stripped). */
export function normalizeChannelHandle(name: string, handle?: string): string {
  const explicit = (handle || '').trim().replace(/^@/, '');
  if (explicit && /^[\w.\-]{2,60}$/.test(explicit)) return explicit;
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return slug.slice(0, 40);
}

interface YtFlatEntry {
  channel?: string;
  uploader?: string;
  channel_url?: string;
  uploader_url?: string;
  channel_id?: string;
}

/**
 * Picks the YouTube channel candidate whose channel/uploader name best matches
 * the VL-recognized name (pure function, unit-tested).
 */
export function pickYouTubeChannelCandidate(
  entries: readonly YtFlatEntry[],
  name: string
): YtFlatEntry | null {
  const needle = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const tokens = needle.split(' ').filter((t) => t.length >= 2);
  let best: { entry: YtFlatEntry; score: number } | null = null;
  for (const entry of entries) {
    const candidate = `${entry.channel || ''} ${entry.uploader || ''}`.trim().toLowerCase();
    if (!candidate) continue;
    let score = 0;
    if (candidate.includes(needle)) score += 3;
    for (const token of tokens) {
      if (candidate.includes(token)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best ? best.entry : null;
}

export function ytdlpBaseArgs(cookiePath?: string | null, proxyUrl?: string | null): string[] {
  const args = ['--no-warnings', '--no-check-certificates'];
  const cookies = cookiePath ?? process.env.COOKIE_PATH ?? process.env.COOKIES_TXT_PATH ?? null;
  if (cookies && fsSync.existsSync(cookies)) args.push('--cookies', cookies);
  const noProxyRequested =
    proxyUrl === 'none' ||
    proxyUrl === 'direct' ||
    proxyUrl === '' ||
    process.env.YTDLP_NO_PROXY === '1' ||
    process.env.YTDLP_NO_PROXY === 'true';

  let proxy: string | null = null;
  if (!noProxyRequested) {
    proxy = proxyUrl ?? process.env.PROXY_URL ?? null;
    if (proxy === 'none' || proxy === 'direct' || proxy === '') proxy = null;
  }
  if (proxy) {
    args.push('--proxy', proxy);
  } else if (noProxyRequested) {
    args.push('--proxy', '');
  }
  return args;
}

async function runYtDlpJson(
  target: string,
  params: LookupChannelSpotlightParams,
  extraArgs: string[] = []
): Promise<any | null> {
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--dump-json', '--skip-download', '--playlist-items', '1:1', ...ytdlpBaseArgs(params.cookiePath, params.proxyUrl), ...extraArgs, target],
      { timeout: params.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 }
    );
    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

async function runYtDlpSearch(
  query: string,
  params: LookupChannelSpotlightParams
): Promise<YtFlatEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--flat-playlist', '--dump-json', '--playlist-items', '1:6', ...ytdlpBaseArgs(params.cookiePath, params.proxyUrl), `ytsearch6:${query}`],
      { timeout: params.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 }
    );
    return stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => {
        try {
          return JSON.parse(l) as YtFlatEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is YtFlatEntry => e !== null);
  } catch {
    return [];
  }
}

/** Fetches a page as text via curl (honors the proxy environment). */
async function fetchPageText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sL', '--max-time', String(Math.max(5, Math.ceil(timeoutMs / 1000))), url],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    return stdout || null;
  } catch {
    return null;
  }
}

function firstMatch(text: string, re: RegExp): string | null {
  const match = re.exec(text);
  return match ? match[1] : null;
}

/** Parses approximate counts like "142M subscribers", "1,234", "6.5万". */
export function parseApproxCount(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  const match = /(\d+(?:\.\d+)?)\s*([KMB万亿])?/i.exec(cleaned);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = (match[2] || '').toUpperCase();
  const factor =
    suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : suffix === '万' ? 1e4 : suffix === '亿' ? 1e8 : 1;
  return Math.round(value * factor);
}

/** Downloads the avatar image (开篇素材) into outDir via curl. */
async function downloadAvatar(
  avatarUrl: string,
  outDir: string,
  platform: string
): Promise<string | undefined> {
  try {
    await fs.mkdir(outDir, { recursive: true });
    const probePath = path.join(outDir, `channel-avatar-${platform}.bin`);
    const { stdout } = await execFileAsync(
      'curl',
      ['-sL', '--max-time', '30', '-o', probePath, '-w', '%{content_type}', avatarUrl],
      { maxBuffer: 1024 }
    );
    const stat = await fs.stat(probePath).catch(() => null);
    if (!stat || stat.size < 500) {
      await fs.rm(probePath, { force: true });
      return undefined;
    }
    const ext = stdout.includes('png') ? '.png' : stdout.includes('webp') ? '.webp' : '.jpg';
    const filePath = path.join(outDir, `channel-avatar-${platform}${ext}`);
    await fs.rename(probePath, filePath);
    return filePath;
  } catch {
    return undefined;
  }
}

async function lookupYouTube(
  ref: ChannelRef,
  params: LookupChannelSpotlightParams
): Promise<ChannelPlatformSpotlight | null> {
  const handle = normalizeChannelHandle(ref.name, ref.handle);
  if (!handle && !ref.name.trim()) return null;

  // 1) Discover the channel home via yt-dlp search, matching the VL name.
  let channelUrl = '';
  let resolvedHandle = handle;
  const entries = await runYtDlpSearch(`${ref.name} ${ref.platform === 'youtube' ? '' : 'official'}`.trim(), params);
  const picked = pickYouTubeChannelCandidate(entries, ref.name);
  const pickedUrl = picked?.channel_url || picked?.uploader_url || '';
  const pickedVideoUrl = (picked as any)?.url
    ? String((picked as any).url).startsWith('http')
      ? String((picked as any).url)
      : `https://www.youtube.com/watch?v=${(picked as any).url}`
    : '';
  if (pickedUrl.includes('/channel/') || pickedUrl.includes('/@') || pickedUrl.includes('/c/') || pickedUrl.includes('/user/')) {
    channelUrl = pickedUrl;
    const at = /\/(@[\w.\-]+)/.exec(channelUrl);
    if (at) resolvedHandle = at[1];
  }
  if (!channelUrl && handle) {
    channelUrl = `https://www.youtube.com/@${handle}`;
    resolvedHandle = `@${handle}`;
  }
  if (!channelUrl) return null;

  // 2) Follower count via yt-dlp (exact channel_follower_count from one video
  //    of this channel), falling back to the channel header's subscriber text.
  let followerCount: number | undefined;
  if (pickedVideoUrl) {
    const meta = await runYtDlpJson(pickedVideoUrl, params);
    const rawCount = meta?.channel_follower_count ?? meta?.uploader_follower_count;
    if (typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0) {
      followerCount = rawCount;
    }
  }

  // 3) Avatar + subscriber count via the channel page metadata (best-effort scrape).
  let avatarUrl: string | undefined;
  const html = await fetchPageText(`${channelUrl}?hl=en`, params.timeoutMs ?? 30_000);
  if (html) {
    if (followerCount == null) {
      // Only the channel HEADER count is trusted (first subscriberCountText in
      // the page can belong to a sidebar channel) — otherwise leave it unknown.
      const countText =
        firstMatch(html, /"c4TabbedHeaderRenderer"[\s\S]{0,3000}?"subscriberCountText":\{"simpleText":"([^"]+)"/) ||
        firstMatch(html, /"pageHeaderViewModel"[\s\S]{0,9000}?(\d[\d.,]*[KMB]?\s+subscribers)/) ||
        '';
      const parsed = parseApproxCount(countText);
      if (parsed != null && parsed > 0) followerCount = parsed;
    }
    avatarUrl =
      firstMatch(html, /"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/) ||
      firstMatch(html, /(https:\/\/yt3\.googleusercontent\.com\/[^"\\s]+)/) ||
      firstMatch(html, /<meta property="og:image" content="([^"]+)"/) ||
      undefined;
  }

  const avatarPath = avatarUrl ? await downloadAvatar(avatarUrl, params.outDir, 'youtube') : undefined;
  return {
    platform: 'youtube',
    handle: resolvedHandle,
    url: channelUrl,
    followerCount,
    avatarUrl,
    avatarPath,
  };
}

async function lookupTikTok(
  ref: ChannelRef,
  params: LookupChannelSpotlightParams
): Promise<ChannelPlatformSpotlight | null> {
  const handle = normalizeChannelHandle(ref.name, ref.handle);
  if (!handle) return null;
  const url = `https://www.tiktok.com/@${handle}`;

  let followerCount: number | undefined;
  let avatarUrl: string | undefined;

  // 1) yt-dlp first (follower count from user feed metadata).
  const meta = await runYtDlpJson(url, params);
  const rawCount = meta?.channel_follower_count ?? meta?.uploader_follower_count;
  if (typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0) {
    followerCount = rawCount;
  }

  // 2) Page metadata for follower count and avatar (best-effort scrape).
  const html = await fetchPageText(url, params.timeoutMs ?? 30_000);
  if (html) {
    if (followerCount == null) {
      const countText = firstMatch(html, /"followerCount":"?(\d+)/) || firstMatch(html, /"follower_count":(\d+)/);
      if (countText) {
        const parsed = Number(countText);
        if (Number.isFinite(parsed)) followerCount = parsed;
      }
    }
    avatarUrl =
      firstMatch(html, /"avatarLarger":"([^"]+)"/) ||
      firstMatch(html, /"avatarMedium":"([^"]+)"/) ||
      firstMatch(html, /"avatar":"([^"]+)"/) ||
      undefined;
    if (avatarUrl) avatarUrl = avatarUrl.replace(/\\u002F/g, '/');
    const exists = followerCount != null || avatarUrl != null;
    if (!exists) return null;
  } else if (followerCount == null) {
    return null;
  }

  const avatarPath = avatarUrl ? await downloadAvatar(avatarUrl, params.outDir, 'tiktok') : undefined;
  return {
    platform: 'tiktok',
    handle: `@${handle}`,
    url,
    followerCount,
    avatarUrl,
    avatarPath,
  };
}

/**
 * Resolves a VL-recognized channel on YouTube and TikTok (followers + avatar).
 * Returns found=false when nothing verifiable is found — callers must then
 * keep specific numbers out of the generated video.
 */
export async function lookupChannelSpotlight(
  params: LookupChannelSpotlightParams
): Promise<ChannelSpotlightResult> {
  ensureStandardBinaryPaths();
  const ref = params.channel;
  const displayName = ref?.name?.trim() || ref?.handle?.trim() || '';
  const empty: ChannelSpotlightResult = {
    found: false,
    displayName,
    channels: [],
    missingNumbers: true,
  };
  if (!ref || (!ref.name.trim() && !ref.handle.trim())) return empty;

  const channels: ChannelPlatformSpotlight[] = [];
  const [youtube, tiktok] = await Promise.all([
    lookupYouTube(ref, params).catch(() => null),
    lookupTikTok(ref, params).catch(() => null),
  ]);
  if (youtube) channels.push(youtube);
  if (tiktok) channels.push(tiktok);

  const counts = channels.map((c) => c.followerCount).filter((c): c is number => typeof c === 'number');
  const followerCount = counts.length > 0 ? Math.max(...counts) : undefined;
  const hasAvatar = channels.some((c) => Boolean(c.avatarPath));

  return {
    found: channels.length > 0 && (followerCount != null || hasAvatar),
    displayName,
    channels,
    followerCount,
    missingNumbers: followerCount == null,
  };
}
