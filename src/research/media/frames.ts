/**
 * Video Media Probe, Scene Detection, Frame Extraction, and Contact-Sheet Grids.
 *
 * Implements:
 * 1. ffprobe-based video media inspection (dimensions, duration, fps, sha256)
 * 2. ffmpeg scene change detection per transcript segment
 * 3. Priority timestamp sampling (prompt keyword hints + scene cuts + dynamic gap-filling)
 * 4. Perceptual near-duplicate frame removal using downsampled raw RGB signatures
 * 5. High-quality frame extraction and labeled contact-sheet grid montage generation with Sharp & SVG badges
 * 6. Progressive Vision JPEG compression for multimodal LLM ingestion
 * 7. Frame evidence generation and projection to legacy FramesResult format
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp, { type OverlayOptions, type SharpenOptions } from 'sharp';
import type {
  Frame,
  FrameEvidence,
  FrameGrid,
  FramesResult,
  FrameStrip,
  FrameTableEntry,
  SampleSource,
  Segment,
  SegmentFrameEvidence,
  SelectedVideoMedia,
  Transcript,
  VideoCandidate,
} from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';

const execFileAsync = promisify(execFile);

export function resolveFfmpegBin(): string {
  if (process.env.FFMPEG_BIN && existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, '.pi/agent/bin/ffmpeg'),
    path.join(home, '.local/bin/ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

export function resolveFfprobeBin(): string {
  if (process.env.FFPROBE_BIN && existsSync(process.env.FFPROBE_BIN)) return process.env.FFPROBE_BIN;
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, '.pi/agent/bin/ffprobe'),
    path.join(home, '.local/bin/ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.env.FFPROBE_BIN || 'ffprobe';
}

export const DEFAULT_MIN_FRAMES = 4;
export const DEFAULT_MAX_FRAMES = 6;
export const DEFAULT_SCENE_THRESHOLD = 0.3;
export const DEFAULT_MIN_GAP_SEC = 1.0;
export const DEFAULT_GRID_COLUMNS = 3;
export const DEFAULT_MAX_GRID_SIZE = 2400;
export const LEGACY_FRAMES_PER_SEGMENT = 6;

export interface FrameEvidenceResult {
  evidence: FrameEvidence;
  frames: FramesResult;
}

export interface CollectFrameEvidenceOptions {
  video: VideoCandidate;
  segments: readonly Segment[];
  transcript?: Transcript;
  videoPath?: string | null;
  outputDir: string;
  minFrames?: number;
  maxFrames?: number;
  sceneThreshold?: number;
  now?: () => Date;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface VideoInfo {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

export interface SampleTimestamp {
  timestampSeconds: number;
  source: 'scene' | 'uniform' | 'hint';
}

export interface GridLayout {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
}

export interface BuiltFrameGrid {
  buffer: Buffer;
  layout: GridLayout;
}

export interface ExtractedFrame {
  frameIndex: number;
  timestampSec: number;
  relativeSec: number;
  timestamp: string;
  sampleSource: SampleSource;
  jpeg: Buffer;
  width: number;
  height: number;
  timestampSeconds?: number;
  source?: SampleSource;
}

export type SpawnedCommand = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<ProcessResult>;

/**
 * Spawn a subprocess without a shell so URLs and paths cannot inject shell syntax.
 * Clamps in-memory stdout/stderr accumulation to prevent Node maxBuffer heap crashes.
 */
export const runCommand: SpawnedCommand = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, Math.max(1_000, timeoutMs));

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (error) =>
      finish(() => reject(new Error(`Unable to start ${command}: ${error.message}`))),
    );
    child.on('close', (code, signal) =>
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else
          reject(
            new Error(
              `${command} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}: ${stderr.trim() || 'no stderr'}`,
            ),
          );
      }),
    );
  });

/**
 * Escapes XML special characters for safe inclusion in SVG markup.
 */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Vision-ready image format: PNG → sharpen → 256-colour palette.
 * Posterising removes codec/rescale noise and keeps
 * on-image text edges hard, so VL models can OCR prompt text reliably.
 */
export async function toVisionPng(
  input: Buffer,
  options: { sharpen?: boolean | SharpenOptions; colours?: number } = {},
): Promise<Buffer> {
  let img = sharp(input);
  if (options.sharpen !== false) {
    img = img.sharpen(
      typeof options.sharpen === 'object' ? options.sharpen : { sigma: 0.8, m1: 1.0, m2: 1.8 },
    );
  }
  return img
    .png({ palette: true, colours: options.colours ?? 256, dither: 0 })
    .toBuffer();
}

/**
 * Computes SHA-256 hash of a file on disk.
 */
export async function calculateFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Formats a duration in seconds to standard MM:SS.ss or HH:MM:SS.ss timestamp.
 */
export function formatTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = Math.floor((totalMs % 1000) / 10);
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);

  const secStr = String(sec).padStart(2, '0');
  const msStr = String(ms).padStart(2, '0');
  const minStr = String(min).padStart(2, '0');

  if (hours > 0) {
    const hoursStr = String(hours).padStart(2, '0');
    return `${hoursStr}:${minStr}:${secStr}.${msStr}`;
  }
  return `${minStr}:${secStr}.${msStr}`;
}

/**
 * Parses frame rate from ffprobe fraction format (e.g. "30000/1001" or "25/1").
 */
function parseFps(fpsStr?: string): number {
  if (!fpsStr) return 30.0;
  if (fpsStr.includes('/')) {
    const [numStr, denStr] = fpsStr.split('/');
    const num = parseFloat(numStr ?? '0');
    const den = parseFloat(denStr ?? '1');
    if (den > 0 && num > 0) return Math.round((num / den) * 100) / 100;
  }
  const parsed = parseFloat(fpsStr);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30.0;
}

/**
 * Probes video media file using ffprobe and computes SHA-256 hash.
 */
