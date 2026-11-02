import { test } from 'node:test';
import assert from 'node:assert/strict';

import { XDevPipelineOptionsSchema, resolvePublishMode } from '../src/pipelines/xdev/contracts.js';

test('a bare xdev run fills a draft and never publishes', () => {
  const options = XDevPipelineOptionsSchema.parse({});
  assert.equal(options.publishMode, 'draft');
  assert.equal(resolvePublishMode({}), 'draft');
});

test('publishing must be asked for explicitly', () => {
  assert.equal(resolvePublishMode({ publish: true }), 'publish');
  assert.equal(resolvePublishMode({ publishMode: 'publish' }), 'publish');
  assert.equal(resolvePublishMode({ publish: true, publishMode: 'publish' }), 'publish');
});

test('--draft-only wins over any publish request', () => {
  assert.equal(resolvePublishMode({ draftOnly: true }), 'draft');
  assert.equal(resolvePublishMode({ draftOnly: true, publish: true }), 'draft');
  assert.equal(resolvePublishMode({ draftOnly: true, publishMode: 'publish' }), 'draft');
  assert.equal(resolvePublishMode({ draftOnly: true, publish: true, publishMode: 'publish' }), 'draft');
});

test('an unrecognised publish mode falls back to draft, not publish', () => {
  assert.equal(resolvePublishMode({ publishMode: 'PUBLISH' }), 'draft');
  assert.equal(resolvePublishMode({ publishMode: '' }), 'draft');
});
