/**
 * Diagnoses "why is post X not in our Top-feed results?".
 *
 * Opens the same `x.com/search` URLs the scraper uses (with and without the
 * `lang:` operator) and dumps what X actually returns, in order, including the
 * signals the scraper filters on (views, article cover, social context).
 *
 * Usage:
 *   npx tsx tools/diag-xdev-search-visibility.ts <statusUrlOrId> [query...]
 *   npx tsx tools/diag-xdev-search-visibility.ts 2116857257245987236
 */
import pc from 'picocolors';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';
import { buildXSearchUrl } from '../src/libs/text/index.js';

const target = process.argv[2] ?? '';
const targetId = (target.match(/(\d{6,})/) ?? [])[1] ?? target;
const queries = process.argv.slice(3).length ? process.argv.slice(3) : ['Agent system'];
const scrolls = Number(process.env.DIAG_SCROLLS ?? 6);

interface Row {
  position: number;
  handle: string;
  id: string;
  viewsText: string;
  hasArticleCover: boolean;
  socialContext: string;
  textSnippet: string;
  datetime: string;
}

async function collect(browser: any, query: string, rank: 'top' | 'live', lang: string | null) {
  const url = buildXSearchUrl(query, rank, lang);
  console.log(pc.cyan(`\n=== ${url}`));
  await browser.setTimeout({ script: 300_000 });
  await browser.url(url);
  for (let wait = 0; wait < 15; wait += 1) {
    const n = await browser.execute(
      () => document.querySelectorAll('article[data-testid="tweet"]').length
    );
    if (n > 0) break;
    await browser.pause(1000);
  }
  await browser.pause(1500);

  // X virtualises the timeline: off-screen articles are unmounted, so the DOM
  // count shrinks again after each scroll. Accumulate by status id instead.
  const seen = new Map<string, Row>();
  for (let i = 0; i < scrolls; i += 1) {
    const batch: Row[] = await browser.execute(() => {
      const out: Array<Record<string, unknown>> = [];
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      articles.forEach((el) => {
        const anchors = Array.from(el.querySelectorAll('a[href*="/status/"]')) as HTMLAnchorElement[];
        let handle = '';
        let id = '';
        for (const a of anchors) {
          const m = (a.getAttribute('href') || '').match(/\/([^/]+)\/status\/(\d+)(?:[?#].*)?$/);
          if (m) {
            handle = m[1];
            id = m[2];
            break;
          }
        }
        if (!id) return;
        const analytics = el.querySelector('a[href*="/analytics"]');
        const viewsText =
          (analytics && (analytics.getAttribute('aria-label') || analytics.textContent)) || '';
        const textEl = el.querySelector('[data-testid="tweetText"]');
        out.push({
          handle,
          id,
          viewsText: String(viewsText).slice(0, 60),
          hasArticleCover: !!el.querySelector('[data-testid="article-cover-image"]'),
          socialContext: (el.querySelector('[data-testid="socialContext"]')?.textContent || '').slice(0, 40),
          textSnippet: String(textEl?.textContent || '').replace(/\s+/g, ' ').slice(0, 70),
          datetime: el.querySelector('time')?.getAttribute('datetime') || '',
        });
      });
      return out;
    });

    for (const row of batch) {
      if (!seen.has(row.id)) seen.set(row.id, { ...row, position: seen.size + 1 });
    }
    console.log(
      pc.dim(`  scroll ${i + 1}/${scrolls}: ${batch.length} rendered / ${seen.size} unique so far`)
    );
    await browser.execute(() => window.scrollBy(0, 1800));
    await browser.pause(1400);
  }

  const rows = [...seen.values()];
  rows.forEach((r) => {
    const mark = r.id === targetId ? pc.green(' ★ TARGET') : '';
    console.log(
      `  #${String(r.position).padStart(2)} @${r.handle || '?'} (${r.id}) ${r.datetime} views="${r.viewsText}" articleCover=${r.hasArticleCover} social="${r.socialContext}"${mark}`
    );
    console.log(pc.dim(`       ${r.textSnippet}`));
  });

  const hit = rows.find((r) => r.id === targetId);
  console.log(
    hit
      ? pc.green(`  → target present at position #${hit.position} of ${rows.length} unique`)
      : pc.yellow(`  → target absent (${rows.length} unique articles scanned)`)
  );
  return { rows, hit };
}

const driver = new FirefoxBiDiDriver({
  firefoxBinary: process.env.FIREFOX_BINARY ?? '/usr/bin/firefox-esr',
  headless: true,
  cookiesPath: process.env.X_COOKIES_PATH ?? 'x_cookies.json',
});

try {
  const browser = await driver.launch();
  await driver.injectCookies('https://x.com');
  console.log(pc.bold(`\ntarget status id: ${targetId || '(none given)'}`));
  for (const query of queries) {
    await collect(browser, query, 'top', 'en');
    await collect(browser, query, 'top', null);
  }
} catch (err) {
  console.error(pc.red(`diag failed: ${(err as Error).message}`));
  process.exitCode = 1;
} finally {
  await driver.close().catch(() => {});
}
