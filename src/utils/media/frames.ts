import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp, { type OverlayOptions, type SharpenOptions } from 'sharp';

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

export const DEFAULT_MAX_GRID_SIZE = 2400;

export interface VideoInfo {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
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
  sampleSource?: string;
  jpeg: Buffer;
  width: number;
  height: number;
}

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

export async function probeVideo(videoPath: string, timeoutMs = 30_000): Promise<VideoInfo> {
  const ffprobeBin = resolveFfprobeBin();
  const { stdout } = await execFileAsync(
    ffprobeBin,
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
    { timeout: timeoutMs }
  );
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
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

export async function extractFrameAt(
  videoPath: string,
  timestampSec: number,
  outputPath: string,
  options: {
    quality?: number;
    timeoutMs?: number;
    ffmpegBin?: string;
    sharpen?: boolean | SharpenOptions;
  } = {}
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const ffmpegBin = options.ffmpegBin || resolveFfmpegBin();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const timestamp = Math.max(0, timestampSec);

  await execFileAsync(
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
    { timeout: options.timeoutMs ?? 60_000 }
  );

  if (!existsSync(outputPath)) {
    throw new Error(`ffmpeg did not create frame at timestamp ${timestampSec}s: ${outputPath}`);
  }

  const rawJpeg = await fs.readFile(outputPath);
  let sharpInstance = sharp(rawJpeg);
  if (options.sharpen !== false) {
    const sharpenOpts =
      typeof options.sharpen === 'object'
        ? options.sharpen
        : { sigma: 1.0, m1: 1.0, m2: 2.0 };
    sharpInstance = sharpInstance.sharpen(sharpenOpts);
  }
  const jpeg = await sharpInstance
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  await fs.writeFile(outputPath, jpeg);

  const metadata = await sharp(jpeg).metadata();
  return {
    jpeg,
    width: metadata.width || 0,
    height: metadata.height || 0,
  };
}

export async function buildFrameGrid(
  frames: ExtractedFrame[],
  videoWidth: number,
  videoHeight: number,
  maxGridSize = DEFAULT_MAX_GRID_SIZE,
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

    const tile = await sharp(frame.jpeg)
      .resize(layout.cellWidth, layout.cellHeight, {
        fit: 'contain',
        kernel: sharp.kernel.lanczos3,
        background: { r: 10, g: 12, b: 20 },
      })
      .png()
      .toBuffer();

    const label = `#${frame.frameIndex}  ${frame.timestamp}`;
    const fontSize = Math.max(6, Math.round(layout.cellWidth / 24 * 0.3));
    const labelWidth = Math.min(
      layout.cellWidth - 4,
      Math.max(60, Math.round(label.length * fontSize * 0.58 + 14))
    );
    const labelHeight = fontSize + 10;

    const svg = Buffer.from(`<svg width="${layout.cellWidth}" height="${layout.cellHeight}">
      <rect x="8" y="8" width="${labelWidth}" height="${labelHeight}" rx="4" fill="rgba(0,0,0,0.7)" />
      <text x="14" y="${8 + fontSize}" fill="#ffcc00" font-size="${fontSize}" font-family="monospace" font-weight="bold">${label}</text>
    </svg>`);

    overlays.push({ input: tile, left, top });
    overlays.push({ input: svg, left, top });
  }

  const canvas = await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 3,
      background: { r: 7, g: 10, b: 18 },
    },
  })
    .composite(overlays)
    .jpeg({ quality: 90 })
    .toBuffer();

  return { buffer: canvas, layout };
}
