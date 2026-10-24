import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { buildXHotGrid } from './grid.js';
import type { XHotCandidate } from './contracts.js';

export * from './contracts.js';
export * from './search.js';
export * from './grid.js';

/**
 * Self-test routine for the Discovery Module.
 * Verifies candidate grid compilation with badges and geometry layout.
 */
export async function testDiscoveryModule(): Promise<{
  success: boolean;
  gridGenerated: boolean;
  layout?: { columns: number; rows: number };
  errors: string[];
}> {
  const errors: string[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-discovery-'));
  const gridPath = path.join(tempDir, 'test-grid.png');

  let gridGenerated = false;
  let layout: { columns: number; rows: number } | undefined;

  try {
    const mockCandidates: XHotCandidate[] = [
      {
        index: 1,
        id: '101',
        authorName: 'Alpha',
        authorHandle: '@alpha',
        text: 'Claude 3.7 announced with hybrid reasoning.',
        metrics: { replies: 10, reposts: 50, likes: 200, views: 5000 },
        mediaUrls: [],
        hasVideo: false,
      },
      {
        index: 2,
        id: '102',
        authorName: 'Beta',
        authorHandle: '@beta',
        text: 'DeepSeek-V3 open source weights benchmark report.',
        metrics: { replies: 20, reposts: 80, likes: 400, views: 9000 },
        mediaUrls: [],
        hasVideo: false,
      },

    ];

    const result = await buildXHotGrid({
      candidates: mockCandidates,
      outputPath: gridPath,
      maxGridDimension: 800,
    });

    layout = { columns: result.layout.columns, rows: result.layout.rows };
    const exists = await fs.stat(gridPath).then(() => true).catch(() => false);
    gridGenerated = exists && result.buffer.length > 0;

    if (!gridGenerated) {
      errors.push('Failed to generate grid image on disk');
    }
  } catch (err: any) {
    errors.push(`Grid building exception: ${err.message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    success: errors.length === 0,
    gridGenerated,
    layout,
    errors,
  };
}
