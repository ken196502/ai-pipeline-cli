// Visual components: charts, lucide icons, prompt terminal cards, the flash
// montage component, the final-showcase component and generic media cells.

import { env, styleFor } from './env.js';
import { loadIcon, promptTextFor, seekVideo } from './media.js';
import { drawTypewriter } from './text.js';
import {
  clamp,
  easeOutCubic,
  hash1,
  hexA,
  lineGap,
  rr,
  tokenize,
} from './util.js';

const CHART_DEFAULTS = {
  bars: [4, 7, 5, 9, 6],
  line: [3, 6, 4, 8, 5, 9],
  donut: [40, 25, 20, 15],
};

export function drawChart(ctx, it, x, y, size) {
  const S = env.S;
  const PAL = env.PAL;
  const FONT = env.FONT;
  const data = it.data || CHART_DEFAULTS[it.chart] || [4, 7, 5, 9, 6];
  ctx.save();
  ctx.translate(x, y);

  rr(ctx, -size / 2, -size / 2, size, size, 16 * S);
  ctx.fillStyle = hexA(PAL.ink2, 0.85);
  ctx.fill();
  ctx.strokeStyle = hexA(PAL.graphite, 0.4);
  ctx.lineWidth = 2 * S;
  ctx.stroke();

  const pad = 24 * S;
  const w = size - pad * 2;
  const h = size - pad * 2;
  ctx.save();
  ctx.translate(-w / 2, -h / 2);
  const max = Math.max.apply(Math, data.concat([1]));

  if (it.chart === 'bars') {
    const gap = w / data.length;
    const bw = gap * 0.65;
    data.forEach((v, i) => {
      const bh = h * (v / max);
      const bx = i * gap + (gap - bw) / 2;
      ctx.fillStyle = i === data.length - 1 ? PAL.acid : PAL.signal;
      rr(ctx, bx, h - bh, bw, bh, 4 * S);
      ctx.fill();
    });
  } else if (it.chart === 'line') {
    ctx.strokeStyle = PAL.signal;
    ctx.lineWidth = 3 * S;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    data.forEach((v, i) => {
      const px = (i / (data.length - 1)) * w;
      const py = h - h * (v / max);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
    data.forEach((v, i) => {
      const px = (i / (data.length - 1)) * w;
      const py = h - h * (v / max);
      ctx.fillStyle = PAL.ember;
      ctx.beginPath();
      ctx.arc(px, py, 4 * S, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (it.chart === 'donut') {
    const sum = data.reduce((a, b) => a + b, 0) || 1;
    const palette = [PAL.signal, PAL.ember, PAL.ash, PAL.graphite];
    let a0 = -Math.PI / 2;
    const R = (Math.min(w, h) / 2) * 0.92;
    data.forEach((v, i) => {
      const a1 = a0 + (v / sum) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2);
      ctx.arc(w / 2, h / 2, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = palette[i % palette.length];
      ctx.fill();
      a0 = a1;
    });
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, R * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = PAL.ink;
    ctx.fill();
  }
  ctx.restore();

  if (it.label) {
    ctx.fillStyle = PAL.ash;
    ctx.font = '500 ' + Math.round(18 * S) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.label, 0, size / 2 + 24 * S);
  }
  ctx.restore();
}

/** HUD corner brackets around a centred w×h rect (cyber frame accent). */
export function drawCornerBrackets(ctx, w, h, color, alpha, len, gap) {
  const S = env.S;
  const L = len != null ? len : 22 * S;
  const g = gap != null ? gap : 8 * S;
  const x0 = -w / 2 - g;
  const y0 = -h / 2 - g;
  const x1 = w / 2 + g;
  const y1 = h / 2 + g;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 2.2 * S);
  ctx.beginPath();
  ctx.moveTo(x0, y0 + L);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0 + L, y0);
  ctx.moveTo(x1 - L, y0);
  ctx.lineTo(x1, y0);
  ctx.lineTo(x1, y0 + L);
  ctx.moveTo(x1, y1 - L);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - L, y1);
  ctx.moveTo(x0 + L, y1);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x0, y1 - L);
  ctx.stroke();
  ctx.restore();
}

export function drawLucide(ctx, name, x, y, size, label) {
  const S = env.S;
  const PAL = env.PAL;
  const color = PAL.bone;
  const rec = loadIcon(name, color);
  const tile = size * 1.45;
  ctx.save();
  ctx.translate(x, y);

  rr(ctx, -tile / 2, -tile / 2, tile, tile, 22 * S);
  ctx.fillStyle = hexA(PAL.ink2, 0.78);
  ctx.fill();
  ctx.strokeStyle = hexA(PAL.graphite, 0.4);
  ctx.lineWidth = 1.5 * S;
  ctx.stroke();
  drawCornerBrackets(ctx, tile, tile, env.ACCENT, 0.85, 20 * S, 6 * S);

  ctx.save();
  ctx.shadowColor = hexA(env.ACCENT, 0.55);
  ctx.shadowBlur = 18 * S;
  if (rec.loaded && rec.img) {
    ctx.drawImage(rec.img, -size / 2, -size / 2, size, size);
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * S;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
  }
  ctx.restore();

  if (label) {
    ctx.fillStyle = PAL.ash;
    ctx.font = '500 ' + Math.round(18 * S) + 'px ' + env.FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, tile / 2 + 30 * S);
  }
  ctx.restore();
}

