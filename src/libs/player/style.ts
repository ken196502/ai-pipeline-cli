/**
 * Explainer *effect* configuration (style.json) — fully independent from the
 * storyboard *content* (storyboard.json).
 *
 *   storyboard.json  LLM-authored content: chapters, shots, phrases, narration.
 *                    No colours, fonts, durations, cameras or transitions.
 *   style.json       Human-authored look & feel: theme, typography, timing,
 *                    components, camera motion, transitions, post-processing.
 *   voice.json       TTS-derived timing (aStart/aDur/words), never written back
 *                    into the storyboard.
 *
 * Merge priority (low → high):
 *   built-in defaults < preset (xhot / flowTutor) < run-directory style.json
 *   < CLI overrides (--style <path>, --transition <name>) < per-clip/shot overrides.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const EXPLAINER_STYLE_VERSION = '1';

const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour like #0B0F19');

export const ExplainerThemeSchema = z.object({
  bg: HexColorSchema.default('#0A0A0B'),
  ink2: HexColorSchema.default('#151517'),
  accent: HexColorSchema.default('#FF4D12'),
  palette: z
    .object({
      bone: HexColorSchema.default('#EEE9DF'),
      ash: HexColorSchema.default('#9C978F'),
      graphite: HexColorSchema.default('#5E5B57'),
      ember: HexColorSchema.default('#FF8A3D'),
      blood: HexColorSchema.default('#C21D0B'),
      acid: HexColorSchema.default('#D8FF3C'),
    })
    .default({}),
  font: z
    .string()
    .default('"D-DIN Exp", "D-DIN", Inter, "Segoe UI", system-ui, -apple-system, sans-serif'),
});
export type ExplainerTheme = z.infer<typeof ExplainerThemeSchema>;

export const ExplainerTimingSchema = z.object({
  /** Chapter title card in / hold / out. The single source of truth (C9). */
  titleIn: z.number().nonnegative().default(0.55),
  titleHold: z.number().nonnegative().default(1.1),
  titleOut: z.number().nonnegative().default(0.55),
  /** Extra silence after the title card before the first spoken line. */
  titleSafePad: z.number().nonnegative().default(0.1),
  lineGap: z.number().nonnegative().default(0.12),
  shotGap: z.number().nonnegative().default(0.18),
  clipTail: z.number().nonnegative().default(0.5),
  /** Fallback shot duration when no voice track exists (preview only). */
  shotDur: z.number().positive().default(4.2),
  shotTrans: z.number().nonnegative().default(0.8),
  clipTrans: z.number().positive().default(1.0),
  /**
   * Seconds an element (phrase + its visual) appears BEFORE the voice speaks
   * the phrase. The phrase position comes from voice.json `pStart`.
   */
  phraseLead: z.number().nonnegative().default(0.1),
});
export type ExplainerTiming = z.infer<typeof ExplainerTimingSchema>;

export const ExplainerFlashComponentSchema = z.object({
  /** Rapid cut interval in seconds. */
  interval: z.number().positive().default(0.2),
  /** Punch-in zoom amount applied at each cut. */
  punch: z.number().nonnegative().default(0.04),
  /** Shutter highlight duration (fraction of the interval). */
  shutter: z.number().min(0).max(1).default(0.22),
  /** Border colour: 'accent' follows the theme, or an explicit hex. */
  border: z.string().default('accent'),
  /** Asset selector: 'tag:<name>' or 'all-images'. */
  pool: z.string().default('tag:candidate'),
  badge: z.boolean().default(true),
});

export const ExplainerFinalShowcaseComponentSchema = z.object({
  tag: z.string().default('FINAL AI VIDEO SHOWCASE'),
  /** 'source' = the asset already carries its own audio (no TTS over it). */
  audio: z.enum(['source', 'none']).default('source'),
  /** Asset id played by the component. */
  asset: z.string().default('final-ai-video'),
  fit: z.enum(['contain', 'cover']).default('contain'),
});

export const TITLE_CARD_LAYOUTS = ['center', 'editorial', 'hud'] as const;
export const LANDSCAPE_VARIANTS = ['split', 'stack', 'full'] as const;

export const ExplainerTitleCardComponentSchema = z.object({
  /**
   * Chapter title-card layouts the player picks from. The pick is a stable
   * pseudo-random function of (seed, clip index), never two identical layouts
   * in a row, and never authored by the LLM.
   */
  layouts: z.array(z.enum(TITLE_CARD_LAYOUTS)).min(1).default([...TITLE_CARD_LAYOUTS]),
  seed: z.number().int().default(5),
});

