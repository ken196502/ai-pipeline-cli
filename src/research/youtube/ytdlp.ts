/**
 * yt-dlp execution wrapper for YouTube video discovery, metadata extraction,
 * subtitle retrieval, and media downloading.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REFERENCE-VIDEO DOWNLOAD POLICY: yt-dlp is the ONLY supported transport.
 *
 * Every browser / "player capture" download attempt was removed on purpose.
 * They all fail or poison the pipeline, for the following verified reasons:
 *
 *   1. Progressive `streamingData.formats` URLs exposed on the watch page are
 *      bound to the proxy exit IP that YouTube saw when minting them. With a
 *      rotating/multi-exit airport proxy the media `fetch()` leaves from a
 *      different exit IP and googlevideo answers HTTP 403 (SABR/IP-binding).
 *   2. Modern YouTube forces SABR/UMP streaming for web clients, so the plain
 *      progressive URL does not exist for most videos anyway.
 *   3. Capturing the MSE `SourceBuffer.appendBuffer` fragments while the player
 *      runs works in principle, but:
 *        - a mid-roll AD swaps the video element / MediaSource and interleaves
 *          ad fragments into the same per-mime track, corrupting the file;
 *        - YouTube autoplay switches to the next video at `ended`, further
 *          contaminating the capture and making the duration unbounded;
 *        - video and audio arrive as different containers (e.g. av01/MP4 +
 *          opus/WebM), requiring lossy remux/transcode;
 *        - capture is bandwidth-bound (~3x realtime at best even with a high
 *          playbackRate) and cannot guarantee a complete file within timeout;
 *        - a canvas/decoder stall silently produces frozen "dead frames" that
 *          pass naive size/bitrate checks and poison prompt detection.
 *   4. Synthesizing a "reference video" from canvas screenshots is strictly
 *      forbidden — it fabricates media and was the source of the dead-frame
 *      incident (see plan-fix-degenerate-video-and-prompt-fallback.md).
 *
 * yt-dlp, by contrast, performs the player-API request and the media download
 * inside one process on one egress, is not subject to the ad/autoplay problems,
 * and returns a real complete file. Requirements:
 *   - a PO token provider (bgutil server on 127.0.0.1:4416, see pot-provider.ts),
 *   - a JS challenge (EJS) solver so yt-dlp can solve YouTube's `n` challenge
 *     (pip package `yt-dlp-ejs`; `resolveJsRuntimesArg` passes `--js-runtimes`),
 *   - the `web` player client (`--extractor-args youtube:player_client=web`),
 *   - a valid cookies file (see buildBaseArgs).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SearchResult, Transcript, VideoCandidate } from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import { ensureStandardBinaryPaths } from '../../utils/ytdlp.js';
import { validateReferenceVideoQuality } from './reference-validation.js';
import { ensurePotProviderRunning } from './pot-provider.js';
import { toVideoCandidate, type RawYtDlpInfo } from './hydrate.js';
import { selectBestSubtitleTrack, type SubtitleTrack } from './subtitles.js';
import { extractVideoId, toWatchUrl } from './urls.js';
import { parseVtt } from './vtt.js';

const execFileAsync = promisify(execFile);

/**
 * Creates a clean environment for yt-dlp child processes, stripping proxy
 * variables so that buildBaseArgs() is the sole source of proxy configuration.
 */
function cleanYtDlpEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    delete env[key];
  }
  return env;
}

export interface YtDlpSearchOptions {
  query: string;
  maxCandidates?: number;
  cookiePath?: string | null;
  proxyUrl?: string | null;
  timeoutMs?: number;
  now?: () => Date;
}

export interface YtDlpTranscriptOptions {
  videoId: string;
  preferredLanguages?: readonly string[];
  cacheDir?: string;
  cookiePath?: string | null;
  proxyUrl?: string | null;
  timeoutMs?: number;
}

export interface YtDlpDownloadOptions {
  videoId: string;
  outputDir: string;
  format?: string;
  cookiePath?: string | null;
  proxyUrl?: string | null;
  timeoutMs?: number;
  /** Platform-reported duration used to reject truncated downloads (optional). */
  expectedDurationSec?: number;
}

/**
 * Resolves the path to the yt-dlp executable.
 */
