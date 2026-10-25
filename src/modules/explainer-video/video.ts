import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import type {
  ExplainerAsset,
  ExplainerStoryboard,
  ExplainerVideoSummary,
} from '../../libs/player/contracts.js';
import {
  generateExplainerStoryboard,
  produceExplainerVideo,
} from './produce.js';
import { maskProfanity } from '../../utils/text.js';
import type { XHotEvalResult } from '../evaluation/contracts.js';
import type { XHotHarvestResult } from '../harvest/contracts.js';
import type { CreateExplainerVideoOptions } from './contracts.js';

/**
 * Builds OpusVideo materials list from Xhot evaluation and harvested assets.
 */
export async function buildExplainerAssets(
  evalResult: XHotEvalResult,
  harvestResult: XHotHarvestResult,
  assetsOutDir: string
): Promise<ExplainerAsset[]> {
  await fs.mkdir(assetsOutDir, { recursive: true });
  // Xhot-specific material preparation only: the shared explainer-video module
  // still receives plain video/image assets and owns the fullscreen layout.
  const videoAssets: ExplainerAsset[] = [];
  const imageAssets: ExplainerAsset[] = [];

  // 1. Candidate Grid & Individual Candidate Shots (Flash Montage)
  if (evalResult.gridImagePath) {
    try {
      const ext = path.extname(evalResult.gridImagePath) || '.png';
      const dest = path.join(assetsOutDir, `xhot-grid${ext}`);
      await fs.copyFile(evalResult.gridImagePath, dest);
      imageAssets.push({
        id: 'xhot-candidate-grid',
        kind: 'image',
        label: `X Topic Search Grid: ${evalResult.query}`,
        src: `assets/${path.basename(dest)}`,
        sourcePath: dest,
      });
    } catch {}

    // Check for candidate-shots directory next to gridImagePath
    try {
      const candShotsDir = path.join(path.dirname(evalResult.gridImagePath), 'candidate-shots');
      const candEntries = await fs.readdir(candShotsDir).catch(() => []);
      for (const entry of candEntries.sort()) {
        if (!entry.endsWith('.png') && !entry.endsWith('.jpg') && !entry.endsWith('.jpeg')) continue;
        const srcPath = path.join(candShotsDir, entry);
        const destPath = path.join(assetsOutDir, entry);
        await fs.copyFile(srcPath, destPath);
        const candId = entry.replace(/\.[^.]+$/, '');
        imageAssets.push({
          id: candId,
          kind: 'image',
          label: `Trending Candidate: ${candId}`,
          src: `assets/${entry}`,
          sourcePath: destPath,
        });
      }
    } catch {}
  }

  // 2. Harvested Tweets Screenshots & Media
  for (let i = 0; i < harvestResult.items.length; i++) {
    const item = harvestResult.items[i];
    const prefix = `tweet-${String(i + 1).padStart(2, '0')}`;

    // Tweet Screenshot - only include as candidate if the tweet doesn't have direct media files,
    // avoiding filling the asset pool with blurry/compressed tweet bounding-box cards.
    if (item.screenshotPath && item.mediaFiles.length === 0) {
      try {
        const dest = path.join(assetsOutDir, `${prefix}-shot.png`);
        await fs.copyFile(item.screenshotPath, dest);
        imageAssets.push({
          id: `${prefix}-shot`,
          kind: 'image',
          label: `Community Tweet by ${item.authorName} (${item.authorHandle})`,
          src: `assets/${path.basename(dest)}`,
          sourcePath: dest,
        });
      } catch {}
    }

    // Media attachments (images & videos)
    for (let m = 0; m < item.mediaFiles.length; m++) {
      const media = item.mediaFiles[m];
      const ext = path.extname(media.localPath) || (media.kind === 'video' ? '.mp4' : '.jpg');
      const destName = `${prefix}-media-${m + 1}${ext}`;
      const destPath = path.join(assetsOutDir, destName);
      try {
        await fs.copyFile(media.localPath, destPath);
        const target = media.kind === 'video' ? videoAssets : imageAssets;
        target.push({
          id: `${prefix}-${media.kind}-${m + 1}`,
          kind: media.kind,
          label:
            media.kind === 'video'
              ? `PRIORITY DEMO VIDEO from ${item.authorHandle} — use this instead of the tweet screenshot`
              : `Visual Preview from ${item.authorHandle}`,
          src: `assets/${destName}`,
          sourcePath: destPath,
        });
      } catch {}
    }
  }

  // Videos first so the storyboard LLM naturally prefers real demo footage.
  return [...videoAssets, ...imageAssets];
}
export const buildXHotTutorialAssets = buildExplainerAssets;

/**
 * Uses LLM to generate an OpusVideo storyboard introducing the #1 trending topic/model.
 */
