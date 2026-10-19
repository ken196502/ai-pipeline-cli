import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { chat } from '../llm/client.js';
import { extractJsonObject } from '../llm/json.js';
import { getEnvConfig } from '../env.js';
import {
  TutorialStoryboardSchema,
  TutorialTimelineSchema,
  type TutorialGenerationSummary,
  type TutorialStoryboard,
  type TutorialTimeline,
} from '../tutorial/contracts.js';
import { createTutorialGrid } from '../tutorial/grid.js';
import { listLucideIconNames, resolveLucideIcons } from '../tutorial/icons.js';
import { writeTutorialPlayer } from '../tutorial/player.js';
import { renderTutorialVideo } from '../tutorial/render.js';
import { writeHostRenderScript } from '../tutorial/host-script.js';
import { buildOpusVoiceTrack, type OpusVoiceTrackResult } from '../tutorial/tts.js';
import type { ExplainerProduceOptions } from './contracts.js';

export const EXPLAINER_DEFAULTS = {
  fps: 30,
  width: 1920,
  height: 1080,
  crf: 20,
  preset: 'medium',
  engine: 'chromium' as 'firefox' | 'chromium',
  tutorialDirname: 'tutorial',
  videoFilename: 'tutorial-video.mp4',
  gridFilename: 'tutorial-grid.jpg',
};

/**
 * Shared production tail for every explainer/presentation video pipeline:
 *   TTS voice track → timeline assembly → player bundle → host render script
 *   → headless frame render → (afterRender hook) → contact grid → summary.
 *
 * Domain pipelines (xhot introduction videos, viral tutorial videos, …) supply
 * the two genuinely different parts — assets and a storyboard — and keep their
 * own asset collection / storyboard prompting / QA logic.
 */
