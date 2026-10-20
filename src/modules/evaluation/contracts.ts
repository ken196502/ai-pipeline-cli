import { z } from 'zod';
import type { XHotCandidate } from '../discovery/contracts.js';

export const XHotTopCandidateSchema = z.object({
  rank: z.number().int().positive(),
  index: z.number().int().nonnegative(),
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  reason: z.string().min(1),
  score: z.number().optional(),
});
export type XHotTopCandidate = z.infer<typeof XHotTopCandidateSchema>;

export const XHotEvalResultSchema = z.object({
  query: z.string(),
  evaluatedAt: z.string(),
  gridImagePath: z.string(),
  winner: XHotTopCandidateSchema,
  topCandidates: z.array(XHotTopCandidateSchema).min(1).max(5),
  reasoning: z.string(),
});
export type XHotEvalResult = z.infer<typeof XHotEvalResultSchema>;

export interface EvaluateXHotCandidatesOptions {
  query: string;
  candidates: XHotCandidate[];
  gridBuffer: Buffer;
  gridImagePath: string;
  model?: string;
  onProgress?: (msg: string) => void;
}
