// Small pure helpers shared by every runtime module.
// Plain ESM (bundled by esbuild into the player IIFE) — no TypeScript here.

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
export function easeOutCubic(p) {
  return 1 - Math.pow(1 - p, 3);
}
export function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
export function easeOutBack(p) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function hexToRgb(h) {
  h = String(h).replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function hexA(h, a) {
  const rgb = hexToRgb(h);
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
}
export function shade(h, d) {
  const rgb = hexToRgb(h);
  const f = (v) => clamp(Math.round(v + d), 0, 255);
  return 'rgb(' + f(rgb[0]) + ',' + f(rgb[1]) + ',' + f(rgb[2]) + ')';
}
export function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function shoulder(v) {
  const k = 0.72;
  if (v <= k) return v;
  return k + (1 - k) * (1 - Math.exp(-(v - k) / (1 - k)));
}

/**
 * Deterministic 32-bit hash (used for grain noise + transition selection).
 * Replaces Math.random() so the same frame always renders identically (B3).
 */
export function hash32(n) {
  let x = n | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** Deterministic float in [0,1) from an integer seed. */
export function hashFloat(n) {
  return hash32(n) / 4294967296;
}

export function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function tokenize(text) {
  if (/\s/.test(text)) return text.split(/\s+/).filter(Boolean);
  return Array.from(text);
}
export function lineGap(text, S) {
  return /\s/.test(text) ? 10 * S : 2 * S;
}
