import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import pc from 'picocolors';
import { ensureStandardBinaryPaths, resolveYtDlpBinary } from '../../libs/media/ytdlp.js';
import { isPromotedTweet } from '../discovery/search.js';
import type { XHotHarvestItem, XHotHarvestResult, HarvestWinnerOptions } from './contracts.js';

const execFileAsync = promisify(execFile);

/**
 * Downloads an image from a URL into local file.
 */
async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return false;
    const arrayBuffer = await res.arrayBuffer();
    await fs.writeFile(destPath, Buffer.from(arrayBuffer));
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts to download video media from a tweet URL via yt-dlp.
 */
async function downloadTweetVideo(tweetUrl: string, destMp4Path: string): Promise<boolean> {
  ensureStandardBinaryPaths();
  try {
    const ytdlpBin = await resolveYtDlpBinary();
    await execFileAsync(
      ytdlpBin,
      [
        tweetUrl,
        '-f',
        'bv*+ba/b',
        '-S',
        'res:1080,ext:mp4:m4a',
        '--recode-video',
        'mp4',
        '-o',
        destMp4Path,
        '--no-playlist',
        '--socket-timeout',
        '30',
      ],
      { timeout: 60_000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches X for the top-1 winner topic, scrolls through top discussions,
 * collects tweets, downloads high-res images and videos, and captures tweet screenshots.
 */
export async function harvestWinnerTopicMaterials(
  page: Page,
  options: HarvestWinnerOptions
): Promise<XHotHarvestResult> {
  const { winnerName, targetCount = 6, outDir, onProgress } = options;
  const materialsDir = path.join(outDir, 'materials');
  const shotsDir = path.join(materialsDir, 'tweets');
  const mediaDir = path.join(materialsDir, 'media');

  await fs.mkdir(materialsDir, { recursive: true });
  await fs.mkdir(shotsDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });

  const report = (msg: string) => {
    console.log(pc.cyan(`[x-harvest] ${msg}`));
    onProgress?.(msg);
  };

  const searchUrl = `https://x.com/search?q=${encodeURIComponent(winnerName)}&f=top`;
  report(`Deep searching X for winner topic: "${winnerName}" -> ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);

  const tweetSelector = 'article[data-testid="tweet"]';
  await page.waitForSelector(tweetSelector, { state: 'visible', timeout: 20_000 }).catch(() => {});

  const items: XHotHarvestItem[] = [];
  const seenTweetIds = new Set<string>();
  let totalMediaFiles = 0;
  let scrollAttempts = 0;

  while (items.length < targetCount && scrollAttempts < 10) {
    scrollAttempts++;
    const tweetElements = await page.$$(tweetSelector);

    for (const tweetEl of tweetElements) {
      if (items.length >= targetCount) break;

      try {
        // Skip ads / promoted tweets during deep harvest
        if (await isPromotedTweet(tweetEl)) {
          report('Skipping promoted ad tweet in harvest...');
          continue;
        }

        const linkEl = await tweetEl.$('a[href*="/status/"]');
        const href = linkEl ? await linkEl.getAttribute('href') : null;
        let tweetId = '';
        if (href) {
          const match = href.match(/\/status\/(\d+)/);
          tweetId = match ? match[1] : href;
        }
        if (!tweetId) tweetId = `harvest-${items.length + 1}`;

        if (seenTweetIds.has(tweetId)) continue;
        seenTweetIds.add(tweetId);

        const tweetUrl = href ? (href.startsWith('http') ? href : `https://x.com${href}`) : undefined;

        // Author & text
        const authorEl = await tweetEl.$('[data-testid="User-Name"]');
        const authorText = authorEl ? (await authorEl.innerText()).split('\n') : [];
        const authorName = authorText[0] || 'Contributor';
        const authorHandle = authorText.find((t) => t.startsWith('@')) || '';

        const textEl = await tweetEl.$('[data-testid="tweetText"]');
        const text = textEl ? (await textEl.innerText()).trim() : '';

        // Capture tweet screenshot card
        await tweetEl.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(200);

        const screenshotPath = path.join(shotsDir, `tweet-${items.length + 1}.png`);
        try {
          await tweetEl.screenshot({ path: screenshotPath, type: 'png' });
        } catch {
          await page.screenshot({ path: screenshotPath, type: 'png' });
        }

        const mediaFiles: XHotHarvestItem['mediaFiles'] = [];

        // Check for images
        const imgEls = await tweetEl.$$('img[src*="pbs.twimg.com/media/"]');
        for (let mIdx = 0; mIdx < imgEls.length; mIdx++) {
          const src = await imgEls[mIdx].getAttribute('src');
          if (src) {
            // Replace with large format if present
            const cleanUrl = src.replace(/name=\w+/, 'name=large');
            const localImgPath = path.join(mediaDir, `img-${items.length + 1}-${mIdx + 1}.jpg`);
            const ok = await downloadImage(cleanUrl, localImgPath);
            if (ok) {
              mediaFiles.push({ kind: 'image', localPath: localImgPath, url: cleanUrl });
              totalMediaFiles++;
            }
          }
        }

        // Check for video container
        const videoEl = await tweetEl.$('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
        if (videoEl && tweetUrl) {
          const localVideoPath = path.join(mediaDir, `video-${items.length + 1}.mp4`);
          report(`Found video attachment in tweet ${tweetId}, attempting download via yt-dlp...`);
          const downloaded = await downloadTweetVideo(tweetUrl, localVideoPath);
          if (downloaded) {
            mediaFiles.push({ kind: 'video', localPath: localVideoPath, url: tweetUrl });
            totalMediaFiles++;
            report(`✓ Successfully downloaded video asset: ${path.basename(localVideoPath)}`);
          }
        }

        const item: XHotHarvestItem = {
          tweetId,
          url: tweetUrl,
          authorName,
          authorHandle,
          text,
          mediaFiles,
          screenshotPath,
        };

        items.push(item);
        report(`Harvested item #${items.length}: [${authorHandle}] with ${mediaFiles.length} media file(s)`);
      } catch (err: any) {
        // Skip single tweet parse error
      }
    }

    if (items.length < targetCount) {
      report(`Scrolling for more discussion materials (${items.length}/${targetCount})...`);
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(2000);
    }
  }

  const result: XHotHarvestResult = {
    topicName: winnerName,
    items,
    harvestedMediaCount: totalMediaFiles,
    materialsDir,
  };

  await fs.writeFile(
    path.join(outDir, 'harvest-result.json'),
    JSON.stringify(result, null, 2) + '\n',
    'utf-8'
  );

  report(`Completed harvesting materials for "${winnerName}": ${items.length} tweets, ${totalMediaFiles} media items.`);
  return result;
}