// Word-wrap prompt text: space-delimited text wraps by word, CJK-dominant text
// wraps by character.
function wrapPromptText(ctx, text, maxW) {
  const lines = [];
  String(text)
    .split('\n')
    .forEach((para) => {
      if (!para.trim()) {
        lines.push('');
        return;
      }
      const tokens = /\s/.test(para) ? para.split(/\s+/) : Array.from(para);
      let cur = '';
      tokens.forEach((tk) => {
        const sep = /\s/.test(para) && cur ? ' ' : '';
        const candidate = cur + sep + tk;
        if (cur && ctx.measureText(candidate).width > maxW) {
          lines.push(cur);
          cur = tk;
        } else {
          cur = candidate;
        }
      });
      if (cur) lines.push(cur);
    });
  return lines;
}

/**
 * Prompt material card: terminal-style panel showing the actual generation
 * prompt. Long texts auto-scroll vertically over the shot — scroll progress is
 * a pure function of the shot-local time so interactive preview and headless
 * frame-by-frame rendering stay pixel-identical.
 */
export function drawPromptCard(ctx, asset, cx, cy, sl, slotDur, outerLabel) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const FONT = env.FONT;
  const id = (asset && asset.id) || '';
  const text = promptTextFor(id) || 'missing prompt text for "' + id + '"';
  const kind = /image-prompt/i.test(id)
    ? 'IMAGE PROMPT'
    : /video-prompt/i.test(id)
      ? 'VIDEO PROMPT'
      : /narration/i.test(id)
        ? 'VOICEOVER SCRIPT'
        : 'PROMPT';
  const rawLabel = (asset && asset.label) || outerLabel || id;
  const title =
    String(rawLabel)
      .replace(/\s*\([^)]*(?:[Pp]rompt|旁白)[^)]*\)\s*$/, '')
      .trim() || id;

  const cardW = Math.min(660 * S, W * 0.34);
  const cardH = Math.min(760 * S, H * 0.7);
  const headerH = 60 * S;
  const padX = 30 * S;
  const fontPx = Math.max(13, Math.round(19 * S));
  const lineH = Math.round(fontPx * 1.55);

  ctx.save();
  ctx.translate(cx, cy);

  rr(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 20 * S);
  ctx.fillStyle = 'rgba(13, 14, 17, 0.93)';
  ctx.fill();
  ctx.strokeStyle = hexA(PAL.signal, 0.38);
  ctx.lineWidth = 2 * S;
  ctx.stroke();

  const hy = -cardH / 2 + headerH / 2;
  ctx.beginPath();
  ctx.arc(-cardW / 2 + padX, hy, 5 * S, 0, Math.PI * 2);
  ctx.fillStyle = PAL.signal;
  ctx.fill();

  ctx.font = '700 ' + Math.max(10, Math.round(15 * S)) + 'px ' + FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PAL.ember;
  ctx.fillText(kind, -cardW / 2 + padX + 16 * S, hy);

  const kindW = ctx.measureText(kind).width;
  ctx.font = '600 ' + Math.max(11, Math.round(17 * S)) + 'px ' + FONT;
  ctx.fillStyle = PAL.bone;
  const titleX = -cardW / 2 + padX + 16 * S + kindW + 18 * S;
  const maxTitleW = cardW - (titleX + cardW / 2) - padX - (asset && asset.clipIndex ? 110 * S : 0);
  let t = title;
  while (t && ctx.measureText(t).width > maxTitleW && t.length > 1) {
    t = t.slice(0, -2).trim() + '…';
  }
  ctx.fillText(t, titleX, hy);

  if (asset && asset.clipIndex) {
    const chip = 'CLIP ' + asset.clipIndex;
    ctx.font = '700 ' + Math.max(10, Math.round(13 * S)) + 'px ' + FONT;
    const cw = ctx.measureText(chip).width + 22 * S;
    rr(ctx, cardW / 2 - padX - cw, hy - 13 * S, cw, 26 * S, 13 * S);
    ctx.fillStyle = hexA(PAL.signal, 0.16);
    ctx.fill();
    ctx.strokeStyle = hexA(PAL.ember, 0.5);
    ctx.lineWidth = 1.5 * S;
    ctx.stroke();
    ctx.fillStyle = PAL.ember;
    ctx.fillText(chip, cardW / 2 - padX - cw + 11 * S, hy);
  }

  ctx.strokeStyle = hexA(PAL.graphite, 0.35);
  ctx.lineWidth = 1.5 * S;
  ctx.beginPath();
  ctx.moveTo(-cardW / 2 + padX, -cardH / 2 + headerH);
  ctx.lineTo(cardW / 2 - padX, -cardH / 2 + headerH);
  ctx.stroke();

  const bodyTop = -cardH / 2 + headerH + 6 * S;
  const bodyH = cardH - headerH - 18 * S;
  const bodyW = cardW - padX * 2 - 18 * S;
  ctx.font =
    '500 ' + fontPx + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  const lines = wrapPromptText(ctx, text, bodyW);
  const contentH = lines.length * lineH;
  const maxScroll = Math.max(0, contentH - bodyH + lineH * 0.5);

  // Terminal typing: the prompt is typed in and the view follows the cursor.
  // `sl` is the time since the card appeared, so typing always starts fresh.
  const totalChars = lines.reduce((acc, l) => acc + Array.from(l).length, 0) || 1;
  const typeStart = 0.2;
  const twCfg = (env.components && env.components.typewriter) || {};
  const baseCps = twCfg.cps > 0 ? twCfg.cps * 2 : 84;
  const cps = Math.max(baseCps, totalChars / Math.max(0.6, slotDur * 0.75 - typeStart));
  const typed = clamp((sl - typeStart) * cps, 0, totalChars);
  let cursorLine = lines.length - 1;
  let cursorFrac = 1;
  let cum = 0;
  const visibleChars = lines.map(() => 0);
  for (let li = 0; li < lines.length; li++) {
    const n = Array.from(lines[li]).length;
    if (typed >= cum + n && li < lines.length - 1) {
      visibleChars[li] = n;
      cum += n;
      continue;
    }
    visibleChars[li] = Math.min(n, Math.floor(typed - cum));
    cursorLine = li;
    cursorFrac = n > 0 ? clamp((typed - cum) / n, 0, 1) : 1;
    break;
  }
  const cursorY = (cursorLine + cursorFrac) * lineH;
  const offsetY = clamp(cursorY - bodyH * 0.7, 0, maxScroll);
  const scrollP = maxScroll > 0 ? offsetY / maxScroll : 0;
  const typingDone = typed >= totalChars;

  ctx.save();
  rr(ctx, -cardW / 2 + padX * 0.6, bodyTop, cardW - padX * 1.2, bodyH, 8 * S);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const missing = text.indexOf('missing prompt text') === 0;
  let cursorX = -cardW / 2 + padX;
  let cursorLy = bodyTop + lineH / 2;
  for (let li = 0; li < lines.length; li += 1) {
    const ly = bodyTop + li * lineH + lineH / 2 - offsetY;
    const shownN = visibleChars[li];
    if (shownN <= 0 && li > cursorLine) break;
    const shown = Array.from(lines[li]).slice(0, shownN).join('');
    if (li === cursorLine) {
      cursorX = -cardW / 2 + padX + ctx.measureText(shown).width;
      cursorLy = ly;
    }
    if (ly < bodyTop - lineH || ly > bodyTop + bodyH + lineH) continue;
    ctx.fillStyle = missing ? PAL.ember : hexA(PAL.bone, 0.92);
    ctx.fillText(shown, -cardW / 2 + padX, ly);
  }
  const blinkOn = !typingDone || Math.floor((sl - typeStart - totalChars / cps) * 2.6) % 2 === 0;
  if (sl > typeStart && blinkOn) {
    ctx.fillStyle = PAL.signal;
    ctx.fillRect(cursorX + 2 * S, cursorLy - fontPx * 0.5, fontPx * 0.55, fontPx);
  }
  ctx.restore();

  if (maxScroll > 0) {
    const trackX = cardW / 2 - padX * 0.6 - 4 * S;
    const trackY = bodyTop + 4 * S;
    const trackH = bodyH - 8 * S;
    rr(ctx, trackX, trackY, 4 * S, trackH, 2 * S);
    ctx.fillStyle = hexA(PAL.graphite, 0.3);
    ctx.fill();
    const thumbH = Math.max(24 * S, trackH * (bodyH / contentH));
    const thumbY = trackY + (trackH - thumbH) * scrollP;
    rr(ctx, trackX, thumbY, 4 * S, thumbH, 2 * S);
    ctx.fillStyle = hexA(PAL.ember, 0.85);
    ctx.fill();
  }

  ctx.restore();
}

