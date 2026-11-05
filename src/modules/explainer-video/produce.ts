import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { chat } from '../../libs/llm/client.js';
import { extractJsonObject } from '../../libs/llm/json.js';
import {
  ExplainerTimelineSchema,
  ExplainerStoryboardSchema,
  buildExplainerStoryboardSchema,
  collectStoryboardEffectFields,
  migrateLegacyStoryboard,
  storyboardForDisk,
  type ExplainerVideoSummary,
  type ExplainerStoryboard,
  type ExplainerTimeline,
} from '../../libs/player/contracts.js';
import { createExplainerGrid } from '../../libs/player/grid.js';
import { listLucideIconNames, resolveLucideIcons } from '../../libs/player/icons.js';
import { writeExplainerPlayer } from '../../libs/player/player.js';
import { renderExplainerVideo } from '../../libs/player/render.js';
import { writeHostRenderScript } from '../../libs/player/host-script.js';
import { buildOpusVoiceTrack, type OpusVoiceTrackResult } from '../../libs/player/tts.js';
import { collectPhraseExcerptErrors } from '../../libs/player/phrase.js';
import {
  ExplainerStyleSchema,
  deepMergeStyle,
  loadStyle,
  readStylePatch,
  type ExplainerStyle,
  type ExplainerStylePatch,
} from '../../libs/player/style.js';
import type { ExplainerProduceOptions } from './contracts.js';

export const EXPLAINER_DEFAULTS = {
  fps: 30,
  width: 1920,
  height: 1080,
  crf: 20,
  preset: 'medium',
  engine: 'chromium' as 'firefox' | 'chromium',
  explainerDirname: 'explainer',
  tutorialDirname: 'explainer',
  videoFilename: 'explainer-video.mp4',
  gridFilename: 'explainer-grid.jpg',
  stylePreset: 'preset:ember-dark',
};

/**
 * Shared production tail for every explainer video pipeline:
 *   style resolution → TTS voice track → timeline assembly → player bundle
 *   → host render script → headless frame render → (afterRender hook)
 *   → contact grid → summary.
 *
 * Content (storyboard) and effects (style) are loaded independently and both
 * written into the run directory next to voice.json.
 */
