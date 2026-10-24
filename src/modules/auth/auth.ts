/**
 * X (x.com) authentication.
 *
 * Two responsibilities, deliberately kept apart:
 *
 * 1. `ensureXLogin()` — automated sign-in on the persistent profile. It never
 *    touches the profile on disk. Every checkpoint (after load, after the
 *    username step, after the password step) is diagnosed with
 *    `diagnoseXLoginPage()`, so a blocker is named precisely instead of being
 *    guessed from a timeout.
 *
 * 2. Interactive recovery — entered ONLY when a real verification blocker is
 *    detected (phone/2FA challenge, Arkose/CAPTCHA, /signup_phone,
 *    /account/access, ...). It archives the flagged profile, optionally seeds a
 *    system profile (verified before use), relaunches a HEADED Chromium and
 *    waits for the operator to finish the login, then persists the fresh
 *    session to `x_cookies.json` and hands the new page back to the caller.
 *
 * Credential rejection and plain timeouts are NOT blockers: they alert and
 * throw. Deleting a profile is a last resort, never a generic retry.
 */
import type { Page, BrowserContext } from 'playwright-core';
import pc from 'picocolors';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '../../utils/env.js';
import {
  getProjectRootDir,
  resolveProfileDir,
  findSystemProfileSource,
  copyProfileDir,
} from '../../utils/browser.js';
import { sendMsg, notifyError } from '../../utils/send_msg.js';
import { launchBrowser, type LaunchBrowserResult } from '../../libs/browser/launcher.js';
import { closeBrowserSession } from '../../libs/browser/session.js';
import type {
  XLoginOptions,
  XLoginResult,
  XLoginDiagnosis,
  XDomProbe,
} from './contracts.js';

const X_COOKIE_URLS = ['https://x.com', 'https://twitter.com'];
const DEFAULT_AUTOMATED_LOGIN_TIMEOUT_MS = 25_000;
const DEFAULT_MANUAL_LOGIN_TIMEOUT_MS = 300_000;
const MANUAL_LOGIN_POLL_INTERVAL_MS = 2_000;
/** How many `.broken-<ts>` profile archives are kept for post-mortem. */
const MAX_PROFILE_ARCHIVES = 1;

/** URL paths that mean "X wants a human" — never used to justify deleting a profile on their own. */
const CHALLENGE_URL_PATTERNS: Array<[RegExp, string]> = [
  [/\/signup_phone\b/i, 'X 要求手机号验证 (/signup_phone)'],
  [/\/i\/flow\/phone_verification\b/i, 'X 要求手机号验证 (/i/flow/phone_verification)'],
  [/\/account\/access\b/i, 'X 要求账号访问验证 (/account/access)'],
  [/\/login_verification\b/i, 'X 要求登录二次验证 (/login_verification)'],
  [/\/i\/flow\/login_verification\b/i, 'X 要求登录二次验证 (/i/flow/login_verification)'],
  [/\/challenge\b/i, 'X 风控挑战页面 (/challenge)'],
];

/** URL paths that mean the account itself is unusable — a manual login cannot fix these. */
const FAILURE_URL_PATTERNS: Array<[RegExp, string]> = [
  [/\/account\/locked\b/i, 'X 账号已被锁定 (/account/locked)'],
];

const CHALLENGE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/verify your identity|verify it'?s you|confirm your identity|we need to verify/i, 'X 要求身份验证'],
  [/we'?ve detected (?:unusual|suspicious)|unusual activity|suspicious activity|unusual login/i, 'X 检测到异常/可疑登录活动'],
  [/enter the (?:verification |confirmation )?code|we sent (?:you )?(?:a )?code|verification code|check your (?:phone|email)/i, 'X 要求输入短信/邮箱验证码'],
  [/confirm your phone|add your phone|verify your phone|phone verification/i, 'X 要求手机号验证'],
  [/complete the challenge|solve the (?:puzzle|captcha)|are you (?:a )?(?:robot|human)|not a robot/i, 'X 要求完成人机验证'],
  [/进行(?:真人|人机)?验证|真人验证|人机验证|安全验证|身份验证|身份确认|异常活动|可疑活动|验证码|短信验证|邮箱验证|绑定手机/, 'X 要求中文风控验证'],
];

