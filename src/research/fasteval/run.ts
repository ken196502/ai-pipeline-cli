import { z } from 'zod';
import type { RunContext } from '../../run/index.js';
import { runFastEval, toFastEvalData } from './index.js';
import type { FastEvalOptions } from './types.js';

const settingsSchema = z.object({
  query: z.string(), topic: z.string().optional(), fastevalCandidates: z.number().optional(),
  profileDir: z.string().optional(), browserPath: z.string().optional(), model: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional(),
  minDurationSec: z.number().optional(), maxAgeDays: z.number().optional(),
});

export async function runFastEvalFromRun(run: RunContext, onProgress?: FastEvalOptions['onProgress']) {
  return run.step('fasteval', async () => {
    const config = await run.config(settingsSchema);
    // Keep the RESIDENT headful browser session (persistent profile): the user's
    // login must survive the whole pipeline. Headless searches would restart the
    // browser with a throwaway profile and log it out.
    const result = await runFastEval({ ...config, headless: false, candidateCount: config.fastevalCandidates, outDir: run.outDir, onProgress });
    await run.write('fastEval', toFastEvalData(result));
    return result;
  });
}
