import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import pc from 'picocolors';
import { ensureStandardBinaryPaths, resolveYtDlpBinary } from '../../libs/media/ytdlp.js';
import { isPromotedTweet } from '../discovery/search.js';
import { transcribeTweetVideo, checkPuterAsrReady } from '../../libs/asr/index.js';
import type { XHotHarvestItem, XHotHarvestResult, HarvestWinnerOptions } from './contracts.js';
import { evaluateTweetRichnessWithVL } from './eval-richness.js';


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

interface ScannedCandidateTweet {
  index: number;
  tweetId: string;
  tweetUrl?: string;
  authorName: string;
  authorHandle: string;
  text: string;
  screenshotPath: string;
  imageUrls: string[];
  hasVideo: boolean;
}

/**
 * Searches X for the top-1 winner topic, scrolls through top discussions,
 * scans the first previewCount (default 20) tweets, evaluates their richness with VL,
 * and then harvests materials (screenshots, media files, ASR) for the top targetCount (default 10) tweets.
 */
export async function harvestWinnerTopicMaterials(
  page: Page,
  options: HarvestWinnerOptions
): Promise<XHotHarvestResult> {
  const { winnerName, previewCount = 20, targetCount = 10, outDir, onProgress } = options;
  const materialsDir = path.join(outDir, 'materials');
  const shotsDir = path.join(materialsDir, 'tweets');
  const mediaDir = path.join(materialsDir, 'media');
  const previewShotsDir = path.join(materialsDir, 'preview-shots');

  await fs.mkdir(materialsDir, { recursive: true });
  await fs.mkdir(shotsDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.mkdir(previewShotsDir, { recursive: true });

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

  const scannedCandidates: ScannedCandidateTweet[] = [];
  const seenTweetIds = new Set<string>();
  let scrollAttempts = 0;

  report(`Scanning top ${previewCount} tweets for VL richness evaluation...`);

  while (scannedCandidates.length < previewCount && scrollAttempts < 15) {
    scrollAttempts++;
    const tweetElements = await page.$$(tweetSelector);

    for (const tweetEl of tweetElements) {
      if (scannedCandidates.length >= previewCount) break;

      try {
        if (await isPromotedTweet(tweetEl)) {
          report('Skipping promoted ad tweet in harvest scan...');
          continue;
        }

        const linkEl = await tweetEl.$('a[href*="/status/"]');
        const href = linkEl ? await linkEl.getAttribute('href') : null;
        let tweetId = '';
        if (href) {
          const match = href.match(/\/status\/(\d+)/);
          tweetId = match ? match[1] : href;
        }
        if (!tweetId) tweetId = `harvest-cand-${scannedCandidates.length + 1}`;

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

        // Capture preview screenshot card
        await tweetEl.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(200);

        const candIndex = scannedCandidates.length + 1;
        const screenshotPath = path.join(previewShotsDir, `cand-${candIndex}.png`);
        try {
          await tweetEl.screenshot({ path: screenshotPath, type: 'png' });
        } catch {
          await page.screenshot({ path: screenshotPath, type: 'png' });
        }

        // Detect images
        const imgEls = await tweetEl.$$('img[src*="pbs.twimg.com/media/"]');
        const imageUrls: string[] = [];
        for (const imgEl of imgEls) {
          const src = await imgEl.getAttribute('src');
          if (src) {
            imageUrls.push(src.replace(/name=\w+/, 'name=large'));
          }
        }

        // Detect video
        const videoEl = await tweetEl.$('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
        const hasVideo = Boolean(videoEl && tweetUrl);

        scannedCandidates.push({
          index: candIndex,
          tweetId,
          tweetUrl,
          authorName,
          authorHandle,
          text,
          screenshotPath,
          imageUrls,
          hasVideo,
        });

        report(`Scanned candidate #${candIndex}: [${authorHandle}] (Images: ${imageUrls.length}, HasVideo: ${hasVideo})`);
      } catch (err: any) {
        // Skip single tweet parse error
      }
    }

    if (scannedCandidates.length < previewCount) {
      report(`Scrolling for more candidate tweets (${scannedCandidates.length}/${previewCount})...`);
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(2000);
    }
  }

  report(`Found ${scannedCandidates.length} candidate tweets. Evaluating richness with VL to select top ${targetCount}...`);

  // Evaluate candidate richness with VL
  let selectedIndices: number[] = [];
  try {
    selectedIndices = await evaluateTweetRichnessWithVL({
      topicName: winnerName,
      candidates: scannedCandidates,
      targetCount,
      outDir,
      onProgress: (m) => report(`[richness-eval] ${m}`),
    });
  } catch (evalErr: any) {
    report(`VL richness evaluation warning: ${evalErr.message}. Falling back to top ${targetCount} scanned.`);
    selectedIndices = scannedCandidates.slice(0, targetCount).map((c) => c.index);
  }

  const selectedCandidates = selectedIndices
    .map((idx) => scannedCandidates.find((c) => c.index === idx))
    .filter((c): c is ScannedCandidateTweet => Boolean(c));

  report(`Proceeding to harvest full materials for ${selectedCandidates.length} chosen tweets...`);

  const items: XHotHarvestItem[] = [];
  let totalMediaFiles = 0;

  for (let i = 0; i < selectedCandidates.length; i++) {
    const cand = selectedCandidates[i];
    const harvestIndex = i + 1;
    const finalShotPath = path.join(shotsDir, `tweet-${harvestIndex}.png`);

    // Copy or move preview screenshot to official tweets shot directory
    try {
      await fs.copyFile(cand.screenshotPath, finalShotPath);
    } catch {
      // Fallback
    }

    const mediaFiles: XHotHarvestItem['mediaFiles'] = [];

    // Download images
    for (let mIdx = 0; mIdx < cand.imageUrls.length; mIdx++) {
      const cleanUrl = cand.imageUrls[mIdx];
      const localImgPath = path.join(mediaDir, `img-${harvestIndex}-${mIdx + 1}.jpg`);
      const ok = await downloadImage(cleanUrl, localImgPath);
      if (ok) {
        mediaFiles.push({ kind: 'image', localPath: localImgPath, url: cleanUrl });
        totalMediaFiles++;
      }
    }

    // Download video & transcribe if present
    let asrTranscript: string | undefined;
    if (cand.hasVideo && cand.tweetUrl) {
      const localVideoPath = path.join(mediaDir, `video-${harvestIndex}.mp4`);
      report(`Harvesting video attachment for tweet #${harvestIndex} (${cand.tweetId})...`);
      const downloaded = await downloadTweetVideo(cand.tweetUrl, localVideoPath);
      if (downloaded) {
        let videoAsrText: string | undefined;
        if (options.transcribeVideos !== false) {
          const asrReady = await checkPuterAsrReady();
          if (asrReady.configured) {
            report(`Running Puter ASR on downloaded video ${path.basename(localVideoPath)}...`);
            try {
              const asrRes = await transcribeTweetVideo(localVideoPath, {}, (msg) => {
                report(`[asr] ${msg}`);
              });
              if (asrRes.text && asrRes.text.trim()) {
                videoAsrText = asrRes.text.trim();
                asrTranscript = videoAsrText;
                report(`✓ ASR Transcribed (${videoAsrText.length} chars): "${videoAsrText.slice(0, 80).replace(/\n/g, ' ')}..."`);
              }
            } catch (asrErr: any) {
              report(`⚠ Puter ASR failed: ${asrErr.message}`);
            }
          } else {
            report(`ℹ Puter ASR not configured (PUTER_AUTH_TOKEN missing), skipping speech transcription.`);
          }
        }

        mediaFiles.push({
          kind: 'video',
          localPath: localVideoPath,
          url: cand.tweetUrl,
          asrTranscript: videoAsrText,
        });
        totalMediaFiles++;
        report(`✓ Successfully downloaded video asset: ${path.basename(localVideoPath)}`);
      }
    }

    const item: XHotHarvestItem = {
      tweetId: cand.tweetId,
      url: cand.tweetUrl,
      authorName: cand.authorName,
      authorHandle: cand.authorHandle,
      text: cand.text,
      mediaFiles,
      asrTranscript,
      screenshotPath: finalShotPath,
    };

    items.push(item);
    report(`✓ Completed harvest item #${harvestIndex}: [${cand.authorHandle}] with ${mediaFiles.length} media file(s)`);
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
