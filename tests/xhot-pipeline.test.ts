import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  XHOT_STAGES,
  XHotPipelineOptionsSchema,
  executeXHotPipeline,
  generateFinalReportMarkdown,
  generateFinalReportJson,
  saveFinalReports,
  printExecutiveSummary,
  type XHotFullResult,
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
  assert.equal(parsed.explainerEngine, 'chromium');
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
    const finalReportMdExists = await fs.stat(path.join(tempDir, 'FINAL_REPORT.md')).then(() => true).catch(() => false);
    const finalReportHtmlExists = await fs.stat(path.join(tempDir, 'FINAL_REPORT.html')).then(() => true).catch(() => false);
    const finalReportJsonExists = await fs.stat(path.join(tempDir, 'final-report.json')).then(() => true).catch(() => false);

    assert.ok(reportMdExists, 'report.md must be generated');
    assert.ok(resultJsonExists, 'result.json must be generated');
    assert.ok(finalReportMdExists, 'FINAL_REPORT.md must be generated');
    assert.ok(finalReportHtmlExists, 'FINAL_REPORT.html must be generated');
    assert.ok(finalReportJsonExists, 'final-report.json must be generated');

    assert.equal(result.reportMarkdownPath, path.join(tempDir, 'FINAL_REPORT.md'));
    assert.equal(result.reportHtmlPath, path.join(tempDir, 'FINAL_REPORT.html'));
    assert.equal(result.reportJsonPath, path.join(tempDir, 'final-report.json'));

    const htmlContent = await fs.readFile(path.join(tempDir, 'FINAL_REPORT.html'), 'utf-8');
    assert.ok(/<!doctype html>/i.test(htmlContent), 'HTML report must have doctype');
    assert.ok(htmlContent.includes('Xhot Pipeline Report'), 'HTML report must include title');
    assert.ok(htmlContent.includes('Executive Summary'), 'HTML report must include Executive Summary');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('generateFinalReportMarkdown and saveFinalReports generate full VideoGen-style reports', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhot-full-report-'));
  try {
    const mockResult: XHotFullResult = {
      runId: 'xhot-test-run-123',
      pipelineId: 'xhot',
      query: 'AI agents 2026',
      outDir: tempDir,
      startedAt: '2026-10-22T10:00:00.000Z',
      completedAt: '2026-10-22T10:08:30.000Z',
      totalDurationMs: 510000,
      winner: {
        rank: 1,
        index: 1,
        id: 'c-1',
        name: 'AutoAgent Pro',
        summary: 'Autonomous coding agent released',
        reason: 'Most significant technical discussion',
      },
      topCandidates: [
        { rank: 1, index: 1, id: 'c-1', name: 'AutoAgent Pro', summary: 'Autonomous coding agent released', reason: 'Most significant technical discussion' },
        { rank: 2, index: 2, id: 'c-2', name: 'FastReasoner', summary: '10x faster reasoning', reason: 'Strong community engagement' },
        { rank: 3, index: 3, id: 'c-3', name: 'OmniVision 3', summary: 'Open source multimodal model', reason: 'High reposts and benchmark scores' },
      ],
      gridImagePath: path.join(tempDir, 'xhot-grid.png'),
      harvestResult: {
        materialsDir: path.join(tempDir, 'materials'),
        harvestedMediaCount: 3,
        items: [
          {
            tweetId: 't-1',
            text: 'AutoAgent Pro released with full sandbox capability',
            authorName: 'Tech Insiders',
            authorHandle: 'tech_insiders',
            mediaFiles: [
              { kind: 'image', localPath: 'p1.jpg' },
              { kind: 'video', localPath: 'v1.mp4' },
            ],
            asrTranscript: 'This changes agentic workflows completely.',
          },
        ],
        topicName: 'AutoAgent Pro',
      },
      explainer: {
        videoPath: path.join(tempDir, 'explainer', 'explainer-video.mp4'),
        playerPath: path.join(tempDir, 'explainer', 'index.html'),
        storyboardPath: path.join(tempDir, 'explainer', 'storyboard.json'),
        narrationPath: path.join(tempDir, 'explainer', 'narration.mp3'),
        totalDurationSec: 45.2,
        fps: 30,
        resolution: { width: 1080, height: 1920 },
        sceneCount: 4,
        voice: 'zh-CN-YunxiNeural',
        rate: '+5%',
        framesRendered: 1356,
      },
      stages: {
        'check-env': { stage: 'check-env', status: 'completed', durationMs: 1200, summary: 'Environment verified' },
        'x-login': { stage: 'x-login', status: 'completed', durationMs: 4500, summary: 'Persistent X login active' },
        'x-search': { stage: 'x-search', status: 'completed', durationMs: 15000, summary: '12 candidates captured' },
        'x-eval': { stage: 'x-eval', status: 'completed', durationMs: 8000, summary: 'Top 3 ranked' },
        'x-harvest': { stage: 'x-harvest', status: 'completed', durationMs: 12000, summary: '1 tweet, 3 media files harvested' },
        'x-video': { stage: 'x-video', status: 'completed', durationMs: 30000, summary: 'Explainer video rendered' },
        'report': { stage: 'report', status: 'completed', durationMs: 500, summary: 'Reports saved' },
      },
      envCheck: {
        llmConfigured: true,
        llmEndpoint: 'https://ai.reluv.xyz/v1',
        llmModel: 'glm-5.3-flash',
        vlModel: 'nemotron-3.5-super-vl',
        chromiumInstalled: true,
        chromiumPath: '/usr/bin/chromium',
        chromiumVersion: '130.0.0.0',
        ytDlpInstalled: true,
        ytDlpPath: '/usr/local/bin/yt-dlp',
        ffmpegInstalled: true,
        profileDir: '/tmp/test-profile',
        puterAsrConfigured: true,
      },
    };

    const md = generateFinalReportMarkdown(mockResult);
    assert.ok(md.includes('# 🔥 Xhot Trending Video Generation Pipeline Report'));
    assert.ok(md.includes('AutoAgent Pro'));
    assert.ok(md.includes('This changes agentic workflows completely.'));
    assert.ok(md.includes('Puter ASR Speech Transcription'));
    assert.ok(md.includes('Pipeline Execution Stages'));
    assert.ok(md.includes('Artifact Manifest'));

    const json = generateFinalReportJson(mockResult);
    assert.ok(json.includes('"xhot-test-run-123"'));

    const saved = await saveFinalReports(mockResult, tempDir);
    assert.equal(saved.markdownPath, path.join(tempDir, 'FINAL_REPORT.md'));
    assert.equal(saved.htmlPath, path.join(tempDir, 'FINAL_REPORT.html'));
    assert.equal(saved.jsonPath, path.join(tempDir, 'final-report.json'));

    const html = await fs.readFile(saved.htmlPath, 'utf-8');
    assert.ok(/<!doctype html>/i.test(html), 'HTML report must have doctype');
    assert.ok(html.includes('AutoAgent Pro'));
    assert.ok(html.includes('Executive Summary'));

    // Test printExecutiveSummary doesn't throw
    printExecutiveSummary(mockResult);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
