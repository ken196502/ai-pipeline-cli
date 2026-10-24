import { z } from 'zod';
import { RunContext } from '../run/index.js';
import { EvaluationRequirementsSchema } from './contracts.js';
import { AppError, ErrorCodes } from './errors.js';
import type { ResearchPipelineOptions } from './index.js';

export type ResearchServices = Pick<ResearchPipelineOptions,
  'now' | 'onProgress' | 'refreshCookies' | 'transcriptStorage' | 'videoStorage'>;

const settingsSchema = z.object({
  query: z.string().min(1), topic: z.string().optional(), language: z.string().optional(),
  maxCandidates: z.number().int().positive().optional(), poolSize: z.number().int().positive().optional(),
  evaluationPoolSize: z.number().int().positive().optional(),
  cookiePath: z.string().nullable().optional(), proxyUrl: z.string().nullable().optional(), model: z.string().optional(),
  evaluationFocus: z.string().optional(), evaluationRequirements: z.union([EvaluationRequirementsSchema, z.string()]).optional(),
  skipMediaDownload: z.boolean().optional(), locatePrompts: z.boolean().optional(), generateFlowScript: z.boolean().optional(),
  requireVideoPrompt: z.boolean().optional(),
  clipDuration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional(),
  aspectRatio: z.enum(['landscape', 'portrait']).optional(),
  scriptModel: z.string().optional(), flowModel: z.string().optional(), useLlmForScript: z.boolean().optional(),
  minFrames: z.number().optional(), maxFrames: z.number().optional(), sceneThreshold: z.number().optional(),
  metricThresholds: z.object({ minDurationSec: z.number().optional(), maxAgeDays: z.number().optional() }).optional(),
});

export async function researchOptionsFromRun(run: RunContext, services: ResearchServices): Promise<ResearchPipelineOptions> {
  const config = await run.config(settingsSchema);
  // FastEval is the evaluation: the artifact must exist before research runs.
  const fastEvalResult = await run.optional('fastEval');
  if (!fastEvalResult) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Run artifact "fastEval" not found: execute the FastEval stage (browser search + VL top-3) before the research pipeline',
      stage: 'research',
      task: 'run-options',
      retryable: false,
    });
  }
  return {
    ...config,
    evaluationPoolSize: config.poolSize ?? config.evaluationPoolSize,
    scriptModel: config.flowModel ?? config.scriptModel,
    outputDir: run.outDir,
    existingStandard: await run.optional('standard'), fastEvalResult,
    ...services,
  };
}
