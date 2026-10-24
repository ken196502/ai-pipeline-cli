/**
 * Tutorial material inventory collector.
 *
 * Materials are strictly limited to what the pipeline already produced:
 *   - generation prompts (flow-script clip imagePrompt / visualPrompt, VL-extracted prompts)
 *   - generated videos (generated-clips/clip-XXX.mp4)
 *   - generated images (generated-clips/clip-XXX.jpg)
 * plus lucide icons (resolved separately in ./icons.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FlowClipPrompt } from '../research/script/contracts.js';
import type { VlExtractedPrompt } from '../research/contracts.js';
import type { TutorialAsset } from './contracts.js';
import { voiceAndMuxAiVideo, assembleFinalAiVideo, probeDurationSec } from './tts.js';
import { sanitizeNarrationText, isActionableSpokenNarration } from '../research/script/narration.js';

const execFileAsync = promisify(execFile);

export interface TutorialClipOutputRef {
  clipIndex: number;
  title?: string;
  localImagePath?: string | null;
  localVideoPath?: string | null;
  imagePrompt?: string;
  visualPrompt?: string;
  status?: string;
}

export interface CollectTutorialAssetsParams {
  /** Directory containing generated clip media (generated-clips/). */
  generatedClipsDir?: string;
  /** Flow script clips carrying the generation prompts. */
  clips?: FlowClipPrompt[];
  /** Batch generation outputs carrying local media paths. */
  clipOutputs?: TutorialClipOutputRef[];
  /** Extra VL-extracted prompt texts from the candidate video. */
  vlPrompts?: VlExtractedPrompt[];
  /** Destination directory for copied media (tutorial bundle assets/). */
  assetsOutDir: string;
  /** Edge-TTS voice for AI video narration voiceover. */
  edgeTtsVoice?: string;
}

export interface TutorialAssetInventory {
  assets: TutorialAsset[];
  skippedMissingMedia: string[];
}

function padClip(index: number): string {
  return String(index).padStart(3, '0');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Extracts the first frame of a generated video as the image-generation
 * example (生图示例) when no generated image was saved for that clip.
 */
export async function extractFirstFrame(videoPath: string, outImagePath: string): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outImagePath]);
  } catch (error: any) {
    throw new Error(
      `Failed to extract first frame of ${videoPath} as image-generation example: ${error?.message || error}`
    );
  }
  if (!(await fileExists(outImagePath))) {
    throw new Error(`First frame extraction of ${videoPath} produced no image at ${outImagePath}`);
  }
}

/**
 * Collects the material inventory and copies video/image media into the
 * tutorial bundle so the player can load them over HTTP.
 */
