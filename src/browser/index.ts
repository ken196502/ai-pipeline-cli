/**
 * Common Browser Automation Utility Engine (browser-use).
 *
 * Provides persistent profile management, Chrome DevTools Protocol (CDP) connectivity,
 * extension loading, Ungoogled Chromium detection & auto-installation, advanced screenshots,
 * anti-bot stealth mechanisms, and Netscape cookie export.
 */

// Types & Contracts
export * from './types.js';

// Detection and Installation
export {
  getSearchPaths,
  inspectChromiumBinary,
  detectChromiumInstallation,
  resolveChromiumPath,
  installUngoogledChromium,
} from './installer.js';

// Browser Launching and Stealth
export {
  launchBrowser,
  buildExtensionArgs,
  applyStealthEvasions,
  maximizeBrowserWindow,
  isWindowGeometrySatisfied,
  applyViewportIfChanged,
  parseViewport,
  resolveEffectiveViewport,
  DEFAULT_VIEWPORT,
  type LaunchBrowserResult,
  type WindowGeometryTarget,
} from './launcher.js';

// Session Persistence and Management
export {
  isSessionAlive,
  clearSessionInfo,
  findAvailablePort,
  releaseBrowser,
  closeBrowserSession,
  killOrphanedBrowserOnPort,
  type BrowserSessionInfo,
} from './session.js';

// CDP Connectivity and Sessions
export {
  connectViaCDP,
  createCDPSession,
  getAllCookiesViaCDP,
  setCookiesViaCDP,
  clearCookiesViaCDP,
  sendCDPCommand,
} from './cdp.js';

// Screenshots
export {
  takeScreenshot,
  takeFullPageScreenshot,
  takeElementScreenshot,
  takeClipScreenshot,
} from './screenshots.js';

// Real Chrome Launcher (No CDP, Extension-based)
export {
  launchRealChrome,
  checkNativeHostInstallation,
  type RealChromeOptions,
  type RealChromeSession,
} from './real-chrome-launcher.js';

// Native Bridge (Extension Communication)
export {
  NativeBridge,
  type DOMState,
  type ElementRect,
  type NativeBridgeOptions,
} from './native-bridge.js';

// High-Level Actions & Cookie Utilities
export {
  navigate,
  click,
  type,
  wait,
  evaluate,
  exportCookies,
} from './actions.js';

export {
  formatCookiesToNetscape,
  validateYouTubeAuthCookies,
  parseNetscapeCookies,
  saveCookiesToFile,
} from '../utils/cookies.js';