export async function resolveYtDlpBinary(): Promise<string> {
  ensureStandardBinaryPaths();

  const envPath = process.env.YTDLP_PATH;
  if (envPath && fsSync.existsSync(envPath)) return envPath;

  const candidates = [
    process.env.YTDLP_PATH,
    path.join(process.env.HOME || '', '.pi/agent/bin/yt-dlp'),
    path.join(process.env.HOME || '', '.local/bin/yt-dlp'),
    path.join(process.env.HOME || '', '.cargo/bin/yt-dlp'),
    '/usr/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        return candidate;
      } catch {
        // Continue search
      }
    }
  }

  // Check if available in PATH via which
  try {
    const { stdout } = await execFileAsync('which', ['yt-dlp']);
    const resolved = stdout.trim();
    if (resolved && fsSync.existsSync(resolved)) return resolved;
  } catch {
    // Continue search
  }

  // Check if direct execution works
  try {
    await execFileAsync('yt-dlp', ['--version']);
    return 'yt-dlp';
  } catch {
    throw new AppError({
      code: ErrorCodes.YTDLP_EXEC_ERROR,
      message: 'yt-dlp executable could not be found in PATH or standard locations.',
      stage: 'research',
      task: 'find-ytdlp',
      retryable: false,
    });
  }
}

/**
 * Caches --js-runtimes support per resolved binary path. The option was
 * introduced in yt-dlp 2025.08.x; older binaries abort every invocation with
 * "no such option: --js-runtimes", which previously killed all research-stage
 * yt-dlp calls while the error was silently swallowed downstream.
 */
const jsRuntimesSupportCache = new Map<string, boolean>();

/**
 * Resolves the optional `--js-runtimes node:<path>` argument for a given
 * yt-dlp binary. Returns an empty array when the binary does not support the
 * option (or no JavaScript runtime is available).
 */
export async function resolveJsRuntimesArg(binary: string): Promise<string[]> {
  let supported = jsRuntimesSupportCache.get(binary);
  if (supported === undefined) {
    try {
      const { stdout } = await execFileAsync(binary, ['--help'], {
        timeout: 15_000,
        env: cleanYtDlpEnv(),
        maxBuffer: 10 * 1024 * 1024,
      });
      supported = stdout.includes('--js-runtimes');
    } catch {
      supported = false;
    }
    jsRuntimesSupportCache.set(binary, supported);
  }

  if (!supported) {
    return [];
  }

  const nodeCandidates = [
    process.env.NODE_BIN,
    process.execPath,
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ].filter(Boolean) as string[];

  for (const candidate of nodeCandidates) {
    if (fsSync.existsSync(candidate)) {
      return ['--js-runtimes', `node:${candidate}`];
    }
  }

  return ['--js-runtimes', 'node'];
}

/**
 * Builds base arguments for yt-dlp calls (cookies, proxy, headers).
 * Note: the `--js-runtimes` argument is NOT included here; callers must spread
 * the result of `resolveJsRuntimesArg(binary)` for their binary, since support
 * varies by yt-dlp version.
 */
