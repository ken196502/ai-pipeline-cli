// Shared runtime state + style resolution.
//
// Everything the engine needs is read from the four independent data blocks
// embedded in the player HTML: content (clips), style, voice (timing) and
// assets. Nothing is hardcoded here — theme, timing, components, camera motion,
// transitions and post-processing all come from style.json.

import { clamp, hash1 } from './util.js';

export const env = {
  W: 1920,
  H: 1080,
  S: 1.5,
  FONT: 'Inter, system-ui, sans-serif',
  PAL: {},
  ACCENT: '#FF4D12',
  config: { meta: { design: { w: 1920, h: 1080 } }, clips: [] },
  style: null,
  voice: null,
  assetList: [],
  promptTexts: {},
  iconData: {},

  clips: [],
  N: 0,
  playDur: [],
  total: 0,
  VOICE: false,
  AUDIO: null,

  shotDur: 4.2,
  shotTrans: 0.8,
  clipTrans: 1.0,
  titleIn: 0.55,
  titleHold: 1.1,
  titleOut: 0.55,

  post: {},
  camera: {},
  components: {},
  transitions: {},
  renderer: 'canvas2d',

  canvas: null,
  scene: null,
  glow: null,
  bufCur: null,
  bufNxt: null,
  bufNxtBG: null,
  cellA: null,
  cellB: null,

  mediaElements: new Map(),
  promptAssets: new Map(),
  iconCache: new Map(),
  flashPool: [],

  playing: false,
  time: 0,
  showSubtitles: false,
  lastLoc: { ci: 0, si: 0 },
  warnings: [],
  trace: { shots: 0, layouts: {}, lastShot: null },
};

export function readDataBlock(id) {
  const el = document.getElementById(id);
  return el ? el.textContent : null;
}

export function readJsonBlock(id, fallback) {
  const raw = readDataBlock(id);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    env.warnings.push(`failed to parse #${id}: ${err && err.message ? err.message : err}`);
    return fallback;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge used for style overrides (arrays replace). */
export function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(patch)) return out;
  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value === undefined) return;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value);
    else if (Array.isArray(value)) out[key] = value.slice();
    else out[key] = value;
  });
  return out;
}

/**
 * Effective style for a clip/shot: base style + `clip:<id>` + `shot:<id>`
 * overrides. Cached because drawShot runs on every frame.
 */
const overrideCache = new Map();
export function styleFor(clipId, shotId) {
  const base = env.style;
  if (!base) return null;
  const overrides = base.overrides || {};
  const clipPatch = clipId ? overrides['clip:' + clipId] : null;
  const shotPatch = shotId ? overrides['shot:' + shotId] : null;
  if (!clipPatch && !shotPatch) return base;

  const key = String(clipId) + '|' + String(shotId);
  const cached = overrideCache.get(key);
  if (cached) return cached;

  let resolved = base;
  if (clipPatch) resolved = mergeDeep(resolved, clipPatch);
  if (shotPatch) resolved = mergeDeep(resolved, shotPatch);
  overrideCache.set(key, resolved);
  return resolved;
}

export function legacyComponent(refId) {
  if (!refId) return null;
  if (refId === 'component:flash') return 'flash';
  if (refId === 'component:final-showcase') return 'final-showcase';
  if (refId === 'flash' || refId === 'xhot-candidate-grid' || refId === 'candidate-grid') return 'flash';
  if (refId.indexOf('flash:') === 0) return 'flash';
  if (refId === 'final-ai-video') return 'final-showcase';
  return null;
}

export function componentFor(refId) {
  const kind = legacyComponent(refId);
  if (!kind) return null;
  const components = env.components || {};
  if (kind === 'flash') {
    return { kind: 'flash', config: components.flash || {} };
  }
  const cfg = components.finalShowcase || {};
  // `component:final-showcase` has no asset id of its own: the style declares it.
  const assetId = refId === 'component:final-showcase' ? cfg.asset : refId;
  return { kind: 'final-showcase', config: cfg, assetId };
}

export function isComponent(refId, kind) {
  const resolved = legacyComponent(refId);
  return resolved === kind;
}

/**
 * Deterministic 2D camera for a shot. `style.camera.mode` selects the source:
 *   auto-drift → zoom/pan/roll derived from the shot index inside the style range
 *   static     → identity
 *   script     → the per-shot values from overrides (legacy migrated cameras)
 */
export function cameraAt(shot, shotIndex, progress, style) {
  const cam = (style && style.camera) || env.camera;
  const mode = cam.mode || 'auto-drift';
  if (mode === 'static') return { zoom: 1, x: 0, y: 0, roll: 0 };

  if (mode === 'script') {
    const a = shot && shot.camera ? shot.camera : { zoom: 1, x: 0, y: 0, roll: 0 };
    return {
      zoom: a.zoom != null ? a.zoom : 1,
      x: (a.x != null ? a.x : 0) * env.S,
      y: (a.y != null ? a.y : 0) * env.S,
      roll: a.roll != null ? a.roll : 0,
    };
  }

  const range = cam.zoomRange || [1.0, 1.06];
  const driftPx = cam.driftPx != null ? cam.driftPx : 18;
  const rollMax = cam.rollMax != null ? cam.rollMax : 0.01;
  const seed = hash1((shotIndex + 1) * 7.3 + 1.7);
  const seed2 = hash1((shotIndex + 1) * 3.1 + 4.4);
  const seed3 = hash1((shotIndex + 1) * 5.9 + 2.2);
  const zoomFrom = range[0] + (range[1] - range[0]) * seed;
  const zoomTo = range[0] + (range[1] - range[0]) * (1 - seed);
  const p = clamp(progress, 0, 1);
  return {
    zoom: zoomFrom + (zoomTo - zoomFrom) * p,
    x: (seed2 - 0.5) * 2 * driftPx * env.S * p,
    y: (seed3 - 0.5) * 2 * driftPx * env.S * p,
    roll: (seed - 0.5) * 2 * rollMax * p,
  };
}
