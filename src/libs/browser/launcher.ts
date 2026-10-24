/**
 * Chromium Launcher with Persistent Profile, Extension Loading, and Anti-Bot Protections.
 *
 * Implemented over playwright-core. The driven browser is still the same
 * Ungoogled Chromium with the same persistent profile directory, session
 * reuse file and detached keep-alive semantics as the puppeteer version.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import pc from 'picocolors';
import { resolveChromiumPath } from './installer.js';
import { ensureLoopbackNoProxy, listBrowserPages } from './cdp.js';
import {
  clearSessionInfo,
  findAvailablePort,
  isPidAlive,
  isSessionAlive,
  spawnDetachedChromium,
} from './session.js';
import type { BrowserLaunchOptions } from './types.js';
import { getActiveRunLogger } from '../../utils/logger.js';
import { resolveProfileDir, getProjectRootDir } from '../../utils/browser.js';

/** Reads a process cmdline from /proc; returns null when unavailable. */
async function readProcessCmdline(pid: number): Promise<string | null> {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf-8')).replace(/\0/g, ' ');
  } catch {
    return null;
  }
}

/**
 * Restarts a headless keep-alive session so an explicitly headful request
 * (interactive login/refresh flows) gets a real window. A headful Chromium
 * cannot share the profile singleton with a running headless instance, and
 * silently reusing the headless one leaves the user with no visible browser.
 */
async function terminateHeadlessSessionForHeadfulRequest(
  pid: number,
  profileDir: string,
): Promise<void> {
  console.warn(
    pc.yellow(
      `[browser] Existing session (pid ${pid}) is headless; headful window requested — restarting browser...`
    )
  );
  const runLogger = getActiveRunLogger();
  runLogger?.warn('Restarting headless browser session to open a headful window', { pid });
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 25 && isPidAlive(pid); i += 1) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await clearSessionInfo(profileDir);
}

/** Hydrates browser cookies from cookies.txt via CDP to guarantee session persistence. */
async function hydrateCookiesFromDisk(page: Page): Promise<void> {
  try {
    const cookiePath = path.join(getProjectRootDir(), 'cookies.txt');
    const content = await fs.readFile(cookiePath, 'utf-8').catch(() => null);
    if (!content) return;

    const { parseNetscapeCookies } = await import('../../utils/cookies.js');
    const { createCDPSession, setCookiesViaCDP } = await import('./cdp.js');
    const parsed = parseNetscapeCookies(content);
    if (parsed.length === 0) return;
    const client = await createCDPSession(page);
    const cdpCookies = parsed
      .filter((c) => {
        const d = (c.domain || '').toLowerCase();
        // ONLY hydrate YouTube domains from cookies.txt. Never contaminate Flow or accounts.google.com!
        return d.includes('youtube.com') || d.includes('googlevideo.com') || d.includes('ytimg.com');
      })
      .map((c) => {
      const isHost = c.name.startsWith('__Host-');
      const domain = c.domain;
      const cookie: any = {
        name: c.name,
        value: c.value,
        path: c.path || '/',
        expires: c.expires > 0 ? c.expires : undefined,
        httpOnly: c.httpOnly,
        secure: c.secure,
      };
      if (isHost) {
        cookie.url = 'https://' + c.domain.replace(/^\./, '');
      } else {
        cookie.domain = domain;
      }
      return cookie;
    });
    await setCookiesViaCDP(client, cdpCookies);
    await client.detach().catch(() => {});
  } catch {}
}

export interface LaunchBrowserResult {
  browser: Browser;
  /** The browser context that owns `page` (default context when reusing a session). */
  context: BrowserContext;
  page: Page;
  executablePath: string;
  userDataDir: string;
  remoteDebuggingPort?: number;
  reused?: boolean;
}

/**
 * Legacy default viewport. Not used by Flow automation — Flow always uses
 * detected screen size (via xrandr/xdpyinfo) or the conservative 1600×900
 * fallback. Kept for backward compatibility with external callers.
 */
export const DEFAULT_VIEWPORT = { width: 1600, height: 900 };

/**
 * Live CSS viewport vs window-bounds divergence (px) that indicates a stale
 * `Emulation.setDeviceMetricsOverride`.
 *
 * Normal browser chrome (toolbars, tab strip) accounts for roughly 130 px of
 * outer-vs-inner difference; anything far beyond that means the page is
 * rendering an emulated viewport (Puppeteer's 800x600 default, DevTools device
 * mode, …) instead of the real window.
 */
