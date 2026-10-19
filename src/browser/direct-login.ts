import type { Page } from 'playwright-core';
import pc from 'picocolors';

export async function performDirectGoogleLogin(page: Page): Promise<boolean> {
  try {
    const isFlowFlow =
      page.url().includes('flow.google.com') ||
      page.url().includes('continue=https%3A%2F%2Fflow.google.com');

    if (!isFlowFlow && !page.url().includes('accounts.google.com')) {
      // 1. Clear stale origin storage to completely eliminate CookieMismatch for YouTube
      try {
        const client = await page.context().newCDPSession(page);
        await client.send('Storage.clearDataForOrigin', { origin: 'https://accounts.google.com', storageTypes: 'all' });
        await client.send('Storage.clearDataForOrigin', { origin: 'https://www.youtube.com', storageTypes: 'all' });
        await client.detach();
      } catch {}

      console.log(pc.cyan('  [direct-login] Navigating to Google / YouTube ServiceLogin...'));
      await page.goto(
        'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
        { waitUntil: 'domcontentloaded', timeout: 25_000 }
      ).catch(() => {});
      await page.waitForTimeout(2500);
    } else {
      console.log(pc.cyan(`  [direct-login] Handling sign-in on current page (${isFlowFlow ? 'Google Flow' : 'Google Accounts'})...`));
    }

    // 2. Email input
    const emailInput = await page.$('input[type="email"], input[name="identifier"]');
    if (emailInput && (await emailInput.isVisible())) {
      const email = process.env.GOOGLE_LOGIN_EMAIL?.trim() || 'jadepot@gmail.com';
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
    const chooser = await page.$(
      'div[data-identifier="jadepot@gmail.com"], li:has-text("jadepot@gmail.com"), div[role="link"]:has-text("jadepot@gmail.com")'
    );
    if (chooser && (await chooser.isVisible())) {
      console.log(pc.dim('  [direct-login] Clicking remembered account from chooser...'));
      await chooser.click();
      await page.waitForTimeout(2000);
    }

    // 4. Password input
    const pwdSelector = 'input[name="Passwd"], input[type="password"]';
    await page.waitForSelector(pwdSelector, { state: 'visible', timeout: 10_000 }).catch(() => {});
    const pwdInput = await page.$(pwdSelector);

    if (pwdInput && (await pwdInput.isVisible())) {
      const pwd = process.env.GOOGLE_LOGIN_PWD?.trim() || 'Gpt#Coding@852';
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

    if (isFlowFlow) {
      // Google Flow sign-in handling
      console.log(pc.dim('  [direct-login] Verifying Google Flow authentication...'));
      for (let attempt = 0; attempt < 15; attempt++) {
        await page.waitForTimeout(1000);
        if (page.url().includes('flow.google.com') && !page.url().includes('accounts.google.com')) {
          console.log(pc.green('  ✓ [direct-login] Successfully landed on Google Flow!'));
          return true;
        }
      }
      return page.url().includes('flow.google.com');
    }

    // 5. Navigate to YouTube and poll for login cookies
    console.log(pc.dim('  [direct-login] Ensuring YouTube session is activated...'));
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});

    // Poll up to 15 seconds for LOGIN_INFO / SAPISID to arrive
    for (let attempt = 0; attempt < 15; attempt++) {
      await page.waitForTimeout(1000);
      const cookies = await page.context().cookies(['https://www.youtube.com', 'https://accounts.google.com']);
      const hasLoginInfo = cookies.some((c) => c.name === 'LOGIN_INFO');
      const hasSid = cookies.some((c) => c.name === 'SAPISID' || c.name === 'SID');
      if (hasLoginInfo && hasSid) {
        console.log(pc.green('  ✓ [direct-login] Successfully obtained LOGIN_INFO & SAPISID cookies!'));
        return true;
      }
      // Nudge YouTube to issue LOGIN_INFO if on homepage
      if (attempt === 3 || attempt === 8) {
        await page.evaluate(() => {
          fetch('https://www.youtube.com/youtubei/v1/account/account_menu', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: (window as any).ytcfg?.get?.('INNERTUBE_CONTEXT') || {} }),
          }).catch(() => {});
        });
      }
    }

    const finalCookies = await page.context().cookies(['https://www.youtube.com']);
    const finalHasLogin = finalCookies.some((c) => c.name === 'LOGIN_INFO');
    return finalHasLogin;
  } catch (err: any) {
    console.log(pc.yellow(`  [direct-login] Failed: ${err.message}`));
    return false;
  }
}
