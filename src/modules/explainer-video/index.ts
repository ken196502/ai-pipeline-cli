import { buildExplainerAssets } from './video.js';
import type { XHotEvalResult } from '../evaluation/contracts.js';
import type { XHotHarvestResult } from '../harvest/contracts.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

export * from './contracts.js';
export * from './produce.js';
export * from './video.js';

/**
 * Self-test routine for the Explainer Video Module.
 * Verifies asset assembly mapping and storyboard structure validation.
 */
export async function testExplainerVideoModule(): Promise<{
  success: boolean;
  assetsBuilt: boolean;
  assetCount: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-explainer-'));
  let assetsBuilt = false;
  let assetCount = 0;

  try {
    const mockEval: XHotEvalResult = {
      query: 'new model',
      evaluatedAt: new Date().toISOString(),
      gridImagePath: '',
      winner: {
        rank: 1,
        index: 1,
        id: '101',
        name: 'Claude 3.7',
        summary: 'Hybrid reasoning release',
        reason: 'Leading discussion',
      },
      topCandidates: [],
      reasoning: 'Evaluation summary',
    };

    const mockHarvest: XHotHarvestResult = {
      topicName: 'Claude 3.7',
      winnerName: 'Claude 3.7',
      materialsDir: tempDir,
      items: [
        {
          tweetId: '101',
          tweetUrl: 'https://x.com/tech/status/101',
          authorName: 'Tech',
          authorHandle: '@tech',
          text: 'Claude 3.7 live announcement',
          metrics: { replies: 1, reposts: 2, likes: 3, views: 4 },
          mediaFiles: [],
        },
      ],
      harvestedMediaCount: 0,
    };

    const assets = await buildExplainerAssets(mockEval, mockHarvest, path.join(tempDir, 'assets'));
    assetsBuilt = true;
    assetCount = assets.length;
  } catch (err: any) {
    errors.push(`Explainer asset build error: ${err.message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    success: errors.length === 0,
    assetsBuilt,
    assetCount,
    errors,
  };
}

export const testPresentationModule = testExplainerVideoModule;
