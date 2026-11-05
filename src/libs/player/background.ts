/**
 * Pre-rendered cyberspace background plate.
 *
 * The expensive, static part of the background (deep-space gradient, nebula
 * clouds, star field, two-layer neon skyline, light pillars, horizon glow) is
 * rendered ONCE per theme as an SVG and rasterised to JPEG with sharp. The
 * player only blits the plate (with a slow parallax drift) and draws the cheap
 * animated layer on top (perspective floor grid, data packets, scan beam).
 *
 * The plate is written into the bundle's assets/ directory, named by a content
 * hash, so re-runs with the same theme reuse it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { ExplainerStyle } from './style.js';

/** Bump when the plate drawing changes so cached plates are regenerated. */
export const CYBER_PLATE_VERSION = 1;
/** Plate is larger than the frame so the player can drift / parallax it. */
export const CYBER_PLATE_OVERSCAN = 1.12;
/** Horizon height as a fraction of the plate height (runtime grid uses it too). */
export const CYBER_PLATE_HORIZON = 0.64;

export interface CyberPlateParams {
  width: number;
  height: number;
  bg: string;
  accent: string;
  ember: string;
  blood: string;
  graphite: string;
  brightness: number;
  seed: number;
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

function shade(a: string, d: number): string {
  const A = hexToRgb(a);
  return rgbHex([A[0] + d, A[1] + d, A[2] + d]);
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (v: number) => v.toFixed(1);

/** Builds the plate SVG (exported for inspection / tests). */
export function buildCyberPlateSvg(p: CyberPlateParams): string {
  const PW = Math.round(p.width * CYBER_PLATE_OVERSCAN);
  const PH = Math.round(p.height * CYBER_PLATE_OVERSCAN);
  const S = p.width / 1920;
  const hy = PH * CYBER_PLATE_HORIZON;
  const rnd = mulberry32(p.seed * 7919 + 17);
  const br = Math.max(0, p.brightness);

  const skyTop = shade(p.bg, -6);
  const skyMid = mix(p.bg, p.accent, 0.05 * br);
  const skyLow = mix(p.bg, p.accent, 0.2 * br);
  const floorTop = mix(p.bg, p.accent, 0.08 * br);
  const floorBottom = shade(p.bg, -8);
  const magenta = p.blood;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}">`);
  parts.push(`<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${skyTop}"/>
    <stop offset="${(CYBER_PLATE_HORIZON * 0.6).toFixed(3)}" stop-color="${skyMid}"/>
    <stop offset="${CYBER_PLATE_HORIZON.toFixed(3)}" stop-color="${skyLow}"/>
    <stop offset="${(CYBER_PLATE_HORIZON + 0.001).toFixed(3)}" stop-color="${floorTop}"/>
    <stop offset="1" stop-color="${floorBottom}"/>
  </linearGradient>
  <linearGradient id="pillar" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="${p.accent}" stop-opacity="0.55"/>
    <stop offset="1" stop-color="${p.accent}" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="reflect" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${p.accent}" stop-opacity="${(0.1 * br).toFixed(3)}"/>
    <stop offset="1" stop-color="${p.accent}" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="farCity" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${mix(p.bg, p.accent, 0.16 * br)}"/>
    <stop offset="1" stop-color="${mix(p.bg, p.accent, 0.08 * br)}"/>
  </linearGradient>
  <linearGradient id="nearCity" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${shade(p.bg, 4)}"/>
    <stop offset="1" stop-color="${shade(p.bg, -4)}"/>
  </linearGradient>
  <radialGradient id="neb">
    <stop offset="0" stop-color="#fff" stop-opacity="1"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <filter id="blurXL" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${f1(70 * S)}"/></filter>
  <filter id="blurL" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${f1(26 * S)}"/></filter>
  <filter id="blurM" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="${f1(7 * S)}"/></filter>
  <filter id="blurS" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${f1(1.4 * S)}"/></filter>
</defs>`);
  parts.push(`<rect width="${PW}" height="${PH}" fill="url(#sky)"/>`);

  // Nebula clouds (accent / ember / magenta), heavily blurred.
  const nebColors = [p.accent, p.ember, magenta, p.accent, p.ember, magenta, p.accent];
  parts.push(`<g filter="url(#blurXL)">`);
  nebColors.forEach((c, i) => {
    const cx = PW * (0.08 + 0.84 * rnd());
    const cy = hy * (0.12 + 0.62 * rnd());
    const rx = PW * (0.12 + 0.16 * rnd());
    const ry = rx * (0.35 + 0.3 * rnd());
    const op = (0.07 + 0.09 * rnd()) * br * (i % 3 === 2 ? 0.8 : 1);
    parts.push(
      `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="${c}" opacity="${op.toFixed(3)}" transform="rotate(${f1(-20 + 40 * rnd())} ${f1(cx)} ${f1(cy)})"/>`
    );
  });
  parts.push(`</g>`);

  // Star field.
  parts.push(`<g>`);
  for (let i = 0; i < 380; i++) {
    const x = PW * rnd();
    const y = hy * 0.92 * Math.pow(rnd(), 1.25);
    const r = (0.5 + 1.3 * Math.pow(rnd(), 3)) * S;
    const op = (0.18 + 0.7 * rnd()) * Math.min(1, 0.4 + br * 0.6) * (1 - y / hy) ** 0.6;
    const col = rnd() < 0.18 ? p.accent : '#E8EEFF';
    parts.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${r.toFixed(2)}" fill="${col}" opacity="${op.toFixed(3)}"/>`);
  }
  parts.push(`</g>`);

  // Light pillars rising from the skyline.
  parts.push(`<g filter="url(#blurM)" opacity="${(0.32 * br).toFixed(3)}">`);
  for (let i = 0; i < 7; i++) {
    const x = PW * (0.05 + 0.9 * rnd());
    const w = (4 + 10 * rnd()) * S;
    const h = hy * (0.35 + 0.5 * rnd());
    parts.push(`<rect x="${f1(x)}" y="${f1(hy - h)}" width="${f1(w)}" height="${f1(h)}" fill="url(#pillar)"/>`);
  }
  parts.push(`</g>`);

  // Horizon glow (wide soft band + bright core line).
  parts.push(
    `<rect x="0" y="${f1(hy - 70 * S)}" width="${PW}" height="${f1(140 * S)}" fill="${p.accent}" opacity="${(0.2 * br).toFixed(3)}" filter="url(#blurL)"/>`
  );

  // Far skyline: hazy, slightly blurred, low.
  const skyline = (layer: 'far' | 'near') => {
    const out: string[] = [];
    let x = -20 * S;
    while (x < PW + 20 * S) {
      const w = (layer === 'far' ? 14 + 46 * rnd() : 26 + 70 * rnd()) * S;
      const centerDist = Math.abs(x + w / 2 - PW / 2) / (PW / 2);
      // Keep the middle of the frame low so on-screen copy stays readable.
      const heightScale = layer === 'far' ? 0.55 + 0.45 * centerDist : 0.25 + 0.75 * centerDist ** 1.3;
      const h = (layer === 'far' ? 30 + 150 * rnd() : 50 + 260 * rnd()) * S * heightScale;
      out.push(`<rect x="${f1(x)}" y="${f1(hy - h)}" width="${f1(w + 1)}" height="${f1(h + 1)}"/>`);
      if (layer === 'near') {
        const cols = Math.max(1, Math.floor(w / (9 * S)));
        const rows = Math.max(1, Math.floor(h / (13 * S)));
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (rnd() > 0.16) continue;
            const wx = x + 4 * S + c * 9 * S;
            const wy = hy - h + 6 * S + r * 13 * S;
            const col = rnd() < 0.7 ? p.accent : p.ember;
            out.push(
              `<rect x="${f1(wx)}" y="${f1(wy)}" width="${f1(3.5 * S)}" height="${f1(5 * S)}" fill="${col}" opacity="${((0.25 + 0.5 * rnd()) * br).toFixed(3)}"/>`
            );
          }
        }
        if (h > 160 * S && rnd() < 0.5) {
          const ax = x + w * (0.3 + 0.4 * rnd());
          const ah = (20 + 50 * rnd()) * S;
          out.push(`<rect x="${f1(ax)}" y="${f1(hy - h - ah)}" width="${f1(1.6 * S)}" height="${f1(ah)}"/>`);
          out.push(`<circle cx="${f1(ax + 0.8 * S)}" cy="${f1(hy - h - ah)}" r="${f1(2.4 * S)}" fill="${magenta}" opacity="0.9"/>`);
        }
      }
      x += w + (layer === 'far' ? 2 : 6 + 20 * rnd()) * S;
    }
    return out.join('');
  };
  parts.push(`<g fill="url(#farCity)" filter="url(#blurS)" opacity="0.9">${skyline('far')}</g>`);
  parts.push(`<g fill="url(#nearCity)">${skyline('near')}</g>`);

  // Horizon core line + floor reflection.
  parts.push(
    `<rect x="0" y="${f1(hy - 1.2 * S)}" width="${PW}" height="${f1(2.4 * S)}" fill="${p.accent}" opacity="${(0.75 * br).toFixed(3)}"/>`
  );
  parts.push(`<rect x="0" y="${f1(hy)}" width="${PW}" height="${f1(PH * 0.18)}" fill="url(#reflect)"/>`);

  // Readability veil: darken the band where copy sits.
  parts.push(`<rect width="${PW}" height="${PH}" fill="${p.bg}" opacity="0.18"/>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

export function cyberPlateParams(style: ExplainerStyle, width: number, height: number): CyberPlateParams {
  return {
    width,
    height,
    bg: style.theme.bg,
    accent: style.theme.accent,
    ember: style.theme.palette.ember,
    blood: style.theme.palette.blood,
    graphite: style.theme.palette.graphite,
    brightness: style.background.brightness,
    seed: style.background.seed,
  };
}

/**
 * Ensures the cyber plate exists in `<outDir>/assets/` and returns its bundle
 * relative src (e.g. `assets/bg-cyber-1a2b3c4d.jpg`), or null when the style
 * does not use the cyber background.
 */
export async function ensureCyberPlate(params: {
  style: ExplainerStyle;
  outDir: string;
  width: number;
  height: number;
}): Promise<string | null> {
  if (params.style.background.mode !== 'cyber') return null;
  const p = cyberPlateParams(params.style, params.width, params.height);
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ v: CYBER_PLATE_VERSION, ...p }))
    .digest('hex')
    .slice(0, 10);
  const name = `bg-cyber-${hash}.jpg`;
  const assetsDir = path.join(params.outDir, 'assets');
  const target = path.join(assetsDir, name);
  const exists = await fs.stat(target).then((s) => s.size > 0).catch(() => false);
  if (!exists) {
    await fs.mkdir(assetsDir, { recursive: true });
    const svg = buildCyberPlateSvg(p);
    const tmp = `${target}.tmp`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 90, mozjpeg: true }).toFile(tmp);
    await fs.rename(tmp, target);
  }
  return `assets/${name}`;
}
