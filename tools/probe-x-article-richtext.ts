/**
 * Probe #2: does X's Article composer accept rich HTML paste (h2 / blockquote /
 * list) and does setting the hidden fileInput insert an inline image block at
 * the caret? Answers decide how much structure the publisher can preserve.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');
await fs.mkdir(OUT, { recursive: true });

const headerPng = (await fs.readdir('artifacts/xdev', { recursive: true })).filter((f) => /(^|\/)header-image-.*\.png$/.test(f)).sort().pop();
if (!headerPng) throw new Error('no header image found');
const headerPath = path.resolve('artifacts/xdev', headerPng);
console.log('using header image:', headerPath);

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

const dumpBlocks = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
    if (!composer) return { error: 'no composer' };
    const blocks = Array.from(composer.querySelectorAll('[data-block="true"]')).map((b) => ({
      cls: b.className,
      tag: b.tagName,
      text: (b as HTMLElement).innerText?.slice(0, 60),
      hasImg: Boolean(b.querySelector('img')),
      html: b.outerHTML.slice(0, 400),
    }));
    return { count: blocks.length, blocks };
  });

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  await browser.pause(6000);
  await browser.execute(() => {
    const btn = document.querySelector('[aria-label="create"]') as HTMLElement | null;
    btn?.click();
  });
  await browser.pause(7000);
  await browser.setWindowSize(1280, 1200);

  const titleArea = await browser.$('textarea[name="Article Title"]');
  await titleArea.click();
  await titleArea.setValue('PROBE rich paste structure');

  // --- Test 1: rich HTML paste ---
  const htmlPaste = await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as any;
    const propsKey = Object.keys(composer).find((k) => k.startsWith('__reactProps$'));
    const props = propsKey ? composer[propsKey] : null;
    if (!props?.onPaste) return 'no onPaste';
    const html =
      '<h2>小标题测试 Heading</h2><p>第一段普通正文，用于验证段落块。</p>' +
      '<blockquote>这是一段引用：@someone 在推文中指出问题。</blockquote>' +
      '<ul><li>列表项一</li><li>列表项二</li></ul><p>结尾段落。</p>';
    const data: Record<string, string> = { 'text/html': html, 'text/plain': '小标题测试\n\n第一段\n\n引用\n\n结尾' };
    const clipboardData = {
      getData: (t: string) => data[t] || '',
      types: Object.keys(data),
      files: [],
    };
    props.onPaste({
      clipboardData,
      preventDefault: () => {},
      stopPropagation: () => {},
      isDefaultPrevented: () => false,
      nativeEvent: { clipboardData },
    });
    return 'pasted';
  });
  console.log('html paste result:', htmlPaste);
  await browser.pause(4000);
  console.log('BLOCKS AFTER HTML PASTE:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '03-html-paste.png'));

  // --- Test 2: inline image insert via fileInput at caret ---
  const caret = await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as HTMLElement;
    if (!composer) return 'no composer';
    composer.focus();
    const sel = window.getSelection();
    const blocks = composer.querySelectorAll('[data-block="true"]');
    const last = blocks[blocks.length - 1] as HTMLElement | undefined;
    if (last) {
      const range = document.createRange();
      range.selectNodeContents(last);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return 'caret at end';
  });
  console.log('caret:', caret);

  const fileInput = await browser.$('input[data-testid="fileInput"]');
  console.log('fileInput exists:', await fileInput.isExisting());
  await fileInput.setValue(headerPath);
  await browser.pause(12000);
  console.log('BLOCKS AFTER IMAGE:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '04-after-image.png'));

  const editorUrl = await browser.getUrl();
  console.log('EDITOR URL:', editorUrl);
} finally {
  await driver.cleanup().catch(() => {});
}