export async function probeVideoMedia(
  videoPath: string,
  videoId: string,
  options?: {
    source?: 'yt-dlp' | 'cache' | 'fixture';
    now?: () => Date;
  },
): Promise<SelectedVideoMedia> {
  const { source = 'yt-dlp', now = () => new Date() } = options ?? {};

  try {
    const stats = await fs.stat(videoPath);
    const sha256 = await calculateFileSha256(videoPath);
    const ffprobeBin = resolveFfprobeBin();

    const { stdout } = await execFileAsync(ffprobeBin, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ]);

    const probe = JSON.parse(stdout);
    const videoStream = probe.streams?.find((s: any) => s.codec_type === 'video');

    const width = parseInt(videoStream?.width, 10) || 1280;
    const height = parseInt(videoStream?.height, 10) || 720;
    const fps = parseFps(videoStream?.r_frame_rate || videoStream?.avg_frame_rate);
    const durationSec = parseFloat(probe.format?.duration) || videoStream?.duration || 1.0;
    const container = (probe.format?.format_name || 'mp4').split(',')[0] ?? 'mp4';

    return {
      videoId,
      path: videoPath,
      bytes: stats.size,
      sha256,
      container,
      durationSec: Math.round(durationSec * 100) / 100,
      width,
      height,
      fps,
      source,
      downloadedAt: now().toISOString(),
    };
  } catch (error: any) {
    throw new AppError({
      code: ErrorCodes.MEDIA_PROBE_FAILED,
      message: `Failed to probe video file "${videoPath}": ${error.message}`,
      stage: 'research',
      task: 'probe-video',
      retryable: false,
      cause: error,
    });
  }
}

/**
 * Standard ffprobe media inspector matching reference video-media.ts.
 * Returns core geometry, duration, and frame rate for downstream processing.
 */
export async function probeVideo(
  videoPath: string,
  timeoutMs = 60_000,
  ffprobeBin = process.env.FFPROBE_BIN || resolveFfprobeBin(),
  command: SpawnedCommand = runCommand,
): Promise<VideoInfo> {
  const result = await command(
    ffprobeBin || resolveFfprobeBin(),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'format=duration:stream=width,height,r_frame_rate',
      '-of',
      'json',
      videoPath,
    ],
    timeoutMs,
  );
  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON for the video');
  }
  const stream = parsed?.streams?.[0] || {};
  const frameRate = String(stream.r_frame_rate || '')
    .split('/')
    .map(Number);
  const fps =
    frameRate.length === 2 &&
    Number.isFinite(frameRate[0]) &&
    Number.isFinite(frameRate[1]) &&
    frameRate[1]! > 0
      ? frameRate[0]! / frameRate[1]!
      : 30;
  const durationSeconds = Number(parsed?.format?.duration) || 0;
  const width = Math.max(1, Math.round(Number(stream.width) || 1280));
  const height = Math.max(1, Math.round(Number(stream.height) || 720));
  if (durationSeconds <= 0) throw new Error('The video has no positive duration');
  return { durationSeconds, width, height, fps };
}

/**
 * Calculates adaptive contact-sheet grid dimensions and cell coordinates.
 * Preserves source aspect ratio while enforcing maxGridSize bounding.
 */
export function calculateGridLayout(
  videoWidth: number,
  videoHeight: number,
  frameCount: number,
  maxGridSize = DEFAULT_MAX_GRID_SIZE,
): GridLayout {
  const count = Math.max(1, Math.min(256, Math.round(frameCount)));
  const ratio = Math.max(0.1, (videoWidth || 16) / Math.max(1, videoHeight || 9));

  let columns = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * ratio))));
  let rows = Math.max(1, Math.ceil(count / columns));
  while (columns * rows < count) columns += 1;
  columns = Math.min(count, Math.min(16, columns));
  rows = Math.min(16, Math.max(rows, Math.ceil(count / columns)));

  let cellWidth = ratio >= 1 ? 640 : Math.max(360, Math.round(480 * ratio));
  let cellHeight = Math.max(200, Math.round(cellWidth / ratio));
  if (ratio < 1) {
    cellHeight = 560;
    cellWidth = Math.max(240, Math.round(cellHeight * ratio));
  }

  const gap = 2;
  let width = columns * cellWidth + (columns + 1) * gap;
  let height = rows * cellHeight + (rows + 1) * gap;
  const largest = Math.max(width, height);
  if (largest > maxGridSize) {
    const scale = Math.max(0.1, maxGridSize / largest);
    cellWidth = Math.max(32, Math.floor(cellWidth * scale));
    cellHeight = Math.max(18, Math.floor(cellHeight * scale));
    width = columns * cellWidth + (columns + 1) * gap;
    height = rows * cellHeight + (rows + 1) * gap;
  }
  if (width > maxGridSize) {
    cellWidth = Math.max(16, Math.floor((maxGridSize - (columns + 1) * gap) / columns));
    width = columns * cellWidth + (columns + 1) * gap;
  }
  if (height > maxGridSize) {
    cellHeight = Math.max(12, Math.floor((maxGridSize - (rows + 1) * gap) / rows));
    height = rows * cellHeight + (rows + 1) * gap;
  }

  return { columns, rows, cellWidth, cellHeight, width, height };
}

/**
 * Sharpens and re-encodes an extracted frame as a high-quality JPEG on disk.
 */
async function finalizeExtractedFrame(
  outputPath: string,
  rawJpeg: Buffer,
  options: { sharpen?: boolean | SharpenOptions },
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  // First-pass sharpening at screenshot stage: enhances text outlines & fine details immediately.
  let sharpInstance = sharp(rawJpeg);
  if (options.sharpen !== false) {
    const sharpenOpts =
      typeof options.sharpen === 'object'
        ? options.sharpen
        : { sigma: 1.0, m1: 1.0, m2: 2.0 };
    sharpInstance = sharpInstance.sharpen(sharpenOpts);
  }
  const jpeg = await sharpInstance
    .jpeg({
      quality: 92,
      mozjpeg: true,
    })
    .toBuffer();
  await fs.writeFile(outputPath, jpeg);

  const metadata = await sharp(jpeg).metadata();
  return {
    jpeg,
    width: metadata.width || 0,
    height: metadata.height || 0,
  };
}

