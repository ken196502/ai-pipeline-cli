/**
 * AI commentary / tutorial video orchestration (解说视频生成).
 *
 * Pipeline of the tutorial step:
 *   ① collect materials (prompts / generated videos / generated images + lucide icons)
 *   ② LLM storyboard generation (narration + storyboard array, per-scene column layouts)
 *   ③ edge-tts narration synthesis (per scene + full narration track)
 *   ④ tutorial player bundle (interactive preview + deterministic render mode)
 *   ⑤ headless frame-by-frame rendering → ffmpeg encode
 *   ⑥ narration mux → tutorial-video.mp4
 */
import fs from 'node:fs/promises';
import type { RunContext } from '../run/index.js';
import path from 'node:path';
import type { EnvConfig } from '../env.js';
import type { Segment, Transcript, VlExtractedPrompt } from '../research/contracts.js';
import type { FlowClipPrompt } from '../research/script/contracts.js';
import { collectTutorialAssets, type TutorialClipOutputRef } from './assets.js';
import { collectBrowserStepShots } from './step-shots.js';
import { captureGeminiShots } from './ui-shots.js';
import { listLucideIconNames, resolveLucideIcons } from './icons.js';
import { writeExplainerPlayer } from '../libs/player/player.js';
import { loadStyle, readStylePatch, type ExplainerStyle, type ExplainerStylePatch } from '../libs/player/style.js';
import {
  renderExplainerVideo,
  type ExplainerRenderEngine,
} from '../libs/player/render.js';
import { runExplainerVisualQa } from '../libs/player/qa.js';
import { generateTutorialStoryboard } from './storyboard.js';
import { produceExplainerVideo } from '../modules/explainer-video/index.js';
import { writeHostRenderScript } from '../libs/player/host-script.js';
import { lookupChannelSpotlight, type ChannelSpotlightResult } from '../research/social/lookup.js';
import {
  buildNarrationTrack,
  probeDurationSec,
  resolveDefaultVoice,
  synthesizeNarrationSegment,
} from './tts.js';
import {
  TutorialStoryboardSchema,
  TutorialTimelineSchema,
  resolveChatbotPrompts,
  sceneDurationFromWords,
  type TutorialGenerationSummary,
  type TutorialStoryboard,
  type TutorialTimeline,
  type TutorialVoiceLine,
} from './contracts.js';
import { migrateLegacyStoryboard, storyboardForDisk } from '../libs/player/contracts.js';

export interface TutorialLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

export interface CreateTutorialVideoParams {
  run?: RunContext;
  runId: string;
  videoId: string;
  topic: string;
  title: string;
  /** Original video subtitles (transcript cues) used as LLM input. */
  transcript: Pick<Transcript, 'language' | 'cues'>;
  segments?: Segment[];
  /** Flow script clips carrying the generation prompts. */
  clips?: FlowClipPrompt[];
  /** Batch generation outputs carrying local media paths. */
  clipOutputs?: TutorialClipOutputRef[];
  vlPrompts?: VlExtractedPrompt[];
  /** Directory containing generated clip media (generated-clips/). */
  generatedClipsDir?: string;
  /**
   * Directory containing browser operation step screenshots (浏览器操作步骤截图,
   * step-NNN.png + optional steps.json). Defaults to <outDir>/browser-steps when present.
   */
  browserStepsDir?: string;
  /**
   * Directory containing Gemini chat page screenshots (Gemini 聊天页面真实截图,
   * gemini-NNN.png + gemini-shots.json). Defaults to <outDir>/gemini-shots when present.
   */
  geminiShotsDir?: string;
  /**
   * Master prompt captured into the real Gemini page (chatbot UI screenshot
   * material). Defaults to the first flow-script image prompt.
   */
  geminiPrompt?: string;
  /** Run artifact directory: storyboard JSON lands here, bundle in <outDir>/tutorial. */
  outDir: string;
  narrationLanguage: string;
  /** edge-tts voice; defaults to the voice mapped from narrationLanguage. */
  ttsVoice?: string;
  ttsRate?: string;
  fps?: number;
  width?: number;
  height?: number;
  maxScenes?: number;
  /** Whether to show narration subtitles / captions (defaults to false). */
  subtitles?: boolean;
  /** Generate narration and HTML bundle without rendering an MP4. */
  previewOnly?: boolean;
  /** Skip the yt-dlp channel lookup (频道查证) for the opening material. */
  skipChannelLookup?: boolean;
  cookiePath?: string | null;
  proxyUrl?: string | null;
  crf?: number;
  preset?: string;
  /**
   * Style (effects) document: a JSON file path, an inline style/patch object or
   * `preset:<name>`. Content and effects are independent — the storyboard only
   * carries text, this carries theme/timing/components/transitions/post.
   */
  style?: ExplainerStyle | ExplainerStylePatch | string;
  /** Pipeline style preset override (defaults to the pipeline preset). */
  stylePreset?: string;
  /** Force one clip transition shader for the whole video. */
  transition?: string;
  /** Max concurrent TTS line requests (default 2). */
  ttsConcurrency?: number;
  model?: string;
  llmConfig?: EnvConfig;
  profileDir?: string;
  /** Render engine override. Defaults to 'firefox'. */
  engine?: ExplainerRenderEngine;
  browserPath?: string;
  logger?: TutorialLogger;
  onProgress?: (stage: string, message: string) => void;
}