export async function generateExplainerStoryboardFromXHot(
  evalResult: XHotEvalResult,
  harvestResult: XHotHarvestResult,
  assets: ExplainerAsset[]
): Promise<ExplainerStoryboard> {
  const assetListText = assets
    .map((a) =>
      a.kind === 'video'
        ? `- "${a.id}" (video, PRIORITY MATERIAL): ${a.label}`
        : `- "${a.id}" (${a.kind}): ${a.label}`
    )
    .join('\n');
  const videoAssetIds = assets.filter((a) => a.kind === 'video').map((a) => a.id);

  let maskedTweetCount = 0;
  const tweetSummaries = harvestResult.items
    .map((item, idx) => {
      const { text: safeText, maskedCount } = maskProfanity(item.text || '');
      if (maskedCount > 0) maskedTweetCount += 1;
      return `Tweet #${idx + 1} by ${item.authorName} (${item.authorHandle}):\n"${safeText}"`;
    })
    .join('\n\n');
  if (maskedTweetCount > 0) {
    console.log(
      pc.yellow(
        `[explainer-video] Masked profanity in ${maskedTweetCount} harvested tweet(s) for content-filter compliance`
      )
    );
  }

  const systemPrompt = `You are a world-class technology journalist, lead documentary director, and analytical narrator.
You craft calm, authoritative, deeply informative, and engaging documentary videos about breaking tech announcements and hot AI models based on X (Twitter) trending discussions.
The presentation is rendered using the OpusVideo canvas procedural engine featuring two parallel, distinct visual modes:
1. Standard Split Layout (elements component):
   - Left column: punchy 3-8 word takeaway phrases with highlight pops
   - Right column: matching visual material (tweet screenshots like 'tweet-01-shot', demo videos like 'tweet-01-video-1', or Lucide vector icons like 'sparkles', 'zap', 'flame', 'award', 'trending-up', 'cpu', 'code', 'globe').
2. Fullscreen Flash Component (standalone montage):
   - A dedicated, full-screen rapid montage that cycles through a set of candidate assets (one snapshot every 0.2s) in sync with the spoken narration.
   - Script Rule: The script is strictly stripped of any visual effect, transition, or animation specifications. The script ONLY arranges the narration lines and specifies the asset group name ('flash:candidates' or 'flash'). All pacing, zoom pulses, shutter effects, and rendering are handled autonomously by the player engine.

Tone & Narration Voice Guidelines:
- Tone must be calm, steady, insightful, professional, and natural.
- STRICTLY AVOID sensationalist, theatrical, or over-excited clickbait wording (e.g. DO NOT say "reaches a fever pitch", "exploded", "insane", "unbelievable jaw-dropping", "community goes crazy").
- Do NOT jump back and forth with erratic emotional spikes. The narrative flow should be smooth, cohesive, and thoughtful, like a high-end Bloomberg Technology or Vox Explained mini-documentary.
- Each shot has an elements array of [phraseText, visualRef] and an 1:1 matching spoken narration sentence.`;

  const userPrompt = `【Trending Winner / Topic】
- Winner: ${evalResult.winner.name} (Rank #1)
- Summary: ${evalResult.winner.summary}
- VL Evaluation Reasoning: ${evalResult.reasoning}

【Top 3 Shortlist Overview】
${evalResult.topCandidates.map((c) => `${c.rank}. ${c.name} — ${c.summary}`).join('\n')}

【Available Video & Image Assets】
${assetListText}

【Harvested Community Tweets & Discussions】
${tweetSummaries}

【Requirements】
0. MEDIA ASSET PRIORITY OVER COMPRESSED SCREENSHOTS (MANDATORY):
   - Available video assets: ${videoAssetIds.length > 0 ? videoAssetIds.map((id) => `'${id}'`).join(', ') : 'none'}.
   - Whenever a tweet has a media image or video attachment (e.g. 'tweet-*-image-*' or 'tweet-*-video-*'), you MUST ALWAYS prefer and prioritize that direct high-res media asset over the static compressed tweet screenshot ('*-shot').
   - NEVER use compressed tweet screenshots for product reveals, benchmarks, architecture diagrams, or UI demonstrations when original media images or video clips are available.
   - Tweet screenshots ('*-shot') are ONLY for showing user tweets in Chapter 2 (Community Reactions) when NO media attachment exists.
1. Structure the presentation video into 4 or 5 concise chapters:
   - Chapter 0 (Overview/Hook): The emerging topic and trending landscape on X.
     * IMPORTANT: For the opening hook, use a dedicated standalone shot with the Flash component (visualRef: 'flash:candidates' or 'flash'). The script only needs to provide the narration sentence and the asset group name; the player handles full-screen 0.2s rapid playback.
   - Chapter 1 (The Winner Announcement): Introduce ${evalResult.winner.name}, its core technical capability, and why it ranks at the top. Use original visual media assets ('*-image-*' or '*-video-*') or distinct tech icons ('cpu', 'sparkles', 'zap').
   - Chapter 2 (Community Reactions & Proof): Showcase real discussions and user reaction tweets (prefer '*-image-*' if available; otherwise 'tweet-01-shot', 'tweet-02-shot').
   - Chapter 3 (Live Demos / Visual Showcase): Feature demo video or media image assets from the tweets (e.g. 'tweet-01-video-1', 'tweet-05-image-1', etc.). Prefer every available '*-video-*' asset here, followed by '*-image-*' high-res media. DO NOT use '*-shot' in this chapter.
   - Chapter 4 (Future & Perspective): Strategic industry context and balanced forward takeaway.
2. In each shot:
   - For regular content shots: provide 2 to 3 elements with distinct visual assets or icons.
   - For the opening flash montage shot: provide a single element specifying ["Trending Candidates Montage", "flash:candidates"] with its corresponding spoken narration sentence.
   - Every phraseText must be 3-8 words, clear, concise, and professional.
   - visualRef MUST strictly match either 'flash:candidates', an asset ID from the Available Assets above, or a valid lucide icon ('sparkles', 'zap', 'flame', 'code', 'trending-up', 'award', 'globe', 'cpu').
   - Spoken narration sentences must be delivered in natural, composed, measured English (1 sentence per element).
3. Return PURE JSON adhering to the OpusVideo Storyboard format:
{
  "title": "${evalResult.winner.name}: Analysis & Overview",
  "subtitle": "Deep Dive into the #1 Trending Topic on X",
  "meta": {
    "title": "${evalResult.winner.name}",
    "subtitle": "Trending Overview",
    "bg": "#0B0F19",
    "accent": "#00F0FF"
  },
  "clips": [
    {
      "id": "c0_hook",
      "kicker": "00 · OVERVIEW",
      "title": "Trending On X",
      "subtitle": "Global Technology Overview",
      "bg": "#0B0F19",
      "shots": [
        {
          "id": "s0_1",
          "elements": [
            ["Emerging AI Breakthroughs", "flash"],
            ["GPT-6.3 Sol Leads Focus", "flame"]
          ],
          "narration": [
            "Today's tech conversations across X centered on significant new announcements and emerging models.",
            "Among the contenders, OpenAI's GPT-6.3 Sol emerged at the forefront of developer discussions."
          ]
        }
      ]
    }
  ]
}`;

  return generateExplainerStoryboard({
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    contextTask: 'storyboard',
    fallbackTitle: `${evalResult.winner.name} Showcase`,
    fallbackTopic: evalResult.query,
  });
}
export const generateXHotStoryboard = generateExplainerStoryboardFromXHot;

