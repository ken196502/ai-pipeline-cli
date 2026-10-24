/**
 * yt-dlp transcript download backed by the resident logged-in browser session.
 *
 * Why this exists: through the shared egress proxy, anonymous and headless
 * requests to YouTube watch/player endpoints are bot-walled ("Sign in to
 * confirm you're not a bot"), regardless of client (yt-dlp default/android/ios/
 * tv/web_safari all fail) — while the persistent-profile browser holds a
 * trusted, logged-in session the user keeps alive in a visible window.
 *
 * Mechanism (verified against the live egress, Oct 2026):
 * 1. Dump the LIVE cookies of the resident browser over CDP right before the
 *    yt-dlp call (disk-exported cookies.txt goes stale relative to session
 *    rotation; the CDP dump always matches the session the user sees).
 * 2. Match the browser's exact User-Agent — cookie/UA mismatch is a bot-wall
 *    trigger on its own.
 * 3. Run yt-dlp with player_client=web, -f sb0/sb1/sb2/b (storyboard fallback
 *    satisfies format selection when PO-token gating hides media streams) and
 *    --skip-download. Subtitle tracks list and VTT download succeed (verified
 *    on videos with manual + ASR tracks; videos without a track in the
 *    requested languages correctly report none).
 *
 * The resident browser is NEVER closed or restarted here: headful keep-alive
 * sessions preserve the user's login and are the whole point of this module.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Transcript } from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import { launchBrowser } from '../../browser/launcher.js';
import { buildBaseArgs, resolveJsRuntimesArg, resolveYtDlpBinary } from './ytdlp.js';
import { extractVideoId, toWatchUrl } from './urls.js';
import { parseVtt } from './vtt.js';

const execFileAsync = promisify(execFile);

export interface YtDlpCdpTranscriptOptions {
  videoId: string;
  preferredLanguages?: readonly string[];
  /** Profile dir for the persistent browser session (defaults to launcher default). */
  profileDir?: string;
  /** Egress proxy for yt-dlp (defaults to PROXY_URL env). */
  proxyUrl?: string | null;
  /** Timeout for the yt-dlp call in ms (default 120s). */
  timeoutMs?: number;
}

interface SessionSnapshot {
  cookiePath: string;
  userAgent: string;
  workDir: string;
}

/**
 * Strips ambient proxy variables so buildBaseArgs() is the sole source of
 * proxy configuration (mirrors cleanYtDlpEnv() in ytdlp.ts).
 */
function cleanYtDlpEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    delete env[key];
  }
  return env;
}

/**
 * Captures the resident browser's live session: all cookies (Netscape format
 * for yt-dlp) plus its exact User-Agent. The browser must already be running
 * via launchBrowser(); this never closes or restarts it.
 */
async function snapshotBrowserSession(options: { profileDir?: string }): Promise<SessionSnapshot> {
  const launched = await launchBrowser({
    headless: false,
    ...(options.profileDir ? { profileDir: options.profileDir } : {}),
  });
  const ctx = launched.browser.contexts()[0];
  if (!ctx) {
    throw new AppError({
      code: ErrorCodes.UNEXPECTED_ERROR,
      message: 'Resident browser launched without any browser context',
      stage: 'research',
      task: 'resolve-transcript',
      retryable: true,
    });
  }

  // Read the UA from an existing page when possible; a briefly created helper
  // page is closed again. Tabs the user has open are never touched.
  const pages = ctx.pages();
  let probe = pages.find((p) => p.url().startsWith('http')) ?? null;
  let created = false;
  if (!probe) {
    probe = await ctx.newPage();
    created = true;
  }
  const browserVersion = launched.browser.version();
  const userAgent =
    (await probe.evaluate(() => navigator.userAgent).catch(() => null)) ??
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;
  if (created) {
    await probe.close().catch(() => {});
  }

  // Anti-bot cookies (CONSISTENCY, DEVICE_INFO, __Secure-YT_DERP, __Secure-YT_TVFAS)
  // are seeded by youtube.com page loads and vanish when no youtube tab exists.
  // Without them the dumped session is bot-walled even with valid auth tokens
  // (verified: successful dumps always had a youtube.com page open). Ensure a
  // youtube.com page is loaded before dumping — and keep it open afterwards so
  // the session stays warm for subsequent calls.
  const hasYoutubePage = ctx.pages().some((p) => /(^|\.)youtube\.com/.test(p.url()));
  if (!hasYoutubePage) {
    const warmPage = await ctx.newPage();
    const resp = await warmPage
      .goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => null);
    if (!resp || warmPage.url().includes('google.com/sorry')) {
      await warmPage.close().catch(() => {});
      throw new AppError({
        code: ErrorCodes.YOUTUBE_RATE_LIMITED,
        message: 'Could not warm the session: youtube.com homepage unreachable through the egress',
        stage: 'research',
        task: 'resolve-transcript',
        retryable: true,
      });
    }
  }

  const cookies = await ctx.cookies();
  if (cookies.length === 0) {
    throw new AppError({
      code: ErrorCodes.YOUTUBE_BOT_DETECTED,
      message: 'Resident browser session holds no cookies — log into YouTube in the browser window, then retry',
      stage: 'research',
      task: 'resolve-transcript',
      retryable: false,
    });
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytdlp-cdp-'));
  const cookiePath = path.join(workDir, 'cookies-cdp.txt');
  const lines = ['# Netscape HTTP Cookie File', '# dumped live from the resident browser via CDP'];
  for (const c of cookies) {
    const flag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expiry = c.expires > 0 ? Math.floor(c.expires) : 0;
    // NOTE: no '#HttpOnly_' prefix — yt-dlp only honours it at line start; a
    // mid-line prefix would corrupt the cookie NAME and break the session.
    lines.push([c.domain, flag, c.path, c.secure ? 'TRUE' : 'FALSE', expiry, c.name, c.value].join('\t'));
  }
  await fs.writeFile(cookiePath, lines.join('\n') + '\n', 'utf8');

  return { cookiePath, userAgent, workDir };
}

