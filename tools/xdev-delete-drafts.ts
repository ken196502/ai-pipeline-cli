/**
 * xdev-delete-drafts.ts
 *
 * Opens Firefox (reusing the authenticated X session via FirefoxBiDiDriver),
 * enters the X Articles drafts list, and either LISTS, PROBES, or DELETES drafts.
 *
 * Usage:
 *   node tools/xdev-delete-drafts.ts            # LIST only (safe) — prints drafts + screenshot
 *   node tools/xdev-delete-drafts.ts --probe    # click first draft's "…" menu, dump menu items, exit (no delete)
 *   node tools/xdev-delete-drafts.ts --delete   # delete EVERY draft found
 *
 * Auth: injectCookies() refreshes cookies from the live Firefox ESR profile,
 * so no manual login is needed. Runs headless.
 *
 * DOM notes (verified 2026-11-04):
 *   - Each draft row has its OWN overflow button:  button[aria-label="More"][class*="r-bt1l66"]
 *     (the global left-nav button is aria-label="More menu items" — do NOT click that one).
 *   - Draft links: a[href*="/compose/articles/edit/<id>"]
 *   - Row overflow menu is a [role="menu"] with items: "Edit in focus mode",
 *     "Preview your draft", "Delete Article".
 *   - Drafts list loads asynchronously and the Articles SPA shell itself can be
 *     slow to mount, so we POLL for the Drafts nav + draft links (with reload
 *     retries) rather than relying on fixed sleeps.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT_DIR = path.resolve('artifacts/xdev/_drafts-cleanup');
const ROW_MORE_CLASS = 'r-bt1l66'; // distinctive class on the per-draft row "…" button

type Mode = 'list' | 'probe' | 'delete';

async function main(): Promise<void> {
  const mode: Mode = process.argv.includes('--delete')
    ? 'delete'
    : process.argv.includes('--probe')
      ? 'probe'
      : 'list';
  console.log(`[drafts] mode=${mode}`);

  const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
  const browser = await driver.launch();

  const collectDrafts = () =>
    browser.execute(() => {
      const links = Array.from(
        document.querySelectorAll('a[href*="/compose/articles/edit/"]')
      ) as HTMLAnchorElement[];
      const seen = new Set<string>();
      const out: { title: string; url: string }[] = [];
      for (const a of links) {
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        out.push({
          title: (a.innerText || a.getAttribute('aria-label') || '(untitled)')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120),
          url: a.href,
        });
      }
      return out;
    });

  // Click the "Drafts" nav entry; returns true if found & clicked.
  const clickDraftsNav = () =>
    browser.execute(() => {
      const c = Array.from(document.querySelectorAll('a, button, [role="tab"], [role="button"]')) as HTMLElement[];
      const h = c.find((el) => {
        const t = (el.getAttribute('aria-label') || el.innerText || '').trim().toLowerCase();
        return t === 'drafts' || t.startsWith('draft');
      });
      if (h) { h.click(); return true; }
      return false;
    });

  // Navigate to the drafts list reliably: poll for the SPA shell + Drafts nav,
  // click it, then poll for draft links. Retry with a reload if it never appears.
  const goToDrafts = async (attempts = 4): Promise<{ title: string; url: string }[]> => {
    for (let a = 0; a < attempts; a++) {
      await browser.url('https://x.com/compose/articles');
      let navClicked = false;
      for (let i = 0; i < 25 && !navClicked; i++) {
        await browser.pause(1000);
        navClicked = await clickDraftsNav();
      }
      // Poll for draft links once Drafts has been clicked.
      let drafts = await collectDrafts();
      for (let i = 0; i < 25 && drafts.length === 0; i++) {
        await browser.pause(1000);
        drafts = await collectDrafts();
      }
      if (drafts.length > 0) return drafts;
      console.warn(`[drafts] attempt ${a + 1}: drafts list still empty — reloading`);
    }
    return [];
  };

  try {
    const injected = await driver.injectCookies('https://x.com');
    console.log(`[drafts] injected ${injected} cookies`);

    let drafts = await goToDrafts();
    console.log(`[drafts] found ${drafts.length} draft(s)`);
    for (const d of drafts) console.log(`  • ${d.title}\n    ${d.url}`);

    await fs.mkdir(OUT_DIR, { recursive: true });
    const listShot = path.join(OUT_DIR, `drafts-list-${Date.now()}.png`);
    await browser.saveScreenshot(listShot).catch(() => {});
    const dom = await browser.execute(() => document.body.innerText.slice(0, 4000)).catch(() => '');
    await fs.writeFile(path.join(OUT_DIR, `drafts-list-${Date.now()}.txt`), dom, 'utf-8').catch(() => {});
    console.log(`[drafts] list screenshot: ${listShot}`);

    if (mode === 'list') {
      console.log('[drafts] LIST only — re-run with --probe or --delete.');
      return;
    }

    // --- PROBE: open the first draft row's "…" menu, dump items, exit (no delete) ---
    if (mode === 'probe') {
      const opened = await browser.execute((rowClass: string) => {
        const link = document.querySelector('a[href*="/compose/articles/edit/"]') as HTMLElement | null;
        if (!link) return { ok: false, reason: 'no draft link' };
        let node: HTMLElement | null = link;
        while (node) {
          const parent = node.parentElement;
          if (!parent) break;
          const more = parent.querySelector(`button[aria-label="More"][class*="${rowClass}"]`) as HTMLElement | null;
          if (more) { more.click(); return { ok: true }; }
          node = parent;
        }
        return { ok: false, reason: 'no row More button found' };
      }, ROW_MORE_CLASS);
      console.log(`[drafts] probe menu open: ${JSON.stringify(opened)}`);
      await browser.pause(2500);
      const menu = await browser.execute(() => {
        const m = document.querySelector('[role="menu"]') as HTMLElement | null;
        const items = Array.from(
          (m || document.body).querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, a, div')
        ).map((e) => (e.getAttribute('aria-label') || (e as HTMLElement).innerText || '').trim())
          .filter(Boolean)
          .slice(0, 40);
        return { role: m ? 'menu' : 'unknown', items };
      });
      const shot = path.join(OUT_DIR, `probe-menu-${Date.now()}.png`);
      await browser.saveScreenshot(shot).catch(() => {});
      console.log(`[drafts] probe menu role=${menu.role}`);
      console.log('[drafts] probe menu items:');
      for (const it of menu.items) console.log(`    - ${it}`);
      console.log(`[drafts] probe screenshot: ${shot}`);
      console.log('[drafts] PROBE done — no drafts were deleted.');
      return;
    }

    // --- DELETE every draft via its row "…" menu, then "Delete Article", confirm ---
    let removed = 0;
    let guard = 0;
    const MAX = drafts.length * 2 + 5;
    while (guard++ < MAX) {
      const current = await collectDrafts();
      if (current.length === 0) {
        console.log('[drafts] list empty — all drafts deleted.');
        break;
      }
      const d = current[0];
      console.log(`[drafts] deleting (${removed + 1}): ${d.title} -> ${d.url}`);
      try {
        // Click this row's OWN "More" button (not the global nav one).
        const opened = await browser.execute((rowClass: string, targetUrl: string) => {
          const link = Array.from(
            document.querySelectorAll('a[href*="/compose/articles/edit/"]')
          ).find((a) => (a as HTMLAnchorElement).href === targetUrl) as HTMLElement | null;
          if (!link) return { ok: false, reason: 'link not found' };
          let node: HTMLElement | null = link;
          while (node) {
            const parent = node.parentElement;
            if (!parent) break;
            const more = parent.querySelector(`button[aria-label="More"][class*="${rowClass}"]`) as HTMLElement | null;
            if (more) { more.click(); return { ok: true }; }
            node = parent;
          }
          const any = document.querySelector(`button[aria-label="More"][class*="${rowClass}"]`) as HTMLElement | null;
          if (any) { any.click(); return { ok: true, fallback: true }; }
          return { ok: false, reason: 'no More button' };
        }, ROW_MORE_CLASS, d.url);
        if (!opened.ok) {
          console.warn(`  ⚠ could not open menu for ${d.url}: ${opened.reason} — reloading drafts list`);
          await goToDrafts();
          continue;
        }
        await browser.pause(2000);

        const menuShot = path.join(OUT_DIR, `menu-${Date.now()}.png`);
        await browser.saveScreenshot(menuShot).catch(() => {});

        // Click the "Delete Article" menu item (target real menu entries, not wrapper divs).
        const delClicked = await browser.execute(() => {
          const scope = document.querySelector('[role="menu"]') || document.body;
          const items = Array.from(
            scope.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button')
          ) as HTMLElement[];
          const del = items.find((el) => {
            const t = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
            return t.includes('delete') || t.includes('discard') || t.includes('trash') || t.includes('remove');
          });
          if (del) { del.click(); return (del.innerText || del.getAttribute('aria-label') || '').trim(); }
          return false;
        });
        if (!delClicked) {
          console.warn('  ⚠ "Delete Article" menu item not found; reloading list');
          await browser.execute(() => document.body.click()).catch(() => {});
          await browser.pause(1000);
          await goToDrafts();
          continue;
        }
        console.log(`  clicked menu item: "${delClicked}"`);
        await browser.pause(2000);

        // Confirm in the dialog (button label contains "delete").
        const confirmed = await browser.execute(() => {
          const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]') as HTMLElement | null;
          const scope = dialog || document.body;
          const btns = Array.from(scope.querySelectorAll('button')) as HTMLElement[];
          const confirm = btns.find((b) => {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase();
            return t.includes('delete');
          });
          if (confirm) { confirm.click(); return (confirm.innerText || confirm.getAttribute('aria-label') || '').trim(); }
          return false;
        });
        if (!confirmed) {
          console.warn('  ⚠ confirmation button not found; reloading list');
          await browser.execute(() => document.body.click()).catch(() => {});
          await browser.pause(1000);
          await goToDrafts();
          continue;
        }
        console.log(`  confirmed with: "${confirmed}"`);
        await browser.pause(3500);

        // verify the draft count actually dropped
        const after = await collectDrafts();
        if (after.length < current.length || after.length === 0) {
          removed++;
          console.log(`  ✔ deleted (${removed} done, ${after.length} remaining)`);
        } else {
          console.warn(`  ⚠ count did not drop (still ${after.length}); will retry`);
        }
      } catch (err: any) {
        console.warn(`  ⚠ error deleting ${d.url}: ${err?.message || err}`);
        await browser.pause(1000);
      }
    }
    const leftover = await collectDrafts();
    console.log(`[drafts] removed ${removed} draft(s); ${leftover.length} still present`);
    if (leftover.length > 0) {
      for (const l of leftover) console.log(`    remaining: ${l.title} -> ${l.url}`);
    }
  } finally {
    await driver.cleanup().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[drafts] ✗ fatal:', err?.stack || err);
  process.exit(1);
});
