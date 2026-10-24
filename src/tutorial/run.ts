import path from 'node:path';
import { z } from 'zod';
import type { RunContext } from '../run/index.js';
import { createTutorialVideo, type CreateTutorialVideoParams } from './index.js';

const settingsSchema = z.object({
  narrationLang: z.string().optional(), language: z.string().optional(),
  ttsVoice: z.string().optional(), ttsRate: z.string().optional(),
  tutorialEngine: z.enum(['firefox', 'chromium']).optional(), tutorialFps: z.number().positive().optional(),
  tutorialSize: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  maxTutorialScenes: z.number().positive().optional(), tutorialSubtitles: z.boolean().optional(),
  cookiePath: z.string().nullable().optional(), proxyUrl: z.string().nullable().optional(),
  model: z.string().optional(), browserPath: z.string().optional(), profileDir: z.string().optional(),
});

/** Resolve domain inputs at the step boundary, rather than threading them through callers. */
export async function tutorialParamsFromRun(run: RunContext): Promise<CreateTutorialVideoParams> {
  const config = await run.config(settingsSchema);
  const research = await run.read('research');
  const script = await run.read('script');
  const flow = await run.optional('flow');
  return {
    run, runId: run.runId, outDir: run.outDir,
    videoId: research.selected.videoId, title: research.selected.title, topic: research.topic,
    transcript: research.transcript, segments: research.segments, vlPrompts: research.vlPrompts,
    clips: script.clips,
    clipOutputs:
      flow?.results && flow.results.length > 0
        ? flow.results
            .filter((clip) => clip.status === 'completed')
            .map((clip) => ({
              clipIndex: clip.clipIndex,
              localVideoPath: clip.outputPath,
              localImagePath: clip.localImagePath,
              imagePrompt: clip.imagePrompt,
              visualPrompt: clip.visualPrompt,
            }))
        : script?.clips
            ?.filter((clip: any) => clip.status === 'completed' && clip.localVideoPath)
            .map((clip: any) => ({
              clipIndex: clip.clipIndex,
              localVideoPath: clip.localVideoPath,
              localImagePath: clip.localImagePath,
              imagePrompt: clip.imagePrompt,
              visualPrompt: clip.visualPrompt,
            })) || [],
    generatedClipsDir: path.join(run.outDir, 'generated-clips'),
    narrationLanguage: config.narrationLang || config.language || research.transcript.language || 'en',
    ttsVoice: config.ttsVoice, ttsRate: config.ttsRate,
    engine: config.tutorialEngine || 'firefox', fps: config.tutorialFps,
    width: config.tutorialSize?.width, height: config.tutorialSize?.height,
    maxScenes: config.maxTutorialScenes, subtitles: config.tutorialSubtitles,
    cookiePath: config.cookiePath, proxyUrl: config.proxyUrl, model: config.model, profileDir: config.profileDir,
    browserPath: config.tutorialEngine === 'chromium' ? config.browserPath : undefined,
  };
}

export async function createTutorialFromRun(
  run: RunContext,
  overrides: Partial<Omit<CreateTutorialVideoParams, 'run' | 'runId'>> = {},
) {
  return run.step('tutorial-gen', async () => createTutorialVideo({ ...await tutorialParamsFromRun(run), ...overrides, run }));
}