// Fullscreen box for landscape media (contain + a little padding).
const FULLSCREEN_FIT_W = 0.94;
const FULLSCREEN_FIT_H = 0.9;
export function fitFullscreen(ar) {
  const boxW = env.W * FULLSCREEN_FIT_W;
  const boxH = env.H * FULLSCREEN_FIT_H;
  if (!(ar > 0)) ar = 16 / 9;
  if (boxW / boxH >= ar) return { w: boxH * ar, h: boxH };
  return { w: boxW, h: boxW / ar };
}

export function refAspect(ref) {
  const id = typeof ref === 'string' ? ref : ref ? ref.assetId || ref.name : '';
  const entry = env.mediaElements.get(id);
  if (!entry) return null;
  if (entry.kind === 'video') {
    const v = entry.el;
    return v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : null;
  }
  if (entry.kind === 'image') {
    const im = entry.el;
    return im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : null;
  }
  return null;
}

export function refIsLandscape(ref) {
  const ar = refAspect(ref);
  return ar != null && ar > 1.0 + 1e-6;
}

function componentBorderColor(spec) {
  if (!spec || spec === 'accent') return env.ACCENT;
  return spec;
}

/**
 * `component:flash` — full-screen rapid montage of the pool selected by
 * `style.components.flash.pool`. Interval / punch / shutter / border / badge all
 * come from the style document.
 */
