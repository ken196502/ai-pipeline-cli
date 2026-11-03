/**
 * Probe #5: find the INLINE media path (the top fileInput is the cover upload).
 * Installs an HTMLInputElement.prototype.click interceptor so no native file
 * dialog can open, then clicks "Add Media" / the Insert menu and reports which
 * file inputs the app creates for inline insertion.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');
await fs.mkdir(OUT, { recursive: true });

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  await browser.pause(6000);
  await browser.execute(() => { (document.querySelector('[aria-label="create"]') as HTMLElement | null)?.click(); });
  await browser.pause(7000);
  await browser.setWindowSize(1280, 1400);

  const titleArea = await browser.$('textarea[name="Article Title"]');
  await titleArea.click();
  await titleArea.setValue('PROBE inline media discovery');

  // paste one paragraph so we have a caret
  await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
    const props = k ? composer[k] : null;
    const data: Record<string, string> = { 'text/html': '<p>正文第一段。</p>', 'text/plain': '正文第一段。' };
    const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
    props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
  });
  await browser.pause(2000);

  // install interceptor
  const installed = await browser.execute(() => {
    const w = window as any;
    w.__captured = [];
    if (!w.__origClickPatched) {
      const orig = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type === 'file') {
          w.__captured.push(this);
          this.setAttribute('data-captured', String(w.__captured.length));
          return;
        }
        return orig.apply(this, arguments as any);
      };
      w.__origClickPatched = true;
    }
    return true;
  });
  console.log('interceptor installed:', installed);

  const ariaList = await browser.execute(() =>
    Array.from(document.querySelectorAll('[aria-label]'))
      .map((e) => ({ aria: e.getAttribute('aria-label'), tag: e.tagName, testid: e.getAttribute('data-testid') }))
      .filter((x) => /media|photo|image|insert|add/i.test(x.aria || ''))
  );
  console.log('candidates:', JSON.stringify(ariaList, null, 2));

  // click "Add Media"
  const clicked = await browser.execute(() => {
    const el = document.querySelector('[aria-label="Add Media"]') as HTMLElement | null;
    if (!el) return 'no Add Media';
    el.click();
    return 'clicked';
  });
  console.log('add media:', clicked);
  await browser.pause(4000);
  await browser.saveScreenshot(path.join(OUT, '10-add-media-click.png'));

  const afterAddMedia = await browser.execute(() => {
    const w = window as any;
    return {
      captured: (w.__captured || []).map((i: HTMLInputElement) => ({ accept: i.accept, testid: i.getAttribute('data-testid'), cls: i.className, parent: i.parentElement?.className?.slice(0, 60) })),
      allInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({ testid: i.getAttribute('data-testid'), accept: (i as HTMLInputElement).accept, captured: i.getAttribute('data-captured'), cls: i.className.slice(0, 50), parentCls: i.parentElement?.className?.slice(0, 60) })),
      menus: Array.from(document.querySelectorAll('[role="menu"], [data-testid="Dropdown"]')).map((m) => (m as HTMLElement).innerText.slice(0, 300)),
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((m) => (m as HTMLElement).innerText.slice(0, 300)),
    };
  });
  console.log('AFTER ADD MEDIA:', JSON.stringify(afterAddMedia, null, 2));

  // also inspect the "Insert" dropdown
  const insertClicked = await browser.execute(() => {
    const el = Array.from(document.querySelectorAll('[role="button"], button')).find((b) =>
      /^Insert/i.test((b as HTMLElement).innerText || '')
    ) as HTMLElement | undefined;
    if (!el) return 'no insert';
    el.click();
    return 'clicked insert';
  });
  console.log('insert menu:', insertClicked);
  await browser.pause(2500);
  await browser.saveScreenshot(path.join(OUT, '11-insert-menu.png'));
  const insertMenu = await browser.execute(() =>
    Array.from(document.querySelectorAll('[role="menu"], [role="menuitem"]')).map((m) => (m as HTMLElement).innerText.slice(0, 200))
  );
  console.log('insert menu items:', JSON.stringify(insertMenu, null, 2));
} finally {
  await driver.cleanup().catch(() => {});
}
