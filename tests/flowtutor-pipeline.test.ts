import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowTutorPipeline,
  FlowTutorPipelineOptionsSchema,
  FLOW_TUTOR_PIPELINE_STAGES,
  DEFAULT_FLOW_TUTOR_QUERY,
  runFlowTutorPipeline,
} from '../src/pipelines/flowtutor/index.js';
import { pipelineRegistry } from '../src/pipelines/index.js';

test('flowTutor pipeline stages and schema are correctly defined', () => {
  assert.equal(flowTutorPipeline.id, 'flowTutor');
  assert.ok(flowTutorPipeline.stages.length >= 10);
  assert.ok(flowTutorPipeline.stages.some((s) => s.id === 'check-ytb'));
  assert.ok(flowTutorPipeline.stages.some((s) => s.id === 'flow-generate'));
  assert.ok(flowTutorPipeline.stages.some((s) => s.id === 'tutorial-gen'));
  assert.ok(FLOW_TUTOR_PIPELINE_STAGES.length >= 10);

  const parsed = FlowTutorPipelineOptionsSchema.parse({ query: DEFAULT_FLOW_TUTOR_QUERY });
  assert.equal(parsed.query, DEFAULT_FLOW_TUTOR_QUERY);
  assert.equal(parsed.aspectRatio, 'landscape');
});

test('flowTutor pipeline is auto-registered in pipelineRegistry', () => {
  const p = pipelineRegistry.get('flowTutor');
  assert.ok(p, 'flowTutor should be registered in pipelineRegistry');
  assert.equal(p.id, 'flowTutor');
});