/**
 * --sub-langs value from preferred languages: exact codes plus wildcard forms
 * ("en,en*" matches en, en-orig, en-US, ...).
 */
function buildSubLangs(preferredLanguages: readonly string[]): string {
  const langs = new Set<string>();
  for (const lang of preferredLanguages) {
    if (lang.includes('*')) {
      langs.add(lang);
    } else {
      langs.add(lang);
      langs.add(`${lang}*`);
    }
  }
  return [...langs].join(',');
}

interface PickedSubtitleFile {
  path: string;
  language: string;
  kind: 'auto' | 'manual';
}

/**
 * Picks the downloaded subtitle file best matching the preferred languages.
 * yt-dlp names files <id>.<lang>.vtt; the "-orig" suffix marks manual tracks.
 */
async function pickSubtitleFile(
  workDir: string,
  videoId: string,
  preferredLanguages: readonly string[],
): Promise<PickedSubtitleFile | null> {
  const entries = await fs.readdir(workDir).catch(() => [] as string[]);
  const candidates = entries
    .filter((f) => f.startsWith(`${videoId}.`) && f.endsWith('.vtt'))
    .map((f) => {
      const lang = f.slice(videoId.length + 1, -'.vtt'.length);
      return {
        path: path.join(workDir, f),
        language: lang,
        kind: (lang.endsWith('-orig') ? 'manual' : 'auto') as 'auto' | 'manual',
        base: lang.replace(/-orig$/, ''),
      };
    });
  if (candidates.length === 0) return null;

  for (const pref of preferredLanguages) {
    const prefBase = pref.replace(/[-*].*$/, '');
    const exact = candidates.find((c) => c.base === pref && c.kind === 'manual');
    if (exact) return exact;
    const exactAny = candidates.find((c) => c.base === pref);
    if (exactAny) return exactAny;
    const prefix = candidates.find((c) => c.base === prefBase);
    if (prefix) return prefix;
  }
  return candidates[0];
}

/**
 * Downloads a transcript with yt-dlp using the resident browser's live session.
 * Throws AppError with codes the caller can act on:
 * - YOUTUBE_BOT_DETECTED: the live session itself was bot-walled (user may
 *   need to re-login in the browser window, or run the cookie-refresh stage).
 * - SUBTITLE_NOT_AVAILABLE: the video has no subtitle track in the requested
 *   languages (definitive — no point retrying other transports).
 * - YOUTUBE_RATE_LIMITED / YTDLP_EXEC_ERROR: transient egress/exec issues.
 */
