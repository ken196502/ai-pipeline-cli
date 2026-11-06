import test from 'node:test';
import assert from 'node:assert';
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

test('inspect X account published articles and drafts', async () => {
  const driver = new FirefoxBiDiDriver({
    firefoxBinary: '/usr/bin/firefox-esr',
    headless: true,
    cookiesPath: 'x_cookies.json',
  });
  const browser = await driver.launch();
  try {
    await driver.injectCookies('https://x.com');
    await browser.url('https://x.com/compose/articles');
    await browser.pause(5000);

    const info = await browser.execute(() => {
      const pageText = document.body.innerText || '';
      const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map(t => t.textContent?.trim());
      const links = Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText?.trim() }));
      return {
        url: location.href,
        title: document.title,
        tabs,
        linksCount: links.length,
        links: links.filter(l => l.href.includes('article') || l.href.includes('status')),
        preview: pageText.slice(0, 500)
      };
    });

    console.log('X compose/articles inspect:', JSON.stringify(info, null, 2));
    assert.ok(info.url.includes('articles'));
  } finally {
    await driver.close();
  }
});
