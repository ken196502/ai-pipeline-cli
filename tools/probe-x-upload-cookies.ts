/**
 * Probe #10: are auth cookies visible on upload.x.com? The inline media upload
 * returns 401 "Could not authenticate you." while GraphQL on x.com works.
 */
import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

try {
  await driver.injectCookies('https://x.com');
  await browser.url('https://x.com/home');
  await browser.pause(3000);
  console.log('document.cookie on x.com:', await browser.execute(() => document.cookie.split('; ').map((c) => c.split('=')[0])));
  console.log('cookies visible for x.com:', (await browser.getCookies()).map((c: any) => `${c.name}@${c.domain}`));

  await browser.url('https://upload.x.com/');
  await browser.pause(3000);
  const cookiesUpload = await browser.getCookies().catch((e: any) => `ERR ${e.message}`);
  console.log('cookies visible for upload.x.com:', JSON.stringify(cookiesUpload, null, 2));

  // try a direct INIT call from the upload.x.com page
  const init = await browser.execute(async () => {
    try {
      const ct0 = document.cookie.split('; ').find((c) => c.startsWith('ct0='))?.split('=')[1] || '';
      const res = await fetch('https://upload.x.com/i/media/upload.json?command=INIT&total_bytes=12345&media_type=image%2Fjpeg&media_category=tweet_image', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': ct0 },
      });
      return { status: res.status, body: (await res.text()).slice(0, 200), ct0: ct0.slice(0, 6) };
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  });
  console.log('direct INIT from upload.x.com page:', JSON.stringify(init, null, 2));
} finally {
  await driver.cleanup().catch(() => {});
}