export function drawFlashComponent(ctx, cx, cy, sl, slotDur, syncPromiseQueue, fullscreen) {
  const S = env.S;
  const PAL = env.PAL;
  const FONT = env.FONT;
  const cfg = env.components.flash || {};
  const pool = env.flashPool;
  if (pool.length === 0) return false;

  const interval = cfg.interval > 0 ? cfg.interval : 0.2;
  const punch = cfg.punch != null ? cfg.punch : 0.04;
  const shutter = cfg.shutter != null ? cfg.shutter : 0.22;
  const borderColor = componentBorderColor(cfg.border);

  const rawIdx = Math.floor(sl / interval);
  const curIdx = rawIdx % pool.length;
  const subProgress = (sl % interval) / interval;
  const img = pool[curIdx].el;

  const fAR = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9;
  let fw;
  let fh;
  if (fullscreen) {
    const fFit = fitFullscreen(fAR);
    fw = fFit.w;
    fh = fFit.h;
  } else {
    const maxFlashW = Math.min(env.W * 0.42, 680 * S);
    const maxFlashH = env.H * 0.72;
    if (fAR >= maxFlashW / maxFlashH) {
      fw = maxFlashW;
      fh = maxFlashW / fAR;
    } else {
      fh = maxFlashH;
      fw = maxFlashH * fAR;
    }
  }

  ctx.save();
  ctx.translate(cx, cy);

  const punchScale = 1.0 + (1 - easeOutCubic(subProgress)) * punch;
  ctx.scale(punchScale, punchScale);

  rr(ctx, -fw / 2, -fh / 2, fw, fh, 16 * S);
  ctx.fillStyle = PAL.ink2;
  ctx.fill();

  ctx.save();
  rr(ctx, -fw / 2, -fh / 2, fw, fh, 16 * S);
  ctx.clip();
  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, -fw / 2, -fh / 2, fw, fh);
  } else {
    ctx.fillStyle = hexA(PAL.ink2, 0.9);
    ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
  }

  if (subProgress < shutter) {
    const cutAlpha = (1 - subProgress / shutter) * 0.22;
    ctx.fillStyle = 'rgba(255, 255, 255, ' + cutAlpha + ')';
    ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
  }
  ctx.restore();

  ctx.strokeStyle = hexA(borderColor, 0.6);
  ctx.lineWidth = 2 * S;
  rr(ctx, -fw / 2, -fh / 2, fw, fh, 16 * S);
  ctx.stroke();

  if (cfg.badge !== false) {
    ctx.save();
    const badgeText =
      'FLASH · ' +
      String(curIdx + 1).padStart(2, '0') +
      '/' +
      String(pool.length).padStart(2, '0');
    ctx.font = '700 ' + Math.round(12 * S) + 'px ' + FONT;
    const btw = ctx.measureText(badgeText).width + 20 * S;
    rr(ctx, fw / 2 - btw - 14 * S, -fh / 2 + 14 * S, btw, 24 * S, 12 * S);
    ctx.fillStyle = hexA(PAL.ink, 0.88);
    ctx.fill();
    ctx.strokeStyle = hexA(borderColor, 0.7);
    ctx.stroke();
    ctx.fillStyle = borderColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, fw / 2 - btw / 2 - 14 * S, -fh / 2 + 26 * S);
    ctx.restore();
  }

  ctx.restore();
  return true;
}