export const STALE_EMULATION_DIVERGENCE_PX = 250;

const execFileAsync = promisify(execFile);

/**
 * Detects the real screen size of the attached display.
 * A window larger than the screen (content rendered off-screen) is a strong
 * automation tell: window.outerWidth/outerHeight would exceed
 * screen.availWidth/availHeight, which never happens for real users.
 */
export async function detectScreenSize(): Promise<{ width: number; height: number } | null> {
  const displayEnv = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
  try {
    const { stdout } = await execFileAsync('xrandr', [], { timeout: 5000, env: displayEnv });
    const m = stdout.match(/current\s+(\d+)\s+x\s+(\d+)/);
    if (m) {
      return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
    }
  } catch {
    // xrandr unavailable — try xdpyinfo
  }
  try {
    const { stdout } = await execFileAsync('xdpyinfo', [], { timeout: 5000, env: displayEnv });
    const m = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
    if (m) {
      return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
    }
  } catch {
    // no display info available
  }
  return null;
}

/**
 * Parses viewport specification from string (e.g. "1920x1080", "1280,720"), null, or object.
 * Returns null if string is 'null', 'none', or 'window' (meaning no viewport emulation).
 */
export function parseViewport(
  input?: string | { width: number; height: number } | null
): { width: number; height: number } | null | undefined {
  if (input === null) return null;
  if (input === undefined) return undefined;
  if (typeof input === 'object') {
    if (typeof input.width === 'number' && typeof input.height === 'number') {
      return { width: input.width, height: input.height };
    }
    return undefined;
  }
  const trimmed = String(input).trim().toLowerCase();
  if (trimmed === 'null' || trimmed === 'none' || trimmed === 'window' || trimmed === 'full') {
    return null;
  }
  const match = trimmed.match(/^(\d+)\s*[xX,]\s*(\d+)$/);
  if (match) {
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  return undefined;
}

/**
 * Resolves the effective viewport:
 * 1. options.viewport (if explicitly specified, including null)
 * 2. process.env.BROWSER_VIEWPORT or process.env.BROWSER_RESOLUTION (if set)
 * 3. null — native window size (window maximized to system screen without fixed emulation).
 */
export function resolveEffectiveViewport(
  optionsViewport?: { width: number; height: number } | null
): { width: number; height: number } | null {
  if (optionsViewport !== undefined) {
    return optionsViewport;
  }
  const envViewport = process.env.BROWSER_VIEWPORT || process.env.BROWSER_RESOLUTION;
  if (envViewport) {
    const parsed = parseViewport(envViewport);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return null;
}

export interface WindowGeometryTarget {
  headless?: boolean | 'shell';
  width?: number;
  height?: number;
}

/**
 * Pure predicate: does the window's current geometry already satisfy the target?
 *
 * Re-sending `Browser.setWindowBounds` for a window that is already at the
 * target size still produces window geometry churn mid-session — a behavioral
 * signal that trips Google risk analysis right before prompt entry. Callers
 * must skip the CDP write when this returns true.
 *
 * IMPORTANT: we always compare explicit width/height dimensions — never trust
 * `windowState: 'maximized'` alone. On Xvfb/VNC setups, 'maximized' fills the
 * virtual screen's native resolution (e.g. 1920x1080), which may exceed the
 * xrandr-reported screen size (e.g. 1600x900). This mismatch causes
 * `window.innerWidth/innerHeight` to jump to the native resolution, tripping
 * Google's client-side anti-abuse telemetry.
 */
export function isWindowGeometrySatisfied(
  currentBounds: { width?: number; height?: number; windowState?: string } | null | undefined,
  target: WindowGeometryTarget
): boolean {
  if (!currentBounds) return false;
  if (typeof target.width !== 'number' || typeof target.height !== 'number') return false;
  // Allow ±2 px tolerance for window manager rounding / WM frame borders.
  const wOk = typeof currentBounds.width === 'number' && Math.abs(currentBounds.width - target.width) <= 2;
  const hOk = typeof currentBounds.height === 'number' && Math.abs(currentBounds.height - target.height) <= 2;
  return wOk && hOk;
}

/**
 * Monitors and logs window resize events inside the browser page so any
 * geometry churn is visibly recorded in the logs.
 */
export async function attachWindowResizeMonitor(page: Page): Promise<void> {
  const listenerScript = () => {
    if ((window as any).__windowResizeMonitorAttached) return;
    (window as any).__windowResizeMonitorAttached = true;
    let prevW = window.innerWidth;
    let prevH = window.innerHeight;
    window.addEventListener('resize', () => {
      const curW = window.innerWidth;
      const curH = window.innerHeight;
      // YouTube's own scripts synthetically dispatch window 'resize' events
      // constantly (scroll-triggered lazy loading, layout recalcs, player init).
      // These carry unchanged dimensions and are harmless noise — only report
      // events where the geometry actually changed (real churn that could trip
      // Google's client-side anti-abuse telemetry).
      if (curW === prevW && curH === prevH) return;
      console.warn(
        `[WINDOW_RESIZE_EVENT] ${prevW}x${prevH} -> ${curW}x${curH} ` +
        `(outer: ${window.outerWidth}x${window.outerHeight}, screen: ${screen.width}x${screen.height})`
      );
      prevW = curW;
      prevH = curH;
    });
  };

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[WINDOW_RESIZE_EVENT]')) {
      console.warn(pc.yellow(`[browser:resize] ⚠ ${text}`));
      getActiveRunLogger()?.warn(`[browser:resize] ⚠ ${text}`);
    }
  });

  await page.addInitScript(listenerScript).catch(() => {});
  await Promise.race([
    page.evaluate(listenerScript).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/**
 * Applies viewport emulation only when it actually differs from the current
 * rendering size.
 *
 * Playwright re-sends `Emulation.setDeviceMetricsOverride` on every
 * `page.setViewportSize()` call (and on every reconnect when `viewport` is
 * set), which fires window `resize` events even for identical dimensions.
 * Repeated no-op viewport re-applications before prompt entry are a Google
 * risk-control trigger, so identical geometry must never be re-applied.
 */
export async function applyViewportIfChanged(
  page: Page,
  viewport: { width: number; height: number }
): Promise<void> {
  const current = page.viewportSize();
  if (current && current.width === viewport.width && current.height === viewport.height) {
    return;
  }

  const live = await page
    .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    .catch(() => null);

  if (!current && live && live.width === viewport.width && live.height === viewport.height) {
    console.log(
      pc.gray(`[browser] Page already renders at ${viewport.width}x${viewport.height} — skipping viewport emulation`)
    );
    return;
  }

  console.log(
    pc.cyan(
      `[browser] Applying viewport emulation: ${viewport.width}x${viewport.height} (previously: ${current ? `${current.width}x${current.height}` : `live ${live?.width}x${live?.height}`})`
    )
  );
  getActiveRunLogger()?.info(`[browser] Applying viewport emulation: ${viewport.width}x${viewport.height}`);
  await page.setViewportSize(viewport);
}

/**
 * Maximizes or resizes the browser window to match the actual display before page navigation.
 * - Headed mode: asks the window manager to maximize (windowState: 'maximized').
 * - Headless mode: resizes window bounds to the detected screen size (e.g. 1600x900).
 *
 * Idempotent: when the window is already maximized (headed) or already at the
 * target size (headless), no window-geometry CDP command is sent at all.
 */
export async function maximizeBrowserWindow(
  page: Page,
  options: { headless?: boolean | 'shell'; screenSize?: { width: number; height: number } | null } = {}
): Promise<{ width: number; height: number }> {
  const client = await page.context().newCDPSession(page).catch(() => null);
  if (!client) {
    return await page
      .evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      .catch(() => ({ width: 1600, height: 900 }));
  }

  let geometryChanged = false;

  try {
    const { windowId } = await client.send('Browser.getWindowForTarget');
    const targetWidth = options.screenSize?.width ?? 1600;
    const targetHeight = options.screenSize?.height ?? 900;

    let currentBounds: { width?: number; height?: number; windowState?: string } | null = null;
    try {
      const boundsResult = await client.send('Browser.getWindowBounds', { windowId });
      currentBounds = (boundsResult as { bounds?: { width?: number; height?: number; windowState?: string } })
        ?.bounds ?? null;
    } catch {
      // Older Chromium without Browser.getWindowBounds — fall through and apply.
    }

    if (
      isWindowGeometrySatisfied(currentBounds, {
        headless: options.headless,
        width: targetWidth,
        height: targetHeight,
      })
    ) {
      const msg = `[browser] Window geometry already correct (${currentBounds?.width}x${currentBounds?.height}, state: "${currentBounds?.windowState}") — skipping resize`;
      console.log(pc.gray(msg));
      getActiveRunLogger()?.info(msg);
    } else {
      const msg = `[browser] Adjusting window bounds: current=${currentBounds?.width}x${currentBounds?.height} (state: "${currentBounds?.windowState}"), target=${targetWidth}x${targetHeight}`;
      console.log(pc.cyan(msg));
      getActiveRunLogger()?.info(msg);
      // ALWAYS use explicit width × height bounds — NEVER `windowState: 'maximized'`.
      // On Xvfb/VNC setups, 'maximized' fills the virtual screen's native resolution
      // (e.g. 1920x1080), which may differ from the xrandr-reported resolution
      // (e.g. 1600x900). This mismatch causes `window.innerWidth/innerHeight` to
      // jump to 1920x1080, tripping Google's client-side anti-abuse telemetry.
      //
      // First un-maximize the window (if maximized) so that explicit bounds take
      // effect — a maximized window ignores setWindowBounds width/height.
      const currentState = String(currentBounds?.windowState || '').toLowerCase();
      if (currentState === 'maximized' || currentState === 'fullscreen') {
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
        await new Promise((r) => setTimeout(r, 100));
      }

      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 0, top: 0, width: targetWidth, height: targetHeight },
      });
      geometryChanged = true;
    }

    // Clear leftover viewport emulation when it is actually active.
    //
    // `page.viewportSize()` bookkeeping is per-connection: an
    // `Emulation.setDeviceMetricsOverride` applied by an earlier connection or
    // an external tool survives a reconnect while the fresh `Page` wrapper
    // reports `viewportSize() === null`. The reliable signal is therefore the LIVE
    // CSS viewport vs the real window bounds: a stale override (e.g.
    // Playwright's/Puppeteer's 800x600 default) makes innerWidth/innerHeight
    // diverge from the window by far more than browser chrome
    // (STALE_EMULATION_DIVERGENCE_PX).
    // Clearing an absent override forces a pointless relayout (resize signal)
    // on every reconnect, so only clear on evidence.
    //
    // SAFETY NET: if `page.evaluate()` fails (page navigating, destroyed context,
    // network hiccup), liveViewport is null and staleEmulation would silently be
    // false — leaving 800x600 emulation active for the entire run.  Retry once;
    // if still null, assume stale emulation exists and clear it (the cost of one
    // extra resize event is far smaller than rendering the whole pipeline at 800x600).
    let liveViewport = await page
      .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      .catch(() => null);
    if (!liveViewport) {
      await new Promise((r) => setTimeout(r, 500));
      liveViewport = await page
        .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
        .catch(() => null);
    }
    const boundsWidth = currentBounds?.width ?? targetWidth;
    const boundsHeight = currentBounds?.height ?? targetHeight;
    const staleEmulation =
      !!liveViewport &&
      (boundsWidth - liveViewport.w > STALE_EMULATION_DIVERGENCE_PX ||
        boundsHeight - liveViewport.h > STALE_EMULATION_DIVERGENCE_PX);
    // When the evaluate failed both times, the live viewport is unknown — but
    // leaving a potential 800x600 emulation unchecked is the worse outcome.
    // Clear unconditionally (one extra relayout is acceptable).
    const assumeStale = !liveViewport && !page.viewportSize();
    if (page.viewportSize() || staleEmulation || assumeStale) {
      const reason = page.viewportSize()
        ? `page.viewportSize() reports ${page.viewportSize()!.width}x${page.viewportSize()!.height}`
        : staleEmulation
          ? `page renders ${liveViewport!.w}x${liveViewport!.h} inside a ${boundsWidth}x${boundsHeight} window`
          : `page.evaluate() failed — cannot read live viewport; clearing defensively`;
      const msg = `[browser] Clearing stale viewport emulation (${reason})`;
      console.warn(pc.yellow(msg));
      getActiveRunLogger()?.warn(msg);
      await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      geometryChanged = true;

      // POST-CLEAR VERIFICATION: re-read the live viewport after clearing and
      // confirm it now matches the window bounds. If it doesn't, something else
      // is re-applying emulation (or the clear had no effect).
      await new Promise((r) => setTimeout(r, 300));
      const postClear = await page
        .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
        .catch(() => null);
      if (postClear) {
        const widthOk = Math.abs(boundsWidth - postClear.w) <= STALE_EMULATION_DIVERGENCE_PX;
        const heightOk = Math.abs(boundsHeight - postClear.h) <= STALE_EMULATION_DIVERGENCE_PX;
        if (widthOk && heightOk) {
          const okMsg = `[browser] ✓ Viewport emulation cleared — page now renders at ${postClear.w}x${postClear.h}`;
          console.log(pc.green(okMsg));
          getActiveRunLogger()?.info(okMsg);
        } else {
          const warnMsg =
            `[browser] ⚠ Viewport emulation clear may not have taken effect: ` +
            `page still renders ${postClear.w}x${postClear.h} inside a ${boundsWidth}x${boundsHeight} window — setting explicit bounds override`;
          console.warn(pc.yellow(warnMsg));
          getActiveRunLogger()?.warn(warnMsg);
          // Set explicit override matching window bounds so the page never renders at 800x600
          await client.send('Emulation.setDeviceMetricsOverride', {
            width: boundsWidth,
            height: boundsHeight,
            deviceScaleFactor: 1,
            mobile: false,
          }).catch(() => {});
        }
      }
    }

    // Allow window manager or headless compositor a brief tick to apply the new
    // geometry — only when geometry actually changed.
    if (geometryChanged) {
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err: any) {
    console.warn(pc.yellow(`[browser] Notice maximizing window: ${err.message}`));
  } finally {
    await client.detach().catch(() => {});
  }

  const dimensions = await page
    .evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    .catch(() => ({ width: 1600, height: 900 }));

  // Warn loudly if the actual rendering size exceeds the intended screen
  // dimensions — this is exactly the discrepancy that triggers Google risk
  // control (e.g. Xvfb native 1920x1080 vs xrandr-reported 1600x900).
  const targetWidth = options.screenSize?.width ?? 1600;
  const targetHeight = options.screenSize?.height ?? 900;
  if (dimensions.width > targetWidth + 5 || dimensions.height > targetHeight + 5) {
    console.warn(
      pc.yellow(
        `[browser] ⚠ RESOLUTION MISMATCH: window renders at ${dimensions.width}x${dimensions.height} ` +
        `but screen target is ${targetWidth}x${targetHeight}. ` +
        `This exceeds the physical screen and WILL trigger Google risk control. ` +
        `Check your Xvfb/VNC display resolution.`
      )
    );
  }

  return dimensions;
}

