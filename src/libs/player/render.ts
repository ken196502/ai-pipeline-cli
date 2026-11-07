/**
 * Headless frame-by-frame rendering of the explainer player.
 *
 * A local static server hosts the explainer bundle, a headless browser opens the
 * player in render mode, and every frame is painted deterministically via
 * `window.__explainer.seek(t)` and captured as a PNG streamed into ffmpeg's
 * image2pipe encoder. The encoded silent video is then muxed with the edge-tts
 * narration track.
 *
 * Browser engine (default: the project's Ungoogled Chromium):
 *   - `chromium` (default): the project's Ungoogled Chromium via an explicit
 *     `browserPath` (or the auto-detected path).
 *   - `firefox`: system Firefox via Playwright's WebDriver BiDi
 *     transport (`channel: 'moz-firefox'`). On Ubuntu the Firefox package is a
 *     snap with strict confinement, so the persistent render profile must live
 *     under `~/snap/firefox/common/` — /tmp profiles are rejected with
 *     "Could not find profile folder".
 *
 * The engine is explicit — there is no silent cross-engine fallback. Override
 * with `EXPLAINER_RENDER_ENGINE=firefox|chromium` or the `engine` parameter.
 *
 * Chunk resume: `.render-chunks/manifest.json` records a hash of everything
 * that affects the rendered pixels (timeline, style, voice, player JS). A
 * mismatch wipes the chunk directory so a changed script/style never produces
 * a video stitched from stale chunks (P0/B2).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { resolveChromiumPath } from '../browser/installer.js';
import {
  probeRenderService,
  renderViaService,
  resolveRenderServiceGpuMode,
  type RenderServiceGpuMode,
} from './render-service-client.js';

const execFileAsync = promisify(execFile);

/** Engines supported by the final render stage. */
export type ExplainerRenderEngine = 'firefox' | 'chromium';
export type TutorialRenderEngine = ExplainerRenderEngine;

declare global {
  interface Window {
    __explainer?: { seek(t: number): Promise<void> };
    __explainerReady?: boolean;
    __explainerError?: string;
    __tutorial?: { seek(t: number): Promise<void> };
    __tutorialReady?: boolean;
    __tutorialError?: string;
  }
}

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

/**
 * Resolves the default Firefox render profile directory.
 *
 * Ubuntu ships Firefox as a strictly-confined snap that can only read profiles
 * inside its own data dir; a profile anywhere else fails launch with
 * "Could not find profile folder". Override with EXPLAINER_RENDER_FIREFOX_PROFILE.
 */
export function resolveFirefoxRenderProfileDir(): string {
  const override = process.env.EXPLAINER_RENDER_FIREFOX_PROFILE || process.env.TUTORIAL_RENDER_FIREFOX_PROFILE;
  if (override) {
    return path.resolve(override);
  }
  const snapCommon = path.join(os.homedir(), 'snap', 'firefox', 'common');
  if (fs.existsSync(snapCommon)) {
    return path.join(snapCommon, 'aigc-render', 'profile');
  }
  return path.join(os.tmpdir(), 'aigc-render-firefox-profile');
}

/** Minimal static file server used to host the explainer bundle for the player. */
export async function serveExplainerDir(dir: string): Promise<StaticServer> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = requestPath.replace(/^\/+/, '');
    if (rel === '') {
      if (fs.existsSync(path.join(root, 'explainer-player.html'))) {
        rel = 'explainer-player.html';
      } else {
        rel = 'tutorial-player.html';
      }
    }
    const filePath = path.join(root, rel);

    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const size = fs.statSync(filePath).size;
    let start = 0, end = size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      if (!match || (!match[1] && !match[2]) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind explainer static server');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
export const serveTutorialDir = serveExplainerDir;

/** Default x264 preset for every chunk encode (shared by produce + host script). */
export const DEFAULT_ENCODE_PRESET = 'medium';

/**
 * Chromium GL backend used for frame rendering.
 *
 * `default` leaves the choice to Chromium (SwiftShader on GPU-less hosts).
 * `gpu` / `vulkan` force ANGLE onto the real driver and are asserted after boot:
 * if the browser comes up on SwiftShader anyway the render fails loudly instead
 * of silently rendering at CPU speed. Measured on this host (2026-11-05,
 * virtio-gpu without 3D accel): default 773 ms/frame, `gpu` 797 ms/frame — both
 * software rasterizers, so `gpu` is a deliberate opt-in, not the default.
 */
export type ChromiumGlMode = 'default' | 'gpu' | 'vulkan' | 'swiftshader';

export function resolveChromiumGlMode(raw?: string | null): ChromiumGlMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'default' || value === 'auto') return 'default';
  if (value === 'gpu' || value === 'gl' || value === 'angle-gl') return 'gpu';
  if (value === 'vulkan' || value === 'angle-vulkan') return 'vulkan';
  if (value === 'swiftshader' || value === 'cpu') return 'swiftshader';
  throw new Error(`unknown EXPLAINER_CHROMIUM_GL "${raw}" — use default | gpu | vulkan | swiftshader`);
}

