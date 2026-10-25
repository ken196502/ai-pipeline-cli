import { z } from 'zod';
import type { RunContext } from '../../run/index.js';
import { generateFlowVideoScript } from './generator.js';

const settingsSchema = z.object({
  clipDuration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(4),
  aspectRatio: z.enum(['landscape', 'portrait']).default('landscape'),
  flowModel: z.string().optional(), scriptModel: z.string().optional(),
  useLlmForScript: z.boolean().default(true), scriptClipCount: z.number().int().positive().optional(),
  maxClips: z.number().int().positive().optional(),
  requireVideoPrompt: z.boolean().default(true),
});

export async function generateScriptFromRun(run: RunContext) {
  return run.step('script', async () => {
    const config = await run.config(settingsSchema);
    const research = await run.read('research');
    const script = await generateFlowVideoScript({ ...research, runId: run.runId }, {
      clipDuration: config.clipDuration, aspectRatio: research.detectedOrientation || config.aspectRatio,
      model: config.flowModel || config.scriptModel || 'lite',
      useLlm: config.useLlmForScript, clipCount: config.scriptClipCount || config.maxClips,
      // ported from prod hotfix 81d6152: without visible generation prompts in the
      // reference video, fall back to transcript-synthesized prompts (pipeline default)
      allowTranscriptSynthesis: !config.requireVideoPrompt,
    });
    const outputPath = await run.write('script', script);
    return { script, outputPath };
  });
}
