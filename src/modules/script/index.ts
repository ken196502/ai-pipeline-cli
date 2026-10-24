/**
 * Video Script Generator Module Script.
 * Extracts narrative scenes from transcript cues and compiles Veo-optimized clip prompts
 * into validated FlowVideoScript specifications.
 */
import { generateFlowVideoScript } from '../../research/script/generator.js';
import {
  FlowVideoScriptSchema,
  type FlowVideoScript,
} from '../../research/script/contracts.js';
import { runGenerateScriptCli } from '../../research/cli/script.js';

export { runGenerateScriptCli };
export * from '../../research/script/index.js';

/**
 * Self-test routine for the Script Generator Module.
 * Tests scene segmentation compilation and Veo prompt schema validation in isolation.
 */
export async function testScriptModule(): Promise<{
  success: boolean;
  totalClips: number;
  totalDurationSec: number;
  errors: string[];
}> {
  const errors: string[] = [];

  const mockSegments = [
    {
      segmentId: 'scene-001',
      title: 'Introduction to Modern Generative Video',
      startSec: 0,
      endSec: 24,
      summary: 'In this video, we explore how neural rendering transforms video synthesis.',
      text: 'Welcome to the complete breakdown of modern video generation models.',
    },
    {
      segmentId: 'scene-002',
      title: 'Diffusion Latent Spaces',
      startSec: 24,
      endSec: 48,
      summary: 'Diving deep into the latent space compression and temporal attention.',
      text: 'Temporal cross-attention enables stable consistency across consecutive video frames.',
    },
  ];

  let script: FlowVideoScript;
  try {
    script = await generateFlowVideoScript({
      runId: 'test-script-module',
      videoId: 'vid-test-01',
      topic: 'ai-video-generation',
      videoTitle: 'Modern Generative Video Breakdown',
      videoSummary: 'Overview of modern generative video',
      segments: mockSegments,
      vlPrompts: [
        {
          prompt: 'Futuristic holographic neural network visualizing latent diffusion space, 35mm lens, photorealistic',
          promptType: 'image',
          uiContext: 'Midjourney',
          narration: 'Visualizing latent diffusion space in futuristic neural network',
          confidence: 0.95,
          settings: ['--ar 16:9'],
        },
        {
          prompt: 'Slow dolly-in camera motion through floating glowing data points and temporal latent vectors',
          promptType: 'video',
          uiContext: 'Runway Gen-3',
          narration: 'Slow dolly-in camera motion through floating glowing data points',
          confidence: 0.93,
          settings: ['Motion: 5'],
        },
      ],
      clipDuration: 6,
      aspectRatio: 'landscape',
      useLlm: false,
    });

    const parsed = FlowVideoScriptSchema.safeParse(script);
    if (!parsed.success) {
      errors.push(`Script schema validation failed: ${parsed.error.message}`);
    }

    if (script.clips.length === 0) {
      errors.push('Expected generated clips, but got 0');
    }
  } catch (err: any) {
    errors.push(`Script generation error: ${err.message}`);
    script = {
      version: '1.0.0',
      runId: 'test-script-module',
      videoId: 'vid-test-01',
      topic: 'test',
      aspectRatio: 'landscape',
      model: 'lite',
      hasNarration: false,
      totalClips: 0,
      totalDurationSec: 0,
      totalCreditsEstimate: 0,
      clips: [],
      createdAt: new Date().toISOString(),
    };
  }

  return {
    success: errors.length === 0,
    totalClips: script.clips.length,
    totalDurationSec: script.totalDurationSec,
    errors,
  };
}
