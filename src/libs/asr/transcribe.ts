import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { extractAudioFromVideo, fileToDataUri, isAudioFile, isVideoFile } from './audio.js';
import { callPuterSttDriver, resolvePuterAuthToken } from './puter-client.js';
import type { PuterAsrOptions, PuterAsrResult } from './contracts.js';

export interface TranscribeProgressCallback {
  (stage: string, message: string): void;
}

/**
 * Transcribes audio from:
 * 1. An HTTPS audio URL (e.g. 'https://assets.puter.site/speech.mp3')
 * 2. A local audio file (.mp3, .wav, .ogg, .m4a)
 * 3. A local video file (.mp4, .webm, .mkv, .mov), extracting audio automatically via ffmpeg
 * 4. A Data URI string ('data:audio/...;base64,...')
 */
export async function transcribeAudio(
  input: string,
  options: PuterAsrOptions = {},
  onProgress?: TranscribeProgressCallback
): Promise<PuterAsrResult> {
  const notify = (stg: string, msg: string) => {
    onProgress?.(stg, msg);
  };

  let fileSource = input;
  let tempExtractedAudio: string | null = null;

  try {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      // Remote URL, pass directly to Puter
      notify('upload', `Passing remote audio URL to Puter ASR: ${input}`);
      fileSource = input;
    } else if (input.startsWith('data:')) {
      // Data URI
      notify('data-uri', `Using audio Data URI payload (${Math.round(input.length / 1024)} KB)`);
      fileSource = input;
    } else if (existsSync(input)) {
      // Local file
      if (isVideoFile(input)) {
        notify('extract-audio', `Extracting audio from video file: ${path.basename(input)}`);
        tempExtractedAudio = await extractAudioFromVideo(input);
        notify('encode-audio', `Encoding audio to Base64 Data URI...`);
        fileSource = await fileToDataUri(tempExtractedAudio);
      } else if (isAudioFile(input)) {
        notify('encode-audio', `Encoding local audio file ${path.basename(input)} to Base64 Data URI...`);
        fileSource = await fileToDataUri(input);
      } else {
        // Assume audio file by default
        notify('encode-file', `Encoding local file ${path.basename(input)} to Base64 Data URI...`);
        fileSource = await fileToDataUri(input);
      }
    } else {
      throw new Error(`Invalid ASR input source: "${input}". File does not exist and is not a valid URL.`);
    }

    notify('transcribe', `Requesting Puter STT (${options.model || 'gpt-4o-transcribe'})...`);
    const result = await callPuterSttDriver(fileSource, options);
    notify('done', `ASR completed: transcribed ${result.text.length} chars.`);
    return result;
  } finally {
    if (tempExtractedAudio) {
      await fs.unlink(tempExtractedAudio).catch(() => {});
    }
  }
}

/**
 * High-level helper for transcribing a video asset downloaded from Twitter / X or another platform.
 * Automatically extracts the audio, submits it to Puter ASR, and returns the transcription text.
 */
export async function transcribeTweetVideo(
  videoPath: string,
  options: PuterAsrOptions = {},
  onProgress?: (message: string) => void
): Promise<PuterAsrResult> {
  return transcribeAudio(videoPath, options, (_stage, msg) => onProgress?.(msg));
}

/**
 * Verifies if Puter ASR is configured and ready in the current environment.
 */
export async function checkPuterAsrReady(): Promise<{
  configured: boolean;
  tokenSource?: string;
  tokenPreview?: string;
}> {
  const token = await resolvePuterAuthToken();
  if (token) {
    return {
      configured: true,
      tokenSource: process.env.PUTER_AUTH_TOKEN ? 'env(PUTER_AUTH_TOKEN)' : 'token_file',
      tokenPreview: `${token.slice(0, 4)}...${token.slice(-4)}`,
    };
  }
  return {
    configured: false,
  };
}
