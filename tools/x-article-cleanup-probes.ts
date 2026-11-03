/**
 * Deletes leftover X Article drafts whose title starts with DRAFT_PREFIX
 * (default "PROBE"). Uses real WebDriver clicks — the draft cards are links, so
 * JS .click() either navigates or gets swallowed by React's delegated handlers.
 *
 *   npx tsx tools/x-article-cleanup-probes.ts
 */
import pc from 'picocolors';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const PREFIX = process.env.DRAFT_PREFIX || 'PROBE';
const MAX = Number(process.env.DRAFT_MAX || 30);

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

/** Index of the first draft card whose title starts with PREFIX, plus its title. */
async function findProbeCard(): Promise<{ index: number; title: string; total: number } | null> {
  return browser.execute((prefix: string) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="cellInnerDiv"]')) as HTMLElement[];
    const withMore: Array<{ el: HTMLElement; lines: string[] }> = [];
    for (const card of cards) {
      if (!card.querySelector('[aria-label="More"]')) continue;
      withMore.push({
        el: card,
        lines: (card.innerText || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      });
    }
    const idx = withMore.findIndex((c) => c.lines.some((l) => l.startsWith(prefix)));
    if (idx < 0) return null;
    const title = withMore[idx].lines.find((l) => l.startsWith(prefix)) || '';
    return { index: idx, title, total: withMore.length };
  }, PREFIX);
}

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  for (let i = 0; i < 20; i++) {
    await browser.pause(1500);
    const ready = await browser.execute(() => document.querySelectorAll('[data-testid="cellInnerDiv"]').length > 0);
    if (ready) break;
  }

  let deleted = 0;
  for (let i = 0; i < MAX; i++) {
    const card = await findProbeCard();
    if (!card) break;

    const moreButtons = await browser.$$('[data-testid="cellInnerDiv"] [aria-label="More"]');
    if (!moreButtons[card.index]) {
      console.warn(pc.yellow(`  ⚠ no "More" button at index ${card.index}`));
      break;
    }
    await moreButtons[card.index].click();
    await browser.pause(1500);

    const menuItems = await browser.$$('[role="menuitem"]');
    if (!menuItems.length) {
      console.warn(pc.yellow('  ⚠ draft menu did not open'));
      await browser.keys(['Escape']);
      break;
    }
    let deleteBtn: any = null;
    for (const item of menuItems) {
      const text = (await item.getText().catch(() => '')).trim();
      if (/^delete(\s+article)?$/i.test(text)) deleteBtn = item;
    }
    if (!deleteBtn) {
      const texts: string[] = [];
      for (const item of menuItems) texts.push((await item.getText().catch(() => '')).trim());
      console.warn(pc.yellow(`  ⚠ no Delete item, menu has: ${texts.join(' | ')}`));
      await browser.keys(['Escape']);
      break;
    }
    await deleteBtn.click();
    await browser.pause(2500);

    const dialogs = await browser.execute(() => ({
      sheets: Array.from(document.querySelectorAll('[data-testid*="confirmation" i]')).map((d) => ({
        testid: d.getAttribute('data-testid'),
        text: (d as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 160),
      })),
      roleDialogs: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).map((d) =>
        (d as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 160)
      ),
    }));

    const confirmed = await browser.execute(() => {
      const confirmBtn =
        (document.querySelector('[data-testid="confirmationSheetConfirm"]') as HTMLElement | null) ||
        (Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
          /^delete(\s+article)?$/i.test(((b as HTMLElement).innerText || '').trim())
        ) as HTMLElement | null);
      if (!confirmBtn) return false;
      confirmBtn.click();
      return true;
    });
    if (!confirmed) console.warn(pc.yellow(`  ⚠ 未找到确认按钮: ${JSON.stringify(dialogs)}`));

    console.log(pc.cyan(`删除草稿: ${card.title} ${confirmed ? '✔' : '✗'}`));
    if (confirmed) deleted += 1;

    // Wait for the sheet to close before touching the list again.
    for (let w = 0; w < 12; w++) {
      const open = await browser.execute(
        () =>
          Boolean(
            document.querySelector('[data-testid*="confirmation" i], [role="dialog"], [aria-modal="true"]')
          )
      );
      if (!open) break;
      await browser.pause(1000);
    }
    await browser.pause(1500);
  }

  const remaining = await findProbeCard();
  console.log(pc.green(`已删除 ${deleted} 个草稿；剩余 ${remaining ? '有' : '无'} 以 ${PREFIX} 开头的草稿`));
  if (remaining) process.exitCode = 1;
} finally {
  await driver.cleanup().catch(() => {});
}
