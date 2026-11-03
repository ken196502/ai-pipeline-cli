import type { Page } from 'playwright-core';
import pc from 'picocolors';

export async function performDirectGoogleLogin(page: Page): Promise<boolean> {
  try {
    const isFlowFlow =
      page.url().includes('flow.google.com') ||
      page.url().includes('continue=https%3A%2F%2Fflow.google.com');
    const email = process.env.GOOGLE_LOGIN_EMAIL?.trim();
    const isChallengePage = async (): Promise<boolean> => {
      // Google's own password step lives at /challenge/pwd — that is the normal
      // sign-in form, not a challenge we must abort on. Only other challenge
      // routes (totp/dp/ipp/...) require human interaction.
      if (page.url().includes('/challenge/') && !page.url().includes('/challenge/pwd')) return true;
      const challenge = await page.$('#totpPin, [data-challengeid]');
      return challenge !== null && await challenge.isVisible();
    };
    const reportChallenge = (): void => {
      console.log(pc.yellow(`  [direct-login] 需要二次验证/挑战页，自动登录无法继续（当前 URL: ${page.url()}）`));
    };

    if (!isFlowFlow && !page.url().includes('accounts.google.com')) {
      if (await isChallengePage()) {
        reportChallenge();
        return false;
      }
      // 1. Clear stale origin storage to completely eliminate CookieMismatch for YouTube
      const cookies = await page.context().cookies(['https://www.youtube.com', 'https://accounts.google.com']);
      if (cookies.some((c) => c.name === 'SAPISID' || c.name === 'SID' || c.name === 'LOGIN_INFO')) {
        console.log(pc.dim('  [direct-login] 检测到已有认证 cookie，跳过破坏性清理'));
      } else {
        const client = await page.context().newCDPSession(page);
        try {
          await client.send('Storage.clearDataForOrigin', { origin: 'https://accounts.google.com', storageTypes: 'all' });
          await client.send('Storage.clearDataForOrigin', { origin: 'https://www.youtube.com', storageTypes: 'all' });
        } finally {
          await client.detach();
        }
      }

      console.log(pc.cyan('  [direct-login] Navigating to Google / YouTube ServiceLogin...'));
      await page.goto(
        'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
        { waitUntil: 'domcontentloaded', timeout: 25_000 }
      );
      await page.waitForTimeout(2500);
    } else {
      console.log(pc.cyan(`  [direct-login] Handling sign-in on current page (${isFlowFlow ? 'Google Flow' : 'Google Accounts'})...`));
    }

    // 2. Email input
    const emailInput = await page.$('input[type="email"], input[name="identifier"]');
    if (emailInput && (await emailInput.isVisible())) {
      if (!email) {
        console.log(pc.yellow('  [direct-login] Email input requires GOOGLE_LOGIN_EMAIL, but it is not configured'));
        return false;
      }
      console.log(pc.dim(`  [direct-login] Entering email (${email})...`));
      await emailInput.fill(email);
      await page.waitForTimeout(400);
      const nextBtn = await page.$('button:has-text("Next"), #identifierNext');
      if (nextBtn) {
        await nextBtn.click();
      } else {
        await emailInput.press('Enter');
      }
      await page.waitForTimeout(2000);
    }

    // 3. Account chooser item if email was not prompted
    const chooser = email ? await page.$(
      `div[data-identifier=${JSON.stringify(email)}], li:has-text(${JSON.stringify(email)}), div[role="link"]:has-text(${JSON.stringify(email)})`
    ) : null;
    if (chooser && (await chooser.isVisible())) {
      console.log(pc.dim('  [direct-login] Clicking remembered account from chooser...'));
      await chooser.click();
    }

    // 4. Password input
    const pwdSelector = 'input[name="Passwd"], input[type="password"]';
    const passwordDeadline = Date.now() + 15_000;
    let pwdInput = null;
    while (Date.now() < passwordDeadline) {
      const candidate = await page.$(pwdSelector);
      if (candidate && await candidate.isVisible()) {
        pwdInput = candidate;
        break;
      }
      if (await isChallengePage()) {
        reportChallenge();
        return false;
      }
      await page.waitForTimeout(250);
    }
    if (!pwdInput) {
      console.log(pc.yellow(`  [direct-login] 未出现密码框也未出现挑战页（当前 URL: ${page.url()}）`));
      return false;
    }

    if (pwdInput) {
      const pwd = process.env.GOOGLE_LOGIN_PWD?.trim();
      if (!pwd) {
        console.log(pc.yellow('  [direct-login] Password input requires GOOGLE_LOGIN_PWD, but it is not configured'));
        return false;
      }
      console.log(pc.dim('  [direct-login] Entering password...'));
      await pwdInput.fill(pwd);
      await page.waitForTimeout(400);
      const nextBtn = await page.$('#passwordNext button, button:has-text("Next"), #passwordNext');
      if (nextBtn) {
        await nextBtn.click();
      } else {
        await pwdInput.press('Enter');
      }
      console.log(pc.dim(`  [direct-login] Submitted password, awaiting landing (${isFlowFlow ? 'Flow' : 'YouTube'})...`));
      await page.waitForTimeout(5000);
    }

    if (await isChallengePage()) {
      reportChallenge();
      return false;
    }

    if (isFlowFlow) {
      // Google Flow sign-in handling
      console.log(pc.dim('  [direct-login] Verifying Google Flow authentication...'));
      for (let attempt = 0; attempt < 15; attempt++) {
        await page.waitForTimeout(1000);
        if (await isChallengePage()) {
          reportChallenge();
          return false;
        }
        if (page.url().includes('flow.google.com') && !page.url().includes('accounts.google.com')) {
          console.log(pc.green('  ✓ [direct-login] Successfully landed on Google Flow!'));
          return true;
        }
      }
      console.log(pc.yellow(`  [direct-login] Google Flow authentication did not land within 15s (current URL: ${page.url()})`));
      return false;
    }

    // 5. Navigate to YouTube and poll for login cookies
    console.log(pc.dim('  [direct-login] Ensuring YouTube session is activated...'));
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Poll up to 15 seconds for LOGIN_INFO / SAPISID to arrive
    for (let attempt = 0; attempt < 15; attempt++) {
      await page.waitForTimeout(1000);
      if (await isChallengePage()) {
        reportChallenge();
        return false;
      }
      const cookies = await page.context().cookies(['https://www.youtube.com', 'https://accounts.google.com']);
      const hasLoginInfo = cookies.some((c) => c.name === 'LOGIN_INFO');
      const hasSid = cookies.some((c) => c.name === 'SAPISID' || c.name === 'SID');
      if (hasLoginInfo && hasSid) {
        console.log(pc.green('  ✓ [direct-login] Successfully obtained LOGIN_INFO & SAPISID cookies!'));
        return true;
      }
      // Nudge YouTube to issue LOGIN_INFO if on homepage
      if (attempt === 3 || attempt === 8) {
        await page.evaluate(async () => {
          const context = (window as any).ytcfg?.get?.('INNERTUBE_CONTEXT');
          if (!context) throw new Error('YouTube INNERTUBE_CONTEXT is unavailable for session activation');
          const response = await fetch('https://www.youtube.com/youtubei/v1/account/account_menu', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context }),
          });
          if (!response.ok) throw new Error(`YouTube session activation failed: HTTP ${response.status}`);
        });
      }
    }

    const finalCookies = await page.context().cookies(['https://www.youtube.com', 'https://accounts.google.com']);
    const missingCookies = [];
    if (!finalCookies.some((c) => c.name === 'LOGIN_INFO')) missingCookies.push('LOGIN_INFO');
    if (!finalCookies.some((c) => c.name === 'SAPISID' || c.name === 'SID')) missingCookies.push('SAPISID/SID');
    console.log(pc.yellow(`  [direct-login] YouTube authentication timed out after 15s; missing cookies: ${missingCookies.join(', ')} (current URL: ${page.url()})`));
    return false;
  } catch (err: any) {
    console.log(pc.yellow(`  [direct-login] Failed: ${err instanceof Error ? err.message : String(err)} (current URL: ${page.url()})`));
    return false;
  }
}
