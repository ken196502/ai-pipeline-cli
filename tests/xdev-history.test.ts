import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { tweetIdFromUrl, splitByHistory, formatHistoryForPrompt } from '../src/pipelines/xdev/history.js';
import { validateArticleBody, buildArticleMaterial } from '../src/pipelines/xdev/analyzer.js';

test('tweetIdFromUrl extracts the numeric status id', () => {
  assert.equal(tweetIdFromUrl('https://x.com/foo/status/2116743337697026369'), '2116743337697026369');
  assert.equal(tweetIdFromUrl('https://twitter.com/foo/statuses/123?s=20'), '123');
  assert.equal(tweetIdFromUrl('https://x.com/foo'), null);
  assert.equal(tweetIdFromUrl(''), null);
  assert.equal(tweetIdFromUrl(undefined), null);
});

test('splitByHistory drops tweets already used in a previous run', () => {
  const history = [
    {
      runId: '2026-11-01T04-31-25-888Z',
      articleTitle: 'A',
      tweetUrls: ['https://x.com/aaron/status/111'],
      topicTitles: ['旧议题'],
    },
    {
      runId: '2026-11-01T03-05-50-460Z',
      articleTitle: 'B',
      tweetUrls: ['https://x.com/bob/status/222'],
      topicTitles: ['另一个旧议题'],
    },
  ];

  const tweets = [
    { url: 'https://x.com/aaron/status/111', text: 'repeat' },
    { url: 'https://x.com/carol/status/333', text: 'fresh' },
    { url: 'https://x.com/bob/status/222', text: 'repeat2' },
    { url: 'https://x.com/dave/status/444', text: 'fresh2' },
  ];

  const { fresh, repeated } = splitByHistory(tweets, history);

  assert.deepEqual(
    fresh.map((t) => t.text),
    ['fresh', 'fresh2']
  );
  assert.deepEqual(
    repeated.map((r) => [r.tweet.text, r.previousRunId, r.previousTopic]),
    [
      ['repeat', '2026-11-01T04-31-25-888Z', '旧议题'],
      ['repeat2', '2026-11-01T03-05-50-460Z', '另一个旧议题'],
    ]
  );
});

test('splitByHistory keeps everything when there is no history', () => {
  const tweets = [{ url: 'https://x.com/a/status/1' }, { url: 'https://x.com/b/status/2' }];
  const { fresh, repeated } = splitByHistory(tweets, []);
  assert.equal(fresh.length, 2);
  assert.equal(repeated.length, 0);
});

test('formatHistoryForPrompt is prompt-ready and says so when empty', () => {
  assert.match(formatHistoryForPrompt([]), /无历史记录/);

  const text = formatHistoryForPrompt([
    {
      runId: '2026-11-01T04-31-25-888Z',
      articleTitle: '标题X',
      tweetUrls: ['https://x.com/a/status/1'],
      topicTitles: ['议题X'],
    },
  ]);
  assert.match(text, /标题X/);
  assert.match(text, /议题X/);
});

test('validateArticleBody blocks hallucinated Anthropic text when absent in material', () => {
  const material = '推文讨论 DeepSeek 团队的 Multi-Agent 通信机制';
  const body = `# 测试标题\n\n正文一...\n\n结合 Anthropic 的官方基准...`;

  const issues = validateArticleBody(body, material);
  assert.ok(issues.some((i) => i.includes('Anthropic')));
});

test('validateArticleBody blocks empty or trivial content', () => {
  const material = '测试素材';
  const issues = validateArticleBody('太短', material);
  assert.ok(issues.some((i) => i.includes('过少或为空')));
});

test('validateArticleBody blocks excessive "不是……而是……" false dichotomy patterns', () => {
  const material = '关于多智能体审查流程的讨论';
  const body = `# 规范化协作协议

这一机制的核心价值在于流程约束。它解决的不是代码质量，而是协作协议失效。
在实际运行中，这并非单点优化，而是整个链路的闭环重试。
同时我们注意到，Tuck 不是收到模糊反馈，而是获得明确清单。
这种模式为系统提供了确定性。`;

  const issues = validateArticleBody(body, material);
  assert.ok(issues.some((i) => i.includes('不是…而是…')));
});


test('validateArticleBody blocks vague pain-point assertions like “痛点很直接。”', () => {
  const material = '关于多智能体审查流程的讨论';
  const body = `# 多智能体的状态治理

多个 Agent 同时改同一分支时，客户端各自维护状态，冲突会不断累积。

## 共享工作区的代价

痛点很直接。

## 机制推导

状态分叉后无法回滚，重试会放大上下文污染。

## 工程启示

把状态收敛到服务端才能止血。`;

  const issues = validateArticleBody(body, material);
  assert.ok(issues.some((i) => i.includes('谜语式空断言')));
});

test('validateArticleBody allows pain points that name the concrete failure', () => {
  const material = '关于多智能体审查流程的讨论';
  const body = `# 多智能体的状态治理

多个 Agent 同时改同一分支时，客户端各自维护状态，冲突会不断累积。

## 共享工作区的代价

这里的痛点很直接：三个 Agent 共用一个分支，每次重试都要重放历史，冲突率直接翻倍。

## 机制推导

状态分叉后无法回滚，重试会放大上下文污染。

## 工程启示

把状态收敛到服务端才能止血。`;

  const issues = validateArticleBody(body, material);
  assert.ok(!issues.some((i) => i.includes('谜语式空断言')));
});
