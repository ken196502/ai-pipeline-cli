// Shot layout registry + shot/clip composition.
//
// Each layout is a self-contained renderer; `resolveLayout` picks one from the
// shot's visual refs. Variation (landscape compositions, prompt-card side) is
// a stable hash of the shot's position — never authored by the LLM.
//
// Timing contract: element j (phrase + its visual) appears
// `style.timing.phraseLead` seconds before the voice speaks the phrase
// (`voice.json` line.pStart), and the phrase is typed in while it is spoken.

import { env, cameraAt, componentFor, styleFor } from './env.js';
import { drawTitleCard } from './title.js';
import {
  drawFlashComponent,
  drawPromptCard,
  drawSubtitleBanner,
  drawVisualCell,
  refIsLandscape,
} from './components.js';
import { drawTypewriter, typeDuration } from './text.js';
import {
  clamp,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  hash1,
  hash32,
  lerp,
} from './util.js';

const SWAP = 0.5;
const REVEAL = 0.5;

function vKey(item) {
  if (!item) return '';
  return typeof item === 'string' ? item : item.assetId || item.name || '';
}

function elemTransform(side, enterK, exitK) {
  const dir = side === 'L' ? -1 : 1;
  const dist = 280 * env.S * dir;
  if (exitK != null) {
    const p = clamp(exitK, 0, 1);
    return {
      x: dist * easeInOutCubic(p),
      alpha: 1 - p,
      scale: lerp(1, 0.9, easeInOutCubic(p)),
    };
  }
  if (enterK != null) {
    const p = clamp(enterK, 0, 1);
    return { x: -dist * (1 - easeOutBack(p)), alpha: p, scale: lerp(0.9, 1, easeOutCubic(p)) };
  }
  return { x: 0, alpha: 1, scale: 1 };
}

function colScale(ctx, cx, cy, s, xoff) {
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);
  ctx.translate(xoff, 0);
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Per-element timing in shot-local seconds:
 *   lineStartRel(j)   when element j appears (phrase start − phraseLead)
 *   typeWindow(j)     { start, dur } typing window of the phrase
 *   sentenceWindow(j) { start, dur } the whole narration sentence
 */
function lineTimesFor(shot, tf, entries) {
  const n = entries.length;
  const timing = styleFor(tf.clipId, shot.id).timing;

  if (env.VOICE && shot.vLines) {
    const base = shot.vStart || 0;
    const lead = timing.phraseLead != null ? timing.phraseLead : 0.1;
    const startAbs = (j) => {
      const L = shot.vLines[j];
      if (!L) return 1e9;
      const p = L.pStart != null ? L.pStart : L.aStart;
      return p - lead;
    };
    return {
      lineStartRel: (j) => startAbs(j) - base,
      typeWindow: (j) => {
        const L = shot.vLines[j];
        if (!L) return { start: 1e9, dur: 0.5 };
        const s = startAbs(j);
        const pEnd = L.pEnd != null ? L.pEnd : L.aStart + Math.min(L.aDur || 0, 1.0);
        return { start: s - base, dur: clamp(pEnd - s, 0.25, 1.6) };
      },
      sentenceWindow: (j) => {
        const L = shot.vLines[j];
        if (!L) return { start: 1e9, dur: 1 };
        return { start: L.aStart - base, dur: Math.max(0.3, L.aDur || 0) };
      },
    };
  }

  const si = tf.si || 0;
  const titleWindow = timing.titleIn + timing.titleHold + timing.titleOut;
  const TITLE_SAFE = si === 0 ? Math.min(titleWindow + 0.15, timing.shotDur * 0.55) : 0;
  const LEAD = 0.18;
  const lead = TITLE_SAFE + LEAD * 0.5;
  const step = Math.max(0.05, (timing.shotDur - TITLE_SAFE - LEAD) / n);
  const tAt = (j) => lead + j * step;
  return {
    lineStartRel: (j) => tAt(j),
    typeWindow: (j) => ({ start: tAt(j), dur: typeDuration(entries[j][0], 0.3, Math.min(0.9, step)) }),
    sentenceWindow: (j) => ({ start: tAt(j), dur: step }),
  };
}

// ---------------------------------------------------------------------------
// Stable per-shot variation
// ---------------------------------------------------------------------------

