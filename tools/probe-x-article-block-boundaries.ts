/**
 * Probe #12: block-boundary rules for segment-wise HTML paste.
 * Answers: after a segment, what block holds the caret, what does Enter create
 * for h2 / blockquote / list-item, and does the next paste keep its block type?
 */
import path from 'node:path';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

const dump = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
    if (!composer) return { error: 'no composer' };
    const blocks = Array.from(composer.querySelectorAll('[data-block="true"]')).map((b) => ({
      cls: (b.className || '').split(' ')[0] || b.tagName,
      text: (b as HTMLElement).innerText?.replace(/\n/g, '\\n').slice(0, 24),
    }));
    // caret block
    let caret: any = null;
    const sel = window.getSelection();
    let el: any = sel?.anchorNode;
    el = el?.nodeType === 1 ? el : el?.parentElement;
    while (el && el !== composer && !el.hasAttribute?.('data-block')) el = el.parentElement;
    if (el && el !== composer) {
      caret = { cls: (el.className || '').split(' ')[0] || el.tagName, text: (el as HTMLElement).innerText?.slice(0, 20) };
    }
    return { blocks, caret };
  });

const paste = (html: string, plain: string) =>
  browser.execute(
    (h: string, p: string) => {
      const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
      const k = Object.keys(composer).find((x) => x.startsWith('__reactProps$'));
      const props = k ? composer[k] : null;
      const data: Record<string, string> = { 'text/html': h, 'text/plain': p };
      const cd = { getData: (t: string) => data[t] || '', types: Object.keys(data), files: [] };
      props.onPaste({ clipboardData: cd, preventDefault: () => {}, stopPropagation: () => {}, isDefaultPrevented: () => false, nativeEvent: { clipboardData: cd } });
      return 'ok';
    },
    html,
    plain
  );

/** Move caret to end of document and press Enter when the caret block is not empty. */
async function newBlock(label: string) {
  const before = await dump();
  const isLastEmpty = await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as HTMLElement;
    const blocks = composer.querySelectorAll('[data-block="true"]');
    const last = blocks[blocks.length - 1] as HTMLElement;
    return ((last.innerText || '').trim() === '' && !last.querySelector('img'));
  });
  if (isLastEmpty) {
    console.log(`[${label}] last block already empty -> caret block:`, JSON.stringify((await dump()).caret));
    return;
  }
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
  await browser.pause(400);
  await browser.keys(['Enter']);
  await browser.pause(900);
  const after = await dump();
  console.log(`[${label}] before last=${JSON.stringify(before.blocks.at(-1))} -> after Enter caret=`, JSON.stringify(after.caret));
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
  await titleArea.setValue('PROBE block boundaries');

  await paste('<h2>标题一</h2><p>段落一。</p>', '标题一\n\n段落一。');
  await browser.pause(2500);
  console.log('1 after seg1:', JSON.stringify((await dump()).blocks));

  await newBlock('after h2+p');
  await paste('<h2>标题二</h2><p>段落二。</p>', '标题二\n\n段落二。');
  await browser.pause(2500);
  console.log('2 after seg2:', JSON.stringify((await dump()).blocks));

  await newBlock('after h2+p #2');
  await paste('<ul><li>项一</li><li>项二</li></ul>', '项一\n项二');
  await browser.pause(2500);
  console.log('3 after list:', JSON.stringify((await dump()).blocks));

  await newBlock('after list');
  await paste('<p>列表后的段落。</p>', '列表后的段落。');
  await browser.pause(2500);
  console.log('4 after para:', JSON.stringify((await dump()).blocks));

  await newBlock('after para');
  await paste('<blockquote>推文引用内容</blockquote>', '推文引用内容');
  await browser.pause(2500);
  console.log('5 after quote:', JSON.stringify((await dump()).blocks));

  await newBlock('after quote');
  await paste('<h2>引用后的标题</h2><p>引用后的段落。</p>', '引用后的标题\n\n引用后的段落。');
  await browser.pause(2500);
  console.log('6 final:', JSON.stringify((await dump()).blocks));
  await browser.saveScreenshot(path.join(OUT, '21-block-boundaries.png'));
} finally {
  await driver.cleanup().catch(() => {});
}