/** Contain-fit an aspect ratio into a maxW × maxH box. */
export function fitBox(ar, maxW, maxH) {
  if (!(ar > 0)) ar = 16 / 9;
  if (maxW / maxH >= ar) return { w: maxH * ar, h: maxH };
  return { w: maxW, h: maxW / ar };
}

function normalizeCellOpts(opts) {
  if (opts === true) return { fullscreen: true };
  if (!opts) return {};
  return opts;
}

/** Media tag chip at the bottom of a frame. */
function drawMediaTag(ctx, text, h, dotColor) {
  const S = env.S;
  const PAL = env.PAL;
  ctx.font = '600 ' + Math.round(14 * S) + 'px ' + env.FONT;
  const tw = ctx.measureText(text).width + 30 * S;
  rr(ctx, -tw / 2, h / 2 - 38 * S, tw, 26 * S, 13 * S);
  ctx.fillStyle = 'rgba(10, 10, 11, 0.85)';
  ctx.fill();
  ctx.strokeStyle = hexA(dotColor, 0.4);
  ctx.lineWidth = 1.5 * S;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-tw / 2 + 14 * S, h / 2 - 25 * S, 3.5 * S, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();
  ctx.fillStyle = PAL.bone;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, -tw / 2 + 24 * S, h / 2 - 25 * S);
}

