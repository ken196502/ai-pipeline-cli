import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  parseTopics,
  ContinuousTopicScheduler,
  runPipeline24h,
  pipelineRegistry,
} from '../src/pipelines/index.js';
import { formatDurationMs } from '../src/utils/time.js';

test('parseTopics parses semicolon-separated topics with whitespace and deduplication', () => {
  const parsed1 = parseTopics('AI; new model; deepseek r1 ; AI');
  assert.deepEqual(parsed1, ['AI', 'new model', 'deepseek r1']);

  const parsed2 = parseTopics('');
  assert.deepEqual(parsed2, ['new model']);

  const parsed3 = parseTopics(['model A', 'model B', 'model A']);
  assert.deepEqual(parsed3, ['model A', 'model B']);
});

test('formatDurationMs accurately formats milliseconds into readable duration string', () => {
  assert.equal(formatDurationMs(5000), '5s');
  assert.equal(formatDurationMs(65000), '1m 5s');
  assert.equal(formatDurationMs(3665000), '1h 1m 5s');
});

test('ContinuousTopicScheduler enforces maxRunsPer24h and calculates wait times', async () => {
  const topics = ['topic-a', 'topic-b'];
  const windowMs = 10_000; // 10 seconds window for test
  const scheduler = new ContinuousTopicScheduler(topics, {
    maxRunsPer24h: 2,
    windowMs,
  });

  const now = 1_000_000;

  // Topic A has not run yet
  assert.equal(scheduler.canRun('topic-a', now), true);
  assert.equal(scheduler.getWaitTimeMs('topic-a', now), 0);

  // 1st run for Topic A
  await scheduler.recordRun('topic-a', now);
  assert.equal(scheduler.canRun('topic-a', now + 100), true);
  assert.equal(scheduler.getRunsInWindow('topic-a', now + 100).length, 1);

  // 2nd run for Topic A
  await scheduler.recordRun('topic-a', now + 500);
  assert.equal(scheduler.canRun('topic-a', now + 600), false);
  assert.equal(scheduler.getRunsInWindow('topic-a', now + 600).length, 2);

  // Since maxRunsPer24h is 2, wait time is based on 1st run (oldest blocking run at now)
  const waitMs = scheduler.getWaitTimeMs('topic-a', now + 600);
  // readyAt is now + windowMs (10,000). Current time is now + 600 -> waitMs = 9,400
  assert.equal(waitMs, 9_400);

  // After window expires for 1st run (now + 10_001), 1st run rolls out, so topic-a can run again!
  assert.equal(scheduler.canRun('topic-a', now + 10_001), true);
});

test('ContinuousTopicScheduler persists state across reloads', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-test-'));
  const statePath = path.join(tempDir, 'state.json');

  try {
    const topics = ['alpha', 'beta'];
    const scheduler1 = new ContinuousTopicScheduler(topics, {
      maxRunsPer24h: 1,
      windowMs: 60_000,
      stateFilePath: statePath,
    });
    await scheduler1.init();

    const timestamp = Date.now();
    await scheduler1.recordRun('alpha', timestamp);
    await scheduler1.setLastIndex(1);

    // Verify file written to disk
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.maxRunsPer24h, 1);
    assert.equal(parsed.lastRunIndex, 1);
    assert.deepEqual(parsed.topics.alpha, [timestamp]);

    // Create a new scheduler instance pointing to same file
    const scheduler2 = new ContinuousTopicScheduler(topics, {
      maxRunsPer24h: 1,
      windowMs: 60_000,
      stateFilePath: statePath,
    });
    await scheduler2.init();

    assert.equal(scheduler2.getLastIndex(), 1);
    assert.equal(scheduler2.canRun('alpha'), false);
    assert.equal(scheduler2.canRun('beta'), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('runPipeline24h executes topics sequentially in non-stop loop and respects abort', async () => {
  const executed: Array<{ topic: string; round: number }> = [];
  const abortController = new AbortController();

  const topics = ['topic1', 'topic2', 'topic3'];
  let runCount = 0;

  await runPipeline24h({
    topics,
    maxRunsPer24h: 5,
    windowMs: 60_000,
    signal: abortController.signal,
    executeFn: async (topic, round) => {
      executed.push({ topic, round });
      runCount++;
      // Stop after 4 sequential rounds (topic1 -> topic2 -> topic3 -> topic1)
      if (runCount === 4) {
        abortController.abort();
      }
      return { success: true };
    },
  });

  assert.equal(executed.length, 4);
  assert.equal(executed[0].topic, 'topic1');
  assert.equal(executed[1].topic, 'topic2');
  assert.equal(executed[2].topic, 'topic3');
  assert.equal(executed[3].topic, 'topic1');
});

test('runPipeline24h continues to next topic when a topic encounters an error', async () => {
  const attempted: string[] = [];
  const errors: string[] = [];
  const abortController = new AbortController();

  const topics = ['failing-topic', 'healthy-topic'];
  let runCount = 0;

  await runPipeline24h({
    topics,
    maxRunsPer24h: 5,
    errorCooldownMs: 10, // short cooldown for test
    signal: abortController.signal,
    executeFn: async (topic) => {
      attempted.push(topic);
      runCount++;
      if (runCount >= 3) {
        abortController.abort();
      }
      if (topic === 'failing-topic') {
        throw new Error('Simulated network failure on X');
      }
      return { ok: true };
    },
    onRoundError: async (topic, err: any) => {
      errors.push(`${topic}: ${err.message}`);
    },
  });

  // Failing topic should not stop runner from progressing to healthy-topic
  assert.deepEqual(attempted, ['failing-topic', 'healthy-topic', 'failing-topic']);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Simulated network failure'));
});

test('pipelineRegistry.run24h launches registered pipeline in 24h mode', async () => {
  const executedTopics: string[] = [];
  const abortController = new AbortController();

  // Test with registered xhot pipeline in dry-run mode
  await pipelineRegistry.run24h('xhot', {
    topics: ['topic-A', 'topic-B'],
    maxRunsPer24h: 2,
    signal: abortController.signal,
    createOptions: (topic) => ({
      query: topic,
      dryRun: true,
      skipVideo: true,
    }),
    onRoundSuccess: async (topic) => {
      executedTopics.push(topic);
      if (executedTopics.length >= 2) {
        abortController.abort();
      }
    },
  });

  assert.deepEqual(executedTopics, ['topic-A', 'topic-B']);
});
