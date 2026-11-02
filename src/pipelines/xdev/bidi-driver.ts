import { remote, type Browser } from 'webdriverio';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface FirefoxBiDiClientOptions {
  firefoxBinary?: string;
  headless?: boolean;
  cookiesPath?: string;
}

export class FirefoxBiDiDriver {
  private browser: Browser | null = null;
  private options: FirefoxBiDiClientOptions;

  constructor(options: FirefoxBiDiClientOptions = {}) {
    this.options = {
      firefoxBinary: options.firefoxBinary || '/usr/bin/firefox-esr',
      headless: options.headless ?? true,
      cookiesPath: options.cookiesPath || 'x_cookies.json',
    };
  }

  async launch(): Promise<Browser> {
    const args = ['--width=1280', '--height=900'];
    if (this.options.headless) {
      args.unshift('-headless');
    }

    const prefs: Record<string, any> = {
      'network.proxy.type': 1,
      'network.proxy.http': '127.0.0.1',
      'network.proxy.http_port': 7890,
      'network.proxy.ssl': '127.0.0.1',
      'network.proxy.ssl_port': 7890,
    };

    this.browser = await remote({
      automationProtocol: 'webdriver',
      capabilities: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          binary: this.options.firefoxBinary,
          args,
          prefs,
        },
        webSocketUrl: true, // Enable Webdriver BiDi protocol
      },
      logLevel: 'error',
    });

    return this.browser;
  }

  /**
   * Refresh x_cookies.json from the live Firefox ESR profile SQLite database.
   * This ensures auth_token / ct0 / cf_clearance are always current, avoiding
   * the Cloudflare "Just a moment…" bot-challenge screen that occurs when
   * cookies are more than ~24–48 h stale.
   */
  private async refreshCookiesFromFirefoxProfile(cookiesFile: string): Promise<boolean> {
    try {
      const ffProfileDir = path.join(
        process.env.HOME || '/home/piagent',
        '.config/mozilla/firefox',
      );
      // Find the first default-esr or default profile
      let profileSubdir: string | null = null;
      try {
        const entries = await fs.readdir(ffProfileDir);
        // Prefer .default-esr over .default; pick the profile whose cookies.sqlite
        // actually contains an x.com auth_token cookie.
        const candidates = entries.filter((e) =>
          e.endsWith('.default-esr') || e.endsWith('.default')
        );
        // Sort: default-esr first
        candidates.sort((a, b) =>
          (b.endsWith('.default-esr') ? 1 : 0) - (a.endsWith('.default-esr') ? 1 : 0)
        );
        for (const candidate of candidates) {
          const sqlitePath = path.join(ffProfileDir, candidate, 'cookies.sqlite');
          try {
            await fs.access(sqlitePath);
            profileSubdir = candidate;
            break;
          } catch { /* no cookies.sqlite in this profile */ }
        }
        if (!profileSubdir && candidates.length > 0) profileSubdir = candidates[0];
      } catch { /* no firefox profile dir */ }

      if (!profileSubdir) return false;

      const sqliteSrc = path.join(ffProfileDir, profileSubdir, 'cookies.sqlite');
      const sqliteTmp = '/tmp/ff_cookies_xdev.sqlite';
      // Copy to /tmp to avoid WAL lock from running Firefox
      await fs.copyFile(sqliteSrc, sqliteTmp);

      // Use Python sqlite3 (always available) to extract x.com cookies
      const script = [
        'import sqlite3,json',
        `conn=sqlite3.connect('${sqliteTmp}')`,
        `rows=conn.execute("SELECT name,value,host,path,isSecure,isHttpOnly,expiry FROM moz_cookies WHERE host LIKE '%x.com' OR host LIKE '%twitter.com'").fetchall()`,
        'conn.close()',
        'cookies=[{"name":r[0],"value":r[1],"domain":r[2],"path":r[3],"secure":bool(r[4]),"httpOnly":bool(r[5]),"expiry":r[6]} for r in rows]',
        `print(json.dumps(cookies))`,
      ].join('\n');

      // NOTE: must run from a FILE, not `python3 -c "..."`. JSON.stringify turns the
      // newlines into literal `\n` inside a double-quoted shell string, which bash
      // does not expand — python then receives a single line with stray `\n` and dies
      // with a SyntaxError (observed: cookie refresh silently failing -> stale cookies
      // -> Cloudflare challenge -> empty Grok response).
      const scriptPath = `/tmp/xdev_ff_cookies_${process.pid}.py`;
      await fs.writeFile(scriptPath, script, 'utf-8');
      let result: string;
      try {
        result = execSync(`python3 ${scriptPath}`, { timeout: 15000 }).toString().trim();
      } finally {
        await fs.unlink(scriptPath).catch(() => {});
      }
      const freshCookies = JSON.parse(result);

      if (!Array.isArray(freshCookies) || freshCookies.length === 0) return false;

      // Verify auth_token is present and non-empty
      const hasAuth = freshCookies.some((c: any) => c.name === 'auth_token' && c.value);
      if (!hasAuth) {
        console.warn('[cookies] Firefox profile cookies found but no auth_token — skipping refresh');
        return false;
      }

      await fs.writeFile(cookiesFile, JSON.stringify(freshCookies, null, 2), 'utf-8');
      console.log(`[cookies] ✔ Refreshed ${freshCookies.length} x.com cookies from Firefox ESR profile`);
      return true;
    } catch (err: any) {
      // Loud, and fatal when the on-disk cookie file is too stale to be trusted:
      // a silent fallback here only resurfaces 6 minutes later as an opaque
      // "empty Grok response".
      const msg = err?.message || String(err);
      let ageHours = Infinity;
      try {
        const st = await fs.stat(cookiesFile);
        ageHours = (Date.now() - st.mtimeMs) / 3_600_000;
      } catch {
        /* no cookie file at all -> ageHours stays Infinity */
      }
      console.error(`[cookies] ✗ Could not refresh from Firefox profile: ${msg}`);
      if (ageHours > 12) {
        throw new Error(
          `[cookies] Cookie refresh failed and ${path.basename(cookiesFile)} is ${ageHours === Infinity ? 'missing' : ageHours.toFixed(1) + 'h old'}. ` +
            `Refusing to start an unauthenticated X session: ${msg}`
        );
      }
      console.warn(`[cookies] Falling back to existing cookies (${ageHours.toFixed(1)}h old) — refresh error above must be fixed.`);
      return false;
    }
  }

  async injectCookies(domainTarget = 'https://x.com'): Promise<number> {
    if (!this.browser) {
      throw new Error('Browser is not initialized. Call launch() first.');
    }

    const cookiesFile = path.resolve(process.cwd(), this.options.cookiesPath || 'x_cookies.json');

    // Always try to refresh cookies from the live Firefox ESR profile first
    await this.refreshCookiesFromFirefoxProfile(cookiesFile);

    let rawData: string;
    try {
      rawData = await fs.readFile(cookiesFile, 'utf-8');
    } catch {
      // Fallback check parent or other known location
      const fallback = path.resolve(process.cwd(), 'cookies.txt');
      rawData = await fs.readFile(fallback, 'utf-8').catch(() => '[]');
    }

    let count = 0;
    try {
      const cookies = JSON.parse(rawData);
      if (Array.isArray(cookies)) {
        await this.browser.url(domainTarget);
        for (const c of cookies) {
          if (!c.name || !c.value) continue;
          try {
            await this.browser.setCookies({
              name: c.name,
              value: c.value,
              // Keep the leading dot. Stripping it turns the cookie host-only for
              // `x.com`, so media uploads to `upload.x.com` arrive without
              // auth_token/ct0 and fail with 401 "Could not authenticate you."
              domain: c.domain || undefined,
              path: c.path || '/',
              secure: Boolean(c.secure),
              httpOnly: Boolean(c.httpOnly),
            });
            count++;
          } catch {
            // ignore individual cookie rejection
          }
        }
      }
    } catch (err) {
      console.warn('Could not parse cookie JSON:', err);
    }

    return count;
  }

  async fetchArticleContent(url: string): Promise<{ title: string; content: string; excerpt: string }> {
    if (!this.browser) throw new Error('Browser not active');
    try {
      await this.browser.url(url);
      await this.browser.pause(3000);
      const title = await this.browser.getTitle().catch(() => '');
      
      const bodyText = await this.browser.execute(() => {
        const article = document.querySelector('article') || document.querySelector('main') || document.body;
        const paragraphs = Array.from(article.querySelectorAll('p, h1, h2, h3, li'));
        const texts = paragraphs
          .map((p) => (p.textContent || '').trim())
          .filter((t) => t.length > 20);
        return texts.join('\n\n');
      }).catch(() => '');

      const excerpt = bodyText.slice(0, 500);
      return {
        title,
        content: bodyText.slice(0, 4000),
        excerpt,
      };
    } catch (err: any) {
      return {
        title: '',
        content: `Error loading URL: ${err?.message || err}`,
        excerpt: '',
      };
    }
  }

  /**
   * Ask Grok on x.com and return its full live answer.
   *
   * The Grok page is a heavy React SPA: after navigation it renders a spinner for
   * 10-30 s and may first show a full-screen ToS sheet inside `div#layers`. Fixed
   * sleeps are not enough — we poll until the input really exists.
   */
  async askGrok(prompt: string): Promise<string> {
    if (!this.browser) throw new Error('Browser not active');
    const browser = this.browser;

    console.log('[askGrok] Navigating to x.com/i/grok...');
    await browser.url('https://x.com/i/grok');

    const INPUT_SELECTOR =
      '[role="textbox"][aria-label="Ask anything"], [role="textbox"][contenteditable="true"], textarea[aria-label*="Ask"]';

    let inputEl: any = null;
    const inputDeadline = Date.now() + 60_000;
    while (Date.now() < inputDeadline) {
      await browser.pause(1500);

      // The Grok ToS / "Agree and continue" sheet lives inside div#layers. Clicking
      // buttons alone is unreliable (the overlay stays mounted and swallows pointer
      // events), so accept the ToS and then drop the layer node itself.
      const removed = await browser
        .execute(() => {
          const layers = document.getElementById('layers');
          if (!layers) return false;
          const btn = Array.from(layers.querySelectorAll('button, div[role="button"]')).find((b) =>
            /agree and continue|not now|accept|got it/i.test((b.textContent || '').trim())
          ) as HTMLElement | undefined;
          if (btn) btn.click();
          layers.remove();
          return true;
        })
        .catch(() => false);
      if (removed) console.log('[askGrok] Dismissed #layers overlay');

      const candidate = await browser.$(INPUT_SELECTOR);
      const exists = await candidate.isExisting().catch(() => false);
      const displayed = exists ? await candidate.isDisplayed().catch(() => false) : false;
      if (exists && displayed) {
        inputEl = candidate;
        break;
      }
    }

    if (!inputEl) {
      const title = await browser.getTitle().catch(() => '');
      throw new Error(
        `[askGrok] Grok input box not found on x.com/i/grok after 60s (page title: "${title}"). ` +
          'Stale cookies, a Cloudflare challenge, or a Grok DOM change is the usual cause.'
      );
    }
    console.log('[askGrok] Grok input box ready');

    // Snapshot the conversation that is already on screen, so an answer to a
    // PREVIOUS prompt can never be mistaken for the answer to this one.
    const baseline: string[] = await browser
      .execute(() => {
        const main = document.querySelector('[role="main"]') || document.body;
        return Array.from(main.querySelectorAll('div, p, span'))
          .map((el) => ((el as HTMLElement).innerText || el.textContent || '').trim())
          .filter((t) => t.length >= 80)
          .slice(0, 400);
      })
      .catch(() => []);
    const baselineSet = new Set(baseline);

    // Type with real key events: React's contenteditable ignores direct
    // .value / .textContent assignment.
    await inputEl.click({ button: 'left' } as any).catch(() => {});
    await browser.pause(500);
    await browser.keys(prompt.split(''));
    await browser.pause(800);

    const sendClicked = await browser
      .execute(() => {
        const btn = document.querySelector(
          'button[aria-label="Send"], button[aria-label*="Send prompt"], button[data-testid="sendMessage"]'
        ) as HTMLButtonElement | null;
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      })
      .catch(() => false);

    if (!sendClicked) {
      await browser.keys(['Enter']);
      console.log('[askGrok] Send button unavailable — submitted with Enter');
    } else {
      console.log('[askGrok] Prompt submitted via Send button');
    }

    console.log('[askGrok] Waiting for Grok response stream to complete...');

    const NOISE = [
      'One Grok, everywhere',
      'Ask anything',
      'You are using a free Grok',
      'Upgrade to Premium',
      'Add files, skills',
      'Select a model',
      'Shared links could not be loaded',
    ];
    const promptPrefix = prompt.slice(0, 40);
    let grokReply = '';
    let sawStopButton = false;
    let unchangedPollCount = 0;
    let lastLen = 0;

    // Polling up to 45 times * 2.5s = ~112s max timeout for live web search + thinking
    for (let poll = 0; poll < 45; poll++) {
      await browser.pause(2500);

      // 1. Check for quota exhaustion or account-level blocks immediately
      const limitReached = await browser
        .execute(() => {
          const bodyText = document.body.innerText || '';
          if (bodyText.includes('You have reached your Grok usage limit')) {
            return 'You have reached your Grok usage limit';
          }
          if (bodyText.includes('More Grok with Premium') && bodyText.includes('Upgrade for more access')) {
            return 'Grok usage limit reached (Upgrade for more access)';
          }
          return null;
        })
        .catch(() => null);

      if (limitReached) {
        throw new Error(
          `[askGrok] FATAL: Grok 使用额度已耗尽 (${limitReached})，无法完成学术与行业调研。严格 Fail-Fast 阻断，禁止假装成功瞒报！`
        );
      }

      // 2. Check generation state via Stop button or loading indicator
      const isGenerating = await browser
        .execute(() => {
          const stopBtn = document.querySelector(
            'button[aria-label="Stop"], [aria-label*="Stop" i], [data-testid*="stop" i], [aria-busy="true"], [data-testid*="loading" i]'
          );
          return Boolean(stopBtn);
        })
        .catch(() => false);

      if (isGenerating) {
        sawStopButton = true;
      }

      // 3. Extract the best candidate response
      const candidate: string = await browser
        .execute(
          (prefix: string, noise: string[]) => {
            // Priority 1: Check assistant message item inside transcript container
            const transcriptInner =
              document.querySelector(
                'div[class*="min-h-"][class*="space-y-"], div.space-y-4 > div[class*="space-y-"]'
              ) || document.querySelector('div.space-y-4');

            if (transcriptInner) {
              const children = Array.from(transcriptInner.children);
              // Find the assistant turn (usually non-user group)
              const assistantChild = children.find(
                (c) =>
                  !c.classList.contains('group/user') &&
                  !c.className.includes('items-end') &&
                  ((c as HTMLElement).innerText || '').trim().length > 50
              ) || children[children.length - 1];

              if (assistantChild) {
                const text = ((assistantChild as HTMLElement).innerText || '').trim();
                if (text.length >= 80 && !text.includes(prefix)) {
                  return text;
                }
              }
            }

            // Priority 2: Fallback to scanning elements in role="main" or body
            const main = document.querySelector('[role="main"]') || document.body;
            const texts = Array.from(main.querySelectorAll('div, p, span'))
              .map((el) => ((el as HTMLElement).innerText || el.textContent || '').trim())
              .filter((t) => {
                if (t.length < 80) return false;
                if (t.includes(prefix)) return false;
                if (/Shared links could not be loaded/i.test(t)) return false;
                if (/Upgrade to Premium/i.test(t)) return false;
                if (/You have reached your Grok/i.test(t)) return false;
                if (/More Grok with Premium/i.test(t)) return false;
                if (t.includes('@font-face')) return false;
                return !noise.some((n) => t.includes(n));
              })
              .sort((a, b) => b.length - a.length);
            return texts[0] || '';
          },
          promptPrefix,
          NOISE
        )
        .catch(() => '');

      // Accept only text that was NOT on screen before we asked.
      if (candidate && !baselineSet.has(candidate) && candidate.length > grokReply.length) {
        grokReply = candidate;
        console.log(`[askGrok] Poll ${poll + 1}: captured ${grokReply.length} chars`);
      }

      // Check whether generation is done:
      // Condition A: If stop button was seen and is now gone, and we have captured substantive response (> 150 chars)
      // Condition B: If length is substantial (> 200 chars) and hasn't changed for 3 consecutive polls (7.5s) and not generating
      if (grokReply.length === lastLen && grokReply.length > 150) {
        unchangedPollCount++;
      } else {
        unchangedPollCount = 0;
        lastLen = grokReply.length;
      }

      // Ensure that grokReply is not merely intermediate web search status
      // e.g., "Searched the web\nexample.com\n..."
      const isOnlySearchStatus =
        grokReply.startsWith('Searched') &&
        !grokReply.includes('Thought for') &&
        !/\n\n[^\n]{20,}/.test(grokReply) &&
        !/[，。：、]/.test(grokReply) &&
        grokReply.length < 800;

      if (sawStopButton && !isGenerating && grokReply.length > 200 && !isOnlySearchStatus) {
        console.log(`[askGrok] Generation finished (Stop button disappeared at Poll ${poll + 1})`);
        break;
      }

      if (!isGenerating && grokReply.length > 250 && unchangedPollCount >= 3 && !isOnlySearchStatus) {
        console.log(`[askGrok] Stream stabilized with ${grokReply.length} chars (Poll ${poll + 1})`);
        break;
      }
    }

    // Strip intermediate web-search status block if present at the top of the text,
    // but keep "Thought for Xs" or the actual synthesis
    const cleanedReply = grokReply.trim();

    // Verify it is not just search pills
    const isOnlySearchPills =
      cleanedReply.startsWith('Searched') &&
      cleanedReply.split('\n').every((line) => {
        const l = line.trim();
        return (
          l.length < 50 ||
          l.startsWith('http') ||
          l.startsWith('Brows') ||
          l.startsWith('Searched') ||
          l.startsWith('+')
        );
      });

    if (isOnlySearchPills) {
      throw new Error(
        `[askGrok] Grok returned only search pill indicators without synthesis content (captured ${cleanedReply.length} chars).`
      );
    }

    if (!cleanedReply || cleanedReply.length < 50) {
      throw new Error(
        `[askGrok] Grok returned no usable answer (captured ${cleanedReply.length} chars). No fallbacks allowed.`
      );
    }

    console.log(`[askGrok] ✔ Received real Grok research response (${cleanedReply.length} characters)`);
    return cleanedReply;
  }




  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.deleteSession();
      } catch {
        // ignore session close errors
      } finally {
        this.browser = null;
      }
    }
  }

  async cleanup(): Promise<void> {
    return this.close();
  }
}

