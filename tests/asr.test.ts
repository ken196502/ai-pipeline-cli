import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  testAsrLib,
  checkPuterAsrReady,
  resolvePuterAuthToken,
  isVideoFile,
  isAudioFile,
  fileToDataUri,
  PuterAsrResultSchema,
  extractAudioFromVideo,
  transcribeAudio,
} from '../src/libs/asr/index.js';

test('ASR Lib: file type detection for audio and video files', () => {
  assert.equal(isVideoFile('sample.mp4'), true);
  assert.equal(isVideoFile('/tmp/video.webm'), true);
  assert.equal(isVideoFile('audio.mp3'), false);

  assert.equal(isAudioFile('sample.mp3'), true);
  assert.equal(isAudioFile('voice.wav'), true);
  assert.equal(isAudioFile('video.mp4'), false);
});

test('ASR Lib: fileToDataUri encodes file into valid base64 data URI', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-asr-${Date.now()}.mp3`);
  await fs.writeFile(tmpFile, Buffer.from('RIFF....WAVEfmt '));
  try {
    const dataUri = await fileToDataUri(tmpFile);
    assert.ok(dataUri.startsWith('data:audio/mpeg;base64,'));
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
});

test('ASR Lib: PuterAsrResultSchema validates correctly', () => {
  const valid = PuterAsrResultSchema.parse({
    text: 'Hello world',
    model: 'gpt-4o-transcribe',
    durationSeconds: 2.5,
    words: [{ word: 'Hello', start: 0, end: 1 }],
  });
  assert.equal(valid.text, 'Hello world');
  assert.equal(valid.durationSeconds, 2.5);
});

test('ASR Lib: testAsrLib verifies ffmpeg and Puter reachability', async () => {
  const res = await testAsrLib();
  assert.equal(res.success, true, `ASR test failed: ${res.errors.join(', ')}`);
  assert.equal(res.ffmpegAvailable, true, 'ffmpeg must be available for ASR audio extraction');
  assert.equal(res.apiReachable, true, 'api.puter.com should be reachable');
});

test('ASR Lib: transcribeAudio throws when given non-existent file without falling back to fake text', async () => {
  await assert.rejects(
    async () => {
      await transcribeAudio('/non/existent/path/audio.mp3', { testMode: true });
    },
    {
      message: /Invalid ASR input source/i,
    }
  );
});

test('ASR Lib: transcribeAudio throws clear error when auth token is missing for live transcription', async () => {
  const savedToken = process.env.PUTER_AUTH_TOKEN;
  const savedToken2 = process.env.puterAuthToken;
  try {
    delete process.env.PUTER_AUTH_TOKEN;
    delete process.env.puterAuthToken;

    await assert.rejects(
      async () => {
        await transcribeAudio('https://assets.puter.site/speech.mp3', { authToken: '' });
      },
      {
        message: /Puter ASR requires an authentication token/i,
      }
    );
  } finally {
    if (savedToken) process.env.PUTER_AUTH_TOKEN = savedToken;
    if (savedToken2) process.env.puterAuthToken = savedToken2;
  }
});