/**
 * Prepares Chrome command line arguments for extension loading.
 */
export async function buildExtensionArgs(extensionPaths: string[] = []): Promise<string[]> {
  const validPaths: string[] = [];

  for (const extPath of extensionPaths) {
    const resolved = path.resolve(extPath);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        validPaths.push(resolved);
      } else {
        console.warn(pc.yellow(`[browser] Extension path is not a directory: ${resolved}`));
      }
    } catch {
      console.warn(pc.yellow(`[browser] Extension directory not found: ${resolved}`));
    }
  }

  if (validPaths.length === 0) {
    return [];
  }

  const joined = validPaths.join(',');
  return [`--load-extension=${joined}`, `--disable-extensions-except=${joined}`];
}

/** Runtime support for serialized TypeScript callbacks; independent of browser identity. */
export async function installEvaluationHelpers(page: Page): Promise<void> {
  // Polyfill for esbuild's __name helper (esbuild >=0.28 injects __name(fn, "name")
  // wrappers around named function expressions; when these appear inside
  // page.evaluate() closures, the driver serializes them to the browser context
  // where __name doesn't exist → ReferenceError). This no-op shim makes them safe.
  const esbuildNamePolyfill = () => {
    if (typeof (globalThis as any).__name === 'undefined') {
      (globalThis as any).__name = (target: any, _value: any) => target;
    }
  };
  await page.addInitScript(esbuildNamePolyfill).catch(() => {});
  await Promise.race([
    page.evaluate(esbuildNamePolyfill).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/**
 * Injects anti-bot evasions into a Playwright Page.
 */
export async function applyStealthEvasions(page: Page): Promise<void> {
  await installEvaluationHelpers(page);

  const evasionScript = () => {
    // 1. Delete navigator.webdriver from Navigator.prototype and instance
    try {
      delete (Object.getPrototypeOf(navigator) as any).webdriver;
    } catch {}
    try {
      delete (navigator as any).webdriver;
    } catch {}
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // 2. Emulate standard hardware concurrency & device memory
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
      configurable: true,
    });

    // 3. Emulate window.chrome runtime object
    if (!(window as any).chrome) {
      (window as any).chrome = {
        runtime: {},
        app: {},
        csi: () => {},
        loadTimes: () => {},
      };
    } else if (!(window as any).chrome.runtime) {
      (window as any).chrome.runtime = {};
    }

    // 4. Emulate languages
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });
    }

    // 5. Spoof WebGL unmasked vendor/renderer ONLY when the real renderer is a
    // software rasterizer (SwiftShader/llvmpipe) — claiming an NVIDIA/Direct3D
    // GPU on a Linux box is itself an inconsistency that betrays automation.


    const isSoftwareRenderer = (r: string) => /swiftshader|llvmpipe|software/i.test(r);
    const spoofVendor = 'Google Inc. (Intel)';
    const spoofRenderer =
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)';

    const patchContext = (proto: any) => {
      if (!proto || !proto.getParameter) return;
      const originalGetParameter = proto.getParameter;
      // Read the REAL unmasked values via the original getParameter (calling the
      // patched one here would recurse infinitely).
      const readUnmasked = (gl: any): { vendor: string; renderer: string } => {
        try {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            vendor: String((ext && originalGetParameter.call(gl, ext.UNMASKED_VENDOR_WEBGL)) || ''),
            renderer: String((ext && originalGetParameter.call(gl, ext.UNMASKED_RENDERER_WEBGL)) || ''),
          };
        } catch {
          return { vendor: '', renderer: '' };
        }
      };

      proto.getParameter = function (parameter: number) {
        // UNMASKED_VENDOR_WEBGL = 37445 (0x9245)
        if (parameter === 37445) {
          const real = readUnmasked(this);
          return isSoftwareRenderer(real.renderer) ? spoofVendor : real.vendor;
        }
        // UNMASKED_RENDERER_WEBGL = 37446 (0x9246)
        if (parameter === 37446) {
          const real = readUnmasked(this);
          return isSoftwareRenderer(real.renderer) ? spoofRenderer : real.renderer;
        }
        return originalGetParameter.apply(this, arguments as any);
      };
    };

    if (typeof WebGLRenderingContext !== 'undefined') {
      patchContext(WebGLRenderingContext.prototype);
    }
    if (typeof WebGL2RenderingContext !== 'undefined') {
      patchContext(WebGL2RenderingContext.prototype);
    }
  };

  await page.addInitScript(evasionScript).catch(() => {});
  await Promise.race([
    page.evaluate(evasionScript).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/**
 * Wires stealth/init/resize hooks into every page of the browser — including
 * pages created later. Playwright fires `context.on('page')` per context and
 * `browser.on('context')` for contexts created afterwards (the equivalent of
 * puppeteer's `targetcreated`).
 */
export function attachPageHooks(browser: Browser, stealth: boolean): void {
  const onPage = async (p: Page) => {
    if (stealth) {
      await applyStealthEvasions(p).catch(() => {});
    } else {
      await installEvaluationHelpers(p);
    }
    await attachWindowResizeMonitor(p).catch(() => {});
  };
  for (const context of browser.contexts()) {
    context.on('page', (p) => {
      void onPage(p);
    });
  }
  browser.on('context', (context) => {
    context.on('page', (p) => {
      void onPage(p);
    });
  });
}

/**
 * Launches a browser instance with persistent profile, anti-bot flags, and extension support.
 * Automatically checks for and reuses existing active browser sessions on the same profile.
 * Spawns detached Chromium by default so the browser window remains open after pipeline runs.
 */
export async function launchBrowser(
  options: BrowserLaunchOptions = {}
): Promise<LaunchBrowserResult> {
  const executablePath = await resolveChromiumPath(options.executablePath);
  const profileDir = resolveProfileDir(options.userDataDir || options.profileDir);
  const stealth = options.stealth !== false;
  const reuseSession = options.reuseSession !== false;
  const keepAlive = options.keepAlive !== false;

  const screenSize = await detectScreenSize();
  const effectiveViewport = resolveEffectiveViewport(options.viewport);

  await fs.mkdir(profileDir, { recursive: true });

  // 1. Check if an existing browser session is active for this profile
  if (reuseSession) {
    let sessionCheck = await isSessionAlive(profileDir);
    // An explicitly headful request (interactive login flows) must never be
    // silently attached to a headless keep-alive instance — the user would
    // see no window at all. Restart the headless session in that case.
    if (
      options.headless === false &&
      sessionCheck.alive &&
      sessionCheck.session?.pid &&
      (await readProcessCmdline(sessionCheck.session.pid))?.includes('--headless')
    ) {
      await terminateHeadlessSessionForHeadfulRequest(sessionCheck.session.pid, profileDir);
      sessionCheck = { alive: false };
    }
    if (sessionCheck.alive && sessionCheck.session) {
      const session = sessionCheck.session;
      console.log(
        pc.green(
          `[browser] Reusing existing browser session on port ${session.port} (profile: ${path.basename(profileDir)})`
        )
      );

      // NOTE: no viewport option on connect — Playwright only applies viewport
      // emulation when explicitly requested via setViewportSize(), so reconnecting
      // never re-sends Emulation.setDeviceMetricsOverride (under puppeteer,
      // defaultViewport was re-applied to every page object on reconnect, firing
      // window resize events before each prompt entry). Viewport is applied
      // explicitly and only when it actually differs (see below).
      ensureLoopbackNoProxy();
      const browser = await chromium.connectOverCDP({
        endpointURL: `http://127.0.0.1:${session.port}`,
        timeout: 300_000,
      });

      attachPageHooks(browser, stealth);

      const pages = listBrowserPages(browser);
      const defaultContext = browser.contexts()[0];
      let page: Page;
      let needsNavigation = false;

      // Helper to probe if a page target is alive and responsive to evaluation
      const isPageResponsive = async (p: Page): Promise<boolean> => {
        try {
          return await Promise.race([
            p.evaluate(() => true).then(() => true).catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
          ]);
        } catch {
          return false;
        }
      };

      if (options.url) {
        const matchingPage = pages.find((p) => {
          const u = p.url();
          if (u === options.url) return true;
          if (options.url && options.url.includes('flow.google.com') && u.includes('flow.google.com')) {
            return true;
          }
          return false;
        });

        if (matchingPage && (await isPageResponsive(matchingPage))) {
          page = matchingPage;
          if (options.url.includes('/project/')) {
            needsNavigation = !page.url().includes(options.url);
          } else if (page.url().includes('/about') && !options.url.includes('/about')) {
            needsNavigation = true;
          }
        } else {
          let healthyPage: Page | null = null;
          for (const candidate of pages) {
            if (await isPageResponsive(candidate)) {
              healthyPage = candidate;
              break;
            }
          }
          page = healthyPage || (await defaultContext.newPage());
          needsNavigation = true;
        }
      } else {
        let healthyPage: Page | null = null;
        for (const candidate of pages) {
          if (await isPageResponsive(candidate)) {
            healthyPage = candidate;
            break;
          }
        }
        page = healthyPage || (await defaultContext.newPage());
      }

      await page.bringToFront().catch(() => {});
      await attachWindowResizeMonitor(page).catch(() => {});

      // Window geometry is applied exactly once per launchBrowser() call, before
      // navigation, and is idempotent: an already-maximized window / an already
      // matching viewport is left completely untouched (repeated screen resizes
      // right before prompt entry trip Google risk control).
      if (effectiveViewport) {
        await applyViewportIfChanged(page, effectiveViewport).catch(() => {});
      } else {
        await maximizeBrowserWindow(page, { headless: options.headless, screenSize });
      }

      if (options.url && needsNavigation) {
        await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }

      if (stealth) {
        await applyStealthEvasions(page).catch(() => {});
      } else {
        await installEvaluationHelpers(page);
      }

      return {
        browser,
        context: page.context(),
        page,
        executablePath,
        userDataDir: profileDir,
        remoteDebuggingPort: session.port,
        reused: true,
      };
    }
  }

  // 2. Launch new browser (detached if keepAlive)
  const port = options.remoteDebuggingPort || (await findAvailablePort(9222, profileDir));

  const defaultArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ];

  // Window size matches real screen dimensions or custom viewport.
  // NEVER use --start-maximized: on Xvfb/VNC it fills the virtual screen's
  // native resolution (e.g. 1920x1080) even when xrandr reports a smaller
  // desktop (e.g. 1600x900). Use explicit --window-size + --window-position.
  const windowWidth = effectiveViewport?.width ?? screenSize?.width ?? 1600;
  const windowHeight = effectiveViewport?.height ?? screenSize?.height ?? 900;
  defaultArgs.push(`--window-size=${windowWidth},${windowHeight}`);
  defaultArgs.push('--window-position=0,0');
  console.log(
    pc.gray(
      `[browser] Window ${windowWidth}x${windowHeight}${screenSize ? ` (screen ${screenSize.width}x${screenSize.height})` : ''}${effectiveViewport ? `, viewport ${effectiveViewport.width}x${effectiveViewport.height}` : ', explicit bounds (no emulation)'}`
    )
  );

  defaultArgs.push(`--remote-debugging-port=${port}`);

  if (options.headless) {
    defaultArgs.push(options.headless === 'shell' ? '--headless=shell' : '--headless=new');
  }

  // Browser proxy: on this box there is NO direct internet access, so the
  // browser must share the same explicit egress as yt-dlp/API calls
  // (BROWSER_PROXY_URL, typically the same Clash instance as PROXY_URL).
  // Do NOT rely on Chromium picking up http_proxy env vars: that fallback
  // silently breaks when the pipeline is started with a clean environment.
  // Keeping browser and yt-dlp on ONE exit IP also avoids the
  // login-session-revocation loop caused by the account bouncing between
  // different egress contexts.
  const resolvedProxy = options.proxyServer ?? process.env.BROWSER_PROXY_URL ?? null;

  if (resolvedProxy && !options.extraArgs?.some((a) => a.startsWith('--proxy-server='))) {
    defaultArgs.push(`--proxy-server=${resolvedProxy}`);
    defaultArgs.push('--proxy-bypass-list=<-loopback>');
  }

  const extensionArgs = await buildExtensionArgs(options.extensions);
  const args = [...defaultArgs, ...extensionArgs, ...(options.extraArgs || [])];

  if (keepAlive) {
    args.push(`--user-data-dir=${profileDir}`);
    console.log(
      pc.cyan(
        `[browser] Spawning persistent background Chromium on port ${port} (profile: ${path.basename(profileDir)})`
      )
    );

    await spawnDetachedChromium({
      executablePath,
      args,
      profileDir,
      port,
    });

    ensureLoopbackNoProxy();
    const browser = await chromium.connectOverCDP({
      endpointURL: `http://127.0.0.1:${port}`,
      timeout: 300_000,
    });

    attachPageHooks(browser, stealth);

    const pages = listBrowserPages(browser);
    const page: Page = pages.length > 0 ? pages[0] : await browser.contexts()[0].newPage();
    await attachWindowResizeMonitor(page).catch(() => {});

    if (effectiveViewport) {
      await applyViewportIfChanged(page, effectiveViewport).catch(() => {});
    } else {
      await maximizeBrowserWindow(page, { headless: options.headless, screenSize });
    }

    if (stealth) {
      await applyStealthEvasions(page).catch(() => {});
    } else {
      await installEvaluationHelpers(page);
    }

    await hydrateCookiesFromDisk(page);

    if (options.url) {
      try {
        await page.goto(options.url, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
      } catch (err: any) {
        console.warn(pc.yellow(`[browser] Initial navigation notice for ${options.url}: ${err.message}`));
      }
    }

    return {
      browser,
      context: page.context(),
      page,
      executablePath,
      userDataDir: profileDir,
      remoteDebuggingPort: port,
      reused: false,
    };
  }

  // Fallback for non-keepAlive: a playwright persistent context — still the same
  // Ungoogled Chromium binary and the same profile directory. Playwright talks to
  // the browser over its own pipe transport, so the --remote-debugging-port and
  // --headless* args meant for the detached-spawn path are stripped here (they
  // would fight playwright's launch plumbing); headless is set via the option.
  const persistentArgs = args.filter(
    (a) => !a.startsWith('--remote-debugging-port=') && a !== '--headless' && !a.startsWith('--headless=')
  );
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    // 'shell' (legacy puppeteer headless-shell mode) maps onto playwright's
    // standard headless mode; the same system Chromium binary is launched.
    headless: options.headless === undefined ? false : options.headless !== false,
    viewport: null,
    timeout: 300_000,
    ignoreDefaultArgs: stealth ? ['--enable-automation'] : undefined,
    args: persistentArgs,
  });
  const browser = context.browser();
  if (!browser) {
    throw new Error('launchPersistentContext returned no browser handle');
  }

  attachPageHooks(browser, stealth);

  const pages = context.pages();
  const page: Page = pages.length > 0 ? pages[0] : await context.newPage();
  await attachWindowResizeMonitor(page).catch(() => {});

  if (effectiveViewport) {
    await applyViewportIfChanged(page, effectiveViewport).catch(() => {});
  } else {
    await maximizeBrowserWindow(page, { headless: options.headless, screenSize });
  }

  if (stealth) {
    await applyStealthEvasions(page);
  } else {
    await installEvaluationHelpers(page);
  }

  if (options.url) {
    try {
      await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    } catch (err: any) {
      console.warn(pc.yellow(`[browser] Initial navigation notice for ${options.url}: ${err.message}`));
    }
  }

  return {
    browser,
    context,
    page,
    executablePath,
    userDataDir: profileDir,
    remoteDebuggingPort: port,
    reused: false,
  };
}