export function buildBaseArgs(cookiePath?: string | null, proxyUrl?: string | null): string[] {
  const args: string[] = ['--no-warnings', '--no-check-certificates'];

  let resolvedCookies = cookiePath ?? process.env.COOKIE_PATH ?? (process.env.COOKIES_TXT_PATH || null);
  if (!resolvedCookies) {
    const cwdCookies = path.resolve(process.cwd(), 'cookies.txt');
    if (fsSync.existsSync(cwdCookies)) {
      resolvedCookies = cwdCookies;
    }
  }

  if (resolvedCookies) {
    args.push('--cookies', resolvedCookies);
  }

  const noProxyRequested =
    proxyUrl === 'none' ||
    proxyUrl === 'direct' ||
    proxyUrl === '' ||
    process.env.YTDLP_NO_PROXY === '1' ||
    process.env.YTDLP_NO_PROXY === 'true';

  let resolvedProxy: string | null = null;
  if (!noProxyRequested) {
    resolvedProxy =
      proxyUrl ??
      process.env.PROXY_URL ??
      process.env.ALL_PROXY ??
      process.env.all_proxy ??
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      null;

    if (resolvedProxy === 'none' || resolvedProxy === 'direct' || resolvedProxy === '') {
      resolvedProxy = null;
    }
  }

  if (resolvedProxy) {
    args.push('--proxy', resolvedProxy);
  }

  const ffmpegCandidates = [
    process.env.FFMPEG_BIN,
    path.join(process.env.HOME || '', '.pi/agent/bin/ffmpeg'),
    path.join(process.env.HOME || '', '.local/bin/ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean) as string[];

  for (const candidate of ffmpegCandidates) {
    if (fsSync.existsSync(candidate)) {
      args.push('--ffmpeg-location', path.dirname(candidate));
      break;
    }
  }

  return args;
}

/**
 * Searches YouTube for video candidates matching a query using yt-dlp.
 */
export async function searchVideos(
  options: YtDlpSearchOptions,
): Promise<SearchResult> {
  const {
    query,
    maxCandidates = 15,
    cookiePath,
    proxyUrl,
    timeoutMs = 180_000,
    now,
  } = options;

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Search query cannot be empty.',
      stage: 'research',
      task: 'search',
      retryable: false,
    });
  }

  const binary = await resolveYtDlpBinary();
  const count = Math.max(1, Math.min(50, Math.floor(maxCandidates)));

  // If query is directly a YouTube video ID or URL, search that directly
  const singleVideoId = extractVideoId(trimmedQuery);
  const target = singleVideoId ? toWatchUrl(singleVideoId) : `ytsearch${count}:${trimmedQuery}`;

  const args = [
    ...buildBaseArgs(cookiePath, proxyUrl),
    ...(await resolveJsRuntimesArg(binary)),
    '--ignore-no-formats-error',
    '--print',
    '%(.{id,title,description,uploader,uploader_id,channel,channel_id,duration,view_count,like_count,comment_count,upload_date,timestamp,release_timestamp,tags,thumbnail,thumbnails})j',
    '--default-search',
    'ytsearch',
    '--no-playlist',
    target,
  ];

  let stdout = '';
  try {
    const result = await execFileAsync(binary, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: timeoutMs,
      env: cleanYtDlpEnv(),
    });
    stdout = result.stdout;
  } catch (error: any) {
    const combined = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
    if (combined.includes('Sign in to confirm you are not a bot')) {
      throw new AppError({
        code: ErrorCodes.YOUTUBE_BOT_DETECTED,
        message: 'YouTube bot verification required when searching.',
        stage: 'research',
        task: 'search',
        retryable: false,
        cause: error,
      });
    }
    if (combined.includes('The provided YouTube account cookies are no longer valid')) {
      throw new AppError({
        code: ErrorCodes.COOKIE_INVALID,
        message: 'YouTube account cookies have expired or been revoked.',
        stage: 'research',
        task: 'search',
        retryable: false,
        cause: error,
      });
    }
    throw new AppError({
      code: ErrorCodes.YTDLP_EXEC_ERROR,
      message: error.killed
        ? `yt-dlp search timed out after ${Math.round(timeoutMs / 1000)}s. Try increasing timeout or reducing maxCandidates.`
        : `yt-dlp search failed: ${error.message}\nstderr: ${(error.stderr || '').toString().slice(0, 500)}`,
      stage: 'research',
      task: 'search',
      retryable: true,
      cause: error,
    });
  }

  // Parse JSON lines from stdout
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const candidates: VideoCandidate[] = [];

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as RawYtDlpInfo;
      const candidate = toVideoCandidate(raw, { now });
      if (candidate) {
        // Avoid duplicate videoIds in search results
        if (!candidates.some((c) => c.videoId === candidate.videoId)) {
          candidates.push(candidate);
        }
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  if (candidates.length === 0) {
    throw new AppError({
      code: ErrorCodes.NO_CANDIDATES,
      message: `No video candidates found for "${trimmedQuery}".`,
      stage: 'research',
      task: 'search',
      retryable: true,
      cause: { query: trimmedQuery, rawLines: lines.length },
    });
  }

  return {
    query: trimmedQuery,
    candidates,
    source: 'youtube',
    requestedAt: (now ? now() : new Date()).toISOString(),
  };
}

/**
 * Downloads and parses subtitle tracks for a YouTube video.
 */