export async function produceExplainerVideo(
  options: ExplainerProduceOptions
): Promise<TutorialGenerationSummary> {
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
  const voice = options.ttsVoice || 'local-clone';
  const rate = options.ttsRate ?? '+0%';
  const tutorialDirname = options.tutorialDirname ?? EXPLAINER_DEFAULTS.tutorialDirname;

  const progress = (stage: string, message: string) => {
    if (onProgress) {
      onProgress(stage, message);
    } else {
      console.log(pc.cyan(`[explainer] [${stage}] ${message}`));
    }
  };

  const tutorialDir = path.join(outDir, tutorialDirname);
  const assetsOutDir = path.join(tutorialDir, 'assets');
  await fs.mkdir(tutorialDir, { recursive: true });
  await fs.mkdir(assetsOutDir, { recursive: true });

  if (options.storyboardFilename) {
    await fs.writeFile(
      path.join(outDir, options.storyboardFilename),
      JSON.stringify(storyboard, null, 2) + '\n',
      'utf-8'
    );
  }

  // 1. Voice track synthesis (edge/local TTS with OpusVideo chapter padding)
  progress('tts', `Synthesizing spoken narration (${voice}, rate ${rate})...`);
  const voiceTrack: OpusVoiceTrackResult = await buildOpusVoiceTrack({
    clips: storyboard.clips,
    outAudioDir: assetsOutDir,
    assets,
    voice,
    rate,
    onProgress: (m) => progress('tts', m),
  });
  const totalDurationSec = voiceTrack.totalDurationSec;

  // 2. Timeline assembly
  progress('player', 'Building OpusVideo player timeline...');
  const timeline: TutorialTimeline = TutorialTimelineSchema.parse({
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
      ...(storyboard.meta || {
        title,
        subtitle: topic,
        design: { w: width, h: height },
      }),
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

  const playerFiles = await writeTutorialPlayer({
    timeline,
    icons: resolveLucideIcons(usedIconNames),
    outDir: tutorialDir,
  });
  progress('player', `Player bundle ready: ${path.basename(playerFiles.htmlPath)}`);

  const hostScript = await writeHostRenderScript({ tutorialDir });
  progress('player', `Host render script ready: ${path.basename(hostScript.scriptPath)}`);

  // 4. Headless frame-by-frame render + narration mux
  const videoPath = path.join(tutorialDir, EXPLAINER_DEFAULTS.videoFilename);
  let framesRendered = 0;
  if (!options.previewOnly) {
    progress(
      'render',
      `Rendering ${Math.round(totalDurationSec * fps)} frames at ${fps}fps (${width}x${height}) using ${engine}...`
    );
    const renderResult = await renderTutorialVideo({
      tutorialDir,
      timeline,
      narrationWavPath: voiceTrack.wavPath,
      outVideoPath: videoPath,
      engine,
      browserPath: engine === 'chromium' ? options.browserPath : undefined,
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
  } else {
    progress('preview', 'HTML preview and narration ready; video rendering skipped (previewOnly)');
  }

  // 5. Post-render hook (visual QA etc.) — throws to fail the production
  if (options.afterRender && !options.previewOnly) {
    await options.afterRender({ videoPath, tutorialDir, timeline, voiceTrack });
  }

  // 6. Contact-sheet grid preview
  let gridPath = '';
  if (!options.previewOnly) {
    try {
      progress('grid', 'Building contact-sheet grid of the final video (grid preview for the report)');
      const gridOpts = options.gridOptions?.(voiceTrack);
      gridPath = path.join(tutorialDir, EXPLAINER_DEFAULTS.gridFilename);
      await createTutorialGrid({
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

  const summary: TutorialGenerationSummary = {
    status: 'completed',
    sceneCount: (storyboard.clips || []).reduce((acc, c) => acc + (c.shots || []).length, 0),
    totalDurationSec,
    fps,
    resolution: { width, height },
    voice,
    rate,
    narrationLanguage,
    assetsCount: assets.length,
    storyboardPath: options.storyboardFilename
      ? path.join(outDir, options.storyboardFilename)
      : path.join(tutorialDir, 'storyboard.json'),
    gridPath,
    timelinePath: playerFiles.timelinePath,
    playerPath: playerFiles.htmlPath,
    narrationPath: voiceTrack.mp3Path || voiceTrack.wavPath,
    hostScriptPath: hostScript.scriptPath,
    videoPath: options.previewOnly ? '' : videoPath,
    framesRendered,
    clipOutline,
    sceneOutline,
    ...summaryExtras,
  };

  if (options.resultFilename) {
    await fs.writeFile(
      path.join(outDir, options.resultFilename),
      JSON.stringify(summary, null, 2) + '\n',
      'utf-8'
    );
  }

  await onSummary?.(summary);

  progress(
    'done',
    options.previewOnly
      ? `Explainer preview ready (no render): ${playerFiles.htmlPath}`
      : `Explainer video successfully created: ${videoPath} (${totalDurationSec.toFixed(1)}s)`
  );
  return summary;
}

/**
 * Generic LLM storyboard generation: prompt → JSON extraction → schema
 * validation with deterministic repair (title/meta defaults). Domain pipelines
 * provide the prompts and any extra repair logic.
 */
export async function generateExplainerStoryboard(params: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  contextTask?: string;
  model?: string;
  fallbackTitle: string;
  fallbackTopic: string;
}): Promise<TutorialStoryboard> {
  const env = getEnvConfig();
  const response = await chat(
    {
      context: { stage: 'explainer', task: params.contextTask || 'storyboard' },
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
      temperature: params.temperature ?? 0.3,
    },
    env
  );

  const jsonExtraction = extractJsonObject(response.content);
  if (!jsonExtraction.ok || !jsonExtraction.value) {
    throw new Error(
      `Failed to extract valid JSON storyboard: ${response.content.slice(0, 300)}`
    );
  }
  const parsed = jsonExtraction.value as any;

  try {
    return TutorialStoryboardSchema.parse(parsed);
  } catch (err: any) {
    console.warn(pc.yellow(`[explainer] Storyboard schema warning: ${err.message}. Repairing...`));
    parsed.title = parsed.title || params.fallbackTitle;
    parsed.meta = parsed.meta || {
      title: parsed.title,
      subtitle: params.fallbackTopic,
      design: { w: 1920, h: 1080 },
    };
    return TutorialStoryboardSchema.parse(parsed);
  }
}
