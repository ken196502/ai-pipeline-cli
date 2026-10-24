import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeQwen3Tts } from '../src/libs/player/tts.js';

test('synthesizeQwen3Tts correctly queries Hugging Face Space and returns audio with words', async () => {
  const result = await synthesizeQwen3Tts('Qwen3 在线语音合成测试成功。', {
    speaker: 'Ryan',
    timeoutMs: 60_000,
  });

  assert.ok(result.audioBuffer instanceof Buffer, 'audioBuffer should be a Buffer');
  assert.ok(result.audioBuffer.length > 1000, 'audioBuffer should contain valid audio data');
  assert.ok(result.durationSec > 0.5, 'durationSec should be greater than 0.5s');
  assert.ok(Array.isArray(result.words), 'words should be an array');
  assert.ok(result.words.length > 0, 'words array should not be empty');
  assert.equal(result.words[0].word, 'Q');
});
