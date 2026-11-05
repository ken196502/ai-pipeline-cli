// Chapter title cards.
//
// Three layouts (center / editorial / hud) × two title text effects
// (typewriter / decode). The combination is a stable pseudo-random function of
// (style.components.titleCard.seed, clip index); adjacent chapters never share
// a layout. Nothing here is authored by the LLM.

import { env, styleFor } from './env.js';
import { drawDecode, drawTypewriter, typeDuration, wipe } from './text.js';
import { clamp, easeInOutCubic, easeOutCubic, hash32, hexA } from './util.js';

const KNOWN_LAYOUTS = ['center', 'editorial', 'hud'];
let plan = null;

/** Per-clip { layout, effect } plan, computed once per boot. */
export function titlePlan() {
  if (plan && plan.length === env.N) return plan;
  const cfg = (env.components && env.components.titleCard) || {};
  const pool = (Array.isArray(cfg.layouts) ? cfg.layouts : KNOWN_LAYOUTS).filter((l) => KNOWN_LAYOUTS.indexOf(l) >= 0);
  const layouts = pool.length > 0 ? pool : KNOWN_LAYOUTS;
  const seed = cfg.seed != null ? cfg.seed : 5;
  plan = [];
  let prev = -1;
  for (let i = 0; i < env.N; i++) {
    let pick = hash32(seed * 7919 + i * 104729 + 13) % layouts.length;
    if (layouts.length > 1 && pick === prev) pick = (pick + 1) % layouts.length;
    prev = pick;
    const effect = hash32(seed * 31 + i * 7 + 3) % 2 === 0 ? 'decode' : 'typewriter';
    plan.push({ layout: layouts[pick], effect });
  }
  return plan;
}

/** Envelope of the title card: alpha + exit progress. */
function envelope(sl, timing) {
  const tIn = timing.titleIn;
  const tHold = tIn + timing.titleHold;
  const tOut = timing.titleOut;
  if (sl < tIn) return { a: easeOutCubic(clamp(sl / Math.max(1e-3, tIn), 0, 1)), exit: 0 };
  if (sl < tHold) return { a: 1, exit: 0 };
  if (sl < tHold + tOut) {
    const p = clamp((sl - tHold) / Math.max(1e-3, tOut), 0, 1);
    return { a: 1 - easeInOutCubic(p), exit: easeInOutCubic(p) };
  }
  return { a: 0, exit: 1 };
}

/** Typing budget: the title must settle within the in + hold window. */
function budget(timing) {
  return Math.max(0.35, (timing.titleIn + timing.titleHold) * 0.62);
}

function drawTitleText(ctx, effect, text, x, y, o) {
  if (effect === 'decode') return drawDecode(ctx, text, x, y, o);
  return drawTypewriter(ctx, text, x, y, Object.assign({ cursor: true }, o));
}

function fitFont(ctx, weight, text, basePx, maxW) {
  ctx.font = weight + ' ' + Math.round(basePx) + 'px ' + env.FONT;
  const w = ctx.measureText(text).width;
  return w > maxW ? Math.max(12, (basePx * maxW) / w) : basePx;
}

function kickerDigits(kicker) {
  const m = /(\d{1,3})/.exec(kicker || '');
  return m ? m[1].padStart(2, '0') : '';
}