export async function produceExplainerVideo(
  options: ExplainerProduceOptions
): Promise<ExplainerVideoSummary> {
  const {
    outDir,
    runId,
    topic,
    title,
    videoId,
    assets,
    storyboard,
    onSummary,
    summaryExtras,
    onProgress,
  } = options;

  const fps = options.fps ?? EXPLAINER_DEFAULTS.fps;
  const width = options.width ?? EXPLAINER_DEFAULTS.width;
  const height = options.height ?? EXPLAINER_DEFAULTS.height;
  const crf = options.crf ?? EXPLAINER_DEFAULTS.crf;
  const preset = options.preset ?? EXPLAINER_DEFAULTS.preset;
  const engine = options.engine ?? EXPLAINER_DEFAULTS.engine;
  const subtitles = options.subtitles ?? false;
  const narrationLanguage = options.narrationLanguage ?? 'en';
  const voice = options.ttsVoice || 'Ryan';
  const rate = options.ttsRate ?? '+0%';
  const explainerDirname =
    options.explainerDirname ?? options.tutorialDirname ?? EXPLAINER_DEFAULTS.explainerDirname;

  const progress = (stage: string, message: string) => {
    if (onProgress) {
      onProgress(stage, message);
    } else {
      console.log(pc.cyan(`[explainer] [${stage}] ${message}`));
    }
  };

  const explainerDir = path.join(outDir, explainerDirname);
  const assetsOutDir = path.join(explainerDir, 'assets');
  await fs.mkdir(explainerDir, { recursive: true });
  await fs.mkdir(assetsOutDir, { recursive: true });

  // 0. Style resolution: built-in defaults < pipeline preset < run style.json
  //    < explicit CLI/style option. Never silently falls back on a bad file.
  const stylePatches: ExplainerStylePatch[] = [];
  if (options.storyboardStylePatch) stylePatches.push(options.storyboardStylePatch);
  if (options.style) stylePatches.push(await readStylePatch(options.style, outDir));
  if (options.transition) {
    stylePatches.push({
      transitions: {
        clip: {
          mode: 'fixed',
          pool: [options.transition],
        },
      },
    });
  }
  let style: ExplainerStyle = await loadStyle({
    input: options.stylePreset ?? EXPLAINER_DEFAULTS.stylePreset,
    patches: stylePatches,
  });
  if (subtitles) {
    style = ExplainerStyleSchema.parse(
      deepMergeStyle(style, { components: { subtitleBanner: { enabled: true } } })
    );
  }
  await fs.writeFile(path.join(explainerDir, 'style.json'), JSON.stringify(style, null, 2) + '\n', 'utf-8');
  progress('style', `Style ready (${path.join(explainerDirname, 'style.json')})`);

  // Guarantee that all material assets exist inside explainerDir/assets
  for (const asset of assets) {
    if (asset.sourcePath && asset.src) {
      const destPath = path.join(explainerDir, asset.src);
      try {
        const destExists = await fs.stat(destPath).then(() => true).catch(() => false);
        const srcExists = await fs.stat(asset.sourcePath).then(() => true).catch(() => false);
        if (!destExists && srcExists) {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(asset.sourcePath, destPath);
        } else if (!srcExists && !destExists) {
          throw new Error(`source file is missing: ${asset.sourcePath}`);
        }
      } catch (err: any) {
        throw new Error(`failed to package asset "${asset.id}": ${err?.message || err}`);
      }
    }
  }

  // The storyboard written to disk is CONTENT ONLY (no effect fields).
  const storyboardPath = options.storyboardFilename
    ? path.join(outDir, options.storyboardFilename)
    : path.join(explainerDir, 'storyboard.json');
  await fs.writeFile(storyboardPath, JSON.stringify(storyboardForDisk(storyboard), null, 2) + '\n', 'utf-8');

  // 1. Voice track synthesis (timing derives entirely from style.timing)
  progress('tts', `Synthesizing spoken narration (${voice}, rate ${rate})...`);
  const voiceTrack: OpusVoiceTrackResult = await buildOpusVoiceTrack({
    clips: storyboard.clips,
    outAudioDir: assetsOutDir,
    style,
    assets,
    voice,
    rate,
    instruct: options.ttsInstruct,
    concurrency: options.ttsConcurrency,
    onProgress: (m) => progress('tts', m),
  });
  const totalDurationSec = voiceTrack.totalDurationSec;

  // 2. Timeline assembly (content only; voice timing lives in voice.json)
  progress('player', 'Building explainer player timeline...');
  const timeline: ExplainerTimeline = ExplainerTimelineSchema.parse({
    version: '2.0.0',
    runId,
    ...(videoId ? { videoId } : {}),
    topic,
    title,
    narrationLanguage,
    resolution: { width, height },
    fps,
    totalDurationSec,
    audioSrc: 'assets/narration.mp3',
    meta: {
      title: storyboard.meta?.title || title,
      subtitle: storyboard.meta?.subtitle || topic,
      design: { w: width, h: height },
      subtitles,
    },
    assets,
    clips: storyboard.clips,
    voice: voiceTrack.voiceData,
  });

  // 3. Player bundle + host render helper
  const availableIcons = listLucideIconNames();
  const usedIconNames = new Set<string>();
  for (const clip of storyboard.clips || []) {
    for (const shot of clip.shots || []) {
      for (const [, visualRef] of shot.elements || []) {
        const id =
          typeof visualRef === 'string'
            ? visualRef
            : (visualRef as any)?.assetId || (visualRef as any)?.name || '';
        if (availableIcons.includes(id)) {
          usedIconNames.add(id);
        }
      }
    }
  }

  const playerFiles = await writeExplainerPlayer({
    timeline,
    icons: resolveLucideIcons(usedIconNames),
    outDir: explainerDir,
    style,
  });
  progress('player', `Player bundle ready: ${path.basename(playerFiles.htmlPath)}`);

  const hostScript = await writeHostRenderScript({ explainerDir });
  progress('player', `Host render script ready: ${path.basename(hostScript.scriptPath)}`);

  // 4. Headless frame-by-frame render + narration mux
  const videoFilename = options.videoFilename ?? EXPLAINER_DEFAULTS.videoFilename;
  const videoPath = path.join(explainerDir, videoFilename);
  let framesRendered = 0;
  if (!options.previewOnly) {
    progress(
      'render',
      `Rendering ${Math.round(totalDurationSec * fps)} frames at ${fps}fps (${width}x${height}) using ${engine}...`
    );
    const renderResult = await renderExplainerVideo({
      explainerDir,
      timeline,
      narrationWavPath: voiceTrack.wavPath,
      outVideoPath: videoPath,
      engine,
      browserPath: engine === 'chromium' ? options.browserPath : undefined,
      profileDir: options.profileDir,
      concurrency: options.concurrency,
      crf,
      preset,
      onProgress: (renderedFrames, totalFrames) => {
        framesRendered = renderedFrames;
        const pct = totalFrames > 0 ? (renderedFrames / totalFrames) * 100 : 0;
        progress('render', `Render progress: ${renderedFrames}/${totalFrames} frames (${pct.toFixed(0)}%)`);
      },
    });
    framesRendered = renderResult.framesRendered;
    progress('render', `Video ready: ${path.basename(videoPath)}`);

    // Ensure compatibility if caller used custom filename (e.g. tutorial-video.mp4)
    if (videoFilename !== EXPLAINER_DEFAULTS.videoFilename) {
      const aliasPath = path.join(explainerDir, EXPLAINER_DEFAULTS.videoFilename);
      await fs.copyFile(videoPath, aliasPath).catch(() => undefined);
    }
  } else {
    progress('preview', 'HTML preview and narration ready; video rendering skipped (previewOnly)');
  }

  // 5. Post-render hook (visual QA etc.) — throws to fail the production
  if (options.afterRender && !options.previewOnly) {
    await options.afterRender({ videoPath, explainerDir, timeline, voiceTrack });
  }

  // 6. Contact-sheet grid preview
  let gridPath = '';
  if (!options.previewOnly) {
    try {
      progress('grid', 'Building contact-sheet grid of the final video (grid preview for the report)');
      const gridOpts = options.gridOptions?.(voiceTrack);
      const gridFilename = options.gridFilename ?? EXPLAINER_DEFAULTS.gridFilename;
      gridPath = path.join(explainerDir, gridFilename);
      await createExplainerGrid({
        videoPath,
        outPath: gridPath,
        count: gridOpts?.count,
        finalShowcaseRange: gridOpts?.finalShowcaseRange,
      });
      progress('grid', `Grid ready: ${path.basename(gridPath)}`);
    } catch (err: any) {
      progress('grid', `Grid preview failed (non-fatal): ${err?.message || err}`);
      gridPath = '';
    }
  }

  // 7. Outline derivation + summary
  const clipOutline = (storyboard.clips || []).map((clip) => ({
    clipId: clip.id,
    kicker: clip.kicker,
    title: clip.title,
    subtitle: clip.subtitle,
    shots: (clip.shots || []).map((shot) => ({
      shotId: shot.id,
      phrases: (shot.elements || []).map((e) => e[0]),
      visuals: (shot.elements || []).map((e) =>
        typeof e[1] === 'string' ? e[1] : (e[1] as any)?.assetId || (e[1] as any)?.name || ''
      ),
      narration: shot.narration,
    })),
  }));

  const sceneOutline = (storyboard.clips || []).flatMap((clip) =>
    (clip.shots || []).map((shot) => ({
      sceneId: shot.id,
      type: 'content' as const,
      title: `${clip.title} · ${shot.id}`,
      narration: (shot.narration || []).join(' '),
      columns: (shot.elements || []).map(([phrase, visual]) => ({
        role: 'visual',
        widthPercent: 50,
        detail:
          typeof visual === 'string'
            ? visual
            : `${(visual as any)?.kind || 'asset'}: ${(visual as any)?.assetId || (visual as any)?.name || ''}`,
      })),
    }))
  );

  const summary: ExplainerVideoSummary = {
    status: 'completed',
    sceneCount: (storyboard.clips || []).reduce((acc, c) => acc + (c.shots || []).length, 0),
    totalDurationSec,
    fps,
    resolution: { width, height },
    voice,
    rate,
    narrationLanguage,
    assetsCount: assets.length,
    storyboardPath,
    gridPath,
    timelinePath: playerFiles.timelinePath,
    playerPath: playerFiles.htmlPath,
    narrationPath: path.join(assetsOutDir, 'narration.mp3'),
    hostScriptPath: hostScript.scriptPath,
    videoPath: options.previewOnly ? '' : videoPath,
    framesRendered,
    sceneOutline,
    clipOutline,
    ...summaryExtras,
  };

  if (options.resultFilename) {
    const resultPath = path.join(outDir, options.resultFilename);
    await fs.writeFile(resultPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
    progress('summary', `Production summary saved: ${path.basename(resultPath)}`);
  }

  if (onSummary) {
    await onSummary(summary);
  }

  return summary;
}

/**
 * Loads a storyboard JSON from disk, migrating legacy effect fields out into a
 * style patch. Used to re-render artifacts produced before content/effect
 * separation (e.g. `_archive/xhot/*\/10-explainer-storyboard.json`).
 */
export async function loadStoryboardWithMigration(filePath: string): Promise<{
  storyboard: ExplainerStoryboard;
  stylePatch: ExplainerStylePatch;
  migratedFields: string[];
}> {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  const migrated = migrateLegacyStoryboard(raw);
  if (migrated.migratedFields.length > 0) {
    console.warn(
      pc.yellow(
        `[explainer] Migrated ${migrated.migratedFields.length} legacy effect field(s) out of ${path.basename(
          filePath
        )} into style.json: ${migrated.migratedFields.join(', ')}`
      )
    );
  }
  return {
    storyboard: migrated.storyboard,
    stylePatch: migrated.stylePatch as ExplainerStylePatch,
    migratedFields: migrated.migratedFields,
  };
}

/** Raised when element phrases are not verbatim excerpts of their narration. */
class PhraseExcerptError extends Error {}

function assertPhraseExcerpts(storyboard: ExplainerStoryboard): void {
  const errors = collectPhraseExcerptErrors(storyboard);
  if (errors.length > 0) {
    throw new PhraseExcerptError(
      `every element phrase must be copied verbatim from its narration sentence: ${errors.join('; ')}`
    );
  }
}

export interface GenerateExplainerStoryboardParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  contextTask?: string;
  fallbackTitle: string;
  fallbackTopic: string;
  /**
   * Material ids + lucide icon names bound into the schema. When provided the
   * storyboard is validated strictly (unknown visual refs are rejected and fed
   * back to the model) instead of silently degrading to an empty icon (B4).
   */
  assetIds?: ReadonlySet<string>;
  iconNames?: ReadonlySet<string>;
}

