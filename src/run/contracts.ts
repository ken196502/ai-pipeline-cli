import { z } from 'zod';

export const StageResultSchema = z.object({
  stage: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped', 'failed']),
  durationMs: z.number().nonnegative(),
  summary: z.string().optional(),
  error: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type StageResult = z.infer<typeof StageResultSchema>;
export type StageStatus = StageResult['status'];

export const RunDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  pipelineId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  error: z.string().optional(),
  config: z.record(z.unknown()),
  stages: z.record(StageResultSchema),
  artifacts: z.record(z.object({ path: z.string().min(1), updatedAt: z.string() })),
});
export type RunDocument = z.infer<typeof RunDocumentSchema>;
