/**
 * Contracts and Zod schemas for AI commentary / explainer video generation
 * based on the OpusVideo procedural canvas engine.
 *
 * Data hierarchy:
 *   ExplainerStoryboard / Config
 *     └── meta: design { w, h }, bg, accent, font, shotDur, shotTrans, clipTrans
 *     └── clips[]: chapters (e.g. 00 · HOOK, 01 · STEP 1, 02 · STEP 2...)
 *           └── kicker, title, subtitle, bg
 *           └── shots[]: visual shots within the chapter
 *                 └── id
 *                 └── elements[]: [ [phraseText, visualRef], ... ]
 *                 └── narration[]: spoken sentences corresponding 1:1 to element lines
 *                 └── camera?: { zoom, x, y, roll }
 *
 * Visual references (visualRef) can be:
 *   - Video reference: e.g. "clip-001-video" (generated video clip)
 *   - Keyframe / Screenshot: e.g. "clip-001-image", "browser-step-001", "channel-avatar"
 *   - Lucide icon: e.g. "film", "sparkles", "code", "shapes"
 *   - Chart keyword: "bars", "line", "donut"
 *   - Or explicit descriptor: { kind: 'video' | 'image' | 'icon' | 'chart', ... }
 */
import { z } from 'zod';

export const EXPLAINER_STORYBOARD_VERSION = '2.0.0';
export const TUTORIAL_STORYBOARD_VERSION = EXPLAINER_STORYBOARD_VERSION;

export const ExplainerAssetKindSchema = z.enum(['video', 'image', 'prompt']);
export type ExplainerAssetKind = z.infer<typeof ExplainerAssetKindSchema>;
export const TutorialAssetKindSchema = ExplainerAssetKindSchema;
export type TutorialAssetKind = ExplainerAssetKind;