// ---------------------------------------------------------------------------
// center: bracketed kicker, big title, accent rule growing from the centre
// ---------------------------------------------------------------------------
function drawCenter(ctx, clip, sl, timing, effect, a, exit) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const B = budget(timing);
  const yOff = exit * 40 * S;
  const ty = H / 2 - 18 * S - yOff;

  ctx.save();
  const halo = ctx.createRadialGradient(W / 2, ty, 40 * S, W / 2, ty, W * 0.5);
  halo.addColorStop(0, 'rgba(0,0,0,' + 0.6 * a + ')');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = a;

  if (clip.kicker) {
    const kt = '[ ' + clip.kicker + ' ]';
    drawTypewriter(ctx, kt, W / 2, ty - 80 * S, {
      elapsed: sl,
      dur: typeDuration(kt, 0.2, B * 0.45),
      font: '600 ' + Math.round(22 * S) + 'px ' + env.FONT,
      fs: 22 * S,
      color: env.ACCENT,
      align: 'center',
      cursor: false,
    });
  }

  const fs = fitFont(ctx, 800, clip.title, 66 * S, W * 0.82);
  const font = '800 ' + Math.round(fs) + 'px ' + env.FONT;
  const tStart = 0.12;
  drawTitleText(ctx, effect, clip.title, W / 2, ty, {
    elapsed: sl - tStart,
    dur: effect === 'decode' ? B * 0.8 : typeDuration(clip.title, 0.3, B * 0.8),
    font,
    fs,
    color: PAL.bone,
    align: 'center',
  });

  const rule = wipe(sl - 0.25, 0.7) * (1 - exit);
  if (rule > 0) {
    const rw = W * 0.28 * rule;
    const g = ctx.createLinearGradient(W / 2 - rw, 0, W / 2 + rw, 0);
    g.addColorStop(0, hexA(env.ACCENT, 0));
    g.addColorStop(0.5, hexA(env.PAL.acid, 0.95));
    g.addColorStop(1, hexA(env.ACCENT, 0));
    ctx.fillStyle = g;
    ctx.fillRect(W / 2 - rw, ty + fs * 0.62, rw * 2, Math.max(2, 2.5 * S));
  }

  if (clip.subtitle) {
    drawTypewriter(ctx, clip.subtitle, W / 2, ty + fs * 0.62 + 46 * S, {
      elapsed: sl - B * 0.55,
      dur: typeDuration(clip.subtitle, 0.25, B * 0.6),
      font: '500 ' + Math.round(26 * S) + 'px ' + env.FONT,
      fs: 26 * S,
      color: PAL.ash,
      align: 'center',
      cursor: false,
    });
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// editorial: left-aligned, giant ghost chapter number, vertical accent bar
// ---------------------------------------------------------------------------
function drawEditorial(ctx, clip, sl, timing, effect, a, exit) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const B = budget(timing);
  const xOff = -exit * 60 * S;
  const x0 = W * 0.11 + xOff;
  const ty = H * 0.5;

  ctx.save();
  const shade = ctx.createLinearGradient(0, 0, W * 0.75, 0);
  shade.addColorStop(0, 'rgba(0,0,0,' + 0.72 * a + ')');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = a;

  const digits = kickerDigits(clip.kicker);
  if (digits) {
    ctx.save();
    const gp = wipe(sl, 0.9);
    ctx.globalAlpha = a * 0.16 * gp;
    ctx.font = '900 ' + Math.round(300 * S) + 'px ' + env.FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2 * S;
    ctx.strokeStyle = env.PAL.acid;
    ctx.strokeText(digits, W * 0.94 + (1 - gp) * 80 * S, ty);
    ctx.restore();
  }

  const fs = fitFont(ctx, 800, clip.title, 74 * S, W * 0.74);
  const barH = (fs * 1.1 + 120 * S) * wipe(sl, 0.45);
  ctx.fillStyle = env.ACCENT;
  ctx.fillRect(x0 - 28 * S, ty - fs * 0.55 - 62 * S, Math.max(3, 5 * S), barH);

  if (clip.kicker) {
    drawTypewriter(ctx, clip.kicker.toUpperCase(), x0, ty - fs * 0.55 - 36 * S, {
      elapsed: sl - 0.1,
      dur: typeDuration(clip.kicker, 0.2, B * 0.4),
      font: '700 ' + Math.round(20 * S) + 'px ' + env.FONT,
      fs: 20 * S,
      color: env.ACCENT,
      cursor: false,
    });
  }

  drawTitleText(ctx, effect, clip.title, x0, ty, {
    elapsed: sl - 0.2,
    dur: effect === 'decode' ? B * 0.8 : typeDuration(clip.title, 0.3, B * 0.8),
    font: '800 ' + Math.round(fs) + 'px ' + env.FONT,
    fs,
    color: PAL.bone,
  });

  const rule = wipe(sl - 0.35, 0.8) * (1 - exit);
  if (rule > 0) {
    ctx.fillStyle = hexA(PAL.graphite, 0.8);
    ctx.fillRect(x0, ty + fs * 0.62, W * 0.5 * rule, Math.max(1, 1.5 * S));
  }

  if (clip.subtitle) {
    drawTypewriter(ctx, clip.subtitle, x0, ty + fs * 0.62 + 40 * S, {
      elapsed: sl - B * 0.5,
      dur: typeDuration(clip.subtitle, 0.25, B * 0.6),
      font: '500 ' + Math.round(26 * S) + 'px ' + env.FONT,
      fs: 26 * S,
      color: PAL.ash,
      cursor: false,
    });
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// hud: corner brackets open around the title, kicker chip, scan beam
// ---------------------------------------------------------------------------
function drawHud(ctx, clip, sl, timing, effect, a, exit) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const B = budget(timing);
  const cx = W / 2;
  const cy = H / 2;

  const fs = fitFont(ctx, 800, clip.title, 62 * S, W * 0.66);
  ctx.font = '800 ' + Math.round(fs) + 'px ' + env.FONT;
  const titleW = ctx.measureText(clip.title).width;
  const fw = Math.max(titleW + 120 * S, W * 0.42);
  const fh = fs * 1.2 + 150 * S;
  const open = wipe(sl, 0.5) * (1 - exit * 0.6);
  const hw = (fw / 2) * (0.35 + 0.65 * open);
  const hh = (fh / 2) * (0.35 + 0.65 * open);

  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = hexA(PAL.ink, 0.62 * open);
  ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);

  // Scan beam crossing the frame once.
  const sp = clamp((sl - 0.2) / 0.9, 0, 1);
  if (sp > 0 && sp < 1) {
    const sy = cy - hh + hh * 2 * sp;
    const g = ctx.createLinearGradient(0, sy - 18 * S, 0, sy + 18 * S);
    g.addColorStop(0, hexA(env.ACCENT, 0));
    g.addColorStop(0.5, hexA(env.ACCENT, 0.32 * Math.sin(Math.PI * sp)));
    g.addColorStop(1, hexA(env.ACCENT, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - hw, sy - 18 * S, hw * 2, 36 * S);
  }

  const L = 34 * S;
  ctx.strokeStyle = env.ACCENT;
  ctx.lineWidth = Math.max(2, 3 * S);
  const corners = [
    [cx - hw, cy - hh, 1, 1],
    [cx + hw, cy - hh, -1, 1],
    [cx - hw, cy + hh, 1, -1],
    [cx + hw, cy + hh, -1, -1],
  ];
  corners.forEach(([x, y, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * L, y);
    ctx.stroke();
  });

  if (clip.kicker) {
    ctx.font = '700 ' + Math.round(17 * S) + 'px ' + env.FONT;
    const kw = ctx.measureText(clip.kicker).width + 26 * S;
    const kp = wipe(sl - 0.15, 0.35);
    ctx.fillStyle = env.ACCENT;
    ctx.fillRect(cx - hw, cy - hh - 34 * S, kw * kp, 28 * S);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - hw, cy - hh - 34 * S, kw * kp, 28 * S);
    ctx.clip();
    ctx.fillStyle = PAL.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(clip.kicker, cx - hw + 13 * S, cy - hh - 20 * S);
    ctx.restore();
  }

  const meta = 'CH-' + String(env.clips.indexOf(clip) + 1).padStart(2, '0') + ' / ' + String(env.N).padStart(2, '0');
  drawTypewriter(ctx, meta, cx + hw, cy + hh + 24 * S, {
    elapsed: sl - 0.3,
    dur: 0.35,
    font: '600 ' + Math.round(14 * S) + 'px ui-monospace, Menlo, monospace',
    fs: 14 * S,
    color: PAL.ash,
    align: 'right',
    cursor: false,
  });

  drawTitleText(ctx, effect, clip.title, cx, cy - (clip.subtitle ? 18 * S : 0), {
    elapsed: sl - 0.18,
    dur: effect === 'decode' ? B * 0.8 : typeDuration(clip.title, 0.3, B * 0.8),
    font: '800 ' + Math.round(fs) + 'px ' + env.FONT,
    fs,
    color: PAL.bone,
    align: 'center',
  });

  if (clip.subtitle) {
    drawTypewriter(ctx, clip.subtitle, cx, cy + fs * 0.5 + 26 * S, {
      elapsed: sl - B * 0.5,
      dur: typeDuration(clip.subtitle, 0.25, B * 0.6),
      font: '500 ' + Math.round(24 * S) + 'px ' + env.FONT,
      fs: 24 * S,
      color: PAL.ash,
      align: 'center',
      cursor: false,
    });
  }
  ctx.restore();
}

const DRAWERS = { center: drawCenter, editorial: drawEditorial, hud: drawHud };

export function drawTitleCard(ctx, clip, sl) {
  const timing = styleFor(clip.id, null).timing;
  const { a, exit } = envelope(sl, timing);
  if (a <= 0.002) return;
  const ci = env.clips.indexOf(clip);
  const entry = titlePlan()[ci >= 0 ? ci : 0] || { layout: 'center', effect: 'typewriter' };
  const draw = DRAWERS[entry.layout] || drawCenter;
  draw(ctx, clip, sl, timing, entry.effect, a, exit);
}
