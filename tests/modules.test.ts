import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testAuthModule,
  testDiscoveryModule,
  testEvaluationModule,
  testHarvestModule,
  testPresentationModule,
  testAllModules,
} from '../src/modules/index.js';

test('Module 1 (Auth): validates cookie auth detection and credentials check', async () => {
  const res = await testAuthModule();
  assert.equal(res.success, true, `Auth module self-test failed: ${res.errors.join(', ')}`);
});

test('Module 2 (Discovery): builds contact grid and layout geometry correctly', async () => {
  const res = await testDiscoveryModule();
  assert.equal(res.success, true, `Discovery module self-test failed: ${res.errors.join(', ')}`);
  assert.equal(res.gridGenerated, true);
  assert.equal(res.layout?.columns, 2);
  assert.equal(res.layout?.rows, 1);
});

test('Module 3 (Evaluation): validates VL top 3 rankings and schema enforcement', async () => {
  const res = await testEvaluationModule();
  assert.equal(res.success, true, `Evaluation module self-test failed: ${res.errors.join(', ')}`);
  assert.equal(res.schemaValidationPassed, true);
});

test('Module 4 (Harvest): verifies yt-dlp binary resolution for media capture', async () => {
  const res = await testHarvestModule();
  assert.equal(res.success, true, `Harvest module self-test failed: ${res.errors.join(', ')}`);
  assert.ok(res.ytDlpAvailable, 'yt-dlp must be accessible on system');
});

test('Module 5 (Presentation): builds OpusVideo materials from harvested assets', async () => {
  const res = await testPresentationModule();
  assert.equal(res.success, true, `Presentation module self-test failed: ${res.errors.join(', ')}`);
  assert.equal(res.assetsBuilt, true);
});

test('Unified testAllModules(): runs all 5 modules sequentially', async () => {
  const unified = await testAllModules();
  assert.equal(unified.allPassed, true, 'All modules must pass via unified runner');
  assert.equal(unified.results['auth'].success, true);
  assert.equal(unified.results['discovery'].success, true);
  assert.equal(unified.results['evaluation'].success, true);
  assert.equal(unified.results['harvest'].success, true);
  assert.equal(unified.results['presentation'].success, true);
});
