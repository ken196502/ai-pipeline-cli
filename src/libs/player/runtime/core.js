// Player bootstrap: data loading, renderer selection, timeline, seek contract,
// HUD/controls and the transition lab.

import { env, mergeDeep, readJsonBlock } from './env.js';
import { buildMediaCatalog, preloadIcons, readPromptTexts } from './media.js';
import { drawBG, setBackgroundPlate } from './bg.js';
import { drawContent, locateInClip } from './layout.js';
import { grade, halate, initNoise } from './post.js';
import { createGLRenderer, listTransitions } from './gl.js';
import { locateClip, pickTransitionName } from './timeline.js';
import { clamp, easeInOutCubic, easeOutCubic, hexToRgb, lerp } from './util.js';

const DEFAULT_STYLE = {
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
    font: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
  },
  timing: {
    titleIn: 0.55,
    titleHold: 1.1,
    titleOut: 0.55,
    titleSafePad: 0.1,
    lineGap: 0.12,
    shotGap: 0.18,
    clipTail: 0.5,
    shotDur: 4.2,
    shotTrans: 0.8,
    clipTrans: 1.0,
    phraseLead: 0.1,
  },
  components: {
    flash: { interval: 0.2, punch: 0.04, shutter: 0.22, border: 'accent', pool: 'tag:candidate', badge: true },
    finalShowcase: { tag: 'FINAL AI VIDEO SHOWCASE', audio: 'source', asset: 'final-ai-video', fit: 'contain' },
    subtitleBanner: { enabled: false },
    titleCard: { layouts: ['center', 'editorial', 'hud'], seed: 5 },
    landscape: { variants: ['split', 'stack', 'full'] },
    typewriter: { cps: 42, scramble: 3, cursor: true },
  },
  camera: { mode: 'auto-drift', zoomRange: [1.0, 1.06], rollMax: 0.01, driftPx: 18 },
  transitions: {
    clip: { mode: 'sequence', pool: ['directionalWarp', 'lumaGlitch', 'radialBloom'], seed: 7, params: {} },
    shot: { type: 'conveyor' },
    visualSwap: { type: 'slide-fade' },
  },
  post: {
    renderer: 'webgl',
    halation: 0.3,
    halationTint: '#FF2E0A',
    grain: 0.05,
    chromaticAberration: 2.0,
    vignette: 0.35,
    contrast: 1.05,
  },
  background: { mode: 'cyber', grid: 1, speed: 0.35, brightness: 1, seed: 9, plate: null },
  overrides: {},
};

const urlParams = new URLSearchParams(window.location.search);
const isRender = urlParams.get('render') === '1' || Boolean(window.__RENDER_MODE__);
const labMode = urlParams.get('transitionLab') === '1';

if (isRender) {
  document.documentElement.classList.add('render-mode');
  document.body.classList.add('render-mode');
}

function pickTransition(clipIndex, totalClips) {
  return pickTransitionName({ channel: env.transitions.clip || {}, clipIndex, totalClips });
}

function buildStyle() {
  const raw = readJsonBlock('explainer-style', {});
  return mergeDeep(DEFAULT_STYLE, raw || {});
}