/**
 * Extracts one frame at `timestampSec` as a sharpened JPEG.
 */
export async function extractFrameAt(
  videoPath: string,
  timestampSec: number,
  outputPath: string,
  options: {
    quality?: number;
    timeoutMs?: number;
    ffmpegBin?: string;
    command?: SpawnedCommand;
    /** Whether to sharpen the extracted frame for crisp text & edge definition (default: true). */
    sharpen?: boolean | SharpenOptions;
  } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const command = options.command || runCommand;
  const ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || resolveFfmpegBin();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const timestamp = Math.max(0, timestampSec);

  await command(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      timestamp.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      String(Math.max(1, Math.min(31, Math.round(options.quality ?? 2)))),
      '-y',
      outputPath,
    ],
    options.timeoutMs ?? 60_000,
  );

  if (!existsSync(outputPath)) {
    throw new Error(`ffmpeg did not create frame at timestamp ${timestampSec}s: ${outputPath}`);
  }

  const rawJpeg = await fs.readFile(outputPath);
  return await finalizeExtractedFrame(outputPath, rawJpeg, options);
}

/**
 * Extracts the LAST frame of a video.
 *
 * Used by the 连续 (continuous, non-cut) shot flow: once a clip's video is downloaded,
 * its final frame becomes the uploaded starting frame of the next clip so the same
 * shot continues seamlessly (see plan-continuous-last-frame-video.md).
 */
export async function extractLastFrame(
  videoPath: string,
  outputPath: string,
  options: {
    quality?: number;
    timeoutMs?: number;
    ffmpegBin?: string;
    command?: SpawnedCommand;
    sharpen?: boolean | SharpenOptions;
  } = {},
): Promise<{ jpeg: Buffer; width: number; height: number; timestampSec: number }> {
  const command = options.command || runCommand;
  const ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || resolveFfmpegBin();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const info = await probeVideo(videoPath, options.timeoutMs ?? 60_000);

  // Seek to the END of the file (`-sseof`): only the final decoded frames are read.
  // Seeking to `duration - ε` is NOT reliable — once the timestamp passes the
  // presentation time of the last frame, ffmpeg writes no output at all.
  await command(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-sseof',
      '-0.2',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      String(Math.max(1, Math.min(31, Math.round(options.quality ?? 2)))),
      '-y',
      outputPath,
    ],
    options.timeoutMs ?? 60_000,
  );

  if (!existsSync(outputPath)) {
    throw new Error(`ffmpeg did not extract the last frame of ${videoPath} to ${outputPath}`);
  }

  const rawJpeg = await fs.readFile(outputPath);
  const finalized = await finalizeExtractedFrame(outputPath, rawJpeg, options);
  return { ...finalized, timestampSec: info.durationSeconds };
}
export async function frameSignature(jpeg: Buffer): Promise<Buffer> {
  return sharp(jpeg).resize(64, 36, { fit: 'fill' }).removeAlpha().raw().toBuffer();
}

/**
 * Returns true when two raw 64x36 RGB signatures depict (near-)identical images.
 * Same metric as removeNearDuplicateFrames: tiny average delta + almost no pixel
 * exceeding the per-channel change threshold.
 */
export function frameSignaturesSimilar(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let delta = 0;
  let changed = 0;
  for (let j = 0; j < a.length; j += 3) {
    const r = Math.abs(a[j]! - b[j]!);
    const g = Math.abs(a[j + 1]! - b[j + 1]!);
    const bch = Math.abs(a[j + 2]! - b[j + 2]!);
    delta += r + g + bch;
    if (Math.max(r, g, bch) >= 20) changed += 1;
  }
  const pixels = a.length / 3;
  return delta / (a.length * 255) < 0.012 && changed / pixels < 0.008;
}

/**
 * Counts how many visually DISTINCT frames exist in a set of JPEG buffers.
 * Greedy clustering against kept representatives — O(n²) on tiny 64x36 signatures.
 * A fully frozen/degenerate video yields 1 (all frames cluster together).
 */
export async function countDistinctFrameSignatures(jpegs: readonly Buffer[]): Promise<number> {
  if (jpegs.length === 0) return 0;
  const representatives: Buffer[] = [];
  for (const jpeg of jpegs) {
    const signature = await frameSignature(jpeg);
    if (!representatives.some((rep) => frameSignaturesSimilar(rep, signature))) {
      representatives.push(signature);
    }
  }
  return representatives.length;
}

export interface DegeneracyCheckResult {
  sampleCount: number;
  distinctCount: number;
  minDistinctRequired: number;
}

/**
 * Samples frames evenly across a video and asserts the content actually CHANGES
 * over time. Catches the two silent corruption modes that pass every other
 * check (size / bitrate / black-frame): truncated downloads that freeze on the
 * last decoded frame, and synthesized fallback videos stitched from a stuck
 * canvas. Throws AppError(MEDIA_DEGENERATE) when too few distinct frames exist.
 */