let shotIndexMap = null;
function globalShotIndex(clipId, shotId) {
  if (!shotIndexMap) {
    shotIndexMap = new Map();
    let g = 0;
    env.clips.forEach((c) => c.shots.forEach((s) => shotIndexMap.set(c.id + '|' + s.id, g++)));
  }
  const v = shotIndexMap.get(clipId + '|' + shotId);
  return v != null ? v : 0;
}

function shotHash(g, salt) {
  return hash32(g * 2654435761 + salt * 97 + 11);
}

const LANDSCAPE_VARIANTS = ['split', 'stack', 'full'];
function landscapeVariant(clipId, shotId) {
  const cfg = (env.components && env.components.landscape) || {};
  const pool = (Array.isArray(cfg.variants) ? cfg.variants : LANDSCAPE_VARIANTS).filter(
    (v) => LANDSCAPE_VARIANTS.indexOf(v) >= 0
  );
  const variants = pool.length > 0 ? pool : LANDSCAPE_VARIANTS;
  const g = globalShotIndex(clipId, shotId);
  const pick = (gi) => shotHash(gi, 3) % variants.length;
  let v = pick(g);
  if (variants.length > 1 && g > 0 && v === pick(g - 1)) v = (v + 1) % variants.length;
  return variants[v];
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * Stacked phrase column. Each phrase slides in when its element appears and is
 * typed while the voice speaks it; the active phrase carries an accent bar.
 * region: { x0, maxEnd, cy }
 */
function drawPhraseColumn(ctx, a, region) {
  const { entries, jActive, typeWindow, tf } = a;
  const S = env.S;
  const PAL = env.PAL;
  const FONT = env.FONT;
  const sl = tf.sl;
  const n = entries.length;
  const x0 = region.x0;
  const markerW = 56 * S;
  const xText = x0 + markerW;
  const avail = Math.max(120 * S, region.maxEnd - xText);
  const targetW = Math.min(600 * S, avail * 0.92);
  const minF = 28 * S;
  const maxF = 70 * S;

  const styles = [];
  for (let j = 0; j < n; j++) {
    const text = entries[j][0];
    ctx.font = '600 ' + Math.round(100 * S) + 'px ' + FONT;
    const wRef = ctx.measureText(text).width || 1;
    let fs = clamp((targetW / wRef) * (100 * S), minF, maxF);
    fs = clamp(fs * (1 + (hash1(j * 7.3 + 1.7) - 0.5) * 0.2), minF, maxF);
    const weight = j % 2 === 0 ? 700 : 500;
    const indent = j % 2 === 1 ? 26 * S : 0;
    ctx.font = weight + ' ' + Math.round(fs) + 'px ' + FONT;
    const w = ctx.measureText(text).width;
    if (xText + indent + w > region.maxEnd) {
      fs = Math.max(14 * S, (fs * (region.maxEnd - xText - indent)) / w);
    }
    styles.push({ text, fs, weight, accentFirst: j % 2 === 1, indent });
  }

  const lineHs = styles.map((s) => s.fs * 1.34 + 10 * S);
  const totalH = lineHs.reduce((acc, b) => acc + b, 0);
  let yy = region.cy - totalH / 2;
  const cyArr = lineHs.map((lh) => {
    const c = yy + lh / 2 - 5 * S;
    yy += lh;
    return c;
  });

  // Rail
  ctx.save();
  ctx.globalAlpha *= 0.16;
  ctx.strokeStyle = PAL.graphite;
  ctx.lineWidth = 2 * S;
  ctx.beginPath();
  ctx.moveTo(x0 - 8 * S, cyArr[0]);
  ctx.lineTo(x0 - 8 * S, cyArr[cyArr.length - 1]);
  ctx.stroke();
  ctx.restore();

  for (let j = 0; j < styles.length; j++) {
    const win = typeWindow(j);
    const local = sl - win.start;
    if (local < -1e-6) continue;
    const s = styles[j];
    const cy = cyArr[j];
    const active = j === jActive;
    const inK = easeOutCubic(clamp(local / 0.35, 0, 1));
    const baseAlpha = clamp(local / 0.18, 0, 1) * (active ? 1 : 0.62);
    const slide = (1 - inK) * -34 * S;

    ctx.save();
    ctx.translate(slide, 0);
    ctx.globalAlpha *= baseAlpha;

    const num = String(j + 1).padStart(2, '0');
    ctx.font = '600 ' + Math.max(13 * S, s.fs * 0.26) + 'px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = active ? PAL.signal : PAL.graphite;
    ctx.fillText(num, x0, cy);

    const tx = xText + s.indent;
    if (active) {
      const barH = s.fs * 0.95 * inK;
      ctx.fillStyle = PAL.acid;
      ctx.fillRect(tx - 18 * S, cy - barH / 2, Math.max(2, 4 * S), barH);
    }

    const geo = drawTypewriter(ctx, s.text, tx, cy, {
      elapsed: local,
      dur: win.dur,
      font: s.weight + ' ' + Math.round(s.fs) + 'px ' + FONT,
      fs: s.fs,
      color: PAL.bone,
      accent: PAL.signal,
      highlightFirst: s.accentFirst,
      cursor: active,
    });

    ctx.globalAlpha *= active ? 0.55 : 0.2;
    ctx.strokeStyle = active ? PAL.signal : PAL.graphite;
    ctx.lineWidth = 2 * S;
    ctx.beginPath();
    ctx.moveTo(tx, cy + s.fs * 0.6);
    ctx.lineTo(tx + geo.typedWidth, cy + s.fs * 0.6);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Media slot with the visual-swap transition: the outgoing visual slides off
 * while the incoming one slides in; a fresh visual wipes open (reveal).
 */
function drawMediaSlot(ctx, a, cx, cy, cellOpts) {
  const { cur, prev, k, curStart, prevStart, tf, slotDur, syncPromiseQueue } = a;
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const sl = tf.sl;
  const opts = cellOpts || {};

  if (prev != null) {
    env.cellA.x.clearRect(0, 0, W, H);
    drawVisualCell(env.cellA.x, prev, cx, cy, sl - prevStart, slotDur - prevStart, syncPromiseQueue, opts);
    env.cellB.x.clearRect(0, 0, W, H);
    drawVisualCell(
      env.cellB.x,
      cur,
      cx,
      cy,
      sl - curStart,
      slotDur - curStart,
      syncPromiseQueue,
      Object.assign({}, opts, { reveal: clamp((sl - curStart) / REVEAL, 0, 1) })
    );

    ctx.save();
    ctx.globalAlpha *= 1 - k;
    ctx.translate(-120 * S * easeInOutCubic(k), 0);
    ctx.drawImage(env.cellA.c, 0, 0, W, H);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha *= k;
    ctx.translate(140 * S * (1 - easeOutBack(k)), 0);
    ctx.drawImage(env.cellB.c, 0, 0, W, H);
    ctx.restore();
    return;
  }

  const reveal = clamp((sl - curStart) / REVEAL, 0, 1);
  drawVisualCell(
    ctx,
    cur,
    cx,
    cy,
    sl - curStart,
    slotDur - curStart,
    syncPromiseQueue,
    Object.assign({}, opts, { reveal })
  );
}

/** Large single-phrase caption (stack / full landscape variants). */
function drawCaption(ctx, a, x, y, align, maxW, basePx) {
  const { entries, jActive, typeWindow, tf } = a;
  const S = env.S;
  const PAL = env.PAL;
  const text = entries[jActive] ? entries[jActive][0] : '';
  if (!text) return;
  const win = typeWindow(jActive);
  const local = tf.sl - win.start;
  if (local < 0) return;
  let fs = basePx;
  ctx.font = '700 ' + Math.round(fs) + 'px ' + env.FONT;
  const w = ctx.measureText(text).width;
  if (w > maxW) fs = Math.max(16 * S, (fs * maxW) / w);
  const font = '700 ' + Math.round(fs) + 'px ' + env.FONT;
  ctx.font = font;
  const fullW = ctx.measureText(text).width;
  const x0 = align === 'center' ? x - fullW / 2 : x;
  const inK = easeOutCubic(clamp(local / 0.3, 0, 1));

  ctx.save();
  ctx.globalAlpha *= clamp(local / 0.15, 0, 1);
  ctx.translate(0, (1 - inK) * 16 * S);

  const idx = String(jActive + 1).padStart(2, '0') + ' / ' + String(entries.length).padStart(2, '0');
  ctx.font = '700 ' + Math.round(15 * S) + 'px ' + env.FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PAL.signal;
  ctx.fillText(idx, x0, y - fs * 0.95);
  ctx.fillRect(x0 - 20 * S, y - fs * 0.48, Math.max(2, 4 * S), fs * 0.96 * inK);

  drawTypewriter(ctx, text, x0, y, {
    elapsed: local,
    dur: win.dur,
    font,
    fs,
    color: PAL.bone,
    accent: PAL.signal,
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layout: fullscreen flash montage component
// ---------------------------------------------------------------------------
function drawFlashLayout(ctx, a) {
  const { shot, tf, entries, jActive, sentenceWindow, slotDur, syncPromiseQueue } = a;
  const W = env.W;
  const H = env.H;
  const tr = elemTransform('R', tf.enterK, tf.exitK);
  const blockAlpha = elemTransform('L', tf.enterK, tf.exitK).alpha;

  ctx.save();
  ctx.globalAlpha *= blockAlpha * tr.alpha;
  colScale(ctx, W / 2, H / 2, tr.scale, tr.x);
  drawFlashComponent(ctx, W / 2, H / 2, tf.sl, slotDur, syncPromiseQueue, true);
  ctx.restore();

  const bannerEnabled = Boolean((env.components.subtitleBanner || {}).enabled);
  const activeSentence = (shot.narration && shot.narration[jActive]) || entries[jActive][0] || '';
  if (bannerEnabled && activeSentence) {
    const win = sentenceWindow(jActive);
    drawSubtitleBanner(ctx, activeSentence, blockAlpha, {
      elapsed: tf.sl - win.start + 0.1,
      dur: Math.min(win.dur * 0.85, typeDuration(activeSentence, 0.4, 2.2)),
    });
  }
}

// ---------------------------------------------------------------------------
// Layout: final AI video showcase component
// ---------------------------------------------------------------------------
function drawFinalShowcaseLayout(ctx, a) {
  const { shot, tf, entries, slotDur, syncPromiseQueue } = a;
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const style = styleFor(tf.clipId, shot.id);
  const cfg = style.components.finalShowcase || {};
  const refId = vKey(entries[0][1]);
  const component = componentFor(refId);
  const assetId = (component && component.assetId) || cfg.asset;

  const tr = elemTransform('R', tf.enterK, tf.exitK);
  const fcx = W / 2;
  const fcy = H / 2 + 18 * S;

  ctx.save();
  ctx.globalAlpha *= tr.alpha;
  colScale(ctx, fcx, fcy, tr.scale, tr.x);

  if (cfg.tag) {
    drawTypewriter(ctx, cfg.tag, fcx, 52 * S, {
      elapsed: tf.sl,
      dur: typeDuration(cfg.tag, 0.3, 0.9),
      font: '700 ' + Math.max(12, Math.round(18 * S)) + 'px ' + env.FONT,
      fs: 18 * S,
      color: PAL.signal,
      align: 'center',
      cursor: false,
    });
  }

  // The showcase video carries its own audio that starts with the shot, so
  // its playback clock is the shot-local time (not the element appear time).
  drawVisualCell(ctx, assetId, fcx, fcy, tf.sl, slotDur, syncPromiseQueue, {
    fullscreen: cfg.fit === 'cover',
    box: cfg.fit === 'cover' ? null : { maxW: W * 0.86, maxH: H * 0.8 },
    reveal: clamp(tf.sl / REVEAL, 0, 1),
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layout: prompt card + generated media (side by side, side alternates)
// ---------------------------------------------------------------------------
function resolveMediaForPrompt(pAsset, shotEntries) {
  const cIdx = pAsset ? pAsset.clipIndex : null;
  const pId = (pAsset && pAsset.id) || '';
  const isImgPrompt = /image/i.test(pId);
  const isVidPrompt = /video/i.test(pId);

  if (cIdx != null) {
    const pad = String(cIdx).padStart(3, '0');
    const imgKey = 'clip-' + pad + '-image';
    const vidKey = 'clip-' + pad + '-video';
    if (isVidPrompt && env.mediaElements.has(vidKey)) return vidKey;
    if (isImgPrompt && env.mediaElements.has(imgKey)) return imgKey;
    if (env.mediaElements.has(imgKey)) return imgKey;
    if (env.mediaElements.has(vidKey)) return vidKey;
  }

  for (let i = 0; i < shotEntries.length; i++) {
    const ref = vKey(shotEntries[i][1]);
    if (ref && env.mediaElements.has(ref) && !env.promptAssets.has(ref)) return ref;
  }

  const keys = Array.from(env.mediaElements.keys());
  for (let ki = 0; ki < keys.length; ki++) {
    if (keys[ki] !== 'final-ai-video') return keys[ki];
  }
  return null;
}

function drawPromptLayout(ctx, a) {
  const { shot, tf, entries, jActive, lineStartRel, typeWindow, cur, curStart, slotDur, syncPromiseQueue } = a;
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const sl = tf.sl;
  const tl = elemTransform('L', tf.enterK, tf.exitK);
  const tr = elemTransform('R', tf.enterK, tf.exitK);

  // Most recent prompt element up to the active one, and when it appeared.
  let promptKey = '';
  let promptStart = 0;
  let promptLabel = '';
  for (let j = 0; j <= jActive; j++) {
    const key = vKey(entries[j][1]);
    if (env.promptAssets.has(key) && key !== promptKey) {
      promptKey = key;
      promptStart = lineStartRel(j);
      promptLabel = typeof entries[j][1] === 'object' ? entries[j][1].label : '';
    }
  }
  const pAsset = env.promptAssets.get(promptKey);

  // Side media: the active visual when it is media, otherwise the prompt's own output.
  const curKey = vKey(cur);
  const curIsMedia = !env.promptAssets.has(curKey) && env.mediaElements.has(curKey);
  const sideMedia = curIsMedia ? curKey : resolveMediaForPrompt(pAsset, entries);
  const mediaStart = curIsMedia ? curStart : promptStart;
  const landscape = refIsLandscape(sideMedia);

  const g = globalShotIndex(tf.clipId, shot.id);
  const promptLeft = shotHash(g, 5) % 2 === 0;
  const promptCx = promptLeft ? W * 0.27 : W * 0.73;
  const mediaCx = promptLeft ? W * 0.72 : W * 0.28;
  const cy = H / 2 - 18 * S;
  const box = landscape ? { maxW: W * 0.46, maxH: H * 0.62 } : { maxW: W * 0.34, maxH: H * 0.72 };

  if (pAsset) {
    const local = sl - promptStart;
    const inK = easeOutCubic(clamp(local / 0.4, 0, 1));
    ctx.save();
    ctx.globalAlpha *= tl.alpha * clamp(local / 0.25, 0, 1);
    colScale(ctx, promptCx, cy, tl.scale, tl.x + (1 - inK) * (promptLeft ? -40 : 40) * S);
    drawPromptCard(ctx, pAsset, promptCx, cy, local, slotDur - promptStart, promptLabel);
    ctx.restore();
  }

  if (sideMedia) {
    ctx.save();
    ctx.globalAlpha *= tr.alpha;
    colScale(ctx, mediaCx, cy, tr.scale, tr.x);
    drawVisualCell(ctx, sideMedia, mediaCx, cy, sl - mediaStart, slotDur - mediaStart, syncPromiseQueue, {
      box,
      reveal: clamp((sl - mediaStart) / REVEAL, 0, 1),
    });
    ctx.restore();
  }

  const activePhrase = entries[jActive] ? entries[jActive][0] : '';
  if (activePhrase) {
    const win = typeWindow(jActive);
    drawSubtitleBanner(ctx, activePhrase, tl.alpha * clamp((sl - win.start) / 0.15, 0, 1), {
      elapsed: sl - win.start,
      dur: win.dur,
    });
  }
}

// ---------------------------------------------------------------------------
// Layout: landscape-led shot (split / stack / full, picked per shot)
// ---------------------------------------------------------------------------
function drawLandscapeLayout(ctx, a) {
  const { shot, tf } = a;
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const tl = elemTransform('L', tf.enterK, tf.exitK);
  const tr = elemTransform('R', tf.enterK, tf.exitK);
  const variant = landscapeVariant(tf.clipId, shot.id);
  env.trace.lastVariant = variant;

  if (variant === 'split') {
    ctx.save();
    ctx.globalAlpha *= tl.alpha;
    colScale(ctx, W * 0.22, H / 2, tl.scale, tl.x);
    drawPhraseColumn(ctx, a, { x0: 96 * S, maxEnd: W * 0.4, cy: H / 2 });
    ctx.restore();

    ctx.save();
    ctx.globalAlpha *= tl.alpha;
    colScale(ctx, W * 0.705, H / 2, tr.scale, tr.x);
    drawMediaSlot(ctx, a, W * 0.705, H / 2, { box: { maxW: W * 0.54, maxH: H * 0.66 } });
    ctx.restore();
    return;
  }

  if (variant === 'stack') {
    const my = H * 0.42;
    ctx.save();
    ctx.globalAlpha *= tl.alpha;
    colScale(ctx, W / 2, my, tr.scale, tr.x);
    drawMediaSlot(ctx, a, W / 2, my, { box: { maxW: W * 0.64, maxH: H * 0.6 } });
    ctx.restore();

    ctx.save();
    ctx.globalAlpha *= tl.alpha;
    drawCaption(ctx, a, W / 2, H * 0.86, 'center', W * 0.8, 44 * S);
    ctx.restore();
    return;
  }

  // full: fullscreen media + typed lower-third caption
  ctx.save();
  ctx.globalAlpha *= tl.alpha;
  colScale(ctx, W / 2, H / 2, tr.scale, tr.x);
  drawMediaSlot(ctx, a, W / 2, H / 2, { fullscreen: true });
  ctx.restore();

  ctx.save();
  ctx.globalAlpha *= tl.alpha;
  const g = ctx.createLinearGradient(0, H * 0.6, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.78)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.6, W, H * 0.4);
  drawCaption(ctx, a, W * 0.08, H * 0.86, 'left', W * 0.8, 46 * S);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Layout: standard two-column (stacked phrases + media cell)
// ---------------------------------------------------------------------------
function drawStandardLayout(ctx, a) {
  const { tf } = a;
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const tl = elemTransform('L', tf.enterK, tf.exitK);
  const tr = elemTransform('R', tf.enterK, tf.exitK);

  ctx.save();
  ctx.globalAlpha *= tl.alpha;
  colScale(ctx, 380 * S, H / 2, tl.scale, tl.x);
  drawPhraseColumn(ctx, a, { x0: 118 * S, maxEnd: Math.min(W * 0.48, W * 0.5 - 30 * S), cy: H / 2 });
  ctx.restore();

  const rcx = W * 0.72;
  ctx.save();
  ctx.globalAlpha *= tl.alpha;
  colScale(ctx, rcx, H / 2, tr.scale, tr.x);
  drawMediaSlot(ctx, a, rcx, H / 2, {});
  ctx.restore();
}

/** Layout registry — order matters (first matching layout wins). */
export const LAYOUTS = {
  flash: drawFlashLayout,
  finalShowcase: drawFinalShowcaseLayout,
  prompt: drawPromptLayout,
  landscape: drawLandscapeLayout,
  standard: drawStandardLayout,
};

/** Resolves which layout a shot uses from its element visual refs. */
export function resolveLayout(shot, entries) {
  const component = entries.map((e) => componentFor(vKey(e[1]))).find((c) => c && c.kind);
  if (component && component.kind === 'flash') return 'flash';
  if (component && component.kind === 'final-showcase') return 'finalShowcase';

  const first = entries[0][1];
  if (env.promptAssets.has(vKey(first))) return 'prompt';
  if (refIsLandscape(first)) return 'landscape';
  return 'standard';
}

export function drawShot(ctx, clip, shot, tf, syncPromiseQueue) {
  const entries = shot.elements || [];
  env.trace.shots += 1;
  const n = entries.length;
  if (n === 0) return;
  const sl = tf.sl;
  tf.clipId = clip.id;

  const times = lineTimesFor(shot, tf, entries);
  const { lineStartRel } = times;

  let jActive = -1;
  for (let j = 0; j < n; j++) if (sl >= lineStartRel(j)) jActive = j;
  if (jActive < 0) return;

  // Active visual + swap transition state (and when each visual appeared).
  let cur = entries[0][1];
  let curStart = lineStartRel(0);
  let prev = null;
  let prevStart = 0;
  let k = 1;
  for (let j = 1; j <= jActive; j++) {
    const ic = entries[j][1];
    if (vKey(ic) !== vKey(cur)) {
      const since = sl - lineStartRel(j);
      if (since < SWAP) {
        prev = cur;
        prevStart = curStart;
        k = since / SWAP;
      } else {
        prev = null;
        k = 1;
      }
      cur = ic;
      curStart = lineStartRel(j);
    }
  }

  const style = styleFor(clip.id, shot.id);
  const slotDur = env.VOICE && shot.vDur ? shot.vDur : style.timing.shotDur;
  const layoutName = resolveLayout(shot, entries);
  const layout = LAYOUTS[layoutName] || LAYOUTS.standard;
  env.trace.layouts[layoutName] = (env.trace.layouts[layoutName] || 0) + 1;
  env.trace.lastShot = { id: shot.id, n, jActive, sl, layoutName, cur: vKey(cur) };
  layout(ctx, {
    shot,
    tf,
    entries,
    jActive,
    lineStartRel,
    typeWindow: times.typeWindow,
    sentenceWindow: times.sentenceWindow,
    cur,
    curStart,
    prev,
    prevStart,
    k,
    slotDur,
    syncPromiseQueue,
  });
}

export function drawShotLayer(ctx, clip, si, sl, syncPromiseQueue) {
  const sh = clip.shots;
  const cur = sh[si];
  const style = styleFor(clip.id, cur.id);
  const timing = style.timing;
  const shotTrans = timing.shotTrans;
  const sd = env.VOICE && cur.vDur ? cur.vDur : timing.shotDur;
  let enterK = null;
  let exitK = null;
  if (sl < shotTrans) enterK = clamp(sl / shotTrans, 0, 1);
  else if (sl > sd - shotTrans) exitK = clamp((sl - (sd - shotTrans)) / shotTrans, 0, 1);
  if (si === sh.length - 1) exitK = null;

  drawShot(ctx, clip, cur, { sl, enterK, exitK, si }, syncPromiseQueue);

  if (exitK != null && si + 1 < sh.length && sl - sd < 0) {
    drawShot(ctx, clip, sh[si + 1], { sl: sl - sd, enterK: exitK, exitK: null, si: si + 1 }, syncPromiseQueue);
  }
}

export function locateInClip(clip, local) {
  const sh = clip.shots;
  if (env.VOICE && sh[0] && sh[0].vStart != null) {
    let si = 0;
    for (let i = 0; i < sh.length; i++) if (local >= sh[i].vStart - clip.vStart) si = i;
    return { si, sl: local - (sh[si].vStart - clip.vStart) };
  }
  const style = styleFor(clip.id, null);
  const shotDur = style.timing.shotDur;
  const si = Math.min(sh.length - 1, Math.floor(local / shotDur));
  return { si, sl: local - si * shotDur };
}

function applyCam(ctx, cam) {
  ctx.translate(env.W / 2, env.H / 2);
  ctx.rotate(cam.roll);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-env.W / 2 + cam.x, -env.H / 2 + cam.y);
}

export function drawContent(ctx, clip, local, syncPromiseQueue) {
  const loc = locateInClip(clip, local);
  const style = styleFor(clip.id, clip.shots[loc.si] && clip.shots[loc.si].id);
  const timing = style.timing;
  const ek = easeOutCubic(clamp(local / timing.clipTrans, 0, 1));
  const shotDur = env.VOICE && clip.shots[loc.si].vDur ? clip.shots[loc.si].vDur : timing.shotDur;
  const cam = cameraAt(clip.shots[loc.si], loc.si, clamp(loc.sl / shotDur, 0, 1), style);
  cam.zoom *= lerp(1.16, 1.0, ek);

  ctx.save();
  applyCam(ctx, cam);
  drawShotLayer(ctx, clip, loc.si, loc.sl, syncPromiseQueue);
  ctx.restore();

  drawTitleCard(ctx, clip, local);
}

