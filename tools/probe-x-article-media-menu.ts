/**
 * Probe #6: drive the real inline-media path:
 *   Add Media -> menu item "Media" -> captured file input -> upload -> Edit media -> Apply
 * Also checks the "Divider" menu item block type.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');
await fs.mkdir(OUT, { recursive: true });
const headerPng = (await fs.readdir('artifacts/xdev', { recursive: true })).filter((f) => /(^|\/)header-image-.*\.png$/.test(f)).sort().pop()!;
const headerPath = path.resolve('artifacts/xdev', headerPng);

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

const dumpBlocks = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
    if (!composer) return { error: 'no composer' };
    const blocks = Array.from(composer.querySelectorAll('[data-block="true"]')).map((b) => ({
      cls: (b.className || '').split(' ')[0],
      tag: b.tagName,
      text: (b as HTMLElement).innerText?.slice(0, 30),
      img: (b.querySelector('img') as HTMLImageElement | null)?.src?.slice(0, 60) || null,
    }));
    return { count: blocks.length, blocks };
  });

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  await browser.pause(6000);
  await browser.execute(() => { (document.querySelector('[aria-label="create"]') as HTMLElement | null)?.click(); });
  await browser.pause(7000);
  await browser.setWindowSize(1280, 1400);

  const titleArea = await browser.$('textarea[name="Article Title"]');
  await titleArea.click();
  await titleArea.setValue('PROBE inline media v2');

  await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
    const props = k ? composer[k] : null;
    const data: Record<string, string> = { 'text/html': '<p>正文第一段，图片将插在其后。</p>', 'text/plain': '正文第一段' };
    const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
    props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
  });
  await browser.pause(2500);

  // intercept file input clicks
  await browser.execute(() => {
    const w = window as any;
    w.__captured = [];
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type === 'file') {
        w.__captured.push(this);
        this.setAttribute('data-captured', String(w.__captured.length));
        return;
      }
      return orig.apply(this, arguments as any);
    };
  });

  // open Add Media menu and click "Media"
  await browser.execute(() => { (document.querySelector('[aria-label="Add Media"]') as HTMLElement)?.click(); });
  await browser.pause(2000);
  const mediaClicked = await browser.execute(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] div[tabindex], [role="menu"] button, [role="menu"] [role="button"]'));
    const target = items.find((el) => /^media$/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0]));
    if (!target) return 'no media item';
    (target as HTMLElement).click();
    return 'clicked media';
  });
  console.log('media menu:', mediaClicked);
  await browser.pause(2500);
  await browser.saveScreenshot(path.join(OUT, '12-media-menu-click.png'));

  const state = await browser.execute(() => {
    const w = window as any;
    return {
      captured: (w.__captured || []).map((i: HTMLInputElement) => ({ accept: i.accept, testid: i.getAttribute('data-testid'), parentCls: i.parentElement?.className?.slice(0, 60) })),
      inputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({ testid: i.getAttribute('data-testid'), accept: (i as HTMLInputElement).accept, captured: i.getAttribute('data-captured'), cls: i.className.slice(0, 40), parentCls: i.parentElement?.className?.slice(0, 60) })),
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => (d as HTMLElement).innerText.slice(0, 200)),
    };
  });
  console.log('STATE:', JSON.stringify(state, null, 2));

  // upload to the captured inline input
  const uploaded = await browser.execute(() => {
    const w = window as any;
    const input: HTMLInputElement | undefined = (w.__captured || [])[0];
    if (!input) return 'no captured input';
    return 'have input';
  });
  console.log('captured input:', uploaded);

  // use webdriver element for the captured input
  const el = await browser.$('input[data-captured]');
  if (await el.isExisting()) {
    await el.addValue(headerPath);
    console.log('addValue sent to inline input');
    for (let i = 0; i < 40; i++) {
      await browser.pause(1000);
      const r = await browser.execute(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return 'no-dialog';
        const apply = Array.from(dialog.querySelectorAll('button, [role="button"]')).find((b) =>
          /^apply$/i.test(((b as HTMLElement).innerText || '').trim())
        ) as HTMLElement | undefined;
        if (apply) { apply.click(); return 'applied'; }
        return 'waiting:' + (dialog as HTMLElement).innerText.slice(0, 80);
      });
      if (r === 'applied') { console.log('applied after', i + 1, 's'); break; }
      if (i === 39) console.log('last poll:', r);
    }
    await browser.pause(7000);
    console.log('AFTER INLINE IMG:', JSON.stringify(await dumpBlocks(), null, 2));
    await browser.saveScreenshot(path.join(OUT, '13-after-inline-img.png'));
  }

  // divider test
  await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as HTMLElement;
    composer.focus();
    const blocks = composer.querySelectorAll('[data-block="true"]');
    const last = blocks[blocks.length - 1] as HTMLElement;
    const r = document.createRange();
    r.selectNodeContents(last);
    r.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await browser.pause(800);
  await browser.execute(() => { (document.querySelector('[aria-label="Add Media"]') as HTMLElement)?.click(); });
  await browser.pause(1500);
  const divClicked = await browser.execute(() => {
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="button"], [role="menu"] button, [role="menu"] div[tabindex]'));
    const t = items.find((el) => /^divider$/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0]));
    if (!t) return 'no divider item';
    (t as HTMLElement).click();
    return 'clicked divider';
  });
  console.log('divider:', divClicked);
  await browser.pause(3000);
  console.log('AFTER DIVIDER:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '14-after-divider.png'));
} finally {
  await driver.cleanup().catch(() => {});
}
