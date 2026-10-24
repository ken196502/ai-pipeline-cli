import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  extractNameTokens,
  verifyWinnerName,
} from '../src/modules/evaluation/winner-name-check.js';

test('normalizeName keeps alnum + CJK, drops punctuation and case', () => {
  assert.equal(normalizeName('Claude/Fable 3.5'), 'claudefable35');
  assert.equal(normalizeName('DeepSeek-V3'), 'deepseekv3');
  assert.equal(normalizeName('Claude（克劳德）'), 'claude克劳德');
});

test('extractNameTokens splits on structural separators and drops generic words', () => {
  assert.deepEqual(
    extractNameTokens('Anthropic New Model (Claude/Fable)'),
    ['anthropic', 'claude', 'fable']
  );
  assert.deepEqual(extractNameTokens('DeepSeek-V3'), ['deepseek', 'v3']);
  assert.deepEqual(extractNameTokens('Kimi K3 (月之暗面 Moonshot AI)'), [
    'kimi',
    'k3',
    '月之暗面',
    'moonshot',
  ]);
  assert.deepEqual(extractNameTokens('Gemini 3 / Gemini 3 Pro'), [
    'gemini',
    '3',
    'pro',
  ]);
});

test('fully generic name yields no content tokens and is not applicable', () => {
  const r = verifyWinnerName({
    name: 'new model',
    tweetText: 'Anthropic is preparing a new AI model',
  });
  assert.equal(r.tokens.length, 0);
  assert.equal(r.strategy, 'no-content-tokens');
  assert.equal(r.applicable, false);
  assert.equal(r.matches, true);
});

test('REGRESSION: cluster name with parenthetical aliases matches via all-tokens', () => {
  // The exact failure: winner name synthesized from a 6-tweet cluster, anchored to
  // a representative tweet that only mentions Anthropic + Fable.
  const r = verifyWinnerName({
    name: 'Anthropic New Model (Claude/Fable)',
    tweetText:
      'Anthropic is preparing a new AI model that can better infer what users are trying to accomplish.',
    extraHaystacks: [
      'Claude Duet, Fable 5.1, Fable 5.5 circulating across multiple sources (Fable 5.5 by Salio, Claude Duet by Alex Finn)',
    ],
  });
  assert.equal(r.strategy, 'all-tokens');
  assert.equal(r.matches, true);
  assert.deepEqual(r.missingTokens, []);
});

test('exact contiguous match still reports strategy=exact', () => {
  const r = verifyWinnerName({
    name: 'DeepSeek-V3',
    tweetText: 'DeepSeek-V3 is now open source.',
  });
  assert.equal(r.strategy, 'exact');
  assert.equal(r.matches, true);
});

test('partial grounding is reported via single-token strategy', () => {
  // 'rumor' is generic so it is dropped; fable+5.5 both present -> all-tokens.
  const r = verifyWinnerName({
    name: 'Fable 5.5 (rumor)',
    tweetText: 'Salio says Fable 5.5 is imminent.',
  });
  assert.equal(r.matches, true);
  assert.equal(r.strategy, 'all-tokens');
  assert.deepEqual(r.missingTokens, []);
});

test('single strong token suffices when no long token is missing (tweet-only)', () => {
  // "Fable 5.5 Supremum" - 'supremum' is missing and no cluster context is
  // available, so the partly-invented label must still be rejected.
  const r = verifyWinnerName({
    name: 'Fable 5.5 Supremum',
    tweetText: 'Salio says Fable 5.5 is imminent.',
  });
  assert.equal(r.matches, false);
  assert.ok(r.missingTokens.includes('supremum'));
});

test('cluster context allows partial grounding', () => {
  const r = verifyWinnerName({
    name: 'Fable 5.5 Supremum',
    tweetText: 'Salio says Fable 5.5 is imminent.',
    extraHaystacks: ['Siblings discuss Claude Duet and Fable releases.'],
  });
  assert.equal(r.matches, true);
  assert.equal(r.strategy, 'single-token');
});

test('genuinely hallucinated concrete entity still fails', () => {
  const r = verifyWinnerName({
    name: 'Llama 4 Maverick',
    tweetText: 'Anthropic is preparing a new AI model.',
  });
  assert.equal(r.matches, false);
  assert.ok(r.missingTokens.includes('llama'));
  assert.ok(r.missingTokens.includes('maverick'));
});

test('hallucination is rejected even when the reasoning field is polluted', () => {
  const r = verifyWinnerName({
    name: 'Grok 5 Super Reasoner',
    tweetText: 'Anthropic is preparing a new AI model.',
    extraHaystacks: ['Unrelated commentary about shipping cadence.'],
  });
  assert.equal(r.matches, false);
});

test('CJK names are matched whole', () => {
  const r = verifyWinnerName({
    name: '月之暗面 Kimi K3',
    tweetText: '月之暗面发布了 Kimi K3，推理能力大幅提升。',
  });
  assert.equal(r.matches, true);
});

test('author handle can ground the name when tweet text is terse', () => {
  const r = verifyWinnerName({
    name: 'OpenRouter',
    tweetText: 'New release is live now.',
    extraHaystacks: ['@OpenRouter'],
  });
  assert.equal(r.matches, true);
});

test('empty tweet text with a concrete name still fails (not silently waived)', () => {
  const r = verifyWinnerName({
    name: 'Gemini 3',
    tweetText: '',
  });
  assert.equal(r.matches, false);
});