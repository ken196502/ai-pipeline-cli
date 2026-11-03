/**
 * Probe #7: complete the inline media dialog flow.
 *   Add Media -> Media -> dialog fileInput -> wait for preview -> confirm
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
  await titleArea.setValue('PROBE inline media dialog');

  await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
    const props = k ? composer[k] : null;
    const data: Record<string, string> = { 'text/html': '<p>正文第一段，图片将插在其后。</p>', 'text/plain': '正文第一段' };
    const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
    props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
  });
  await browser.pause(2500);

  // caret at end of last block
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
  await browser.pause(600);

  // Add Media -> Media
  await browser.execute(() => { (document.querySelector('[aria-label="Add Media"]') as HTMLElement)?.click(); });
  await browser.pause(1800);
  await browser.execute(() => {
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="button"], [role="menu"] button, [role="menu"] div[tabindex]'));
    const t = items.find((el) => /^media$/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0]));
    (t as HTMLElement | undefined)?.click();
  });
  await browser.pause(3000);
  await browser.saveScreenshot(path.join(OUT, '15-media-dialog.png'));

  // the inline input is the one whose accept includes video
  const inputs = await browser.$$('input[type="file"]');
  console.log('file inputs:', inputs.length);
  let inlineInput: any = null;
  for (const i of inputs) {
    const accept = await i.getAttribute('accept');
    if (accept && accept.includes('video')) inlineInput = i;
  }
  if (!inlineInput) throw new Error('inline media input not found');
  await inlineInput.addValue(headerPath);
  console.log('uploaded to inline input, waiting for preview...');
  await browser.pause(12000);
  await browser.saveScreenshot(path.join(OUT, '16-media-dialog-preview.png'));

  const dialogState = await browser.execute(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return { dialog: null };
    return {
      text: (d as HTMLElement).innerText.slice(0, 400),
      buttons: Array.from(d.querySelectorAll('button, [role="button"]')).map((b) => ({
        text: (b as HTMLElement).innerText?.trim().slice(0, 40),
        aria: b.getAttribute('aria-label'),
        testid: b.getAttribute('data-testid'),
      })),
      imgs: Array.from(d.querySelectorAll('img')).map((i) => (i as HTMLImageElement).src.slice(0, 60)),
    };
  });
  console.log('DIALOG:', JSON.stringify(dialogState, null, 2));

  // try clicking the primary confirm button
  const confirmed = await browser.execute(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return 'no dialog';
    const cands = Array.from(d.querySelectorAll('button, [role="button"]')).filter((b) => {
      const txt = ((b as HTMLElement).innerText || '').trim();
      return /^(insert|add|apply|done|next|save)$/i.test(txt);
    }) as HTMLElement[];
    if (!cands.length) return 'no confirm';
    cands[cands.length - 1].click();
    return 'clicked:' + ((cands[cands.length - 1].innerText || '').trim());
  });
  console.log('confirm:', confirmed);
  await browser.pause(10000);
  console.log('AFTER CONFIRM:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '17-after-inline-insert.png'));

  // paste after image to check caret
  const pasted = await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
    const props = k ? composer[k] : null;
    const data: Record<string, string> = { 'text/html': '<h2>图片之后的小标题</h2><p>图片之后的正文。</p>', 'text/plain': '图片之后的小标题\n\n图片之后的正文。' };
    const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
    props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
    return 'ok';
  });
  console.log('paste after image:', pasted);
  await browser.pause(4000);
  console.log('FINAL BLOCKS:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '18-final.png'));
} finally {
  await driver.cleanup().catch(() => {});
}
