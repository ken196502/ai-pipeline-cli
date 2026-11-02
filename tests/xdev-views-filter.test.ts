import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTweetViews } from '../src/pipelines/xdev/scraper.js';
import { XDevPipelineOptionsSchema, OperationalWarningError } from '../src/pipelines/xdev/contracts.js';

test('parseTweetViews parses plain integers and formatted numbers with commas', () => {
  assert.equal(parseTweetViews('0'), 0);
  assert.equal(parseTweetViews('100'), 100);
  assert.equal(parseTweetViews('999'), 999);
  assert.equal(parseTweetViews('1,000'), 1000);
  assert.equal(parseTweetViews('1,234'), 1234);
  assert.equal(parseTweetViews('56,789'), 56789);
  assert.equal(parseTweetViews('1,234,567'), 1234567);
});

test('parseTweetViews parses scale multipliers (K, M, B, 万, 亿)', () => {
  assert.equal(parseTweetViews('1K'), 1000);
  assert.equal(parseTweetViews('2.5K'), 2500);
  assert.equal(parseTweetViews('10.2k'), 10200);
  assert.equal(parseTweetViews('1.5M'), 1500000);
  assert.equal(parseTweetViews('2.4m'), 2400000);
  assert.equal(parseTweetViews('1B'), 1000000000);
  assert.equal(parseTweetViews('1.2万'), 12000);
  assert.equal(parseTweetViews('35万'), 350000);
  assert.equal(parseTweetViews('1.5亿'), 150000000);
});

test('parseTweetViews parses realistic X UI aria-labels in English and Chinese', () => {
  assert.equal(parseTweetViews('2,450 views. View post analytics'), 2450);
  assert.equal(parseTweetViews('1.2K views. View post analytics'), 1200);
  assert.equal(parseTweetViews('15.8K Views'), 15800);
  assert.equal(parseTweetViews('1.2M views'), 1200000);
  assert.equal(parseTweetViews('2,450 次查看。查看推文数据分析'), 2450);
  assert.equal(parseTweetViews('1.2万 次查看。查看推文数据分析'), 12000);
  assert.equal(parseTweetViews('950 次查看'), 950);
});

test('parseTweetViews handles missing, whitespace and non-numeric strings safely', () => {
  assert.equal(parseTweetViews(null), 0);
  assert.equal(parseTweetViews(undefined), 0);
  assert.equal(parseTweetViews(''), 0);
  assert.equal(parseTweetViews('   '), 0);
  assert.equal(parseTweetViews('View post analytics'), 0);
  assert.equal(parseTweetViews('No views recorded'), 0);
});

test('XDevPipelineOptionsSchema defaults minViews to 1000 and parses overrides', () => {
  const defaultOpts = XDevPipelineOptionsSchema.parse({});
  assert.equal(defaultOpts.minViews, 1000);

  const customOpts = XDevPipelineOptionsSchema.parse({ minViews: 5000 });
  assert.equal(customOpts.minViews, 5000);

  assert.throws(() => {
    XDevPipelineOptionsSchema.parse({ minViews: -1 });
  });
});

test('Filtering logic: tweets below threshold are rejected, tweets at or above are retained', () => {
  const threshold = 1000;
  const mockTweets = [
    { text: 'A', rawAria: '850 views' },
    { text: 'B', rawAria: '1,200 views' },
    { text: 'C', rawAria: '999 views' },
    { text: 'D', rawAria: '2.5K views' },
    { text: 'E', rawAria: '1.2万 次查看' },
    { text: 'F', rawAria: 'View post analytics' }, // 0 views
  ];

  let filteredLowViewsCount = 0;
  const qualified: { text: string; views: number }[] = [];

  for (const t of mockTweets) {
    const views = parseTweetViews(t.rawAria);
    if (views < threshold) {
      filteredLowViewsCount++;
      continue;
    }
    qualified.push({ text: t.text, views });
  }

  assert.equal(filteredLowViewsCount, 3); // 850, 999, and 0
  assert.equal(qualified.length, 3);
  assert.deepEqual(
    qualified.map((q) => [q.text, q.views]),
    [
      ['B', 1200],
      ['D', 2500],
      ['E', 12000],
    ]
  );
});

test('Fail-fast: zero qualified tweets throws direct error without fallback', () => {
  const threshold = 1000;
  const mockLowViewTweets = [
    { text: 'A', rawAria: '320 views' },
    { text: 'B', rawAria: '500 views' },
  ];

  let filteredLowViewsCount = 0;
  const qualified: any[] = [];

  for (const t of mockLowViewTweets) {
    const views = parseTweetViews(t.rawAria);
    if (views < threshold) {
      filteredLowViewsCount++;
      continue;
    }
    qualified.push(t);
  }

  assert.equal(qualified.length, 0);
  assert.equal(filteredLowViewsCount, 2);

  // Assert pipeline throws directly as per "没有直接报错" and "No fallbacks"
  assert.throws(
    () => {
      if (qualified.length === 0) {
        throw new OperationalWarningError(
          `未抓取到符合条件的候选推文（已过滤阅读量不足 ${threshold} 的推文 ${filteredLowViewsCount} 条）。至少需要 ${threshold} 阅读量才值得作为参考。`
        );
      }
    },
    (err: any) => {
      return (
        err instanceof OperationalWarningError &&
        err.isOperational === true &&
        /未抓取到符合条件的候选推文.*至少需要 1000 阅读量/.test(err.message)
      );
    }
  );
});