/** Extra Chromium flags for a GL mode (empty for `default`). */
export function chromiumGlArgs(mode: ChromiumGlMode): string[] {
  switch (mode) {
    case 'gpu':
      return ['--use-gl=angle', '--use-angle=gl', '--enable-gpu', '--enable-gpu-compositing'];
    case 'vulkan':
      return ['--use-gl=angle', '--use-angle=vulkan', '--enable-gpu', '--enable-gpu-compositing'];
    case 'swiftshader':
      return ['--use-gl=angle', '--use-angle=swiftshader'];
    case 'default':
      return [];
  }
}

export interface LaunchRenderBrowserParams {
  engine?: ExplainerRenderEngine;
  browserPath?: string;
  width: number;
  height: number;
  profileDir?: string;
}

export interface LaunchRenderBrowserResult {
  browser: Browser | BrowserContext;
  page: Page;
  engine: ExplainerRenderEngine;
  executablePath: string;
}

/**
 * Launches the render browser for the final video rendering stage.
 *
 * Defaults to Chromium (`engine: 'chromium'`, overridable via
 * EXPLAINER_RENDER_ENGINE). Failures surface loudly on the requested engine —
 * never a silent engine switch.
 */
export async function launchRenderBrowser(
  params: LaunchRenderBrowserParams
): Promise<LaunchRenderBrowserResult> {
  const envEngine = process.env.EXPLAINER_RENDER_ENGINE || process.env.TUTORIAL_RENDER_ENGINE;
  const explicitEngine =
    params.engine ?? (envEngine === 'firefox' || envEngine === 'chromium' ? envEngine : undefined);

  // Default is 'chromium'. Overridable via EXPLAINER_RENDER_ENGINE or explicit param.
  const engine: ExplainerRenderEngine = explicitEngine ?? 'chromium';

  if (explicitEngine === 'firefox' && params.browserPath) {
    throw new Error(
      `render engine 'firefox' does not accept browserPath (a Chromium executable) — pass engine 'chromium' to use it`
    );
  }

  const { width, height } = params;

  if (engine === 'firefox') {
    const profileDir = params.profileDir ? path.resolve(params.profileDir) : resolveFirefoxRenderProfileDir();
    await fsp.mkdir(profileDir, { recursive: true });
    // Clear stale lock files from previous runs to prevent profile lock deadlocks
    for (const lockFile of ['lock', '.parentlock', 'parent.lock']) {
      await fsp.rm(path.join(profileDir, lockFile), { force: true }).catch(() => undefined);
    }

    // Resolve Firefox from an explicit env override, else from playwright-core's
    // own registry — never from a hardcoded user-home path (P0/B6).
    const envFfPath =
      process.env.FIREFOX_PATH ||
      process.env.EXPLAINER_RENDER_FIREFOX_PATH ||
      process.env.TUTORIAL_RENDER_FIREFOX_PATH;
    const customFfPath = envFfPath || firefox.executablePath();

    const isHeadless =
      (process.env.EXPLAINER_RENDER_HEADLESS || process.env.TUTORIAL_RENDER_HEADLESS) === 'true';

    const context = await firefox.launchPersistentContext(profileDir, {
      ...(customFfPath ? { executablePath: customFfPath } : {}),
      headless: isHeadless,
      viewport: { width, height },
      // Deterministic frame output.
      deviceScaleFactor: 1,
      firefoxUserPrefs: {
        'layers.acceleration.force-enabled': true,
        'webgl.force-enabled': true,
        'gfx.webrender.all': true,
        'widget.dmabuf.force-enabled': true,
      },
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width, height });
    const executablePath = customFfPath || 'system firefox';
    return { browser: context, page, engine, executablePath };
  }

  const executablePath = await resolveChromiumPath(params.browserPath);
  const glMode = resolveChromiumGlMode(process.env.EXPLAINER_CHROMIUM_GL);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1',
      '--font-render-hinting=none',
      '--disable-lcd-text',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      // WebGL: hardware accelerated by default; the player probes the context
      // and falls back to Canvas2D when it cannot be created.
      '--enable-unsafe-webgpu',
      ...chromiumGlArgs(glMode),
    ],
  });
  if (glMode !== 'default') {
    console.log(`[render] chromium GL mode: ${glMode} (${chromiumGlArgs(glMode).join(' ')})`);
  }
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setViewportSize({ width, height });
  return { browser, page, engine, executablePath };
}

