import pc from 'picocolors';
import type { Page } from 'playwright-core';
import { sendMsg } from '../../utils/send_msg.js';
import { loadEnvFile } from '../../utils/env.js';
import { performDirectGoogleLogin } from './direct-login.js';

loadEnvFile();

export function parseGooglePassword(raw?: string | null): string | null {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts and sanitizes Google login password from process.env.GOOGLE_LOGIN_PWD.
 * Strips enclosing quotes (double or single) and trims whitespace.
 */
export function getSanitizedGoogleLoginPassword(): string | null {
  loadEnvFile();
  return parseGooglePassword(process.env.GOOGLE_LOGIN_PWD);
}

export interface AutoSignInResult {
  attempted: boolean;
  success?: boolean;
  captchaDetected?: boolean;
  message?: string;
}

/**
 * Checks if the page or any iframe presents a CAPTCHA, bot challenge, or 2FA verification.
 */
export async function detectHumanVerificationOrCaptcha(page: Page): Promise<{ detected: boolean; reason?: string }> {
  try {
    const url = page.url();

    // Check challenge URL paths (excluding normal password entry)
    if (
      url.includes('accounts.google.com') &&
      (url.includes('/challenge/recaptcha') ||
        url.includes('/challenge/selection') ||
        url.includes('/challenge/totp') ||
        url.includes('/challenge/ipp') ||
        url.includes('/challenge/iap') ||
        url.includes('/challenge/az') ||
        url.includes('/challenge/kpp'))
    ) {
      return { detected: true, reason: `Google security challenge detected in URL: ${url}` };
    }

    if (url.includes('google.com/sorry')) {
      return { detected: true, reason: 'Google "unusual traffic" / sorry page detected' };
    }

    // Check DOM elements
    const domCheck = await page.evaluate(() => {
      function isVisible(el: HTMLElement | null): boolean {
        if (!el) return false;
        if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      // 1. Visible CAPTCHA text input
      const caInput = document.querySelector('input#ca, input[name="ca"]') as HTMLElement | null;
      if (caInput && isVisible(caInput)) {
        return { detected: true, reason: 'CAPTCHA image text input displayed' };
      }

      // 2. Visible CAPTCHA image challenge
      const captchaImg = document.querySelector('#captchaimg, img[src*="Captcha" i]') as HTMLElement | null;
      if (captchaImg && isVisible(captchaImg)) {
        const src = (captchaImg as HTMLImageElement).src || captchaImg.getAttribute('src');
        if (src && src.trim().length > 0) {
          return { detected: true, reason: 'Visible CAPTCHA image displayed in DOM' };
        }
      }

      // 3. Visible interactive reCAPTCHA iframe
      // Note: Google pages often embed invisible reCAPTCHA Enterprise iframe (width/height <= 1 or hidden)
      // which is NOT an interactive challenge. We must check for visible dimensions.
      const iframes = Array.from(document.querySelectorAll('iframe')) as HTMLElement[];
      for (const iframe of iframes) {
        const src = iframe.getAttribute('src') || '';
        if (/recaptcha|captcha/i.test(src)) {
          if (isVisible(iframe)) {
            const rect = iframe.getBoundingClientRect();
            if (rect.width >= 50 && rect.height >= 50) {
              return { detected: true, reason: 'Interactive reCAPTCHA challenge displayed in DOM' };
            }
          }
        }
      }

      // If a standard password input is visible and ready, this is a normal password entry step,
      // not a blocked human verification page.
      const pwdInput = document.querySelector('input[type="password"]') as HTMLElement | null;
      const isPwdVisible = pwdInput && isVisible(pwdInput);

      // Specific Google challenge text indicators
      const text = document.body ? document.body.innerText : '';
      if (!isPwdVisible) {
        if (/verify it's you|verify that it's you|confirm you're not a robot/i.test(text)) {
          return { detected: true, reason: 'Google "Verify it\'s you" challenge displayed' };
        }
        if (/2-step verification|check your phone|enter the code/i.test(text) && !/stay signed in/i.test(text)) {
          return { detected: true, reason: '2-Step Verification prompt displayed' };
        }
        if (/真人校验|安全验证|输入验证码|进行人机身份验证/.test(text)) {
          return { detected: true, reason: '人机验证 / 2FA 提示出现' };
        }
      }

      return { detected: false };
    });

    if (domCheck.detected) {
      return domCheck;
    }

    return { detected: false };
  } catch {
    return { detected: false };
  }
}

/**
 * Sends a Telegram webhook alert when CAPTCHA or human verification is encountered.
 */
export async function notifyCaptchaWebhook(details: { url: string; reason?: string }): Promise<void> {
  const alertMsg =
    '⚠️ 【VideoGen 提示】YouTube/Google 登录遇到真人校验/验证码 (CAPTCHA/2FA)！\n' +
    `• 原因: ${details.reason || '检测到人机校验或二次安全验证'}\n` +
    `• 当前 URL: ${details.url}\n` +
    '• 请在 Chromium 浏览器窗口中手动完成人机验证或安全确认，完成后流水线将自动继续。';

  console.log(pc.yellow(`\n${alertMsg}\n`));
  try {
    await sendMsg(alertMsg);
  } catch (err: any) {
    console.error(pc.yellow(`[webhook] Failed to send CAPTCHA notification: ${err?.message || err}`));
  }
}

/**
 * Automates clicking the YouTube "Sign in" button, selecting remembered account,
 * entering the Google password from GOOGLE_LOGIN_PWD, and monitoring for CAPTCHA/challenges.
 */
export async function attemptGoogleAutoSignIn(
  page: Page,
  password?: string | null
): Promise<AutoSignInResult> {
  const pwd = password ?? getSanitizedGoogleLoginPassword();
  if (!pwd) {
    console.log(pc.dim('  [auto-signin] GOOGLE_LOGIN_PWD not configured or empty — skipping automated sign-in.'));
    return { attempted: false, message: 'GOOGLE_LOGIN_PWD not configured' };
  }

  console.log(pc.cyan('🤖 Attempting automated Google / YouTube sign-in...'));

  try {
    // Primary path: attempt direct robust navigation and login
    const directOk = await performDirectGoogleLogin(page);
    if (directOk) {
      return { attempted: true, success: true };
    }

    // Check if CAPTCHA or 2FA was encountered
    const captchaCheck = await detectHumanVerificationOrCaptcha(page);
    if (captchaCheck.detected) {
      await notifyCaptchaWebhook({ url: page.url(), reason: captchaCheck.reason });
      return { attempted: true, captchaDetected: true, message: captchaCheck.reason };
    }

    return { attempted: true, success: false, message: 'Direct login did not acquire valid tokens' };
  } catch (err: any) {
    console.log(pc.yellow(`  [auto-signin] Auto sign-in encountered error: ${err?.message || err}`));
    return { attempted: true, success: false, message: err?.message };
  }
}

