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
import { loadEnvFile } from '../../utils/env.js';
import { resolveComponentRef, resolveTitleSafe, type ExplainerStyle } from './style.js';
import { locatePhraseTiming } from './phrase.js';
import type {
  ExplainerWord,
  ExplainerClip,
  ExplainerVoiceData,
  ExplainerVoiceClip,
  ExplainerVoiceShot,
  ExplainerVoiceLine,
  ExplainerAsset,
} from './contracts.js';

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Default Hugging Face Space Qwen3-TTS URL. */
export const DEFAULT_QWEN3_TTS_URL = 'https://qwen-qwen3-tts.hf.space';

/** Default local clone TTS URL. */
export const DEFAULT_LOCAL_TTS_URL = 'http://192.168.64.1:6111';

/** Resolves the Qwen3 TTS service URL from parameter or environment. */
export function resolveQwen3TtsUrl(customUrl?: string): string {
  const url = customUrl || process.env.QWEN3_TTS_URL || DEFAULT_QWEN3_TTS_URL;
  return url.replace(/https?:\/\/huggingface\.co\/spaces\//, 'https://').replace(/\/+$/, '');
}

/** Resolves the local TTS service URL from parameter or environment. */
export function resolveLocalTtsUrl(customUrl?: string): string {
  loadEnvFile();
  return (customUrl || process.env.LOCAL_TTS_URL || DEFAULT_LOCAL_TTS_URL).replace(/\/+$/, '');
}

/** Parses cooldown seconds from ZeroGPU quota exceeded message, or null if not a ZeroGPU quota error. */
export function parseZeroGpuWaitSec(errorMsg: string): number | null {
  if (!errorMsg.toLowerCase().includes('zerogpu quota')) {
    return null;
  }
  const match = errorMsg.match(/Try again in (?:(\d+):)?(\d+):(\d+)/i);
  if (match) {
    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const totalSec = hours * 3600 + minutes * 60 + seconds;
    return totalSec > 0 ? totalSec : 15;
  }
  return 20;
}

/**
 * Executes a single attempt to synthesize speech using Hugging Face Space Qwen3-TTS (gradio 5 API).
 */
async function executeSingleQwen3TtsAttempt(
  text: string,
  options: {
    url?: string;
    speaker?: string;
    language?: string;
    instruct?: string;
    modelSize?: string;
    timeoutMs?: number;
    token?: string;
  } = {}
): Promise<{ audioBuffer: Buffer; durationSec: number; words: ExplainerWord[] }> {
  loadEnvFile();
  const baseUrl = resolveQwen3TtsUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const speaker = !options.speaker || options.speaker === 'local-clone' ? 'Ryan' : options.speaker;
  const language = options.language || 'Auto';
  const instruct =
    options.instruct !== undefined
      ? options.instruct
      : 'Speak with confidence, clarity, and crisp projection like an authoritative tech news anchor. Energetic, distinct, broadcast-ready delivery; strictly avoid whispering, mumbling, or overly quiet tone.';
  const modelSize = options.modelSize || '1.7B';
  const hfToken = options.token !== undefined ? (options.token ? options.token : undefined) : process.env.HF_TOKEN;

  const sessionHash = Math.random().toString(36).slice(2, 12);
  const joinEndpoint = `${baseUrl}/gradio_api/queue/join`;

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (hfToken) {
    requestHeaders['Authorization'] = `Bearer ${hfToken}`;
  }

  let joinResponse: Response;
  try {
    joinResponse = await fetch(joinEndpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        data: [
          text,
          language,
          speaker,
          instruct, // Style Instruction (Optional)
          modelSize,
        ],
        fn_index: 2,
        trigger_id: 49,
        session_hash: sessionHash,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new Error(
      `Failed to initiate Qwen3-TTS queue request at ${joinEndpoint}: ${err?.message || String(err)}`
    );
  }

  if (!joinResponse.ok) {
    const errText = await joinResponse.text().catch(() => '');
    throw new Error(
      `Qwen3-TTS queue join failed with HTTP ${joinResponse.status} (${joinResponse.statusText}): ${errText}`
    );
  }

  const joinResult = (await joinResponse.json()) as { event_id?: string };
  const eventId = joinResult.event_id;
  if (!eventId) {
    throw new Error(`Qwen3-TTS did not return an event_id: ${JSON.stringify(joinResult)}`);
  }

  // Stream SSE results from queue/data until completion
  const streamEndpoint = `${baseUrl}/gradio_api/queue/data?session_hash=${encodeURIComponent(sessionHash)}`;
  let streamResponse: Response;
  try {
    streamResponse = await fetch(streamEndpoint, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(hfToken ? { Authorization: `Bearer ${hfToken}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new Error(
      `Failed to read Qwen3-TTS queue stream at ${streamEndpoint}: ${err?.message || String(err)}`
    );
  }

  if (!streamResponse.ok) {
    const errText = await streamResponse.text().catch(() => '');
    throw new Error(
      `Qwen3-TTS stream failed with HTTP ${streamResponse.status} (${streamResponse.statusText}): ${errText}`
    );
  }

  const streamBody = streamResponse.body;
  if (!streamBody) {
    throw new Error('Qwen3-TTS queue stream response body is null');
  }

  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let audioDownloadUrl: string | null = null;
  const recentMessages: any[] = [];

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (streamErr: any) {
        // The shared ZeroGPU Space serves one session at a time; a parallel
        // request or a proxy reset kills the SSE socket mid-generation and
        // undici reports the bare word "terminated". Classify it so the retry
        // wrapper above can back off and try again instead of failing the stage.
        const dropped: any = new Error(
          `Qwen3-TTS queue stream terminated before completion (session ${sessionHash}): ${streamErr?.message || String(streamErr)}`
        );
        dropped.code = 'TTS_STREAM_TERMINATED';
        dropped.retryable = true;
        throw dropped;
      }
      const { value, done } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('data:')) {
          const rawData = line.slice(5).trim();
          try {
            const parsed = JSON.parse(rawData);
            if (recentMessages.length > 5) recentMessages.shift();
            recentMessages.push(parsed);

            if (parsed.msg === 'unexpected_error') {
              const errDetail = parsed.message || parsed.output?.error || JSON.stringify(parsed);
              throw new Error(`Qwen3-TTS unexpected error: ${errDetail}`);
            }

            if (parsed.msg === 'process_completed') {
              if (parsed.success === false) {
                const errDetail =
                  parsed.output?.error || parsed.title || JSON.stringify(parsed.output || {});
                throw new Error(`Qwen3-TTS synthesis failed: ${errDetail}`);
              }
              const outputData = parsed.output?.data;
              if (Array.isArray(outputData) && outputData[0]?.url) {
                audioDownloadUrl = outputData[0].url;
              } else if (Array.isArray(outputData) && outputData[0]?.path) {
                audioDownloadUrl = `${baseUrl}/gradio_api/file=${outputData[0].path}`;
              }
              break;
            } else if (parsed.msg === 'close_stream' && !audioDownloadUrl) {
              break;
            }
          } catch (e: any) {
            if (e.message && e.message.includes('Qwen3-TTS synthesis failed:')) {
              throw e;
            }
          }
        }
      }

      if (audioDownloadUrl) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (!audioDownloadUrl) {
    const summary = recentMessages.map((m) => m?.msg || JSON.stringify(m)).join(', ');
    throw new Error(
      `Qwen3-TTS stream closed without returning generated audio. Last messages: [${summary}]. ZeroGPU quota may be exhausted or Hugging Face token is required.`
    );
  }

  // Download the generated audio file
  let audioFetchResponse: Response;
  try {
    audioFetchResponse = await fetch(audioDownloadUrl, {
      headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new Error(
      `Failed to download synthesized audio from ${audioDownloadUrl}: ${err?.message || String(err)}`
    );
  }

  if (!audioFetchResponse.ok) {
    throw new Error(
      `Failed to download audio from ${audioDownloadUrl}: HTTP ${audioFetchResponse.status}`
    );
  }

  const arrayBuf = await audioFetchResponse.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuf);

  // Measure audio duration precisely using ffprobe on a temp file
  const tmpWav = path.join(os.tmpdir(), `qwen3_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  await fs.writeFile(tmpWav, audioBuffer);
  let durationSec = 0;
  try {
    durationSec = await probeDurationSec(tmpWav);
  } finally {
    await fs.rm(tmpWav, { force: true }).catch(() => undefined);
  }

  // Generate linear word/character timings across the duration
  const words: ExplainerWord[] = [];
  const textChars = Array.from(text);
  if (textChars.length > 0 && durationSec > 0) {
    const charStep = durationSec / textChars.length;
    textChars.forEach((c, idx) => {
      words.push({
        word: c,
        t0: Math.round(idx * charStep * 1000) / 1000,
        t1: Math.round((idx + 1) * charStep * 1000) / 1000,
      });
    });
  }

  return { audioBuffer, durationSec, words };
}

/**
 * Synthesizes speech using Hugging Face Space Qwen3-TTS (gradio 5 API) with ZeroGPU quota retry resilience.
 * Fails loudly if the service returns an unrecoverable error or retries are exhausted (no fallback).
 */
export async function synthesizeQwen3Tts(
  text: string,
  options: {
    url?: string;
    speaker?: string;
    language?: string;
    instruct?: string;
    modelSize?: string;
    timeoutMs?: number;
    token?: string;
    maxRetries?: number;
  } = {}
): Promise<{ audioBuffer: Buffer; durationSec: number; words: ExplainerWord[] }> {
  loadEnvFile();
  const maxRetries = options.maxRetries ?? 3;
  // A single long narration line can take ~2 minutes on the shared Space.
  // Keep enough headroom so a normal slow generation is not aborted at 180s.
  const timeoutMs = options.timeoutMs ?? 300_000;
  let lastError: any = null;
  let currentToken = options.token || process.env.HF_TOKEN;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await executeSingleQwen3TtsAttempt(text, {
        ...options,
        timeoutMs,
        token: currentToken,
      });
    } catch (err: any) {
      lastError = err;
      const errMsg = err?.message || '';
      const isTimeout =
        err?.name === 'TimeoutError' ||
        /aborted due to timeout|timed out|timeout/i.test(errMsg);

      // A dropped SSE socket is transient: the Space was busy or the proxy reset
      // the connection. Back off and retry instead of failing the whole stage.
      const isStreamDropped =
        err?.code === 'TTS_STREAM_TERMINATED' ||
        /stream terminated|socket hang up|ECONNRESET|other side closed|fetch failed/i.test(errMsg);

      // If a free Hugging Face token is rejected because free account quota is 0s,
      // drop the token to let the request use the proxy IP quota.
      if (currentToken && errMsg.includes('free ZeroGPU quota')) {
        console.warn(
          `[tts] HF_TOKEN is a free tier account with 0s quota. Switching to proxy IP quota for Qwen3-TTS...`
        );
        currentToken = '';
        continue;
      }

      if (isTimeout && attempt < maxRetries) {
        console.warn(
          `[tts] Qwen3-TTS request timed out after ${Math.round(timeoutMs / 1000)}s; retrying ${attempt + 1}/${maxRetries}...`
        );
        continue;
      }

      if (isStreamDropped && attempt < maxRetries) {
        const backoffMs = 3000 * attempt;
        console.warn(
          `[tts] Qwen3-TTS stream dropped mid-generation (${errMsg.slice(0, 120)}); retrying ${attempt + 1}/${maxRetries} after ${backoffMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      const waitSec = parseZeroGpuWaitSec(errMsg);
      if (waitSec !== null && attempt < maxRetries) {
        console.warn(
          `[tts] ZeroGPU quota temporarily exceeded (${errMsg.slice(0, 80)}...). Cooling down for ${waitSec}s before retry ${attempt + 1}/${maxRetries}...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
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
): Promise<{ audioBuffer: Buffer; durationSec: number; words: ExplainerWord[] }> {
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
  const words: ExplainerWord[] = (data.timestamps || []).map((t) => ({
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
  words: ExplainerWord[];
}

export interface SynthesizeNarrationOptions {
  voice?: string;
  rate?: string;
  ttsUrl?: string;
  instruct?: string;
  pythonBin?: string;
  cwd?: string;
  /** Per-line TTS request timeout (default 300s for Qwen3-TTS). */
  timeoutMs?: number;
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

/** Synthesizes a single narration line (MP3 + word timings) via Qwen3-TTS HF Space (or local TTS if explicitly designated). */
export async function synthesizeNarrationSegment(
  request: NarrationSegmentRequest,
  options: SynthesizeNarrationOptions = {}
): Promise<NarrationSegmentResult> {
  await fs.mkdir(path.dirname(request.outAudioPath), { recursive: true });
  const wordsPath = `${request.outAudioPath}.words.json`;

  let synthResult: { audioBuffer: Buffer; durationSec: number; words: ExplainerWord[] };

  if (options.ttsUrl && options.ttsUrl.includes('192.168.')) {
    synthResult = await synthesizeLocalTts(request.text, {
      url: options.ttsUrl,
      timeoutMs: options.timeoutMs,
    });
  } else {
    const speaker = !options.voice || options.voice === 'local-clone' ? 'Ryan' : options.voice;
    synthResult = await synthesizeQwen3Tts(request.text, {
      url: options.ttsUrl,
      speaker,
      instruct: options.instruct,
      timeoutMs: options.timeoutMs,
    });
  }

  const { audioBuffer, durationSec, words } = synthResult;

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
    voice: options.voice && options.voice !== 'local-clone' ? options.voice : 'Ryan',
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
}): Promise<{ audioPath: string; wordsPath: string; durationSec: number; words: ExplainerWord[] }> {
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
  let words: ExplainerWord[] = [];
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

/**
 * @deprecated Timing now lives in style.json (`ExplainerStyle.timing`).
 * Kept only for backwards-compatible imports; do not read these constants.
 */
export const OPUS_TIMING = {
  TITLE_SAFE: 2.3,
  CLIP_TAIL: 0.5,
  LINE_GAP: 0.12,
  SHOT_GAP: 0.18,
} as const;

export interface BuildOpusVoiceTrackParams {
  clips: ExplainerClip[];
  outAudioDir: string;
  /**
   * Resolved style document. It is the single source of truth for every
   * silence/duration constant and for the `final-showcase` audio policy.
   */
  style: ExplainerStyle;
  assets?: ExplainerAsset[];
  voice?: string;
  rate?: string;
  instruct?: string;
  sampleRate?: number;
  ttsUrl?: string;
  onProgress?: (message: string) => void;
  /** Per-line TTS request timeout in milliseconds. */
  ttsTimeoutMs?: number;
  /** Max concurrent TTS line requests (default 2, override with EXPLAINER_TTS_CONCURRENCY). */
  concurrency?: number;
}

export interface OpusVoiceTrackResult {
  wavPath: string;
  mp3Path: string;
  voiceData: ExplainerVoiceData;
  totalDurationSec: number;
}

interface VoiceLineJob {
  index: number;
  clipIndex: number;
  shotIndex: number;
  lineIndex: number;
  text: string;
  /** On-screen element phrase (excerpt of `text`). */
  phrase: string;
  refId: string;
  /** Component source asset (final-showcase): its own audio replaces the TTS line. */
  sourceAssetId?: string;
  sourceAsset?: ExplainerAsset;
}

interface VoiceLineResult {
  /** Absolute audio duration contributed by this line. */
  aDur: number;
  /** Path of the concatenation part for this line. */
  partPath: string;
  words: ExplainerWord[];
  chars: Array<{ c: string; t: number }>;
}

/**
 * Resolves the TTS concurrency limit.
 *
 * Default is 1: the Qwen3-TTS HF Space is a single-session ZeroGPU app, and two
 * concurrent SSE sessions make the Space drop one of them mid-generation
 * (observed 2026-11-03: `terminated` 26s into a 5-line narration). Raise it via
 * `EXPLAINER_TTS_CONCURRENCY` only against a TTS endpoint that can take it.
 */
export function resolveTtsConcurrency(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.floor(override));
  }
  const env = Number(process.env.EXPLAINER_TTS_CONCURRENCY || process.env.TUTORIAL_TTS_CONCURRENCY);
  if (Number.isFinite(env) && env > 0) return Math.max(1, Math.floor(env));
  return 1;
}

/**
 * Builds the narration track and voice.json synchronization metadata.
 *
 * Pure with respect to the storyboard: it never writes `vStart/vDur/vLines`
 * back into the clip/shot objects (the player merges voice.json at runtime and
 * `attachVoiceTimings()` provides an in-memory copy for QA tooling).
 */
export async function buildOpusVoiceTrack(
  params: BuildOpusVoiceTrackParams
): Promise<OpusVoiceTrackResult> {
  const { clips, outAudioDir, style } = params;
  const voice = params.voice && params.voice !== 'local-clone' ? params.voice : 'Ryan';
  const rate = params.rate ?? '+0%';
  const sampleRate = params.sampleRate ?? 44100;
  const timing = style.timing;
  const titleSafe = resolveTitleSafe(timing);
  await fs.mkdir(outAudioDir, { recursive: true });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-voice-work-'));
  const wavPath = path.join(outAudioDir, 'narration.wav');
  const mp3Path = path.join(outAudioDir, 'narration.mp3');

  // Silence cache: one ffmpeg process per distinct duration instead of one per gap.
  const silenceCache = new Map<string, Promise<string>>();
  function makeSilence(durSec: number): Promise<string> {
    const key = durSec.toFixed(3);
    const cached = silenceCache.get(key);
    if (cached) return cached;
    const target = path.join(workDir, `silence-${key}.wav`);
    const job = execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=${sampleRate}:cl=stereo`,
      '-t',
      key,
      '-c:a',
      'pcm_s16le',
      target,
    ]).then(() => target);
    silenceCache.set(key, job);
    return job;
  }

  const finalShowcase = style.components.finalShowcase;

  // 1. Flatten every spoken line into an ordered job list.
  const jobs: VoiceLineJob[] = [];
  clips.forEach((clip, ci) => {
    clip.shots.forEach((shot, si) => {
      shot.elements.forEach((element, li) => {
        const text = shot.narration[li] || (element[0] as string);
        const visualRef = element[1];
        const refId = typeof visualRef === 'string' ? visualRef : visualRef.assetId || visualRef.name || '';
        const component = resolveComponentRef(refId, style);
        const isShowcase = component?.component === 'final-showcase';
        jobs.push({
          index: jobs.length,
          clipIndex: ci,
          shotIndex: si,
          lineIndex: li,
          text,
          phrase: String(element[0] ?? ''),
          refId,
          sourceAssetId: isShowcase
            ? component!.assetId && component!.assetId.length > 0
              ? component!.assetId
              : finalShowcase.asset
            : undefined,
        });
      });
    });
  });

  // 2. Synthesize concurrently (bounded), keeping the original order.
  const concurrency = resolveTtsConcurrency(params.concurrency);
  const results: VoiceLineResult[] = new Array(jobs.length);
  let completed = 0;
  let cursor = 0;

  async function processJob(job: VoiceLineJob): Promise<void> {
    const partName = `line-${String(job.clipIndex).padStart(3, '0')}-${String(job.shotIndex).padStart(2, '0')}-${String(job.lineIndex).padStart(2, '0')}`;
    const segWavPath = path.join(workDir, `${partName}.wav`);

    if (job.sourceAssetId) {
      const asset = (params.assets || []).find((a) => a.id === job.sourceAssetId);
      if (!asset) {
        throw new Error(
          `component:final-showcase references asset "${job.sourceAssetId}" which is not part of this bundle`
        );
      }
      let finalDur = asset.durationSec && asset.durationSec > 0 ? asset.durationSec : 0;
      if (!finalDur && asset.sourcePath) {
        finalDur = await probeDurationSec(asset.sourcePath);
      }
      if (!finalDur) {
        throw new Error(
          `component:final-showcase asset "${asset.id}" has no resolvable duration (missing durationSec/sourcePath)`
        );
      }

      // The showcase asset carries its own audio: never talk over it.
      let audioExtracted = false;
      if (finalShowcase.audio === 'source' && asset.sourcePath) {
        if (await probeHasAudioStream(asset.sourcePath)) {
          await extractAndResampleAudio({
            videoPath: asset.sourcePath,
            outAudioPath: segWavPath,
            sampleRate,
          });
          audioExtracted = true;
        }
      }
      if (!audioExtracted) {
        await execFileAsync('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `anullsrc=r=${sampleRate}:cl=stereo`,
          '-t',
          finalDur.toFixed(3),
          '-c:a',
          'pcm_s16le',
          segWavPath,
        ]);
      }
      results[job.index] = { aDur: finalDur, partPath: segWavPath, words: [], chars: [] };
      return;
    }

    params.onProgress?.(
      `Synthesizing narration (TTS): clip ${job.clipIndex + 1}/${clips.length}, shot ${job.shotIndex + 1}/${clips[job.clipIndex].shots.length}, line ${job.lineIndex + 1}/${clips[job.clipIndex].shots[job.shotIndex].elements.length}`
    );

    const segAudioPath = path.join(workDir, `${partName}.src.wav`);
    const seg = await synthesizeNarrationSegment(
      {
        sceneId: `${clips[job.clipIndex].id}_${clips[job.clipIndex].shots[job.shotIndex].id}_${job.lineIndex}`,
        text: job.text,
        outAudioPath: segAudioPath,
      },
      { voice, rate, instruct: params.instruct, ttsUrl: params.ttsUrl, timeoutMs: params.ttsTimeoutMs }
    );

    // Convert line segment to PCM WAV for seamless concatenation.
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

    // Word/char timings are made absolute during the assembly pass (the cursor
    // is only known there), so keep them relative for now.
    results[job.index] = {
      aDur: seg.durationSec,
      partPath: segWavPath,
      words: seg.words || [],
      chars: [],
    };
  }

  try {
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= jobs.length) return;
        await processJob(jobs[index]);
        completed += 1;
        if (completed === jobs.length) params.onProgress?.(`Narration synthesized: ${jobs.length} lines`);
      }
    });
    await Promise.all(workers);

    // 3. Assemble in order: title-safe silence → lines (+ line gaps) → shot gaps → clip tail.
    const audioParts: string[] = [];
    let currentCursor = 0;
    const voiceClips: ExplainerVoiceClip[] = [];
    const unmatchedPhrases: string[] = [];

    for (let ci = 0; ci < clips.length; ci += 1) {
      const clip = clips[ci];
      const clipStart = currentCursor;

      audioParts.push(await makeSilence(titleSafe));
      currentCursor += titleSafe;

      const voiceShots: ExplainerVoiceShot[] = [];
      let shotStart = currentCursor;

      for (let si = 0; si < clip.shots.length; si += 1) {
        shotStart = currentCursor;
        const shot = clip.shots[si];
        const voiceLines: ExplainerVoiceLine[] = [];

        for (let li = 0; li < shot.elements.length; li += 1) {
          const job = jobs.find(
            (j) => j.clipIndex === ci && j.shotIndex === si && j.lineIndex === li
          )!;
          const result = results[job.index];
          if (!result) throw new Error(`missing TTS result for ${clip.id}/${shot.id}/line ${li}`);

          // Secondary lines of a showcase shot are visual-only: the asset's own
          // audio already covers the shot, so they add no duration.
          const isShowcase = Boolean(job.sourceAssetId);
          const duplicatedShowcase = isShowcase && voiceLines.some((l) => l.aDur > 0 && l.icon === job.refId);
          const aDur = duplicatedShowcase ? 0 : result.aDur;

          const aStart = currentCursor;
          if (aDur > 0) {
            audioParts.push(result.partPath);
            currentCursor += aDur;
          }

          const words: ExplainerWord[] = result.words.map((w) => ({
            word: w.word,
            t0: round(aStart + w.t0),
            t1: round(aStart + w.t1),
          }));
          const chars: Array<{ c: string; t: number }> =
            words.length > 0
              ? words.map((w) => ({ c: w.word, t: w.t0 }))
              : Array.from(job.text).map((c, idx) => ({
                  c,
                  t: round(aStart + (aDur > 0 ? (idx * aDur) / Math.max(1, job.text.length) : 0)),
                }));

          // When does the voice actually say the on-screen phrase? The player
          // reveals the element `style.timing.phraseLead` seconds before pStart.
          const phraseTiming = locatePhraseTiming({
            text: job.text,
            phrase: job.phrase,
            aStart,
            aDur,
            words,
          });
          if (!phraseTiming.matched && aDur > 0 && !isShowcase) {
            unmatchedPhrases.push(`${clip.id}/${shot.id}#${li + 1} "${job.phrase}"`);
          }

          voiceLines.push({
            text: job.text,
            icon: job.refId,
            aStart: round(aStart),
            aDur: round(aDur),
            chars,
            words,
            phrase: job.phrase,
            pStart: phraseTiming.pStart,
            pEnd: phraseTiming.pEnd,
          });

          if (li < shot.elements.length - 1 && aDur > 0) {
            audioParts.push(await makeSilence(timing.lineGap));
            currentCursor += timing.lineGap;
          }
        }

        if (si < clip.shots.length - 1) {
          audioParts.push(await makeSilence(timing.shotGap));
          currentCursor += timing.shotGap;
        }

        voiceShots.push({
          start: round(shotStart),
          dur: round(currentCursor - shotStart),
          lines: voiceLines,
        });
      }

      audioParts.push(await makeSilence(timing.clipTail));
      currentCursor += timing.clipTail;

      voiceClips.push({
        start: round(clipStart),
        dur: round(currentCursor - clipStart),
        shots: voiceShots,
      });
    }

    const totalDurationSec = round(currentCursor);
    if (unmatchedPhrases.length > 0) {
      params.onProgress?.(
        `Warning: ${unmatchedPhrases.length} phrase(s) are not excerpts of their narration; they reveal at sentence start: ${unmatchedPhrases.slice(0, 5).join(', ')}${unmatchedPhrases.length > 5 ? ', …' : ''}`
      );
    }

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

    const voiceData: ExplainerVoiceData = {
      voice,
      total: totalDurationSec,
      titleSafe,
      clipTail: timing.clipTail,
      lineGap: timing.lineGap,
      shotGap: timing.shotGap,
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

