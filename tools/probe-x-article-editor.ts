/**
 * Probe script: dumps the real DOM of the X Articles composer so the publisher
 * refactor can target actual elements (toolbar media button, file inputs,
 * Draft.js block structure) instead of guesses.
 *
 * Usage: npx tsx tools/probe-x-article-editor.ts
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
  await browser.setWindowSize(1280, 1000);
  await browser.saveScreenshot(path.join(OUT, '01-list.png'));

  const listState = await browser.execute(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).map((b) => ({
      text: (b as HTMLElement).innerText?.trim().slice(0, 40),
      aria: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid'),
    }));
    return { url: location.href, title: document.title, buttons: btns.slice(0, 40) };
  });
  console.log('LIST STATE:', JSON.stringify(listState, null, 2));

  // open the composer
  const created = await browser.execute(() => {
    const btn =
      document.querySelector('[aria-label="create"]') ||
      Array.from(document.querySelectorAll('[role="button"], button')).find((b) =>
        /create|new/i.test((b as HTMLElement).innerText || '')
      );
    if (!btn) return false;
    (btn as HTMLElement).click();
    return true;
  });
  console.log('clicked create:', created);
  await browser.pause(7000);
  await browser.saveScreenshot(path.join(OUT, '02-composer.png'));

  const state = await browser.execute(() => {
    const composer = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
    const editor = document.querySelector('[contenteditable="true"]');
    const files = Array.from(document.querySelectorAll('input[type="file"]')).map((f) => ({
      accept: f.getAttribute('accept'),
      testid: f.getAttribute('data-testid'),
      multiple: (f as HTMLInputElement).multiple,
      hidden: (f as HTMLInputElement).hidden,
      outer: f.outerHTML.slice(0, 300),
    }));
    const toolbarButtons = Array.from(
      document.querySelectorAll('[role="toolbar"] button, [role="toolbar"] [role="button"], [data-testid*="toolbar"] button')
    ).map((b) => ({
      aria: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid'),
      text: (b as HTMLElement).innerText?.trim().slice(0, 30),
    }));
    const allAria = Array.from(document.querySelectorAll('[aria-label]'))
      .map((e) => e.getAttribute('aria-label') || '')
      .filter((a) => /image|media|photo|picture|add|insert|upload/i.test(a));
    return {
      url: location.href,
      hasComposer: Boolean(composer),
      composerHtml: composer ? composer.outerHTML.slice(0, 3000) : null,
      editorHtml: !composer && editor ? editor.outerHTML.slice(0, 1500) : null,
      files,
      toolbarButtons,
      relevantAria: Array.from(new Set(allAria)).slice(0, 40),
      textareas: Array.from(document.querySelectorAll('textarea')).map((t) => t.outerHTML.slice(0, 200)),
    };
  });
  console.log('COMPOSER STATE:', JSON.stringify(state, null, 2));

  await fs.writeFile(path.join(OUT, 'composer-state.json'), JSON.stringify(state, null, 2));
} finally {
  await driver.cleanup().catch(() => {});
}
