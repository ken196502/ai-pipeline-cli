import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_WEIGHT,
  VIEW_WEIGHT,
  rankCandidates,
  viewScoreOf,
  type CandidateScore,
} from '../src/pipelines/xdev/analyzer.js';
import type { ExtractedTweet } from '../src/pipelines/xdev/contracts.js';

function tweet(views: number, handle = '@x'): ExtractedTweet {
  return {
    id: String(views),
    url: `https://x.com/${handle}/status/${views}`,
    authorName: handle,
    authorHandle: handle,
    text: 'text',
    views,
    externalLinks: [],
    blogs: [],
    isMultiAgentRelated: true,
  };
}

function score(index: number, value: number): CandidateScore {
  return { index, score: value, verdictZh: '' };
}

test('weights are content 50% + views 50%', () => {
  assert.equal(CONTENT_WEIGHT + VIEW_WEIGHT, 1);
  assert.equal(VIEW_WEIGHT, 0.5);
});

test('view score is log-scaled against the batch maximum', () => {
  assert.equal(viewScoreOf(3_190_536, 3_190_536), 100);
  assert.equal(viewScoreOf(0, 3_190_536), 0);
  // 25k views against a 3.19M max ≈ 68, not ≈ 1 (linear scaling would flatten it)
  const mid = viewScoreOf(25_000, 3_190_536);
  assert.ok(mid > 60 && mid < 75, `expected ~68, got ${mid}`);
  // ordering is preserved and monotonic
  assert.ok(viewScoreOf(1_000_000, 3_190_536) > viewScoreOf(100_000, 3_190_536));
});

test('the 3.19M-view post beats an 88-point post with 25k views', () => {
  // The real numbers from 2026-11-06: the top-viewed candidate (DeepSeekHarness,
  // 3,190,536 views) scored 65 on content and lost to an 88-point post with
  // 25,973 views — until views were weighted.
  const tweets = [tweet(3_190_536, '@DeepSeekHarness'), tweet(25_973, '@StackDhruv')];
  const ranking = rankCandidates(tweets, [score(0, 65), score(1, 88)]);

  assert.equal(ranking[0].index, 0);
  assert.ok(ranking[0].finalScore > ranking[1].finalScore);
  assert.ok(ranking[0].viewScore > ranking[1].viewScore);
});

test('content still gates quality: a 3.19M-view ad at 0 points is excluded', () => {
  const tweets = [tweet(3_190_536, '@shiller'), tweet(12_000, '@solid')];
  const ranking = rankCandidates(tweets, [score(0, 0), score(1, 80)]);
  assert.deepEqual(ranking.map((r) => r.index), [1]);
});

test('a viral but weak post still loses to a strong, moderately seen one', () => {
  // 3.19M views, content 30 => 15 + 50 = 65
  // 400k views, content 92  => 46 + 43.5 = 89.5
  const tweets = [tweet(3_190_536, '@viral'), tweet(400_000, '@solid')];
  const ranking = rankCandidates(tweets, [score(0, 30), score(1, 92)]);
  assert.equal(ranking[0].index, 1);
});

test('unscored candidates are left out instead of being treated as zero', () => {
  const tweets = [tweet(3_000_000, '@a'), tweet(5_000, '@b'), tweet(9_000_000, '@c')];
  const ranking = rankCandidates(tweets, [score(0, 70), score(1, 60)]);
  assert.deepEqual(ranking.map((r) => r.index).sort(), [0, 1]);
});

test('weights are configurable without touching the call sites', () => {
  const tweets = [tweet(3_190_536, '@DeepSeekHarness'), tweet(25_973, '@StackDhruv')];
  const contentOnly = rankCandidates(tweets, [score(0, 65), score(1, 88)], { content: 1, views: 0 });
  assert.equal(contentOnly[0].index, 1);
});
