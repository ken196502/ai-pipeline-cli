/**
 * Headless frame-by-frame rendering of the explainer player.
 *
 * A local static server hosts the explainer bundle, a headless browser opens the
 * player in render mode, and every frame is painted deterministically via
 * `window.__explainer.seek(t)` and captured as a PNG streamed into ffmpeg's
 * image2pipe encoder. The encoded silent video is then muxed with the edge-tts
 * narration track.
 *
 * Browser engine (final video rendering stage runs on the LOCAL Firefox):
 *   - `firefox` (default): system Firefox via Playwright's WebDriver BiDi
 *     transport (`channel: 'moz-firefox'`). On Ubuntu the Firefox package is a
 *     snap with strict confinement, so the persistent render profile must live
 *     under `~/snap/firefox/common/` — /tmp profiles are rejected with
 *     "Could not find profile folder".
 *   - `chromium`: the project's Ungoogled Chromium via an explicit
 *     `browserPath` (or the auto-detected path), matching the legacy behavior.
 *
 * The engine is explicit — there is no silent cross-engine fallback. Set
 * `EXPLAINER_RENDER_ENGINE=chromium` (or pass `engine`) to leave Firefox.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { resolveChromiumPath } from '../browser/installer.js';

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
    return path.join(snapCommon, 'xhot-render', 'profile');
  }
  return path.join(os.tmpdir(), 'xhot-render-firefox-profile');
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
 * Defaults to the LOCAL Firefox (`engine: 'firefox'`, overridable via
 * EXPLAINER_RENDER_ENGINE). Pass `engine: 'chromium'` (with an optional
 * `browserPath`) for the legacy Chromium path. Failures surface loudly on the
 * requested engine — never a silent engine switch.
 */
export async function launchRenderBrowser(
  params: LaunchRenderBrowserParams
): Promise<LaunchRenderBrowserResult> {
  const envEngine = process.env.EXPLAINER_RENDER_ENGINE || process.env.TUTORIAL_RENDER_ENGINE;
  const explicitEngine =
    params.engine ?? (envEngine === 'firefox' || envEngine === 'chromium' ? envEngine : undefined);

  // Default is 'firefox'. Overridable via EXPLAINER_RENDER_ENGINE or explicit param.
  const engine: ExplainerRenderEngine = explicitEngine ?? 'firefox';

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

    const customFfPath =
      process.env.FIREFOX_PATH ||
      process.env.EXPLAINER_RENDER_FIREFOX_PATH ||
      process.env.TUTORIAL_RENDER_FIREFOX_PATH ||
      (fs.existsSync('/home/piagent/.cache/ms-playwright/firefox-1555/firefox/firefox')
        ? '/home/piagent/.cache/ms-playwright/firefox-1555/firefox/firefox'
        : undefined);

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
    ],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setViewportSize({ width, height });
  return { browser, page, engine, executablePath };
}

export interface RenderExplainerVideoParams {
  /** Explainer bundle directory containing explainer-player.html and assets. */
  explainerDir: string;
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
  crf?: number;
  preset?: string;
  logFilePath?: string;
  onProgress?: (renderedFrames: number, totalFrames: number) => void;
}
export type RenderTutorialVideoParams = RenderExplainerVideoParams & { tutorialDir?: string };

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
  return Math.max(1, Math.min(2, Math.floor((cpuCount || 2) / 2)));
}

/**
 * Per-frame ceiling for `evaluate(seek) + screenshot`. This is a runaway guard, not
 * the expected cost; override with EXPLAINER_FRAME_TIMEOUT_MS.
 */
export function resolveFrameTimeoutMs(override?: number): number {
  return override !== undefined && Number.isFinite(override) && override > 0 ? Math.floor(override) : 30_000;
}

/**
 * Renders the player frame-by-frame into a video and muxes the narration track.
 */
