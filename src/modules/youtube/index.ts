/**
 * Research Search & Discovery Module Script.
 * Discovers candidates via yt-dlp, hydrates metadata, and applies metric pre-filtering.
 */
import { filterCandidates } from '../../research/youtube/filter.js';
import type { VideoCandidate } from '../../research/contracts.js';
import { runSearchCli } from '../../research/cli/search.js';

export { runSearchCli };
export * from '../../research/youtube/filter.js';
export * from '../../research/youtube/urls.js';

/**
 * Self-test routine for the Research Module.
 * Tests candidate filtering logic, velocity calculations, and threshold enforcement in isolation.
 */
export async function testResearchModule(): Promise<{
  success: boolean;
  passedCount: number;
  rejectedCount: number;
  errors: string[];
}> {
  const errors: string[] = [];

  const mockCandidates: VideoCandidate[] = [
    {
      videoId: 'test_good_01',
      title: 'High Velocity AI Breakdown',
      description: 'Detailed analysis of transformer architecture',
      url: 'https://www.youtube.com/watch?v=test_good_01',
      channelId: 'channel_1',
      channelTitle: 'Deep AI Lab',
      language: 'en',
      tags: ['ai', 'transformers'],
      metrics: {
        viewCount: 150000,
        likeCount: 5000,
        commentCount: 400,
        durationSec: 600,
        publishedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        viewsPerDay: 30000,
        engagementRate: 0.036,
      },
    },
    {
      videoId: 'test_short_02',
      title: 'Too Short Clip',
      description: 'Quick short',
      url: 'https://www.youtube.com/watch?v=test_short_02',
      channelId: 'channel_2',
      channelTitle: 'Shorts Channel',
      language: 'en',
      tags: ['shorts'],
      metrics: {
        viewCount: 20000,
        likeCount: 500,
        commentCount: 20,
        durationSec: 120, // below 300s
        publishedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
        viewsPerDay: 10000,
        engagementRate: 0.026,
      },
    },
  ];

  const filtered = filterCandidates(mockCandidates, 'ai-video-generation');

  if (filtered.kept.length !== 1 || filtered.kept[0].videoId !== 'test_good_01') {
    errors.push(`Expected 1 kept candidate, got ${filtered.kept.length}`);
  }

  if (filtered.rejected.length !== 1 || filtered.rejected[0].videoId !== 'test_short_02') {
    errors.push(`Expected 1 rejected candidate, got ${filtered.rejected.length}`);
  }

  return {
    success: errors.length === 0,
    passedCount: filtered.kept.length,
    rejectedCount: filtered.rejected.length,
    errors,
  };
}
