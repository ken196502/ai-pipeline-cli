/**
 * Probe #3: interleaved strategy — paste HTML segment, then upload image via the
 * hidden fileInput (addValue, not setValue), then paste the next segment. Checks
 * whether the atomic image block lands at the caret (end of pasted content) and
 * whether the caret then advances for the following paste.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const OUT = path.resolve('artifacts/_scratch/probe');
await fs.mkdir(OUT, { recursive: true });

const headerPng = (await fs.readdir('artifacts/xdev', { recursive: true })).filter((f) => /(^|\/)header-image-.*\.png$/.test(f)).sort().pop()!;
const headerPath = path.resolve('artifacts/xdev', headerPng);
console.log('using header image:', headerPath);

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

const dumpBlocks = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
    if (!composer) return { error: 'no composer' };
    const blocks = Array.from(composer.querySelectorAll('[data-block="true"]')).map((b) => ({
      cls: (b.className || '').split(' ')[0],
      tag: b.tagName,
      text: (b as HTMLElement).innerText?.slice(0, 40),
      img: (b.querySelector('img') as HTMLImageElement | null)?.src?.slice(0, 60) || null,
    }));
    return { count: blocks.length, blocks };
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
      props.onPaste({
        clipboardData,
        preventDefault: () => {},
        stopPropagation: () => {},
        isDefaultPrevented: () => false,
        nativeEvent: { clipboardData },
      });
      return 'ok';
    },
    html,
    plain
  );

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  await browser.pause(6000);
  await browser.execute(() => {
    (document.querySelector('[aria-label="create"]') as HTMLElement | null)?.click();
  });
  await browser.pause(7000);
  await browser.setWindowSize(1280, 1200);

  const titleArea = await browser.$('textarea[name="Article Title"]');
  await titleArea.click();
  await titleArea.setValue('PROBE interleaved image');

  console.log('seg1:', await pasteHtml('<p>开头导语段落，交代推文来源。</p><h2>机制一</h2><p>正文一。</p>', '开头导语段落\n\n机制一\n\n正文一。'));
  await browser.pause(3000);

  // upload via addValue (hidden input, so no clear/interactability check)
  const fileInput = await browser.$('input[data-testid="fileInput"]');
  await fileInput.addValue(headerPath);
  console.log('addValue sent, waiting for upload...');
  await browser.pause(15000);
  console.log('AFTER IMAGE 1:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '05-after-img1.png'));

  console.log('seg2:', await pasteHtml('<h2>机制二</h2><p>正文二，位于图片之后。</p>', '机制二\n\n正文二，位于图片之后。'));
  await browser.pause(4000);
  console.log('AFTER SEG2:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '06-after-seg2.png'));

  // second image, no paste in between
  await fileInput.addValue(headerPath);
  await browser.pause(15000);
  console.log('AFTER IMAGE 2:', JSON.stringify(await dumpBlocks(), null, 2));
  await browser.saveScreenshot(path.join(OUT, '07-after-img2.png'));

  console.log('EDITOR URL:', await browser.getUrl());
  console.log('title value:', await titleArea.getValue());
} finally {
  await driver.cleanup().catch(() => {});
}
