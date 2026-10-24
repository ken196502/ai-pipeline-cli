import type { Page } from 'playwright-core';
import type { LaunchBrowserResult } from '../../libs/browser/launcher.js';

export interface XLoginOptions {
  username?: string;
  password?: string;
  /** Max time (ms) the automated login may take to settle before it is diagnosed. */
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
  /** Persistent profile directory used by the recovery path (default: resolveProfileDir()). */
  profileDir?: string;
  /** Max time (ms) the operator gets to finish the manual login in the headed window. */
  manualLoginTimeoutMs?: number;
  /**
   * Allow the destructive recovery path (archive profile → headed browser → manual login).
   * Defaults to true; set false for CI runs where no human is available.
   */
  allowInteractiveRecovery?: boolean;
  /** Persist the authenticated session to <projectRoot>/x_cookies.json (default true). */
  persistCookies?: boolean;
  /** Test seam: replaces the real headed relaunch with an injected launcher. */
  relaunchHeaded?: (profileDir: string) => Promise<LaunchBrowserResult>;
  /**
   * Replaces the default interactive recovery when a verification blocker
   * (phone/SMS/Arkose/CAPTCHA) is detected. The pipeline uses this to run the
   * explicit reset-from-system + headed CDP + credential login flow instead of
   * waiting for a human.
   */
  onChallenge?: (diagnosis: XLoginDiagnosis, page: Page) => Promise<XLoginResult>;
}

export type XLoginState = 'logged-in' | 'challenge' | 'failed' | 'unknown';

export interface XLoginDiagnosis {
  state: XLoginState;
  url: string;
  reason: string;
}

export interface XLoginResult {
  loggedIn: boolean;
  /** The page that owns the authenticated session (may belong to a relaunched browser). */
  page: Page;
  /** Present only when the recovery path replaced the browser session. */
  session?: LaunchBrowserResult;
  /** True when the profile was archived and a headed browser was used for a manual login. */
  recovered: boolean;
  /** Human readable explanation of why the recovery path was entered. */
  reason?: string;
}

/**
 * Raw DOM facts scraped from the page. Classification happens in Node so the
 * rules stay unit-testable (no logic hidden inside page.evaluate()).
 */
export interface XDomProbe {
  /** Visible `input[data-testid="ocfEnterTextTextInput"]` (phone / identity challenge). */
  hasCodeInput: boolean;
  /** Visible interactive Arkose / CAPTCHA challenge. */
  hasVisibleCaptcha: boolean;
  /** A normal password input is visible — the page is the regular password step. */
  passwordFormVisible: boolean;
  /** Truncated page text. */
  bodyText: string;
}

export interface XAuthStatus {
  loggedIn: boolean;
  hasAuthToken: boolean;
  usernameConfigured: boolean;
}
