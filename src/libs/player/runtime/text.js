// Deterministic text effects: typewriter with a scrambled "decoding" tail and
// a block cursor, and a per-glyph decode-resolve. Every function is a pure
// function of the elapsed time, so seek(t) stays pixel-identical.

import { env } from './env.js';
import { clamp, easeOutCubic, hash32 } from './util.js';

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+<>/=_';
const SCRAMBLE_FPS = 24;

function glyphFor(seed) {
  return GLYPHS[hash32(seed) % GLYPHS.length];
}

function isBlank(ch) {
  return /\s/.test(ch);
}

/** Stable integer seed for a string (so every phrase scrambles differently). */
export function textSeed(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function typewriterCfg() {
  return (env.components && env.components.typewriter) || {};
}

/** Default typing duration for `text` at the style's characters-per-second. */
export function typeDuration(text, minDur, maxDur) {
  const cps = typewriterCfg().cps > 0 ? typewriterCfg().cps : 42;
  const n = Array.from(String(text || '')).length;
  return clamp(n / cps, minDur != null ? minDur : 0.2, maxDur != null ? maxDur : 2.4);
}

/**
 * Typewriter state at `elapsed` seconds into a `dur`-second reveal.
 * Returns the fully typed prefix and a scrambled tail of the next glyphs.
 */
export function typewriterState(text, elapsed, dur, scrambleOverride) {
  const chars = Array.from(String(text || ''));
  const n = chars.length;
  const scramble = scrambleOverride != null ? scrambleOverride : typewriterCfg().scramble != null ? typewriterCfg().scramble : 3;
  if (elapsed <= 0 || n === 0) return { typed: '', tail: '', count: 0, n, done: n === 0, doneAt: dur };
  const p = dur > 0 ? clamp(elapsed / dur, 0, 1) : 1;
  const count = Math.min(n, Math.floor(p * n + 1e-6));
  const tailN = count < n ? Math.min(scramble, n - count) : 0;
  const frame = Math.floor(elapsed * SCRAMBLE_FPS);
  const seed = textSeed(text);
  let tail = '';
  for (let i = 0; i < tailN; i++) {
    const ch = chars[count + i];
    tail += isBlank(ch) ? ch : glyphFor(seed + frame * 131 + (count + i) * 17);
  }
  return { typed: chars.slice(0, count).join(''), tail, count, n, done: count >= n, doneAt: dur };
}

function cursorVisible(elapsed, dur) {
  if (typewriterCfg().cursor === false) return false;
  if (elapsed < dur) return true;
  const after = elapsed - dur;
  if (after > 1.4) return false;
  return Math.floor(after * 2.6) % 2 === 0;
}

/**
 * Draws typewriter text with a stable layout (the anchor never shifts while
 * typing). Returns geometry so callers can attach underlines / bars.
 *
 * opts: { elapsed, dur, font, fs, color, accent, align: 'left'|'center'|'right',
 *         highlightFirst (colour the first token with accent), scramble, cursor }
 */
export function drawTypewriter(ctx, text, x, y, opts) {
  const o = opts || {};
  const fs = o.fs || 32;
  const color = o.color || env.PAL.bone;
  const accent = o.accent || env.PAL.signal;
  ctx.save();
  if (o.font) ctx.font = o.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = o.baseline || 'middle';
  const full = ctx.measureText(text).width;
  const align = o.align || 'left';
  const x0 = align === 'center' ? x - full / 2 : align === 'right' ? x - full : x;

  const st = typewriterState(text, o.elapsed, o.dur, o.scramble);
  let cx = x0;
  if (st.typed) {
    if (o.highlightFirst) {
      const m = /^(\S+)(.*)$/s.exec(st.typed);
      const head = m ? m[1] : st.typed;
      const rest = m ? m[2] : '';
      ctx.fillStyle = accent;
      ctx.fillText(head, cx, y);
      cx += ctx.measureText(head).width;
      if (rest) {
        ctx.fillStyle = color;
        ctx.fillText(rest, cx, y);
        cx += ctx.measureText(rest).width;
      }
    } else {
      ctx.fillStyle = color;
      ctx.fillText(st.typed, cx, y);
      cx += ctx.measureText(st.typed).width;
    }
  }
  const typedW = cx - x0;
  if (st.tail) {
    ctx.save();
    ctx.globalAlpha *= 0.75;
    ctx.fillStyle = accent;
    ctx.fillText(st.tail, cx, y);
    cx += ctx.measureText(st.tail).width;
    ctx.restore();
  }
  if (o.cursor !== false && o.elapsed > 0 && cursorVisible(o.elapsed, o.dur)) {
    const cw = Math.max(2, fs * 0.09);
    const ch = fs * 0.92;
    const cy = ctx.textBaseline === 'middle' ? y - ch / 2 : y - ch * 0.82;
    ctx.fillStyle = accent;
    ctx.fillRect(cx + fs * 0.06, cy, cw, ch);
  }
  ctx.restore();
  return { x0, width: full, typedWidth: typedW, progress: st.n ? st.count / st.n : 1 };
}

/**
 * Decode-resolve: every glyph flickers through random symbols and settles on
 * its real character, roughly left to right. Layout uses the real glyph
 * advances, so nothing jumps when the text settles.
 */
export function drawDecode(ctx, text, x, y, opts) {
  const o = opts || {};
  const color = o.color || env.PAL.bone;
  const accent = o.accent || env.PAL.signal;
  const dur = Math.max(0.05, o.dur || 0.8);
  const elapsed = o.elapsed || 0;
  const chars = Array.from(String(text || ''));
  const n = chars.length;
  ctx.save();
  if (o.font) ctx.font = o.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = o.baseline || 'middle';
  const full = ctx.measureText(text).width;
  const align = o.align || 'left';
  const x0 = align === 'center' ? x - full / 2 : align === 'right' ? x - full : x;
  const seed = textSeed(text) ^ (o.seed || 0);
  const frame = Math.floor(elapsed * SCRAMBLE_FPS);

  let cx = x0;
  for (let i = 0; i < n; i++) {
    const ch = chars[i];
    const adv = ctx.measureText(ch).width;
    if (!isBlank(ch)) {
      const order = n > 1 ? i / (n - 1) : 0;
      const jitter = (hash32(seed + i * 97) % 1000) / 1000;
      const resolveAt = dur * (0.25 + 0.5 * order + 0.25 * jitter);
      const appearAt = resolveAt - dur * 0.45;
      if (elapsed >= appearAt) {
        const settled = elapsed >= resolveAt;
        ctx.globalAlpha = settled ? 1 : 0.45 + 0.4 * clamp((elapsed - appearAt) / (resolveAt - appearAt), 0, 1);
        ctx.fillStyle = settled ? color : accent;
        ctx.fillText(settled ? ch : glyphFor(seed + frame * 59 + i * 13), cx, y);
      }
    }
    cx += adv;
  }
  ctx.restore();
  return { x0, width: full, progress: clamp(elapsed / dur, 0, 1) };
}

/** Horizontal wipe-in factor helper (0→1) used for rules / bars. */
export function wipe(elapsed, dur) {
  return easeOutCubic(clamp(elapsed / Math.max(1e-3, dur), 0, 1));
}
