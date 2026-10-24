import { z } from 'zod';

export const XHotHarvestItemSchema = z.object({
  tweetId: z.string(),
  url: z.string().optional(),
  tweetUrl: z.string().optional(),
  authorName: z.string().default(''),
  authorHandle: z.string().default(''),
  text: z.string().default(''),
  metrics: z.object({
    replies: z.number().default(0),
    reposts: z.number().default(0),
    likes: z.number().default(0),
    views: z.number().default(0),
  }).optional(),
  mediaFiles: z.array(z.object({
    kind: z.enum(['image', 'video']),
    localPath: z.string(),
    url: z.string().optional(),
    asrTranscript: z.string().optional(),
  })).default([]),
  asrTranscript: z.string().optional(),
  screenshotPath: z.string().optional(),
});
export type XHotHarvestItem = z.infer<typeof XHotHarvestItemSchema>;

export const XHotHarvestResultSchema = z.object({
  topicName: z.string(),
  winnerName: z.string().optional(),
  items: z.array(XHotHarvestItemSchema),
  harvestedMediaCount: z.number().int().nonnegative(),
  materialsDir: z.string(),
});
export type XHotHarvestResult = z.infer<typeof XHotHarvestResultSchema>;

export interface HarvestWinnerOptions {
  winnerName: string;
  previewCount?: number;
  targetCount?: number;
  outDir: string;
  /**
   * If true, enables ASR transcription for harvested video assets.
   * Default is true.
   */
  transcribeVideos?: boolean;
  onProgress?: (msg: string) => void;
}

