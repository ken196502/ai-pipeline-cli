/**
 * TypeScript Contracts and Types for the Common Browser-Use Utility Module.
 */
import type { CDPCookie } from '../../utils/cookies.js';

export type { CDPCookie };

export interface BrowserLaunchOptions {
  /**
   * Path to the Chromium / Ungoogled Chromium binary.
   * If omitted, auto-detected from environment and OS standard paths.
   */
  executablePath?: string;

  /**
   * Path to persistent user profile directory (userDataDir).
   * Defaults to './.chromium-profile'.
   */
  profileDir?: string;
  userDataDir?: string;

  /**
   * Initial URL to navigate to upon launch.
   */
  url?: string;

  /**
   * Headless mode. Default is false to facilitate user interaction and anti-bot evasion.
   */
  headless?: boolean | 'shell';

  /**
   * List of local directory paths containing unpacked Chrome extensions to load.
   */
  extensions?: string[];

  /**
   * Chrome DevTools Protocol remote debugging port.
   * If specified, passes --remote-debugging-port=<port>.
   */
  remoteDebuggingPort?: number;

  /**
   * Additional command line arguments to pass to the Chromium process.
   */
  extraArgs?: string[];

  /**
   * Proxy server URL (e.g., http://127.0.0.1:7890).
   */
  proxyServer?: string;

  /**
   * Anti-bot stealth mode (masks navigator.webdriver, suppresses automation flags).
   * Defaults to true.
   */
  stealth?: boolean;

  /**
   * Default viewport dimensions. Set to null to allow full window size.
   */
  viewport?: { width: number; height: number } | null;

  /**
   * Polling interval in ms for interactive operations (e.g. cookie export).
   */
  pollIntervalMs?: number;

  /**
   * Whether to check for and reuse an existing active browser session for this profile.
   * Defaults to true.
   */
  reuseSession?: boolean;

  /**
   * Whether to keep the browser running in the background after Puppeteer disconnects.
   * Spawns Chromium as a detached process so the window remains open after pipeline ends.
   * Defaults to true.
   */
  keepAlive?: boolean;
}

export interface CDPConnectOptions {
  /**
   * HTTP endpoint to connect to an existing browser instance (e.g., http://127.0.0.1:9222).
   */
  browserURL?: string;

  /**
   * Direct WebSocket endpoint for CDP (e.g., ws://127.0.0.1:9222/devtools/browser/...).
   */
  browserWSEndpoint?: string;

  /**
   * Hostname for CDP connection if constructing browserURL. Defaults to 127.0.0.1.
   */
  host?: string;

  /**
   * Port number for CDP connection if constructing browserURL (e.g., 9222).
   */
  port?: number;

  /**
   * Default viewport configuration for connected pages.
   */
  defaultViewport?: { width: number; height: number } | null;
}

export interface ScreenshotOptions {
  /**
   * Destination file path to save screenshot on disk.
   * If omitted, the buffer and base64 string are still returned.
   */
  path?: string;

  /**
   * When true, captures the complete scrollable page height.
   */
  fullPage?: boolean;

  /**
   * CSS selector of element to screenshot (crops to element bounding box).
   */
  selector?: string;

  /**
   * Specific clipping region coordinates in pixels.
   */
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  /**
   * Image compression format. Defaults to 'png'.
   */
  type?: 'png' | 'jpeg' | 'webp';

  /**
   * Image compression quality (1-100), applicable to 'jpeg' and 'webp'.
   */
  quality?: number;

  /**
   * Hide default white background and allow capturing transparency.
   */
  omitBackground?: boolean;
}

export interface ScreenshotResult {
  /**
   * Raw image binary buffer.
   */
  buffer: Buffer;

  /**
   * Base64-encoded representation of the image.
   */
  base64: string;

  /**
   * Absolute path where image was saved on disk, if path option was provided.
   */
  path?: string;

  /**
   * Image format ('png', 'jpeg', or 'webp').
   */
  format: 'png' | 'jpeg' | 'webp';
}

export interface ClickOptions {
  /**
   * Time to wait in ms before releasing click.
   */
  delay?: number;

  /**
   * Mouse button to click with. Defaults to 'left'.
   */
  button?: 'left' | 'right' | 'middle';

  /**
   * Number of clicks (e.g. 1 for single click, 2 for double click).
   */
  clickCount?: number;

  /**
   * Whether to wait for selector to be visible before clicking. Defaults to true.
   */
  waitForSelector?: boolean;

  /**
   * Maximum wait timeout in milliseconds.
   */
  timeout?: number;
}

export interface TypeOptions {
  /**
   * Static delay between keystrokes in ms.
   */
  delay?: number;

  /**
   * If true, applies randomized typing speed jitter (humanized typing). Defaults to true.
   */
  humanize?: boolean;

  /**
   * Minimum random delay in ms per keystroke when humanize is enabled. Defaults to 25ms.
   */
  minDelay?: number;

  /**
   * Maximum random delay in ms per keystroke when humanize is enabled. Defaults to 95ms.
   */
  maxDelay?: number;

  /**
   * Clear existing input field text before typing. Defaults to false.
   */
  clear?: boolean;
}

export interface NavigateOptions {
  /**
   * Navigation completion lifecycle event. Defaults to 'domcontentloaded'.
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

  /**
   * Navigation timeout in milliseconds. Defaults to 30000ms.
   */
  timeout?: number;

  /**
   * HTTP Referer header to include with request.
   */
  referer?: string;
}

export interface ChromiumInstallInfo {
  /**
   * Whether a valid Chromium or Ungoogled Chromium binary was located.
   */
  found: boolean;

  /**
   * Resolved path to the executable binary.
   */
  path: string | null;

  /**
   * Output from `--version` if executable is runnable.
   */
  version: string | null;

  /**
   * True if binary signature indicates Ungoogled Chromium flavor.
   */
  isUngoogled: boolean;

  /**
   * Operating system platform detected ('darwin', 'linux', 'win32').
   */
  platform: NodeJS.Platform;

  /**
   * Informational notes or error messages.
   */
  notes?: string;
}

export interface CookieExportOptions {
  /**
   * Destination path for Netscape cookies.txt file. Defaults to './cookies.txt'.
   */
  outputPath?: string;

  /**
   * Optional domain filter (e.g. ['youtube.com', 'google.com']).
   */
  domains?: string[];

  /**
   * Validate that YouTube login authentication cookies (LOGIN_INFO + SAPISID/SID) exist.
   */
  validateYouTube?: boolean;
}
