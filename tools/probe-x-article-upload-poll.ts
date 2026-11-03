/**
 * Probe #8: inline media upload — long poll with status/error capture.
 * Uses a downscaled JPEG to rule out upload-size/timeout issues.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');
await fs.mkdir(OUT, { recursive: true });
const headerPng = (await fs.readdir('artifacts/xdev', { recursive: true })).filter((f) => /(^|\/)header-image-.*\.png$/.test(f)).sort().pop()!;
const src = path.resolve('artifacts/xdev', headerPng);
const small = path.join(OUT, 'probe-inline.jpg');
await sharp(src).resize({ width: 900 }).jpeg({ quality: 82 }).toFile(small);
console.log('probe image:', small, (await fs.stat(small)).size, 'bytes');

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
      img: (b.querySelector('img') as HTMLImageElement | null)?.src?.slice(0, 70) || null,
    }));
    const status = document.body.innerText.match(/Uploading media[^\n]*|Could not[^\n]*|failed[^\n]*|error[^\n]*/gi);
    return { count: blocks.length, blocks, status };
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
  await titleArea.setValue('PROBE inline upload long poll');

  await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
    const props = k ? composer[k] : null;
    const data: Record<string, string> = { 'text/html': '<p>正文第一段，图片将插在其后。</p>', 'text/plain': '正文第一段' };
    const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
    props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
  });
  await browser.pause(2500);

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

  await browser.execute(() => { (document.querySelector('[aria-label="Add Media"]') as HTMLElement)?.click(); });
  await browser.pause(1800);
  await browser.execute(() => {
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="button"], [role="menu"] button, [role="menu"] div[tabindex]'));
    const t = items.find((el) => /^media$/i.test(((el as HTMLElement).innerText || '').trim().split('\n')[0]));
    (t as HTMLElement | undefined)?.click();
  });
  await browser.pause(3000);

  const inputs = await browser.$$('input[type="file"]');
  let inlineInput: any = null;
  for (const i of inputs) {
    const accept = await i.getAttribute('accept');
    if (accept && accept.includes('video')) inlineInput = i;
  }
  if (!inlineInput) throw new Error('inline media input not found');
  await inlineInput.addValue(small);
  console.log('upload started');

  for (let i = 0; i < 25; i++) {
    await browser.pause(4000);
    const s = await dumpBlocks();
    console.log(`t+${(i + 1) * 4}s`, JSON.stringify({ count: s.count, status: s.status, imgs: s.blocks?.map((b: any) => b.img).filter(Boolean) }));
    if (s.blocks?.some((b: any) => b.img)) {
      console.log('IMAGE INSERTED');
      break;
    }
  }
  await browser.saveScreenshot(path.join(OUT, '19-long-poll.png'));
  console.log('FINAL:', JSON.stringify(await dumpBlocks(), null, 2));
} finally {
  await driver.cleanup().catch(() => {});
}