export const ExplainerLandscapeComponentSchema = z.object({
  /**
   * How a shot led by landscape media is composed:
   *   split → phrase column + media on the other side
   *   stack → media on top, the active phrase typed underneath
   *   full  → fullscreen media with a typed lower-third caption
   * Picked per shot (stable hash), adjacent shots differ.
   */
  variants: z.array(z.enum(LANDSCAPE_VARIANTS)).min(1).default([...LANDSCAPE_VARIANTS]),
});

export const ExplainerTypewriterComponentSchema = z.object({
  /** Characters per second for text that is not voice-synced (titles, prompt cards). */
  cps: z.number().positive().default(42),
  /** Number of scrambled "decoding" glyphs shown ahead of the typing cursor. */
  scramble: z.number().int().nonnegative().default(3),
  cursor: z.boolean().default(true),
});

export const ExplainerComponentsSchema = z.object({
  flash: ExplainerFlashComponentSchema.default({}),
  finalShowcase: ExplainerFinalShowcaseComponentSchema.default({}),
  subtitleBanner: z.object({ enabled: z.boolean().default(false) }).default({}),
  titleCard: ExplainerTitleCardComponentSchema.default({}),
  landscape: ExplainerLandscapeComponentSchema.default({}),
  typewriter: ExplainerTypewriterComponentSchema.default({}),
});
export type ExplainerComponents = z.infer<typeof ExplainerComponentsSchema>;

export const ExplainerCameraStyleSchema = z.object({
  /** auto-drift: deterministic motion from the shot index; static: none; script: per-shot overrides. */
  mode: z.enum(['auto-drift', 'static', 'script']).default('auto-drift'),
  zoomRange: z.tuple([z.number().positive(), z.number().positive()]).default([1.0, 1.06]),
  rollMax: z.number().nonnegative().default(0.01),
  /** Horizontal / vertical drift in design pixels. */
  driftPx: z.number().nonnegative().default(18),
});
export type ExplainerCameraStyle = z.infer<typeof ExplainerCameraStyleSchema>;

export const ExplainerTransitionChannelSchema = z.object({
  /** sequence: rotate through the pool; seed: pseudo-random by seed; fixed: always pool[0]. */
  mode: z.enum(['sequence', 'seed', 'fixed']).default('sequence'),
  pool: z.array(z.string().min(1)).default([]),
  seed: z.number().int().default(7),
  /** Extra shader uniforms forwarded to the transition (e.g. amplitude). */
  params: z.record(z.string(), z.number()).default({}),
});
export type ExplainerTransitionChannel = z.infer<typeof ExplainerTransitionChannelSchema>;

export const ExplainerTransitionsSchema = z.object({
  clip: ExplainerTransitionChannelSchema.default({
    mode: 'sequence',
    pool: ['directionalWarp', 'lumaGlitch', 'radialBloom'],
    seed: 7,
    params: {},
  }),
  shot: z.object({ type: z.string().default('conveyor') }).default({}),
  visualSwap: z.object({ type: z.string().default('slide-fade') }).default({}),
});
export type ExplainerTransitions = z.infer<typeof ExplainerTransitionsSchema>;

export const ExplainerPostSchema = z.object({
  renderer: z.enum(['webgl', 'canvas2d']).default('webgl'),
  halation: z.number().nonnegative().default(0),
  halationTint: HexColorSchema.default('#FF2E0A'),
  grain: z.number().nonnegative().default(0.05),
  chromaticAberration: z.number().nonnegative().default(0),
  vignette: z.number().min(0).max(1).default(0.35),
  contrast: z.number().positive().default(1.05),
});
export type ExplainerPost = z.infer<typeof ExplainerPostSchema>;

export const ExplainerBackgroundSchema = z.object({
  /**
   * cyber → pre-rendered cyberspace plate (sky, nebula, skyline, horizon) +
   *         a cheap animated perspective grid / data streams on top.
   * plain → flat radial gradient (cheapest).
   */
  mode: z.enum(['cyber', 'plain']).default('cyber'),
  /** Opacity multiplier of the animated floor grid. */
  grid: z.number().min(0).max(2).default(1),
  /** Floor grid scroll speed (grid rows per second). */
  speed: z.number().nonnegative().default(0.35),
  /** Plate brightness multiplier (keep low so copy stays readable). */
  brightness: z.number().min(0).max(2).default(1),
  seed: z.number().int().default(9),
});
export type ExplainerBackground = z.infer<typeof ExplainerBackgroundSchema>;

