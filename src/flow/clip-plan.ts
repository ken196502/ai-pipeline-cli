/**
 * Per-clip generation planning driven by the shot-transition annotation
 * (切分镜 "cut" / 连续 "continuous") — see plan-continuous-last-frame-video.md:
 *
 *   - cut        (切分镜): text-to-image keyframe → image-to-video (Animate)
 *   - continuous (连续):   NO image generation — the LAST frame of the previous
 *                          clip's downloaded video is uploaded as the starting
 *                          frame and the video continues from there.
 *
 * Pure decision logic (no browser / fs access) so it can be unit-tested.
 */
import { normalizeTransition } from '../research/script/shot-transition.js';

export type ClipGenerationMode = 'image-to-video' | 'frame-continue';

export interface ClipPlan {
  mode: ClipGenerationMode;
  transition: 'cut' | 'continuous';
  /** 切分镜 / 连续 */
  transitionLabel: string;
  /** Whether this clip needs a generated keyframe image at all. */
  needsImage: boolean;
  /** Human-readable decision reason (run log + script JSON audit). */
  reason: string;
  /** Source video whose last frame becomes the starting frame (frame-continue only). */
  startFrameSourceVideo?: string;
}

export function planClipGeneration(input: {
  clipIndex: number;
  transition?: string | null;
  /** Downloaded MP4 of the immediately preceding clip (null / missing when unavailable). */
  previousVideoPath?: string | null;
  previousClipIndex?: number | null;
}): ClipPlan {
  const normalized = normalizeTransition(input.transition ?? null);
  const transition: 'cut' | 'continuous' = normalized ?? 'cut';
  const transitionLabel = transition === 'continuous' ? '连续' : '切分镜';
  const previousRef = input.previousClipIndex ? ` (clip ${input.previousClipIndex})` : '';

  if (transition === 'continuous') {
    if (!input.previousVideoPath) {
      throw new Error(
        `Clip ${input.clipIndex} is annotated 连续/continuous but the previous clip${previousRef} ` +
          `has no downloaded video to take the last frame from. ` +
          `Continuation requires the previous clip's MP4 — generating an image instead is forbidden.`
      );
    }
    return {
      mode: 'frame-continue',
      transition,
      transitionLabel,
      needsImage: false,
      reason: `连续/continuous：不生图，取上一片段视频末帧上传作为起始帧续生视频（source: ${input.previousVideoPath}）`,
      startFrameSourceVideo: input.previousVideoPath,
    };
  }

  return {
    mode: 'image-to-video',
    transition,
    transitionLabel,
    needsImage: true,
    reason: normalized
      ? '切分镜/cut：文生图关键帧 → 图生视频（Animate）'
      : `未识别的 transition 标注（${String(input.transition)}）——按切分镜/cut 处理：文生图关键帧 → 图生视频（Animate）`,
  };
}
