import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

async function test() {
  const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
  const browser = await driver.launch();
  try {
    await driver.injectCookies('https://x.com');
    const targetUrl = 'https://x.com/i/grok?conversation=6656bf93-7a94-43dc-b749-c556dcc6a21f';
    console.log('Navigating to user conversation:', targetUrl);
    await browser.url(targetUrl);
    await browser.pause(6000);

    const shotPath = 'artifacts/_scratch/screenshots/user-convo.png';
    await browser.saveScreenshot(shotPath);
    console.log('Saved screenshot to:', shotPath);

    const title = await browser.getTitle();
    console.log('Page title:', title);

    const texts = await browser.execute(() => {
      return Array.from(document.querySelectorAll('[data-testid="messageEntry"], [role="main"] div, [role="main"] p'))
        .map(el => (el as HTMLElement).innerText || '')
        .filter(t => t.length > 30)
        .slice(-10);
    });
    console.log('Found recent messages in convo:', texts.length);
    for (let i = 0; i < texts.length; i++) {
      console.log(`Msg #${i + 1}: ${texts[i].slice(0, 100)}...`);
    }
  } finally {
    await driver.cleanup();
  }
}
test().catch(console.error);