export async function assertVideoFramesNotDegenerate(options: {
  videoPath: string;
  sampleCount?: number;
  minDistinct?: number;
  context?: string;
  timeoutMs?: number;
}): Promise<DegeneracyCheckResult> {
  const sampleCount = Math.max(4, Math.round(options.sampleCount ?? 12));
  const probeTimeoutMs = options.timeoutMs ?? 60_000;
  const label = options.context ?? path.basename(options.videoPath);

  const info = await probeVideo(options.videoPath, probeTimeoutMs);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'degeneracy-probe-'));
  try {
    const jpegs: Buffer[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const fraction = (i + 0.5) / sampleCount;
      const tSec = Math.min(Math.max(0, info.durationSeconds * fraction), Math.max(0, info.durationSeconds - 0.1));
      const framePath = path.join(tempDir, `probe-${String(i).padStart(3, '0')}.jpg`);
      try {
        const extracted = await extractFrameAt(options.videoPath, tSec, framePath, {
          quality: 4,
          timeoutMs: probeTimeoutMs,
        });
        jpegs.push(extracted.jpeg);
      } catch {
        // Unreadable sample point: skip rather than abort — distinctness of the
        // remaining samples still decides degeneracy.
      }
    }

    const distinctCount = await countDistinctFrameSignatures(jpegs);
    const minDistinctRequired = Math.max(3, Math.ceil(jpegs.length * 0.3));
    if (jpegs.length >= 4 && distinctCount < (options.minDistinct ?? minDistinctRequired)) {
      throw new AppError({
        code: ErrorCodes.MEDIA_DEGENERATE,
        message: `Reference video "${label}" is degenerate: only ${distinctCount} distinct frame(s) among ${jpegs.length} evenly-spaced samples across ${info.durationSeconds.toFixed(1)}s — the video is frozen/dead-frame (truncated download or stuck capture). Refusing to use it.`,
        stage: 'research',
        task: 'validate-media',
        retryable: true,
        cause: { videoPath: options.videoPath, durationSec: info.durationSeconds, sampleCount: jpegs.length, distinctCount },
      });
    }

    return { sampleCount: jpegs.length, distinctCount, minDistinctRequired };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Removes adjacent near-identical frames using perceptual RGB signatures.
 * Pure dedup: an identical frame is dropped no matter how far apart the
 * timestamps are. Padding grids with duplicate frames only burns VL tokens
 * and masks degenerate (frozen/dead-frame) media — the video-level
 * degeneracy guard in assertVideoFramesNotDegenerate owns that diagnosis.
 */
export async function removeNearDuplicateFrames(
  frames: ExtractedFrame[],
): Promise<ExtractedFrame[]> {
  if (frames.length <= 1) return frames;

  const kept: ExtractedFrame[] = [frames[0]!];
  let previous = await frameSignature(frames[0]!.jpeg);

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i]!;
    const signature = await frameSignature(frame.jpeg);

    if (!frameSignaturesSimilar(previous, signature)) {
      kept.push(frame);
      previous = signature;
    }
  }

  return kept;
}

/**
 * Scans subtitle cues within a segment for AI prompt and instruction keywords,
 * returning priority timestamps for targeted keyframe sampling.
 */
export function promptPriorityTimestamps(
  segment: Segment,
  transcript?: Transcript,
): number[] {
  if (!transcript || !transcript.cues || transcript.cues.length === 0) {
    return [];
  }

  const promptPattern = /\bprompt(?:s|ing)?\b|提示词|提示詞|copy|paste|script section|text[- ]to[- ](?:image|video)|animation|generate|generation/i;
  const values: number[] = [];

  const add = (val: number) => {
    if (Number.isFinite(val) && val >= segment.startSec && val <= segment.endSec) {
      values.push(val);
      if (val - 0.5 >= segment.startSec) values.push(val - 0.5);
      if (val + 0.5 <= segment.endSec) values.push(val + 0.5);
    }
  };

  for (const cue of transcript.cues) {
    const [startSec, endSec, text] = cue;
    // Check if cue overlaps with segment
    if (endSec < segment.startSec || startSec > segment.endSec) continue;
    if (promptPattern.test(text)) {
      add(startSec);
      add((startSec + endSec) / 2);
      add(endSec);
    }
  }

  return [...new Set(values.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
}

/**
 * Detects scene change timestamps within a segment using ffmpeg select filter.
 */
export async function detectSceneChanges(
  videoPath: string,
  startSec: number,
  endSec: number,
  threshold = DEFAULT_SCENE_THRESHOLD,
): Promise<number[]> {
  const duration = Math.max(0.1, endSec - startSec);
  const ffmpegBin = resolveFfmpegBin();
  try {
    const { stderr } = await execFileAsync(ffmpegBin, [
      '-ss',
      startSec.toFixed(2),
      '-t',
      duration.toFixed(2),
      '-i',
      videoPath,
      '-vf',
      `select='gt(scene,${threshold.toFixed(2)})',showinfo`,
      '-f',
      'null',
      '-',
    ]);

    const timestamps: number[] = [];
    const regex = /pts_time:([0-9.]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(stderr)) !== null) {
      const relSec = parseFloat(match[1] ?? '0');
      if (Number.isFinite(relSec)) {
        timestamps.push(Math.round((startSec + relSec) * 100) / 100);
      }
    }

    return [...new Set(timestamps)].sort((a, b) => a - b);
  } catch {
    // If ffmpeg fails during scene detection, return empty to trigger uniform fallback
    return [];
  }
}

/**
 * Detects scene cut timestamps across an entire video or clip using ffmpeg's scene filter.
 * Matches reference lib/video-media.ts detectSceneTimestamps API.
 */
export async function detectSceneTimestamps(
  videoPath: string,
  threshold = DEFAULT_SCENE_THRESHOLD,
  timeoutMs = 180_000,
  ffmpegBin = process.env.FFMPEG_BIN || resolveFfmpegBin(),
  command: SpawnedCommand = runCommand,
): Promise<number[]> {
  const safeThreshold = Math.max(0.01, Math.min(0.99, Number(threshold) || 0.22));
  try {
    const result = await command(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        videoPath,
        '-an',
        '-vf',
        `select='gt(scene,${safeThreshold.toFixed(2)})',showinfo`,
        '-f',
        'null',
        '-',
      ],
      timeoutMs,
    );
    const timestamps: number[] = [];
    const pattern = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
    for (const stream of [result.stderr, result.stdout]) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(stream)) !== null) {
        const timestamp = Number(match[1]);
        if (Number.isFinite(timestamp)) timestamps.push(timestamp);
      }
    }
    return [...new Set(timestamps.map((value) => Math.round(value * 1000) / 1000))].sort(
      (a, b) => a - b,
    );
  } catch {
    return [];
  }
}

