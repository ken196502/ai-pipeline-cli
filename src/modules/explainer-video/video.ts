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

    // Tweet Screenshot
    if (item.screenshotPath) {
      try {
        const dest = path.join(assetsOutDir, `${prefix}-shot.png`);
        await fs.copyFile(item.screenshotPath, dest);
        imageAssets.push({
          id: `${prefix}-shot`,
          kind: 'image',
          label: `Tweet by ${item.authorName} (${item.authorHandle})`,
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
The presentation is rendered using the OpusVideo canvas procedural engine with a split layout:
- Left column: punchy 3-8 word takeaway phrases with highlight pops
- Right column: matching visual material:
  * "flash" component: for rapid, cinematic split-second cutaways across trending candidate tweets (e.g. "flash" or "flash:candidates")
  * Tweet screenshots (e.g. 'tweet-01-shot', 'tweet-02-shot')
  * Live demo videos & media previews (e.g. 'tweet-01-video-1', 'tweet-02-image-1')
  * Lucide vector icons ('sparkles', 'zap', 'flame', 'award', 'trending-up', 'cpu', 'code', 'globe')

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
0. VIDEO MATERIAL PRIORITY (MANDATORY):
   - Available video assets: ${videoAssetIds.length > 0 ? videoAssetIds.map((id) => `'${id}'`).join(', ') : 'none'}.
   - Whenever a harvested tweet has a video attachment, you MUST use that video asset as the visual for that tweet instead of its static screenshot ('*-shot').
   - Reserve static tweet screenshots mainly for community-reaction/proof shots where no video exists. Never let a screenshot replace an available demo video in the Live Demos / Visual Showcase chapter.
1. Structure the presentation video into 4 or 5 concise chapters:
   - Chapter 0 (Overview/Hook): The emerging topic and trending landscape on X.
     * IMPORTANT: For the opening hook, DO NOT use a static candidate grid ('xhot-candidate-grid'). Instead, use visualRef: 'flash' (or 'flash:candidates') so the video dynamically cuts through candidate snapshots in a fast-paced montage!
   - Chapter 1 (The Winner Announcement): Introduce ${evalResult.winner.name}, its core technical capability, and why it ranks at the top.
   - Chapter 2 (Community Reactions & Proof): Showcase real discussions and user reaction tweets (use tweet shot assets like 'tweet-01-shot', 'tweet-02-shot').
   - Chapter 3 (Live Demos / Visual Showcase): Feature demo video or media image assets from the tweets (e.g. 'tweet-01-video-1', 'tweet-01-image-1', etc.). Prefer every available '*-video-*' asset here before falling back to screenshots or images.
   - Chapter 4 (Future & Perspective): Strategic industry context and balanced forward takeaway.
2. In each shot:
   - Provide 2 to 3 elements.
   - Every phraseText must be 3-8 words, clear, concise, and professional.
   - visualRef MUST strictly match either 'flash', an asset ID from the Available Assets above, or a valid lucide icon ('sparkles', 'zap', 'flame', 'code', 'trending-up', 'award', 'globe', 'cpu').
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
    ttsVoice: options.ttsVoice || 'Ryan',
    ttsRate,
    ttsInstruct: 'Speak in a calm, steady, composed, professional documentary narrator tone. Avoid theatrical excitement or erratic pitch changes.',
    browserPath: options.browserPath,
    resultFilename: 'explainer-result.json',
    storyboardFilename: '10-explainer-storyboard.json',
    gridOptions: () => ({ count: 9 }),
    onProgress: progress,
  });
}

export const createXHotPresentationVideo = createExplainerVideo;
