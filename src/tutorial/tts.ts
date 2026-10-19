/**
 * Narration voice-over via edge-tts (Microsoft Edge neural voices).
 *
 * Each storyboard scene is synthesized into its own MP3 plus word-level
 * timings (WordBoundary), then the per-scene clips are padded to the exact
 * scene durations and concatenated into one full narration track.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { TutorialWord, TutorialClip, TutorialVoiceData, TutorialVoiceClip, TutorialVoiceShot, TutorialVoiceLine, TutorialAsset } from './contracts.js';

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Default local clone TTS URL. */
export const DEFAULT_LOCAL_TTS_URL = 'http://192.168.64.1:6111';

/** Resolves the local TTS service URL from parameter or environment. */
export function resolveLocalTtsUrl(customUrl?: string): string {
  return (customUrl || process.env.LOCAL_TTS_URL || DEFAULT_LOCAL_TTS_URL).replace(/\/+$/, '');
}

export interface LocalTtsTimestamp {
  text: string;
  start_time: number;
  end_time: number;
}

export interface LocalTtsResponse {
  audio_base64: string;
  sample_rate: number;
  duration: number;
  timestamps?: LocalTtsTimestamp[];
}

/**
 * Synthesizes speech using the local clone TTS service (with timestamps).
 * Fails loudly if the service is unreachable or returns an error (no fallback).
 */
export async function synthesizeLocalTts(
  text: string,
  options: { url?: string; timeoutMs?: number } = {}
): Promise<{ audioBuffer: Buffer; durationSec: number; words: TutorialWord[] }> {
  const baseUrl = resolveLocalTtsUrl(options.url);
  const endpoint = `${baseUrl}/tts`;
  const timeoutMs = options.timeoutMs ?? 60_000;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, return_timestamps: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: any) {
    throw new Error(
      `Failed to connect to local TTS service at ${endpoint}: ${error?.message || String(error)}. Ensure the local clone TTS service is running.`
    );
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Local TTS service returned HTTP ${response.status} (${response.statusText}): ${errorBody}`
    );
  }

  const data = (await response.json()) as LocalTtsResponse;
  if (!data.audio_base64) {
    throw new Error(`Local TTS service returned empty audio_base64 for text: "${text}"`);
  }

  const audioBuffer = Buffer.from(data.audio_base64, 'base64');
  const words: TutorialWord[] = (data.timestamps || []).map((t) => ({
    word: t.text,
    t0: Math.round(t.start_time * 1000) / 1000,
    t1: Math.round(t.end_time * 1000) / 1000,
  }));

  const durationSec = data.duration || (words.length > 0 ? words[words.length - 1].t1 : 0);

  return { audioBuffer, durationSec, words };
}

/** Path of the edge-tts python helper (lives in <project>/tools). */
export const EDGE_TTS_SYNTH_SCRIPT = path.resolve(moduleDir, '..', '..', 'tools', 'edge_tts_synth.py');

/** Default edge-tts voices per narration language (overridable via --tts-voice). */
export const DEFAULT_VOICE_BY_LANG: Readonly<Record<string, string>> = {
  'zh-CN': 'zh-CN-YunxiNeural',
  'zh-TW': 'zh-TW-YunJheNeural',
  'zh-HK': 'zh-HK-WanLungNeural',
  en: 'en-US-ChristopherNeural',
  'en-US': 'en-US-ChristopherNeural',
  'en-GB': 'en-GB-RyanNeural',
  ja: 'ja-JP-KeitaNeural',
  ko: 'ko-KR-InJoonNeural',
  es: 'es-ES-AlvaroNeural',
  fr: 'fr-FR-HenriNeural',
  de: 'de-DE-ConradNeural',
  pt: 'pt-BR-AntonioNeural',
  'pt-BR': 'pt-BR-AntonioNeural',
  ru: 'ru-RU-DmitryNeural',
  it: 'it-IT-DiegoNeural',
  ar: 'ar-SA-HamedNeural',
  hi: 'hi-IN-MadhurNeural',
  id: 'id-ID-ArdiNeural',
  th: 'th-TH-NiwatNeural',
  vi: 'vi-VN-NamMinhNeural',
};

export interface NarrationSegmentRequest {
  sceneId: string;
  text: string;
  /** Absolute destination MP3 path. */
  outAudioPath: string;
}

export interface NarrationSegmentResult {
  sceneId: string;
  audioPath: string;
  durationSec: number;
  words: TutorialWord[];
}

export interface SynthesizeNarrationOptions {
  voice?: string;
  rate?: string;
  ttsUrl?: string;
  pythonBin?: string;
  cwd?: string;
}

/**
 * Resolves the default edge-tts voice for a narration language.
 * Throws for unknown languages instead of silently substituting a voice.
 */
export function resolveDefaultVoice(narrationLanguage: string): string {
  const lang = narrationLanguage.trim();
  const direct = DEFAULT_VOICE_BY_LANG[lang] || DEFAULT_VOICE_BY_LANG[lang.toLowerCase()];
  if (direct) return direct;

  const primary = lang.split('-')[0];
  const viaPrimary = DEFAULT_VOICE_BY_LANG[primary];
  if (viaPrimary) return viaPrimary;

  throw new Error(
    `No default edge-tts voice known for narration language "${narrationLanguage}" — pass an explicit voice via --tts-voice`
  );
}

/** Probes the exact media duration in seconds via ffprobe. */
export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned invalid duration for ${filePath}: ${stdout.trim()}`);
  }
  return duration;
}