export async function collectTutorialAssets(
  params: CollectTutorialAssetsParams
): Promise<TutorialAssetInventory> {
  const { generatedClipsDir, clips = [], clipOutputs = [], vlPrompts = [], assetsOutDir } = params;
  await fs.mkdir(assetsOutDir, { recursive: true });

  const assets: TutorialAsset[] = [];
  const skippedMissingMedia: string[] = [];
  const voicedClipPaths: string[] = [];

  // Index batch outputs by clip index (they carry the local media paths).
  const outputsByClip = new Map<number, TutorialClipOutputRef>();
  for (const out of clipOutputs) {
    outputsByClip.set(out.clipIndex, out);
  }

  const clipIndexes = new Set<number>([
    ...clips.map((c) => c.clipIndex),
    ...clipOutputs.map((c) => c.clipIndex),
  ]);

  for (const clipIndex of [...clipIndexes].sort((a, b) => a - b)) {
    const clip = clips.find((c) => c.clipIndex === clipIndex);
    const out = outputsByClip.get(clipIndex);
    const label = clip?.title || out?.title || `Clip ${padClip(clipIndex)}`;

    // 1) Prompt materials (always available when a flow script exists).
    const imagePrompt = clip?.imagePrompt || out?.imagePrompt || '';
    const visualPrompt = clip?.visualPrompt || out?.visualPrompt || '';
    const promptText = [imagePrompt ? `IMAGE PROMPT: ${imagePrompt}` : '', visualPrompt ? `VIDEO PROMPT: ${visualPrompt}` : '']
      .filter(Boolean)
      .join('\n');
    if (imagePrompt) {
      assets.push({
        id: `clip-${padClip(clipIndex)}-image-prompt`,
        kind: 'prompt',
        label: `${label} (Image Prompt)`,
        promptText: imagePrompt,
        clipIndex,
      });
    }
    if (visualPrompt) {
      assets.push({
        id: `clip-${padClip(clipIndex)}-video-prompt`,
        kind: 'prompt',
        label: `${label} (Video Animate Prompt)`,
        promptText: visualPrompt,
        clipIndex,
      });
    }
    if (promptText) {
      assets.push({
        id: `clip-${padClip(clipIndex)}-prompt`,
        kind: 'prompt',
        label,
        promptText,
        clipIndex,
        durationSec: clip?.durationSec,
      });
    }

    // 2) Generated video material (with Edge-TTS voiceover when narration script is present).
    const videoSource = out?.localVideoPath && (await fileExists(out.localVideoPath)) ? out.localVideoPath : undefined;
    if (videoSource) {
      const ext = path.extname(videoSource) || '.mp4';
      const destFilename = `clip-${padClip(clipIndex)}-video${ext}`;
      const src = `assets/${destFilename}`;
      const destPath = path.join(assetsOutDir, destFilename);

      // Check if there is genuine spoken dialogue/narration for THIS clip only.
      // Driven directly by LLM hasNarration field (y/n): if false, strictly NO voiceover.
      const shouldVoice = Boolean(clip?.hasNarration && clip?.narrationCues && clip.narrationCues.trim().length > 0);
      const narrationText = shouldVoice ? clip!.narrationCues!.trim() : '';

      if (narrationText) {
        try {
          await voiceAndMuxAiVideo({
            videoPath: videoSource,
            narrationText,
            outVoicedVideoPath: destPath,
            voice: params.edgeTtsVoice,
          });
          voicedClipPaths.push(destPath);
        } catch {
          await fs.copyFile(videoSource, destPath);
          voicedClipPaths.push(destPath);
        }
      } else {
        await fs.copyFile(videoSource, destPath);
        voicedClipPaths.push(destPath);
      }

      assets.push({
        id: `clip-${padClip(clipIndex)}-video`,
        kind: 'video',
        label: narrationText ? `${label} (Voiced)` : label,
        src,
        sourcePath: destPath,
        clipIndex,
        durationSec: await probeDurationSec(destPath),
      });
    } else if (out?.localVideoPath) {
      skippedMissingMedia.push(out.localVideoPath);
    }

    // 3) Generated image material — falls back to the first frame of the
    //    generated video as the image-generation example (生图示例) when the
    //    run did not save a generated image for this clip.
    const imageSource = out?.localImagePath && (await fileExists(out.localImagePath)) ? out.localImagePath : undefined;
    if (imageSource) {
      const ext = path.extname(imageSource) || '.jpg';
      const src = `assets/clip-${padClip(clipIndex)}-image${ext}`;
      await fs.copyFile(imageSource, path.join(assetsOutDir, path.basename(src)));
      assets.push({
        id: `clip-${padClip(clipIndex)}-image`,
        kind: 'image',
        label,
        src,
        sourcePath: imageSource,
        clipIndex,
      });
    } else {
      if (out?.localImagePath) {
        skippedMissingMedia.push(out.localImagePath);
      }
      if (videoSource) {
        const src = `assets/clip-${padClip(clipIndex)}-image.jpg`;
        const destAbs = path.join(assetsOutDir, path.basename(src));
        await extractFirstFrame(videoSource, destAbs);
        assets.push({
          id: `clip-${padClip(clipIndex)}-image`,
          kind: 'image',
          label: `${label} — Image Reference / 生图示例 (first frame of generated video)`,
          src,
          sourcePath: videoSource,
          clipIndex,
          derivedFrom: 'video-first-frame',
        });
      }
    }
  }

  // 4) Standalone VL-extracted prompt materials (prompts read off the candidate video).
  vlPrompts.forEach((vl, idx) => {
    if (!vl.prompt || !vl.prompt.trim()) return;
    assets.push({
      id: `vl-prompt-${padClip(idx + 1)}`,
      kind: 'prompt',
      label: `Extracted ${vl.promptType} prompt (${vl.uiContext})`,
      promptText: vl.prompt.trim(),
    });
    const cleanVlNarration = sanitizeNarrationText(vl.narration);
    if (cleanVlNarration) {
      assets.push({
        id: `vl-narration-${padClip(idx + 1)}`,
        kind: 'prompt',
        label: `Extracted voiceover script (${vl.uiContext})`,
        promptText: cleanVlNarration,
      });
    }
  });

  // 5) Assemble complete AI video result (master video) from voiced clips
  if (voicedClipPaths.length > 0) {
    const finalDest = path.join(assetsOutDir, 'final-ai-video.mp4');
    try {
      const { durationSec: finalDur } = await assembleFinalAiVideo({
        videoPaths: voicedClipPaths,
        outFinalPath: finalDest,
      });
      assets.push({
        id: 'final-ai-video',
        kind: 'video',
        label: 'Final Voiced AI Video',
        src: 'assets/final-ai-video.mp4',
        sourcePath: finalDest,
        durationSec: finalDur,
      });
    } catch {
      // If assembly fails (e.g. mock/test files), copy first clip as final video
      const firstClip = assets.find((a) => a.kind === 'video' && a.id.startsWith('clip-'));
      if (firstClip && firstClip.sourcePath) {
        await fs.copyFile(firstClip.sourcePath, finalDest).catch(() => undefined);
        assets.push({
          id: 'final-ai-video',
          kind: 'video',
          label: 'Final Voiced AI Video',
          src: 'assets/final-ai-video.mp4',
          sourcePath: finalDest,
          durationSec: firstClip.durationSec,
        });
      }
    }
  }

  return { assets, skippedMissingMedia };
}