export interface RenderServiceRouteConfig {
  /** Base URL of the host render service, e.g. http://192.168.64.1:8790. */
  url: string;
  /** Bearer token; falls back to EXPLAINER_RENDER_SERVICE_TOKEN. */
  token?: string;
  /** GPU mode passed to the host service (falls back to EXPLAINER_RENDER_GPU / EXPLAINER_CHROMIUM_GL). */
  gpu?: RenderServiceGpuMode;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RenderExplainerVideoParams {
  /** Explainer bundle directory containing explainer-player.html and assets. */
  explainerDir?: string;
  /** Legacy alias for explainerDir. */
  tutorialDir?: string;
  /** Timeline with resolution, fps and total duration. */
  timeline: {
    resolution: { width: number; height: number };
    fps: number;
    totalDurationSec: number;
  };
  /** Absolute path of the full narration WAV (muxed into the final video). */
  narrationWavPath: string;
  /** Destination MP4 path of the final explainer video. */
  outVideoPath: string;
  /** Render engine override. Defaults to local Firefox (EXPLAINER_RENDER_ENGINE). */
  engine?: ExplainerRenderEngine;
  /** Chromium executable path (engine 'chromium' only; auto-detected if omitted). */
  browserPath?: string;
  /** Persistent browser profile dir (defaults to a temp dir per render). */
  profileDir?: string;
  concurrency?: number;
  crf?: number;
  preset?: string;
  /**
   * Frame transfer mode: `raw` (default — RGBA readback from the canvas →
   * ffmpeg `-f rawvideo`, skips PNG encode/decode) or `png` (Playwright
   * screenshot). The WebGL path returns bottom-up pixels so ffmpeg flips it.
   * Overridable with EXPLAINER_FRAME_EXPORT=raw|png.
   */
  frameExport?: 'png' | 'raw';
  logFilePath?: string;
  onProgress?: (renderedFrames: number, totalFrames: number) => void;
  /**
   * Host render service routing (also enabled by EXPLAINER_RENDER_SERVICE).
   * When configured, the service is probed first; an unhealthy service fails the
   * render — it never silently falls back to the slow local renderer.
   */
  renderService?: RenderServiceRouteConfig;
  /** Explicitly bypass the render service and render on this machine. */
  forceLocalRender?: boolean;
}
export type RenderTutorialVideoParams = RenderExplainerVideoParams;

export interface RenderExplainerVideoResult {
  videoPath: string;
  silentVideoPath: string;
  framesRendered: number;
  totalFrames: number;
  durationSec: number;
  engine: ExplainerRenderEngine;
}
export type RenderTutorialVideoResult = RenderExplainerVideoResult;

/**
 * Sizes the concurrent chunk-render pool.
 *
 * Each worker owns one browser process AND one ffmpeg encoder, so one worker needs
 * ~2 CPU cores. A flat 2 therefore starves a 2-core box (4 CPU-heavy processes on
 * 2 cores) and makes a single 1080p evaluate+screenshot miss the frame budget.
 * Exported for unit testing; override with EXPLAINER_RENDER_CONCURRENCY.
 */
export function resolveRenderConcurrency(cpuCount: number, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.floor(override));
  }
  // Shared-browser multi-tab rendering: every 1080p tab holds a SwiftShader WebGL
  // context plus ~8 MB readback buffers per frame, so RAM — not core count — is the
  // real limit. 2026-11-03: 2 tabs on a 2-core box with 1.9 GB free crashed the
  // renderer ("page.evaluate: Target crashed") 60 frames in.
  const PER_TAB_BUDGET_MB = 1500;
  const availableMb = Math.floor(os.freemem() / (1024 * 1024));
  const byMemory = Math.max(1, Math.floor(availableMb / PER_TAB_BUDGET_MB));
  return Math.max(1, Math.min(4, Math.floor(cpuCount || 2), byMemory));
}

/**
 * Per-frame ceiling for `evaluate(seek) + screenshot`. This is a runaway guard, not
 * the expected cost; override with EXPLAINER_FRAME_TIMEOUT_MS.
 */
export function resolveFrameTimeoutMs(override?: number): number {
  return override !== undefined && Number.isFinite(override) && override > 0 ? Math.floor(override) : 60_000;
}

/** Host state that decides whether a render tab can keep up. */
export interface SystemPressure {
  cpuCount: number;
  load1: number;
  load5: number;
  load15: number;
  freeMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
}

export function readSystemPressure(): SystemPressure {
  const cpuCount = os.cpus()?.length || 1;
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  let freeMb = Math.floor(os.freemem() / (1024 * 1024));
  let swapTotalMb = 0;
  let swapUsedMb = 0;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const read = (key: string) => {
      const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm'));
      return match ? Math.floor(Number(match[1]) / 1024) : 0;
    };
    const availableMb = read('MemAvailable');
    if (availableMb > 0) freeMb = availableMb;
    swapTotalMb = read('SwapTotal');
    swapUsedMb = Math.max(0, swapTotalMb - read('SwapFree'));
  } catch {
    // /proc/meminfo is Linux-only; os.freemem() above is the portable part.
  }
  return { cpuCount, load1, load5, load15, freeMb, swapUsedMb, swapTotalMb };
}

export function describeSystemPressure(pressure: SystemPressure): string {
  const swap =
    pressure.swapTotalMb > 0
      ? `${pressure.swapUsedMb}/${pressure.swapTotalMb} MB swap used`
      : 'no swap';
  return `load ${pressure.load1.toFixed(1)} on ${pressure.cpuCount} CPUs, ${pressure.freeMb} MB free, ${swap}`;
}

/**
 * True when the host is starved badly enough that a 1080p render tab will start
 * missing frames (measured on 2 cores / 4 GB with a full swap file).
 */
export function isSystemUnderPressure(pressure: SystemPressure): boolean {
  const swapRatio = pressure.swapTotalMb > 0 ? pressure.swapUsedMb / pressure.swapTotalMb : 0;
  return swapRatio >= 0.8 || pressure.load1 >= pressure.cpuCount * 2;
}

/**
 * Per-frame ceiling, widened while frames are legitimately slow.
 *
 * The base value is a runaway guard, not the expected cost. On a loaded host the
 * same frame legitimately takes 10-20x longer (measured 2026-11-05: 0.6s → 15s
 * when a second browser job hammered a 2-core/4 GB box), and a fixed 60s ceiling
 * aborted a 66-minute render at 64%. Scaling off the recent p90 keeps the guard
 * meaningful: an idle box still aborts after `base`, a loaded box gets up to
 * `5x base` instead of dying on a slow-but-alive tab.
 */
