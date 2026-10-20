import { z } from 'zod';

export const XHotCandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string(),
  url: z.string().url().optional(),
  authorName: z.string().default(''),
  authorHandle: z.string().default(''),
  avatarUrl: z.string().optional(),
  text: z.string().default(''),
  timestamp: z.string().optional(),
  ageHours: z.number().optional(),
  metrics: z.object({
    replies: z.number().default(0),
    reposts: z.number().default(0),
    likes: z.number().default(0),
    views: z.number().default(0),
  }).default({}),
  mediaUrls: z.array(z.string()).default([]),
  screenshotPath: z.string().optional(),
  thumbnailBuffer: z.instanceof(Buffer).optional(),
});
export type XHotCandidate = z.infer<typeof XHotCandidateSchema>;

export interface SearchXCandidatesOptions {
  query: string;
  candidateCount?: number;
  maxAgeHours?: number;
  outDir: string;
  onProgress?: (msg: string) => void;
}

export interface XHotGridLayout {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
}
