import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  XHOT_STAGES,
  XHotPipelineOptionsSchema,
  executeXHotPipeline,
} from '../src/pipelines/index.js';
import {
  buildXHotGrid,
  type XHotCandidate,
  XHotEvalResultSchema,
  isXLoggedIn,
  isPromotedTweet,
} from '../src/modules/index.js';

test('xhot pipeline stages are correctly defined', { timeout: 10_000 }, () => {
  assert.equal(XHOT_STAGES.length, 7);
  const stageIds = XHOT_STAGES.map((s) => s.id);
  assert.deepEqual(stageIds, [
    'check-env',
    'x-login',
    'x-search-grid',
    'x-eval',
    'x-harvest',
    'x-video',
    'report',
  ]);
});

test('XHotPipelineOptionsSchema validates query and defaults', { timeout: 5_000 }, () => {
  const parsed = XHotPipelineOptionsSchema.parse({
    query: 'new model',
  });
  assert.equal(parsed.query, 'new model');
  assert.equal(parsed.candidateCount, 12);
  assert.equal(parsed.tutorialEngine, 'chromium');
  assert.equal(parsed.dryRun, false);
});

test('buildXHotGrid creates valid NxN contact grid with numbering badges', { timeout: 15_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhot-grid-test-'));
  const gridPath = path.join(tempDir, 'test-grid.png');

  try {
    const mockCandidates: XHotCandidate[] = [
      {
        index: 1,
        id: '12345',
        authorName: 'Tech Insider',
        authorHandle: '@techinsider',
        text: 'Anthropic announces Claude 3.7 with hybrid reasoning.',
        metrics: { replies: 120, reposts: 500, likes: 2500, views: 50000 },
        mediaUrls: [],
      },
      {
        index: 2,
        id: '12346',
        authorName: 'AI Daily',
        authorHandle: '@aidaily',
        text: 'DeepSeek-V3 open source weights benchmark report.',
        metrics: { replies: 300, reposts: 800, likes: 4500, views: 90000 },
        mediaUrls: [],
      },
      {
        index: 3,
        id: '12347',
        authorName: 'Open Research',
        authorHandle: '@openres',
        text: 'Sora video generation officially expanded to all users.',
        metrics: { replies: 50, reposts: 150, likes: 1200, views: 25000 },
        mediaUrls: [],
      },
      {
        index: 4,
        id: '12348',
        authorName: 'LLM Pulse',
        authorHandle: '@llmpulse',
        text: 'Llama 4 architecture preview and benchmark leaks.',
        metrics: { replies: 80, reposts: 210, likes: 1600, views: 32000 },
        mediaUrls: [],
      },
    ];

    const result = await buildXHotGrid({
      candidates: mockCandidates,
      outputPath: gridPath,
      maxGridDimension: 1200,
    });

    assert.ok(result.buffer && result.buffer.length > 0, 'Grid buffer must be non-empty');
    assert.equal(result.layout.columns, 2);
    assert.equal(result.layout.rows, 2);

    const exists = await fs.stat(gridPath).then(() => true).catch(() => false);
    assert.ok(exists, 'Grid image file should be written to disk');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('XHotEvalResultSchema validates evaluation format', { timeout: 5_000 }, () => {
  const sample = {
    query: 'new model',
    evaluatedAt: new Date().toISOString(),
    gridImagePath: '/path/to/grid.png',
    winner: {
      rank: 1,
      index: 1,
      id: 'tweet-01',
      name: 'Claude 3.7',
      summary: 'Breakthrough hybrid reasoning model released',
      reason: 'Overwhelming positive sentiment and high viral engagement on X',
    },
    topCandidates: [
      {
        rank: 1,
        index: 1,
        id: 'tweet-01',
        name: 'Claude 3.7',
        summary: 'Breakthrough hybrid reasoning model released',
        reason: 'Overwhelming positive sentiment and high viral engagement on X',
      },
      {
        rank: 2,
        index: 2,
        id: 'tweet-02',
        name: 'DeepSeek-V3',
        summary: 'Open source milestone',
        reason: 'Large community replication effort',
      },
      {
        rank: 3,
        index: 3,
        id: 'tweet-03',
        name: 'Sora Turbo',
        summary: 'Video model availability',
        reason: 'Stunning demo clips',
      },
    ],
    reasoning: 'Claude 3.7 dominated both tech metrics and visual appeal.',
  };

  const parsed = XHotEvalResultSchema.parse(sample);
  assert.equal(parsed.winner.name, 'Claude 3.7');
  assert.equal(parsed.topCandidates.length, 3);
});

test('isXLoggedIn detects auth_token cookie correctly', { timeout: 5_000 }, async () => {
  const fakeContext: any = {
    cookies: async () => [{ name: 'auth_token', value: '1234567890abcdef' }],
  };
  const loggedIn = await isXLoggedIn(fakeContext);
  assert.equal(loggedIn, true);

  const fakeContextNoAuth: any = {
    cookies: async () => [{ name: 'guest_id', value: '12345' }],
  };
  const notLoggedIn = await isXLoggedIn(fakeContextNoAuth);
  assert.equal(notLoggedIn, false);
});

test('isPromotedTweet identifies ads and promoted markers', { timeout: 5_000 }, async () => {
  const fakeAdElement: any = {
    evaluate: async (fn: any) => {
      const mockEl = {
        innerText: 'Best AI tool of 2026!\nAd\nSponsored by TechCorp',
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return fn(mockEl);
    },
  };
  const isAd = await isPromotedTweet(fakeAdElement);
  assert.equal(isAd, true, 'Tweet with isolated Ad line should be identified as ad');

  const fakeNormalElement: any = {
    evaluate: async (fn: any) => {
      const mockEl = {
        innerText: 'Anthropic just announced Claude 3.7 hybrid reasoning architecture.',
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return fn(mockEl);
    },
  };
  const isNormal = await isPromotedTweet(fakeNormalElement);
  assert.equal(isNormal, false, 'Organic tweet should not be flagged as ad');
});

test('executeXHotPipeline in dry-run mode completes all stages and produces reports', { timeout: 15_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhot-dryrun-'));
  try {
    const result = await executeXHotPipeline({
      query: 'test model',
      outDir: tempDir,
      dryRun: true,
      skipVideo: true,
    });

    assert.equal(result.query, 'test model');
    assert.equal(result.winner?.rank, 1);
    assert.ok(result.winner?.name.includes('test model'));
    assert.equal(result.topCandidates?.length, 3);

    const reportMdExists = await fs.stat(path.join(tempDir, 'report.md')).then(() => true).catch(() => false);
    const resultJsonExists = await fs.stat(path.join(tempDir, 'result.json')).then(() => true).catch(() => false);
    assert.ok(reportMdExists, 'report.md must be generated');
    assert.ok(resultJsonExists, 'result.json must be generated');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
