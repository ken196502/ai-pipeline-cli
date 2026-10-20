import { z } from 'zod';

export interface PipelineStageDef {
  id: string;
  name: string;
  description: string;
  optional?: boolean;
}

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

export interface Pipeline<TOptions = any, TResult = any> {
  id: string;
  name: string;
  description: string;
  schema: z.ZodType<TOptions, any, any>;
  stages: PipelineStageDef[];
  execute: (options: TOptions, ctx?: any) => Promise<TResult>;
  reports?: {
    generateMarkdownReport?: (result: TResult) => string;
    generateJsonReport?: (result: TResult) => string;
    printSummary?: (result: TResult) => void;
  };
}
