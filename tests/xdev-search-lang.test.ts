import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isEnglishListText, normalizeSearchQuery } from '../src/pipelines/xdev/scraper.js';
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

describe('xdev search: no lang: operator in the query', () => {
  test('the scraper builds the search URL without any lang: operator', () => {
    // X's lang filter drops top-ranked posts: `q=Agent system lang:en` hides the
    // #1 result (DeepSeekHarness/2116857257245987236) that plain `q=Agent system`
    // still returns at #1. So the pipeline never sends lang: to X.
    assert.equal(
      buildXSearchUrl('Agent system', 'top', null),
      'https://x.com/search?q=Agent%20system&f=top'
    );
    assert.equal(
      buildXSearchUrl('Agent system', 'live', null),
      'https://x.com/search?q=Agent%20system&f=live'
    );
  });

  test('the language option survives for other pipelines (xhot)', () => {
    assert.equal(parseSearchLangOption('en'), 'en');
    assert.equal(parseSearchLangOption('none'), null);
    assert.equal(
      buildXSearchUrl('Agent system', 'top', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Aen&f=top'
    );
  });
});

describe('xdev search: only English rows enter the candidate pool', () => {
  test('Chinese rows are rejected on the result-list text', () => {
    assert.equal(isEnglishListText('别学 subagent 了，现在都玩单 Agent + Main Loop 了。'), false);
    assert.equal(isEnglishListText('为 Agent 打造一个 Skill 学习网络'), false);
  });

  test('English rows pass — including long-form posts whose article body is Chinese', () => {
    // The DeepSeek post is an X Article: English preview text, Chinese original
    // body. It must survive the list filter (that was the whole point).
    assert.equal(
      isEnglishListText('Exploring Super-agent Design: Towards a More Autonomous Agent System'),
      true
    );
    assert.equal(isEnglishListText('Google just released a free 2-hour course on agent engineering'), true);
  });

  test('image/video-only rows (empty text) are never dropped', () => {
    assert.equal(isEnglishListText(''), true);
    assert.equal(isEnglishListText('   '), true);
    assert.equal(isEnglishListText('🤖🚀'), true);
  });
});

describe('CJK detection used by the list filter', () => {
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
