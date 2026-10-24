import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { resolveFfmpegBin } from '../media/frames.js';

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.m4v', '.ts']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.wma']);

export function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export function isAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

/**
 * Extracts mono 16kHz MP3 audio from a video file using ffmpeg.
 * Produces an optimized, lightweight audio track ideal for speech-to-text processing.
 */
export async function extractAudioFromVideo(
  videoPath: string,
  outAudioPath?: string
): Promise<string> {
  if (!existsSync(videoPath)) {
    throw new Error(`Video file does not exist at: ${videoPath}`);
  }

  const ffmpegBin = resolveFfmpegBin();
  const destPath =
    outAudioPath ||
    path.join(
      os.tmpdir(),
      `asr-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
    );

  await fs.mkdir(path.dirname(destPath), { recursive: true });

  // ffmpeg -y -i <video> -vn -acodec libmp3lame -ac 1 -ar 16000 -q:a 4 <destPath>
  await execFileAsync(
    ffmpegBin,
    [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-q:a',
      '4',
      destPath,
    ],
    { timeout: 60_000 }
  );

  return destPath;
}

/**
 * Converts a local file to a Data URI string (e.g. data:audio/mp3;base64,...).
 */
export async function fileToDataUri(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  let mimeType = 'audio/mpeg';
  if (ext === 'wav') mimeType = 'audio/wav';
  else if (ext === 'ogg' || ext === 'opus') mimeType = 'audio/ogg';
  else if (ext === 'm4a' || ext === 'aac') mimeType = 'audio/mp4';
  else if (ext === 'flac') mimeType = 'audio/flac';
  else if (ext === 'mp3') mimeType = 'audio/mpeg';
  else if (ext === 'mp4') mimeType = 'video/mp4';

  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}