const FAILURE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/wrong password|incorrect password|invalid password|password you entered (?:did not|didn'?t) match/i, 'X 拒绝了密码（账号或密码错误）'],
  [/could not find your account|couldn'?t find your account|account doesn'?t exist|账号不存在|找不到该账号/i, 'X 找不到该账号（账号或密码错误）'],
  [/account (?:has been )?(?:locked|suspended)|账号已被(?:锁定|冻结|停用)|密码错误/i, 'X 账号被锁定/停用或密码错误'],
];

/* ------------------------------------------------------------------ */
/* Session detection                                                   */
/* ------------------------------------------------------------------ */

/** True when a live (non-expired) `auth_token` cookie is present. */
function hasLiveAuthToken(cookies: Array<{ name: string; value: string; expires?: number }>): boolean {
  return cookies.some((c) => {
    if (c.name !== 'auth_token' || !c.value || c.value.length <= 5) return false;
    // `expires` is absent for session cookies (and for hand-written mocks).
    if (typeof c.expires !== 'number' || c.expires <= 0) return true;
    return c.expires * 1000 > Date.now();
  });
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' | undefined {
  const v = String(value ?? '').toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none') return 'None';
  return undefined;
}

/**
 * Resolves the X cookie session file. `X_COOKIES_FILE` overrides the default so a
 * run can deliberately start without a persisted session (tests, fresh login).
 */
export function resolveXCookieFilePath(): string {
  const override = process.env.X_COOKIES_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(getProjectRootDir(), 'x_cookies.json');
}

/**
 * Hydrates X.com cookies from the resolved cookie file if available.
 * This is an explicit session source (not a hidden fallback): when the file is
 * present its cookies are injected as-is, including their real expiry.
 */
export async function hydrateXCookiesFromDisk(context: BrowserContext): Promise<boolean> {
  // Mocks / non-cookie contexts (module self-test) simply have nothing to hydrate.
  if (typeof (context as any)?.addCookies !== 'function') return false;
  try {
    const cookieFile = resolveXCookieFilePath();
    const content = await fs.readFile(cookieFile, 'utf-8').catch(() => null);
    if (!content) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      console.warn(pc.yellow(`[x-login] x_cookies.json 不是合法 JSON，已跳过注入: ${err.message}`));
      return false;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return false;

    const playwrightCookies = parsed
      .filter((c: any) => c && typeof c.name === 'string' && typeof c.value === 'string' && c.domain)
      .map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: Boolean(c.httpOnly),
        sameSite: normalizeSameSite(c.sameSite) ?? 'Lax',
        ...(typeof c.expirationDate === 'number' && c.expirationDate > 0
          ? { expires: c.expirationDate }
          : {}),
      }));

    if (playwrightCookies.length === 0) return false;
    await context.addCookies(playwrightCookies);
    return true;
  } catch (err: any) {
    console.warn(pc.yellow(`[x-login] 注入 x_cookies.json 失败: ${err.message}`));
    return false;
  }
}

/**
 * Checks if the browser session already has valid X.com / Twitter.com authentication.
 */