/**
 * Shared helper that calls the LLM, extracts the JSON storyboard object,
 * validates it, and repairs syntax or minor schema defects.
 *
 * With `assetIds`/`iconNames` the strict material-bound schema is used and a
 * validation failure is reported back to the model once for repair.
 */
export async function generateExplainerStoryboard(
  params: GenerateExplainerStoryboardParams
): Promise<ExplainerStoryboard> {
  // Models occasionally truncate a long JSON storyboard (or stream ends early).
  // The chat client already retries transport/5xx errors; here we retry only
  // when the returned payload itself is unusable, so a malformed completion
  // does not fail the whole video stage.
  const MAX_ATTEMPTS = 3;
  const strict =
    params.assetIds && params.iconNames
      ? buildExplainerStoryboardSchema({
          assetIds: params.assetIds,
          iconNames: params.iconNames,
        })
      : null;

  let lastError: Error | undefined;
  let repairNote = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userPrompt = repairNote
      ? `${params.userPrompt}\n\n【Previous attempt was rejected】\n${repairNote}\nReturn a corrected pure JSON storyboard.`
      : params.userPrompt;

    const rawResponse = await chat({
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: params.temperature ?? 0.3,
      context: { stage: 'explainer', task: params.contextTask ?? 'storyboard' },
    });

    try {
      const extraction = extractJsonObject(rawResponse.content);
      if (!extraction.ok) {
        throw new Error(`LLM did not return a valid JSON storyboard payload: ${extraction.reason}`);
      }
      const parsed = extraction.value as any;

      const effectFields = collectStoryboardEffectFields(parsed);
      if (effectFields.length > 0) {
        throw new Error(
          `storyboard must not contain effect fields (found: ${effectFields.join(', ')}) — colours, fonts, durations, cameras and transitions are configured in style.json`
        );
      }

      if (strict) {
        const result = strict.safeParse(parsed);
        if (!result.success) {
          throw new Error(result.error.issues.map((i) => i.message).join('; '));
        }
        assertPhraseExcerpts(result.data);
        return result.data;
      }

      try {
        const storyboard = ExplainerStoryboardSchema.parse(parsed);
        assertPhraseExcerpts(storyboard);
        return storyboard;
      } catch (err: any) {
        if (err instanceof PhraseExcerptError) throw err;
        console.warn(pc.yellow(`[explainer] Storyboard validation issue, attempting repair: ${err.message}`));
        // Repair common defects: ensure meta, fallback title, wrap shots
        parsed.meta = parsed.meta || {};
        parsed.meta.title = parsed.meta.title || parsed.title || params.fallbackTitle;
        parsed.meta.design = parsed.meta.design || { w: 1920, h: 1080 };
        parsed.clips = parsed.clips || [];

        for (const clip of parsed.clips) {
          clip.shots = clip.shots || [];
          for (const shot of clip.shots) {
            shot.elements = shot.elements || [['Visual Showcase', 'sparkles']];
            shot.narration = shot.narration || ['Introducing this key milestone.'];
          }
        }

        const repaired = ExplainerStoryboardSchema.parse(parsed);
        assertPhraseExcerpts(repaired);
        return repaired;
      }
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      repairNote = lastError.message;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          pc.yellow(
            `[explainer] Storyboard payload unusable (${lastError.message}); retrying ${attempt + 1}/${MAX_ATTEMPTS}...`
          )
        );
        continue;
      }
    }
  }

  throw lastError ?? new Error('LLM did not return a valid JSON storyboard payload');
}