/** Synthesizes a single narration line (MP3 + word timings) via local clone TTS. */
export async function synthesizeNarrationSegment(
  request: NarrationSegmentRequest,
  options: SynthesizeNarrationOptions = {}
): Promise<NarrationSegmentResult> {
  await fs.mkdir(path.dirname(request.outAudioPath), { recursive: true });
  const wordsPath = `${request.outAudioPath}.words.json`;

  const { audioBuffer, durationSec, words } = await synthesizeLocalTts(request.text, {
    url: options.ttsUrl,
  });

  const isMp3 = request.outAudioPath.toLowerCase().endsWith('.mp3');
  if (isMp3) {
    const tempWav = `${request.outAudioPath}.tmp.wav`;
    await fs.writeFile(tempWav, audioBuffer);
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        tempWav,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        request.outAudioPath,
      ]);
    } finally {
      await fs.rm(tempWav, { force: true }).catch(() => undefined);
    }
  } else {
    await fs.writeFile(request.outAudioPath, audioBuffer);
  }

  const wordsPayload = {
    voice: options.voice || 'local-clone',
    rate: options.rate || '+0%',
    text: request.text,
    durationSec,
    words,
  };
  await fs.writeFile(wordsPath, JSON.stringify(wordsPayload, null, 2) + '\n', 'utf-8');

  return {
    sceneId: request.sceneId,
    audioPath: request.outAudioPath,
    durationSec,
    words,
  };
}

/**
 * Synthesizes audio using Edge-TTS python helper.
 */
export async function synthesizeEdgeTtsAudio(params: {
  text: string;
  outAudioPath: string;
  voice?: string;
  rate?: string;
  pythonBin?: string;
}): Promise<{ audioPath: string; wordsPath: string; durationSec: number; words: TutorialWord[] }> {
  const { text, outAudioPath } = params;
  const voice = params.voice || 'zh-CN-YunxiNeural';
  const rate = params.rate || '+0%';
  const pythonBin = params.pythonBin || process.env.PYTHON_BIN || 'python3';
  const wordsPath = `${outAudioPath}.words.json`;

  await fs.mkdir(path.dirname(outAudioPath), { recursive: true });

  await execFileAsync(
    pythonBin,
    [
      EDGE_TTS_SYNTH_SCRIPT,
      '--text',
      text,
      '--voice',
      voice,
      '--rate',
      rate,
      '--out-audio',
      outAudioPath,
      '--out-words',
      wordsPath,
    ],
    { timeout: 120_000 }
  );

  const durationSec = await probeDurationSec(outAudioPath);
  let words: TutorialWord[] = [];
  try {
    const payload = JSON.parse(await fs.readFile(wordsPath, 'utf-8'));
    words = payload.words || [];
  } catch {
    words = [];
  }

  return { audioPath: outAudioPath, wordsPath, durationSec, words };
}

/**
 * Voices an AI video clip using Edge-TTS narration and muxes it with the video.
 */
export async function voiceAndMuxAiVideo(params: {
  videoPath: string;
  narrationText: string;
  outVoicedVideoPath: string;
  voice?: string;
  rate?: string;
}): Promise<{ voicedVideoPath: string; audioPath: string; durationSec: number }> {
  const { videoPath, narrationText, outVoicedVideoPath } = params;
  await fs.mkdir(path.dirname(outVoicedVideoPath), { recursive: true });
  const audioPath = `${outVoicedVideoPath}.edgetts.mp3`;

  await synthesizeEdgeTtsAudio({
    text: narrationText,
    outAudioPath: audioPath,
    voice: params.voice,
    rate: params.rate,
  });

  await muxAiVideoNarration({ videoPath, audioPath, outVoicedVideoPath });
  const durationSec = await probeDurationSec(outVoicedVideoPath);
  return { voicedVideoPath: outVoicedVideoPath, audioPath, durationSec };
}