const ExplainerStyleShapeSchema = z.object({
  theme: ExplainerThemeSchema,
  timing: ExplainerTimingSchema,
  components: ExplainerComponentsSchema,
  camera: ExplainerCameraStyleSchema,
  transitions: ExplainerTransitionsSchema,
  post: ExplainerPostSchema,
  background: ExplainerBackgroundSchema,
});

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly any[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** Deep-partial patch of the whole style document (used by presets and overrides). */
export type ExplainerStylePatch = DeepPartial<Omit<ExplainerStyleShape, 'version'>> & {
  version?: string;
};

/** Runtime validator for a single `overrides` entry (merged, then validated). */
export const ExplainerStylePatchSchema = z.record(z.string(), z.any());

export const ExplainerStyleSchema = z.object({
  version: z.string().default(EXPLAINER_STYLE_VERSION),
  /** Optional preset name this style was derived from (documentation only). */
  extends: z.string().optional(),
  theme: ExplainerThemeSchema.default({}),
  timing: ExplainerTimingSchema.default({}),
  components: ExplainerComponentsSchema.default({}),
  camera: ExplainerCameraStyleSchema.default({}),
  transitions: ExplainerTransitionsSchema.default({}),
  post: ExplainerPostSchema.default({}),
  background: ExplainerBackgroundSchema.default({}),
  /** Local overrides keyed by `clip:<id>` or `shot:<id>`. */
  overrides: z.record(z.string(), z.any()).default({}),
});
export type ExplainerStyle = z.infer<typeof ExplainerStyleSchema>;
type ExplainerStyleShape = z.infer<typeof ExplainerStyleShapeSchema>;

/** Fully-resolved style (all defaults applied, overrides still separate). */
export function defaultStyle(): ExplainerStyle {
  return ExplainerStyleSchema.parse({});
}

// ==========================================
// Built-in presets
// ==========================================

export interface ExplainerStylePreset {
  name: string;
  description: string;
  patch: ExplainerStylePatch;
}

/**
 * Presets are *templates*: they live in code (and are copied to
 * `src/libs/player/styles/<name>.json` for reference) and are always merged on
 * top of the built-in defaults.
 */
export const EXPLAINER_STYLE_PRESETS: Readonly<Record<string, ExplainerStylePreset>> = {
  'ember-dark': {
    name: 'ember-dark',
    description: 'Warm ember/ink documentary look (default, flowTutor).',
    patch: {
      theme: {
        bg: '#0A0A0B',
        ink2: '#151517',
        accent: '#FF4D12',
        palette: {
          bone: '#EEE9DF',
          ash: '#9C978F',
          graphite: '#5E5B57',
          ember: '#FF8A3D',
          blood: '#C21D0B',
          acid: '#D8FF3C',
        },
      },
      components: { flash: { border: 'accent', pool: 'tag:candidate' } },
      transitions: {
        clip: {
          mode: 'sequence',
          pool: ['directionalWarp', 'lumaGlitch', 'radialBloom'],
          seed: 7,
          params: {},
        },
      },
      post: { halation: 0, halationTint: '#FF2E0A', grain: 0.05, chromaticAberration: 0 },
    },
  },
  'cyan-tech': {
    name: 'cyan-tech',
    description: 'Cold neon-cyan tech look (xhot).',
    patch: {
      theme: {
        bg: '#0B0F19',
        ink2: '#121826',
        accent: '#00F0FF',
        palette: {
          bone: '#E8F4FF',
          ash: '#8FA3BF',
          graphite: '#4A5A73',
          ember: '#37C6FF',
          blood: '#FF3B6B',
          acid: '#9CFF3C',
        },
      },
      components: {
        flash: { border: '#00F0FF', pool: 'tag:candidate' },
        subtitleBanner: { enabled: true },
      },
      transitions: {
        clip: {
          mode: 'sequence',
          pool: ['lumaGlitch', 'crossZoom', 'directionalWarp'],
          seed: 11,
          params: {},
        },
      },
      post: { halation: 0, halationTint: '#00A6FF', grain: 0.035, chromaticAberration: 0 },
    },
  },
  'apple-clean': {
    name: 'apple-clean',
    description: 'Restrained neutral typography with almost no post grain.',
    patch: {
      theme: {
        bg: '#101014',
        ink2: '#1A1A1F',
        accent: '#F5F5F7',
        palette: {
          bone: '#F5F5F7',
          ash: '#A1A1A6',
          graphite: '#6E6E73',
          ember: '#D6D6DB',
          blood: '#FF453A',
          acid: '#30D158',
        },
        font: '"SF Pro Display", "Helvetica Neue", Inter, system-ui, sans-serif',
      },
      camera: { mode: 'static' },
      transitions: {
        clip: { mode: 'fixed', pool: ['dreamyZoom'], seed: 3, params: {} },
      },
      post: { halation: 0, halationTint: '#FFFFFF', grain: 0.015, vignette: 0.18, contrast: 1.02, chromaticAberration: 0 },
    },
  },
};

export function resolvePresetName(name: string): string {
  return name.startsWith('preset:') ? name.slice('preset:'.length) : name;
}

export function hasPreset(name: string): boolean {
  return Boolean(EXPLAINER_STYLE_PRESETS[resolvePresetName(name)]);
}

// ==========================================
// Deep merge
// ==========================================

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges patches left→right. Arrays are replaced, not concatenated. */
export function deepMergeStyle<T>(base: T, ...patches: Array<any>): T {
  let out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const patch of patches) {
    if (!isPlainObject(patch)) continue;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = deepMergeStyle(out[key], value);
      } else if (Array.isArray(value)) {
        out[key] = [...value];
      } else {
        out[key] = value;
      }
    }
  }
  return out as T;
}

