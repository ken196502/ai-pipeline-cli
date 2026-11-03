import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { probeDurationSec } from './tts.js';
import { buildFrameGrid, extractFrameAt, formatTimestamp, type ExtractedFrame } from '../research/media/frames.js';

/**
 * Picks the column count that tiles `count` frames exactly (no blank cells),
 * choosing the factor pair closest to the aspect-ratio-ideal column count.
 */
function exactColumns(count: number, aspectRatio: number): number | undefined {
  const ideal = Math.sqrt(count * Math.max(0.1, aspectRatio));
  let best: number | undefined;
  for (let columns = 1; columns <= Math.min(16, count); columns += 1) {
    if (count % columns !== 0) continue;
    if (count / columns > 16) continue;
    if (best === undefined || Math.abs(columns - ideal) < Math.abs(best - ideal)) best = columns;
  }
  return best;
}

/**
 * Samples frames across the final tutorial video and builds the contact-sheet grid (grid 拼图).
 * When finalShowcaseRange is present, allocates dedicated grid slots (e.g. the entire bottom row)
 * specifically to sample the final AI video showcase, ensuring the final generated video is
 * prominently visible in the report grid preview.
 */
export async function createTutorialGrid(params: {
  videoPath: string;
  outPath: string;
  /** Number of frames on the grid (default 24 — doubled from the original 12 so the
   *  delivered contact sheet shows twice as many steps of the tutorial). */
  count?: number;
  /** Timestamp range of the final video showcase in the rendered tutorial. */
  finalShowcaseRange?: { startSec: number; durationSec: number };
}): Promise<{ gridPath: string; frameCount: number }> {
  const count = params.count ?? 24;
  const durationSec = await probeDurationSec(params.videoPath);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutorial-grid-'));
  try {
    const frames: ExtractedFrame[] = [];
    const timestamps: number[] = [];

    if (params.finalShowcaseRange && params.finalShowcaseRange.durationSec > 0.5) {
      const { startSec, durationSec: showcaseDur } = params.finalShowcaseRange;
      const endSec = Math.min(durationSec, startSec + showcaseDur);
      // Allocate dedicated showcase slots (e.g. 8 frames out of 24)
      const showcaseCount = Math.max(2, Math.min(8, Math.floor(count / 3)));
      const tutorialCount = count - showcaseCount;

      // Sample tutorial workflow/prompt steps up to the showcase start
      const tutSpan = Math.max(0.1, startSec);
      for (let i = 0; i < tutorialCount; i += 1) {
        timestamps.push((tutSpan * (i + 0.5)) / tutorialCount);
      }

      // Sample final AI video showcase uniformly across its duration
      const effectiveShowcaseDur = endSec - startSec;
      for (let i = 0; i < showcaseCount; i += 1) {
        const t = startSec + effectiveShowcaseDur * ((i + 0.5) / showcaseCount);
        timestamps.push(Math.min(durationSec - 0.1, Math.max(startSec + 0.1, t)));
      }
    } else {
      for (let i = 0; i < count; i += 1) {
        timestamps.push((durationSec * (i + 0.5)) / count);
      }
    }

    for (let i = 0; i < timestamps.length; i += 1) {
      const timestampSec = timestamps[i];
      const { jpeg, width, height } = await extractFrameAt(
        params.videoPath,
        timestampSec,
        path.join(workDir, `frame-${String(i).padStart(3, '0')}.jpg`)
      );
      frames.push({
        frameIndex: i,
        timestampSec,
        relativeSec: timestampSec,
        timestamp: formatTimestamp(timestampSec),
        sampleSource: 'uniform',
        jpeg,
        width,
        height,
      });
    }
    const { buffer } = await buildFrameGrid(frames, frames[0].width, frames[0].height, 2400, {
      columns: exactColumns(frames.length, frames[0].width / frames[0].height),
    });
    const finalBuffer = /\.(jpe?g)$/i.test(params.outPath)
      ? await sharp(buffer).jpeg({ quality: 90 }).toBuffer()
      : buffer;
    await fs.mkdir(path.dirname(params.outPath), { recursive: true });
    await fs.writeFile(params.outPath, finalBuffer);
    return { gridPath: params.outPath, frameCount: frames.length };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
