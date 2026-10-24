/**
 * Reference-video quality validation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT: yt-dlp is the ONLY supported way to fetch a YouTube reference
 * video. All browser/"player capture" download paths have been removed on
 * purpose (see the long note at the top of src/research/youtube/ytdlp.ts and
 * plan-fix-sabr-pot-download.md). This module only VALIDATES an already
 * downloaded file; it never fetches media itself.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rejects the failure modes that let poisoned reference media through before:
 *  - truncated downloads (moov duration far below platform metadata),
 *  - pure-black dummy videos,
 *  - frozen/dead-frame media (a truncated download or a stuck capture that
 *    still passes size/bitrate checks).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { AppError, ErrorCodes } from '../errors.js';
import { countDistinctFrameSignatures } from '../media/frames.js';

const execFileAsync = promisify(execFile);

/**
 * Validates that a downloaded reference video is genuine, non-empty, non-black,
 * and has sufficient bitrate/frames to be used as a research baseline.
 * Fails loudly on corrupt, truncated, black or degenerate (frozen) videos.
 */
export async function validateReferenceVideoQuality(
  filePath: string,
  options: {
    expectedDurationSec?: number;
    minBitrateKbps?: number;
    minFileSizeBytes?: number;
  } = {}
): Promise<{ durationSec: number; bitRateKbps: number; sizeBytes: number }> {
  const stat = await fs.stat(filePath);
  const minBytes = options.minFileSizeBytes ?? 1_000_000;
  if (stat.size < minBytes) {
    throw new AppError({
      code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
      message: `Reference video ${path.basename(filePath)} is too small (${(stat.size / 1024).toFixed(1)} KB < ${(minBytes / 1024).toFixed(0)} KB) — corrupted or incomplete download`,
      stage: 'research',
      task: 'download-video',
      retryable: true,
    });
  }

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=codec_name,width,height',
    '-of', 'json',
    filePath,
  ]);
  const probe = JSON.parse(stdout);
  const durationSec = Number(probe.format?.duration || 0);
  const bitRateKbps = Math.round(Number(probe.format?.bit_rate || 0) / 1000);

  const minBitrate = options.minBitrateKbps ?? 25;
  if (bitRateKbps < minBitrate) {
    throw new AppError({
      code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
      message: `Reference video ${path.basename(filePath)} has abnormally low bitrate (${bitRateKbps} kbps < ${minBitrate} kbps threshold) — likely corrupted dummy/black video`,
      stage: 'research',
      task: 'download-video',
      retryable: true,
    });
  }

  // Duration sanity: a truncated download keeps the moov-atom duration but runs
  // out of packets partway through. Compare against the platform metadata.
  const expectedDuration = options.expectedDurationSec ?? 0;
  if (expectedDuration > 30 && durationSec > 0) {
    if (durationSec < expectedDuration * 0.8) {
      throw new AppError({
        code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
        message: `Reference video ${path.basename(filePath)} duration ${durationSec.toFixed(1)}s is far shorter than the expected ${expectedDuration}s — truncated/incomplete download`,
        stage: 'research',
        task: 'download-video',
        retryable: true,
      });
    }
    if (durationSec > expectedDuration * 1.5) {
      throw new AppError({
        code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
        message: `Reference video ${path.basename(filePath)} duration ${durationSec.toFixed(1)}s is far longer than the expected ${expectedDuration}s — wrong/stale media`,
        stage: 'research',
        task: 'download-video',
        retryable: true,
      });
    }
  }

  // Probe points across the video for visual content: black-frame detection AND
  // frozen-frame (dead-frame) detection. A truncated download passes size/bitrate
  // checks while every sampled frame is identical — distinctness is decisive.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-black-'));
  try {
    const probeCount = 10;
    const probePoints = Array.from({ length: probeCount }, (_, i) =>
      Math.max(1, durationSec * ((i + 0.5) / probeCount)),
    );
    let blackFramesCount = 0;
    const sampledPngs: Buffer[] = [];
    for (let i = 0; i < probePoints.length; i++) {
      const probePng = path.join(tempDir, `probe-${i}.png`);
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-ss', String(probePoints[i]),
          '-i', filePath,
          '-vframes', '1',
          probePng,
        ]);
        sampledPngs.push(await fs.readFile(probePng));
        const stats = await sharp(probePng).stats();
        const mean = stats.channels.reduce((sum, c) => sum + c.mean, 0) / stats.channels.length;
        const stdev = stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length;
        if (mean < 5 && stdev < 2) {
          blackFramesCount++;
        }
      } catch {
        blackFramesCount++;
      }
    }

    if (blackFramesCount >= 3) {
      throw new AppError({
        code: ErrorCodes.MEDIA_DOWNLOAD_FAILED,
        message: `Reference video ${path.basename(filePath)} failed visual sanity check: ${blackFramesCount}/${probePoints.length} sampled frames are pure black — refusing to accept black/degenerate reference video`,
        stage: 'research',
        task: 'download-video',
        retryable: true,
      });
    }

    const distinctCount = await countDistinctFrameSignatures(sampledPngs);
    const minDistinct = Math.max(3, Math.ceil(sampledPngs.length * 0.35));
    if (sampledPngs.length >= 6 && distinctCount < minDistinct) {
      throw new AppError({
        code: ErrorCodes.MEDIA_DEGENERATE,
        message: `Reference video ${path.basename(filePath)} is degenerate: only ${distinctCount} distinct frame(s) across ${sampledPngs.length} evenly-spaced probes of a ${durationSec.toFixed(1)}s video — frozen/dead frames from a truncated download or stuck capture. Refusing to accept it.`,
        stage: 'research',
        task: 'download-video',
        retryable: true,
        cause: { durationSec, bitRateKbps, sampled: sampledPngs.length, distinctCount },
      });
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { durationSec, bitRateKbps, sizeBytes: stat.size };
}
