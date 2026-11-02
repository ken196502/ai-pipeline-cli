/**
 * Low-level driver for the X Articles editor (Draft.js based).
 *
 * Everything here was verified against the live editor (see tools/probe-x-article-*.ts):
 *  - rich HTML paste through __reactProps$.onPaste keeps h2 / blockquote / lists
 *  - the cover image uses the top-level fileInput (accept without video) + "Apply"
 *  - inline images need Add Media -> Media -> the dialog fileInput (accept with video)
 *  - dividers come from Add Media -> Divider
 *  - after a paste the caret sits in the last block: a non-empty last block makes
 *    the next paste merge into it, so every op first creates an empty paragraph
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'webdriverio';
import pc from 'picocolors';

export type EditorBlockType =
  | 'heading'
  | 'paragraph'
  | 'quote'
  | 'list-item'
  | 'image'
  | 'divider'
  | 'other';

export interface EditorBlock {
  type: EditorBlockType;
  text: string;
  hasImage: boolean;
}

export interface EditorStructure {
  blocks: EditorBlock[];
  counts: Record<EditorBlockType, number>;
  /** CJK text is not counted by X's "N words" indicator, so char count is the real gate. */
  chars: number;
  wordCount: number | null;
  url: string;
}

const COMPOSER = 'div[data-testid="composer"][contenteditable="true"]';
const TITLE = 'textarea[name="Article Title"]';

function classify(className: string, tag: string, hasImage: boolean): EditorBlockType {
  if (hasImage) return 'image';
  if (className.includes('longform-header')) return 'heading';
  if (className.includes('longform-blockquote')) return 'quote';
  if (className.includes('list-item')) return 'list-item';
  if (tag === 'SECTION') return 'divider';
  if (className.includes('longform-unstyled')) return 'paragraph';
  return 'other';
}

export async function waitForComposer(browser: Browser, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await browser.execute(
      (sel: string) => Boolean(document.querySelector(sel)),
      COMPOSER
    );
    if (ok) return;
    await browser.pause(1000);
  }
  throw new Error(`[x-editor] composer (${COMPOSER}) did not appear within ${timeoutMs}ms`);
}

/** Opens a brand-new article draft and returns its edit URL. */
export async function openNewArticleDraft(browser: Browser): Promise<string> {
  await browser.url('https://x.com/compose/articles');
  await browser.pause(4000);

  const clicked = await browser.execute(() => {
    const btn =
      document.querySelector('[aria-label="create"]') ||
      Array.from(document.querySelectorAll('[role="button"], button')).find((b) =>
        /^create$/i.test(((b as HTMLElement).innerText || '').trim())
      );
    if (!btn) return false;
    (btn as HTMLElement).click();
    return true;
  });
  if (!clicked) throw new Error('[x-editor] could not find the "create" button on /compose/articles');

  await browser.pause(5000);
  await waitForComposer(browser);
  return browser.getUrl();
}

export async function setArticleTitle(browser: Browser, title: string): Promise<void> {
  const area = await browser.$(TITLE);
  if (!(await area.isExisting())) throw new Error(`[x-editor] title field (${TITLE}) not found`);
  await area.click();
  await area.setValue(title.slice(0, 100));
  await browser.pause(600);
  const value = await area.getValue();
  if (!value || value.trim().length === 0) throw new Error('[x-editor] title field stayed empty after setValue');
}

/** Snapshot of the current Draft.js content (block types, text, images). */
export async function readStructure(browser: Browser): Promise<EditorStructure> {
  const raw = await browser.execute(
    (sel: string) => {
      const composer = document.querySelector(sel);
      if (!composer) return null;
      const blocks = Array.from(composer.querySelectorAll('[data-block="true"]')).map((b) => ({
        className: (b.className || '').toString(),
        tag: b.tagName,
        text: ((b as HTMLElement).innerText || '').replace(/\u00a0/g, ' ').trim(),
        hasImage: Boolean(b.querySelector('img')),
      }));
      const wordMatch = (document.body.innerText || '').match(/(\d[\d,]*)\s+words?/i);
      const chars = blocks.reduce((n, b) => n + b.text.replace(/\s/g, '').length, 0);
      return {
        blocks,
        chars,
        wordCount: wordMatch ? Number(wordMatch[1].replace(/,/g, '')) : null,
        url: location.href,
      };
    },
    COMPOSER
  );

  if (!raw) throw new Error('[x-editor] composer not found while reading structure');

  const blocks: EditorBlock[] = raw.blocks.map((b: any) => ({
    type: classify(b.className, b.tag, b.hasImage),
    text: b.text.slice(0, 120),
    hasImage: b.hasImage,
  }));
  const counts: Record<EditorBlockType, number> = {
    heading: 0,
    paragraph: 0,
    quote: 0,
    'list-item': 0,
    image: 0,
    divider: 0,
    other: 0,
  };
  for (const b of blocks) counts[b.type] += 1;
  return { blocks, counts, chars: raw.chars, wordCount: raw.wordCount, url: raw.url };
}