/**
 * Framed media (already translated to the cell centre): rounded plate, the
 * media itself, thin border, HUD corner brackets. `reveal` (0..1) wipes the
 * frame open top→bottom behind an accent scan line.
 */
function drawMediaFrame(ctx, el, ready, w, h, reveal) {
  const S = env.S;
  const PAL = env.PAL;
  const r = clamp(reveal, 0, 1);
  const k = easeOutCubic(r);
  ctx.save();
  if (r < 1) {
    ctx.beginPath();
    ctx.rect(-w / 2 - 20 * S, -h / 2 - 20 * S, w + 40 * S, (h + 40 * S) * k);
    ctx.clip();
  }
  rr(ctx, -w / 2, -h / 2, w, h, 18 * S);
  ctx.fillStyle = PAL.ink2;
  ctx.fill();
  ctx.save();
  rr(ctx, -w / 2, -h / 2, w, h, 18 * S);
  ctx.clip();
  if (ready) ctx.drawImage(el, -w / 2, -h / 2, w, h);
  ctx.restore();
  ctx.strokeStyle = hexA(PAL.graphite, 0.45);
  ctx.lineWidth = 2 * S;
  rr(ctx, -w / 2, -h / 2, w, h, 18 * S);
  ctx.stroke();
  drawCornerBrackets(ctx, w, h, env.ACCENT, 0.9);
  ctx.restore();

  if (r > 0 && r < 1) {
    const y = -h / 2 - 20 * S + (h + 40 * S) * k;
    const g = ctx.createLinearGradient(0, y - 22 * S, 0, y + 2 * S);
    g.addColorStop(0, hexA(env.ACCENT, 0));
    g.addColorStop(1, hexA(env.ACCENT, 0.7 * (1 - r)));
    ctx.fillStyle = g;
    ctx.fillRect(-w / 2 - 20 * S, y - 22 * S, w + 40 * S, 24 * S);
  }
}

/**
 * Generic media cell (video / image / chart / prompt / icon).
 * Component refs are dispatched before this function is reached.
 *
 * `vt` is the time since this visual appeared (videos play from their start,
 * prompt cards start typing fresh). `opts`:
 *   true | { fullscreen }           → fullscreen contain fit
 *   { box: { maxW, maxH } }         → contain fit into that box
 *   { reveal: 0..1 }                → wipe-in progress (default 1)
 */
