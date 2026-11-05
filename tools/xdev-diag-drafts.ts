/**
 * xdev-diag-drafts.ts — diagnostic only.
 * Dumps the structured HTML of the X Articles drafts list so we can see the
 * real per-row "…" (overflow) button markup and its aria-label, plus the
 * menu popover markup. No deletions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT_DIR = path.resolve('artifacts/xdev/_drafts-cleanup');

async function main(): Promise<void> {
  const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
  const browser = await driver.launch();
  try {
    const injected = await driver.injectCookies('https://x.com');
    console.log(`[diag] injected ${injected} cookies`);

    await browser.url('https://x.com/compose/articles');
    await browser.pause(6000);

    const clicked = await browser.execute(() => {
      const c = Array.from(document.querySelectorAll('a, button, [role="tab"], [role="button"]')) as HTMLElement[];
      const h = c.find((el) => {
        const t = (el.getAttribute('aria-label') || el.innerText || '').trim().toLowerCase();
        return t === 'drafts' || t.startsWith('draft');
      });
      if (h) { h.click(); return true; }
      return false;
    });
    console.log(`[diag] clicked Drafts: ${clicked}`);
    await browser.pause(4000);

    // poll for rows
    const collect = () => browser.execute(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/compose/articles/edit/"]')) as HTMLAnchorElement[];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const a of links) { if (seen.has(a.href)) continue; seen.add(a.href); out.push(a.href); }
      return out;
    });
    let urls = await collect();
    for (let i = 0; i < 25 && urls.length === 0; i++) { await browser.pause(1000); urls = await collect(); }
    console.log(`[diag] found ${urls.length} drafts`);

    await fs.mkdir(OUT_DIR, { recursive: true });

    // Dump, for the FIRST draft row, the outerHTML of its row container + every
    // button on the page with aria-label.
    const dump = await browser.execute(() => {
      const firstLink = document.querySelector('a[href*="/compose/articles/edit/"]') as HTMLElement | null;
      if (!firstLink) return { rowHtml: '(no draft link found)', buttons: [] };

      // Walk up to a plausible row container: an element whose direct child set
      // includes the link AND a button, or just go 4 levels up.
      let node: HTMLElement | null = firstLink;
      let row: HTMLElement = firstLink;
      for (let i = 0; i < 6 && node; i++) {
        const parent = node.parentElement;
        if (!parent) break;
        const hasLink = parent.querySelector('a[href*="/compose/articles/edit/"]');
        const hasBtn = parent.querySelector('button, [role="button"]');
        row = parent;
        if (hasLink && hasBtn && parent.querySelectorAll('a[href*="/compose/articles/edit/"]').length >= 1) {
          // good enough; but keep going until we find a container with exactly this draft
        }
        node = parent;
      }

      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map((b) => {
        const el = b as HTMLElement;
        return {
          tag: el.tagName,
          aria: el.getAttribute('aria-label') || '',
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          hasSvg: Boolean(el.querySelector('svg')),
          cls: el.getAttribute('class') || '',
        };
      }).filter((b) => b.aria || b.text || b.hasSvg);

      return { rowHtml: (row as HTMLElement).outerHTML.slice(0, 3000), buttons: buttons.slice(0, 60) };
    });

    const out = {
      rowHtml: dump.rowHtml,
      buttons: dump.buttons,
    };
    const f = path.join(OUT_DIR, `diag-row-${Date.now()}.json`);
    await fs.writeFile(f, JSON.stringify(out, null, 2), 'utf-8');
    console.log(`[diag] wrote ${f}`);
    console.log('--- ROW HTML ---');
    console.log(out.rowHtml);
    console.log('--- BUTTONS ---');
    for (const b of out.buttons) console.log(JSON.stringify(b));
  } finally {
    await driver.cleanup().catch(() => {});
  }
}

main().catch((err) => { console.error('[diag] ✗', err?.stack || err); process.exit(1); });