async function focusLastBlockEnd(browser: Browser): Promise<void> {
  await browser.execute((sel: string) => {
    const composer = document.querySelector(sel) as HTMLElement | null;
    if (!composer) return;
    composer.focus();
    const blocks = composer.querySelectorAll('[data-block="true"]');
    const last = blocks[blocks.length - 1] as HTMLElement | undefined;
    if (!last) return;
    last.scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, COMPOSER);
  await browser.pause(250);
}

async function lastBlockState(browser: Browser): Promise<{ type: EditorBlockType; empty: boolean }> {
  const res = await browser.execute((sel: string) => {
    const composer = document.querySelector(sel) as HTMLElement | null;
    if (!composer) return null;
    const blocks = composer.querySelectorAll('[data-block="true"]');
    const last = blocks[blocks.length - 1] as HTMLElement | undefined;
    if (!last) return null;
    return {
      className: (last.className || '').toString(),
      tag: last.tagName,
      text: ((last as HTMLElement).innerText || '').replace(/\u00a0/g, ' ').trim(),
      hasImage: Boolean(last.querySelector('img')),
    };
  }, COMPOSER);
  if (!res) return { type: 'other', empty: false };
  return { type: classify(res.className, res.tag, res.hasImage), empty: res.text.length === 0 && !res.hasImage };
}

/**
 * Guarantee the caret sits in an EMPTY, plain paragraph block. Pasting into a
 * non-empty block merges into it (losing the pasted heading type), and Enter
 * inside a list item keeps the list alive, hence the Backspace step.
 */
export async function ensureEmptyParagraph(browser: Browser): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const last = await lastBlockState(browser);
    if (last.type === 'paragraph' && last.empty) {
      await focusLastBlockEnd(browser);
      // Draft.js keeps its own selection state: after an image upload the DOM
      // range points at the trailing paragraph while Draft still thinks the
      // atomic block is selected, and the next paste is silently dropped. A real
      // arrow keydown forces Draft to re-read the DOM selection.
      await browser.keys(['ArrowRight']);
      await browser.pause(250);
      return;
    }
    // An atomic block (image) holds the selection after an upload: Enter on it
    // creates the paragraph the next paste needs.
    await focusLastBlockEnd(browser);
    if (last.type === 'list-item' && last.empty) {
      await browser.keys(['Backspace']);
    } else {
      await browser.keys(['Enter']);
    }
    await browser.pause(600);
  }
  throw new Error('[x-editor] could not create an empty paragraph block for the next paste');
}