/**
 * Coordinates asset packaging, storyboard generation, and the shared explainer
 * production tail (TTS → player → render → grid → summary) for the Xhot
 * #1-trending-topic explainer video.
 */
export async function createExplainerVideo(
  options: CreateExplainerVideoOptions
): Promise<ExplainerVideoSummary> {
  const {
    query,
    evalResult,
    harvestResult,
    outDir,
    fps = 30,
    width = 1920,
    height = 1080,
    engine = 'chromium',
    subtitles = false,
    concurrency = 2,
    ttsRate = '+0%',
    onProgress,
  } = options;

  const progress = (stage: string, message: string) => {
    console.log(pc.cyan(`[explainer-video] [${stage}] ${message}`));
    onProgress?.(stage, message);
  };

  const explainerDir = path.join(outDir, 'explainer');
  const assetsOutDir = path.join(explainerDir, 'assets');
  await fs.mkdir(assetsOutDir, { recursive: true });

  // 1. Inventory & copy assets
  progress('assets', 'Collecting and packaging visual assets for explainer canvas...');
  const assets = await buildExplainerAssets(evalResult, harvestResult, assetsOutDir);
  if (assets.length === 0) {
    throw new Error('No assets could be gathered from Xhot harvest for explainer video');
  }

  // 2. Generate Storyboard with LLM
  progress('storyboard', 'Generating documentary storyboard script via LLM...');
  const storyboard = await generateExplainerStoryboardFromXHot(evalResult, harvestResult, assets);

  // 3. Shared explainer production tail (TTS → timeline → player → render → grid → summary)
  return produceExplainerVideo({
    outDir,
    explainerDirname: 'explainer',
    runId: path.basename(outDir),
    topic: query,
    title: evalResult.winner.name,
    narrationLanguage: 'en',
    assets,
    storyboard,
    fps,
    width,
    height,
    engine,
    subtitles,
    concurrency,
    ttsVoice: options.ttsVoice || 'Ryan',
    ttsRate,
    ttsInstruct:
      options.ttsInstruct ||
      process.env.EXPLAINER_TTS_INSTRUCT ||
      'Speak with confidence, clarity, and crisp projection like an authoritative tech news anchor. Energetic, distinct, broadcast-ready delivery; strictly avoid whispering, mumbling, or overly quiet tone.',
    browserPath: options.browserPath,
    resultFilename: 'explainer-result.json',
    storyboardFilename: '10-explainer-storyboard.json',
    gridOptions: () => ({ count: 9 }),
    onProgress: progress,
  });
}

export const createXHotPresentationVideo = createExplainerVideo;