export function drawVisualCell(ctx, visualRef, cx, cy, vt, slotDur, syncPromiseQueue, opts) {
  const S = env.S;
  const PAL = env.PAL;
  const o = normalizeCellOpts(opts);
  const reveal = o.reveal != null ? o.reveal : 1;
  const id = typeof visualRef === 'string' ? visualRef : visualRef.assetId || visualRef.name || '';
  const label = typeof visualRef === 'object' ? visualRef.label : '';
  const sizeFor = (ar, defW, defH, defBoxW, defBoxH) => {
    if (o.fullscreen) return fitFullscreen(ar);
    if (o.box) return fitBox(ar, o.box.maxW, o.box.maxH);
    if (!(ar > 0)) return { w: defW, h: defH };
    return fitBox(ar, defBoxW, defBoxH);
  };

  if (id === 'bars' || id === 'line' || id === 'donut') {
    ctx.save();
    ctx.globalAlpha *= easeOutCubic(clamp(reveal, 0, 1));
    const size = o.box ? Math.min(o.box.maxW, o.box.maxH) * 0.8 : 320 * S;
    drawChart(ctx, { chart: id, data: visualRef.data, label: label }, cx, cy, size);
    ctx.restore();
    return;
  }

  const entry = env.mediaElements.get(id);

  if (entry && entry.kind === 'video') {
    const video = entry.el;
    const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : null;
    const landscape = ar != null && ar > 1;
    const size = sizeFor(
      ar,
      440 * S * Math.min(1, (env.W * 0.34) / (440 * S), (env.H * 0.74) / (780 * S)),
      780 * S * Math.min(1, (env.W * 0.34) / (440 * S), (env.H * 0.74) / (780 * S)),
      landscape ? env.W * 0.4 : env.W * 0.34,
      env.H * 0.74
    );

    const dur = video.duration || 4;
    const rate = visualRef.playbackRate || 1;
    const targetT = (Math.max(0, vt) * rate) % dur;

    if (syncPromiseQueue && Math.abs(video.currentTime - targetT) > 0.02) {
      syncPromiseQueue.push(seekVideo(video, targetT));
    } else if (
      !syncPromiseQueue &&
      env.playing &&
      !video.seeking &&
      Math.abs(video.currentTime - targetT) > 0.08
    ) {
      Promise.resolve().then(() => seekVideo(video, targetT));
    }

    ctx.save();
    ctx.translate(cx, cy);
    drawMediaFrame(ctx, video, video.readyState >= 2, size.w, size.h, reveal);
    if (reveal >= 1) drawMediaTag(ctx, label || 'AI VIDEO · ' + id, size.h, PAL.signal);
    ctx.restore();
    return;
  }

  if (entry && entry.kind === 'image') {
    const img = entry.el;
    const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.0;
    const size = sizeFor(ar, 0, 0, Math.min(env.W * 0.42, 740 * S), env.H * 0.78);
    ctx.save();
    ctx.translate(cx, cy);
    drawMediaFrame(ctx, img, img.complete && img.naturalWidth > 0, size.w, size.h, reveal);
    // Only draw a custom label when explicitly given; never a default tag.
    const isKeyframeTag = !label || label === 'KEYFRAME IMAGE' || label === 'OPERATION STEP';
    if (!isKeyframeTag && reveal >= 1) drawMediaTag(ctx, label, size.h, PAL.ember);
    ctx.restore();
    return;
  }

  if (env.promptAssets.has(id)) {
    ctx.save();
    ctx.globalAlpha *= easeOutCubic(clamp(reveal, 0, 1));
    drawPromptCard(ctx, env.promptAssets.get(id), cx, cy, vt, slotDur, label);
    ctx.restore();
    return;
  }

  ctx.save();
  const rk = easeOutCubic(clamp(reveal, 0, 1));
  ctx.globalAlpha *= rk;
  ctx.translate(cx, cy);
  ctx.scale(0.85 + 0.15 * rk, 0.85 + 0.15 * rk);
  drawLucide(ctx, id || 'shapes', 0, 0, 200 * S, label);
  ctx.restore();
}

/**
 * Floating bottom subtitle banner used by the flash + prompt layouts. With
 * `typing` ({ elapsed, dur }) the text is typed in; the pill keeps its final
 * width so it does not grow while typing.
 */
export function drawSubtitleBanner(ctx, text, alpha, typing) {
  if (!text) return;
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const bannerY = H - 54 * S;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const font = '600 ' + Math.max(13, Math.round(18 * S)) + 'px ' + env.FONT;
  ctx.font = font;
  const bw = ctx.measureText(text).width + 64 * S;
  const bh = 38 * S;
  rr(ctx, W / 2 - bw / 2, bannerY - bh / 2, bw, bh, 19 * S);
  ctx.fillStyle = hexA(PAL.ink, 0.92);
  ctx.fill();
  ctx.strokeStyle = hexA(env.ACCENT, 0.55);
  ctx.lineWidth = 1.5 * S;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(W / 2 - bw / 2 + 20 * S, bannerY, 4 * S, 0, Math.PI * 2);
  ctx.fillStyle = env.ACCENT;
  ctx.fill();

  if (typing) {
    drawTypewriter(ctx, text, W / 2 - bw / 2 + 32 * S, bannerY, {
      elapsed: typing.elapsed,
      dur: typing.dur,
      font,
      fs: 18 * S,
      color: PAL.bone,
      cursor: false,
      scramble: 2,
    });
  } else {
    ctx.fillStyle = PAL.bone;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2 - bw / 2 + 32 * S, bannerY);
  }
  ctx.restore();
}

export { hash1, lineGap, tokenize };
