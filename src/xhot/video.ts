import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import type {
  TutorialAsset,
  TutorialStoryboard,
  TutorialGenerationSummary,
} from '../tutorial/contracts.js';
import {
  generateExplainerStoryboard,
  produceExplainerVideo,
} from '../explainer/index.js';
import { maskProfanity } from '../utils/index.js';
import type { XHotEvalResult, XHotHarvestResult } from './contracts.js';

export interface CreateXHotVideoOptions {
  query: string;
  evalResult: XHotEvalResult;
  harvestResult: XHotHarvestResult;
  outDir: string;
  fps?: number;
  width?: number;
  height?: number;
  engine?: 'firefox' | 'chromium';
  subtitles?: boolean;
  ttsVoice?: string;
  ttsRate?: string;
  browserPath?: string;
  profileDir?: string;
  onProgress?: (stage: string, message: string) => void;
}

/**
 * Builds OpusVideo materials list from Xhot evaluation and harvested assets.
 */
export async function buildXHotTutorialAssets(
  evalResult: XHotEvalResult,
  harvestResult: XHotHarvestResult,
  assetsOutDir: string
): Promise<TutorialAsset[]> {
  await fs.mkdir(assetsOutDir, { recursive: true });
  const assets: TutorialAsset[] = [];

  // 1. Candidate Grid
  if (evalResult.gridImagePath) {
    try {
      const ext = path.extname(evalResult.gridImagePath) || '.png';
      const dest = path.join(assetsOutDir, `xhot-grid${ext}`);
      await fs.copyFile(evalResult.gridImagePath, dest);
      assets.push({
        id: 'xhot-candidate-grid',
        kind: 'image',
        label: `X Topic Search Grid: ${evalResult.query}`,
        src: `assets/${path.basename(dest)}`,
        sourcePath: dest,
      });
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
        assets.push({
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
        assets.push({
          id: `${prefix}-${media.kind}-${m + 1}`,
          kind: media.kind,
          label: `${media.kind === 'video' ? 'Demo Video' : 'Visual Preview'} from ${item.authorHandle}`,
          src: `assets/${destName}`,
          sourcePath: destPath,
        });
      } catch {}
    }
  }

  return assets;
}

/**
 * Uses LLM to generate an OpusVideo storyboard introducing the #1 trending topic/model.
 * Domain prompts only — JSON extraction / schema validation / repair is shared
 * explainer-module machinery.
 */
export async function generateXHotStoryboard(
  evalResult: XHotEvalResult,
  harvestResult: XHotHarvestResult,
  assets: TutorialAsset[]
): Promise<TutorialStoryboard> {
  const assetListText = assets
    .map((a) => `- "${a.id}" (${a.kind}): ${a.label}`)
    .join('\n');

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
        `[x-video] Masked profanity in ${maskedTweetCount} harvested tweet(s) for content-filter compliance`
      )
    );
  }

  const systemPrompt = `You are an elite technology video director and documentary producer.
You craft punchy, highly engaging documentary and introduction videos about breaking tech announcements and hot AI models based on X (Twitter) trending discussions.
The presentation is rendered using the OpusVideo canvas procedural engine with a split layout:
- Left column: punchy 3-8 word takeaway phrases with highlight pops
- Right column: matching visual material (tweet screenshots, media demos, candidate grids, or lucide icons like 'sparkles', 'zap', 'flame', 'award', 'trending-up', 'cpu')
Each shot has an elements array of [phraseText, visualRef] and an 1:1 matching spoken narration sentence.`;

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
1. Structure the presentation video into 4 or 5 concise chapters:
   - Chapter 0 (Overview/Hook): Breaking news hook & how this topic topped the X leaderboard (visualRef: 'xhot-candidate-grid' or icon 'flame'/'award').
   - Chapter 1 (The Winner Announcement): Dive into ${evalResult.winner.name}, its core breakthrough, and why the tech community went crazy.
   - Chapter 2 (Community Reactions & Proof): Showcase real user reactions and tweet cards (use tweet shot assets like 'tweet-01-shot', 'tweet-02-shot').
   - Chapter 3 (Live Demos / Visual Showcase): Feature any demo video or media image assets from the tweets (e.g. 'tweet-01-video-1', 'tweet-01-image-1', etc.).
   - Chapter 4 (Future & Takeaway): Final perspective and impact summary.
2. In each shot:
   - Provide 2 to 3 elements.
   - Every phraseText must be 3-8 words, punchy and clear.
   - visualRef MUST strictly match either an asset ID from the Available Assets above, or a valid lucide icon ('sparkles', 'zap', 'flame', 'code', 'trending-up', 'award', 'globe', 'cpu').
   - Provide matching spoken narration sentences in English (1 sentence per element).
3. Return PURE JSON adhering to the OpusVideo Storyboard format:
{
  "title": "${evalResult.winner.name}: Breaking X Viral Hotspot",
  "subtitle": "Deep Dive into the #1 Trending Topic on X",
  "meta": {
    "title": "${evalResult.winner.name}",
    "subtitle": "Breaking X Viral Hotspot",
    "bg": "#0B0F19",
    "accent": "#00F0FF"
  },
  "clips": [
    {
      "id": "c0_hook",
      "kicker": "00 · TRENDING",
      "title": "Viral On X",
      "subtitle": "Top Technology Surge",
      "bg": "#0B0F19",
      "shots": [
        {
          "id": "s0_1",
          "elements": [
            ["Global Tech Trends Explode", "xhot-candidate-grid"],
            ["The Number One Breakthrough", "flame"]
          ],
          "narration": [
            "Tech discourse on X reached a fever pitch today with massive attention around new developments.",
            "Rising above all candidates, one major milestone captured everyone's focus."
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

/**
 * Coordinates asset packaging, storyboard generation, and the shared explainer
 * production tail (TTS → player → render → grid → summary) for the Xhot
 * #1-trending-topic introduction video.
 */
export async function createXHotPresentationVideo(
  options: CreateXHotVideoOptions
): Promise<TutorialGenerationSummary> {
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
    console.log(pc.cyan(`[x-video] [${stage}] ${message}`));
    onProgress?.(stage, message);
  };

  const tutorialDir = path.join(outDir, 'tutorial');
  const assetsOutDir = path.join(tutorialDir, 'assets');
  await fs.mkdir(assetsOutDir, { recursive: true });

  // 1. Inventory & copy assets
  progress('assets', 'Collecting and packaging visual assets for tutorial canvas...');
  const assets = await buildXHotTutorialAssets(evalResult, harvestResult, assetsOutDir);
  if (assets.length === 0) {
    throw new Error('No assets could be gathered from Xhot harvest for video presentation');
  }

  // 2. Generate Storyboard with LLM
  progress('storyboard', 'Generating documentary storyboard script via LLM...');
  const storyboard = await generateXHotStoryboard(evalResult, harvestResult, assets);

  // 3. Shared explainer production tail (TTS → timeline → player → render → grid → summary)
  return produceExplainerVideo({
    outDir,
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
    ttsVoice: options.ttsVoice || 'en-US-ChristopherNeural',
    ttsRate,
    browserPath: options.browserPath,
    resultFilename: 'tutorial-result.json',
    storyboardFilename: '10-tutorial-storyboard.json',
    gridOptions: () => ({ count: 9 }),
    onProgress: progress,
  });
}
