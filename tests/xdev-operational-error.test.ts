import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OperationalWarningError } from '../src/pipelines/xdev/contracts.js';

test('OperationalWarningError carries isOperational flag and name', () => {
  const err = new OperationalWarningError('At least 1000 views required');
  assert.equal(err.isOperational, true);
  assert.equal(err.name, 'OperationalWarningError');
  assert.equal(err.message, 'At least 1000 views required');
  assert.ok(err instanceof Error);
});

test('Operational error classifier distinguishes non-bug data conditions from bugs', () => {
  const isOperationalError = (err: any) =>
    err?.isOperational === true ||
    err instanceof OperationalWarningError ||
    (typeof err?.message === 'string' &&
      (err.message.includes('至少需要') ||
        err.message.includes('没有新题材可写') ||
        err.message.includes('宁缺毋滥安全终止') ||
        err.message.includes('未抓取到符合条件的候选推文')));

  // Operational cases (should only warn on TG, skip Pi inbound)
  assert.equal(
    isOperationalError(new OperationalWarningError('未抓取到符合条件的候选推文（至少需要 1000 阅读量）')),
    true
  );
  assert.equal(
    isOperationalError(new Error('未抓取到符合条件的候选推文（已过滤阅读量不足 1000 的推文 5 条）。至少需要 1000 阅读量才值得作为参考。')),
    true
  );
  assert.equal(
    isOperationalError(new Error('候选 5 条推文在最近 8 期都已写过，没有新题材可写。')),
    true
  );
  assert.equal(
    isOperationalError(new Error('LLM 审稿人全盘否决当期候选（宁缺毋滥安全终止）: 全是商业广告')),
    true
  );

  // Real program bugs (must notify both TG and Pi inbound)
  assert.equal(isOperationalError(new TypeError('Cannot read properties of undefined (reading "map")')), false);
  assert.equal(isOperationalError(new Error('ECONNREFUSED 127.0.0.1:9222')), false);
  assert.equal(isOperationalError(new Error('SyntaxError: Unexpected token in JSON at position 0')), false);
  assert.equal(isOperationalError(new Error('WebDriver error: Target window closed')), false);
});