/** Rich-text paste (h2 / blockquote / list / links) into the composer. */
export async function pasteHtml(browser: Browser, html: string, plain: string): Promise<void> {
  const result = await browser.execute(
    (h: string, p: string, sel: string) => {
      const composer = document.querySelector(sel) as any;
      if (!composer) return 'no-composer';
      const propsKey = Object.keys(composer).find((k) => k.startsWith('__reactProps$'));
      const props = propsKey ? composer[propsKey] : null;
      if (!props?.onPaste) return 'no-onPaste';
      const data: Record<string, string> = { 'text/html': h, 'text/plain': p };
      const clipboardData = {
        getData: (type: string) => data[type] || '',
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
      return 'ok';
    },
    html,
    plain,
    COMPOSER
  );
  if (result !== 'ok') throw new Error(`[x-editor] paste failed: ${result}`);
  await browser.pause(1200);
}

/**
 * Pastes an HTML segment and verifies that its content really landed.
 *
 * Verification must look at BOTH block count and character count:
 *
 * - A single-block op (the opening lead paragraph) does not create a new block:
 *   X's paste handler fills the empty paragraph `ensureEmptyParagraph` prepared,
 *   so Δblocks is 0 while the text lands perfectly.
 * - `readStructure()` truncates each block's `text` to 120 chars for reporting, so
 *   summing those strings caps a long paragraph at ~104 non-space chars and makes
 *   every long op look truncated. The untruncated total is `structure.chars`,
 *   which is measured inside the page.
 *
 * Both mistakes made run 2026-11-02T11-05-28-396Z re-paste the same 836-char lead
 * three times and abort with "连续 3 次粘贴均未落盘" even though each paste worked.
 */
export async function pasteHtmlVerified(
  browser: Browser,
  html: string,
  plain: string,
  expectedBlocks: number
): Promise<void> {
  const minDelta = Math.max(1, expectedBlocks - 1);
  const minChars = Math.max(10, Math.floor(plain.replace(/\s/g, '').length * 0.8));
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Always re-establish a clean empty paragraph: after an image upload the
    // caret can still be parked on the atomic block, which drops the paste.
    await ensureEmptyParagraph(browser);
    const before = await readStructure(browser);
    await pasteHtml(browser, html, plain);
    await browser.pause(900);
    const after = await readStructure(browser);
    const delta = after.blocks.length - before.blocks.length;
    const deltaChars = after.chars - before.chars;
    if (delta >= minDelta || deltaChars >= minChars) return;
    const diag = await browser.execute((sel: string) => {
      const composer = document.querySelector(sel) as HTMLElement | null;
      const sel2 = window.getSelection();
      let el: any = sel2?.anchorNode;
      el = el?.nodeType === 1 ? el : el?.parentElement;
      let caret: string | null = null;
      while (el && el !== composer) {
        if (el.hasAttribute?.('data-block')) {
          caret = (el.className || '').split(' ')[0];
          break;
        }
        el = el.parentElement;
      }
      return {
        active: document.activeElement?.tagName + '/' + ((document.activeElement as HTMLElement)?.getAttribute('data-testid') || ''),
        caretBlock: caret,
        anchorInComposer: Boolean(composer && sel2?.anchorNode && composer.contains(sel2.anchorNode)),
      };
    }, COMPOSER);
    console.warn(
      pc.yellow(
        `  ⚠ [x-editor] paste #${attempt} 丢失（新增 ${delta} 块 / ${deltaChars} 字符，预期 ≥${minDelta} 块或 ≥${minChars} 字符），重新定位光标后重试 ${JSON.stringify(diag)}`
      )
    );
    await ensureEmptyParagraph(browser);
    await browser.keys(['ArrowRight']);
    await browser.pause(400);
  }
  throw new Error(
    `[x-editor] 连续 3 次粘贴均未落盘（预期 ≥${minDelta} 块或 ≥${minChars} 字符）`
  );
}

async function clickDialogButton(browser: Browser, pattern: RegExp, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await browser.execute((re: string) => {
      const rx = new RegExp(re, 'i');
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return 'no-dialog';
      const btn = Array.from(dialog.querySelectorAll('button, [role="button"]')).find((b) =>
        rx.test(((b as HTMLElement).innerText || '').trim())
      ) as HTMLElement | undefined;
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    }, pattern.source);
    if (clicked === 'clicked') return true;
    await browser.pause(1000);
  }
  return false;
}

async function findFileInput(browser: Browser, opts: { requireVideo: boolean }): Promise<any> {
  const inputs = await browser.$$('input[type="file"]');
  let fallback: any = null;
  for (const input of inputs) {
    const accept = (await input.getAttribute('accept')) || '';
    const hasVideo = accept.includes('video');
    if (opts.requireVideo === hasVideo) return input;
    if (!opts.requireVideo && !hasVideo) fallback = input;
  }
  return fallback;
}

/** Cover image (article banner): top fileInput + "Edit media" -> Apply. */
export async function uploadCoverImage(browser: Browser, filePath: string): Promise<void> {
  const input = await findFileInput(browser, { requireVideo: false });
  if (!input) throw new Error('[x-editor] cover file input not found');
  await input.addValue(path.resolve(filePath));
  const applied = await clickDialogButton(browser, /^apply$/i, 90_000);
  if (!applied) {
    console.warn(pc.yellow('  ⚠ [x-editor] cover "Apply" button not found; checking whether the cover still landed...'));
  }
  await browser.pause(4000);
}