function boot() {
  env.config = readJsonBlock('explainer-data', { meta: { design: { w: 1920, h: 1080 } }, clips: [] });
  env.style = buildStyle();
  env.voice = readJsonBlock('explainer-voice', null);
  env.iconData = readJsonBlock('explainer-icons', {}) || {};
  env.assetList = readJsonBlock('explainer-assets', []) || [];
  env.promptTexts = readPromptTexts();

  const style = env.style;
  const meta = env.config.meta || {};
  env.W = (meta.design && meta.design.w) || 1920;
  env.H = (meta.design && meta.design.h) || 1080;
  env.S = env.W / 1280;
  env.FONT = style.theme.font;
  env.ACCENT = style.theme.accent;
  env.PAL = {
    ink: style.theme.bg,
    ink2: style.theme.ink2,
    graphite: style.theme.palette.graphite,
    ash: style.theme.palette.ash,
    bone: style.theme.palette.bone,
    signal: style.theme.accent,
    ember: style.theme.palette.ember,
    blood: style.theme.palette.blood,
    acid: style.theme.palette.acid,
  };
  env.post = style.post;
  env.camera = style.camera;
  env.components = style.components;
  env.transitions = style.transitions;
  env.titleIn = style.timing.titleIn;
  env.titleHold = style.timing.titleHold;
  env.titleOut = style.timing.titleOut;
  env.shotDur = style.timing.shotDur;
  env.shotTrans = style.timing.shotTrans;
  env.clipTrans = style.timing.clipTrans;

  env.showSubtitles = false;
  if (urlParams.has('subtitles')) {
    env.showSubtitles = urlParams.get('subtitles') === '1' || urlParams.get('subtitles') === 'true';
  } else if (typeof meta.subtitles === 'boolean') {
    env.showSubtitles = meta.subtitles;
  }
  env.components.subtitleBanner.enabled = env.showSubtitles;

  env.clips = env.config.clips || [];
  env.N = env.clips.length;
  if (env.N === 0) throw new Error('explainer data block contains no clips');

  buildMediaCatalog();

  env.playDur = env.clips.map((c) => c.shots.length * env.shotDur);
  env.total = env.playDur.reduce((a, b) => a + b, 0);

  if (env.voice && Array.isArray(env.voice.clips) && env.voice.clips.length === env.N) {
    env.VOICE = true;
    env.AUDIO = new Audio('assets/narration.mp3');
    env.AUDIO.preload = 'auto';
    // voice.json is the only timing source: merge it into the clips in memory
    // (the storyboard itself is never mutated on disk).
    env.clips.forEach((clip, i) => {
      const vc = env.voice.clips[i];
      clip.vStart = vc.start;
      clip.vDur = vc.dur;
      clip.shots.forEach((shot, j) => {
        const vs = vc.shots[j];
        if (!vs) return;
        shot.vStart = vs.start;
        shot.vDur = vs.dur;
        shot.vLines = vs.lines;
      });
    });
    env.playDur = env.clips.map((c) => c.vDur);
    env.total = env.voice.total;
  }

  const canvas = document.getElementById('stage');
  env.canvas = canvas;
  canvas.width = env.W;
  canvas.height = env.H;

  // Buffers
  function mkBuf() {
    const c = document.createElement('canvas');
    c.width = env.W;
    c.height = env.H;
    return { c, x: c.getContext('2d') };
  }
  env.scene = mkBuf();
  env.glow = mkBuf();
  env.bufCur = mkBuf();
  env.bufNxt = mkBuf();
  env.cellA = mkBuf();
  env.cellB = mkBuf();
  env.bloomCanvas = document.createElement('canvas');
  env.bloomCanvas.width = Math.max(1, Math.round(env.W / 4));
  env.bloomCanvas.height = Math.max(1, Math.round(env.H / 4));
  env.bloomCtx = env.bloomCanvas.getContext('2d');

  initNoise(style.transitions.clip.seed || 7);

  // Renderer selection: WebGL with an explicit Canvas2D fallback.
  let renderer = null;
  if (env.post.renderer === 'webgl') {
    try {
      renderer = createGLRenderer(canvas);
    } catch (err) {
      env.warnings.push(`WebGL renderer init failed: ${err && err.message ? err.message : err}`);
      renderer = null;
    }
    if (!renderer) {
      env.warnings.push('WebGL unavailable — falling back to the Canvas2D renderer');
    }
  }
  env.renderer = renderer ? 'webgl' : 'canvas2d';
  env.glRenderer = renderer;
  env.stageCtx = renderer ? null : canvas.getContext('2d');

  if (labMode) setupLab();
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Locates (clip, shot) for time t.
 *
 * Each clip occupies exactly `playDur[i]` seconds: the first `clipTrans` seconds
 * are its own entrance (title card + camera settle), NOT a transition from the
 * previous clip. The last clip therefore no longer bleeds into the first frame
 * (P0/B1).
 */
export function locate(t) {
  return locateClip({ playDur: env.playDur, clipTrans: env.clipTrans, clipCount: env.N, t });
}

function drawSceneInto(ctx, clip, local, syncQueue) {
  drawBG(ctx, clip, local);
  drawContent(ctx, clip, local, syncQueue);
}

// ---------------------------------------------------------------------------
// Canvas2D transition compositing (fallback path)
// ---------------------------------------------------------------------------

const TRANSITION_GROUPS = {
  directionalWarp: 'warp',
  crossZoom: 'warp',
  dreamyZoom: 'warp',
  displacement: 'warp',
  lumaGlitch: 'scan',
  radialBloom: 'radial',
  emberBurn: 'radial',
};

function composite2D(ctx, fromCanvas, toCanvas, k, name) {
  const W = env.W;
  const H = env.H;
  const S = env.S;
  const PAL = env.PAL;
  const group = TRANSITION_GROUPS[name] || 'warp';
  const dir = 1;

  if (group === 'scan') {
    const glitchK = easeInOutCubic(k);
    ctx.save();
    ctx.globalAlpha = 1 - glitchK * 0.4;
    ctx.drawImage(fromCanvas, 0, 0, W, H);
    ctx.restore();

    const scanHeight = H * glitchK;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, scanHeight);
    ctx.clip();
    ctx.drawImage(toCanvas, 0, 0, W, H);
    ctx.restore();

    if (scanHeight > 2 && scanHeight < H - 2) {
      ctx.save();
      const beamGrad = ctx.createLinearGradient(0, scanHeight - 16 * S, 0, scanHeight + 16 * S);
      beamGrad.addColorStop(0, 'rgba(0,0,0,0)');
      beamGrad.addColorStop(0.5, hexA(env.ACCENT, 0.55 * Math.sin(Math.PI * k)));
      beamGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = beamGrad;
      ctx.fillRect(0, scanHeight - 16 * S, W, 32 * S);
      ctx.restore();
    }
    return;
  }

  if (group === 'radial') {
    const bloomK = easeInOutCubic(k);
    ctx.save();
    ctx.globalAlpha = 1 - bloomK * 0.6;
    ctx.drawImage(fromCanvas, 0, 0, W, H);
    ctx.restore();

    const rx = easeOutCubic(k) * W * 0.75;
    const ry = easeOutCubic(k) * H * 0.75;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(toCanvas, 0, 0, W, H);
    ctx.restore();

    if (rx > 4 && rx < W * 0.72) {
      ctx.save();
      ctx.strokeStyle = hexA(PAL.ember, 0.4 * Math.sin(Math.PI * k));
      ctx.lineWidth = 6 * S;
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  const warpK = easeInOutCubic(k);
  ctx.save();
  ctx.globalAlpha = 1 - warpK;
  const curDistortX = -120 * S * warpK * dir;
  const curScale = lerp(1.0, 1.08, warpK);
  ctx.translate(W / 2 + curDistortX, H / 2);
  ctx.scale(curScale, curScale);
  ctx.translate(-W / 2, -H / 2);
  ctx.drawImage(fromCanvas, 0, 0, W, H);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = warpK;
  const nxtDistortX = 120 * S * (1 - warpK) * dir;
  const nxtScale = lerp(0.94, 1.0, easeOutCubic(k));
  ctx.translate(W / 2 + nxtDistortX, H / 2);
  ctx.scale(nxtScale, nxtScale);
  ctx.translate(-W / 2, -H / 2);
  ctx.drawImage(toCanvas, 0, 0, W, H);
  ctx.restore();
}

function hexA(hex, alpha) {
  const rgb = hexToRgb(hex);
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

function blitToStage() {
  const ctx = env.stageCtx;
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, env.W, env.H);
  ctx.drawImage(env.scene.c, 0, 0, env.W, env.H);
}

export function render(t, syncQueue) {
  const fps = env.config.fps || 30;
  const frameIndex = Math.round(t * fps);
  const post = env.post;

  if (labMode) {
    renderLab(t, syncQueue);
    return;
  }

  const L = locate(t);
  let flashAmt = 0;

  if (L.trans) {
    const cur = env.clips[L.cur];
    const nxt = env.clips[L.next];
    const k = clamp(L.k, 0, 1);
    const name = pickTransition(L.next, env.N);
    const params = Object.assign(
      { seed: (env.transitions.clip.params && env.transitions.clip.params.seed) || env.transitions.clip.seed || 7, amplitude: 1, direction: L.next % 2 === 0 ? 1 : -1 },
      env.transitions.clip.params || {}
    );

    drawSceneInto(env.bufCur.x, cur, env.playDur[L.cur], syncQueue);
    drawSceneInto(env.bufNxt.x, nxt, k * env.clipTrans, syncQueue);

    flashAmt = (params.flash != null ? params.flash : 0.08) * Math.sin(Math.PI * k);

    if (env.renderer === 'webgl') {
      env.glRenderer.render({
        fromCanvas: env.bufCur.c,
        toCanvas: env.bufNxt.c,
        progress: k,
        transition: name,
        params,
        flash: flashAmt,
        frameIndex,
        bloomCanvas: makeBloomFrom(env.bufNxt.c),
      });
    } else {
      const ctx = env.scene.x;
      ctx.clearRect(0, 0, env.W, env.H);
      ctx.fillStyle = env.PAL.ink;
      ctx.fillRect(0, 0, env.W, env.H);
      composite2D(ctx, env.bufCur.c, env.bufNxt.c, k, name);
      halate();
      grade(flashAmt, frameIndex);
      blitToStage();
    }
    env.lastLoc = { ci: L.cur, si: cur.shots.length - 1 };
    return;
  }

  const clip = env.clips[L.ci];
  const ctx = env.scene.x;
  ctx.clearRect(0, 0, env.W, env.H);
  ctx.fillStyle = env.PAL.ink;
  ctx.fillRect(0, 0, env.W, env.H);
  drawSceneInto(ctx, clip, L.local, syncQueue);
  env.lastLoc = { ci: L.ci, si: locateInClip(clip, L.local).si };

  if (env.renderer === 'webgl') {
    env.glRenderer.render({
      fromCanvas: env.scene.c,
      toCanvas: null,
      progress: 0,
      transition: null,
      params: null,
      flash: 0,
      frameIndex,
      bloomCanvas: makeBloomFrom(env.scene.c),
    });
  } else {
    halate();
    grade(0, frameIndex);
    blitToStage();
  }
}

function makeBloomFrom(sourceCanvas) {
  const post = env.post;
  const bw = env.bloomCanvas.width;
  const bh = env.bloomCanvas.height;
  const ctx = env.bloomCtx;
  ctx.clearRect(0, 0, bw, bh);
  ctx.save();
  ctx.filter = 'blur(' + Math.max(2, Math.round(18 * env.S * (bw / env.W))) + 'px)';
  ctx.drawImage(sourceCanvas, 0, 0, bw, bh);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = post.halationTint;
  ctx.fillRect(0, 0, bw, bh);
  ctx.restore();
  return env.bloomCanvas;
}

// ---------------------------------------------------------------------------
// Transition lab (explainer-player.html?transitionLab=1)
// ---------------------------------------------------------------------------

const LAB_DUR = 2.4;
function labPool() {
  const channel = env.transitions.clip || {};
  const pool = Array.isArray(channel.pool) && channel.pool.length > 0 ? channel.pool : listTransitions();
  return pool;
}

function setupLab() {
  env.labPool = labPool();
  env.total = LAB_DUR * env.labPool.length;
  env.playDur = [env.total];
  env.VOICE = false;
  env.AUDIO = null;
  const hud = document.getElementById('clip-name');
  if (hud) hud.textContent = 'TRANSITION LAB';
}

function renderLab(t, syncQueue) {
  const pool = env.labPool;
  const index = Math.floor(t / LAB_DUR) % pool.length;
  const k = (t % LAB_DUR) / LAB_DUR;
  const name = pool[index];
  const a = env.clips[0];
  const b = env.clips[Math.min(1, env.N - 1)];

  drawSceneInto(env.bufCur.x, a, env.clipTrans, syncQueue);
  drawSceneInto(env.bufNxt.x, b, k * env.clipTrans, syncQueue);

  if (env.renderer === 'webgl') {
    env.glRenderer.render({
      fromCanvas: env.bufCur.c,
      toCanvas: env.bufNxt.c,
      progress: k,
      transition: name,
      params: { seed: 7, amplitude: 1, direction: 1 },
      flash: 0.08 * Math.sin(Math.PI * k),
      frameIndex: Math.round(t * 30),
      bloomCanvas: makeBloomFrom(env.bufNxt.c),
    });
  } else {
    const ctx = env.scene.x;
    ctx.clearRect(0, 0, env.W, env.H);
    composite2D(ctx, env.bufCur.c, env.bufNxt.c, k, name);
    halate();
    grade(0.08 * Math.sin(Math.PI * k), Math.round(t * 30));
    blitToStage();
  }
  const shotName = document.getElementById('shot-name');
  if (shotName) shotName.textContent = name;
}

// ---------------------------------------------------------------------------
// Playback controls
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function syncHud() {
  const loc = env.lastLoc;
  const clip = env.clips[loc.ci];
  const ended = !env.playing && env.time >= env.total - 1e-3;
  if ($('clip-name')) $('clip-name').textContent = clip ? clip.title : '—';
  if ($('shot-name')) $('shot-name').textContent = clip ? clip.shots[loc.si] && clip.shots[loc.si].id : '—';
  if ($('time'))
    $('time').textContent = ended
      ? 'Finished · ' + env.total.toFixed(0) + 's'
      : env.time.toFixed(1) + 's / ' + env.total.toFixed(0) + 's';
  if ($('seek')) $('seek').value = Math.round((env.time / env.total) * 1000);
  if ($('play')) $('play').textContent = env.playing ? '⏸' : ended ? '↻' : '▶';
}

let lastTs = null;

function frame(ts) {
  if (lastTs == null) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (env.VOICE && env.AUDIO) {
    if (env.playing) {
      env.time = env.AUDIO.currentTime;
      if (env.AUDIO.ended || env.time >= env.total) {
        env.time = Math.min(env.time, env.total);
        env.playing = false;
      }
    }
  } else if (env.playing) {
    env.time += dt;
    if (env.time >= env.total) {
      env.time = env.total;
      env.playing = false;
    }
  }
  render(env.time, null);
  syncHud();
  if (env.playing) requestAnimationFrame(frame);
}

export function seekTo(t) {
  env.time = clamp(t, 0, env.total);
  if (env.VOICE && env.AUDIO) env.AUDIO.currentTime = Math.max(0, Math.min(env.time, env.total - 0.01));
  deterministicSeek(env.time);
  syncHud();
}

function toggle() {
  if (!env.playing && env.time >= env.total - 1e-3) seekTo(0);
  env.playing = !env.playing;
  if (env.VOICE && env.AUDIO) {
    if (env.playing) env.AUDIO.play().catch(() => {});
    else env.AUDIO.pause();
  }
  lastTs = null;
  if (env.playing) requestAnimationFrame(frame);
  syncHud();
}

function syncSubtitleButton() {
  const btn = $('toggle-subtitles');
  if (!btn) return;
  if (env.showSubtitles) btn.classList.add('active');
  else btn.classList.remove('active');
}

function toggleSubtitles() {
  env.showSubtitles = !env.showSubtitles;
  env.components.subtitleBanner.enabled = env.showSubtitles;
  syncSubtitleButton();
  render(env.time, null);
}

/** Deterministic seek(t): paints frame t and resolves once media seeks settle. */
export function deterministicSeek(t) {
  env.time = clamp(t, 0, env.total);
  const syncPromises = [];
  render(env.time, syncPromises);
  syncHud();
  if (syncPromises.length > 0) {
    return Promise.all(syncPromises).then(() => {
      render(env.time, null);
    });
  }
  return Promise.resolve();
}

/** Waits for the pre-rendered background plate (missing plate → gradient fallback). */
function loadBackgroundPlate() {
  const img = document.getElementById('bg-plate');
  if (!img) return Promise.resolve();
  const settle = () => setBackgroundPlate(img);
  if (img.complete) {
    settle();
    if (!(img.naturalWidth > 0)) env.warnings.push('background plate failed to load — using gradient fallback');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      settle();
      if (!(img.naturalWidth > 0)) env.warnings.push('background plate failed to load — using gradient fallback');
      resolve();
    };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    setTimeout(done, 5000);
  });
}