import { createTutorialGrid } from './grid.js';
export { createTutorialGrid };

export const TUTORIAL_STORYBOARD_FILENAME = '10-tutorial-storyboard.json';
export const TUTORIAL_DIRNAME = 'tutorial';
export const TUTORIAL_VIDEO_FILENAME = 'tutorial-video.mp4';

const DEFAULTS = {
  fps: 30,
  width: 1920,
  height: 1080,
  maxScenes: 10,
  crf: 20,
  preset: 'medium',
};

export function padScene(index: number): string {
  return String(index + 1).padStart(3, '0');
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Generates the commentary / tutorial video for one pipeline run end-to-end.
 */
export async function createTutorialVideo(
  params: CreateTutorialVideoParams
): Promise<TutorialGenerationSummary> {
  const fps = params.fps ?? DEFAULTS.fps;
  const width = params.width ?? DEFAULTS.width;
  const height = params.height ?? DEFAULTS.height;
  const maxScenes = params.maxScenes ?? DEFAULTS.maxScenes;
  const voice = params.ttsVoice || 'Ryan';
  const rate = params.ttsRate ?? '+0%';

  const tutorialDir = path.join(params.outDir, TUTORIAL_DIRNAME);
  const assetsOutDir = path.join(tutorialDir, 'assets');
  const audioOutDir = path.join(tutorialDir, 'audio');
  await fs.mkdir(tutorialDir, { recursive: true });
  await fs.mkdir(audioOutDir, { recursive: true });

  const progress = (stage: string, message: string) => {
    params.logger?.info(`[tutorial] ${stage}: ${message}`);
    params.onProgress?.(stage, message);
  };

  // ① Materials: prompts + generated videos + generated images (+ lucide icons).
  progress('assets', 'Collecting tutorial materials (prompts, generated videos and images)');
  const inventory = await collectTutorialAssets({
    generatedClipsDir: params.generatedClipsDir,
    clips: params.clips,
    clipOutputs: params.clipOutputs,
    vlPrompts: params.vlPrompts,
    assetsOutDir,
    edgeTtsVoice: resolveDefaultVoice(params.narrationLanguage),
  });
  if (inventory.assets.length === 0) {
    throw new Error(
      'No tutorial materials available (need generation prompts, generated videos or generated images) — cannot build a tutorial video'
    );
  }
  // ①a Browser operation step screenshots (浏览器操作步骤截图素材): real
  //    screenshots of the workflow operation steps collected from the browser.
  const browserStepsDir = params.browserStepsDir
    ? path.resolve(params.browserStepsDir)
    : path.join(params.outDir, 'browser-steps');
  if (await dirExists(browserStepsDir)) {
    const stepShots = await collectBrowserStepShots({ stepsDir: browserStepsDir, assetsOutDir });
    inventory.assets.push(...stepShots.assets);
    if (stepShots.skippedMissingMedia.length > 0) {
      params.logger?.warn('[tutorial] Missing browser step screenshots', stepShots.skippedMissingMedia);
    }
    progress('assets', `Browser step screenshots: ${stepShots.assets.length} operation step shot(s) from ${browserStepsDir}`);
  } else if (params.browserStepsDir) {
    throw new Error(`Browser step screenshot directory not found: ${browserStepsDir}`);
  } else {
    progress('assets', 'No browser step screenshots found (optional) — expected <outDir>/browser-steps/step-NNN.png');
  }

  // ①a2 Gemini chat page screenshots (Gemini 聊天页面真实截图素材): the chatbot
  //      UI operation is captured from the REAL Gemini page when not already provided.
  const geminiShotsDir = params.geminiShotsDir
    ? path.resolve(params.geminiShotsDir)
    : path.join(params.outDir, 'gemini-shots');
  if (!(await dirExists(geminiShotsDir)) && !params.browserStepsDir && (!params.clips || params.clips.length > 0)) {
    const geminiPrompt =
      params.geminiPrompt ||
      inventory.assets.find((a) => a.kind === 'prompt' && a.promptText)?.promptText ||
      '';
    if (geminiPrompt.trim()) {
      progress('gemini', 'Capturing REAL Gemini chat page screenshots (open / type prompt / send)');
      try {
        await captureGeminiShots({
          prompt: geminiPrompt,
          outDir: geminiShotsDir,
          browserPath: params.browserPath,
          profileDir: params.profileDir,
          onProgress: progress,
        });
      } catch (geminiErr: any) {
        params.logger?.warn(`[tutorial] Failed to capture Gemini page screenshots: ${geminiErr?.message || geminiErr}`);
      }
    }
  }
  if (await dirExists(geminiShotsDir)) {
    const geminiShots = await collectBrowserStepShots({ stepsDir: geminiShotsDir, assetsOutDir });
    inventory.assets.push(...geminiShots.assets);
    if (geminiShots.skippedMissingMedia.length > 0) {
      params.logger?.warn('[tutorial] Missing Gemini page screenshots', geminiShots.skippedMissingMedia);
    }
    progress('assets', `Gemini page screenshots: ${geminiShots.assets.length} chatbot shot(s) from ${geminiShotsDir}`);
  } else if (params.geminiShotsDir) {
    throw new Error(`Gemini page screenshot directory not found: ${geminiShotsDir}`);
  }

  // ①b Channel spotlight (频道查证): resolve the VL-recognized channel on
  //    YouTube/TikTok via yt-dlp (follower counts + avatar) as opening material.
  const channelRef = (params.vlPrompts || [])
    .map((p) => p.channel)
    .find((c) => c && (c.name || c.handle));
  let channelSpotlight: ChannelSpotlightResult = {
    found: false,
    displayName: channelRef?.name || channelRef?.handle || '',
    channels: [],
    missingNumbers: true,
  };
  if (!params.skipChannelLookup && channelRef) {
    progress('channel', `Looking up channel "${channelRef.name || channelRef.handle}" on YouTube/TikTok via yt-dlp`);
    channelSpotlight = await lookupChannelSpotlight({
      channel: channelRef,
      outDir: path.join(tutorialDir, 'channel'),
      cookiePath: params.cookiePath,
      proxyUrl: params.proxyUrl,
    });
    await fs.writeFile(
      path.join(params.outDir, '10-channel-spotlight.json'),
      JSON.stringify(channelSpotlight, null, 2) + '\n',
      'utf-8'
    );
    progress(
      'channel',
      channelSpotlight.found
        ? `Channel verified: ${channelSpotlight.displayName} — ${
            channelSpotlight.followerCount != null ? `${channelSpotlight.followerCount} followers` : 'avatar only'
          } (openings may cite numbers)`
        : 'Channel not verified — opening will use generalized claims (no specific numbers)'
    );

    const avatar = channelSpotlight.channels.find((c) => c.avatarPath);
    if (avatar?.avatarPath) {
      const ext = path.extname(avatar.avatarPath) || '.jpg';
      const src = `assets/channel-avatar${ext}`;
      await fs.copyFile(avatar.avatarPath, path.join(assetsOutDir, path.basename(src)));
      inventory.assets.push({
        id: 'channel-avatar',
        kind: 'image',
        label: `Channel avatar — ${channelSpotlight.displayName}`.trim(),
        src,
        sourcePath: avatar.avatarPath,
      });
      progress('channel', `Avatar saved as opening material (asset channel-avatar)`);
    }
  }

  const finalAsset = inventory.assets.find(asset => asset.id === 'final-ai-video');
  if (finalAsset?.sourcePath) {
    const finalPath = path.join(params.outDir, 'final-ai-video.mp4');
    await fs.copyFile(finalAsset.sourcePath, finalPath);
    progress('composition', `Final generated clips with Edge TTS: ${finalPath}`);
  }

  const iconNames = listLucideIconNames();
  if (inventory.skippedMissingMedia.length > 0) {
    params.logger?.warn('[tutorial] Missing generated media files on disk', inventory.skippedMissingMedia);
  }
  progress(
    'assets',
    `Materials ready: ${inventory.assets.length} assets (${inventory.assets.filter((a) => a.kind === 'video').length} videos, ${
      inventory.assets.filter((a) => a.kind === 'image').length
    } images, ${inventory.assets.filter((a) => a.kind === 'prompt').length} prompts), ${iconNames.length} lucide icons`
  );

  // ② LLM storyboard: title pages + narration + storyboard array with per-scene
  //    column layouts. Operation scenes use the REAL browser/Gemini page
  //    screenshots in the material inventory — no HTML UI mocks.
  progress('storyboard', 'Generating narration + storyboard array with LLM');
  const storyboardResult = await generateTutorialStoryboard({
    runId: params.runId,
    videoId: params.videoId,
    topic: params.topic,
    title: params.title,
    narrationLanguage: params.narrationLanguage,
    maxScenes,
    transcript: params.transcript,
    segments: params.segments,
    assets: inventory.assets,
    clips: params.clips,
    iconNames,
    vlPrompts: params.vlPrompts,
    channelSpotlight,
    model: params.model,
    llmConfig: params.llmConfig,
  });
  const storyboard = resolveChatbotPrompts(storyboardResult.storyboard, inventory.assets);
  const storyboardPath = path.join(params.outDir, TUTORIAL_STORYBOARD_FILENAME);
  // Content-only on disk: effect fields (colours, fonts, durations, cameras) live
  // in style.json and must never leak back into the storyboard artifact.
  const storyboardArtifact = { ...storyboardForDisk(storyboard), model: storyboardResult.model };
  if (params.run) {
    // Same object as the typed storyboard minus effect fields (kept out of the
    // artifact on purpose) — the cast only bypasses the deprecated meta fields.
    await params.run.write('storyboard', storyboardArtifact as unknown as typeof storyboard);
  } else {
    await fs.writeFile(storyboardPath, JSON.stringify(storyboardArtifact, null, 2) + '\n', 'utf-8');
  }
  progress(
    'storyboard',
    `Storyboard ready: ${(storyboard.clips || []).length} clips, ${(storyboard.clips || []).reduce((acc, c) => acc + c.shots.length, 0)} shots (model ${storyboardResult.model})`
  );

  const assets = inventory.assets;

  // ③–⑦ Shared explainer production tail: TTS voice track → timeline →
  //    player bundle → host render script → frame render → visual QA →
  //    contact grid → summary. Domain-specific parts (materials, storyboard,
  //    QA policy, persistence) stay in this pipeline and plug in via hooks.
  const engine = params.engine ?? 'chromium';
  let lastRenderLogged = 0;
  const summary = await produceExplainerVideo({
    outDir: params.outDir,
    explainerDirname: TUTORIAL_DIRNAME,
    tutorialDirname: TUTORIAL_DIRNAME,
    videoFilename: TUTORIAL_VIDEO_FILENAME,
    gridFilename: 'tutorial-grid.jpg',
    runId: params.runId,
    topic: params.topic,
    title: params.title,
    videoId: params.videoId,
    narrationLanguage: params.narrationLanguage,
    assets,
    storyboard,
    fps,
    width,
    height,
    engine,
    subtitles: params.subtitles ?? false,
    ttsVoice: voice,
    ttsRate: rate,
    browserPath: engine === 'chromium' ? params.browserPath : undefined,
    profileDir: params.profileDir,
    crf: params.crf ?? DEFAULTS.crf,
    preset: params.preset ?? DEFAULTS.preset,
    style: params.style,
    stylePreset: params.stylePreset,
    transition: params.transition,
    ttsConcurrency: params.ttsConcurrency,
    previewOnly: params.previewOnly,
    summaryExtras: { model: storyboardResult.model, storyboardPath },
    afterRender: async ({ explainerDir }) => {
      // Self-check: programmatic visual QA (canvas pixel variance + JS boot)
      progress('qa', 'Running automated visual QA (canvas frame checks)');
      const targetDir = explainerDir || tutorialDir;
      const qa = await runExplainerVisualQa({
        tutorialDir: targetDir,
        engine,
        browserPath: engine === 'chromium' ? params.browserPath : undefined,
        samplesPerScene: 4,
      });
      if (qa.issues.length > 0) {
        throw new Error(
          `Tutorial visual QA found ${qa.issues.length} issue(s) — fix before shipping:\n` +
            qa.issues.map((issue) => `- [${issue.kind}] ${issue.detail} (t=${issue.tSec.toFixed(2)}s)`).join('\n')
        );
      }
      progress('qa', `Visual QA passed (${qa.checksRun} frames checked, screenshots in ${path.relative(params.outDir, path.join(targetDir, 'qa'))}/)`);
    },
    gridOptions: (voiceTrack) => {
      // Detect final showcase range so the contact-sheet grid preview reliably
      // captures the final AI video showcase.
      let finalShowcaseRange: { startSec: number; durationSec: number } | undefined;
      for (const c of voiceTrack.voiceData.clips) {
        for (const s of c.shots) {
          if (
            s.lines.some(
              (l) => l.icon === 'component:final-showcase' || l.icon === 'final-ai-video'
            )
          ) {
            finalShowcaseRange = {
              startSec: s.start,
              durationSec: s.dur,
            };
            break;
          }
        }
        if (finalShowcaseRange) break;
      }
      return { finalShowcaseRange };
    },
    onSummary: async (explainerSummary) => {
      if (params.run) await params.run.write('tutorial', explainerSummary);
    },
    onProgress: (stage, message) => {
      // Throttle per-frame render logs to every ~10% (previous behavior)
      if (stage === 'render') {
        const m = message.match(/Render progress: (\d+)\/(\d+)/);
        if (m) {
          const rendered = Number(m[1]);
          const total = Number(m[2]) || 1;
          if (rendered !== total && rendered - lastRenderLogged < Math.max(1, Math.floor(total / 10))) {
            return;
          }
          lastRenderLogged = rendered;
        }
      }
      progress(stage, message);
    },
  });
  return summary;
}


/**
 * Rebuilds the player bundle from an existing explainer bundle and re-renders
 * the video — no LLM, TTS or asset collection involved. Used after player
 * styling changes (`--rebuild`).
 *
 * The bundle layout is: explainer.json (content + voice), style.json (effects),
 * explainer-player.*. Bundles produced before the content/effect split carry
 * their effect fields inside explainer.json; those are migrated into a fresh
 * style.json on the first rebuild (and written to disk).
 */
/**
 * Resolves the style document for a rebuild and writes it next to the player.
 *
 * Source priority: `style.json` in the bundle (current layout) → legacy effect
 * fields migrated out of `explainer.json` (old layout) → explicit `--style` /
 * `--style-preset` patch. A bundle with neither source and no `--style` fails
 * loudly instead of rendering with guessed styling.
 */
export async function resolveRebuildStyle(params: {
  tutorialDir: string;
  rawTimeline: unknown;
  style?: ExplainerStyle | ExplainerStylePatch | string;
  stylePreset?: string;
  transition?: string;
  onProgress?: (stage: string, message: string) => void;
}): Promise<ExplainerStyle> {
  const styleFile = path.join(params.tutorialDir, 'style.json');
  const styleExists = await fs.stat(styleFile).then(() => true).catch(() => false);
  const stylePatches: ExplainerStylePatch[] = [];

  if (!styleExists) {
    const migrated = migrateLegacyStoryboard(params.rawTimeline);
    if (migrated.migratedFields.length === 0) {
      throw new Error(
        `cannot rebuild: neither ${styleFile} nor legacy effect fields in explainer.json were found — pass --style <path> or re-run the pipeline`
      );
    }
    stylePatches.push(migrated.stylePatch as ExplainerStylePatch);
    params.onProgress?.(
      'rebuild',
      `Migrated ${migrated.migratedFields.length} legacy effect field(s) into style.json (${migrated.migratedFields.join(', ')})`
    );
  }
  if (params.style) stylePatches.push(await readStylePatch(params.style, params.tutorialDir));
  if (params.transition) {
    stylePatches.push({ transitions: { clip: { mode: 'fixed', pool: [params.transition] } } });
  }

  const style = await loadStyle({
    input: params.stylePreset ?? (styleExists ? styleFile : undefined),
    patches: stylePatches,
  });
  // Persist the resolved style so the next rebuild is a pure re-render.
  await fs.writeFile(styleFile, JSON.stringify(style, null, 2) + '\n', 'utf-8');
  return style;
}

export async function rebuildTutorialBundle(params: {
  tutorialDir: string;
  engine?: ExplainerRenderEngine;
  crf?: number;
  preset?: string;
  browserPath?: string;
  profileDir?: string;
  style?: ExplainerStyle | ExplainerStylePatch | string;
  stylePreset?: string;
  transition?: string;
  onProgress?: (stage: string, message: string) => void;
}): Promise<{ videoPath: string; timeline: TutorialTimeline; framesRendered: number; gridPath: string; hostScriptPath: string }> {
  const timelinePath = path.join(params.tutorialDir, 'explainer.json');
  const rawTimeline = JSON.parse(await fs.readFile(timelinePath, 'utf-8').catch((err: any) => {
    throw new Error(
      `cannot rebuild: ${timelinePath} is missing (${err?.message || err}). Rebuild only supports bundles produced by the current pipeline (explainer.json + style.json).`
    );
  }));
  const timeline = TutorialTimelineSchema.parse(rawTimeline);
  const style = await resolveRebuildStyle({
    tutorialDir: params.tutorialDir,
    rawTimeline,
    style: params.style,
    stylePreset: params.stylePreset,
    transition: params.transition,
    onProgress: params.onProgress,
  });

  // Prompt materials are stored symbolically in tutorial.json (id-only
  // references). Merge the canonical full texts from prompts.json back in so
  // the rebuilt player can inline them; legacy bundles that still embed
  // promptText directly keep working because those assets already carry it.
  try {
    const promptTexts = JSON.parse(await fs.readFile(path.join(params.tutorialDir, 'prompts.json'), 'utf-8')) as Record<string, string>;
    for (const asset of timeline.assets || []) {
      if (asset.kind === 'prompt' && !asset.promptText && promptTexts[asset.id]) {
        asset.promptText = promptTexts[asset.id];
      }
    }
  } catch {
    // prompts.json is optional; prompt assets without any text source render
    // a loud ⚠ placeholder and fail visual QA instead of being silently blank.
  }

  const usedIconNames = new Set<string>();
  const allIconNames = new Set(listLucideIconNames());
  if (timeline.clips && timeline.clips.length > 0) {
    for (const clip of timeline.clips) {
      for (const shot of clip.shots) {
        for (const [, visualRef] of shot.elements) {
          const id = typeof visualRef === 'string' ? visualRef : visualRef.assetId || visualRef.name || '';
          if (id && allIconNames.has(id)) usedIconNames.add(id);
        }
      }
    }
  }

  const playerFiles = await writeExplainerPlayer({
    timeline,
    icons: resolveLucideIcons(usedIconNames),
    outDir: params.tutorialDir,
    style,
  });
  params.onProgress?.('rebuild', `Player bundle rebuilt from explainer.json (${path.basename(playerFiles.htmlPath)})`);

  const hostScript = await writeHostRenderScript({ explainerDir: params.tutorialDir });
  params.onProgress?.('rebuild', `Host render script refreshed (${path.basename(hostScript.scriptPath)})`);

  const narrationWavPath = path.join(params.tutorialDir, 'assets', 'narration.wav');
  const videoPath = path.join(params.tutorialDir, TUTORIAL_VIDEO_FILENAME);
  const engine = params.engine ?? 'chromium';
  const renderResult = await renderExplainerVideo({
    tutorialDir: params.tutorialDir,
    timeline,
    narrationWavPath,
    outVideoPath: videoPath,
    engine,
    browserPath: engine === 'chromium' ? params.browserPath : undefined,
    profileDir: params.profileDir,
    crf: params.crf ?? DEFAULTS.crf,
    preset: params.preset ?? DEFAULTS.preset,
    onProgress: (rendered, total) => {
      if (rendered % Math.max(1, Math.floor(total / 10)) === 0 || rendered === total) {
        params.onProgress?.('rebuild', `Rendered ${rendered}/${total} frames`);
      }
    },
  });

  params.onProgress?.('qa', 'Running automated visual QA (screenshots + layout checks)');
  const qa = await runExplainerVisualQa({
    tutorialDir: params.tutorialDir,
    engine,
    browserPath: engine === 'chromium' ? params.browserPath : undefined,
    samplesPerScene: 4,
  });
  if (qa.issues.length > 0) {
    throw new Error(
      `Tutorial visual QA found ${qa.issues.length} issue(s) — fix before shipping:\n` +
        qa.issues.map((issue) => `- [${issue.kind}] ${issue.detail} (t=${issue.tSec.toFixed(2)}s)`).join('\n')
    );
  }
  params.onProgress?.('qa', `Visual QA passed (${qa.checksRun} frames checked, screenshots in ${path.join(params.tutorialDir, 'qa')}/)`);

  let finalShowcaseRange: { startSec: number; durationSec: number } | undefined;
  if (timeline.voice && timeline.voice.clips) {
    for (const c of timeline.voice.clips) {
      for (const s of c.shots) {
        if (s.lines.some((l: TutorialVoiceLine) => l.icon === 'final-ai-video')) {
          finalShowcaseRange = { startSec: s.start, durationSec: s.dur };
          break;
        }
      }
      if (finalShowcaseRange) break;
    }
  }

  params.onProgress?.('grid', 'Building contact-sheet grid of the final video');
  const grid = await createTutorialGrid({
    videoPath,
    outPath: path.join(params.tutorialDir, 'tutorial-grid.jpg'),
    finalShowcaseRange,
  });
  params.onProgress?.('grid', `Grid ready: ${grid.gridPath} (${grid.frameCount} frames)`);

  return { videoPath, timeline, framesRendered: renderResult.framesRendered, gridPath: grid.gridPath, hostScriptPath: hostScript.scriptPath };
}
