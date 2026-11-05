// Canvas2D post-processing (fallback path + WebGL-unavailable machines).
//
// Halation = blurred copy of the frame, tinted and added back.
// Grade    = chromatic aberration + shoulder roll-off + contrast + vignette +
//            deterministic film grain + white flash.
//
// The grain is driven by a seeded PRNG (not Math.random) so the same frame
// always renders identically and noise stays continuous across chunks/tabs.

import { env } from './env.js';
import { clamp255, hexToRgb, smoothstep, shoulder, hashFloat } from './util.js';

let noiseA = null;
let noiseB = null;

export function initNoise(seed) {
  const W = env.W;
  const H = env.H;
  const NA = W * H;
  const NB = (W * H) >> 2;
  noiseA = new Float32Array(NA);
  noiseB = new Float32Array(NB);
  // Deterministic per-frame offset: the arrays themselves never change, so
  // noise is stable for a given (frame, seed) pair.
  for (let i = 0; i < NA; i++) noiseA[i] = hashFloat(seed * 7919 + i * 2654435761) - 0.5;
  for (let i = 0; i < NB; i++) noiseB[i] = hashFloat(seed * 104729 + i * 40503 + 17) - 0.5;
}

export function halate() {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const post = env.post;
  const gx = env.glow.x;
  gx.clearRect(0, 0, W, H);
  gx.save();
  gx.filter = 'blur(' + 18 * S + 'px)';
  gx.drawImage(env.scene.c, 0, 0, W, H);
  gx.filter = 'none';
  gx.globalCompositeOperation = 'multiply';
  gx.fillStyle = post.halationTint;
  gx.fillRect(0, 0, W, H);
  gx.restore();

  const sx = env.scene.x;
  sx.save();
  sx.globalCompositeOperation = 'lighter';
  sx.globalAlpha = post.halation;
  sx.drawImage(env.glow.c, 0, 0, W, H);
  sx.restore();
}

export function grade(flashAmt, frameIndex) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const post = env.post;
  const NA = W * H;
  const NB = (W * H) >> 2;
  const CA_PX = post.chromaticAberration * S;
  const GRAIN = post.grain;
  const VIGNETTE = post.vignette;
  const CONTRAST = post.contrast;

  const ctx = env.scene.x;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const s = new Uint8ClampedArray(d);
  const aspect = W / H;
  const noiseStart = (((frameIndex * 997) % NA) + NA) % NA;
  const bone = hexToRgb(env.PAL.bone);
  const boneR = bone[0] / 255;
  const boneG = bone[1] / 255;
  const boneB = bone[2] / 255;

  for (let p = 0; p < d.length; p += 4) {
    const i = p >> 2;
    const x = i % W;
    const y = (i / W) | 0;
    const nx = x / W - 0.5;
    const ny = y / H - 0.5;
    const ax = nx * aspect;
    const ay = ny;
    const r2 = ax * ax + ay * ay;
    const m = Math.min(1, Math.sqrt(r2));
    const shift = CA_PX * m;
    const sx2 = Math.min(W - 1, Math.max(0, Math.round(x + shift)));
    const bx = Math.min(W - 1, Math.max(0, Math.round(x - shift)));

    let r = s[(y * W + sx2) * 4] / 255;
    let g = s[p + 1] / 255;
    let b = s[(y * W + bx) * 4 + 2] / 255;
    r = shoulder(r);
    g = shoulder(g);
    b = shoulder(b);
    r = (r - 0.5) * CONTRAST + 0.5;
    g = (g - 0.5) * CONTRAST + 0.5;
    b = (b - 0.5) * CONTRAST + 0.5;
    const vlen = Math.sqrt(ax * ax + ay * 0.8 * (ay * 0.8));
    const v = smoothstep(0.95, 0.25, vlen);
    const vf = 1 - VIGNETTE * (1 - v);
    r *= vf;
    g *= vf;
    b *= vf;
    r += boneR * flashAmt;
    g += boneG * flashAmt;
    b += boneB * flashAmt;
    const lm = 0.299 * r + 0.587 * g + 0.114 * b;
    const amt = GRAIN * (0.55 + 1.2 * lm * (1 - lm));
    const gn =
      (noiseA[(i + noiseStart) % NA] * 0.6 + noiseB[(i << 1) % NB] * 0.4) * amt;
    r += gn;
    g += gn;
    b += gn;
    d[p] = clamp255(r * 255);
    d[p + 1] = clamp255(g * 255);
    d[p + 2] = clamp255(b * 255);
  }
  ctx.putImageData(img, 0, 0);
}