// ==========================================
// Loading & resolving
// ==========================================

export interface LoadStyleOptions {
  /** Preset name, 'preset:<name>', JSON file path, or an inline style object. */
  input?: string | ExplainerStylePatch | ExplainerStyle | null;
  /** Extra patches applied after `input` (CLI flags, pipeline defaults). */
  patches?: ExplainerStylePatch[];
  /** Base directory used to resolve relative JSON paths. */
  baseDir?: string;
}

/**
 * Resolves the effective style: defaults → preset → file/inline input → patches.
 * Throws loudly on an unknown preset or an unreadable/invalid style file.
 */
export async function loadStyle(options: LoadStyleOptions = {}): Promise<ExplainerStyle> {
  let style = defaultStyle();
  const { input, patches = [], baseDir } = options;

  if (input && typeof input === 'object') {
    style = deepMergeStyle(style, input as any);
    if ((input as ExplainerStyle).extends) {
      style = deepMergeStyle(style, styleFromPreset((input as ExplainerStyle).extends!));
    }
  } else if (typeof input === 'string' && input.length > 0) {
    if (input.startsWith('preset:') || hasPreset(input)) {
      style = deepMergeStyle(style, styleFromPreset(input));
    } else {
      const filePath = path.isAbsolute(input) ? input : path.resolve(baseDir || process.cwd(), input);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf-8');
      } catch (err: any) {
        throw new Error(`cannot read style file "${filePath}": ${err?.message || err}`);
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (err: any) {
        throw new Error(`style file "${filePath}" is not valid JSON: ${err?.message || err}`);
      }
      const base = parsed?.extends ? styleFromPreset(parsed.extends) : {};
      style = deepMergeStyle(style, base, parsed);
    }
  }

  for (const patch of patches) {
    if (patch) style = deepMergeStyle(style, patch);
  }

  return ExplainerStyleSchema.parse(style);
}

/**
 * Reads a style *patch* (file or inline object) without merging the built-in
 * defaults, so it can be layered on top of a pipeline preset without silently
 * resetting the preset's values.
 */