/**
 * Combines cut boundaries with uniform coverage while retaining a bounded number
 * of samples. Scene boundaries are preferred because a prompt often appears
 * immediately after a UI transition. Matches reference lib/video-media.ts.
 */
export function buildSampleTimestamps(
  durationSeconds: number,
  sceneTimestamps: number[],
  maxFrames: number,
  minFrames: number,
  priorityTimestamps: number[] = [],
): SampleTimestamp[] {
  const duration = Math.max(0.01, Number(durationSeconds) || 0.01);
  const max = Math.max(1, Math.min(256, Math.round(maxFrames)));
  const target = Math.min(max, Math.max(1, Math.round(minFrames)));
  const sanitize = (values: number[]) =>
    [...new Set(values)]
      .map((value) => Math.max(0, Math.min(duration - 0.02, Number(value) || 0)))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
  const priority = sanitize(priorityTimestamps);
  const scene = sanitize([0, ...sceneTimestamps]);
  const selected = new Map<number, 'scene' | 'uniform' | 'hint'>();
  for (const timestamp of priority) selected.set(Math.round(timestamp * 1000) / 1000, 'hint');
  for (const timestamp of scene) {
    const rounded = Math.round(timestamp * 1000) / 1000;
    if (!selected.has(rounded)) selected.set(rounded, 'scene');
  }

  if (selected.size > max) {
    const preferred = [...selected.entries()].filter(([, source]) => source === 'hint');
    const ordinary = [...selected.entries()].filter(([, source]) => source !== 'hint');
    const takeEvenly = <T>(values: T[], count: number): T[] => {
      if (values.length <= count) return values;
      return Array.from(
        { length: count },
        (_, index) => values[Math.min(values.length - 1, Math.floor((index * values.length) / count))]!,
      );
    };
    const keptPreferred = takeEvenly(preferred, Math.min(max, preferred.length));
    const keptOrdinary = takeEvenly(ordinary, Math.max(0, max - keptPreferred.length));
    selected.clear();
    for (const [timestamp, source] of [...keptPreferred, ...keptOrdinary]) selected.set(timestamp, source);
  }

  // Fill the largest uncovered gaps first
  while (selected.size < target) {
    const points = [...selected.keys()].sort((a, b) => a - b);
    let bestGap = -1;
    let bestAt = duration / 2;
    for (let i = 0; i < points.length; i += 1) {
      const start = points[i]!;
      const end = points[i + 1] ?? duration;
      if (end - start > bestGap) {
        bestGap = end - start;
        bestAt = start + (end - start) / 2;
      }
    }
    const rounded = Math.round(bestAt * 1000) / 1000;
    if (selected.has(rounded) || bestGap <= 0.02) break;
    selected.set(rounded, 'uniform');
  }

  const all = [...selected.keys()].sort((a, b) => a - b);
  return all.map((timestampSeconds) => ({
    timestampSeconds,
    source: selected.get(timestampSeconds) || 'uniform',
  }));
}

/**
 * Samples keyframe timestamps for a segment, integrating priority hints,
 * scene detection transitions, and iterative largest-gap filling.
 */
export function sampleSegmentTimestamps(options: {
  startSec: number;
  endSec: number;
  sceneTimestamps: number[];
  minFrames?: number;
  maxFrames?: number;
  minGapSec?: number;
  priorityTimestamps?: number[];
}): {
  timestamps: Array<{ timestampSec: number; sampleSource: SampleSource }>;
  sceneFallback: boolean;
  sampledCount: number;
  deduplicatedCount: number;
} {
  const {
    startSec,
    endSec,
    sceneTimestamps,
    minFrames = DEFAULT_MIN_FRAMES,
    maxFrames = DEFAULT_MAX_FRAMES,
    minGapSec = DEFAULT_MIN_GAP_SEC,
    priorityTimestamps = [],
  } = options;

  const duration = Math.max(1.0, endSec - startSec);
  const max = Math.max(1, Math.min(64, Math.round(maxFrames)));
  const target = Math.min(max, Math.max(1, Math.round(minFrames)));

  // Sanitize and bound timestamps
  const sanitize = (values: number[]) =>
    [...new Set(values)]
      .filter((v) => Number.isFinite(v) && v >= startSec && v <= endSec)
      .sort((a, b) => a - b);

  const priority = sanitize(priorityTimestamps);
  const scene = sanitize(sceneTimestamps);

  const selected = new Map<number, SampleSource>();

  // 1. Register priority timestamps from subtitle cues (hints)
  for (const t of priority) {
    selected.set(Math.round(t * 100) / 100, 'hint');
  }

  // 2. Register scene transitions (filtering closer than minGapSec)
  let lastScene = -Infinity;
  let rawSceneCount = scene.length;
  let dedupedSceneCount = 0;

  for (const t of scene) {
    if (t - lastScene >= minGapSec) {
      const rounded = Math.round(t * 100) / 100;
      if (!selected.has(rounded)) {
        selected.set(rounded, 'scene');
      }
      lastScene = t;
    } else {
      dedupedSceneCount++;
    }
  }

  // 3. If selected exceeds maxFrames, prune evenly favoring hints
  if (selected.size > max) {
    const hints = [...selected.entries()].filter(([, src]) => src === 'hint');
    const scenes = [...selected.entries()].filter(([, src]) => src === 'scene');

    const takeEvenly = <T>(items: T[], count: number): T[] => {
      if (items.length <= count) return items;
      return Array.from({ length: count }, (_, idx) =>
        items[Math.min(items.length - 1, Math.floor((idx * items.length) / count))]!
      );
    };

    const keptHints = takeEvenly(hints, Math.min(max, hints.length));
    const keptScenes = takeEvenly(scenes, Math.max(0, max - keptHints.length));

    selected.clear();
    for (const [t, src] of [...keptHints, ...keptScenes]) {
      selected.set(t, src);
    }
  }

  const hadEnoughInitialKeyframes = selected.size >= target;

  // 4. Fill largest uncovered gaps (up to max) with REAL frames for contact-sheet
  // coverage. This samples actual video content — it never fabricates frames.
  while (selected.size < max) {
    const points = [startSec, ...selected.keys(), endSec].sort((a, b) => a - b);
    let bestGap = -1;
    let bestAt = startSec + duration / 2;

    for (let i = 0; i < points.length - 1; i++) {
      const pStart = points[i]!;
      const pEnd = points[i + 1]!;
      const gap = pEnd - pStart;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = pStart + gap / 2;
      }
    }

    if (bestGap <= minGapSec) break;
    const rounded = Math.round(bestAt * 100) / 100;
    if (selected.has(rounded)) break;
    selected.set(rounded, 'uniform');
  }

  // NOTE: the old "ensure at least minFrames by forced uniform subdivision"
  // fallback was deliberately REMOVED: when scene detection finds nothing and
  // every gap is below minGapSec, padding the grid with arbitrary duplicate
  // frames fabricates evidence and masks degenerate media. Fewer honest frames
  // beat a full grid of identical ones.

  const sortedTimestamps = [...selected.keys()]
    .sort((a, b) => a - b)
    .slice(0, max)
    .map((timestampSec) => ({
      timestampSec,
      sampleSource: selected.get(timestampSec) || 'uniform',
    }));

  return {
    timestamps: sortedTimestamps,
    sceneFallback: !hadEnoughInitialKeyframes,
    sampledCount: rawSceneCount,
    deduplicatedCount: dedupedSceneCount,
  };
}

