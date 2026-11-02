import test from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';
import {
  buildHeaderBannerSvg,
  buildArchitectureSvg,
  buildSequenceSvg,
} from '../src/pipelines/xdev/svg-builder.js';

test('SVG Builders conform to Google & Apple Modern Clean Design Language', async () => {
  const sampleTopic = 'Autonomous Multi-Agent Architecture';
  const header = buildHeaderBannerSvg(sampleTopic);
  const arch = buildArchitectureSvg(sampleTopic);
  const seq = buildSequenceSvg(sampleTopic);

  const svgs = [header, arch, seq];

  for (const svg of svgs) {
    // 1. Zero Chinese characters
    assert.strictEqual(/[\u4e00-\u9fa5]/.test(svg), false, 'SVG must not contain Chinese characters');

    // 2. No old neon cyberpunk dark artifacts
    assert.strictEqual(/#080c14|#00f2fe|#7f00ff|neonCyan|neonPurple/i.test(svg), false, 'SVG must not use dark neon cyberpunk palette');

    // 3. Must use Apple/Google clean design tokens
    assert.ok(svg.includes('#F8FAFC') || svg.includes('#FFFFFF'), 'SVG must use clean off-white / light base');
    assert.ok(svg.includes('#0071E3') || svg.includes('#4F46E5'), 'SVG must use Apple System Blue / Modern Indigo accent');

    // 4. Must be validly rasterizable by sharp without throwing errors
    const buf = Buffer.from(svg, 'utf-8');
    const imageInfo = await sharp(buf).png().toBuffer();
    assert.ok(imageInfo.length > 1000, 'Sharp should rasterize SVG into valid PNG buffer');
  }
});