export async function readStylePatch(
  input: string | ExplainerStylePatch | ExplainerStyle,
  baseDir?: string
): Promise<ExplainerStylePatch> {
  if (input && typeof input === 'object') {
    return input as ExplainerStylePatch;
  }
  const filePath = path.isAbsolute(input) ? input : path.resolve(baseDir || process.cwd(), input);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    throw new Error(`cannot read style file "${filePath}": ${err?.message || err}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`style file "${filePath}" is not valid JSON: ${err?.message || err}`);
  }
  if (parsed && typeof parsed === 'object' && parsed.extends) {
    const { extends: extendsName, ...rest } = parsed;
    const base = resolvePresetName(String(extendsName));
    const preset = EXPLAINER_STYLE_PRESETS[base];
    if (!preset) {
      throw new Error(
        `style file "${filePath}" extends unknown preset "${extendsName}" — available: ${Object.keys(EXPLAINER_STYLE_PRESETS).join(', ')}`
      );
    }
    return deepMergeStyle(preset.patch as any, rest) as ExplainerStylePatch;
  }
  return parsed as ExplainerStylePatch;
}

/** Resolves a preset patch into a full style (defaults + preset). */
export function styleFromPreset(name: string): ExplainerStyle {
  const key = resolvePresetName(name);
  const preset = EXPLAINER_STYLE_PRESETS[key];
  if (!preset) {
    throw new Error(
      `unknown style preset "${name}" — available: ${Object.keys(EXPLAINER_STYLE_PRESETS).join(', ')}`
    );
  }
  return deepMergeStyle(defaultStyle(), preset.patch);
}

/**
 * Applies `clip:<id>` then `shot:<id>` overrides from the style document.
 * Returns the base style unchanged when no override matches.
 */
export function applyOverrides(
  style: ExplainerStyle,
  ids: { clipId?: string; shotId?: string } = {}
): ExplainerStyle {
  const patches: ExplainerStylePatch[] = [];
  if (ids.clipId) {
    const patch = style.overrides[`clip:${ids.clipId}`];
    if (patch) patches.push(patch);
  }
  if (ids.shotId) {
    const patch = style.overrides[`shot:${ids.shotId}`];
    if (patch) patches.push(patch);
  }
  if (patches.length === 0) return style;
  const { overrides: _overrides, ...rest } = style;
  return deepMergeStyle(rest, ...patches) as ExplainerStyle;
}

/** Title-card window in seconds — the TTS title-safe silence derives from this. */
export function resolveTitleSafe(timing: ExplainerTiming): number {
  return round3(timing.titleIn + timing.titleHold + timing.titleOut + timing.titleSafePad);
}

/** Deterministic transition selection for clip N. */
export function pickClipTransition(
  style: ExplainerStyle,
  clipIndex: number,
  totalClips: number
): string {
  const channel = style.transitions.clip;
  const pool = channel.pool.length > 0 ? channel.pool : ['directionalWarp'];
  if (pool.length === 1) return pool[0];
  if (channel.mode === 'fixed') return pool[0];
  if (channel.mode === 'sequence') {
    // Clip 0 enters with a fixed "opening" transition so the very first frame
    // never shows the last chapter (see P0/B1).
    return pool[clipIndex % pool.length];
  }
  // seed: deterministic pseudo-random, stable across runs.
  const seed = channel.seed + clipIndex * 2654435761 + totalClips * 40503;
  return pool[Math.abs(hash32(seed)) % pool.length];
}

function hash32(n: number): number {
  let x = n | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ==========================================
// Component (magic-id) resolution
// ==========================================

export type ExplainerComponentKind = 'flash' | 'final-showcase';

export interface ResolvedComponent {
  component: ExplainerComponentKind;
  /** Asset the component plays (final-showcase only). */
  assetId?: string;
  /** True when the original visualRef was a legacy magic id. */
  legacy: boolean;
  originalRef: string;
}

const LEGACY_FLASH_IDS = new Set(['flash', 'xhot-candidate-grid', 'candidate-grid']);
const LEGACY_FINAL_IDS = new Set(['final-ai-video']);

/**
 * Maps a visualRef id to a component declaration.
 *
 * New scripts write `component:flash` / `component:final-showcase`; legacy magic
 * ids keep working and are flagged so callers can emit one deprecation warning.
 */
export function resolveComponentRef(
  refId: string,
  style: ExplainerStyle
): ResolvedComponent | null {
  if (!refId) return null;
  if (refId === 'component:flash') return { component: 'flash', legacy: false, originalRef: refId };
  if (refId === 'component:final-showcase') {
    return {
      component: 'final-showcase',
      assetId: style.components.finalShowcase.asset,
      legacy: false,
      originalRef: refId,
    };
  }
  if (LEGACY_FLASH_IDS.has(refId) || refId.startsWith('flash:')) {
    return { component: 'flash', legacy: true, originalRef: refId };
  }
  if (LEGACY_FINAL_IDS.has(refId)) {
    return {
      component: 'final-showcase',
      assetId: refId,
      legacy: true,
      originalRef: refId,
    };
  }
  return null;
}

/** Whether a shot's visualRef resolves to the given component. */
export function isComponentRef(refId: string, component: ExplainerComponentKind): boolean {
  return (
    refId === `component:${component}` ||
    (component === 'flash' && (LEGACY_FLASH_IDS.has(refId) || refId.startsWith('flash:'))) ||
    (component === 'final-showcase' && LEGACY_FINAL_IDS.has(refId))
  );
}

/** Minimal style payload embedded in the player HTML. */
export function styleForRuntime(
  style: ExplainerStyle,
  extras: { backgroundPlate?: string | null } = {}
): Record<string, unknown> {
  return {
    version: style.version,
    theme: style.theme,
    timing: style.timing,
    components: style.components,
    camera: style.camera,
    transitions: style.transitions,
    post: style.post,
    background: { ...style.background, plate: extras.backgroundPlate ?? null },
    overrides: style.overrides,
  };
}