export async function renderExplainerVideo(
  params: RenderExplainerVideoParams | (RenderTutorialVideoParams & { tutorialDir?: string })
): Promise<RenderExplainerVideoResult> {
  const explainerDir = (params as any).explainerDir || (params as any).tutorialDir;
  const { timeline, narrationWavPath, outVideoPath } = params;
  const { width, height } = timeline.resolution;
  const fps = timeline.fps;
  const totalFrames = Math.max(1, Math.round(timeline.totalDurationSec * fps));
  const silentVideoPath = path.join(path.dirname(outVideoPath), 'explainer-silent.mp4');

  await fsp.mkdir(path.dirname(outVideoPath), { recursive: true });

  const chunkDir = path.join(path.dirname(outVideoPath), '.render-chunks');
  await fsp.mkdir(chunkDir, { recursive: true });

  const server = await serveExplainerDir(explainerDir);
  const CHUNK_SIZE = 1000; // 1000 frames (~33s) per segment with fresh browser connection

  try {
    const envEngine = process.env.EXPLAINER_RENDER_ENGINE || process.env.TUTORIAL_RENDER_ENGINE;
    const engine = params.engine ?? (envEngine === 'firefox' || envEngine === 'chromium' ? envEngine : 'firefox');

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

    const cpuCount = os.cpus()?.length || 2;
    const concurrencyEnv = process.env.EXPLAINER_RENDER_CONCURRENCY || process.env.TUTORIAL_RENDER_CONCURRENCY;
    const CONCURRENCY = resolveRenderConcurrency(cpuCount, Number(concurrencyEnv));
    const frameTimeoutEnv = process.env.EXPLAINER_FRAME_TIMEOUT_MS || process.env.TUTORIAL_FRAME_TIMEOUT_MS;
    const FRAME_TIMEOUT_MS = resolveFrameTimeoutMs(Number(frameTimeoutEnv));
    let taskIndex = 0;

    // Detect player HTML filename in bundle
    const hasExplainerHtml = fs.existsSync(path.join(explainerDir, 'explainer-player.html'));
    const playerHtmlFilename = hasExplainerHtml ? 'explainer-player.html' : 'tutorial-player.html';

    const renderChunkWorker = async (workerId: number): Promise<void> => {
      while (taskIndex < chunkTasks.length) {
        const currentTask = chunkTasks[taskIndex++];
        if (!currentTask) break;

        const { startFrame, endFrame, chunkFilePath } = currentTask;

        // Check if already rendered (Auto-Resume)
        try {
          const stat = await fsp.stat(chunkFilePath);
          if (stat.size > 10_000) {
            overallRendered += (endFrame - startFrame);
            params.onProgress?.(overallRendered, totalFrames);
            continue;
          }
        } catch {}

        const workerProfileDir = path.join(os.tmpdir(), `xhot-render-ff-w${workerId}-${Date.now()}`);
        await fsp.mkdir(workerProfileDir, { recursive: true });

        let chunkBrowser: Browser | BrowserContext | null = null;
        let chunkFfmpeg: ReturnType<typeof spawn> | null = null;

        try {
          const launched = await launchRenderBrowser({
            engine,
            browserPath: engine === 'chromium' ? params.browserPath : undefined,
            width,
            height,
            profileDir: workerProfileDir,
          });
          chunkBrowser = launched.browser;
          const page = launched.page;

          await page.goto(`${server.origin}/${playerHtmlFilename}?render=1`, { waitUntil: 'load', timeout: 60_000 });
          await page.waitForFunction(
            'window.__explainerReady === true || window.__tutorialReady === true || window.__explainerError || window.__tutorialError',
            undefined,
            { timeout: 60_000 }
          );

          const bootErr = await page.evaluate('window.__explainerError || window.__tutorialError || null');
          if (bootErr) throw new Error(`explainer player failed to boot: ${bootErr}`);

          await page.evaluate(() => {
            document.documentElement.classList.add('render-mode');
            document.body.classList.add('render-mode');
            document.getElementById('hud')?.remove();
            document.getElementById('controls')?.remove();
          });

          chunkFfmpeg = spawn('ffmpeg', [
            '-y',
            '-f', 'image2pipe',
            '-framerate', String(fps),
            '-i', 'pipe:0',
            '-vf', 'setsar=1/1',
            '-aspect', '16:9',
            '-c:v', 'libx264',
            '-preset', params.preset || 'fast',
            '-crf', String(params.crf ?? 20),
            '-pix_fmt', 'yuv420p',
            '-r', String(fps),
            chunkFilePath,
          ]);

          const stdin = chunkFfmpeg.stdin!;
          const stderrChunks: Buffer[] = [];
          chunkFfmpeg.stderr?.on('data', (c) => stderrChunks.push(c));
          const chunkExit = new Promise<number>((resolve, reject) => {
            chunkFfmpeg!.once('error', reject);
            chunkFfmpeg!.once('close', (code) => resolve(code ?? 0));
          });
          stdin.on('error', () => undefined);

          for (let frame = startFrame; frame < endFrame; frame++) {
            const t = frame / fps;

            const frameDone = await Promise.race([
              (async () => {
                await page.evaluate((time: number) => {
                  const api = window.__explainer || window.__tutorial;
                  return api!.seek(time);
                }, t);
                return await page.screenshot({ type: 'png' });
              })(),
              new Promise<null>((r) => setTimeout(() => r(null), FRAME_TIMEOUT_MS)),
            ]);

            if (!frameDone) {
              throw new Error(
                `Single frame ${frame} render timed out after ${Math.round(FRAME_TIMEOUT_MS / 1000)}s ` +
                  `(concurrency ${CONCURRENCY}, ${cpuCount} CPUs)`
              );
            }

            await new Promise<void>((resolve, reject) => {
              stdin.write(frameDone, (err) => (err ? reject(err) : resolve()));
            });

            overallRendered++;
            params.onProgress?.(overallRendered, totalFrames);
          }

          stdin.end();
          const code = await chunkExit;
          if (code !== 0) {
            throw new Error(`ffmpeg chunk encode failed (${code}): ${Buffer.concat(stderrChunks).toString('utf8').slice(-400)}`);
          }
        } finally {
          if (chunkFfmpeg && !chunkFfmpeg.killed) {
            chunkFfmpeg.kill('SIGKILL');
          }
          if (chunkBrowser) {
            await chunkBrowser.close().catch(() => undefined);
          }
          await fsp.rm(workerProfileDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    };

    // Run parallel workers concurrently
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, idx) => renderChunkWorker(idx + 1))
    );

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
