/**
 * Probe #4: full inline-image flow.
 *  1. paste html segment (caret must be in an EMPTY block to keep block types)
 *  2. upload via input[data-testid="fileInput"] -> "Edit media" modal -> Apply
 *  3. verify atomic image block + caret position, then paste next segment
 *  4. dump all file inputs (cover vs inline media)
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
      img: (b.querySelector('img') as HTMLImageElement | null)?.src?.slice(0, 50) || null,
    }));
    const files = Array.from(document.querySelectorAll('input[type="file"]')).map((f) => ({
      testid: f.getAttribute('data-testid'),
      accept: f.getAttribute('accept'),
      cls: (f.className || '').slice(0, 40),
      rect: (() => { const r = f.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
    }));
    const dialog = document.querySelector('[role="dialog"]');
    return {
      count: blocks.length,
      blocks,
      files,
      dialog: dialog ? (dialog as HTMLElement).innerText.slice(0, 200) : null,
    };
  });

const pasteHtml = (html: string, plain: string) =>
  browser.execute(
    (h: string, p: string) => {
      const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
      const propsKey = Object.keys(composer).find((k) => k.startsWith('__reactProps$'));
      const props = propsKey ? composer[propsKey] : null;
      if (!props?.onPaste) return 'no onPaste';
      const data: Record<string, string> = { 'text/html': h, 'text/plain': p };
      const clipboardData = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
      props.onPaste({ clipboardData, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData } });
      return 'ok';
    },
    html,
    plain
  );

/** Is the caret inside an empty block? */
const caretInEmptyBlock = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
    if (!composer) return false;
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!node) return false;
    let el: Node | null = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== composer && !(el as HTMLElement).hasAttribute?.('data-block')) {
      el = el.parentElement;
    }
    if (!el || el === composer) return false;
    return ((el as HTMLElement).innerText || '').trim().length === 0;
  });

const focusEnd = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as HTMLElement;
    composer.focus();
    const blocks = composer.querySelectorAll('[data-block="true"]');
    const last = blocks[blocks.length - 1] as HTMLElement;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  });

async function ensureEmptyBlock(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const empty = await caretInEmptyBlock();
    if (empty) return;
    await focusEnd();
    await browser.pause(300);
    await browser.keys(['Enter']);
    await browser.pause(700);
  }
  console.log('WARN: could not reach an empty block');
}

async function uploadImage(file: string): Promise<string> {
  const input = await browser.$('input[data-testid="fileInput"]');
  await input.addValue(file);
  // wait for the Edit media modal
  let applied = false;
  for (let i = 0; i < 30; i++) {
    await browser.pause(1000);
    const r = await browser.execute(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return 'no-dialog';
      const apply = Array.from(dialog.querySelectorAll('button, [role="button"]')).find((b) =>
        /^apply$/i.test(((b as HTMLElement).innerText || '').trim())
      ) as HTMLElement | undefined;
      if (apply) { apply.click(); return 'applied'; }
      return 'dialog-no-apply:' + (dialog as HTMLElement).innerText.slice(0, 120);
    });
    if (r === 'applied') { applied = true; break; }
    if (i === 29) console.log('upload poll last:', r);
  }
  await browser.pause(6000);
  return applied ? 'applied' : 'failed';
}

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  await browser.pause(6000);
  await browser.execute(() => { (document.querySelector('[aria-label="create"]') as HTMLElement | null)?.click(); });
  await browser.pause(7000);
  await browser.setWindowSize(1280, 1400);

  const titleArea = await browser.$('textarea[name="Article Title"]');
  await titleArea.click();
  await titleArea.setValue('PROBE inline image v2');

  console.log('paste seg1:', await pasteHtml('<p>导语段落，交代推文与作者来源。</p>', '导语段落，交代推文与作者来源。'));
  await browser.pause(2500);

  await ensureEmptyBlock();
  console.log('caret empty before img:', await caretInEmptyBlock());
  console.log('upload:', await uploadImage(headerPath));
  console.log('AFTER IMG:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '08-after-img-applied.png'));

  await ensureEmptyBlock();
  console.log('caret empty after img:', await caretInEmptyBlock());
  console.log('paste seg2:', await pasteHtml('<h2>机制剖析</h2><p>图片之后的正文，验证没有和上一段粘连。</p>', '机制剖析\n\n图片之后的正文'));
  await browser.pause(3000);
  console.log('AFTER SEG2:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '09-after-seg2.png'));
} finally {
  await driver.cleanup().catch(() => {});
}
