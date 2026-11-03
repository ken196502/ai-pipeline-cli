/**
 * Draft-only smoke test for the refactored X Article publisher.
 *
 *   npx tsx tools/x-article-draft-test.ts [markdown] [summary-json]
 *
 * Fills the real X Article editor with a previously generated article, inserts
 * the cover + inline images, verifies the block structure and saves screenshots.
 * It NEVER clicks Publish.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';

import { FirefoxBiDiDriver } from '../src/pipelines/xdev/bidi-driver.js';
import { publishArticleToX } from '../src/pipelines/xdev/publisher.js';

const ART = path.resolve('artifacts/xdev');

async function latest(prefix: string, ext: string): Promise<string> {
  const files = (await fs.readdir(ART, { recursive: true })).filter((f) => path.basename(f).startsWith(prefix) && f.endsWith(ext)).sort();
  if (!files.length) throw new Error(`no ${prefix}*${ext} in ${ART}`);
  return path.join(ART, files[files.length - 1]);
}

const markdownPath = process.argv[2] ? path.resolve(process.argv[2]) : await latest('multi-agent-thinking-', '.md');
const summaryPath = process.argv[3] ? path.resolve(process.argv[3]) : await latest('xdev-summary-', '.json');

const markdown = await fs.readFile(markdownPath, 'utf-8');
const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
const topic = summary.selectedTopics?.[0];
if (!topic?.tweetUrl) throw new Error(`no selectedTopics[0].tweetUrl in ${summaryPath}`);

const stamp = path.basename(markdownPath).replace(/^multi-agent-thinking-|\.md$/g, '');
const coverPath = path.join(ART, `header-image-${stamp}.png`);
console.log(pc.cyan(`markdown : ${markdownPath}`));
console.log(pc.cyan(`summary  : ${summaryPath}`));
console.log(pc.cyan(`cover    : ${coverPath}`));

const authorMatch = String(topic.author || '').match(/^(.*?)\s*\(@?([\w]+)\)$/);
const authorName = (authorMatch?.[1] || topic.author || 'unknown').trim();
const authorHandle = (authorMatch?.[2] || 'unknown').trim();

const driver = new FirefoxBiDiDriver({ headless: true, cookiesPath: 'x_cookies.json' });
const browser = await driver.launch();

try {
  await driver.injectCookies('https://x.com');

  // Pull the real tweet text so the citation block is genuine, not invented.
  console.log(pc.cyan(`fetching tweet text: ${topic.tweetUrl}`));
  await browser.url(topic.tweetUrl);
  await browser.pause(6000);
  const tweetText = await browser.execute(() => {
    const article = document.querySelector('article');
    if (!article) return '';
    const nodes = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
    return nodes.map((n) => (n as HTMLElement).innerText).join('\n').trim();
  });
  if (!tweetText) throw new Error(`could not read tweet text from ${topic.tweetUrl}`);
  console.log(pc.dim(`tweet: ${tweetText.slice(0, 120).replace(/\n/g, ' ')}…`));

  const result = await publishArticleToX(browser, {
    title: summary.articleTitle || topic.topic,
    markdownContent: markdown,
    coverImagePath: coverPath,
    mode: 'draft',
    assetBaseDir: ART,
    artifactDir: ART,
    screenshots: 4,
    source: {
      authorName,
      authorHandle,
      tweetUrl: topic.tweetUrl,
      tweetText,
    },
  });

  const outPath = path.join(ART, `x-article-draft-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(outPath, JSON.stringify({ markdownPath, summaryPath, tweetText, result }, null, 2), 'utf-8');

  console.log('\n================ RESULT ================');
  console.log(JSON.stringify(result, null, 2));
  console.log(`saved: ${outPath}`);
  if (!result.success) process.exitCode = 1;
} finally {
  await driver.cleanup().catch(() => {});
}
