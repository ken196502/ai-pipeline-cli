/**
 * Contracts and Zod Schemas for Veo-Optimized Flow Video Scripts.
 */
import { z } from 'zod';

/**
 * Shot transition annotation of a clip relative to the previous clip:
 * - 'cut'        (切分镜): a NEW shot — framing / camera angle / shot size / scene changes.
 * - 'continuous' (连续):   the SAME shot continues — the keyframe must seamlessly
 *                          continue the previous clip's end state.
 */
export const ShotTransitionSchema = z.enum(['cut', 'continuous']);
export type ShotTransition = z.infer<typeof ShotTransitionSchema>;

export const FlowClipPromptSchema = z.object({
  clipIndex: z.number().int().nonnegative(),
  sceneId: z.string().default(''),
  title: z.string().default(''),
  /** 切分镜 / 连续 — see ShotTransitionSchema. */
  transition: ShotTransitionSchema.default('cut'),
  /** 备注: why this transition was chosen + what must stay consistent + what changes. */
  transitionNote: z.string().default(''),
  startSec: z.number().nonnegative().default(0),
  endSec: z.number().positive().default(4),
  durationSec: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(4),
  imagePrompt: z.string().default(''),
  imageUrl: z.string().url().optional(),
  localImagePath: z.string().optional(),
  imageTileKey: z.string().nullable().optional(),
  /** End frame prompt for cut/split scenes (结尾图提示词). */
  endImagePrompt: z.string().default(''),
  endImageUrl: z.string().url().optional(),
  localEndImagePath: z.string().optional(),
  endImageTileKey: z.string().nullable().optional(),
  planMode: z.string().optional(),
  startFrameSourceVideo: z.string().optional(),
  startFramePath: z.string().optional(),
  visualPrompt: z.string().min(1, 'Visual prompt cannot be empty'),
  cameraMovement: z.string().default('static tripod shot'),
  subjectAction: z.string().default(''),
  environmentLighting: z.string().default('natural soft daylight'),
  styleAesthetic: z.string().default('photorealistic cinematic, 35mm lens, high fidelity'),
  hasNarration: z.boolean().default(false),
  narrationCues: z.string().default(''),
  estimatedCredits: z.number().int().default(15),
  status: z.enum(['pending', 'generating', 'completed', 'failed']).default('pending'),
  videoUrl: z.string().url().optional(),
  localVideoPath: z.string().optional(),
  error: z.string().optional(),
});
export type FlowClipPrompt = z.infer<typeof FlowClipPromptSchema>;

export const FlowVideoScriptSchema = z.object({
  version: z.literal('1.0.0').default('1.0.0'),
  runId: z.string(),
  videoId: z.string(),
  topic: z.string(),
  aspectRatio: z.enum(['landscape', 'portrait']).default('landscape'),
  model: z.string().default('lite'),
  visualStyle: z.string().optional(),
  characters: z.record(z.string(), z.string()).optional(),
  backgrounds: z.record(z.string(), z.string()).optional(),
  hasNarration: z.boolean().default(false),
  totalClips: z.number().int().nonnegative(),
  totalDurationSec: z.number().int().nonnegative(),
  totalCreditsEstimate: z.number().int().nonnegative(),
  clips: z.array(FlowClipPromptSchema),
  createdAt: z.string(),
});
export type FlowVideoScript = z.infer<typeof FlowVideoScriptSchema>;
