import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchQuery } from '../src/pipelines/xdev/scraper.js';
import {
  buildXSearchUrl,
  isCjkDominated,
  parseSearchLangOption,
} from '../src/libs/text/search-query.js';
import {
  buildXSearchUrl,
  isCjkDominated,
  parseSearchLangOption,
} from '../src/libs/text/search-query.js';

describe('normalizeSearchQuery', () => {
  test('should append lang:en to keywords by default', () => {
    assert.equal(normalizeSearchQuery('Agent system'), 'Agent system lang:en');
    assert.equal(normalizeSearchQuery('Agent orchestration'), 'Agent orchestration lang:en');
  });

  test('should not duplicate lang:en if already present', () => {
    assert.equal(normalizeSearchQuery('Agent system lang:en'), 'Agent system lang:en');
    assert.equal(normalizeSearchQuery('"AI agent" lang:en'), '"AI agent" lang:en');
  });

  test('should preserve custom language if explicitly specified', () => {
    assert.equal(normalizeSearchQuery('Agent system lang:zh'), 'Agent system lang:zh');
    assert.equal(normalizeSearchQuery('Agent system lang:ja'), 'Agent system lang:ja');
  });

  test('should handle whitespace properly', () => {
    assert.equal(normalizeSearchQuery('  Agent workflow  '), 'Agent workflow lang:en');
    assert.equal(normalizeSearchQuery(''), '');
  });
});

describe('xdev search language option', () => {
  test('defaults to lang:en and can be disabled', () => {
    assert.equal(parseSearchLangOption(undefined), 'en');
    assert.equal(parseSearchLangOption('en'), 'en');
    assert.equal(parseSearchLangOption('zh'), 'zh');
    assert.equal(parseSearchLangOption('none'), null);
    assert.equal(parseSearchLangOption('off'), null);
    assert.equal(parseSearchLangOption('false'), null);
  });

  test('buildXSearchUrl applies the language operator to the Top feed', () => {
    assert.equal(
      buildXSearchUrl('Agent system', 'top', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Aen&f=top'
    );
    assert.equal(
      buildXSearchUrl('Agent system', 'live', null),
      'https://x.com/search?q=Agent%20system&f=live'
    );
  });

  test('buildXSearchUrl never duplicates an explicit lang: operator', () => {
    assert.equal(
      buildXSearchUrl('Agent system lang:zh', 'top', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Azh&f=top'
    );
  });
});

describe('CJK backstop used by the xdev sweep', () => {
  test('drops Chinese bodies', () => {
    assert.equal(isCjkDominated('别学 subagent 了，现在都玩单 Agent + Main Loop 了。'), true);
    assert.equal(isCjkDominated('为 Agent 打造一个 Skill 学习网络'), true);
  });

  test('keeps English bodies, including mixed-script ones below the threshold', () => {
    assert.equal(isCjkDominated('Google just released a free 2-hour course on agent engineering'), false);
    assert.equal(isCjkDominated('Agent 系统'), true);
  });

  test('image/video-only tweets (empty text) are never dropped', () => {
    assert.equal(isCjkDominated(''), false);
    assert.equal(isCjkDominated('   '), false);
    assert.equal(isCjkDominated('🤖🚀'), false);
  });
});

describe('xdev search language option', () => {
  test('defaults to lang:en and can be disabled', () => {
    assert.equal(parseSearchLangOption(undefined), 'en');
    assert.equal(parseSearchLangOption('en'), 'en');
    assert.equal(parseSearchLangOption('zh'), 'zh');
    assert.equal(parseSearchLangOption('none'), null);
    assert.equal(parseSearchLangOption('off'), null);
    assert.equal(parseSearchLangOption('false'), null);
  });

  test('buildXSearchUrl applies the language operator to the Top feed', () => {
    assert.equal(
      buildXSearchUrl('Agent system', 'top', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Aen&f=top'
    );
    assert.equal(
      buildXSearchUrl('Agent system', 'live', null),
      'https://x.com/search?q=Agent%20system&f=live'
    );
  });

  test('buildXSearchUrl never duplicates an explicit lang: operator', () => {
    assert.equal(
      buildXSearchUrl('Agent system lang:zh', 'top', 'en'),
      'https://x.com/search?q=Agent%20system%20lang%3Azh&f=top'
    );
  });
});

describe('CJK backstop used by the xdev sweep', () => {
  test('drops Chinese bodies', () => {
    assert.equal(isCjkDominated('别学 subagent 了，现在都玩单 Agent + Main Loop 了。'), true);
    assert.equal(isCjkDominated('为 Agent 打造一个 Skill 学习网络'), true);
  });

  test('keeps English bodies, including mixed-script ones below the threshold', () => {
    assert.equal(isCjkDominated('Google just released a free 2-hour course on agent engineering'), false);
    assert.equal(isCjkDominated('Agent 系统'), true);
  });

  test('image/video-only tweets (empty text) are never dropped', () => {
    assert.equal(isCjkDominated(''), false);
    assert.equal(isCjkDominated('   '), false);
    assert.equal(isCjkDominated('🤖🚀'), false);
  });
});