function main() {
  boot();

  if (!isRender) {
    if ($('toggle-subtitles')) $('toggle-subtitles').addEventListener('click', toggleSubtitles);
    if ($('play')) $('play').addEventListener('click', toggle);
    if ($('seek'))
      $('seek').addEventListener('input', (e) => seekTo((e.target.value / 1000) * env.total));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'ArrowRight') {
        seekTo(env.time + (e.shiftKey ? 5 : 2));
      } else if (e.code === 'ArrowLeft') {
        seekTo(env.time - (e.shiftKey ? 5 : 2));
      } else if (e.key === 'c' || e.key === 'C') {
        toggleSubtitles();
      } else if (e.key === ',') {
        env.playing = false;
        if (env.VOICE && env.AUDIO) env.AUDIO.pause();
        seekTo(env.time - 1 / 30);
      } else if (e.key === '.') {
        env.playing = false;
        if (env.VOICE && env.AUDIO) env.AUDIO.pause();
        seekTo(env.time + 1 / 30);
      } else if (e.key === 'r') {
        seekTo(0);
      }
    });
  }
  syncSubtitleButton();

  window.__explainer = {
    seek: deterministicSeek,
    render: (t) => deterministicSeek(t),
    get time() {
      return env.time;
    },
    get total() {
      return env.total;
    },
    get subtitles() {
      return env.showSubtitles;
    },
    get renderer() {
      return env.renderer;
    },
    get rendererInfo() {
      return env.glRenderer ? env.glRenderer.rendererInfo : 'canvas2d';
    },
    get warnings() {
      return env.warnings;
    },
    get transitions() {
      return listTransitions();
    },
    /** Diagnostic snapshot (used by visual QA + the benchmark script). */
    debug: () => ({
      renderer: env.renderer,
      voice: env.VOICE,
      total: env.total,
      clips: env.N,
      playDur: env.playDur,
      lastLoc: env.lastLoc,
      assets: env.assetList.length,
      flashPool: env.flashPool.length,
      styleTiming: env.style && env.style.timing,
      trace: env.trace,
      warnings: env.warnings,
    }),
    setSubtitles: (val) => {
      env.showSubtitles = Boolean(val);
      env.components.subtitleBanner.enabled = env.showSubtitles;
      syncSubtitleButton();
      render(env.time, null);
    },
    toggleSubtitles,
    pause: () => {
      env.playing = false;
    },
  };
  window.__player = window.__explainer;

  // Initial draw after icon bitmaps settle — the ready flag gates both the
  // interactive preview and the headless frame-by-frame renderer.
  Promise.all([preloadIcons(), loadBackgroundPlate()])
    .then(() => {
      deterministicSeek(0);
      window.__explainerReady = true;
    })
    .catch((err) => {
      window.__explainerError = String((err && err.stack) || (err && err.message) || err);
    });
}

try {
  main();
} catch (err) {
  window.__explainerError = String((err && err.message) || err);
  throw err;
}

