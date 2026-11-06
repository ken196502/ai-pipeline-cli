import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchQuery } from '../src/pipelines/xdev/scraper.js';
import { XDevPipelineOptionsSchema } from '../src/pipelines/xdev/contracts.js';
import {
  buildXSearchUrl,
  isCjkDominated,
  parseSearchLangOption,
} from '../src/libs/text/search-query.js';

describe('normalizeSearchQuery', () => {
  test('appends lang:en when the helper is asked for it', () => {
    assert.equal(normalizeSearchQuery('Agent system'), 'Agent system lang:en');
    assert.equal(normalizeSearchQuery('Agent orchestration'), 'Agent orchestration lang:en');
  });

  test('does not duplicate an existing lang operator', () => {
    assert.equal(normalizeSearchQuery('Agent system lang:en'), 'Agent system lang:en');
    assert.equal(normalizeSearchQuery('"AI agent" lang:en'), '"AI agent" lang:en');
  });

  test('preserves a custom language', () => {
    assert.equal(normalizeSearchQuery('Agent system lang:zh'), 'Agent system lang:zh');
    assert.equal(normalizeSearchQuery('Agent system lang:ja'), 'Agent system lang:ja');
  });

  test('leaves the query untouched when lang is null', () => {
    assert.equal(normalizeSearchQuery('Agent system', { lang: null }), 'Agent system');
  });

  test('handles whitespace', () => {
    assert.equal(normalizeSearchQuery('  Agent workflow  '), 'Agent workflow lang:en');
    assert.equal(normalizeSearchQuery(''), '');
  });
});

describe('xdev search language option', () => {
  test('default is NO language operator (X drops top-ranked posts under lang:en)', () => {
    // A/B measured 2026-11-06 on the live Top feed:
    //   q=Agent system            → DeepSeekHarness/2116857257245987236 at #1
    //   q=Agent system lang:en    → that same post is absent from the feed
    assert.equal(XDevPipelineOptionsSchema.parse({}).searchLang, null);
    assert.equal(XDevPipelineOptionsSchema.parse({ searchLang: 'en' }).searchLang, 'en');
  });

  test('"none" disables the operator, explicit codes pass through', () => {
    assert.equal(parseSearchLangOption('none'), null);
    assert.equal(parseSearchLangOption('off'), null);
    assert.equal(parseSearchLangOption('false'), null);
    assert.equal(parseSearchLangOption('en'), 'en');
    assert.equal(parseSearchLangOption('zh'), 'zh');
  });

  test('buildXSearchUrl omits the operator when lang is null', () => {
    assert.equal(
      buildXSearchUrl('Agent system', 'top', null),
      'https://x.com/search?q=Agent%20system&f=top'
    );
    assert.equal(
      buildXSearchUrl('Agent system', 'top', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Aen&f=top'
    );
    assert.equal(
      buildXSearchUrl('Agent system lang:zh', 'live', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Azh&f=live'
    );
  });
});

describe('CJK backstop (only active with --search-lang en)', () => {
  test('drops Chinese bodies', () => {
    assert.equal(isCjkDominated('别学 subagent 了，现在都玩单 Agent + Main Loop 了。'), true);
    assert.equal(isCjkDominated('为 Agent 打造一个 Skill 学习网络'), true);
  });

  test('keeps English bodies and mixed ones below the threshold', () => {
    assert.equal(isCjkDominated('Google just released a free 2-hour course on agent engineering'), false);
    assert.equal(isCjkDominated('Agent 系统'), true);
  });

  test('image/video-only tweets (empty text) are never dropped', () => {
    assert.equal(isCjkDominated(''), false);
    assert.equal(isCjkDominated('   '), false);
    assert.equal(isCjkDominated('🤖🚀'), false);
  });
});
