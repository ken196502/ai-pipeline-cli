import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { ensureYtDlp, verifyCookiesWithYtDlp, type YtDlpVerificationResult } from './ytdlp.js';

export interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ParsedCookie {
  domain: string;
  flag: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

export interface CookieValidationResult {
  valid: boolean;
  reason?: string;
  foundAuthCookies: string[];
  missingAuthCookies: string[];
  expiredCookies: string[];
}

export interface ComprehensiveVerificationResult {
  valid: boolean;
  stage: 'file_check' | 'static_tokens' | 'ytdlp_live';
  reason: string;
  foundAuthTokens?: string[];
  missingAuthTokens?: string[];
  expiredTokens?: string[];
  ytDlpResult?: YtDlpVerificationResult;
}

/**
 * Converts CDP / Puppeteer cookies into Netscape HTTP Cookie File format compatible with yt-dlp and curl.
 */
export function formatCookiesToNetscape(cookies: CDPCookie[]): string {
  const lines: string[] = [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/rfc/cookie_spec.html',
    '# This is a generated file!  Do not edit.',
    '',
  ];

  const sortedCookies = [...cookies].sort((a, b) => {
    const d = a.domain.localeCompare(b.domain);
    if (d !== 0) return d;
    const p = a.path.localeCompare(b.path);
    if (p !== 0) return p;
    return a.name.localeCompare(b.name);
  });

  for (const cookie of sortedCookies) {
    const domainPrefix = cookie.httpOnly ? '#HttpOnly_' : '';
    const domain = `${domainPrefix}${cookie.domain}`;
    const flag = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const cookiePath = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiration = cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    const name = cookie.name;
    const value = cookie.value;

    lines.push(`${domain}\t${flag}\t${cookiePath}\t${secure}\t${expiration}\t${name}\t${value}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Parses a Netscape cookie file content into structured cookie objects.
 */
export function parseNetscapeCookies(content: string): ParsedCookie[] {
  const cookies: ParsedCookie[] = [];
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) {
      continue;
    }

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    let rawDomain = parts[0];
    let httpOnly = false;
    if (rawDomain.startsWith('#HttpOnly_')) {
      httpOnly = true;
      rawDomain = rawDomain.substring('#HttpOnly_'.length);
    }

    const flag = parts[1].toUpperCase() === 'TRUE';
    const cookiePath = parts[2];
    const secure = parts[3].toUpperCase() === 'TRUE';
    const expires = parseInt(parts[4], 10) || 0;
    const name = parts[5];
    const value = parts.slice(6).join('\t');

    cookies.push({
      domain: rawDomain,
      flag,
      path: cookiePath,
      secure,
      expires,
      name,
      value,
      httpOnly,
    });
  }

  return cookies;
}

/**
 * Validates YouTube authentication cookies against required tokens.
 */
export function validateYouTubeAuthCookies(
  cookies: Array<{ name: string; domain?: string; expires?: number }>
): CookieValidationResult {
  const now = Math.floor(Date.now() / 1000);
  const cookieMap = new Map<string, { expires?: number }>();
  const expiredCookies: string[] = [];

  for (const c of cookies) {
    cookieMap.set(c.name, c);
    if (c.expires && c.expires > 0 && c.expires < now) {
      expiredCookies.push(c.name);
    }
  }

  const foundAuthCookies: string[] = [];
  const missingAuthCookies: string[] = [];

  if (cookieMap.has('LOGIN_INFO')) {
    foundAuthCookies.push('LOGIN_INFO');
  } else {
    missingAuthCookies.push('LOGIN_INFO');
  }

  const sidCandidates = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID', 'SID', 'SSID'];
  const matchedSid = sidCandidates.filter((name) => cookieMap.has(name));

  if (matchedSid.length > 0) {
    foundAuthCookies.push(...matchedSid);
  } else {
    missingAuthCookies.push('SAPISID / __Secure-3PAPISID / SID');
  }

  const hasLoginInfo = cookieMap.has('LOGIN_INFO');
  const hasSid = matchedSid.length > 0;

  const loginInfoExpired =
    cookieMap.has('LOGIN_INFO') &&
    (cookieMap.get('LOGIN_INFO')?.expires ?? 0) > 0 &&
    (cookieMap.get('LOGIN_INFO')?.expires ?? 0) < now;

  let valid = false;
  let reason: string | undefined;

  if (!hasLoginInfo) {
    reason = 'Missing LOGIN_INFO cookie (not logged in)';
  } else if (!hasSid) {
    reason = 'Missing SAPISID / __Secure-3PAPISID / SID auth tokens';
  } else if (loginInfoExpired) {
    reason = 'LOGIN_INFO cookie has expired';
  } else {
    valid = true;
  }

  return {
    valid,
    reason,
    foundAuthCookies,
    missingAuthCookies,
    expiredCookies,
  };
}

/**
 * Merges a fresh browser export with the existing cookie file.
 *
 * The browser export is the source of truth for every cookie it contains,
 * but exports can be incomplete (e.g. captured before YouTube lazily issued
 * LOGIN_INFO). A full overwrite would then destroy still-valid auth tokens
 * that are simply absent from this export. Merge rule:
 *   - cookie present in the fresh export  -> fresh value wins (covers rotation);
 *   - cookie missing from the export     -> kept only while unexpired;
 *   - expired cookies                    -> dropped.
 */
async function mergeWithExistingCookies(filePath: string, cookies: CDPCookie[]): Promise<CDPCookie[]> {
  let existing: ParsedCookie[] = [];
  try {
    existing = parseNetscapeCookies(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return cookies; // no previous file — nothing to preserve
  }
  if (existing.length === 0) return cookies;

  const now = Math.floor(Date.now() / 1000);
  const freshCookieMap = new Map<string, CDPCookie>();
  for (const c of cookies) {
    freshCookieMap.set(`${c.domain}|${c.path}|${c.name}`, c);
  }
  const preserved: CDPCookie[] = [];
  const authCookieNames = new Set([
    'LOGIN_INFO',
    'SID',
    'SSID',
    'HSID',
    'APISID',
    'SAPISID',
    '__Secure-3PAPISID',
    '__Secure-1PAPISID',
    '__Secure-3PSID',
    '__Secure-1PSID',
  ]);

  for (const old of existing) {
    const key = `${old.domain}|${old.path}|${old.name}`;
    const fresh = freshCookieMap.get(key);

    if (fresh) {
      // If the fresh cookie has an empty/blank value but the old one is valid, keep the old one!
      if (!fresh.value && old.value && (old.expires <= 0 || old.expires > now)) {
        preserved.push({
          name: old.name,
          value: old.value,
          domain: old.domain,
          path: old.path,
          expires: old.expires,
          size: old.value.length,
          httpOnly: old.httpOnly,
          secure: old.secure,
          session: old.expires <= 0,
        });
        freshCookieMap.delete(key);
      }
      continue;
    }

    // Missing from fresh export: keep unexpired cookies
    if (old.expires > 0 && old.expires <= now) continue; // expired
    preserved.push({
      name: old.name,
      value: old.value,
      domain: old.domain,
      path: old.path,
      expires: old.expires,
      size: old.value.length,
      httpOnly: old.httpOnly,
      secure: old.secure,
      session: old.expires <= 0,
    });
  }

  if (preserved.length > 0) {
    const authKept = preserved.filter((c) =>
      ['LOGIN_INFO', 'SID', 'SSID', 'HSID', 'APISID', 'SAPISID'].includes(c.name)
    ).length;
    console.log(
      `[cookies] merged with existing file: preserved ${preserved.length} unexpired cookie(s)` +
        (authKept > 0 ? ` (${authKept} auth token(s) absent from the fresh export)` : '') +
        `, refreshed ${cookies.length}`
    );
  }

  return [...cookies, ...preserved];
}

/**
 * Saves formatted cookies to file atomically, preserving still-valid cookies
 * from the previous file that the fresh export did not include.
 */
export async function saveCookiesToFile(filePath: string, cookies: CDPCookie[]): Promise<void> {
  const merged = await mergeWithExistingCookies(filePath, cookies);
  const content = formatCookiesToNetscape(merged);
  const targetDir = path.dirname(filePath);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Performs a 2-stage verification of YouTube cookies.
 */
export async function verifyCookies(
  cookieFilePath: string,
  options: { skipLiveTest?: boolean; testUrl?: string; verbose?: boolean; proxyUrl?: string } = {}
): Promise<ComprehensiveVerificationResult> {
  try {
    const stat = await fs.stat(cookieFilePath);
    if (stat.size === 0) {
      return {
        valid: false,
        stage: 'file_check',
        reason: 'Cookie file exists but is empty (0 bytes).',
      };
    }
  } catch {
    return {
      valid: false,
      stage: 'file_check',
      reason: `Cookie file does not exist at ${cookieFilePath}.`,
    };
  }

  let content: string;
  try {
    content = await fs.readFile(cookieFilePath, 'utf-8');
  } catch (err: any) {
    return {
      valid: false,
      stage: 'file_check',
      reason: `Failed to read cookie file: ${err.message}`,
    };
  }

  const parsedCookies = parseNetscapeCookies(content);
  if (parsedCookies.length === 0) {
    return {
      valid: false,
      stage: 'static_tokens',
      reason: 'No valid Netscape format cookies found in file.',
    };
  }

  const staticCheck = validateYouTubeAuthCookies(parsedCookies);
  if (!staticCheck.valid) {
    return {
      valid: false,
      stage: 'static_tokens',
      reason: staticCheck.reason || 'Missing required YouTube authentication cookies.',
      foundAuthTokens: staticCheck.foundAuthCookies,
      missingAuthTokens: staticCheck.missingAuthCookies,
      expiredTokens: staticCheck.expiredCookies,
    };
  }

  if (options.skipLiveTest) {
    return {
      valid: true,
      stage: 'static_tokens',
      reason: 'Static authentication cookies present and unexpired (live test skipped).',
      foundAuthTokens: staticCheck.foundAuthCookies,
    };
  }

  try {
    const ytDlpPath = await ensureYtDlp();
    const liveResult = await verifyCookiesWithYtDlp(ytDlpPath, cookieFilePath, options.testUrl, options.proxyUrl);

    if (!liveResult.usable) {
      return {
        valid: false,
        stage: 'ytdlp_live',
        reason: liveResult.reason,
        ytDlpResult: liveResult,
      };
    }

    return {
      valid: true,
      stage: 'ytdlp_live',
      reason: 'Cookies are valid and authenticated according to yt-dlp.',
      foundAuthTokens: staticCheck.foundAuthCookies,
      ytDlpResult: liveResult,
    };
  } catch (err: any) {
    return {
      valid: false,
      stage: 'ytdlp_live',
      reason: `yt-dlp verification check failed: ${err.message}`,
    };
  }
}
