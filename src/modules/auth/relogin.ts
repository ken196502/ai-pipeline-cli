/**
 * Reset-from-system re-login flow.
 *
 * Explicit, repeatable procedure requested by the operator:
 *   1. stop the browser that holds the profile,
 *   2. DELETE the persistent profile,
 *   3. copy the system Chromium profile into it,
 *   4. launch a HEADED Chromium with --remote-debugging-port (CDP),
 *   5. sign in with X_USERNAME / X_PWD (no manual window wait),
 *   6. persist the session and hand the page/session back to the caller.
 *
 * Nothing here is a silent fallback: every failure (no system profile, no
 * DISPLAY, rejected credentials, verification blocker) throws with a precise
 * reason, and a browser that failed to authenticate is closed again.
 */
import pc from 'picocolors';
import type { Browser } from 'playwright-core';
import { launchBrowser, type LaunchBrowserResult } from '../../libs/browser/launcher.js';
import { closeBrowserSession } from '../../libs/browser/session.js';
import { resolveProfileDir, resetProfileFromSystem } from '../../utils/browser.js';
import { loadEnvFile } from '../../utils/env.js';
import { ensureXLogin, isXLoggedIn, persistXCookiesToDisk } from './auth.js';

export interface ResetFromSystemLoginOptions {
  /** Profile directory to reset (default: resolveProfileDir()). */
  profileDir?: string;
  /** Defaults to X_USERNAME from .env. */
  username?: string;
  /** Defaults to X_PWD from .env. */
  password?: string;
  /** Headed by default — the login must happen in a real visible window. */
  headless?: boolean;
  /** Chromium password store used to decrypt the copied cookies. */
  passwordStore?: string;
  /** Browser handle to close before the profile is deleted. */
  browser?: Browser;
  onProgress?: (msg: string) => void;
}

const X_COOKIE_URLS = ['https://x.com', 'https://twitter.com'];

/**
 * Deletes the persistent profile, re-clones it from the system Chromium profile,
 * launches a headed CDP Chromium and authenticates with the configured credentials.
 * Returns the live session; throws (after closing the failed browser) otherwise.
 */
export async function resetProfileFromSystemAndLogin(
  options: ResetFromSystemLoginOptions = {}
): Promise<LaunchBrowserResult> {
  loadEnvFile();

  const profileDir = resolveProfileDir(options.profileDir);
  const headless = options.headless === true;
  const passwordStore = options.passwordStore ?? 'gnome-libsecret';
  const report = (msg: string) => {
    console.log(pc.cyan(`[x-relogin] ${msg}`));
    options.onProgress?.(msg);
  };

  if (!headless && !process.env.DISPLAY) {
    throw new Error(
      `无法以有头模式登录 X：当前环境没有 DISPLAY（profile: ${profileDir}）。` +
        `请在有图形界面的会话中运行，或显式设置 headless 并自行提供有效会话。`
    );
  }

  report(`[1/5] 关闭占用 profile 的浏览器会话: ${profileDir}`);
  await closeBrowserSession({ browser: options.browser, profileDir });

  report('[2/5] 删除 profile 并从系统 Chromium profile 复制');
  const reset = await resetProfileFromSystem(profileDir);
  if (!reset) {
    throw new Error(
      `未找到可复制的系统 Chromium profile（已检查 ~/.config/chromium、~/.config/google-chrome、` +
        `~/.config/chromium-browser），无法按「复制系统 profile」流程登录。profile: ${profileDir}`
    );
  }

  report(`[3/5] 启动${headless ? '无头' : '有头'} Chromium（CDP）...`);
  const session = await launchBrowser({
    profileDir,
    headless,
    reuseSession: false,
    keepAlive: true,
    extraArgs: [`--password-store=${passwordStore}`],
  });

  try {
    if (session.remoteDebuggingPort) {
      report(`      CDP endpoint: http://127.0.0.1:${session.remoteDebuggingPort}`);
    }

    const cookies = await session.context.cookies(X_COOKIE_URLS);
    const hasAuthToken = cookies.some((c) => c.name === 'auth_token' && c.value.length > 5);
    report(`[4/5] X cookies visible to the driver: ${cookies.length} (auth_token: ${hasAuthToken ? 'yes' : 'no'})`);

    if (await isXLoggedIn(session.context, session.page)) {
      report('✓ 复制过来的系统 profile 会话有效，无需密码登录');
      const file = await persistXCookiesToDisk(session.context).catch(() => null);
      if (file) report(`已持久化 X 会话: ${file}`);
      return session;
    }

    report('[5/5] 使用 X_USERNAME / X_PWD 执行账号密码登录');
    await ensureXLogin(session.page, {
      profileDir,
      username: options.username,
      password: options.password,
      allowInteractiveRecovery: false,
      onProgress: report,
    });
    report('✓ 账号密码登录成功，会话已持久化');
    return session;
  } catch (err) {
    // A browser that failed to authenticate must not linger and poison the next run.
    await closeBrowserSession({ browser: session.browser, profileDir }).catch(() => {});
    throw err;
  }
}
