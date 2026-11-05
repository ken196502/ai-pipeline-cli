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
  /** Planned camera setup of this clip (single position + single continuous move). */
  cameraSetup: z.string().optional(),
  /** Planned location/scene this clip belongs to (same set = same 机位 coverage). */
  locationId: z.string().optional(),
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

/**
 * Story plan (剧本/分镜表) — the AUTHORITATIVE screenplay + shot list produced by the
 * dedicated screenwriting LLM pass BEFORE any prompt is written.
 *
 * Why it exists: extracted reference material is often only a character sheet + a
 * background + one single-shot prompt. Asking the prompt-writing LLM to invent the
 * whole story while writing prompts produced incoherent clips (cause/effect reversed).
 * The story plan pins down how many scenes there are, how each scene is performed
 * (blocking, movement, action, dialogue) and how each scene is covered by shots; the
 * prompt pass may only translate each planned shot into imagePrompt/endImagePrompt/
 * visualPrompt.
 */
export const StoryPlanDialogueLineSchema = z
  .object({
    /** Character key (character1…) or "narrator" for off-screen voiceover. */
    speaker: z.string().default(''),
    line: z.string().default(''),
    /** How the line is delivered (whisper, shouted, laughing…). */
    delivery: z.string().default(''),
  })
  .passthrough();
export type StoryPlanDialogueLine = z.infer<typeof StoryPlanDialogueLineSchema>;

export const StoryPlanSceneSchema = z
  .object({
    sceneId: z.string().default(''),
    /** Background key + the area of it this scene plays in. */
    location: z.string().default(''),
    /** Spatial layout: fixed landmarks and where they sit in the set. */
    setting: z.string().default(''),
    timeOfDay: z.string().default(''),
    lighting: z.string().default(''),
    cast: z.array(z.string()).default([]),
    /** Props present in the scene and their starting state. */
    props: z.string().default(''),
    /** Story purpose of the scene (why it exists in the film). */
    summary: z.string().default(''),
    /** Where every character stands / faces at the start of the scene, relative to landmarks. */
    blocking: z.string().default(''),
    /** How the scene plays out (演绎): beat-by-beat action, movement and reactions. */
    performance: z.string().default(''),
    /** What has changed by the end of the scene: positions, prop states, emotions, light. */
    changes: z.string().default(''),
  })
  .passthrough();
export type StoryPlanScene = z.infer<typeof StoryPlanSceneSchema>;

/**
 * One planned shot = one clip. Inside a scene, shots may freely switch between wide /
 * medium / close-ups on different subjects; the start and end frames of a shot may also
 * differ a lot. What must not drift is the scene itself (location, set layout, wardrobe,
 * props, lighting, character positions).
 */
export const StoryPlanShotSchema = z
  .object({
    shotIndex: z.number().int().default(0),
    sceneId: z.string().default(''),
    /** Story function of this shot (why it exists, what changed since the previous shot). */
    beat: z.string().default(''),
    shotSize: z.string().default(''),
    cameraAngle: z.string().default(''),
    cameraHeight: z.string().default(''),
    lens: z.string().default(''),
    /** Physical camera position inside the set ("8 m back, left of the path"). */
    cameraPosition: z.string().default(''),
    cameraMove: z.string().default(''),
    /** Who/what the shot is about (focus subject of a close-up, group in a wide). */
    focusSubject: z.string().default(''),
    /** Composition of the frame at t=0 (shot size, subject, screen positions). */
    startFrame: z.string().default(''),
    /** Composition of the frame at the end — may be a different size/subject in the same scene. */
    endFrame: z.string().default(''),
    /** Screen direction / axis commitment (who is frame-left / frame-right). */
    screenDirection: z.string().default(''),
    /** Where each character stands at the start of the shot, relative to set landmarks. */
    blocking: z.string().default(''),
    /** How positions change during the shot (who walks where, who turns, distances). */
    blockingChange: z.string().default(''),
    actionStart: z.string().default(''),
    actionEnd: z.string().default(''),
    /** Acting: expressions, gestures, emotional shift. */
    performance: z.string().default(''),
    /** Lines spoken in this shot (on-screen dialogue and/or narrator voiceover). */
    dialogue: z.array(StoryPlanDialogueLineSchema).default([]),
    /** Plain spoken text for the TTS track (all dialogue lines of the shot, in order). */
    narrationLine: z.string().default(''),
    continuity: z.string().default(''),
  })
  .passthrough();
export type StoryPlanShot = z.infer<typeof StoryPlanShotSchema>;

export const StoryPlanSchema = z
  .object({
    logline: z.string().default(''),
    synopsis: z.string().default(''),
    hasNarration: z.boolean().default(false),
    scenes: z.array(StoryPlanSceneSchema).default([]),
    shots: z.array(StoryPlanShotSchema).default([]),
    characters: z.record(z.string(), z.string()).default({}),
    backgrounds: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
export type StoryPlan = z.infer<typeof StoryPlanSchema>;

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
  /** Screenplay/shot plan that the prompts were translated from (audit trail). */
  storyPlan: StoryPlanSchema.optional(),
  createdAt: z.string(),
});
export type FlowVideoScript = z.infer<typeof FlowVideoScriptSchema>;