async function openInsertMenu(browser: Browser, item: 'Media' | 'Divider'): Promise<void> {
  const opened = await browser.execute(() => {
    const btn = document.querySelector('[aria-label="Add Media"]') as HTMLElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error('[x-editor] "Add Media" toolbar button not found');
  await browser.pause(1500);

  const clicked = await browser.execute((label: string) => {
    const rx = new RegExp(`^${label}$`, 'i');
    const items = Array.from(
      document.querySelectorAll(
        '[role="menu"] [role="menuitem"], [role="menu"] [role="button"], [role="menu"] button, [role="menu"] div[tabindex]'
      )
    );
    const target = items.find((el) => rx.test(((el as HTMLElement).innerText || '').trim().split('\n')[0])) as
      | HTMLElement
      | undefined;
    if (!target) return false;
    target.click();
    return true;
  }, item);
  if (!clicked) throw new Error(`[x-editor] "Add Media" menu item "${item}" not found`);
  await browser.pause(2500);
}

/** Inline image: Add Media -> Media -> dialog upload -> wait for the atomic block. */
export async function insertInlineImage(browser: Browser, filePath: string, timeoutMs = 120_000): Promise<void> {
  await ensureEmptyParagraph(browser);
  const before = await readStructure(browser);
  await openInsertMenu(browser, 'Media');

  const input = await findFileInput(browser, { requireVideo: true });
  if (!input) throw new Error('[x-editor] inline media file input (accept with video) not found in the Insert dialog');
  await input.addValue(path.resolve(filePath));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await browser.pause(3000);
    const after = await readStructure(browser);
    if (after.counts.image > before.counts.image) {
      await browser.pause(2000);
      // Leave the caption editor so the next op's caret handling starts from the
      // composer, not from the image caption.
      await browser.keys(['Escape']);
      await browser.pause(800);
      return;
    }
    const failed = await browser.execute(() => /failed to upload/i.test(document.body.innerText || ''));
    if (failed) {
      const dialogText = await browser.execute(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? (d as HTMLElement).innerText.slice(0, 300) : '';
      });
      throw new Error(`[x-editor] inline image upload failed ("failed to upload") ${dialogText}`);
    }
  }
  throw new Error(`[x-editor] inline image did not appear within ${timeoutMs}ms (${path.basename(filePath)})`);
}

/** Horizontal divider between the citation and the article body. */
export async function insertDivider(browser: Browser): Promise<void> {
  await ensureEmptyParagraph(browser);
  const before = await readStructure(browser);
  await openInsertMenu(browser, 'Divider');
  await browser.pause(1500);
  const after = await readStructure(browser);
  if (after.counts.divider <= before.counts.divider) {
    throw new Error('[x-editor] divider block did not appear after clicking "Divider"');
  }
}

/** Waits until the draft is persisted (the header shows a save timestamp). */
export async function waitForAutosave(browser: Browser, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await browser.execute(() => {
      const text = document.body.innerText || '';
      return {
        saved: /Last saved/i.test(text),
        saving: /Saving\.\.\.|Uploading media/i.test(text),
      };
    });
    if (state.saved && !state.saving) return;
    await browser.pause(2000);
  }
  console.warn(pc.yellow('  ⚠ [x-editor] autosave indicator did not settle in time; continuing'));
}

/** Scrolls through the rendered article and stores screenshots. */
export async function captureEditorScreenshots(
  browser: Browser,
  dir: string,
  prefix: string,
  shots = 3
): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const files: string[] = [];

  // The editor scrolls inside a container, not the window.
  const metrics = await browser.execute((sel: string) => {
    const composer = document.querySelector(sel) as HTMLElement | null;
    let scroller: HTMLElement | null = null;
    let el: HTMLElement | null = composer?.parentElement || null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 40) {
        scroller = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scroller) scroller = (document.scrollingElement as HTMLElement) || document.documentElement;
    (window as any).__xdevScroller = scroller;
    scroller.scrollTop = 0;
    return { clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight };
  }, COMPOSER);

  await browser.pause(1200);
  const step = Math.max(200, Math.round(metrics.clientHeight * 0.85));
  for (let i = 0; i < shots; i++) {
    const file = path.join(dir, `${prefix}-${i + 1}.png`);
    await browser.saveScreenshot(file);
    files.push(file);
    if (i === shots - 1) break;
    await browser.execute((y: number) => {
      const scroller = (window as any).__xdevScroller as HTMLElement | null;
      if (scroller) scroller.scrollTop = y;
    }, step * (i + 1));
    await browser.pause(1200);
  }
  await browser.execute(() => {
    const scroller = (window as any).__xdevScroller as HTMLElement | null;
    if (scroller) scroller.scrollTop = 0;
  });
  return files;
}

/** Clicks Publish + fills the caption, then returns the resulting URL. */
export async function publishDraft(browser: Browser, caption: string): Promise<string> {
  const opened = await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === 'Publish');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error('[x-editor] Publish button not found');
  await browser.pause(3000);

  await browser.execute((cap: string) => {
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    if (!dialog) return;
    const field = dialog.querySelector('textarea, div[contenteditable="true"]') as HTMLTextAreaElement | null;
    if (!field) return;
    field.focus();
    field.value = cap;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, caption);
  await browser.pause(1000);

  const confirmed = await browser.execute(() => {
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll('button')).filter(
      (b) => (b.innerText || '').trim() === 'Publish' || b.getAttribute('aria-label') === 'Publish'
    );
    if (!buttons.length) return false;
    (buttons[buttons.length - 1] as HTMLElement).click();
    return true;
  });
  if (!confirmed) throw new Error('[x-editor] confirmation Publish button not found');
  await browser.pause(8000);
  return browser.getUrl();
}
