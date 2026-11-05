// Cyberspace background.
//
// The static, expensive layer (sky, nebula, stars, skyline, horizon glow) is a
// plate pre-rendered at bundle time (src/libs/player/background.ts) and only
// blitted here with a slow parallax drift. On top of it the player draws a
// cheap animated layer: a perspective floor grid scrolling toward the viewer,
// light packets running along the grid, drifting data motes and a periodic
// scan beam. Everything is a pure function of time (deterministic seek).

import { env, styleFor } from './env.js';
import { clamp, hash1, hexA, shade } from './util.js';

// Must match background.ts (CYBER_PLATE_OVERSCAN / CYBER_PLATE_HORIZON).
const OVERSCAN = 1.12;
const PLATE_HORIZON = 0.64;

let plateImg = null;

/** Called once at boot with the <img id="bg-plate"> element (may be null). */
export function setBackgroundPlate(img) {
  plateImg = img && img.complete && img.naturalWidth > 0 ? img : null;
}

function bgCfg() {
  return (env.style && env.style.background) || {};
}

/** Plate camera at time t: source rect in plate pixels + horizon in frame px. */
function plateCamera(t) {
  const W = env.W;
  const H = env.H;
  const PW = W * OVERSCAN;
  const PH = H * OVERSCAN;
  const ox = (PW - W) / 2 + Math.sin(t * 0.045) * (PW - W) * 0.38;
  const oy = (PH - H) / 2 + Math.cos(t * 0.037) * (PH - H) * 0.3;
  return { ox, oy, horizon: PH * PLATE_HORIZON - oy, PW, PH };
}

function drawPlate(ctx, cam, base) {
  const W = env.W;
  const H = env.H;
  if (plateImg) {
    const k = plateImg.naturalWidth / cam.PW;
    ctx.drawImage(plateImg, cam.ox * k, cam.oy * k, W * k, H * k, 0, 0, W, H);
    return;
  }
  // Fallback when the plate is missing: sky/floor gradient split at the horizon.
  const hz = clamp(cam.horizon / H, 0.05, 0.95);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, shade(base, -6));
  g.addColorStop(hz * 0.98, shade(base, 10));
  g.addColorStop(hz, shade(base, 6));
  g.addColorStop(1, shade(base, -10));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawFloorGrid(ctx, t, cam, accent) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const cfg = bgCfg();
  const amt = cfg.grid != null ? cfg.grid : 1;
  if (amt <= 0) return;
  const hy = cam.horizon;
  const depth = H - hy;
  if (depth <= 4) return;
  const vpx = W / 2 - (cam.ox - (cam.PW - W) / 2) * 0.6;
  const speed = cfg.speed != null ? cfg.speed : 0.35;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, hy, W, depth);
  ctx.clip();

  // Rows: perspective spacing, scrolling toward the viewer.
  const ROWS = 18;
  const phase = (t * speed) % 1;
  ctx.lineWidth = Math.max(1, 1.2 * S);
  for (let i = 0; i < ROWS; i++) {
    const z = (i + phase) / ROWS;
    const y = hy + depth * Math.pow(z, 2.3);
    const a = (0.03 + 0.2 * Math.pow(z, 1.3)) * amt;
    ctx.strokeStyle = hexA(accent, a);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Columns converging on the vanishing point; fade toward the horizon.
  const COLS = 26;
  const spread = W * 0.2;
  const colGrad = ctx.createLinearGradient(0, hy, 0, H);
  colGrad.addColorStop(0, hexA(accent, 0));
  colGrad.addColorStop(0.35, hexA(accent, 0.08 * amt));
  colGrad.addColorStop(1, hexA(accent, 0.2 * amt));
  ctx.strokeStyle = colGrad;
  for (let c = -COLS / 2; c <= COLS / 2; c++) {
    ctx.beginPath();
    ctx.moveTo(vpx + c * spread * 0.02, hy);
    ctx.lineTo(vpx + c * spread, H);
    ctx.stroke();
  }

  // Light packets running toward the viewer along a few columns.
  for (let p = 0; p < 7; p++) {
    const col = Math.round((hash1(p * 3.3 + 1.1) - 0.5) * COLS);
    const u = (t * (0.16 + 0.12 * hash1(p * 7.7)) + hash1(p * 5.1)) % 1;
    const e = u * u;
    const x0 = vpx + col * spread * 0.02;
    const x1 = vpx + col * spread;
    const px = x0 + (x1 - x0) * e;
    const py = hy + depth * e;
    const len = (8 + 70 * e) * S;
    const dx = (x1 - x0) / depth;
    const g = ctx.createLinearGradient(px - dx * len, py - len, px, py);
    g.addColorStop(0, hexA(accent, 0));
    g.addColorStop(1, hexA(p % 3 === 0 ? env.PAL.ember : accent, 0.75 * Math.sin(Math.PI * u) * amt));
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1.5, (1 + 2.5 * e) * S);
    ctx.beginPath();
    ctx.moveTo(px - dx * len, py - len);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
  ctx.restore();

  // Horizon pulse.
  const pulse = 0.35 + 0.25 * Math.sin(t * 1.3);
  ctx.fillStyle = hexA(accent, pulse * 0.5 * amt);
  ctx.fillRect(0, hy - 1 * S, W, 2 * S);
}

