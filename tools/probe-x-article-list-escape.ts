/**
 * Probe #13: how to exit a Draft.js list in the X Article editor, plus toolbar
 * button labels (list toggles) so the publisher can force block types.
 */
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

const dump = () =>
  browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]') as HTMLElement;
    const blocks = Array.from(composer.querySelectorAll('[data-block="true"]')).map((b) => ({
      cls: (b.className || '').split(' ')[0] || b.tagName,
      text: (b as HTMLElement).innerText?.replace(/\n/g, '\\n').slice(0, 20),
    }));
    let caret: any = null;
    const sel = window.getSelection();
    let el: any = sel?.anchorNode;
    el = el?.nodeType === 1 ? el : el?.parentElement;
    while (el && el !== composer && !el.hasAttribute?.('data-block')) el = el.parentElement;
    if (el && el !== composer) caret = { cls: (el.className || '').split(' ')[0] || el.tagName };
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

const caretEnd = () =>
  browser.execute(() => {
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

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/compose/articles');
  await browser.pause(6000);
  await browser.execute(() => { (document.querySelector('[aria-label="create"]') as HTMLElement | null)?.click(); });
  await browser.pause(7000);
  await browser.setWindowSize(1280, 1400);
  const titleArea = await browser.$('textarea[name="Article Title"]');
  await titleArea.click();
  await titleArea.setValue('PROBE list escape');

  const toolbar = await browser.execute(() =>
    Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'))
      .map((b) => b.getAttribute('aria-label'))
      .filter((a) => a && !/^[A-Z]$/.test(a))
  );
  console.log('toolbar labels:', JSON.stringify(toolbar));

  await paste('<p>列表前段落。</p>', '列表前段落。');
  await browser.pause(2000);
  await caretEnd();
  await browser.pause(300);
  await browser.keys(['Enter']);
  await browser.pause(600);
  await paste('<ul><li>项一</li><li>项二</li></ul>', '项一\n项二');
  await browser.pause(2500);
  console.log('after list:', JSON.stringify(await dump()));

  await caretEnd();
  await browser.pause(300);
  await browser.keys(['Enter']);
  await browser.pause(800);
  console.log('after Enter (empty list item):', JSON.stringify(await dump()));

  await browser.keys(['Backspace']);
  await browser.pause(800);
  console.log('after Backspace:', JSON.stringify(await dump()));

  // if still a list item, try the toolbar list toggle
  let st = await dump();
  if (st.caret?.cls?.includes('list')) {
    const toggled = await browser.execute(() => {
      const btn = Array.from(document.querySelectorAll('button[aria-label]')).find((b) =>
        /list/i.test(b.getAttribute('aria-label') || '')
      ) as HTMLElement | undefined;
      if (!btn) return 'no list button';
      btn.click();
      return 'clicked ' + btn.getAttribute('aria-label');
    });
    console.log('toggle list:', toggled);
    await browser.pause(1500);
    console.log('after toggle:', JSON.stringify(await dump()));
  }

  // paste a heading after the list
  await paste('<h2>列表后的标题</h2><p>列表后的段落。</p>', '列表后的标题\n\n列表后的段落。');
  await browser.pause(2500);
  console.log('FINAL:', JSON.stringify(await dump()));
} finally {
  await driver.cleanup().catch(() => {});
}
