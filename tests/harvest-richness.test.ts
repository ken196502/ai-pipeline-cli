import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTweetRichnessWithVL } from '../src/modules/harvest/eval-richness.js';

test('evaluateTweetRichnessWithVL: returns all indices directly when candidate count <= targetCount', async () => {
  const candidates = [
    {
      index: 1,
      tweetId: '101',
      authorName: 'User A',
      authorHandle: '@usera',
      text: 'Tweet 1 text',
      screenshotPath: '/tmp/cand-1.png',
    },
    {
      index: 2,
      tweetId: '102',
      authorName: 'User B',
      authorHandle: '@userb',
      text: 'Tweet 2 text',
      screenshotPath: '/tmp/cand-2.png',
    },
  ];

  const selected = await evaluateTweetRichnessWithVL({
    topicName: 'test-topic',
    candidates,
    targetCount: 10,
    outDir: '/tmp',
  });

  assert.deepEqual(selected, [1, 2]);
});
