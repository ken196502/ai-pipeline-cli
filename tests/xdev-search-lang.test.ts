import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchQuery } from '../src/pipelines/xdev/scraper.js';

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