/** Preserve every video frame; fit long speech and pad short speech with silence. */
export async function muxAiVideoNarration(params: {
  videoPath: string;
  audioPath: string;
  outVoicedVideoPath: string;
}): Promise<void> {
  const videoDuration = await probeDurationSec(params.videoPath);
  const audioDuration = await probeDurationSec(params.audioPath);
  let speed = Math.max(1, audioDuration / videoDuration);
  const filters: string[] = [];
  while (speed > 2) {
    filters.push('atempo=2');
    speed /= 2;
  }
  if (speed > 1) filters.push(`atempo=${speed}`);
  filters.push('apad');
  await execFileAsync('ffmpeg', [
    '-y', '-i', params.videoPath, '-i', params.audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-af', filters.join(','),
    '-c:a', 'aac', '-b:a', '192k', '-t', String(videoDuration),
    '-movflags', '+faststart', params.outVoicedVideoPath,
  ]);
}

/**
 * Concatenates multiple AI video clips into a single continuous master video (成片).
 */
export async function assembleFinalAiVideo(params: {
  videoPaths: string[];
  outFinalPath: string;
}): Promise<{ finalVideoPath: string; durationSec: number }> {
  const { videoPaths, outFinalPath } = params;
  if (videoPaths.length === 0) {
    throw new Error('assembleFinalAiVideo requires at least one video path');
  }

  await fs.mkdir(path.dirname(outFinalPath), { recursive: true });

  if (videoPaths.length === 1) {
    await fs.copyFile(videoPaths[0], outFinalPath);
    const durationSec = await probeDurationSec(outFinalPath);
    return { finalVideoPath: outFinalPath, durationSec };
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-final-video-'));
  try {
    const listFile = path.join(workDir, 'concat-list.txt');
    const content = videoPaths.map((p) => `file '${path.resolve(p)}'`).join('\n') + '\n';
    await fs.writeFile(listFile, content, 'utf-8');

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c',
        'copy',
        outFinalPath,
      ]);
    } catch {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        outFinalPath,
      ]);
    }

    const durationSec = await probeDurationSec(outFinalPath);
    return { finalVideoPath: outFinalPath, durationSec };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface NarrationTrackSegment {
  audioPath: string;
  /** Exact on-screen duration the segment must occupy (audio is padded/trimmed). */
  durationSec: number;
}

/**
 * Builds the full narration track: every segment is padded (or trimmed) to its
 * scene duration and concatenated, so the track length equals the timeline
 * length exactly and stays frame-aligned with the rendered video.
 * Returns both a lossless WAV (for muxing) and an M4A (for browser preview).
 */
export async function buildNarrationTrack(
  segments: readonly NarrationTrackSegment[],
  outBasePath: string,
  options: { sampleRate?: number } = {}
): Promise<{ wavPath: string; m4aPath: string; totalDurationSec: number }> {
  if (segments.length === 0) {
    throw new Error('buildNarrationTrack requires at least one narration segment');
  }

  const sampleRate = options.sampleRate ?? 44100;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tutorial-narration-'));
  const wavPath = `${outBasePath}.wav`;
  const m4aPath = `${outBasePath}.m4a`;
  const totalDurationSec = segments.reduce((acc, seg) => acc + seg.durationSec, 0);

  try {
    const paddedPaths: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const padded = path.join(workDir, `seg-${String(i).padStart(3, '0')}.wav`);
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        seg.audioPath,
        '-ar',
        String(sampleRate),
        '-ac',
        '2',
        '-af',
        'apad',
        '-t',
        seg.durationSec.toFixed(3),
        padded,
      ]);
      paddedPaths.push(padded);
    }

    const concatList = path.join(workDir, 'concat.txt');
    await fs.writeFile(
      concatList,
      paddedPaths.map((p) => `file '${p}'`).join('\n') + '\n',
      'utf-8'
    );

    await fs.mkdir(path.dirname(outBasePath), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatList,
      '-c',
      'copy',
      wavPath,
    ]);
    await execFileAsync('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'aac', '-b:a', '192k', m4aPath]);

    return { wavPath, m4aPath, totalDurationSec };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Checks if a video file contains an audio stream.
 */
export async function probeHasAudioStream(videoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'json',
      videoPath,
    ]);
    const parsed = JSON.parse(stdout || '{}');
    return Array.isArray(parsed.streams) && parsed.streams.length > 0;
  } catch {
    return false;
  }
}