export function adaptiveFrameTimeoutMs(baseMs: number, recentFrameMs: number[]): number {
  if (recentFrameMs.length < 10) return baseMs;
  const sorted = [...recentFrameMs].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  return Math.min(baseMs * 5, Math.max(baseMs, Math.ceil(p90 * 10)));
}

/**
 * Hash of everything that affects the rendered pixels: the player JS/HTML, the
 * assembled timeline, the style document and the voice timing. Used as the
 * `.render-chunks/manifest.json` cache key.
 */
export async function computeRenderHash(
  explainerDir: string,
  timeline: unknown,
  outVideoPath: string
): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(timeline));
  hash.update(path.basename(outVideoPath));
  for (const name of [
    'explainer-player.js',
    'explainer-player.html',
    'explainer.json',
    'style.json',
    'voice.json',
  ]) {
    const filePath = path.join(explainerDir, name);
    const content = await fsp.readFile(filePath).catch(() => null);
    hash.update(name);
    hash.update(content ?? Buffer.from('missing'));
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Validates the chunk manifest. Any hash mismatch wipes the cached chunks so a
 * changed script/style can never be stitched together with stale segments.
 * Returns the number of chunks that were discarded.
 */
export async function ensureChunkManifest(chunkDir: string, renderHash: string): Promise<number> {
  const manifestPath = path.join(chunkDir, 'manifest.json');
  let previous: string | null = null;
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8');
    previous = JSON.parse(raw).hash ?? null;
  } catch {
    previous = null;
  }

  let discarded = 0;
  if (previous !== renderHash) {
    const entries = await fsp.readdir(chunkDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.startsWith('chunk-') && entry !== 'concat-list.txt') continue;
      await fsp.rm(path.join(chunkDir, entry), { force: true, recursive: true }).catch(() => undefined);
      if (entry.startsWith('chunk-')) discarded += 1;
    }
    await fsp.writeFile(
      manifestPath,
      JSON.stringify({ hash: renderHash, updatedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf-8'
    );
  }
  return discarded;
}

/**
 * Renders the player frame-by-frame into a video and muxes the narration track.
 */
export async function renderExplainerVideo(
  params: RenderExplainerVideoParams
): Promise<RenderExplainerVideoResult> {
  const explainerDir = params.explainerDir || params.tutorialDir;
  if (!explainerDir) {
    throw new Error('renderExplainerVideo requires explainerDir (or the legacy tutorialDir alias)');
  }
  const { timeline, narrationWavPath, outVideoPath } = params;

  // ---------------------------------------------------------------------------
  // Host render service routing (Docs/plan-explainer-host-render-service.md §5).
  //
  // A configured service is authoritative: if it is unhealthy the render FAILS.
  // Silently falling back to the slow VM renderer would hide a broken host and
  // burn an hour of CPU, so there is no fallback — only an explicit
  // `forceLocalRender` / `--local-render` opt-out.
  // ---------------------------------------------------------------------------
  const serviceUrl = (params.renderService?.url || process.env.EXPLAINER_RENDER_SERVICE || '').trim();
  if (params.forceLocalRender) {
    if (serviceUrl) {
      console.log('[render] --local-render set — bypassing render service');
    }
  } else if (serviceUrl) {
    const gpu = resolveRenderServiceGpuMode(
      params.renderService?.gpu ?? process.env.EXPLAINER_RENDER_GPU ?? process.env.EXPLAINER_CHROMIUM_GL
    );
    const token = params.renderService?.token ?? process.env.EXPLAINER_RENDER_SERVICE_TOKEN;
    if (!token) {
      throw new Error(
        `[render] render service ${serviceUrl} is CONFIGURED but no token is set. ` +
          'Set EXPLAINER_RENDER_SERVICE_TOKEN (or pass --render-service-token / params.renderService.token). ' +
          'Refusing to render without authentication.'
      );
    }

    console.log(`[render] render service configured: ${serviceUrl} (gpu=${gpu}) — probing /healthz ...`);
    const healthy = await probeRenderService({
      baseUrl: serviceUrl,
      token,
      probeTimeoutMs: params.renderService?.probeTimeoutMs,
    });
    if (!healthy) {
      throw new Error(
        `[render] render service ${serviceUrl} is CONFIGURED but UNHEALTHY (probe failed). ` +
          'Refusing to silently fall back to the slow VM renderer. ' +
          'Fix the host service, or unset EXPLAINER_RENDER_SERVICE / pass --local-render to render locally.'
      );
    }

    console.log(`[render] ROUTING TO HOST RENDER SERVICE ${serviceUrl} (gpu=${gpu})`);
    return await renderViaService({
      baseUrl: serviceUrl,
      token,
      gpu,
      probeTimeoutMs: params.renderService?.probeTimeoutMs,
      pollIntervalMs: params.renderService?.pollIntervalMs,
      explainerDir,
      timeline,
      outVideoPath,
      crf: params.crf,
      preset: params.preset,
      fps: timeline.fps,
      onProgress: params.onProgress,
    });
  } else {
    console.log('[render] no render service configured — rendering locally on this machine');
  }

  const { width, height } = timeline.resolution;
  const fps = timeline.fps;
  const totalFrames = Math.max(1, Math.round(timeline.totalDurationSec * fps));
  const silentVideoPath = path.join(path.dirname(outVideoPath), 'explainer-silent.mp4');

  await fsp.mkdir(path.dirname(outVideoPath), { recursive: true });

  const chunkDir = path.join(path.dirname(outVideoPath), '.render-chunks');
  await fsp.mkdir(chunkDir, { recursive: true });

  const renderHash = await computeRenderHash(explainerDir, timeline, outVideoPath);
  const discardedChunks = await ensureChunkManifest(chunkDir, renderHash);
  if (discardedChunks > 0) {
    console.log(
      `[render] invalidated ${discardedChunks} stale chunk(s): timeline/style/voice/player changed`
    );
  }

  const server = await serveExplainerDir(explainerDir);
  const CHUNK_SIZE = 1000; // 1000 frames (~33s) per segment with fresh browser connection

  try {
    const envEngine = process.env.EXPLAINER_RENDER_ENGINE || process.env.TUTORIAL_RENDER_ENGINE;
    const engine =
      params.engine ?? (envEngine === 'firefox' || envEngine === 'chromium' ? envEngine : 'chromium');

    // Dual-thread concurrent chunk renderer
    const chunkTasks: Array<{ startFrame: number; endFrame: number; chunkFilePath: string }> = [];
    for (let startFrame = 0; startFrame < totalFrames; startFrame += CHUNK_SIZE) {
      const endFrame = Math.min(startFrame + CHUNK_SIZE, totalFrames);
      const chunkFilename = `chunk-${String(startFrame).padStart(6, '0')}.mp4`;
      const chunkFilePath = path.join(chunkDir, chunkFilename);
      chunkTasks.push({ startFrame, endFrame, chunkFilePath });
    }

    const chunkFiles: string[] = chunkTasks.map((t) => t.chunkFilePath);
    let overallRendered = 0;
    const renderStartedAt = Date.now();

    const cpuCount = os.cpus()?.length || 2;
    const concurrencyEnv = process.env.EXPLAINER_RENDER_CONCURRENCY || process.env.TUTORIAL_RENDER_CONCURRENCY;
    const CONCURRENCY = resolveRenderConcurrency(
      cpuCount,
      params.concurrency ?? (concurrencyEnv ? Number(concurrencyEnv) : undefined)
    );
    const frameTimeoutEnv = process.env.EXPLAINER_FRAME_TIMEOUT_MS || process.env.TUTORIAL_FRAME_TIMEOUT_MS;
    const FRAME_TIMEOUT_MS = resolveFrameTimeoutMs(Number(frameTimeoutEnv));
    const pressureAtStart = readSystemPressure();
    if (isSystemUnderPressure(pressureAtStart)) {
      console.warn(
        `[render] WARN host under pressure before rendering: ${describeSystemPressure(pressureAtStart)} — ` +
          'frames will be slow; stop other browser/CPU-heavy jobs to avoid a stalled tab'
      );
    }
    let taskIndex = 0;

    // Detect player HTML filename in bundle
    const hasExplainerHtml = fs.existsSync(path.join(explainerDir, 'explainer-player.html'));
    const playerHtmlFilename = hasExplainerHtml ? 'explainer-player.html' : 'tutorial-player.html';

    // Launch ONE shared browser instance; concurrent workers each use an isolated tab (page)
    // within the same process to eliminate multi-process memory overhead while maximizing throughput.
    const sharedProfileDir = params.profileDir
      ? path.resolve(params.profileDir)
      : path.join(os.tmpdir(), `aigc-render-shared-${Date.now()}`);
    await fsp.mkdir(sharedProfileDir, { recursive: true });

    let sharedBrowser: Browser | BrowserContext | null = null;
    let initialPage: Page | null = null;

    try {
      const launched = await launchRenderBrowser({
        engine,
        browserPath: engine === 'chromium' ? params.browserPath : undefined,
        width,
        height,
        profileDir: sharedProfileDir,
      });
      sharedBrowser = launched.browser;
      initialPage = launched.page;

      const renderChunkWorker = async (workerId: number): Promise<void> => {
        let workerPage: Page | null = null;
        if (workerId === 1 && initialPage) {
          workerPage = initialPage;
        } else {
          workerPage = await (sharedBrowser as any).newPage({ viewport: { width, height } });
        }

        try {
          await workerPage!.goto(`${server.origin}/${playerHtmlFilename}?render=1`, { waitUntil: 'load', timeout: 60_000 });
          await workerPage!.waitForFunction(
            'window.__explainerReady === true || window.__tutorialReady === true || window.__explainerError || window.__tutorialError',
            undefined,
            { timeout: 60_000 }
          );

          const bootErr = await workerPage!.evaluate('window.__explainerError || window.__tutorialError || null');
          if (bootErr) throw new Error(`explainer player failed to boot: ${bootErr}`);

          // Report the renderer that actually came up (hardware GL, SwiftShader or
          // the Canvas2D fallback) so a silent downgrade is visible in the log.
          let playerRenderer = 'canvas2d';
          const diag = await workerPage!.evaluate(() => {
            const api: any = (window as any).__explainer || (window as any).__tutorial || {};
            return {
              renderer: api.renderer || 'unknown',
              rendererInfo: api.rendererInfo || '',
              warnings: Array.isArray(api.warnings) ? api.warnings : [],
            };
          });
          playerRenderer = diag.renderer;
          if (workerId === 1) {
            console.log(`[render] player renderer: ${diag.renderer} (${diag.rendererInfo || 'n/a'})`);
            for (const warning of diag.warnings) console.warn(`[render] player warning: ${warning}`);
          }

          // A requested GL backend that silently lands elsewhere would look
          // identical in the logs. Assert the backend actually came up, and shout
          // when it is only a software rasterizer (this host: Mesa llvmpipe behind
          // virtio-gpu, i.e. no hardware acceleration at all).
          const requestedGlMode = resolveChromiumGlMode(process.env.EXPLAINER_CHROMIUM_GL);
          if (requestedGlMode === 'gpu' || requestedGlMode === 'vulkan') {
            const rendererInfo = diag.rendererInfo || diag.renderer || '';
            const backendOk =
              requestedGlMode === 'gpu' ? /opengl|mesa|llvmpipe/i.test(rendererInfo) : /vulkan/i.test(rendererInfo);
            if (!backendOk) {
              throw new Error(
                `chromium GL mode "${requestedGlMode}" was not honoured — the player came up on "${rendererInfo}". ` +
                  'Refusing to render on an unexpected backend; fix the driver or use EXPLAINER_CHROMIUM_GL=default.'
              );
            }
            if (/swiftshader|llvmpipe|softpipe|software/i.test(rendererInfo)) {
              console.warn(
                `[render] WARN GL mode "${requestedGlMode}" is up, but the driver is a SOFTWARE rasterizer (${rendererInfo}) — ` +
                  'there is no hardware GPU acceleration on this host, so this is not faster than the default backend'
              );
            }
          }

          // Frame transfer mode: `raw` reads RGBA straight out of the canvas
          // (bottom-up for WebGL, flipped in ffmpeg) and skips PNG entirely.
          // Measured ~30% faster per frame than PNG screenshots on real GPUs
          // (see Docs/plan-explainer-video-style-and-webgl.md).
          //
          // On SOFTWARE GL (SwiftShader/llvmpipe) the readback path is what kills
          // the tab: 8.3 MB readPixels + an ~11 MB base64 hop per frame crashed the
          // renderer at frame ~60 on 2026-11-03, twice, on an idle 2-core box.
          // Playwright's native PNG screenshot never materialises those buffers.
          const softwareGl = /swiftshader|llvmpipe|software/i.test(diag.rendererInfo || '');
          const explicitFrameExport =
            params.frameExport ??
            (process.env.EXPLAINER_FRAME_EXPORT === 'png'
              ? 'png'
              : process.env.EXPLAINER_FRAME_EXPORT
                ? 'raw'
                : undefined);
          const frameMode: 'png' | 'raw' = explicitFrameExport ?? (softwareGl ? 'png' : 'raw');
          if (workerId === 1 && !explicitFrameExport && softwareGl) {
            console.log('[render] software GL detected → PNG frame export (raw readPixels crashes the tab)');
          }
          // WebGL readPixels is bottom-up; Canvas2D getImageData is top-down.
          const needsFlip = playerRenderer !== 'canvas2d';

          const prepareRenderPage = async () => {
            await workerPage!.evaluate(() => {
              document.documentElement.classList.add('render-mode');
              document.body.classList.add('render-mode');
              document.getElementById('hud')?.remove();
              document.getElementById('controls')?.remove();
            });
          };

          /**
           * Fresh render state: reload the tab, or recreate it when the renderer
           * process is gone (`Target crashed`). Used after a stalled frame and at
           * every chunk boundary, so a page-side leak can never accumulate across
           * a full 5000-frame render (2026-11-05: the tab died at frame ~3270 with
           * the host at 27 MB free).
           */
          const restartRenderPage = async (reason: string) => {
            console.log(`[render] restarting render tab (${reason})`);
            try {
              await workerPage!.reload({ waitUntil: 'load', timeout: 60_000 });
            } catch (reloadErr: any) {
              console.warn(`[render] WARN reload failed (${reloadErr?.message || reloadErr}) — recreating the tab`);
              if (workerPage !== initialPage) await workerPage!.close().catch(() => undefined);
              workerPage = await (sharedBrowser as any).newPage({ viewport: { width, height } });
              await workerPage!.goto(`${server.origin}/${playerHtmlFilename}?render=1`, {
                waitUntil: 'load',
                timeout: 60_000,
              });
            }
            await workerPage!.waitForFunction(
              'window.__explainerReady === true || window.__tutorialReady === true || window.__explainerError || window.__tutorialError',
              undefined,
              { timeout: 60_000 }
            );
            const restartErr = await workerPage!.evaluate(
              'window.__explainerError || window.__tutorialError || null'
            );
            if (restartErr) throw new Error(`explainer player failed to restart after a stalled frame: ${restartErr}`);
            await prepareRenderPage();
            framesOnPage = 0;
            recentFrameMs.length = 0;
          };

          await prepareRenderPage();

          // Recent per-frame wall times drive the adaptive frame ceiling below.
          const recentFrameMs: number[] = [];
          // Frames rendered on the current page instance (bounds memory growth).
          let framesOnPage = 0;

          while (taskIndex < chunkTasks.length) {
            const currentTask = chunkTasks[taskIndex++];
            if (!currentTask) break;

            const { startFrame, endFrame, chunkFilePath } = currentTask;
            // Encode into a `.part` file and rename on success: a renderer crash
            // used to leave a truncated chunk behind that auto-resume then trusted
            // (size > 10 KB, but no moov atom → corrupt final video).
            const partFilePath = `${chunkFilePath}.part`;

            // Check if already rendered (Auto-Resume)
            try {
              const stat = await fsp.stat(chunkFilePath);
              if (stat.size > 10_000) {
                overallRendered += (endFrame - startFrame);
                params.onProgress?.(overallRendered, totalFrames);
                continue;
              }
            } catch {}
            await fsp.rm(partFilePath, { force: true }).catch(() => undefined);

            // Bound page-side memory growth: every chunk starts on a fresh tab, so a
            // slow leak cannot accumulate across a 5000-frame render.
            if (framesOnPage >= CHUNK_SIZE) {
              await restartRenderPage(`${framesOnPage} frames rendered on one tab`);
            }

            let chunkFfmpeg: ReturnType<typeof spawn> | null = null;
            let chunkCommitted = false;

            try {
              const ffmpegPreset = params.preset || DEFAULT_ENCODE_PRESET;
              const inputArgs =
                frameMode === 'raw'
                  ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0']
                  : ['-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
              const filter = frameMode === 'raw' && needsFlip ? 'vflip,setsar=1/1' : 'setsar=1/1';
              chunkFfmpeg = spawn('ffmpeg', [
                '-y',
                ...inputArgs,
                '-vf', filter,
                '-aspect', '16:9',
                '-c:v', 'libx264',
                '-preset', ffmpegPreset,
                '-threads', '1',
                '-crf', String(params.crf ?? 20),
                '-pix_fmt', 'yuv420p',
                '-r', String(fps),
                // The output is a `.part` file (renamed on success), so the muxer
                // cannot be inferred from the extension.
                '-f', 'mp4',
                partFilePath,
              ]);

              const stdin = chunkFfmpeg.stdin!;
              const stderrChunks: Buffer[] = [];
              chunkFfmpeg.stderr?.on('data', (c) => stderrChunks.push(c));
              const chunkExit = new Promise<number>((resolve, reject) => {
                chunkFfmpeg!.once('error', reject);
                chunkFfmpeg!.once('close', (code) => resolve(code ?? 0));
              });
              stdin.on('error', () => undefined);

              const captureFrame = async (frame: number, timeoutMs: number): Promise<Buffer> => {
                const t = frame / fps;
                await workerPage!.evaluate((time: number) => {
                  const api = window.__explainer || window.__tutorial;
                  return api!.seek(time);
                }, t);
                if (frameMode === 'raw') {
                  const b64 = await workerPage!.evaluate(async () => {
                    const canvas = document.getElementById('stage') as HTMLCanvasElement;
                    const w = canvas.width;
                    const h = canvas.height;
                    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as
                      | WebGLRenderingContext
                      | null;
                    let bytes: Uint8Array;
                    if (gl) {
                      bytes = new Uint8Array(w * h * 4);
                      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
                    } else {
                      const ctx = canvas.getContext('2d')!;
                      bytes = new Uint8Array(ctx.getImageData(0, 0, w, h).data);
                    }
                    // Native base64 via Blob + FileReader. The previous
                    // String.fromCharCode concat built an ~11 MB rope per frame
                    // inside the renderer and was the main heap-churn source.
                    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
                    const dataUrl: string = await new Promise<string>((resolve, reject) => {
                      const fr = new FileReader();
                      fr.onload = () => resolve(String(fr.result));
                      fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
                      fr.readAsDataURL(blob);
                    });
                    return dataUrl.slice(dataUrl.indexOf(',') + 1);
                  });
                  return Buffer.from(b64, 'base64');
                }
                return await workerPage!.screenshot({ type: 'png', timeout: Math.max(5_000, timeoutMs) });
              };

              /** One frame against a ceiling; `frame: null` means it did not arrive in time. */
              const captureFrameWithin = async (
                frame: number,
                timeoutMs: number
              ): Promise<{ frame: Buffer | null; elapsedMs: number; crashed: boolean }> => {
                const startedAt = Date.now();
                const framePromise = captureFrame(frame, timeoutMs);
                // The loser of the race must not surface later as an unhandled
                // rejection (Playwright's screenshot keeps running after we stop waiting).
                framePromise.catch(() => undefined);
                try {
                  const frameBuffer = await Promise.race([
                    framePromise,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
                  ]);
                  return { frame: frameBuffer, elapsedMs: Date.now() - startedAt, crashed: false };
                } catch (err: any) {
                  const message = String(err?.message ?? err);
                  // A crashed/closed renderer is recoverable the same way a stall is:
                  // rebuild the tab and retry the frame. Playwright's own action
                  // timeouts (screenshot/fonts) are stalls too. Anything else is a bug.
                  if (/Target crashed|Target closed|Protocol error|Session closed|page has been closed/i.test(message)) {
                    return { frame: null, elapsedMs: Date.now() - startedAt, crashed: true };
                  }
                  if (/Timeout \d+ms exceeded|TimeoutError/i.test(message)) {
                    return { frame: null, elapsedMs: Date.now() - startedAt, crashed: false };
                  }
                  throw err;
                }
              };

              for (let frame = startFrame; frame < endFrame; frame++) {
                let frameTimeoutMs = adaptiveFrameTimeoutMs(FRAME_TIMEOUT_MS, recentFrameMs);
                let attempt = await captureFrameWithin(frame, frameTimeoutMs);

                if (!attempt.frame) {
                  // A stalled or crashed tab is usually swapped out, OOM-killed or
                  // wedged, not permanently dead: rebuild it and retry this one frame
                  // before aborting a render that may already be an hour in. A
                  // genuinely broken frame still fails — loudly, with the host state
                  // attached — on the second attempt.
                  const pressure = readSystemPressure();
                  console.warn(
                    `[render] WARN frame ${frame} ${attempt.crashed ? 'crashed the render tab' : `exceeded ${frameTimeoutMs} ms`} ` +
                      `(${describeSystemPressure(pressure)}) — restarting the tab and retrying once`
                  );
                  await restartRenderPage(`frame ${frame} ${attempt.crashed ? 'crashed' : 'stalled'}`);
                  frameTimeoutMs *= 2;
                  attempt = await captureFrameWithin(frame, frameTimeoutMs);
                  if (!attempt.frame) {
                    const now = readSystemPressure();
                    throw new Error(
                      `Single frame ${frame} render failed twice ` +
                        `(${Math.round(frameTimeoutMs / 2000)}s + ${Math.round(frameTimeoutMs / 1000)}s, ` +
                        `${attempt.crashed ? 'tab crashed again' : 'still no frame'}) ` +
                        `(concurrency ${CONCURRENCY}, ${cpuCount} CPUs) · ${describeSystemPressure(now)}`
                    );
                  }
                  console.warn(`[render] WARN frame ${frame} recovered after tab restart in ${attempt.elapsedMs} ms`);
                }

                const frameDone = attempt.frame;
                recentFrameMs.push(attempt.elapsedMs);
                if (recentFrameMs.length > 30) recentFrameMs.shift();
                framesOnPage++;

                await new Promise<void>((resolve, reject) => {
                  stdin.write(frameDone, (err) => (err ? reject(err) : resolve()));
                });

                overallRendered++;
                const elapsedSec = (Date.now() - renderStartedAt) / 1000;
                const perFrame = overallRendered > 0 ? elapsedSec / overallRendered : 0;
                const etaSec = Math.max(0, Math.round(perFrame * (totalFrames - overallRendered)));
                if (overallRendered % 30 === 0 || overallRendered === totalFrames) {
                  console.log(
                    `[render] ${overallRendered}/${totalFrames} frames · ${perFrame.toFixed(2)} s/frame · ETA ${Math.floor(
                      etaSec / 60
                    )}m${String(etaSec % 60).padStart(2, '0')}s`
                  );
                }
                params.onProgress?.(overallRendered, totalFrames);
              }

              stdin.end();
              const code = await chunkExit;
              if (code !== 0) {
                throw new Error(`ffmpeg chunk encode failed (${code}): ${Buffer.concat(stderrChunks).toString('utf8').slice(-400)}`);
              }
              await fsp.rename(partFilePath, chunkFilePath);
              chunkCommitted = true;
            } finally {
              if (chunkFfmpeg && !chunkFfmpeg.killed) {
                chunkFfmpeg.kill('SIGKILL');
              }
              if (!chunkCommitted) {
                await fsp.rm(partFilePath, { force: true }).catch(() => undefined);
              }
            }
          }
        } finally {
          if (workerPage && workerPage !== initialPage) {
            await workerPage.close().catch(() => undefined);
          }
        }
      };

      // Run parallel workers concurrently using tabs in the shared browser
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, idx) => renderChunkWorker(idx + 1))
      );
    } finally {
      if (sharedBrowser) {
        await sharedBrowser.close().catch(() => undefined);
      }
      await fsp.rm(sharedProfileDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // Merge all chunks with concat demuxer (lossless and instantaneous)
    const concatListPath = path.join(chunkDir, 'concat-list.txt');
    const concatContent = chunkFiles.map((f) => `file '${f}'`).join('\n');
    await fsp.writeFile(concatListPath, concatContent, 'utf8');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      silentVideoPath,
    ]);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      silentVideoPath,
      '-i',
      narrationWavPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outVideoPath,
    ]);

    // Chunks are scratch data: keep them only when explicitly requested for
    // debugging (EXPLAINER_KEEP_CHUNKS=1), otherwise delete (~63MB per run).
    if (process.env.EXPLAINER_KEEP_CHUNKS !== '1' && process.env.TUTORIAL_KEEP_CHUNKS !== '1') {
      await fsp.rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`[render] kept render chunks (EXPLAINER_KEEP_CHUNKS=1): ${chunkDir}`);
    }

    return {
      videoPath: outVideoPath,
      silentVideoPath,
      framesRendered: overallRendered,
      totalFrames,
      durationSec: timeline.totalDurationSec,
      engine,
    };
  } finally {
    await server.close();
  }
}

export const renderTutorialVideo = renderExplainerVideo;
