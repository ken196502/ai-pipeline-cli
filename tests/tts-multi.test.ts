import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeQwen3Tts } from '../src/libs/player/tts.js';

test('synthesizeQwen3Tts correctly synthesizes single and consecutive lines', async () => {
  const line1 = await synthesizeQwen3Tts('这是第一段解说词测试。', {
    speaker: 'Ryan',
    timeoutMs: 60_000,
  });
  assert.ok(line1.audioBuffer.length > 1000);
  assert.ok(line1.durationSec > 0.5);
  console.log(`✓ Line 1 synthesized: ${line1.durationSec.toFixed(2)}s, ${line1.words.length} words`);

  const line2 = await synthesizeQwen3Tts('这是第二段紧接着的解说词测试。', {
    speaker: 'Ryan',
    timeoutMs: 60_000,
  });
  assert.ok(line2.audioBuffer.length > 1000);
  assert.ok(line2.durationSec > 0.5);
  console.log(`✓ Line 2 synthesized: ${line2.durationSec.toFixed(2)}s, ${line2.words.length} words`);
});