/**
 * Extracts and resamples the audio stream from a video into a stereo PCM WAV file.
 */
export async function extractAndResampleAudio(params: {
  videoPath: string;
  outAudioPath: string;
  sampleRate: number;
}): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    params.videoPath,
    '-vn',
    '-ar',
    String(params.sampleRate),
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    params.outAudioPath,
  ]);
}

/** Timing constants matching OpusVideo engine specs (in seconds). */
export const OPUS_TIMING = {
  TITLE_SAFE: 2.30,  // chapter title card intro + hold + outro
  CLIP_TAIL: 0.50,   // clean clip tail transition
  LINE_GAP: 0.12,    // breathing space between lines in a shot
  SHOT_GAP: 0.18,    // breathing space between shots
};

/**
 * Builds the OpusVideo-aligned voice track and voice.json synchronization metadata.
 * Inserts exact title-safe and transition silences so the full audio duration
 * is 1:1 identical to the procedural visual timeline.
 */
export interface OpusVoiceTrackResult {
  wavPath: string;
  mp3Path: string;
  voiceData: TutorialVoiceData;
  totalDurationSec: number;
}

export async function buildOpusVoiceTrack(params: {
  clips: TutorialClip[];
  outAudioDir: string;
  assets?: TutorialAsset[];
  voice?: string;
  rate?: string;
  sampleRate?: number;
  ttsUrl?: string;
  onProgress?: (message: string) => void;
}): Promise<OpusVoiceTrackResult> {
  const { clips, outAudioDir } = params;
  const voice = params.voice || 'local-clone';
  const rate = params.rate ?? '+0%';
  const sampleRate = params.sampleRate ?? 44100;
  await fs.mkdir(outAudioDir, { recursive: true });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-voice-work-'));
  const wavPath = path.join(outAudioDir, 'narration.wav');
  const mp3Path = path.join(outAudioDir, 'narration.mp3');

  // Silence generator helper
  async function makeSilence(durSec: number, filename: string): Promise<string> {
    const target = path.join(workDir, filename);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=${sampleRate}:cl=stereo`,
      '-t',
      durSec.toFixed(3),
      '-c:a',
      'pcm_s16le',
      target,
    ]);
    return target;
  }

  const audioParts: string[] = [];
  let currentCursor = 0;
  let partIndex = 0;

  const voiceClips: TutorialVoiceClip[] = [];

  try {
    for (let ci = 0; ci < clips.length; ci += 1) {
      const clip = clips[ci];
      const clipStart = currentCursor;

      // 1. Title Safe Silence (chapter card window)
      const titleSilence = await makeSilence(OPUS_TIMING.TITLE_SAFE, `part-${String(partIndex++).padStart(4, '0')}-title-silence.wav`);
      audioParts.push(titleSilence);
      currentCursor += OPUS_TIMING.TITLE_SAFE;

      const voiceShots: TutorialVoiceShot[] = [];

      for (let si = 0; si < clip.shots.length; si += 1) {
        const shot = clip.shots[si];
        const shotStart = currentCursor;
        const voiceLines: TutorialVoiceLine[] = [];

        for (let li = 0; li < shot.elements.length; li += 1) {
          const lineText = shot.narration[li] || (shot.elements[li][0] as string);
          const visualRef = shot.elements[li][1];
          const refId = typeof visualRef === 'string' ? visualRef : visualRef.assetId || visualRef.name || '';
          const isFinalVideo = refId === 'final-ai-video';

          const segWavPath = path.join(workDir, `clip-${ci}-shot-${si}-line-${li}-resampled.wav`);
          let aDur = 0;
          const chars: Array<{ c: string; t: number }> = [];
          let lineWords: TutorialWord[] = [];

          if (isFinalVideo) {
            // 成片自带声音，成片展示期间绝不加教程 TTS 旁白覆盖成片！
            const finalAsset = (params.assets || []).find((a) => a.id === 'final-ai-video');
            let finalDur = finalAsset?.durationSec && finalAsset.durationSec > 0 ? finalAsset.durationSec : 0;
            if (!finalDur && finalAsset?.sourcePath) {
              try {
                finalDur = await probeDurationSec(finalAsset.sourcePath);
              } catch {
                finalDur = 4;
              }
            }
            if (!finalDur) finalDur = 4;
            aDur = finalDur;

            let audioExtracted = false;
            if (finalAsset?.sourcePath) {
              try {
                const hasAudio = await probeHasAudioStream(finalAsset.sourcePath);
                if (hasAudio) {
                  await extractAndResampleAudio({
                    videoPath: finalAsset.sourcePath,
                    outAudioPath: segWavPath,
                    sampleRate,
                  });
                  audioExtracted = true;
                }
              } catch {
                audioExtracted = false;
              }
            }

            if (!audioExtracted) {
              await makeSilence(finalDur, path.basename(segWavPath));
            }
            audioParts.push(segWavPath);
          } else {
            const segAudioPath = path.join(workDir, `clip-${ci}-shot-${si}-line-${li}.wav`);
            params.onProgress?.(`Synthesizing narration (local TTS): clip ${ci + 1}/${clips.length}, shot ${si + 1}/${clip.shots.length}, line ${li + 1}/${shot.elements.length}`);
            const seg = await synthesizeNarrationSegment(
              {
                sceneId: `${clip.id}_${shot.id}_${li}`,
                text: lineText,
                outAudioPath: segAudioPath,
              },
              { voice, rate, ttsUrl: params.ttsUrl }
            );

            // Convert line segment to PCM WAV for seamless concatenation
            await execFileAsync('ffmpeg', [
              '-y',
              '-i',
              segAudioPath,
              '-ar',
              String(sampleRate),
              '-ac',
              '2',
              segWavPath,
            ]);
            audioParts.push(segWavPath);
            aDur = seg.durationSec;

            // Build token/char times for karaoke reveal directly from real local TTS timestamps
            if (seg.words && seg.words.length > 0) {
              lineWords = seg.words.map((w) => ({
                word: w.word,
                t0: round(currentCursor + w.t0),
                t1: round(currentCursor + w.t1),
              }));
              for (const w of seg.words) {
                chars.push({ c: w.word, t: round(currentCursor + w.t0) });
              }
            } else {
              const textChars = Array.from(lineText);
              const charStep = textChars.length > 0 ? aDur / textChars.length : 0.05;
              textChars.forEach((c, idx) => {
                chars.push({ c, t: round(currentCursor + idx * charStep) });
              });
            }
          }

          const aStart = currentCursor;
          currentCursor += aDur;

          voiceLines.push({
            text: isFinalVideo ? (lineText || 'Final AI Video Showcase') : lineText,
            icon: refId,
            aStart: round(aStart),
            aDur: round(aDur),
            chars,
            words: lineWords,
          });

          // Line gap breathing space
          if (li < shot.elements.length - 1) {
            const lineGap = await makeSilence(OPUS_TIMING.LINE_GAP, `part-${String(partIndex++).padStart(4, '0')}-linegap.wav`);
            audioParts.push(lineGap);
            currentCursor += OPUS_TIMING.LINE_GAP;
          }
        }

        // Shot gap breathing space
        if (si < clip.shots.length - 1) {
          const shotGap = await makeSilence(OPUS_TIMING.SHOT_GAP, `part-${String(partIndex++).padStart(4, '0')}-shotgap.wav`);
          audioParts.push(shotGap);
          currentCursor += OPUS_TIMING.SHOT_GAP;
        }

        const shotDur = currentCursor - shotStart;
        shot.vStart = round(shotStart);
        shot.vDur = round(shotDur);
        shot.vLines = voiceLines;

        voiceShots.push({
          start: round(shotStart),
          dur: round(shotDur),
          lines: voiceLines,
        });
      }

      // Clip tail silence
      const tailSilence = await makeSilence(OPUS_TIMING.CLIP_TAIL, `part-${String(partIndex++).padStart(4, '0')}-tail-silence.wav`);
      audioParts.push(tailSilence);
      currentCursor += OPUS_TIMING.CLIP_TAIL;

      const clipDur = currentCursor - clipStart;
      clip.vStart = round(clipStart);
      clip.vDur = round(clipDur);

      voiceClips.push({
        start: round(clipStart),
        dur: round(clipDur),
        shots: voiceShots,
      });
    }

    const totalDurationSec = round(currentCursor);

    // Concatenate all parts
    const concatList = path.join(workDir, 'concat-all.txt');
    await fs.writeFile(
      concatList,
      audioParts.map((p) => `file '${p}'`).join('\n') + '\n',
      'utf-8'
    );

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatList,
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      wavPath,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      mp3Path,
    ]);

    const voiceData: TutorialVoiceData = {
      voice,
      total: totalDurationSec,
      titleSafe: OPUS_TIMING.TITLE_SAFE,
      clipTail: OPUS_TIMING.CLIP_TAIL,
      lineGap: OPUS_TIMING.LINE_GAP,
      shotGap: OPUS_TIMING.SHOT_GAP,
      clips: voiceClips,
    };

    return { wavPath, mp3Path, voiceData, totalDurationSec };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function round(val: number): number {
  return Math.round(val * 1000) / 1000;
}