function drawMotes(ctx, t, accent) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  for (let p = 0; p < 36; p++) {
    const hx = hash1(p * 2.1);
    const hy = hash1(p * 3.7);
    const hs = hash1(p * 5.3);
    const speed = (8 + hs * 18) * S;
    const travel = H + 40 * S;
    const y = H - ((hy * travel + t * speed) % travel);
    const x = hx * W + Math.sin(t * 0.25 + p) * 14 * S;
    const tw = 0.5 + 0.5 * Math.sin(t * 1.7 + p * 1.9);
    const sz = (1 + hs * 2) * S;
    const edge = clamp(Math.min(y, H - y) / (60 * S), 0, 1);
    ctx.fillStyle = hexA(p % 4 === 0 ? env.PAL.ember : accent, (0.08 + 0.3 * tw) * edge);
    ctx.fillRect(x, y, sz, sz);
  }
}

function drawScanBeam(ctx, t, accent) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PERIOD = 7.5;
  const DUR = 1.8;
  const local = t % PERIOD;
  if (local > DUR) return;
  const p = local / DUR;
  const y = -60 * S + (H + 120 * S) * p;
  const g = ctx.createLinearGradient(0, y - 50 * S, 0, y + 6 * S);
  g.addColorStop(0, hexA(accent, 0));
  g.addColorStop(1, hexA(accent, 0.05 * Math.sin(Math.PI * p)));
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 50 * S, W, 56 * S);
}

export function drawBG(ctx, clip, t) {
  const W = env.W;
  const H = env.H;
  // Global time keeps the background continuous across chapter boundaries
  // (clip-local `t` would restart the drift at every chapter).
  const tpf = Number.isFinite(env.time) ? env.time : t || 0;
  const theme = styleFor(clip && clip.id, null).theme;
  const base = theme.bg || env.PAL.ink;
  const accent = theme.accent || env.ACCENT;
  const cfg = bgCfg();

  if (cfg.mode === 'plain') {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 40 * env.S, W * 0.5, H * 0.5, W * 0.78);
    g.addColorStop(0, shade(base, 9));
    g.addColorStop(0.58, base);
    g.addColorStop(1, shade(base, -13));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }

  const cam = plateCamera(tpf);
  drawPlate(ctx, cam, base);
  drawFloorGrid(ctx, tpf, cam, accent);
  drawMotes(ctx, tpf, accent);
  drawScanBeam(ctx, tpf, accent);
}
