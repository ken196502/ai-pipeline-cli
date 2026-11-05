import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSearchQuery,
  buildXSearchUrl,
  parseSearchLangOption,
  cjkRatio,
  isCjkDominated,
} from '../src/libs/text/search-query.js';

test('normalizeSearchQuery appends lang:en by default', () => {
  assert.equal(normalizeSearchQuery('AI agents'), 'AI agents lang:en');
  assert.equal(normalizeSearchQuery('  deepseek r1  '), 'deepseek r1 lang:en');
});

test('normalizeSearchQuery never duplicates an existing lang modifier', () => {
  assert.equal(normalizeSearchQuery('AI agents lang:en'), 'AI agents lang:en');
  assert.equal(normalizeSearchQuery('AI agents lang:zh'), 'AI agents lang:zh');
  assert.equal(normalizeSearchQuery('"AI agent" LANG:JA'), '"AI agent" LANG:JA');
});

test('normalizeSearchQuery honours an explicit lang option', () => {
  assert.equal(normalizeSearchQuery('AI agents', { lang: 'zh' }), 'AI agents lang:zh');
});

test('normalizeSearchQuery disables the filter when lang is null/empty', () => {
  assert.equal(normalizeSearchQuery('AI 智能体', { lang: null }), 'AI 智能体');
  assert.equal(normalizeSearchQuery('AI 智能体', { lang: '' }), 'AI 智能体');
  assert.equal(normalizeSearchQuery('AI 智能体', { lang: '   ' }), 'AI 智能体');
});

test('normalizeSearchQuery returns empty input untouched', () => {
  assert.equal(normalizeSearchQuery(''), '');
  assert.equal(normalizeSearchQuery('   '), '');
});

test('buildXSearchUrl encodes the lang-restricted query for each feed tab', () => {
  assert.equal(
    buildXSearchUrl('AI agents', 'top'),
    'https://x.com/search?q=AI%20agents%20lang%3Aen&f=top'
  );
  assert.equal(
    buildXSearchUrl('AI agents', 'live', 'zh'),
    'https://x.com/search?q=AI%20agents%20lang%3Azh&f=live'
  );
  assert.equal(
    buildXSearchUrl('AI agents', 'top', null),
    'https://x.com/search?q=AI%20agents&f=top'
  );
});

test('buildXSearchUrl keeps a query that already carries lang:en', () => {
  assert.equal(
    buildXSearchUrl('AI agents lang:en', 'top'),
    'https://x.com/search?q=AI%20agents%20lang%3Aen&f=top'
  );
});

test('parseSearchLangOption maps CLI values', () => {
  assert.equal(parseSearchLangOption(undefined), 'en');
  assert.equal(parseSearchLangOption(''), 'en');
  assert.equal(parseSearchLangOption('EN'), 'en');
  assert.equal(parseSearchLangOption('zh'), 'zh');
  assert.equal(parseSearchLangOption('none'), null);
  assert.equal(parseSearchLangOption('OFF'), null);
});

test('cjkRatio measures the CJK share of non-space characters', () => {
  assert.equal(cjkRatio(''), 0);
  assert.equal(cjkRatio('   '), 0);
  assert.equal(cjkRatio('OpenAI ships a new model'), 0);
  assert.equal(cjkRatio('OpenAI 发布了新模型'), 6 / 12);
  assert.equal(cjkRatio('纯中文正文'), 1);
  // Emoji / punctuation are not CJK ideographs.
  assert.equal(cjkRatio('🚀🔥'), 0);
});

test('isCjkDominated flags Chinese bodies but keeps image-only tweets', () => {
  assert.equal(isCjkDominated(''), false);
  assert.equal(isCjkDominated('OpenAI ships a new model'), false);
  assert.equal(isCjkDominated('OpenAI 发布了新模型，据说是 GPT-6.2'), true);
  // A stray CJK author name inside an English body stays below the threshold.
  assert.equal(
    isCjkDominated('OpenAI GPT-6.2 leaks via 张三 and two other sources, huge release expected soon'),
    false
  );
  assert.equal(isCjkDominated('OpenAI 发布了新模型', 0.9), false);
});
