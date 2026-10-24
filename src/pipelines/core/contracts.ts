import { z } from 'zod';

export type { PipelineExecutionContext as PipelineContext } from './context.js';

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
  stages: readonly PipelineStageDef[] | PipelineStageDef[];
  execute: (options: TOptions, ctx?: any) => Promise<TResult>;
  reports?: {
    generateMarkdownReport?: (result: TResult) => string;
    generateJsonReport?: (result: TResult) => string;
    saveReports?: (result: TResult, outDir: string) => Promise<{ jsonPath: string; markdownPath: string }>;
    printSummary?: (result: TResult) => void;
  };
}

export interface TopicScheduleState {
  version: 1;
  maxRunsPer24h: number;
  lastRunIndex: number;
  topics: Record<string, number[]>;
}

export interface Pipeline24hOptions<TOptions = any, TResult = any> {
  pipelineId?: string;
  pipeline?: Pipeline<TOptions, TResult>;
  topics: string[];
  maxRunsPer24h?: number;
  stateFilePath?: string;
  errorCooldownMs?: number;
  windowMs?: number;
  signal?: AbortSignal;
  executeFn?: (topic: string, roundIndex: number) => Promise<TResult>;
  createOptions?: (topic: string) => TOptions;
  onRoundStart?: (topic: string, roundIndex: number, runCountIn24h: number) => void | Promise<void>;
  onRoundSuccess?: (topic: string, result: TResult, roundIndex: number) => void | Promise<void>;
  onRoundError?: (topic: string, error: unknown, roundIndex: number) => void | Promise<void>;
  onSleep?: (topic: string, waitMs: number, reason: string) => void | Promise<void>;
}