export async function isXLoggedIn(context: BrowserContext, page?: Page): Promise<boolean> {
  try {
    const cookies = await context.cookies(X_COOKIE_URLS);
    if (hasLiveAuthToken(cookies)) return true;

    // Try hydrating from disk if not present in memory
    const hydrated = await hydrateXCookiesFromDisk(context);
    if (hydrated) {
      const refreshedCookies = await context.cookies(X_COOKIE_URLS);
      if (hasLiveAuthToken(refreshedCookies)) return true;
    }

    if (page) {
      const currentUrl = page.url();
      if (currentUrl.includes('x.com') || currentUrl.includes('twitter.com')) {
        const loggedInIndicator = await page.$(
          '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], a[href="/home"]'
        );
        if (loggedInIndicator) return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Stricter than `isXLoggedIn()`: the cookie must be live AND the UI must prove it
 * (landed on /home or the account switcher is rendered). Used while waiting for a
 * manual login so a stale cookie cannot be mistaken for a finished login.
 */
export async function isXSessionActive(page: Page): Promise<boolean> {
  if (!(await isXLoggedIn(page.context(), page))) return false;
  if (page.url().includes('/home')) return true;
  try {
    const indicator = await page.$(
      '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]'
    );
    return Boolean(indicator);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Blocker diagnosis (pure helpers + one DOM scrape)                   */
/* ------------------------------------------------------------------ */

/** Returns a reason when the URL itself is a verification challenge, else null. */
export function matchXChallengeUrl(url: string): string | null {
  for (const [pattern, reason] of CHALLENGE_URL_PATTERNS) {
    if (pattern.test(url)) return reason;
  }
  return null;
}

/** Returns a reason when the URL itself proves the account is unusable, else null. */
export function matchXLoginFailureUrl(url: string): string | null {
  for (const [pattern, reason] of FAILURE_URL_PATTERNS) {
    if (pattern.test(url)) return reason;
  }
  return null;
}

/**
 * Classifies scraped DOM facts. Pure function: the same rules are unit-tested
 * with synthetic probes, and nothing is hidden inside page.evaluate().
 *
 * `passwordFormVisible` guards the text-based challenge rules so the normal
 * Chinese login form ("手机号码、电子邮件地址或用户名") is never mistaken for a
 * phone challenge.
 */
export function classifyXLoginDom(probe: XDomProbe): {
  state: 'challenge' | 'failed' | 'unknown';
  reason: string;
} {
  if (probe.hasCodeInput) {
    return {
      state: 'challenge',
      reason: 'X 要求补充手机号/邮箱或身份验证（ocfEnterTextTextInput 验证码输入框）',
    };
  }
  if (probe.hasVisibleCaptcha) {
    return { state: 'challenge', reason: 'X 人机验证（Arkose/CAPTCHA）挑战' };
  }

  const text = probe.bodyText || '';

  // Credential rejection is independent of which form is visible (it shows up
  // as a toast/banner above the still-rendered password field).
  for (const [pattern, reason] of FAILURE_TEXT_PATTERNS) {
    if (pattern.test(text)) return { state: 'failed', reason };
  }

  if (!probe.passwordFormVisible) {
    for (const [pattern, reason] of CHALLENGE_TEXT_PATTERNS) {
      if (pattern.test(text)) return { state: 'challenge', reason };
    }
  }

  return { state: 'unknown', reason: '未检测到登录成功、风控拦截或凭据拒绝标记' };
}

async function probeXLoginPage(page: Page): Promise<XDomProbe | null> {
  return await page
    .evaluate(() => {
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const he = el as HTMLElement;
        if (he.offsetParent === null && getComputedStyle(he).position !== 'fixed') return false;
        const style = getComputedStyle(he);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = he.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const codeInput = document.querySelector('input[data-testid="ocfEnterTextTextInput"]');
      const captcha = document.querySelector(
        'iframe[src*="arkose"], iframe[src*="captcha"], #arkose, [data-testid="arkose_challenge"], [data-testid="ocf_captcha"]'
      );
      const pwd = document.querySelector('input[name="password"], input[type="password"]');

      let hasVisibleCaptcha = false;
      if (captcha && isVisible(captcha)) {
        const rect = captcha.getBoundingClientRect();
        hasVisibleCaptcha = rect.width >= 50 && rect.height >= 50;
      }

      return {
        hasCodeInput: isVisible(codeInput),
        hasVisibleCaptcha,
        passwordFormVisible: isVisible(pwd),
        bodyText: (document.body ? document.body.innerText || '' : '').slice(0, 20_000),
      };
    })
    .catch(() => null);
}

/**
 * Full page diagnosis: logged-in → failed (account unusable) → challenge (needs a
 * human) → DOM facts → unknown.
 */
export async function diagnoseXLoginPage(page: Page): Promise<XLoginDiagnosis> {
  const url = page.url();

  if (await isXLoggedIn(page.context(), page)) {
    return { state: 'logged-in', url, reason: 'auth_token cookie present' };
  }

  const failureUrl = matchXLoginFailureUrl(url);
  if (failureUrl) return { state: 'failed', url, reason: failureUrl };

  const challengeUrl = matchXChallengeUrl(url);
  if (challengeUrl) return { state: 'challenge', url, reason: challengeUrl };

  const probe = await probeXLoginPage(page);
  if (!probe) {
    return { state: 'unknown', url, reason: '页面不可读（可能正在导航）' };
  }

  const classified = classifyXLoginDom(probe);
  return { state: classified.state, url, reason: classified.reason };
}

/* ------------------------------------------------------------------ */
/* Cookie persistence                                                  */
/* ------------------------------------------------------------------ */

/**
 * Writes the live X/Twitter cookies to `<projectRoot>/x_cookies.json` in the
 * shape `hydrateXCookiesFromDisk()` consumes. Returns the file path, or null when
 * there is no authenticated cookie to persist.
 */
export async function persistXCookiesToDisk(
  context: BrowserContext,
  filePath?: string
): Promise<string | null> {
  const cookies = await context.cookies(X_COOKIE_URLS);
  if (!hasLiveAuthToken(cookies)) return null;

  const payload = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(typeof c.expires === 'number' && c.expires > 0 ? { expirationDate: c.expires } : {}),
  }));

  const target = filePath ?? resolveXCookieFilePath();
  await fs.writeFile(target, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return target;
}

/* ------------------------------------------------------------------ */
/* Interactive recovery                                                */
/* ------------------------------------------------------------------ */

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Moves the flagged profile out of the active path (never a silent delete) and
 * keeps at most `MAX_PROFILE_ARCHIVES` historical copies.
 */
async function archiveBrokenProfile(profileDir: string, report: (m: string) => void): Promise<string> {
  const archiveDir = `${profileDir}.broken-${timestampSlug()}`;
  try {
    await fs.rename(profileDir, archiveDir);
  } catch (err: any) {
    throw new Error(
      `无法归档被标记的 profile "${profileDir}" -> "${archiveDir}": ${err.message}. ` +
        `为避免污染会话，恢复流程已中止（未做任何静默删除）。`
    );
  }
  report(`已归档被标记的 profile: ${path.basename(archiveDir)}`);

  try {
    const entries = (await fs.readdir(path.dirname(profileDir))).filter((name) =>
      name.startsWith(`${path.basename(profileDir)}.broken-`)
    );
    const stale = entries.sort().slice(0, Math.max(0, entries.length - MAX_PROFILE_ARCHIVES));
    for (const name of stale) {
      await fs.rm(path.join(path.dirname(profileDir), name), { recursive: true, force: true }).catch(() => {});
      report(`已清理更早的 profile 归档: ${name}`);
    }
  } catch {
    // Pruning is best-effort housekeeping; the archive itself is what matters.
  }

  return archiveDir;
}

/** Archives the resolved X cookie file so a flagged session cannot be re-injected. */
async function archiveXCookieFile(report: (m: string) => void): Promise<string | null> {
  const cookieFile = resolveXCookieFilePath();
  if (!fsSync.existsSync(cookieFile)) return null;
  const archiveFile = `${cookieFile}.broken-${timestampSlug()}`;
  try {
    await fs.rename(cookieFile, archiveFile);
    report(`已归档旧 x_cookies.json: ${path.basename(archiveFile)}`);
    return archiveFile;
  } catch (err: any) {
    throw new Error(`无法归档旧 x_cookies.json: ${err.message}`);
  }
}

/**
 * Launches a throwaway browser on the candidate profile and verifies that the
 * session actually works (live auth_token AND a logged-in UI). Anything less is
 * discarded: a half-decryptable profile produces Cloudflare 403 pages, which is
 * worse than an empty profile.
 */
async function probeProfileSession(profileDir: string, report: (m: string) => void): Promise<boolean> {
  let session: LaunchBrowserResult | null = null;
  try {
    session = await launchBrowser({
      profileDir,
      headless: true,
      reuseSession: false,
      keepAlive: true,
    });
    if (!(await isXLoggedIn(session.context, session.page))) return false;

    const response = await session.page
      .goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => null);
    await session.page.waitForTimeout(4_000);

    if (response && response.status() >= 400) {
      report(`系统 profile 会话被 X/Cloudflare 拒绝（HTTP ${response.status()}）`);
      return false;
    }
    return await isXSessionActive(session.page);
  } catch (err: any) {
    report(`系统 profile 会话探测失败: ${err.message}`);
    return false;
  } finally {
    if (session) {
      await closeBrowserSession({ browser: session.browser, profileDir }).catch(() => {});
    }
  }
}

/**
 * Optional seeding: copy the system Chromium profile into the (now empty) project
 * profile and adopt it only when the session is verified usable.
 * Disabled with `X_RECOVERY_SEED_SYSTEM_PROFILE=0`.
 */
async function seedProfileFromSystem(profileDir: string, report: (m: string) => void): Promise<boolean> {
  if (process.env.X_RECOVERY_SEED_SYSTEM_PROFILE === '0') {
    report('系统 profile 播种已禁用 (X_RECOVERY_SEED_SYSTEM_PROFILE=0)');
    await fs.mkdir(profileDir, { recursive: true });
    return false;
  }

  const source = findSystemProfileSource();
  if (!source || path.resolve(source) === path.resolve(profileDir)) {
    report('未找到可用的系统 Chromium profile，使用全新空 profile 等待人工登录');
    await fs.mkdir(profileDir, { recursive: true });
    return false;
  }

  report(`正在从系统 profile 复制干净会话: ${source}`);
  const fileCount = await copyProfileDir(source, profileDir);
  report(`已复制 ${fileCount} 个文件，正在验证会话是否可用...`);

  if (await probeProfileSession(profileDir, report)) {
    report('✓ 系统 profile 会话验证通过，将直接复用');
    return true;
  }

  report('系统 profile 的会话在自动化 Chromium 中不可用（Cookie 加密密钥不匹配或被风控），丢弃并使用全新空 profile');
  await fs.rm(profileDir, { recursive: true, force: true });
  await fs.mkdir(profileDir, { recursive: true });
  return false;
}

async function relaunchHeadedBrowser(
  profileDir: string,
  options: XLoginOptions
): Promise<LaunchBrowserResult> {
  if (options.relaunchHeaded) {
    return await options.relaunchHeaded(profileDir);
  }
  return await launchBrowser({
    profileDir,
    headless: false,
    reuseSession: false,
    keepAlive: true,
  });
}

/**
 * Destructive recovery path — entered only for a confirmed verification blocker.
 */
async function recoverWithInteractiveLogin(
  page: Page,
  diagnosis: XLoginDiagnosis,
  options: XLoginOptions,
  report: (msg: string) => void
): Promise<XLoginResult> {
  const profileDir = resolveProfileDir(options.profileDir);
  const manualTimeoutMs =
    options.manualLoginTimeoutMs ??
    (Number(process.env.X_MANUAL_LOGIN_TIMEOUT_MS) || DEFAULT_MANUAL_LOGIN_TIMEOUT_MS);

  if (!process.env.DISPLAY) {
    const msg =
      `❌ 【X 登录拦截】检测到验证拦截（${diagnosis.reason}），但当前环境没有 DISPLAY，无法拉起有头窗口完成人工登录。\n` +
      `• URL: ${diagnosis.url}\n` +
      `• profile: ${profileDir}\n` +
      `• 处理建议：在有图形界面的会话中运行，或先手动登录后提供 x_cookies.json。`;
    await notifyError(msg).catch(() => {});
    throw new Error(msg);
  }

  report(`⚠️ 检测到 X 登录拦截: ${diagnosis.reason} (${diagnosis.url})`);
  await notifyError(
    `⚠️ 【X 登录拦截】自动化登录无法通过风控验证，即将重置会话并拉起有头浏览器等待人工登录。\n` +
      `• 触发原因: ${diagnosis.reason}\n` +
      `• 当前 URL: ${diagnosis.url}\n` +
      `• 动作: 关闭被污染会话 → 归档旧 profile → 拉起有头 Chromium → 等待手动登录（最多 ${Math.round(manualTimeoutMs / 60000)} 分钟）`
  ).catch(() => {});

  // 1. Stop the flagged session so the profile lock is released before archiving.
  const browser = page.context().browser();
  await closeBrowserSession({ browser: browser ?? undefined, profileDir });
  report('已关闭被污染的浏览器会话');

  // 2. Take the flagged profile (and its cookies) out of the active path.
  await archiveBrokenProfile(profileDir, report);
  await archiveXCookieFile(report);

  // 3. Optional, verified seeding from the system profile.
  const seeded = await seedProfileFromSystem(profileDir, report);

  // 4. Headed relaunch.
  report('正在以有头模式拉起 Chromium，等待人工完成 X 登录...');
  const session = await relaunchHeadedBrowser(profileDir, options);
  await session.page
    .goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .catch((err: any) => report(`导航到 x.com/login 时出现异常: ${err.message}`));
  await session.page.waitForTimeout(2_000);

  // A verified seed may already be logged in — no need to wait for a human.
  if (await isXSessionActive(session.page)) {
    report('✓ 播种的会话已生效，无需人工登录');
    const cookieFile = await persistXCookiesToDisk(session.context).catch(() => null);
    if (cookieFile) report(`已持久化 X 会话: ${cookieFile}`);
    await sendMsg('🎉 【X 登录】播种会话验证通过，已持久化并继续流水线。').catch(() => {});
    return { loggedIn: true, page: session.page, session, recovered: true, reason: diagnosis.reason };
  }

  await sendMsg(
    `🔓 【X 登录需要人工介入】已拉起有头 Chromium 窗口（profile 已归档重置${seeded ? '，系统会话已验证' : ''}）。\n` +
      `• 触发原因: ${diagnosis.reason}\n` +
      `• 请在窗口中手动完成 X 登录/二次验证（含验证码）\n` +
      `• 完成后会话将自动持久化到 profile 与 x_cookies.json，流水线自动继续\n` +
      `• 等待上限: ${Math.round(manualTimeoutMs / 60000)} 分钟`
  ).catch(() => {});

  // 5. Wait for the human.
  const deadline = Date.now() + manualTimeoutMs;
  while (Date.now() < deadline) {
    if (session.page.isClosed()) {
      const msg = '❌ 【X 登录】有头登录窗口在登录完成前被关闭，无法继续流水线。';
      await notifyError(msg).catch(() => {});
      throw new Error(msg);
    }
    if (!session.browser.isConnected()) {
      const msg = '❌ 【X 登录】有头登录浏览器已断开连接，无法继续流水线。';
      await notifyError(msg).catch(() => {});
      throw new Error(msg);
    }
    if (await isXSessionActive(session.page)) {
      report('✓ 检测到人工登录成功，正在持久化会话...');
      const cookieFile = await persistXCookiesToDisk(session.context).catch(() => null);
      if (cookieFile) {
        report(`已持久化 X 会话: ${cookieFile}`);
      } else {
        report('⚠️ 未找到 auth_token，跳过 x_cookies.json 持久化（profile 内会话仍然有效）');
      }
      await sendMsg(
        `🎉 【X 登录成功】人工登录已完成，会话已持久化${cookieFile ? '（profile + x_cookies.json）' : '（profile）'}，流水线继续执行。`
      ).catch(() => {});
      return { loggedIn: true, page: session.page, session, recovered: true, reason: diagnosis.reason };
    }
    await session.page.waitForTimeout(MANUAL_LOGIN_POLL_INTERVAL_MS);
  }

  const timeoutMsg =
    `⌛️ 【X 登录】人工登录等待超时（${Math.round(manualTimeoutMs / 60000)} 分钟），流水线已中止。\n` +
    `• 触发原因: ${diagnosis.reason}\n` +
    `• 当前 URL: ${session.page.url()}\n` +
    `• profile: ${profileDir}\n` +
    `• 处理建议：重新运行，或手动登录后提供 x_cookies.json。`;
  await notifyError(timeoutMsg).catch(() => {});
  throw new Error(timeoutMsg);
}

/* ------------------------------------------------------------------ */
/* Automated login                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ensures the user is logged in to X (x.com) using credentials from
 * process.env (X_USERNAME, X_PWD), reusing the persistent Chromium session.
 *
 * Returns the page that owns the authenticated session — after an interactive
 * recovery this is a NEW page from a NEW browser, so callers must use
 * `result.page` (and swap their session when `result.session` is set).
 */
export async function ensureXLogin(page: Page, options: XLoginOptions = {}): Promise<XLoginResult> {
  loadEnvFile();

  const username = options.username || process.env.X_USERNAME?.trim();
  const password = options.password || process.env.X_PWD?.trim();
  const automatedTimeoutMs = options.timeoutMs ?? DEFAULT_AUTOMATED_LOGIN_TIMEOUT_MS;
  const persistCookies = options.persistCookies !== false;
  const recoveryAllowed =
    options.allowInteractiveRecovery ?? process.env.X_AUTH_INTERACTIVE_RECOVERY !== '0';

  const report = (msg: string) => {
    console.log(pc.cyan(`[x-login] ${msg}`));
    options.onProgress?.(msg);
  };

  const persist = async (ctx: BrowserContext) => {
    if (!persistCookies) return;
    const file = await persistXCookiesToDisk(ctx).catch(() => null);
    if (file) report(`已刷新 X 会话文件: ${path.basename(file)}`);
  };

  const handleBlocker = async (diagnosis: XLoginDiagnosis): Promise<XLoginResult> => {
    // A caller-provided handler takes precedence: it knows whether a reset is
    // appropriate (e.g. only after the existing profile failed a real login).
    if (options.onChallenge) {
      report(`检测到风控拦截: ${diagnosis.reason} → 交由调用方处理`);
      return await options.onChallenge(diagnosis, page);
    }
    if (!recoveryAllowed) {
      const msg =
        `❌ X 登录被拦截: ${diagnosis.reason} (${diagnosis.url})\n` +
        `交互式恢复已被禁用（X_AUTH_INTERACTIVE_RECOVERY=0 / allowInteractiveRecovery=false）。`;
      await notifyError(msg).catch(() => {});
      throw new Error(msg);
    }
    return await recoverWithInteractiveLogin(page, diagnosis, options, report);
  };

  report('Checking existing X login session in persistent profile...');
  if (await isXLoggedIn(page.context(), page)) {
    report('Already authenticated on X (auth_token found).');
    return { loggedIn: true, page, recovered: false };
  }

  if (!username || !password) {
    throw new Error(
      'Missing X credentials. Please configure X_USERNAME and X_PWD in .env or environment variables.'
    );
  }

  report(`Initiating automated sign-in on X for user: ${username}`);
  await page
    .goto('https://x.com/i/flow/login', {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(automatedTimeoutMs, 30_000),
    })
    .catch(() => {});
  await page.waitForTimeout(3_000);

  // Checkpoint 1: redirected straight to home, or straight into a blocker.
  let diagnosis = await diagnoseXLoginPage(page);
  if (diagnosis.state === 'logged-in') {
    report('Landed on home; session active.');
    await persist(page.context());
    return { loggedIn: true, page, recovered: false };
  }
  if (diagnosis.state === 'challenge') {
    return await handleBlocker(diagnosis);
  }

  // 1. Enter username / email / phone
  const usernameSelector =
    'input[name="username_or_email"], input[autocomplete*="username"], input[name="text"], input[data-testid="ocfEnterTextTextInput"]';
  await page.waitForSelector(usernameSelector, { state: 'visible', timeout: 8_000 }).catch(() => {});
  const userInput = await page.$(usernameSelector);

  if (userInput && (await userInput.isVisible())) {
    report(`Entering username/handle: ${username}`);
    await userInput.click();
    await userInput.fill('');
    await userInput.fill(username);
    await page.waitForTimeout(500);

    const nextBtn = await page.$('button:has-text("Next"), button:has-text("Continue")');
    if (nextBtn && (await nextBtn.isVisible())) {
      await nextBtn.click();
      await page.waitForTimeout(2_000);
    }
  }

  // Checkpoint 2: the "unusual activity" / identity challenge often appears here.
  diagnosis = await diagnoseXLoginPage(page);
  if (diagnosis.state === 'challenge') {
    return await handleBlocker(diagnosis);
  }

  // 2. Enter password
  const pwdSelector = 'input[name="password"], input[type="password"]';
  await page.waitForSelector(pwdSelector, { state: 'visible', timeout: 8_000 }).catch(() => {});
  const pwdInput = await page.$(pwdSelector);

  if (pwdInput && (await pwdInput.isVisible())) {
    report('Entering password...');
    await pwdInput.click();
    await pwdInput.fill('');
    await pwdInput.fill(password);
    await page.waitForTimeout(500);

    const loginBtn = await page.$(
      'button[data-testid="LoginForm_Login_Button"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")'
    );
    if (loginBtn && (await loginBtn.isVisible())) {
      await loginBtn.click();
    } else {
      await pwdInput.press('Enter');
    }
    report('Submitted credentials, awaiting login settlement...');
  }

  // Checkpoint 3: poll until the state is no longer "unknown".
  const deadline = Date.now() + automatedTimeoutMs;
  diagnosis = await diagnoseXLoginPage(page);
  while (diagnosis.state === 'unknown' && Date.now() < deadline) {
    await page.waitForTimeout(1_500);
    diagnosis = await diagnoseXLoginPage(page);
  }

  if (diagnosis.state === 'logged-in') {
    report('✓ Login successful! Persistent session active.');
    await persist(page.context());
    return { loggedIn: true, page, recovered: false };
  }

  if (diagnosis.state === 'challenge') {
    return await handleBlocker(diagnosis);
  }

  if (diagnosis.state === 'failed') {
    const msg =
      `❌ X 自动登录被拒绝: ${diagnosis.reason}\n` +
      `• URL: ${diagnosis.url}\n` +
      `• 请检查 X_USERNAME / X_PWD 是否正确；凭据问题不会触发 profile 重置。`;
    await notifyError(msg).catch(() => {});
    throw new Error(msg);
  }

  // Unknown: no blocker marker, no rejection, no success — never guess.
  const msg =
    `❌ X 自动登录在 ${Math.round(automatedTimeoutMs / 1000)} 秒内未完成，且未检测到任何风控拦截标记。\n` +
    `• URL: ${page.url()}\n` +
    `• 未触发 profile 重置（只有确认的验证拦截才会重置）。`;
  await notifyError(msg).catch(() => {});
  throw new Error(msg);
}