export async function downloadTranscriptViaYtDlpCdp(
  options: YtDlpCdpTranscriptOptions,
): Promise<Transcript> {
  const {
    videoId,
    preferredLanguages = ['en', 'en-US', 'en-GB'],
    profileDir,
    proxyUrl = process.env.PROXY_URL || null,
    timeoutMs = 120_000,
  } = options;

  const validId = extractVideoId(videoId);
  if (!validId) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: `Invalid video ID: "${videoId}"`,
      stage: 'research',
      task: 'resolve-transcript',
      retryable: false,
    });
  }

  const snapshot = await snapshotBrowserSession({ profileDir });
  try {
    const binary = await resolveYtDlpBinary();
    const args = [
      ...buildBaseArgs(snapshot.cookiePath, proxyUrl),
      ...(await resolveJsRuntimesArg(binary)),
      '--user-agent', snapshot.userAgent,
      // Storyboard fallback: PO-token gating can hide all media formats, which
      // would abort format selection before subtitles are written. Storyboards
      // always exist and --skip-download never fetches them.
      '--format', 'sb0/sb1/sb2/b',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', buildSubLangs(preferredLanguages),
      '--skip-download',
      '--no-warnings',
      '-o', path.join(snapshot.workDir, '%(id)s.%(ext)s'),
      toWatchUrl(validId),
    ];

    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(binary, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: cleanYtDlpEnv(),
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: any) {
      const combined = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
      // YouTube's wall surfaces under several player-response guises; treat
      // them all as bot-wall evidence rather than transient exec failures:
      // - "Sign in to confirm you're not a bot" (classic wall)
      // - "The page needs to be reloaded" (newer wall served to non-attested
      //   clients when the exit IP is flagged; NOT a transient error)
      if (/sign in to confirm/i.test(combined) || /the page needs to be reloaded/i.test(combined)) {
        throw new AppError({
          code: ErrorCodes.YOUTUBE_BOT_DETECTED,
          message: `YouTube bot-walled the resident session for ${validId} (through the shared egress) — if the logged-in browser also shows google.com/sorry, switch the proxy exit node; otherwise log into YouTube in the browser window, then retry`,
          stage: 'research',
          task: 'resolve-transcript',
          retryable: false,
          cause: error,
        });
      }
      if (/google\.com\/sorry|unusual traffic|HTTP Error 429/i.test(combined)) {
        throw new AppError({
          code: ErrorCodes.YOUTUBE_RATE_LIMITED,
          message: `Google rate-limited the egress for ${validId} (google.com/sorry on the player API)`,
          stage: 'research',
          task: 'resolve-transcript',
          retryable: true,
          cause: error,
        });
      }
      throw new AppError({
        code: ErrorCodes.YTDLP_EXEC_ERROR,
        message: error.killed
          ? `yt-dlp transcript download timed out after ${Math.round(timeoutMs / 1000)}s for ${validId}`
          : `yt-dlp transcript download failed for ${validId}: ${(error.stderr || error.message || '').toString().slice(0, 400)}`,
        stage: 'research',
        task: 'resolve-transcript',
        retryable: true,
        cause: error,
      });
    }

    // A zero-exit run without subtitle files can be either a genuine
    // "no track in these languages" or a soft-walled player response (rapid
    // consecutive player API calls through the egress occasionally return a
    // captionless playability JSON). Retry once before declaring it definitive.
    let picked = await pickSubtitleFile(snapshot.workDir, validId, preferredLanguages);
    if (!picked) {
      await new Promise((r) => setTimeout(r, 8_000));
      try {
        const retry = await execFileAsync(binary, args, {
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          env: cleanYtDlpEnv(),
        });
        stdout = retry.stdout;
        stderr = retry.stderr;
      } catch (error: any) {
        stdout = error.stdout || stdout;
        stderr = error.stderr || stderr;
      }
      picked = await pickSubtitleFile(snapshot.workDir, validId, preferredLanguages);
    }
    if (!picked) {
      if (process.env.YTDLP_CDP_DEBUG) {
        const files = await fs.readdir(snapshot.workDir).catch(() => [] as string[]);
        console.log(`[ytdlp-cdp][debug] workdir files: ${JSON.stringify(files)}`);
        console.log(`[ytdlp-cdp][debug] stdout: ${stdout.slice(0, 1500)}`);
        console.log(`[ytdlp-cdp][debug] stderr: ${stderr.slice(0, 1500)}`);
      } else {
        await fs.rm(snapshot.workDir, { recursive: true, force: true }).catch(() => {});
      }
      throw new AppError({
        code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
        message: `Video ${validId} has no subtitle track in the requested languages (${preferredLanguages.join(', ')})`,
        stage: 'research',
        task: 'resolve-transcript',
        retryable: false,
      });
    }

    const vttBody = await fs.readFile(picked.path, 'utf8');
    const transcript = parseVtt(vttBody, {
      videoId: validId,
      language: picked.language,
      source: picked.kind,
    });

    if (transcript.cues.length === 0) {
      throw new AppError({
        code: ErrorCodes.SUBTITLE_PARSE_FAILED,
        message: `Caption track "${picked.language}" for ${validId} parsed to 0 cues`,
        stage: 'research',
        task: 'resolve-transcript',
        retryable: true,
      });
    }

    return transcript;
  } finally {
    if (!process.env.YTDLP_CDP_DEBUG) {
      await fs.rm(snapshot.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
