import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ytbhotPipeline,
  ViralPipelineOptionsSchema,
  VIRAL_PIPELINE_STAGES,
  runYtbHotPipeline,
} from '../src/pipelines/ytbhot/index.js';
import { pipelineRegistry } from '../src/pipelines/index.js';

test('ytbhot pipeline stages and schema are correctly defined', () => {
  assert.equal(ytbhotPipeline.id, 'ytbhot');
  assert.ok(ytbhotPipeline.stages.length >= 10);
  assert.ok(ytbhotPipeline.stages.some(s => s.id === 'check-ytb'));
  assert.ok(ytbhotPipeline.stages.some(s => s.id === 'flow-generate'));
  assert.ok(ytbhotPipeline.stages.some(s => s.id === 'tutorial-gen'));

  const parsed = ViralPipelineOptionsSchema.parse({
    query: 'AI make Niche Viral Video',
  });
  assert.equal(parsed.query, 'AI make Niche Viral Video');
  assert.equal(parsed.aspectRatio, 'landscape');
});

test('ytbhot pipeline is auto-registered in pipelineRegistry', () => {
  const p = pipelineRegistry.get('ytbhot');
  assert.ok(p, 'ytbhot should be registered in pipelineRegistry');
  assert.equal(p.id, 'ytbhot');
});