/**
 * Composites overlay tiles onto a dark canvas in batches of 40 to avoid memory / Sharp limits.
 * Matches reference lib/video-media.ts renderCompositeGrid.
 */
export async function renderCompositeGrid(
  width: number,
  height: number,
  composites: OverlayOptions[],
  batchSize = 40,
): Promise<Buffer> {
  const create = () =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 7, g: 10, b: 18 },
      },
    });
  let canvas = await create()
    .composite(composites.slice(0, batchSize))
    .png()
    .toBuffer();

  for (let offset = batchSize; offset < composites.length; offset += batchSize) {
    canvas = await sharp(canvas)
      .composite(composites.slice(offset, offset + batchSize))
      .png()
      .toBuffer();
  }
  return canvas;
}

/**
 * Builds a contact-sheet grid montage using Sharp with high-contrast SVG yellow badges.
 * Assembles already-sharpened frame tiles and applies a second-pass sharpening on the
 * composite grid for razor-sharp text readability with compact file size (mozjpeg).
 */
export async function buildFrameGrid(
  frames: ExtractedFrame[],
  videoWidth: number,
  videoHeight: number,
  maxGridSize = DEFAULT_MAX_GRID_SIZE,
  options: {
    /** Whether to apply second-pass sharpening to the assembled grid (default: true). */
    sharpen?: boolean | SharpenOptions;
    quality?: number;
  } = {},
): Promise<BuiltFrameGrid> {
  if (!frames.length) {
    throw new Error('Cannot build a contact-sheet collage without extracted frames');
  }

  const layout = calculateGridLayout(videoWidth, videoHeight, frames.length, maxGridSize);
  const gap = 2;
  const overlays: OverlayOptions[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const row = Math.floor(i / layout.columns);
    const column = i % layout.columns;
    const left = column * layout.cellWidth + (column + 1) * gap;
    const top = row * layout.cellHeight + (row + 1) * gap;

    // Resize tile to fit cell using lanczos3 for maximum edge retention
    const tile = await sharp(frame.jpeg)
      .resize(layout.cellWidth, layout.cellHeight, {
        fit: 'contain',
        kernel: sharp.kernel.lanczos3,
        background: { r: 10, g: 12, b: 20 },
      })
      .png()
      .toBuffer();

    // Render high-contrast yellow badge with frame index and timestamp (70% smaller)
    const label = `#${frame.frameIndex}  ${frame.timestamp}`;
    const fontSize = Math.max(6, Math.round(layout.cellWidth / 24 * 0.3));
    const labelWidth = Math.min(
      layout.cellWidth - 4,
      Math.max(60, Math.round(label.length * fontSize * 0.58 + 14)),
    );
    const labelHeight = fontSize + 10;

    const svg = Buffer.from(`<svg width="${layout.cellWidth}" height="${layout.cellHeight}">
      <rect x="2" y="2" width="${labelWidth}" height="${labelHeight}" rx="3" fill="#000000" opacity="0.8"/>
      <text x="7" y="${fontSize + 5}" fill="#ffe600" font-family="monospace" font-size="${fontSize}" font-weight="700">${xmlEscape(label)}</text>
    </svg>`);

    // Per-tile vision pipeline: PNG → sharpen → 256-colour palette, then stitch.
    const labeled = await toVisionPng(
      await sharp(tile)
        .composite([{ input: svg }])
        .png()
        .toBuffer(),
    );

    overlays.push({ input: labeled, left, top });
  }

  let buffer = await renderCompositeGrid(layout.width, layout.height, overlays);

  // Second-pass sharpening on the full grid: recovers downscaled text & line clarity.
  if (options.sharpen !== false) {
    const gridSharpenOpts =
      typeof options.sharpen === 'object'
        ? options.sharpen
        : { sigma: 0.8, m1: 1.0, m2: 1.8 };
    buffer = await toVisionPng(buffer, { sharpen: gridSharpenOpts });
  }

  return { buffer, layout };
}

