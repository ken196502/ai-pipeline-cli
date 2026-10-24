export * from './contracts.js';
export * from './audio.js';
export * from './puter-client.js';
export * from './transcribe.js';

import { checkPuterAsrReady } from './transcribe.js';
import { callPuterSttDriver } from './puter-client.js';
import { resolveFfmpegBin } from '../media/frames.js';

/**
 * Self-test routine for the ASR Module / Lib.
 */
export async function testAsrLib(): Promise<{
  success: boolean;
  configured: boolean;
  ffmpegAvailable: boolean;
  apiReachable: boolean;
  testModePassed?: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const status = await checkPuterAsrReady();
  let ffmpegAvailable = false;
  let apiReachable = false;
  let testModePassed: boolean | undefined;

  // 1. Check ffmpeg availability
  try {
    const ffmpegPath = resolveFfmpegBin();
    ffmpegAvailable = Boolean(ffmpegPath);
  } catch (err: any) {
    errors.push(`ffmpeg resolution error: ${err.message}`);
  }

  // 2. Check Puter API connectivity
  try {
    const res = await fetch('https://api.puter.com/version', {
      headers: { 'User-Agent': 'aigc-pipeline-asr/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      apiReachable = true;
    } else {
      errors.push(`Puter API unreachable: HTTP ${res.status}`);
    }
  } catch (err: any) {
    errors.push(`Puter API connection failed: ${err.message}`);
  }

  // 3. If configured with valid token, test driver call
  if (status.configured) {
    try {
      const mockResult = await callPuterSttDriver('https://assets.puter.site/speech.mp3', {
        testMode: true,
      });
      testModePassed = Boolean(mockResult?.text);
    } catch (err: any) {
      errors.push(`Puter ASR live test failed: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    configured: status.configured,
    ffmpegAvailable,
    apiReachable,
    testModePassed,
    errors,
  };
}

