/**
 * Probe #9: why does the inline media upload fail?
 * Patches window.fetch + XMLHttpRequest before the upload so we can see which
 * endpoint fails and with what status/body.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');
await fs.mkdir(OUT, { recursive: true });
const headerPng = (await fs.readdir('artifacts/xdev', { recursive: true })).filter((f) => /(^|\/)header-image-.*\.png$/.test(f)).sort().pop()!;
const small = path.join(OUT, 'probe-inline.jpg');
await sharp(path.resolve('artifacts/xdev', headerPng)).resize({ width: 900 }).jpeg({ quality: 82 }).toFile(small);

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
  await titleArea.setValue('PROBE upload network log');

  // install network logger
  await browser.execute(() => {
    const w = window as any;
    w.__net = [];
    const origFetch = window.fetch;
    window.fetch = async function (input: any, init?: any) {
      const url = typeof input === 'string' ? input : input?.url;
      const rec: any = { kind: 'fetch', url: String(url).slice(0, 160), method: init?.method || 'GET', t: Date.now() };
      w.__net.push(rec);
      try {
        const res = await origFetch.apply(this, arguments as any);
        rec.status = res.status;
        rec.ok = res.ok;
        try {
          const clone = res.clone();
          const text = await clone.text();
          rec.body = text.slice(0, 400);
        } catch (e) { rec.bodyErr = String(e); }
        return res;
      } catch (e: any) {
        rec.error = String(e?.message || e);
        throw e;
      }
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method: string, url: string) {
      (this as any).__rec = { kind: 'xhr', method, url: String(url).slice(0, 160), t: Date.now() };
      w.__net.push((this as any).__rec);
      return origOpen.apply(this, arguments as any);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => { (this as any).__rec.status = this.status; (this as any).__rec.body = String(this.responseText || '').slice(0, 300); });
      this.addEventListener('error', () => { (this as any).__rec.error = 'xhr error'; });
      this.addEventListener('timeout', () => { (this as any).__rec.error = 'xhr timeout'; });
      return origSend.apply(this, arguments as any);
    };
  });

  await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
    const props = k ? composer[k] : null;
    const data: Record<string, string> = { 'text/html': '<p>正文第一段。</p>', 'text/plain': '正文第一段' };
    const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
    props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
  });
  await browser.pause(2000);
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
  await inlineInput.addValue(small);
  console.log('upload started; waiting 40s for network log');
  await browser.pause(40000);
  const net = await browser.execute(() => (window as any).__net);
  console.log('NETWORK:', JSON.stringify(net, null, 2));
  await browser.saveScreenshot(path.join(OUT, '20-upload-netlog.png'));
} finally {
  await driver.cleanup().catch(() => {});
}
