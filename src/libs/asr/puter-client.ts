import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '../../utils/env.js';
import { getProjectRootDir } from '../../utils/browser.js';
import type { PuterAsrOptions, PuterAsrResult } from './contracts.js';

const PUTER_DRIVERS_CALL_ENDPOINT = 'https://api.puter.com/drivers/call';
const DEFAULT_MODEL = 'gpt-4o-transcribe';

/**
 * Resolves the Puter authentication token from multiple candidate sources:
 * 1. Explicitly provided authToken option
 * 2. process.env.PUTER_AUTH_TOKEN
 * 3. process.env.puterAuthToken
 * 4. puter_token.json file in project root or VideoGen root
 */
export async function resolvePuterAuthToken(explicitToken?: string): Promise<string | null> {
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }

  loadEnvFile();

  const envToken = process.env.PUTER_AUTH_TOKEN || process.env.puterAuthToken;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }

  // Check puter_token.json file
  const root = getProjectRootDir();
  const candidateFiles = [
    path.join(root, 'puter_token.json'),
    path.join(root, '.puter/token.json'),
    path.resolve(root, '../VideoGen/puter_token.json'),
  ];

  for (const file of candidateFiles) {
    if (existsSync(file)) {
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const parsed = JSON.parse(raw);
        const token = parsed.token || parsed.auth_token || parsed.authToken;
        if (typeof token === 'string' && token.trim()) {
          return token.trim();
        }
      } catch {}
    }
  }

  return null;
}

export interface PuterDriverCallPayload {
  interface: string;
  driver: string;
  method: string;
  test_mode?: boolean;
  args: Record<string, unknown>;
  auth_token?: string;
}

/**
 * Calls Puter Drivers API directly via HTTP POST.
 * Uses exact protocol expected by Puter.js:
 * endpoint: https://api.puter.com/drivers/call
 * Content-Type: text/plain;actually=json
 */
export async function callPuterSttDriver(
  fileSource: string,
  options: PuterAsrOptions = {}
): Promise<PuterAsrResult> {
  const authToken = await resolvePuterAuthToken(options.authToken);

  if (!authToken && !options.testMode) {
    throw new Error(
      'Puter ASR requires an authentication token. Set PUTER_AUTH_TOKEN in .env or provide authToken option (see https://developer.puter.com/tutorials/free-unlimited-speech-to-text-api/).'
    );
  }

  const model = options.model || DEFAULT_MODEL;
  const method = options.translate ? 'translate' : 'transcribe';

  const driverArgs: Record<string, unknown> = {
    file: fileSource,
    model,
  };

  if (options.testMode) {
    driverArgs.test_mode = true;
  }
  if (options.response_format) {
    driverArgs.response_format = options.response_format;
  }
  if (options.timestamp_granularities) {
    driverArgs.timestamp_granularities = options.timestamp_granularities;
  }
  if (options.language) {
    driverArgs.language = options.language;
  }

  const payload: PuterDriverCallPayload = {
    interface: 'puter-speech2txt',
    driver: 'ai-speech2txt',
    method,
    test_mode: options.testMode,
    args: driverArgs,
    auth_token: authToken || undefined,
  };

  const timeoutMs = options.timeoutMs || 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(PUTER_DRIVERS_CALL_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'text/plain;actually=json',
        'User-Agent': 'aigc-pipeline-asr/1.0',
        Origin: 'https://puter.work',
        Referer: 'https://puter.work/',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await res.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Puter ASR returned non-JSON response (HTTP ${res.status}): ${responseText.slice(0, 300)}`
      );
    }

    if (!res.ok || data.success === false || data.error) {
      const errMsg =
        data.message || data.error?.message || data.error || `HTTP ${res.status} error`;
      const code = data.code || data.error?.code || 'ASR_ERROR';
      throw new Error(`Puter ASR Error [${code}]: ${errMsg}`);
    }

    const result = data.result !== undefined ? data.result : data;

    if (typeof result === 'string') {
      return {
        text: result.trim(),
        model: typeof model === 'string' ? model : undefined,
        raw: result,
      };
    }

    const text = (result.text || '').trim();
    const durationSeconds =
      typeof result.duration_seconds === 'number'
        ? result.duration_seconds
        : typeof result.duration === 'number'
          ? result.duration
          : undefined;

    const words = Array.isArray(result.words)
      ? result.words.map((w: any) => ({
          word: w.word || w.text || '',
          start: typeof w.start === 'number' ? w.start : 0,
          end: typeof w.end === 'number' ? w.end : 0,
        }))
      : undefined;

    const segments = Array.isArray(result.segments)
      ? result.segments.map((s: any) => ({
          speaker: s.speaker,
          text: s.text || '',
          start: typeof s.start === 'number' ? s.start : undefined,
          end: typeof s.end === 'number' ? s.end : undefined,
        }))
      : undefined;

    return {
      text,
      model: typeof model === 'string' ? model : undefined,
      language: result.language,
      durationSeconds,
      words,
      segments,
      raw: result,
    };
  } finally {
    clearTimeout(timer);
  }
}