export async function downloadTranscript(
  options: YtDlpTranscriptOptions,
): Promise<Transcript> {
  const {
    videoId,
    preferredLanguages = ['en', 'en-US', 'en-GB', 'en.*'],
    cacheDir,
    cookiePath,
    proxyUrl,
    timeoutMs = 90_000,
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

  const binary = await resolveYtDlpBinary();
  const tempDir = cacheDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), `ytdlp-sub-${validId}-`)));

  try {
    // 1. Fetch available subtitle metadata
    const metaArgs = [
      ...buildBaseArgs(cookiePath, proxyUrl),
      ...(await resolveJsRuntimesArg(binary)),
      '--ignore-no-formats-error',
      '--print',
      '%(.{subtitles,automatic_captions})j',
      '--skip-download',
      toWatchUrl(validId),
    ];

    const { stdout } = await execFileAsync(binary, metaArgs, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: timeoutMs,
      env: cleanYtDlpEnv(),
    });

    const jsonLine = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{') && l.endsWith('}'));
    const info = (jsonLine ? JSON.parse(jsonLine) : JSON.parse(stdout.trim())) as RawYtDlpInfo;
    const tracks: SubtitleTrack[] = [];

    // Parse manual subtitles
    if (info.subtitles && typeof info.subtitles === 'object') {
      for (const [lang, formats] of Object.entries(info.subtitles)) {
        if (Array.isArray(formats)) {
          for (const fmt of formats) {
            tracks.push({
              language: lang,
              ext: fmt.ext || 'vtt',
              kind: 'manual',
              url: fmt.url,
              name: fmt.name,
            });
          }
        }
      }
    }

    // Parse automatic captions
    if (info.automatic_captions && typeof info.automatic_captions === 'object') {
      for (const [lang, formats] of Object.entries(info.automatic_captions)) {
        if (Array.isArray(formats)) {
          for (const fmt of formats) {
            tracks.push({
              language: lang,
              ext: fmt.ext || 'vtt',
              kind: 'auto',
              url: fmt.url,
              name: fmt.name,
            });
          }
        }
      }
    }

    const selectedTrack = selectBestSubtitleTrack(tracks, preferredLanguages);
    if (!selectedTrack) {
      return {
        videoId: validId,
        language: 'en',
        source: 'manual',
        cues: [],
      };
    }

    // 2. Download the chosen subtitle track in vtt format
    const outputTemplate = path.join(tempDir, `${validId}.%(ext)s`);
    const subArgs = [
      ...buildBaseArgs(cookiePath, proxyUrl),
      ...(await resolveJsRuntimesArg(binary)),
      '--ignore-no-formats-error',
      '--skip-download',
      '--sub-format',
      'vtt',
      '--convert-subs',
      'vtt',
      selectedTrack.kind === 'manual' ? '--write-sub' : '--write-auto-sub',
      '--sub-lang',
      selectedTrack.language,
      '-o',
      outputTemplate,
      toWatchUrl(validId),
    ];

    await execFileAsync(binary, subArgs, {
      timeout: timeoutMs,
      env: cleanYtDlpEnv(),
    });

    // Locate generated .vtt file
    const files = await fs.readdir(tempDir);
    const vttFile = files.find((f) => f.endsWith('.vtt'));
    if (!vttFile) {
      throw new AppError({
        code: ErrorCodes.YTDLP_EXEC_ERROR,
        message: `yt-dlp reported subtitle track "${selectedTrack.language}" for ${validId} but no .vtt file was produced.`,
        stage: 'research',
        task: 'transcript',
        retryable: true,
      });
    }

    const vttContent = await fs.readFile(path.join(tempDir, vttFile), 'utf-8');
    return parseVtt(vttContent, {
      videoId: validId,
      language: selectedTrack.language,
      source: selectedTrack.kind,
    });
  } catch (error: any) {
    if (error instanceof AppError) {
      throw error;
    }
    const combined = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`;
    if (combined.includes('Sign in to confirm you’re not a bot') || /the page needs to be reloaded/i.test(combined)) {
      throw new AppError({
        code: ErrorCodes.YOUTUBE_BOT_DETECTED,
        message: 'YouTube bot verification required when downloading subtitles.',
        stage: 'research',
        task: 'transcript',
        retryable: false,
        cause: error,
      });
    }
    if (combined.includes('The provided YouTube account cookies are no longer valid')) {
      throw new AppError({
        code: ErrorCodes.COOKIE_INVALID,
        message: 'YouTube account cookies have expired or been revoked.',
        stage: 'research',
        task: 'transcript',
        retryable: false,
        cause: error,
      });
    }
    throw new AppError({
      code: ErrorCodes.YTDLP_EXEC_ERROR,
      message: error?.killed
        ? `yt-dlp subtitle download timed out after ${Math.round(timeoutMs / 1000)}s for ${validId}.`
        : `yt-dlp subtitle download failed for ${validId}: ${error?.message}\nstderr: ${(error?.stderr || '').toString().slice(0, 500)}`,
      stage: 'research',
      task: 'transcript',
      retryable: true,
      cause: error,
    });
  } finally {
    if (!cacheDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const DEFAULT_DOWNLOAD_FORMAT =
  'bestvideo[height<=720][vcodec^=avc1]+bestaudio[acodec^=mp4a]/' +
  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/' +
  'best[height<=720][ext=mp4]/' +
  'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/' +
  'bestvideo[height<=1080]+bestaudio/' +
  'best[height<=1080]/' +
  'best';

/**
 * Resolves ffmpeg executable path.
 */
export function resolveFfmpegBin(): string {
  if (process.env.FFMPEG_BIN && fsSync.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const candidates = [
    path.join(process.env.HOME || '', '.pi/agent/bin/ffmpeg'),
    path.join(process.env.HOME || '', '.local/bin/ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

/**
 * Resolves ffprobe executable path.
 */
export function resolveFfprobeBin(): string {
  if (process.env.FFPROBE_BIN && fsSync.existsSync(process.env.FFPROBE_BIN)) return process.env.FFPROBE_BIN;
  const candidates = [
    path.join(process.env.HOME || '', '.pi/agent/bin/ffprobe'),
    path.join(process.env.HOME || '', '.local/bin/ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return process.env.FFPROBE_BIN || 'ffprobe';
}

/**
 * Ensures that a video file is encoded with standard H.264 (AVC1) and AAC audio in an MP4 container,
 * with height capped at 720p. If the downloaded stream is AV1, VP9, HEVC, or bloated resolution (>720p),
 * it is transcoded to ensure universal playback in QuickTime Player, Safari, and browsers.
 */
export async function ensurePlayableH264Video(filePath: string): Promise<string> {
  const ffprobeBin = resolveFfprobeBin();
  let probeData: { codec_name?: string; height?: number; width?: number } = {};

  try {
    const { stdout } = await execFileAsync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,height,width',
      '-of', 'json',
      filePath,
    ]);
    const parsed = JSON.parse(stdout);
    if (parsed.streams && parsed.streams[0]) {
      probeData = parsed.streams[0];
    }
  } catch {
    return filePath;
  }

  const isH264 = probeData.codec_name === 'h264';
  const isCappedResolution = (probeData.height || 0) <= 720;

  if (isH264 && isCappedResolution && filePath.endsWith('.mp4')) {
    return filePath;
  }

  const ffmpegBin = resolveFfmpegBin();
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const targetPath = path.join(dir, `${base}.mp4`);
  const tempPath = path.join(dir, `${base}.transcode-${Date.now()}.mp4`);

  const isDarwin = process.platform === 'darwin';
  let transcodeSucceeded = false;

  if (isDarwin) {
    try {
      await execFileAsync(ffmpegBin, [
        '-y',
        '-i', filePath,
        '-vf', "scale='min(1280,iw)':-2",
        '-c:v', 'h264_videotoolbox',
        '-b:v', '1500k',
        '-c:a', 'aac',
        '-b:a', '128k',
        tempPath,
      ]);
      transcodeSucceeded = true;
    } catch {
      // Fallback to software libx264
    }
  }

  if (!transcodeSucceeded) {
    try {
      await execFileAsync(ffmpegBin, [
        '-y',
        '-i', filePath,
        '-vf', "scale='min(1280,iw)':-2",
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '24',
        '-c:a', 'aac',
        '-b:a', '128k',
        tempPath,
      ]);
      transcodeSucceeded = true;
    } catch {
      // If transcode fails, retain original file
      await fs.rm(tempPath, { force: true }).catch(() => {});
      return filePath;
    }
  }

  if (filePath !== targetPath) {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
  await fs.rename(tempPath, targetPath);
  return targetPath;
}

/**
 * Downloads a video file using yt-dlp to a specified destination directory.
 */
export async function downloadVideo(options: YtDlpDownloadOptions): Promise<string> {
  const {
    videoId,
    outputDir,
    format = DEFAULT_DOWNLOAD_FORMAT,
    cookiePath,
    proxyUrl,
    timeoutMs = 300_000,
  } = options;

  const validId = extractVideoId(videoId);
  if (!validId) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: `Invalid video ID: "${videoId}"`,
      stage: 'research',
      task: 'download-video',
      retryable: false,
    });
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, `${validId}.%(ext)s`);
  const binary = await resolveYtDlpBinary();

  const args = [
    ...buildBaseArgs(cookiePath, proxyUrl),
    ...(await resolveJsRuntimesArg(binary)),
    // `web` is the only client that yields downloadable formats on this egress
    // once the PO token provider + EJS solver are in place. The other clients
    // are bot-walled or expose no media formats at all.
    '--extractor-args', 'youtube:player_client=web',
    '-f',
    format,
    '--merge-output-format',
    'mp4',
    '-o',
    outputTemplate,
    toWatchUrl(validId),
  ];

  // PO token provider must be alive or the web client returns degraded/empty
  // formats. Start it (detached) if needed; fail loudly if it cannot start.
  const potUp = await ensurePotProviderRunning();
  if (!potUp) {
    throw new AppError({
      code: ErrorCodes.YTDLP_EXEC_ERROR,
      message:
        'bgutil PO-token provider is not running and could not be started ' +
        '(expected HTTP server on 127.0.0.1:4416). Install/build ' +
        'bgutil-ytdlp-pot-provider and set BGUTIL_POT_SERVER_DIR if non-standard.',
      stage: 'research',
      task: 'download-video',
      retryable: false,
    });
  }

  try {
    await execFileAsync(binary, args, {
      timeout: timeoutMs,
      env: cleanYtDlpEnv(),
    });

    const files = await fs.readdir(outputDir);
    const downloaded = files.find(
      (f) =>
        f.startsWith(validId) &&
        !f.endsWith('.part') &&
        !f.endsWith('.ytdl') &&
        (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')),
    );
    if (!downloaded) {
      throw new Error(`Video file for ${validId} was not created in ${outputDir}`);
    }

    const downloadedPath = path.join(outputDir, downloaded);
    const stat = await fs.stat(downloadedPath);
    if (stat.size === 0) {
      throw new Error(`Downloaded video file for ${validId} is 0 bytes`);
    }

    // Reject truncated downloads (duration mismatch) and frozen/dead-frame
    // media BEFORE returning.
    const playablePath = await ensurePlayableH264Video(downloadedPath);
    await validateReferenceVideoQuality(playablePath, {
      expectedDurationSec: options.expectedDurationSec,
    });
    return playablePath;
  } catch (error: any) {
    // Preserve quality-validation failures (MEDIA_DEGENERATE / MEDIA_DOWNLOAD_FAILED).
    if (error instanceof AppError) throw error;

    const combined = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`;
    if (/sign in to confirm/i.test(combined) || /the page needs to be reloaded/i.test(combined) || /not a bot/i.test(combined)) {
      throw new AppError({
        code: ErrorCodes.YOUTUBE_BOT_DETECTED,
        message: `YouTube bot-walled the yt-dlp download for ${validId} through the shared egress — refresh cookies or switch the proxy exit node`,
        stage: 'research',
        task: 'download-video',
        retryable: false,
        cause: error,
      });
    }
    if (/google\.com\/sorry|unusual traffic|HTTP Error 429/i.test(combined)) {
      throw new AppError({
        code: ErrorCodes.YOUTUBE_RATE_LIMITED,
        message: `Google rate-limited the egress for ${validId} while downloading`,
        stage: 'research',
        task: 'download-video',
        retryable: true,
        cause: error,
      });
    }
    if (/Requested format is not available/i.test(combined)) {
      throw new AppError({
        code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
        message:
          `yt-dlp obtained no downloadable format for ${validId} (only SABR/storyboard streams exposed). ` +
          `Ensure BOTH the bgutil PO-token server (127.0.0.1:4416) and the EJS challenge solver ` +
          `(pip package 'yt-dlp-ejs') are installed — without the EJS solver YouTube's 'n' challenge ` +
          `cannot be solved and the web client yields no direct URLs.`,
        stage: 'research',
        task: 'download-video',
        retryable: false,
        cause: error,
      });
    }
    throw new AppError({
      code: ErrorCodes.YTDLP_EXEC_ERROR,
      message: `Failed to download video ${validId}: ${error.message}`,
      stage: 'research',
      task: 'download-video',
      retryable: true,
      cause: error,
    });
  }
}