/**
 * Extracts frames at specified sample timestamps, saves them to a temp directory,
 * and reports progress. Matches reference lib/video-media.ts extractSampledFrames.
 */
export async function extractSampledFrames(
  videoPath: string,
  samples: Array<{
    timestampSeconds?: number;
    timestampSec?: number;
    source?: SampleSource;
    sampleSource?: SampleSource;
  }>,
  tempDir: string,
  options: {
    quality?: number;
    timeoutMs?: number;
    ffmpegBin?: string;
    command?: SpawnedCommand;
  } = {},
  onProgress?: (index: number, total: number, timestampSeconds: number) => void,
): Promise<ExtractedFrame[]> {
  await fs.mkdir(tempDir, { recursive: true });
  const frames: ExtractedFrame[] = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    const tSec = typeof sample.timestampSeconds === 'number'
      ? sample.timestampSeconds
      : sample.timestampSec ?? 0;
    const src = (sample.source || sample.sampleSource || 'uniform') as SampleSource;
    const outputPath = path.join(tempDir, `sample-${String(index).padStart(4, '0')}.jpg`);
    const extracted = await extractFrameAt(videoPath, tSec, outputPath, options);
    frames.push({
      frameIndex: index,
      timestampSec: tSec,
      relativeSec: tSec,
      timestamp: formatTimestamp(tSec),
      sampleSource: src,
      jpeg: extracted.jpeg,
      width: extracted.width,
      height: extracted.height,
      timestampSeconds: tSec,
      source: src,
    });
    onProgress?.(index + 1, samples.length, tSec);
  }
  return frames;
}

/**
 * Asserts that a candidate path is safely contained within a root directory.
 * Matches reference lib/video-media.ts fileInside.
 */
export function fileInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Extracts frames at specified timestamps, filters perceptual near-duplicates,
 * and stitches them into a labeled Sharp contact-sheet grid montage.
 */
