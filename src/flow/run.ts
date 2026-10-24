import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { RunContext } from '../run/index.js';
import { BatchOptionsSchema, type BatchOptions, type BatchResult } from './contracts.js';
import { FlowVideoScriptSchema } from '../research/script/contracts.js';

const settingsSchema = z.object({
  profileDir: z.string().optional(), flowProjectId: z.string().optional(),
  maxClips: z.number().int().positive().optional(), dryRun: z.boolean().optional(),
  headed: z.boolean().optional(), viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional(),
  aspectRatio: z.enum(['landscape', 'portrait']).optional(), flowModel: z.string().optional(),
  flowOutputDir: z.string().optional(),
});

export interface RunFlowClient {
  batchGenerate(options: BatchOptions, run?: RunContext): Promise<BatchResult>;
}

export async function generateFlowFromRun(run: RunContext, client: RunFlowClient): Promise<BatchResult> {
  const started = Date.now();
  await run.recordStage({ stage: 'flow-generate', status: 'in_progress', durationMs: 0 });
  try {
    const config = await run.config(settingsSchema);
    const script = await run.read('script');
    const project = await run.optional('flowProject');
    const result = await client.batchGenerate(BatchOptionsSchema.parse({
      scriptPath: await run.pathFor('script'), outDir: config.flowOutputDir || path.join(run.outDir, 'generated-clips'),
      ...config, projectId: project?.projectId || config.flowProjectId,
      aspect: script.aspectRatio || config.aspectRatio, model: config.flowModel || script.model,
    }), run);
    await run.write('flow', result);
    // Retain partial batches and replace an earlier failure when this step is retried.
    await run.recordStage({ stage: 'flow-generate', status: result.failedClips ? 'failed' : 'completed', durationMs: Date.now() - started,
      error: result.failedClips ? result.results.find(clip => clip.status === 'failed')?.error || 'Flow clips failed' : undefined });
    return result;
  } catch (error) {
    await run.recordStage({ stage: 'flow-generate', status: 'failed', durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export interface FlowRunCommandOptions {
  run?: string; script?: string; outDir?: string; projectId?: string; maxClips?: number;
  dryRun?: boolean; profileDir?: string; headed?: boolean;
  viewport?: { width: number; height: number } | null;
}

/** Both CLI frontends use the same run-aware boundary. */
export async function runFlowBatchCommand(options: FlowRunCommandOptions, client: RunFlowClient): Promise<BatchResult> {
  if (options.run && (options.script || options.outDir)) throw new Error('--run uses its registered script/output directory; omit --script and --out-dir.');
  if (!options.run && (!options.script || !options.outDir)) {
    throw new Error("error: required option '-s, --script <path>' not specified (provide --script and --out-dir, or --run)");
  }
  const config = { profileDir: options.profileDir, flowProjectId: options.projectId,
    maxClips: options.maxClips, dryRun: options.dryRun, headed: options.headed, viewport: options.viewport };
  const run = options.run ? await RunContext.open(options.run) : await RunContext.create({
    pipelineId: 'flow-batch', outDir: options.outDir,
    config: { ...config, flowOutputDir: path.resolve(options.outDir!) },
  });
  try {
    await run.configure(config);
    if (!options.run) {
      const script = FlowVideoScriptSchema.parse(JSON.parse(await fs.readFile(path.resolve(options.script!), 'utf8')));
      await run.write('script', { ...script, runId: run.runId });
    }
    if (options.projectId) await run.write('flowProject', { projectId: options.projectId,
      url: `https://flow.google.com/project/${options.projectId}` });
    const result = await generateFlowFromRun(run, client);
    await run.finish();
    return result;
  } catch (error) {
    await run.finish(error);
    throw error;
  }
}