export const ExplainerAssetSchema = z.object({
  id: z.string().min(1),
  kind: ExplainerAssetKindSchema,
  label: z.string().default(''),
  /** Relative source path inside the explainer bundle (video / image only). */
  src: z.string().optional(),
  /** Absolute path of the source file on disk (video / image only). */
  sourcePath: z.string().optional(),
  /** Prompt text material (prompt only). */
  promptText: z.string().optional(),
  /** Originating flow-script clip index (1-based). */
  clipIndex: z.number().int().positive().optional(),
  /** Set when the asset is derived from another generated artifact. */
  derivedFrom: z.enum(['video-first-frame', 'browser-step']).optional(),
  durationSec: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type ExplainerAsset = z.infer<typeof ExplainerAssetSchema>;
export const TutorialAssetSchema = ExplainerAssetSchema;
export type TutorialAsset = ExplainerAsset;

// ==========================================
// OpusVideo Meta & Design
// ==========================================

export const ExplainerMetaDesignSchema = z.object({
  w: z.number().int().positive().default(1920),
  h: z.number().int().positive().default(1080),
});
export type ExplainerMetaDesign = z.infer<typeof ExplainerMetaDesignSchema>;
export const TutorialMetaDesignSchema = ExplainerMetaDesignSchema;
export type TutorialMetaDesign = ExplainerMetaDesign;

export const ExplainerMetaSchema = z.object({
  title: z.string().default('AI Explainer Video'),
  subtitle: z.string().optional(),
  subtitles: z.boolean().default(false),
  design: ExplainerMetaDesignSchema.default({ w: 1920, h: 1080 }),
  bg: z.string().default('#0A0A0B'),
  accent: z.string().default('#FF4D12'),
  font: z.string().default('Inter, "Segoe UI", system-ui, -apple-system, sans-serif'),
  shotDur: z.number().positive().default(4.2),
  shotTrans: z.number().positive().default(0.8),
  clipTrans: z.number().positive().default(1.0),
});
export type ExplainerMeta = z.infer<typeof ExplainerMetaSchema>;
export const TutorialMetaSchema = ExplainerMetaSchema;
export type TutorialMeta = ExplainerMeta;

// ==========================================
// 2D Affine Camera
// ==========================================

export const ExplainerCameraSchema = z.object({
  zoom: z.number().default(1),
  x: z.number().default(0),
  y: z.number().default(0),
  roll: z.number().default(0),
});
export type ExplainerCamera = z.infer<typeof ExplainerCameraSchema>;
export const TutorialCameraSchema = ExplainerCameraSchema;
export type TutorialCamera = ExplainerCamera;

// ==========================================
// Visual References: Video, Screenshot/Image, Icon, Chart
// ==========================================

export const CHART_TYPES = ['bars', 'line', 'donut'] as const;
export const ChartTypeSchema = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartTypeSchema>;

export const ExplainerVisualDescriptorSchema = z.object({
  kind: z.enum(['video', 'image', 'icon', 'chart']),
  assetId: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  fit: z.enum(['cover', 'contain']).default('contain'),
  playbackRate: z.number().positive().default(1),
  frame: z.enum(['portrait', 'landscape', 'square']).optional(),
  data: z.array(z.number()).optional(),
  userText: z.string().optional(),
  botText: z.string().optional(),
  promptAssetId: z.string().optional(),
  botName: z.string().optional(),
  stage: z.enum(['image-prompt', 'video-prompt', 'storyboard']).optional(),
});
export type ExplainerVisualDescriptor = z.infer<typeof ExplainerVisualDescriptorSchema>;
export const TutorialVisualDescriptorSchema = ExplainerVisualDescriptorSchema;
export type TutorialVisualDescriptor = ExplainerVisualDescriptor;

export const ExplainerVisualRefSchema = z.union([
  z.string().min(1),
  ExplainerVisualDescriptorSchema,
]);
export type ExplainerVisualRef = z.infer<typeof ExplainerVisualRefSchema>;
export const TutorialVisualRefSchema = ExplainerVisualRefSchema;
export type TutorialVisualRef = ExplainerVisualRef;

// Element: [phraseText, visualRef]
export const ExplainerElementSchema = z.tuple([
  z.string().min(1),
  ExplainerVisualRefSchema,
]);
export type ExplainerElement = z.infer<typeof ExplainerElementSchema>;
export const TutorialElementSchema = ExplainerElementSchema;
export type TutorialElement = ExplainerElement;

// ==========================================
// Shot & Clip
// ==========================================

export const ExplainerShotSchema = z.object({
  id: z.string().min(1),
  elements: z.array(ExplainerElementSchema).min(1),
  narration: z.array(z.string().min(1)).min(1),
  camera: ExplainerCameraSchema.optional(),
  /** Timeline computed start time (seconds). */
  vStart: z.number().optional(),
  /** Timeline computed duration (seconds). */
  vDur: z.number().optional(),
  /** Timeline computed line timings. */
  vLines: z.array(z.any()).optional(),
});
export type ExplainerShot = z.infer<typeof ExplainerShotSchema>;
export const TutorialShotSchema = ExplainerShotSchema;
export type TutorialShot = ExplainerShot;

export const ExplainerClipSchema = z.object({
  id: z.string().min(1),
  kicker: z.string().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  bg: z.string().default('#0A0A0B'),
  shots: z.array(ExplainerShotSchema).min(1),
  /** Timeline computed start time (seconds). */
  vStart: z.number().optional(),
  /** Timeline computed duration (seconds). */
  vDur: z.number().optional(),
});
export type ExplainerClip = z.infer<typeof ExplainerClipSchema>;
export const TutorialClipSchema = ExplainerClipSchema;
export type TutorialClip = ExplainerClip;

// ==========================================
// Storyboard
// ==========================================

export const ExplainerStoryboardSchema = z.object({
  version: z.string().default(EXPLAINER_STORYBOARD_VERSION),
  runId: z.string().default(''),
  videoId: z.string().default(''),
  topic: z.string().default(''),
  title: z.string().default(''),
  narrationLanguage: z.string().default('en'),
  meta: ExplainerMetaSchema.default({}),
  clips: z.array(ExplainerClipSchema).min(1),
  model: z.string().optional(),
  /** Backwards compatibility for scenes property if accessed. */
  scenes: z.array(z.any()).optional(),
});
export type ExplainerStoryboard = z.infer<typeof ExplainerStoryboardSchema>;
export const TutorialStoryboardSchema = ExplainerStoryboardSchema;
export type TutorialStoryboard = ExplainerStoryboard;

// ==========================================
// Voice & Word-Boundary Alignment
// ==========================================

export const ExplainerWordSchema = z.object({
  word: z.string(),
  t0: z.number().nonnegative(),
  t1: z.number().nonnegative(),
});
export type ExplainerWord = z.infer<typeof ExplainerWordSchema>;
export const TutorialWordSchema = ExplainerWordSchema;
export type TutorialWord = ExplainerWord;

export interface ExplainerVoiceWord {
  word: string;
  t0: number;
  t1: number;
}
export type TutorialVoiceWord = ExplainerVoiceWord;

export interface ExplainerVoiceLine {
  text: string;
  icon: string | ExplainerVisualRef;
  aStart: number;
  aDur: number;
  chars?: Array<{ c: string; t: number }>;
  words?: ExplainerVoiceWord[];
}
export type TutorialVoiceLine = ExplainerVoiceLine;

export interface ExplainerVoiceShot {
  start: number;
  dur: number;
  lines: ExplainerVoiceLine[];
}
export type TutorialVoiceShot = ExplainerVoiceShot;

export interface ExplainerVoiceClip {
  start: number;
  dur: number;
  shots: ExplainerVoiceShot[];
}
export type TutorialVoiceClip = ExplainerVoiceClip;

export interface ExplainerVoiceData {
  voice: string;
  total: number;
  titleSafe: number;
  clipTail: number;
  lineGap: number;
  shotGap: number;
  clips: ExplainerVoiceClip[];
}
export type TutorialVoiceData = ExplainerVoiceData;

// ==========================================
// Timeline
// ==========================================

export const ExplainerTimelineSchema = z.object({
  version: z.string().default(EXPLAINER_STORYBOARD_VERSION),
  runId: z.string().default(''),
  videoId: z.string().default(''),
  topic: z.string().default(''),
  title: z.string().default(''),
  narrationLanguage: z.string().default('en'),
  resolution: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  fps: z.number().int().positive(),
  totalDurationSec: z.number().positive(),
  audioSrc: z.string().default('assets/narration.mp3'),
  meta: ExplainerMetaSchema.default({}),
  assets: z.array(ExplainerAssetSchema).default([]),
  clips: z.array(ExplainerClipSchema).default([]),
  voice: z.custom<ExplainerVoiceData>().optional(),
  /** Backward compatibility scenes array. */
  scenes: z.array(z.any()).optional(),
});
export type ExplainerTimeline = z.infer<typeof ExplainerTimelineSchema>;
export const TutorialTimelineSchema = ExplainerTimelineSchema;
export type TutorialTimeline = ExplainerTimeline;

// ==========================================
// Visual Reference Resolution Helper
// ==========================================

export interface ResolvedVisual {
  kind: 'video' | 'image' | 'chart' | 'icon';
  id: string;
  label?: string;
  asset?: ExplainerAsset;
  chartType?: ChartType;
  iconName?: string;
  data?: number[];
  fit?: 'cover' | 'contain';
}

export function resolveVisualRef(
  ref: ExplainerVisualRef,
  assets?: readonly ExplainerAsset[]
): ResolvedVisual {
  const assetMap = new Map((assets || []).map((a) => [a.id, a]));

  if (typeof ref === 'string') {
    if (CHART_TYPES.includes(ref as any)) {
      return { kind: 'chart', id: ref, chartType: ref as ChartType };
    }
    const asset = assetMap.get(ref);
    if (asset) {
      return {
        kind: asset.kind === 'video' ? 'video' : 'image',
        id: ref,
        asset,
        label: asset.label,
        fit: asset.kind === 'video' ? 'cover' : 'contain',
      };
    }
    return { kind: 'icon', id: ref, iconName: ref };
  }

  if (ref.kind === 'chart') {
    return {
      kind: 'chart',
      id: ref.name || 'bars',
      chartType: (ref.name as ChartType) || 'bars',
      data: ref.data,
      label: ref.label,
    };
  }
  if (ref.kind === 'video' || ref.kind === 'image') {
    const assetId = ref.assetId || '';
    const asset = assetMap.get(assetId);
    return {
      kind: ref.kind,
      id: assetId,
      asset,
      label: ref.label || asset?.label,
      fit: ref.fit || (ref.kind === 'video' ? 'cover' : 'contain'),
    };
  }
  return {
    kind: 'icon',
    id: ref.name || ref.assetId || 'shapes',
    iconName: ref.name || ref.assetId || 'shapes',
    label: ref.label,
  };
}

// ==========================================
// Schema Builder with Material / Icon Binding
// ==========================================

export function buildExplainerStoryboardSchema(params: {
  assetIds: ReadonlySet<string>;
  iconNames: ReadonlySet<string>;
}): z.ZodType<ExplainerStoryboard, z.ZodTypeDef, unknown> {
  const chartSet = new Set<string>(CHART_TYPES);

  const visualRefined = ExplainerVisualRefSchema.superRefine((val, ctx) => {
    if (typeof val === 'string') {
      if (chartSet.has(val) || params.assetIds.has(val) || params.iconNames.has(val)) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown visual reference "${val}" — must be a generated material id (video/image/screenshot), a lucide icon name, or a chart (bars/line/donut)`,
      });
      return;
    }

    if (val.kind === 'chart') {
      if (val.name && !chartSet.has(val.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['name'],
          message: `unknown chart type "${val.name}" — must be one of: ${CHART_TYPES.join(', ')}`,
        });
      }
      return;
    }

    if (val.kind === 'icon') {
      const name = val.name || val.assetId;
      if (!name || !params.iconNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['name'],
          message: `unknown lucide icon "${name}" — must be one of the provided lucide icon names`,
        });
      }
      return;
    }

    const assetId = val.assetId;
    if (!assetId || !params.assetIds.has(assetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: `unknown ${val.kind} asset "${assetId}" — must be one of the provided material ids`,
      });
    }
  });

  const elementSchema = z.tuple([
    z.string().min(1, 'element phrase must not be empty').refine(
      (text) => !/->|=>|→/.test(text),
      'arrow chains (->, =>, →) are banned from display copy — use short distinct phrases'
    ),
    visualRefined,
  ]);

  const shotSchema = z
    .object({
      id: z.string().min(1),
      elements: z.array(elementSchema).min(1, 'shot must carry at least 1 element'),
      narration: z.array(z.string().min(1)).min(1, 'shot must carry spoken narration matching elements'),
      camera: ExplainerCameraSchema.optional(),
    })
    .passthrough()
    .superRefine((shot, ctx) => {
      const raw = shot as any;
      for (const banned of ['duration', 'durationSec', 'minDurationSec', 'startSec', 'endSec']) {
        if (raw[banned] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [banned],
            message: `raw shot must not contain timing field "${banned}" — playback timing is derived from TTS`,
          });
        }
      }
    });

  const clipSchema = z
    .object({
      id: z.string().min(1),
      kicker: z.string().optional(),
      title: z.string().min(1, 'clip title is required'),
      subtitle: z.string().optional(),
      bg: z.string().default('#0A0A0B'),
      shots: z.array(shotSchema).min(1, 'clip must carry at least 1 shot'),
    })
    .passthrough()
    .superRefine((clip, ctx) => {
      const raw = clip as any;
      for (const banned of ['duration', 'durationSec', 'startSec', 'endSec']) {
        if (raw[banned] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [banned],
            message: `raw clip must not contain timing field "${banned}" — timing is derived from TTS`,
          });
        }
      }
    });

  return ExplainerStoryboardSchema.extend({
    clips: z.array(clipSchema).min(1, 'storyboard must carry at least 1 clip'),
  }) as z.ZodType<ExplainerStoryboard, z.ZodTypeDef, unknown>;
}
export const buildTutorialStoryboardSchema = buildExplainerStoryboardSchema;

// ==========================================
// Coverage & Validation Checks
// ==========================================

export function collectStoryboardCoverageErrors(
  storyboard: ExplainerStoryboard,
  materials?: readonly ExplainerAsset[]
): string[] {
  const errors: string[] = [];
  if (!materials || materials.length === 0) return errors;

  const used = new Map<string, number>();
  let totalVisualSlots = 0;

  for (const clip of storyboard.clips || []) {
    for (const shot of clip.shots || []) {
      for (const [, visualRef] of shot.elements || []) {
        totalVisualSlots += 1;
        const id = typeof visualRef === 'string' ? visualRef : visualRef.assetId || visualRef.name || '';
        if (id) {
          used.set(id, (used.get(id) || 0) + 1);
        }
      }
    }
  }

  // 1. Browser operation step screenshots coverage
  const browserSteps = materials.filter((m) => m.kind === 'image' && m.derivedFrom === 'browser-step');
  if (browserSteps.length > 0) {
    const shownBrowserSteps = browserSteps.filter((m) => used.has(m.id));
    if (shownBrowserSteps.length === 0) {
      errors.push(
        `visual coverage: at least one browser operation step screenshot (${browserSteps
          .map((m) => m.id)
          .join(', ')}) must appear in the explainer material`
      );
    }
  }

  // 2. Prompt materials coverage
  const promptGroups = new Map<number, ExplainerAsset[]>();
  for (const material of materials) {
    if (material.kind === 'prompt' && material.clipIndex != null) {
      const group = promptGroups.get(material.clipIndex) || [];
      group.push(material);
      promptGroups.set(material.clipIndex, group);
    }
  }
  for (const [clipIndex, group] of promptGroups) {
    const shown = group.some((material) => used.has(material.id));
    if (!shown) {
      errors.push(
        `visual coverage: clip ${clipIndex} prompt material(s) ${group
          .map((material) => material.id)
          .join(', ')} never shown — the explainer must display the actual generation prompts`
      );
    }
  }

  // 3. Generated clips coverage
  const clipGroups = new Map<number, ExplainerAsset[]>();
  for (const material of materials) {
    if ((material.kind === 'video' || material.kind === 'image') && material.clipIndex != null) {
      const group = clipGroups.get(material.clipIndex) || [];
      group.push(material);
      clipGroups.set(material.clipIndex, group);
    }
  }

  const unshownClips: number[] = [];
  for (const [clipIndex, group] of clipGroups) {
    const shown = group.some((m) => used.has(m.id));
    if (!shown) unshownClips.push(clipIndex);
  }

  if (unshownClips.length > 0 && totalVisualSlots >= Math.min(2, clipGroups.size)) {
    errors.push(
      `visual coverage: generated clip(s) ${unshownClips
        .map((c) => `clip-${String(c).padStart(3, '0')}`)
        .join(', ')} never shown — every generated clip must appear at least once across the scenes`
    );
  }

  return errors;
}

export function collectStoryboardDisplayErrors(storyboard: ExplainerStoryboard): string[] {
  const errors: string[] = [];
  const ARROW_PATTERN = /->|=>|→/;

  for (const clip of storyboard.clips || []) {
    if (clip.subtitle && ARROW_PATTERN.test(clip.subtitle)) {
      errors.push(`clip "${clip.title}" subtitle contains banned arrow characters`);
    }
    for (const shot of clip.shots || []) {
      for (const [phrase] of shot.elements || []) {
        if (ARROW_PATTERN.test(phrase)) {
          errors.push(`shot "${shot.id}" phrase "${phrase}" contains banned arrow characters`);
        }
      }
    }
  }

  return errors;
}

export function collectStoryboardRefErrors(
  storyboard: ExplainerStoryboard,
  materials?: readonly ExplainerAsset[]
): string[] {
  const errors: string[] = [];
  if (!materials) return errors;
  const assetIds = new Set(materials.map((m) => m.id));

  for (const clip of storyboard.clips || []) {
    for (const shot of clip.shots || []) {
      for (const [, visualRef] of shot.elements || []) {
        if (typeof visualRef !== 'string') {
          if (visualRef.promptAssetId && !assetIds.has(visualRef.promptAssetId)) {
            errors.push(`unknown prompt asset id "${visualRef.promptAssetId}" in shot "${shot.id}"`);
          }
        }
      }
    }
  }

  return errors;
}

// ==========================================
// Compatibility Helpers
// ==========================================

export function resolveChatbotPrompts(
  storyboard: ExplainerStoryboard,
  assets: readonly ExplainerAsset[]
): ExplainerStoryboard {
  const promptMap = new Map(
    assets.filter((a) => a.kind === 'prompt' && a.promptText).map((a) => [a.id, a.promptText!])
  );

  for (const clip of storyboard.clips || []) {
    for (const shot of clip.shots || []) {
      for (const element of shot.elements || []) {
        const visual = element[1];
        if (typeof visual === 'object' && visual.promptAssetId) {
          const text = promptMap.get(visual.promptAssetId);
          if (text) visual.botText = text;
        }
      }
    }
  }

  return storyboard;
}

export function clampThreeColumnWidths(widths: readonly number[]): number[] {
  if (widths.length !== 3) return [...widths];
  const min = 20;
  const total = widths.reduce((acc, width) => acc + width, 0);
  if (!(total > 0)) return [...widths];
  const out = widths.map((width) => (width / total) * 100);
  const fixed = [false, false, false];
  for (;;) {
    let fixedSum = 0;
    const free: number[] = [];
    let freeSum = 0;
    for (let i = 0; i < out.length; i += 1) {
      if (fixed[i]) fixedSum += out[i];
      else { free.push(i); freeSum += out[i]; }
    }
    if (free.length === 0) break;
    const budget = 100 - fixedSum;
    let clampedThisRound = false;
    for (const i of free) {
      const share = budget * (out[i] / freeSum);
      if (share < min && free.length > 1) {
        out[i] = min;
        fixed[i] = true;
        clampedThisRound = true;
      } else {
        out[i] = share;
      }
    }
    if (!clampedThisRound) break;
  }
  return out.map((width) => Math.round(width * 100) / 100);
}

export function clampSceneColumnWidths<T extends { widthPercent: number }>(
  columns: readonly T[] | undefined
): T[] | undefined {
  if (!columns || columns.length !== 3) return columns as T[] | undefined;
  const clamped = clampThreeColumnWidths(columns.map((column) => column.widthPercent));
  return columns.map((column, index) => ({ ...column, widthPercent: clamped[index] }));
}

export const PHRASE_GAP_SEC = 0.3;

export function firstPhraseEnd(words: readonly ExplainerWord[], minGapSec = PHRASE_GAP_SEC): number | null {
  if (words.length === 0) return null;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].t0 - words[i - 1].t1 >= minGapSec) return words[i - 1].t1;
  }
  return words[Math.min(2, words.length - 1)].t1;
}

export function lastPhraseStart(words: readonly ExplainerWord[], minGapSec = PHRASE_GAP_SEC): number | null {
  if (words.length === 0) return null;
  for (let i = words.length - 1; i >= 1; i -= 1) {
    if (words[i].t0 - words[i - 1].t1 >= minGapSec) return words[i].t0;
  }
  return words[Math.max(0, words.length - 3)].t0;
}

export function sceneDurationFromWords(
  words: readonly ExplainerWord[],
  fallbackSec: number,
  fps: number
): number {
  const lastWordEnd = words.reduce((acc, word) => Math.max(acc, word.t1), 0);
  const spokenSec = lastWordEnd > 0 ? lastWordEnd : fallbackSec;
  return Math.max(Math.ceil(spokenSec * fps) / fps, 1 / fps);
}

export const SubtitleChunkSchema = z.object({
  words: z.array(ExplainerWordSchema),
  t0: z.number().nonnegative(),
  t1: z.number().positive(),
});
export type SubtitleChunk = z.infer<typeof SubtitleChunkSchema>;

export const SUBTITLE_CHUNK_MAX_CHARS = 20;

const SENTENCE_END = /[。！？!?；;，,、…]$/;

export function buildSubtitleChunks(
  words: readonly ExplainerWord[],
  maxChars = SUBTITLE_CHUNK_MAX_CHARS
): SubtitleChunk[] {
  const chunks: SubtitleChunk[] = [];
  let current: ExplainerWord[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      words: [...current],
      t0: current[0].t0,
      t1: current[current.length - 1].t1,
    });
    current = [];
    chars = 0;
  };

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    current.push(word);
    chars += (word.word || '').replace(/\s+/g, '').length;
    const next = words[i + 1];
    const gapAfter = next ? next.t0 - word.t1 : Number.POSITIVE_INFINITY;
    const sentenceEnd = SENTENCE_END.test((word.word || '').trim());
    if (sentenceEnd || chars >= maxChars || gapAfter >= 0.6) {
      flush();
    }
  }
  flush();
  return chunks;
}

export interface ExplainerVideoSummary {
  status: 'completed' | 'failed';
  sceneCount: number;
  totalDurationSec: number;
  fps: number;
  resolution: { width: number; height: number };
  voice: string;
  rate: string;
  narrationLanguage: string;
  assetsCount: number;
  storyboardPath: string;
  gridPath: string;
  timelinePath: string;
  playerPath: string;
  narrationPath: string;
  hostScriptPath: string;
  videoPath: string;
  framesRendered: number;
  model?: string;
  error?: string;
  sceneOutline?: Array<{
    sceneId: string;
    type?: string;
    title: string;
    narration: string;
    titleCard?: any;
    columns?: any[];
  }>;
  clipOutline?: Array<{
    clipId: string;
    kicker?: string;
    title: string;
    subtitle?: string;
    shots: Array<{
      shotId: string;
      phrases: string[];
      visuals: string[];
      narration: string[];
    }>;
  }>;
}
export type TutorialGenerationSummary = ExplainerVideoSummary;
export type ExplainerGenerationSummary = ExplainerVideoSummary;

export type ExplainerRenderScene = any;
export type ExplainerScene = any;
export type ExplainerVisual = any;
export type ExplainerTitleCard = any;

export type TutorialRenderScene = any;
export type TutorialScene = any;
export type TutorialVisual = any;
export type TutorialTitleCard = any;