export async function extractFramesAndBuildGrid(options: {
  videoPath: string;
  segmentId: string;
  timestamps: Array<{ timestampSec: number; sampleSource: SampleSource }>;
  outputDir: string;
  segmentStartSec: number;
  gridColumns?: number;
  maxGridSize?: number;
}): Promise<FrameGrid> {
  const {
    videoPath,
    segmentId,
    timestamps,
    outputDir,
    segmentStartSec,
    maxGridSize = DEFAULT_MAX_GRID_SIZE,
  } = options;

  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `frames-${segmentId}-`));

  try {
    // 1. Extract individual candidate frames
    const candidateFrames: ExtractedFrame[] = [];
    for (let index = 0; index < timestamps.length; index++) {
      const entry = timestamps[index]!;
      const frameFile = path.join(tempDir, `candidate_${String(index).padStart(3, '0')}.jpg`);
      const extracted = await extractFrameAt(videoPath, entry.timestampSec, frameFile, {
        quality: 2,
      });

      const relSec = Math.round(Math.max(0, entry.timestampSec - segmentStartSec) * 100) / 100;
      candidateFrames.push({
        frameIndex: index,
        timestampSec: entry.timestampSec,
        relativeSec: relSec,
        timestamp: formatTimestamp(entry.timestampSec),
        sampleSource: entry.sampleSource,
        jpeg: extracted.jpeg,
        width: extracted.width,
        height: extracted.height,
        timestampSeconds: entry.timestampSec,
        source: entry.sampleSource,
      });
    }

    // 2. Perceptually deduplicate candidate frames (pure dedup — identical
    // frames are dropped regardless of timestamp distance)
    let filteredFrames = await removeNearDuplicateFrames(candidateFrames);
    if (filteredFrames.length === 0 && candidateFrames.length > 0) {
      filteredFrames = [candidateFrames[0]!];
    }

    // Re-index frames sequentially for clean badge display
    const finalFrames: ExtractedFrame[] = filteredFrames.map((frame, idx) => ({
      ...frame,
      frameIndex: idx,
    }));

    const frameEntries: FrameTableEntry[] = finalFrames.map((f) => ({
      frameIndex: f.frameIndex,
      timestampSec: f.timestampSec,
      relativeSec: f.relativeSec,
      timestamp: f.timestamp,
      sampleSource: f.sampleSource,
    }));

    // 3. Build contact sheet grid using Sharp
    const videoWidth = finalFrames[0]?.width || 1280;
    const videoHeight = finalFrames[0]?.height || 720;
    const { buffer: gridBuffer, layout } = await buildFrameGrid(
      finalFrames,
      videoWidth,
      videoHeight,
      maxGridSize,
    );

    const gridFileName = `${segmentId}-grid.png`;
    const gridPath = path.join(outputDir, gridFileName);
    await fs.writeFile(gridPath, gridBuffer);

    const stat = await fs.stat(gridPath);
    const sha256 = await calculateFileSha256(gridPath);

    return {
      segmentId,
      path: gridPath,
      width: layout.width,
      height: layout.height,
      columns: layout.columns,
      rows: layout.rows,
      frameCount: frameEntries.length,
      bytes: stat.size,
      sha256,
      frames: frameEntries,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Prepares an image for Vision-Language model ingestion in the vision-ready format
 * (PNG → sharpen → 256-colour palette), capped by dimension and byte budget.
 */
export async function prepareVisionPng(
  image: Buffer,
  options: {
    maxDimension?: number;
    maxBytes?: number;
  } = {},
): Promise<Buffer> {
  const maxDimension = Math.max(320, Math.round(options.maxDimension ?? 2400));
  const maxBytes = Math.max(0, Math.round(options.maxBytes ?? 4 * 1024 * 1024)); // 4MB default

  let output = await toVisionPng(image);

  const metadata = await sharp(output).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (maxDimension > 0 && Math.max(width, height) > maxDimension) {
    output = await sharp(output)
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png({ palette: true, colours: 256, dither: 0 })
      .toBuffer();
  }

  if (maxBytes > 0 && output.length > maxBytes) {
    // Palette PNGs have no quality knob — shrink dimensions progressively instead.
    for (let i = 0; i < 6 && output.length > maxBytes; i++) {
      const meta = await sharp(output).metadata();
      output = await sharp(output)
        .resize(Math.max(320, Math.round((meta.width || maxDimension) * 0.8)))
        .png({ palette: true, colours: 256, dither: 0 })
        .toBuffer();
    }
    if (output.length > maxBytes) {
      output = await sharp(output)
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .png({ palette: true, colours: 256, dither: 0 })
        .toBuffer();
    }
  }

  return output;
}

/**
 * Projects FrameEvidence into legacy FramesResult format for downstream stages.
 */
export function projectFramesResult(
  evidence: FrameEvidence,
  framesPerSegment = LEGACY_FRAMES_PER_SEGMENT,
): FramesResult {
  const frames: Frame[] = [];
  const strips: FrameStrip[] = [];

  for (const segment of evidence.segments) {
    const gridFrames = segment.grid.frames;
    const count = Math.min(framesPerSegment, gridFrames.length);

    for (let i = 0; i < count; i++) {
      const idx = Math.floor((i * gridFrames.length) / count);
      const frameEntry = gridFrames[idx];
      if (frameEntry) {
        frames.push({
          segmentId: segment.segmentId,
          timestampSec: frameEntry.timestampSec,
        });
      }
    }

    strips.push({
      segmentId: segment.segmentId,
      path: segment.grid.path,
      width: segment.grid.width,
      height: segment.grid.height,
      bytes: segment.grid.bytes,
    });
  }

  return {
    videoId: evidence.videoId,
    frames,
    strips,
  };
}

/**
 * Asserts that the frame evidence covers all expected segments.
 */
export function assertCoversSegments(evidence: FrameEvidence, segments: readonly Segment[]): void {
  const covered = new Set(evidence.segments.map((entry) => entry.segmentId));
  const missing = segments.filter((segment) => !covered.has(segment.segmentId));
  if (missing.length > 0) {
    throw new AppError({
      code: ErrorCodes.FRAME_EXTRACTION_FAILED,
      message: `Frame evidence is missing ${missing.length} of ${segments.length} segments`,
      stage: 'research',
      task: 'extract-frames',
      retryable: false,
      cause: { missing: missing.map((segment) => segment.segmentId).slice(0, 5) },
    });
  }
}

/**
 * Main coordinator: collects frame evidence across all segments for a selected video.
 */
export async function collectFrameEvidence(
  options: CollectFrameEvidenceOptions,
): Promise<FrameEvidenceResult> {
  const {
    video,
    segments,
    transcript,
    videoPath,
    outputDir,
    minFrames = DEFAULT_MIN_FRAMES,
    maxFrames = DEFAULT_MAX_FRAMES,
    sceneThreshold = DEFAULT_SCENE_THRESHOLD,
    now = () => new Date(),
  } = options;

  if (!segments || segments.length === 0) {
    return null as any;
  }

  await fs.mkdir(outputDir, { recursive: true });

  if (!videoPath || videoPath.length === 0) {
    throw new AppError({
      code: ErrorCodes.FRAME_EXTRACTION_FAILED,
      message: `No video path provided — cannot extract frames without downloaded media`,
      stage: 'research',
      task: 'extract-frames',
      retryable: false,
    });
  }

  const media = await probeVideoMedia(videoPath!, video.videoId, { now });

  // Degenerate-media guard: a frozen (dead-frame) reference video must never reach
  // grid building — every segment would extract identical frames and every
  // downstream VL call (prompt detection) would burn tokens on duplicates.
  const degeneracy = await assertVideoFramesNotDegenerate({
    videoPath: videoPath!,
    context: `reference video ${video.videoId}`,
  });
  console.log(`[frames] Degeneracy check passed for ${video.videoId}: ${degeneracy.distinctCount}/${degeneracy.sampleCount} distinct samples across the video`);

  const segmentEvidences: SegmentFrameEvidence[] = [];
  let totalSceneTimestamps = 0;
  let overallSceneFallback = false;

  for (const segment of segments) {
    const sceneTimestamps = await detectSceneChanges(
      videoPath!,
      segment.startSec,
      segment.endSec,
      sceneThreshold,
    );
    totalSceneTimestamps += sceneTimestamps.length;

    const priorities = promptPriorityTimestamps(segment, transcript);

    const sampling = sampleSegmentTimestamps({
      startSec: segment.startSec,
      endSec: segment.endSec,
      sceneTimestamps,
      minFrames,
      maxFrames,
      priorityTimestamps: priorities,
    });

    if (sampling.sceneFallback) {
      overallSceneFallback = true;
    }

    const grid = await extractFramesAndBuildGrid({
      videoPath: videoPath!,
      segmentId: segment.segmentId,
      timestamps: sampling.timestamps,
      outputDir,
      segmentStartSec: segment.startSec,
    });

    segmentEvidences.push({
      segmentId: segment.segmentId,
      startSec: segment.startSec,
      endSec: segment.endSec,
      sampledCount: sampling.sampledCount,
      deduplicatedCount: sampling.deduplicatedCount,
      sceneFallback: sampling.sceneFallback,
      grid,
    });
  }

  const evidence: FrameEvidence = {
    videoId: video.videoId,
    provider: 'ffmpeg+sharp',
    media,
    sampling: {
      maxFrames,
      minFrames,
      maxGridSize: DEFAULT_MAX_GRID_SIZE,
      sceneThreshold,
      sceneTimestamps: totalSceneTimestamps,
      sceneFallback: overallSceneFallback,
    },
    segments: segmentEvidences,
    generatedAt: now().toISOString(),
  };

  assertCoversSegments(evidence, segments);
  const frames = projectFramesResult(evidence, LEGACY_FRAMES_PER_SEGMENT);

  return {
    evidence,
    frames,
  };
}
