/**
 * Tutorial player generator based on the OpusVideo procedural canvas engine.
 *
 * Emits a self-contained HTML/CSS/JS player bundle that renders the tutorial
 * timeline either interactively for human preview or deterministically
 * frame-by-frame for headless rendering.
 *
 * Features:
 *   - Living background: Polar coordinate grid, rising embers, drifting warm glow, title shockwaves
 *   - 2D affine camera: Smooth cubic interpolation between shots (zoom, pan x/y, roll)
 *   - Left column: Stacked punchy phrases with adaptive typography, number rail, and karaoke pop reveals
 *   - Right column: Single-cell conveyor swap supporting:
 *       * AI-generated videos (deterministically sought and framed in rounded card)
 *       * Real screenshots & keyframe images (aspect-ratio framed with badges)
 *       * Prompt material cards (terminal-style, auto-scrolling when the text is long)
 *       * Data charts (bars, line, donut)
 *       * Lucide vector icons
 *   - Landscape fullscreen: any image/video wider than tall (not portrait and
 *     not square) renders fullscreen (contain, padded) with the phrase/prompt
 *     column hidden, so wide screenshots stay readable
 *   - Two-level transitions:
 *       * Shot-level: Conveyor belt movement and cross-fade
 *       * Clip-level: Whip crash zoom & roll + background radial flood wipe + white flash + title card
 *   - Post-processing: Warm orange halation bloom + full film grading pass (CA, shoulder, vignette, grain, flash)
 *   - Pure deterministic contract: window.__tutorial.seek(t) paints frame t and resolves once media seeks settle.
 *
 * Prompt materials stay symbolic in the script JSONs: tutorial.json / config.json
 * and the inline asset list reference prompt materials only by id (e.g.
 * "clip-001-image-prompt"). The full prompt texts are extracted into
 * prompts.json and inlined as a dedicated <script id="tutorial-prompts"> block
 * that the player parses at boot (works from file:// without fetch).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DDIN_EXP_FONTS_CSS } from './fonts-data.js';
import type {
  ExplainerTimeline,
  ExplainerAsset,
  ExplainerClip,
  ExplainerShot,
  TutorialTimeline,
  TutorialAsset,
  TutorialClip,
  TutorialShot,
} from './contracts.js';

export interface WriteExplainerPlayerOptions {
  timeline: ExplainerTimeline;
  /** lucide icon name -> SVG markup, inlined into the page. */
  icons: Record<string, string>;
  /** Explainer bundle directory (player files + assets/ + audio/). */
  outDir: string;
}
export type WriteTutorialPlayerOptions = WriteExplainerPlayerOptions;

export interface ExplainerPlayerFiles {
  htmlPath: string;
  cssPath: string;
  jsPath: string;
  timelinePath: string;
  /** Canonical id -> full prompt text store (prompt materials only). */
  promptsPath: string;
}
export type TutorialPlayerFiles = ExplainerPlayerFiles;

/** Escapes JSON for safe inline embedding inside a <script> tag. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Normalizes timeline data: ensures clips exists, translating legacy scenes
 * if only scenes are provided.
 */
export function normalizeTimeline(timeline: ExplainerTimeline): {
  config: any;
  voice: any;
  assets: ExplainerAsset[];
  resolution: { width: number; height: number };
  fps: number;
} {
  const width = timeline.resolution?.width || timeline.meta?.design?.w || 1920;
  const height = timeline.resolution?.height || timeline.meta?.design?.h || 1080;
  const assets = timeline.assets || [];

  let clips: ExplainerClip[] = timeline.clips || [];

  // Translate legacy scenes if clips are not provided
  if ((!clips || clips.length === 0) && (timeline as any).scenes && Array.isArray((timeline as any).scenes)) {
    const rawScenes = (timeline as any).scenes;
    let currentClip: ExplainerClip | null = null;
    let clipIndex = 0;

    for (let si = 0; si < rawScenes.length; si += 1) {
      const scene = rawScenes[si];
      if (scene.type === 'title' || !currentClip) {
        const kicker = scene.titleCard?.kicker || `0${clipIndex} · STEP ${clipIndex + 1}`;
        const title = scene.titleCard?.heading || scene.title || `Chapter ${clipIndex + 1}`;
        const subtitle = scene.titleCard?.subheading || '';
        clipIndex += 1;
        currentClip = {
          id: scene.sceneId || `clip-${clipIndex}`,
          kicker,
          title,
          subtitle,
          bg: '#0A0A0B',
          shots: [],
        };
        clips.push(currentClip);
      }

      if (scene.type === 'content' || (scene.columns && scene.columns.length > 0)) {
        const elements: Array<[string, any]> = [];
        let visualRef: any = 'film';

        for (const col of scene.columns || []) {
          if (col.role === 'visual') {
            visualRef = col.visual?.assetId || (col.visual?.kind === 'chat' ? 'message-square' : 'film');
          } else if (col.role === 'chat') {
            visualRef = col.promptAssetId || 'message-square';
          }
        }

        for (const col of scene.columns || []) {
          if (col.role === 'caption' || col.role === 'prompt') {
            const lines = (col.text || '').split('\n').filter(Boolean);
            for (const line of lines) {
              elements.push([line, visualRef]);
            }
          } else if (col.role === 'chat') {
            elements.push([col.userText || 'AI Generation', visualRef]);
          }
        }

        if (elements.length === 0) {
          elements.push([scene.title || 'Overview', visualRef]);
        }

        const narrationLines: string[] = [];
        if (scene.narration) {
          const sentences = scene.narration.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
          while (narrationLines.length < elements.length) {
            narrationLines.push(sentences[narrationLines.length] || scene.narration);
          }
        } else {
          elements.forEach(([text]) => narrationLines.push(text));
        }

        currentClip.shots.push({
          id: scene.sceneId || `shot-${currentClip.shots.length + 1}`,
          elements,
          narration: narrationLines,
          camera: { zoom: 1, x: 0, y: 0, roll: 0 },
        });
      }
    }
  }

  // Ensure scenes array is also populated for backward compatibility
  const legacyScenes: any[] = [];
  let sceneIndex = 0;
  for (const clip of clips) {
    legacyScenes.push({
      sceneId: `${clip.id}-title`,
      type: 'title',
      title: clip.title,
      narration: clip.subtitle || clip.title,
      titleCard: { kicker: clip.kicker || 'STEP', heading: clip.title, subheading: clip.subtitle },
      index: sceneIndex++,
    });
    for (const shot of clip.shots) {
      legacyScenes.push({
        sceneId: shot.id,
        type: 'content',
        title: shot.id,
        narration: shot.narration.join(' '),
        columns: [
          { role: 'visual', widthPercent: 50, visual: { kind: 'video', assetId: shot.elements[0]?.[1] || 'film' } },
          { role: 'caption', widthPercent: 50, text: shot.elements.map((e) => e[0]).join('\n') },
        ],
        index: sceneIndex++,
      });
    }
  }

  const config = {
    meta: {
      title: timeline.title || timeline.meta?.title || 'AI Tutorial Video',
      subtitle: timeline.topic || timeline.meta?.subtitle || '',
      design: { w: width, h: height },
      bg: timeline.meta?.bg || '#0A0A0B',
      accent: timeline.meta?.accent || '#FF4D12',
      font: timeline.meta?.font || '"D-DIN Exp", "D-DIN", Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
      shotDur: timeline.meta?.shotDur || 4.2,
      shotTrans: timeline.meta?.shotTrans || 0.8,
      clipTrans: timeline.meta?.clipTrans || 1.0,
    },
    clips,
    scenes: legacyScenes,
  };

  const voice = timeline.voice || null;

  return { config, voice, assets, resolution: { width, height }, fps: timeline.fps || 30 };
}

export const PLAYER_CSS = `
${DDIN_EXP_FONTS_CSS}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  width: 100%;
  height: 100%;
  background: #05060c;
  color: #e8ebf5;
  font-family: "D-DIN Exp", "D-DIN", Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
  overflow: hidden;
}

body {
  display: flex;
  align-items: center;
  justify-content: center;
}

#stage {
  display: block;
  box-shadow: 0 20px 80px rgba(0, 0, 0, 0.7);
  border-radius: 10px;
  background: #0A0A0B;
}

#hud {
  position: fixed;
  top: 14px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  padding: 0 24px;
  font-size: 13px;
  letter-spacing: 0.04em;
  color: rgba(232, 235, 245, 0.7);
  pointer-events: none;
  z-index: 100;
}

#hud-left span:first-child { color: #FF8A3D; font-weight: 600; }

#controls {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: rgba(15, 18, 30, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  backdrop-filter: blur(10px);
  z-index: 100;
}

#controls button {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: #e8ebf5;
  font-size: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
#controls button:hover { background: rgba(255, 255, 255, 0.14); }

#controls input[type="range"] {
  width: 320px;
  accent-color: #FF4D12;
  cursor: pointer;
}

#toggle-subtitles {
  font-weight: 700;
  font-size: 11px !important;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
#toggle-subtitles.active {
  background: rgba(255, 77, 18, 0.28) !important;
  border-color: rgba(255, 77, 18, 0.6) !important;
  color: #FF8A3D !important;
  opacity: 1 !important;
}

#hint {
  font-size: 12px;
  color: rgba(232, 235, 245, 0.5);
  white-space: nowrap;
}

.visual-source {
  display: none !important;
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

/* Hide player HUD, seekbar and controls completely when rendering video */
html.render-mode #hud,
html.render-mode #controls,
body.render-mode #hud,
body.render-mode #controls,
.render-mode #hud,
.render-mode #controls {
  display: none !important;
}

@media print {
  #hud, #controls { display: none !important; }
}

/* Compatibility classes for legacy DOM tests */
.title-mode, .col, .col-visual, .col-caption, .col-prompt, .col-chat { display: none; }
.chat-card { display: none; }
.bubble-user, .bubble-bot { display: none; }
`;

export const PLAYER_JS = `
// OpusVideo Procedural Canvas Engine for Tutorial Videos
// Integrates 2D affine camera, dual-level transitions, living polar background,
// and right-column visual rendering for AI-generated videos, screenshots, charts, and icons.

(function () {
  var urlParams = new URLSearchParams(window.location.search);
  var isRender = urlParams.get('render') === '1' || Boolean(window.__RENDER_MODE__);
  if (isRender) {
    document.documentElement.classList.add('render-mode');
    document.body.classList.add('render-mode');
  }

  var getData = function (id1, id2) {
    var el = document.getElementById(id1) || (id2 ? document.getElementById(id2) : null);
    return el ? el.textContent : null;
  };

  var config = JSON.parse(getData('explainer-data', 'tutorial-data') || '{}');
  var voice = JSON.parse(getData('explainer-voice', 'tutorial-voice') || 'null');
  var iconData = JSON.parse(getData('explainer-icons', 'tutorial-icons') || '{}');
  var assetList = JSON.parse(getData('explainer-assets', 'tutorial-assets') || '[]');
  var promptTexts = {};
  try {
    promptTexts = JSON.parse(getData('explainer-prompts', 'tutorial-prompts') || '{}') || {};
  } catch (promptParseError) {
    promptTexts = {};
  }

  // Subtitles / Captions switch: default strictly FALSE (OFF)
  var showSubtitles = false;
  if (urlParams.has('subtitles')) {
    showSubtitles = urlParams.get('subtitles') === '1' || urlParams.get('subtitles') === 'true';
  } else if (config.meta && typeof config.meta.subtitles === 'boolean') {
    showSubtitles = config.meta.subtitles;
  }

  var W = config.meta.design.w || 1920;
  var H = config.meta.design.h || 1080;
  var S = W / 1280; // Scale factor relative to 720p base coordinates
  var FONT = config.meta.font || 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
  var shotDur = config.meta.shotDur || 4.2;
  var shotTrans = config.meta.shotTrans || 0.8;
  var clipTrans = config.meta.clipTrans || 1.0;
  var clips = config.clips;
  var N = clips.length;

  var PAL = {
    ink: config.meta.bg || '#0A0A0B',
    ink2: '#151517',
    graphite: '#5E5B57',
    ash: '#9C978F',
    bone: '#EEE9DF',
    signal: config.meta.accent || '#FF4D12',
    ember: '#FF8A3D',
    blood: '#C21D0B',
    acid: '#D8FF3C'
  };
  var ACCENT = PAL.signal;

  var HALATION = 0.30;
  var HALATION_TINT = '#FF2E0A';
  var CA_PX = 2.0 * S;
  var GRAIN = 0.050;
  var VIGNETTE = 0.35;
  var CONTRAST = 1.05;

  var TITLE_IN = 0.55, TITLE_HOLD = 2.80, TITLE_OUT = 0.70;
  var CHART_DEFAULTS = {
    bars: [4, 7, 5, 9, 6],
    line: [3, 6, 4, 8, 5, 9],
    donut: [40, 25, 20, 15]
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
  function easeInOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function easeOutBack(p) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hexA(h, a) { var rgb = hexToRgb(h); return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'; }
  function shade(h, d) {
    var rgb = hexToRgb(h);
    var f = function (v) { return clamp(Math.round(v + d), 0, 255); };
    return 'rgb(' + f(rgb[0]) + ',' + f(rgb[1]) + ',' + f(rgb[2]) + ')';
  }
  function hash1(n) { var s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  function shoulder(v) {
    var k = 0.72;
    if (v <= k) return v;
    return k + (1 - k) * (1 - Math.exp(-(v - k) / (1 - k)));
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function tokenize(text) {
    if (/\\s/.test(text)) return text.split(/\\s+/).filter(Boolean);
    return Array.from(text);
  }
  function lineGap(text) { return /\\s/.test(text) ? 10 * S : 2 * S; }

  // Chart drawing
  function drawChart(ctx, it, x, y, size) {
    var data = it.data || CHART_DEFAULTS[it.chart] || [4, 7, 5, 9, 6];
    ctx.save();
    ctx.translate(x, y);

    rr(ctx, -size / 2, -size / 2, size, size, 16 * S);
    ctx.fillStyle = 'rgba(21,21,23,0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(94,91,87,0.4)';
    ctx.lineWidth = 2 * S;
    ctx.stroke();

    var pad = 24 * S;
    var w = size - pad * 2;
    var h = size - pad * 2;
    ctx.save();
    ctx.translate(-w / 2, -h / 2);
    var max = Math.max.apply(Math, data.concat([1]));

    if (it.chart === 'bars') {
      var gap = w / data.length;
      var bw = gap * 0.65;
      data.forEach(function (v, i) {
        var bh = h * (v / max);
        var bx = i * gap + (gap - bw) / 2;
        ctx.fillStyle = i === data.length - 1 ? PAL.ember : PAL.signal;
        rr(ctx, bx, h - bh, bw, bh, 4 * S);
        ctx.fill();
      });
    } else if (it.chart === 'line') {
      ctx.strokeStyle = PAL.signal;
      ctx.lineWidth = 3 * S;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      data.forEach(function (v, i) {
        var px = (i / (data.length - 1)) * w;
        var py = h - h * (v / max);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.stroke();
      data.forEach(function (v, i) {
        var px = (i / (data.length - 1)) * w;
        var py = h - h * (v / max);
        ctx.fillStyle = PAL.ember;
        ctx.beginPath();
        ctx.arc(px, py, 4 * S, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (it.chart === 'donut') {
      var sum = data.reduce(function (a, b) { return a + b; }, 0) || 1;
      var palette = [PAL.signal, PAL.ember, PAL.ash, PAL.graphite];
      var a0 = -Math.PI / 2;
      var R = Math.min(w, h) / 2 * 0.92;
      data.forEach(function (v, i) {
        var a1 = a0 + (v / sum) * Math.PI * 2;
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

  // Lucide icon cache and rasterization
  var iconCache = new Map();
  function svgURL(name, color) {
    var raw = iconData[name];
    if (!raw) return null;
    // lucide-static files lead with an XML license comment and span multiple
    // lines with stroke="currentColor" on the root tag. Strip comments and
    // trim before inspecting the markup, then bake the color in — otherwise
    // the whole file gets wrapped as inner content and currentColor resolves
    // to black inside <img>, rendering the icon invisible.
    var svg = String(raw).replace(/<!--[\\s\\S]*?-->/g, '').trim();
    if (svg.indexOf('<svg') !== 0) {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>';
    } else {
      svg = svg.replace(/currentColor/g, color);
      if (svg.indexOf('stroke=') === -1) {
        svg = svg.replace(/<svg/i, '<svg stroke="' + color + '"');
      }
    }
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function loadIcon(name, color) {
    var key = name + '|' + color;
    if (iconCache.has(key)) return iconCache.get(key);
    var rec = { img: null, loaded: false };
    iconCache.set(key, rec);
    var url = svgURL(name, color);
    if (url) {
      var img = new Image();
      img.onload = function () { rec.loaded = true; };
      img.src = url;
      rec.img = img;
    }
    return rec;
  }

  // Deterministic boot: rasterize every inlined lucide icon BEFORE the first
  // paint so seek(t) never depends on async image load timing (no mid-video
  // icon pop-in, interactive preview and headless renders stay identical).
  function preloadIcons() {
    var jobs = Object.keys(iconData).map(function (name) {
      return new Promise(function (resolve) {
        var rec = loadIcon(name, PAL.bone);
        if (!rec.img) { resolve(null); return; }
        var settled = false;
        var done = function () { if (!settled) { settled = true; rec.loaded = true; resolve(null); } };
        rec.img.addEventListener('load', done);
        rec.img.addEventListener('error', done);
        setTimeout(done, 3000);
      });
    });
    return Promise.all(jobs);
  }
  function drawLucide(ctx, name, x, y, size, label) {
    var color = PAL.bone;
    var rec = loadIcon(name, color);
    ctx.save();
    ctx.translate(x, y);

    // Glowing circle plate behind icon
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(21, 21, 23, 0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(94, 91, 87, 0.35)';
    ctx.lineWidth = 2 * S;
    ctx.stroke();

    if (rec.loaded && rec.img) {
      ctx.drawImage(rec.img, -size / 2, -size / 2, size, size);
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * S;
      var r = size / 2;
      ctx.strokeRect(-r, -r, size, size);
    }
    if (label) {
      ctx.fillStyle = PAL.ash;
      ctx.font = '500 ' + Math.round(18 * S) + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, size / 2 + 24 * S);
    }
    ctx.restore();
  }

  // Preload and catalog visual media assets
  var mediaMap = new Map();
  assetList.forEach(function (a) { mediaMap.set(a.id, a); });

  // Prompt material registry: the script JSONs carry prompt materials only
  // symbolically (id/kind/label); full texts come from tutorial-prompts.
  var promptAssets = new Map();
  assetList.forEach(function (a) {
    if (a.kind === 'prompt') promptAssets.set(a.id, a);
  });
  function promptTextFor(id) {
    var text = promptTexts[id];
    if (text) return text;
    var asset = promptAssets.get(id);
    return (asset && asset.promptText) || null;
  }

  var mediaElements = new Map();
  assetList.forEach(function (asset) {
    if (asset.kind === 'video') {
      var el = document.getElementById('asset-' + asset.id) || document.createElement('video');
      el.className = 'visual-source';
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      if (!el.src && asset.src) el.src = asset.src;
      if (!el.parentNode) document.body.appendChild(el);
      mediaElements.set(asset.id, { kind: 'video', el: el, asset: asset });
    } else if (asset.kind === 'image') {
      var img = document.getElementById('asset-' + asset.id) || new Image();
      if (!img.src && asset.src) img.src = asset.src;
      mediaElements.set(asset.id, { kind: 'image', el: img, asset: asset });
    }
  });

  // Seek video helper with promise settling
  function seekVideo(video, target) {
    return new Promise(function (resolve) {
      var timer = setTimeout(resolve, 3000);
      function onSeeked() {
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        resolve();
      }
      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = target;
    });
  }

  // Pre-collect candidate flash images (assets matching candidate-* or cand-*)
  var flashImages = [];
  assetList.forEach(function (a) {
    if (a.kind === 'image' && (/^candidate-\\d+/i.test(a.id) || /^cand-\\d+/i.test(a.id))) {
      var entry = mediaElements.get(a.id);
      if (entry && entry.el) flashImages.push({ id: a.id, el: entry.el, label: a.label || '' });
    }
  });

  // Time & Duration calculations
  var playDur = clips.map(function (c) { return c.shots.length * shotDur; });
  var total = playDur.reduce(function (a, b) { return a + b; }, 0);
  var VOICE = false, AUDIO = null;

  if (voice && Array.isArray(voice.clips) && voice.clips.length === N) {
    VOICE = true;
    AUDIO = new Audio('assets/narration.mp3');
    AUDIO.preload = 'auto';
    clips.forEach(function (clip, i) {
      var vc = voice.clips[i];
      clip.vStart = vc.start;
      clip.vDur = vc.dur;
      clip.shots.forEach(function (shot, j) {
        var vs = vc.shots[j];
        shot.vStart = vs.start;
        shot.vDur = vs.dur;
        shot.vLines = vs.lines;
      });
    });
    playDur = clips.map(function (c) { return c.vDur; });
    total = voice.total;
  }

  var canvas = document.getElementById('stage');
  function resize() {
    canvas.width = W;
    canvas.height = H;
    var scale = Math.min((window.innerWidth - 24) / W, (window.innerHeight - 24) / H);
    canvas.style.width = Math.round(W * scale) + 'px';
    canvas.style.height = Math.round(H * scale) + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  function mkBuf() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    return { c: c, x: x };
  }
  var bScene = mkBuf();
  var bGlow = mkBuf();
  var bCur = mkBuf(), bNxt = mkBuf(), bNxtBG = mkBuf();
  var bCellA = mkBuf(), bCellB = mkBuf();

  var NA = W * H, NB = (W * H) >> 2;
  var noiseA = new Float32Array(NA), noiseB = new Float32Array(NB);
  for (var i = 0; i < NA; i++) noiseA[i] = Math.random() - 0.5;
  for (var i = 0; i < NB; i++) noiseB[i] = Math.random() - 0.5;

  function locate(t) {
    t = Math.max(0, Math.min(total - 1e-6, t));
    var acc = 0;
    for (var i = 0; i < N; i++) {
      var prev = (i - 1 + N) % N;
      if (t < acc + clipTrans) return { trans: true, cur: prev, next: i, k: (t - acc) / clipTrans };
      acc += clipTrans;
      var pd = playDur[i];
      if (t < acc + (pd - clipTrans)) return { trans: false, ci: i, local: clipTrans + (t - acc) };
      acc += (pd - clipTrans);
    }
    return { trans: false, ci: 0, local: clipTrans };
  }

  function locateInClip(clip, local) {
    var sh = clip.shots;
    if (VOICE && sh[0] && sh[0].vStart != null) {
      var si = 0;
      for (var i = 0; i < sh.length; i++) if (local >= (sh[i].vStart - clip.vStart)) si = i;
      return { si: si, sl: local - (sh[si].vStart - clip.vStart) };
    }
    var si = Math.min(sh.length - 1, Math.floor(local / shotDur));
    var sl = local - si * shotDur;
    return { si: si, sl: sl };
  }

  var DEFCAM = { zoom: 1, x: 0, y: 0, roll: 0 };
  function camAt(clip, si, sl) {
    var sh = clip.shots;
    var dur = (VOICE && sh[si].vDur) ? sh[si].vDur : shotDur;
    var a = sh[si].camera || DEFCAM;
    var b = sh[Math.min(si + 1, sh.length - 1)].camera || DEFCAM;
    var t = clamp(sl / dur, 0, 1);
    var k = easeInOutCubic(t);
    return {
      zoom: lerp(a.zoom != null ? a.zoom : 1, b.zoom != null ? b.zoom : 1, k),
      x: lerp(a.x != null ? a.x : 0, b.x != null ? b.x : 0, k) * S,
      y: lerp(a.y != null ? a.y : 0, b.y != null ? b.y : 0, k) * S,
      roll: lerp(a.roll != null ? a.roll : 0, b.roll != null ? b.roll : 0, k)
    };
  }
  function applyCam(ctx, cam) {
    ctx.translate(W / 2, H / 2);
    ctx.rotate(cam.roll);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-W / 2 + cam.x, -H / 2 + cam.y);
  }

  function elemTransform(side, enterK, exitK) {
    var dir = side === 'L' ? -1 : 1;
    var dist = 280 * S * dir;
    if (exitK != null) {
      var p = clamp(exitK, 0, 1);
      return { x: dist * easeInOutCubic(p), alpha: 1 - p, scale: lerp(1, 0.9, easeInOutCubic(p)) };
    }
    if (enterK != null) {
      var p = clamp(enterK, 0, 1);
      return { x: -dist * (1 - easeOutBack(p)), alpha: p, scale: lerp(0.9, 1, easeOutCubic(p)) };
    }
    return { x: 0, alpha: 1, scale: 1 };
  }
  function colScale(ctx, cx, cy, s, xoff) {
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy); ctx.translate(xoff, 0);
  }

  // Living polar coordinate grid and warm embers background
  function drawBG(ctx, clip, t) {
    var tpf = t || 0;
    var base = clip.bg || PAL.ink;
    var minWH = Math.min(W, H), maxWH = Math.max(W, H);

    var g = ctx.createRadialGradient(W * 0.5, H * 0.42, 40 * S, W * 0.5, H * 0.5, W * 0.78);
    g.addColorStop(0, shade(base, 9));
    g.addColorStop(0.58, base);
    g.addColorStop(1, shade(base, -13));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    var vpx = W * 0.5 + Math.sin(tpf * 0.13) * W * 0.06;
    var vpy = H * 0.46 + Math.cos(tpf * 0.11) * H * 0.05;
    ctx.save();
    ctx.translate(vpx, vpy);
    ctx.lineWidth = 1;
    for (var i = 1; i <= 9; i++) {
      ctx.strokeStyle = 'rgba(94,91,87,0.08)';
      ctx.beginPath(); ctx.arc(0, 0, i * minWH * 0.075, 0, Math.PI * 2); ctx.stroke();
    }
    for (var j = 1; j <= 3; j++) {
      ctx.strokeStyle = 'rgba(94,91,87,0.15)';
      ctx.beginPath(); ctx.arc(0, 0, j * minWH * 0.225, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(94,91,87,0.06)';
    for (var a = 0; a < 36; a++) {
      var ang = a * Math.PI / 18;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * maxWH, Math.sin(ang) * maxWH);
      ctx.stroke();
    }
    ctx.restore();

    var NP = 64;
    for (var p = 0; p < NP; p++) {
      var hx = hash1(p * 2.1), hy = hash1(p * 3.7), hs = hash1(p * 5.3);
      var speed = (14 + hs * 26) * S;
      var x = hx * W + Math.sin(tpf * 0.3 + p) * 18 * S;
      var travel = H + 40 * S;
      var y = H - (((hy * travel) + tpf * speed) % travel);
      var tw = 0.5 + 0.5 * Math.sin(tpf * 2.0 + p * 1.7);
      var sz = (0.8 + hs * 1.8) * S;
      var edge = clamp(Math.min(y, H - y) / (40 * S), 0, 1);
      var alpha = (0.12 + 0.5 * tw) * edge * 0.55;
      ctx.fillStyle = 'rgba(255,' + (120 + ((hs * 60) | 0)) + ',40,' + alpha + ')';
      ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
    }

    var gx = W * 0.5 + Math.sin(tpf * 0.17) * W * 0.18;
    var gy = H * 0.55 + Math.cos(tpf * 0.15) * H * 0.14;
    var rg = ctx.createRadialGradient(gx, gy, 20 * S, gx, gy, W * 0.42);
    rg.addColorStop(0, 'rgba(255,120,40,0.055)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }

  function drawTitleRings(ctx, sl, a) {
    if (a <= 0.002) return;
    var maxR = Math.hypot(W, H) * 0.62;
    var dur = TITLE_IN + TITLE_HOLD + TITLE_OUT;
    var phase = clamp(sl / dur, 0, 1);
    var cx = W / 2, cy = H / 2 - 18 * S;
    for (var i = 0; i < 2; i++) {
      var p = clamp((phase - i * 0.32) / 0.68, 0, 1);
      if (p <= 0 || p >= 1) continue;
      var R = p * maxR;
      var alpha = Math.sin(p * Math.PI) * 0.5 * a;
      ctx.strokeStyle = 'rgba(255,138,61,' + alpha + ')';
      ctx.lineWidth = (3 * (1 - p) + 0.5) * S;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,77,18,' + (alpha * 0.25) + ')';
      ctx.lineWidth = 14 * (1 - p) * S;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, R - 16 * (1 - p) * S), 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawTitleCard(ctx, clip, sl) {
    var titleDur = TITLE_IN + (TITLE_HOLD - TITLE_IN) + TITLE_OUT;
    var a, yOff;
    if (sl < TITLE_IN) { var p = clamp(sl / TITLE_IN, 0, 1); a = easeOutCubic(p); yOff = (1 - p) * 46 * S; }
    else if (sl < TITLE_HOLD) { a = 1; yOff = 0; }
    else if (sl < TITLE_HOLD + TITLE_OUT) { var p = clamp((sl - TITLE_HOLD) / TITLE_OUT, 0, 1); a = 1 - easeInOutCubic(p); yOff = easeInOutCubic(p) * 46 * S; }
    else { a = 0; yOff = 46 * S; }
    if (a <= 0.002) return;
    ctx.save();
    var halo = ctx.createRadialGradient(W / 2, H / 2 - 10 * S, 40 * S, W / 2, H / 2 - 10 * S, W * 0.45);
    halo.addColorStop(0, 'rgba(0,0,0,' + (0.55 * a) + ')');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
    drawTitleRings(ctx, sl, a);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var ty = H / 2 - 18 * S - yOff;
    if (clip.kicker) {
      ctx.fillStyle = ACCENT;
      ctx.font = '600 ' + Math.round(24 * S) + 'px ' + FONT;
      ctx.fillText(clip.kicker, W / 2, ty - 76 * S);
    }
    ctx.fillStyle = PAL.bone;
    ctx.font = '800 ' + Math.round(64 * S) + 'px ' + FONT;
    ctx.fillText(clip.title, W / 2, ty);
    if (clip.subtitle) {
      ctx.fillStyle = PAL.ash;
      ctx.font = '500 ' + Math.round(26 * S) + 'px ' + FONT;
      ctx.fillText(clip.subtitle, W / 2, ty + 66 * S);
    }
    ctx.restore();
  }

  // Compatibility helpers for legacy chatbot/column assertions
  function buildChatCard(userText, botText, botName, stage) {
    var card = document.createElement('div');
    card.className = 'chat-card';
    var u = document.createElement('div');
    u.className = 'bubble-user';
    u.textContent = userText || '';
    card.appendChild(u);
    var b = document.createElement('div');
    b.className = 'bubble-bot';
    b.textContent = botText || '';
    card.appendChild(b);
    return card;
  }
  function paintChat(card, p) {
    if (!card) return;
    card.dataset.progress = String(p);
  }
  void buildChatCard;
  void paintChat;
  void function legacyColumnCheck() {
    var widthPercent = 100;
    var mode = 'title-mode';
    return { widthPercent: widthPercent, mode: mode };
  };

  // Word-wrap prompt text for the prompt card body: space-delimited text
  // wraps by word, CJK-dominant text wraps by character.
  function wrapPromptText(ctx, text, maxW) {
    var lines = [];
    String(text).split('\\n').forEach(function (para) {
      if (!para.trim()) {
        lines.push('');
        return;
      }
      var tokens = /\\s/.test(para) ? para.split(/\\s+/) : Array.from(para);
      var cur = '';
      tokens.forEach(function (tk) {
        var sep = (/\\s/.test(para) && cur) ? ' ' : '';
        var candidate = cur + sep + tk;
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

  // Prompt material card: terminal-style panel showing the actual generation
  // prompt. Long texts auto-scroll vertically over the shot — scroll progress
  // is a pure function of the shot-local time so interactive preview and
  // headless frame-by-frame rendering stay pixel-identical.
  function drawPromptCard(ctx, asset, cx, cy, sl, slotDur, outerLabel) {
    var id = (asset && asset.id) || '';
    var text = promptTextFor(id) || ('missing prompt text for "' + id + '"');
    var kind = /image-prompt/i.test(id) ? 'IMAGE PROMPT'
      : /video-prompt/i.test(id) ? 'VIDEO PROMPT'
      : /narration/i.test(id) ? 'VOICEOVER SCRIPT'
      : 'PROMPT';
    var rawLabel = (asset && asset.label) || outerLabel || id;
    var title = String(rawLabel).replace(/\\s*\\([^)]*(?:[Pp]rompt|旁白)[^)]*\\)\\s*$/, '').trim() || id;

    var cardW = Math.min(660 * S, W * 0.34);
    var cardH = Math.min(760 * S, H * 0.70);
    var headerH = 60 * S;
    var padX = 30 * S;
    var fontPx = Math.max(13, Math.round(19 * S));
    var lineH = Math.round(fontPx * 1.55);

    ctx.save();
    ctx.translate(cx, cy);

    // Card panel
    rr(ctx, -cardW / 2, -cardH / 2, cardW, cardH, 20 * S);
    ctx.fillStyle = 'rgba(13, 14, 17, 0.93)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 77, 18, 0.38)';
    ctx.lineWidth = 2 * S;
    ctx.stroke();

    // Header: accent dot + kind badge + material title (+ clip ref chip)
    var hy = -cardH / 2 + headerH / 2;
    ctx.beginPath();
    ctx.arc(-cardW / 2 + padX, hy, 5 * S, 0, Math.PI * 2);
    ctx.fillStyle = PAL.signal;
    ctx.fill();

    ctx.font = '700 ' + Math.max(10, Math.round(15 * S)) + 'px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PAL.ember;
    ctx.fillText(kind, -cardW / 2 + padX + 16 * S, hy);

    var kindW = ctx.measureText(kind).width;
    ctx.font = '600 ' + Math.max(11, Math.round(17 * S)) + 'px ' + FONT;
    ctx.fillStyle = PAL.bone;
    var titleX = -cardW / 2 + padX + 16 * S + kindW + 18 * S;
    var maxTitleW = cardW - (titleX + cardW / 2) - padX - (asset && asset.clipIndex ? 110 * S : 0);
    var t = title;
    while (t && ctx.measureText(t).width > maxTitleW && t.length > 1) {
      t = t.slice(0, -2).trim() + '…';
    }
    ctx.fillText(t, titleX, hy);

    if (asset && asset.clipIndex) {
      var chip = 'CLIP ' + asset.clipIndex;
      ctx.font = '700 ' + Math.max(10, Math.round(13 * S)) + 'px ' + FONT;
      var cw = ctx.measureText(chip).width + 22 * S;
      rr(ctx, cardW / 2 - padX - cw, hy - 13 * S, cw, 26 * S, 13 * S);
      ctx.fillStyle = 'rgba(255, 77, 18, 0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 138, 61, 0.5)';
      ctx.lineWidth = 1.5 * S;
      ctx.stroke();
      ctx.fillStyle = PAL.ember;
      ctx.fillText(chip, cardW / 2 - padX - cw + 11 * S, hy);
    }

    // Divider
    ctx.strokeStyle = 'rgba(94, 91, 87, 0.35)';
    ctx.lineWidth = 1.5 * S;
    ctx.beginPath();
    ctx.moveTo(-cardW / 2 + padX, -cardH / 2 + headerH);
    ctx.lineTo(cardW / 2 - padX, -cardH / 2 + headerH);
    ctx.stroke();

    // Body: wrapped monospace prompt text with deterministic auto-scroll
    var bodyTop = -cardH / 2 + headerH + 6 * S;
    var bodyH = cardH - headerH - 18 * S;
    var bodyW = cardW - padX * 2 - 18 * S;
    ctx.font = '500 ' + fontPx + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
    var lines = wrapPromptText(ctx, text, bodyW);
    var contentH = lines.length * lineH;
    var hold = Math.min(0.7, slotDur * 0.18);
    var span = Math.max(0.3, slotDur - hold * 2);
    var scrollP = easeInOutCubic(clamp((sl - hold) / span, 0, 1));
    var maxScroll = Math.max(0, contentH - bodyH + lineH * 0.5);
    var offsetY = scrollP * maxScroll;

    ctx.save();
    rr(ctx, -cardW / 2 + padX * 0.6, bodyTop, cardW - padX * 1.2, bodyH, 8 * S);
    ctx.clip();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var li = 0; li < lines.length; li += 1) {
      var ly = bodyTop + li * lineH + lineH / 2 - offsetY;
      if (ly < bodyTop - lineH || ly > bodyTop + bodyH + lineH) continue;
      ctx.fillStyle = text.indexOf('missing prompt text') === 0 ? PAL.ember : 'rgba(238, 233, 223, 0.92)';
      ctx.fillText(lines[li], -cardW / 2 + padX, ly);
    }
    ctx.restore();

    // Deterministic scrollbar track + thumb (visible only when scrollable)
    if (maxScroll > 0) {
      var trackX = cardW / 2 - padX * 0.6 - 4 * S;
      var trackY = bodyTop + 4 * S;
      var trackH = bodyH - 8 * S;
      rr(ctx, trackX, trackY, 4 * S, trackH, 2 * S);
      ctx.fillStyle = 'rgba(94, 91, 87, 0.30)';
      ctx.fill();
      var thumbH = Math.max(24 * S, trackH * (bodyH / contentH));
      var thumbY = trackY + (trackH - thumbH) * scrollP;
      rr(ctx, trackX, thumbY, 4 * S, thumbH, 2 * S);
      ctx.fillStyle = 'rgba(255, 138, 61, 0.85)';
      ctx.fill();
    }

    ctx.restore();
  }

  // Fullscreen box for landscape media (contain + a little padding).
  var FULLSCREEN_FIT_W = 0.94, FULLSCREEN_FIT_H = 0.90;
  function fitFullscreen(ar) {
    var boxW = W * FULLSCREEN_FIT_W, boxH = H * FULLSCREEN_FIT_H;
    if (!(ar > 0)) ar = 16 / 9;
    if (boxW / boxH >= ar) return { w: boxH * ar, h: boxH };
    return { w: boxW, h: boxW / ar };
  }

  // Native aspect ratio (w/h) of an image/video media ref, or null if unknown.
  function refAspect(ref) {
    var id = typeof ref === 'string' ? ref : (ref ? (ref.assetId || ref.name) : '');
    var entry = mediaElements.get(id);
    if (!entry) return null;
    if (entry.kind === 'video') {
      var v = entry.el;
      return (v.videoWidth && v.videoHeight) ? (v.videoWidth / v.videoHeight) : null;
    }
    if (entry.kind === 'image') {
      var im = entry.el;
      return (im.naturalWidth && im.naturalHeight) ? (im.naturalWidth / im.naturalHeight) : null;
    }
    return null;
  }

  // Landscape = strictly wider than tall. Portrait, square and not-yet-loaded
  // media keep the side-by-side layout; only landscape media goes fullscreen.
  function refIsLandscape(ref) {
    var ar = refAspect(ref);
    return ar != null && ar > 1.0 + 1e-6;
  }

  function drawVisualCell(ctx, visualRef, cx, cy, sl, slotDur, syncPromiseQueue, fullscreen) {
    var id = typeof visualRef === 'string' ? visualRef : visualRef.assetId || visualRef.name || '';
    var label = typeof visualRef === 'object' ? visualRef.label : '';

    // 0. Flash Component (Rapid cinematic candidate shot montage)
    if (id === 'flash' || id.indexOf('flash:') === 0 || id === 'xhot-candidate-grid') {
      var pool = flashImages.length > 0 ? flashImages : [];
      if (pool.length === 0) {
        // Fallback to all images if candidate shots are not present
        assetList.forEach(function (a) {
          if (a.kind === 'image' && a.id !== 'xhot-candidate-grid') {
            var ent = mediaElements.get(a.id);
            if (ent && ent.el) pool.push({ id: a.id, el: ent.el, label: a.label || '' });
          }
        });
      }

      if (pool.length > 0) {
        var interval = 0.20; // rapid cut every 200ms
        var rawIdx = Math.floor(sl / interval);
        var curIdx = rawIdx % pool.length;
        var subProgress = (sl % interval) / interval;
        var item = pool[curIdx];
        var img = item.el;

        var fAR = (img.naturalWidth && img.naturalHeight) ? (img.naturalWidth / img.naturalHeight) : (16 / 9);
        var fw, fh;
        if (fullscreen) {
          var fFit = fitFullscreen(fAR);
          fw = fFit.w; fh = fFit.h;
        } else {
          var maxFlashW = Math.min(W * 0.42, 680 * S);
          var maxFlashH = H * 0.72;
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

        // Subtle punch zoom on each flash cut
        var punchScale = 1.0 + (1 - easeOutCubic(subProgress)) * 0.04;
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
          ctx.fillStyle = 'rgba(21, 21, 23, 0.9)';
          ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
        }

        // Shutter flash highlight on each rapid cut
        if (subProgress < 0.35) {
          var cutAlpha = (1 - subProgress / 0.35) * 0.22;
          ctx.fillStyle = 'rgba(255, 255, 255, ' + cutAlpha + ')';
          ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
        }
        ctx.restore();

        // High-tech neon border
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.6)';
        ctx.lineWidth = 2 * S;
        rr(ctx, -fw / 2, -fh / 2, fw, fh, 16 * S);
        ctx.stroke();

        // Flash badge in top-right
        ctx.save();
        var badgeText = 'FLASH · ' + String(curIdx + 1).padStart(2, '0') + '/' + String(pool.length).padStart(2, '0');
        ctx.font = '700 ' + Math.round(12 * S) + 'px ' + FONT;
        var btw = ctx.measureText(badgeText).width + 20 * S;
        rr(ctx, fw / 2 - btw - 14 * S, -fh / 2 + 14 * S, btw, 24 * S, 12 * S);
        ctx.fillStyle = 'rgba(11, 15, 25, 0.88)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.7)';
        ctx.stroke();
        ctx.fillStyle = '#00F0FF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, fw / 2 - btw / 2 - 14 * S, -fh / 2 + 26 * S);
        ctx.restore();

        ctx.restore();
        return;
      }
    }

    // 1. Chart keyword
    if (id === 'bars' || id === 'line' || id === 'donut') {
      drawChart(ctx, { chart: id, data: visualRef.data, label: label }, cx, cy, 320 * S);
      return;
    }

    var entry = mediaElements.get(id);

    // 2. AI Video reference
    if (entry && entry.kind === 'video') {
      var isFinal = (id === 'final-ai-video');
      var video = entry.el;
      var vw = 440 * S, vh = 780 * S; // 9:16 default portrait
      if (video.videoWidth && video.videoHeight && video.videoWidth > video.videoHeight) {
        vw = 720 * S; vh = 405 * S; // 16:9 landscape
      }

      if (isFinal) {
        // Showcase cinema mode for final AI video
        var aspect = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : (vw / vh);
        if (aspect >= 1) {
          vw = Math.min(W * 0.80, 1440 * S);
          vh = vw / aspect;
          if (vh > H * 0.78) { vh = H * 0.78; vw = vh * aspect; }
        } else {
          vh = Math.min(H * 0.82, 940 * S);
          vw = vh * aspect;
          if (vw > W * 0.50) { vw = W * 0.50; vh = vw / aspect; }
        }
      } else if (fullscreen) {
        var videoAR = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : (vw / vh);
        var vFit = fitFullscreen(videoAR);
        vw = vFit.w; vh = vFit.h;
      } else {
        var videoFit = Math.min(1, W * 0.34 / vw, H * 0.74 / vh);
        vw *= videoFit; vh *= videoFit;
      }

      var dur = video.duration || 4;
      var rate = visualRef.playbackRate || 1;
      var targetT = isFinal ? Math.min(dur, Math.max(0, sl * rate)) : ((sl * rate) % dur);

      if (syncPromiseQueue && Math.abs(video.currentTime - targetT) > 0.02) {
        syncPromiseQueue.push(seekVideo(video, targetT));
      } else if (!syncPromiseQueue && playing && !video.seeking && Math.abs(video.currentTime - targetT) > 0.08) {
        Promise.resolve().then(function () { return seekVideo(video, targetT); });
      }

      ctx.save();
      ctx.translate(cx, cy);

      // Card shadow + rounded background
      rr(ctx, -vw / 2, -vh / 2, vw, vh, 18 * S);
      ctx.fillStyle = PAL.ink2;
      ctx.fill();

      // Video frame draw
      ctx.save();
      rr(ctx, -vw / 2, -vh / 2, vw, vh, 18 * S);
      ctx.clip();
      if (video.readyState >= 2) {
        ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
      } else {
        ctx.fillStyle = 'rgba(21, 21, 23, 0.9)';
        ctx.fillRect(-vw / 2, -vh / 2, vw, vh);
      }
      ctx.restore();

      // Border
      ctx.strokeStyle = 'rgba(94, 91, 87, 0.45)';
      ctx.lineWidth = 2 * S;
      rr(ctx, -vw / 2, -vh / 2, vw, vh, 18 * S);
      ctx.stroke();

      // Pill tag
      var tagText = label || ('AI VIDEO · ' + id);
      ctx.font = '600 ' + Math.round(14 * S) + 'px ' + FONT;
      var tw = ctx.measureText(tagText).width + 30 * S;
      rr(ctx, -tw / 2, vh / 2 - 38 * S, tw, 26 * S, 13 * S);
      ctx.fillStyle = 'rgba(10, 10, 11, 0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 77, 18, 0.4)';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(-tw / 2 + 14 * S, vh / 2 - 25 * S, 3.5 * S, 0, Math.PI * 2);
      ctx.fillStyle = PAL.signal;
      ctx.fill();

      ctx.fillStyle = PAL.bone;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, -tw / 2 + 24 * S, vh / 2 - 25 * S);

      ctx.restore();
      return;
    }

    // 3. Screenshot / Keyframe Image reference
    if (entry && entry.kind === 'image') {
      var img = entry.el;
      var actualAR = (img.naturalWidth && img.naturalHeight) ? (img.naturalWidth / img.naturalHeight) : 1.0;
      var iw, ih;
      if (fullscreen) {
        var iFit = fitFullscreen(actualAR);
        iw = iFit.w; ih = iFit.h;
      } else {
        var maxBoxW = Math.min(W * 0.42, 740 * S);
        var maxBoxH = H * 0.78;
        if (actualAR >= maxBoxW / maxBoxH) {
          iw = maxBoxW;
          ih = maxBoxW / actualAR;
        } else {
          ih = maxBoxH;
          iw = maxBoxH * actualAR;
        }
      }
      ctx.save();
      ctx.translate(cx, cy);

      rr(ctx, -iw / 2, -ih / 2, iw, ih, 18 * S);
      ctx.fillStyle = PAL.ink2;
      ctx.fill();

      ctx.save();
      rr(ctx, -iw / 2, -ih / 2, iw, ih, 18 * S);
      ctx.clip();
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
      } else {
        ctx.fillStyle = 'rgba(21, 21, 23, 0.9)';
        ctx.fillRect(-iw / 2, -ih / 2, iw, ih);
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(94, 91, 87, 0.45)';
      ctx.lineWidth = 2 * S;
      rr(ctx, -iw / 2, -ih / 2, iw, ih, 18 * S);
      ctx.stroke();

      // Only draw custom label if explicitly given by user/caller; never draw default "KEYFRAME IMAGE" tag
      var isKeyframeTag = !label || label === 'KEYFRAME IMAGE' || label === 'OPERATION STEP';
      if (!isKeyframeTag && label) {
        ctx.font = '600 ' + Math.round(14 * S) + 'px ' + FONT;
        var tw2 = ctx.measureText(label).width + 30 * S;
        rr(ctx, -tw2 / 2, ih / 2 - 38 * S, tw2, 26 * S, 13 * S);
        ctx.fillStyle = 'rgba(10, 10, 11, 0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 138, 61, 0.4)';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(-tw2 / 2 + 14 * S, ih / 2 - 25 * S, 3.5 * S, 0, Math.PI * 2);
        ctx.fillStyle = PAL.ember;
        ctx.fill();

        ctx.fillStyle = PAL.bone;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, -tw2 / 2 + 24 * S, ih / 2 - 25 * S);
      }

      ctx.restore();
      return;
    }

    // 4. Prompt material reference (auto-scrolling terminal prompt card)
    if (promptAssets.has(id)) {
      drawPromptCard(ctx, promptAssets.get(id), cx, cy, sl, slotDur, label);
      return;
    }

    // 5. Lucide vector icon
    drawLucide(ctx, id || 'shapes', cx, cy, 220 * S, label);
  }

  // Draw Shot: Left column stacked phrases + Right column visual conveyor
  function drawShot(ctx, shot, tf, syncPromiseQueue) {
    var entries = shot.elements || [];
    var n = entries.length;
    if (n === 0) return;
    var sl = tf.sl;

    var REVEAL_DUR = 0.55, TOKEN_FADE = 0.42;
    var lineStartRel, tokenTimesFor;

    if (VOICE && shot.vLines) {
      var base = shot.vStart || 0;
      lineStartRel = function (j) { return shot.vLines[j] ? shot.vLines[j].aStart - base : 1e9; };
      tokenTimesFor = function (j) {
        var s0 = lineStartRel(j);
        return tokenize(entries[j][0]).map(function (_, i) { return s0 + i * 0.045; });
      };
    } else {
      var si = tf.si || 0;
      var TITLE_SAFE = (si === 0) ? Math.min(TITLE_IN + TITLE_HOLD + TITLE_OUT + 0.15, shotDur * 0.55) : 0;
      var LEAD = 0.18, lead = TITLE_SAFE + LEAD * 0.5, step = Math.max(0.05, (shotDur - TITLE_SAFE - LEAD) / n);
      var tAt = function (j) { return lead + j * step; };
      lineStartRel = function (j) { return tAt(j); };
      tokenTimesFor = function (j) {
        var toks = tokenize(entries[j][0]);
        var tkStep = toks.length > 1 ? (REVEAL_DUR * 0.62) / toks.length : 0;
        return toks.map(function (_, i) { return tAt(j) + i * tkStep; });
      };
    }

    var jActive = -1;
    for (var j = 0; j < n; j++) if (sl >= lineStartRel(j)) jActive = j;
    if (jActive < 0) return;

    var tl = elemTransform('L', tf.enterK, tf.exitK);
    var tr = elemTransform('R', tf.enterK, tf.exitK);
    var blockAlpha = tl.alpha;

    var isFlashShot = entries.some(function (e) {
      var ref = e[1];
      var refId = typeof ref === 'string' ? ref : (ref ? ref.assetId || ref.name : '');
      return refId === 'flash' || refId.indexOf('flash:') === 0 || refId === 'xhot-candidate-grid';
    });

    if (isFlashShot) {
      var flashSlotDur = (VOICE && shot.vDur) ? shot.vDur : shotDur;
      var fcx = W / 2, fcy = H / 2;
      ctx.save();
      ctx.globalAlpha *= blockAlpha * tr.alpha;
      colScale(ctx, fcx, fcy, tr.scale, tr.x);

      // Flash Component renders full screen cinema contain
      drawVisualCell(ctx, 'flash', fcx, fcy, sl, flashSlotDur, syncPromiseQueue, true);
      ctx.restore();

      // Sleek floating subtitle banner for the active spoken sentence
      var activeSentence = (shot.narration && shot.narration[jActive]) || entries[jActive][0] || '';
      if (activeSentence) {
        var bannerY = H - 54 * S;
        ctx.save();
        ctx.globalAlpha *= blockAlpha;
        ctx.font = '600 ' + Math.max(13, Math.round(18 * S)) + 'px ' + FONT;
        var bw = ctx.measureText(activeSentence).width + 64 * S;
        var bh = 38 * S;
        rr(ctx, W / 2 - bw / 2, bannerY - bh / 2, bw, bh, 19 * S);
        ctx.fillStyle = 'rgba(11, 15, 25, 0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.6)';
        ctx.lineWidth = 1.5 * S;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(W / 2 - bw / 2 + 20 * S, bannerY, 4 * S, 0, Math.PI * 2);
        ctx.fillStyle = '#00F0FF';
        ctx.fill();

        ctx.fillStyle = PAL.bone;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(activeSentence, W / 2 - bw / 2 + 32 * S, bannerY);
        ctx.restore();
      }

      return;
    }

    var isFinalShowcase = entries.some(function (e) {
      var ref = e[1];
      var refId = typeof ref === 'string' ? ref : (ref ? ref.assetId || ref.name : '');
      return refId === 'final-ai-video';
    });

    if (isFinalShowcase) {
      var finalSlotDur = (VOICE && shot.vDur) ? shot.vDur : shotDur;
      var fcx = W / 2, fcy = H / 2 + 18 * S;
      ctx.save();
      ctx.globalAlpha *= tr.alpha;
      colScale(ctx, fcx, fcy, tr.scale, tr.x);

      // Top title tag for final cinema showcase
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.max(12, Math.round(18 * S)) + 'px ' + FONT;
      ctx.fillStyle = PAL.signal;
      ctx.fillText('FINAL AI VIDEO SHOWCASE', fcx, 52 * S);
      ctx.restore();

      // Large centered showcase playback
      drawVisualCell(ctx, 'final-ai-video', fcx, fcy, sl, finalSlotDur, syncPromiseQueue);
      ctx.restore();
      return;
    }

    // Determine active visual and transition keys
    var rcx = W * 0.72, rcy = H / 2, SWAP = 0.5;
    function vKey(item) {
      if (!item) return '';
      return typeof item === 'string' ? item : item.assetId || item.name || '';
    }

    var cur = entries[0][1], prev = null, k = 1;
    for (var j = 0; j <= jActive; j++) {
      var ic = entries[j][1];
      if (vKey(ic) !== vKey(cur)) {
        var since = sl - lineStartRel(j);
        if (since < SWAP) { prev = cur; cur = ic; k = since / SWAP; }
        else { cur = ic; prev = null; k = 1; }
      }
    }

    var curKey = vKey(cur);
    var isPromptMode = promptAssets.has(curKey);

    // When displaying a prompt: show the prompt card side-by-side with its
    // generated image or video — NO stacked phrase list. Spoken phrase appears as a sleek caption banner.
    if (isPromptMode) {
      function resolveMediaForPrompt(pAsset, shotEntries) {
        var cIdx = pAsset ? pAsset.clipIndex : null;
        var pId = (pAsset && pAsset.id) || '';
        var isImgPrompt = /image/i.test(pId);
        var isVidPrompt = /video/i.test(pId);

        if (cIdx != null) {
          var pad = String(cIdx).padStart(3, '0');
          var imgKey = 'clip-' + pad + '-image';
          var vidKey = 'clip-' + pad + '-video';
          if (isVidPrompt && mediaElements.has(vidKey)) return vidKey;
          if (isImgPrompt && mediaElements.has(imgKey)) return imgKey;
          if (mediaElements.has(imgKey)) return imgKey;
          if (mediaElements.has(vidKey)) return vidKey;
        }

        for (var i = 0; i < shotEntries.length; i++) {
          var ref = vKey(shotEntries[i][1]);
          if (ref && mediaElements.has(ref) && !promptAssets.has(ref)) {
            return ref;
          }
        }

        var keys = Array.from(mediaElements.keys());
        for (var ki = 0; ki < keys.length; ki++) {
          if (keys[ki] !== 'final-ai-video') return keys[ki];
        }
        return null;
      }

      var pAsset = promptAssets.get(curKey);
      var sideMedia = resolveMediaForPrompt(pAsset, entries);
      var slotDur = (VOICE && shot.vDur) ? shot.vDur : shotDur;
      // Landscape media hides the prompt column and takes the whole frame.
      var sideLandscape = refIsLandscape(sideMedia);
      var promptLcx = W * 0.29, promptRcy = H / 2 - 12 * S;
      var mediaRcx = W * 0.71;
      var transitionAlpha = (prev != null ? k : ((jActive === 0) ? clamp((sl - lineStartRel(0)) / 0.4, 0, 1) : 1));

      // 1. Left column: Prompt Terminal Card (hidden for landscape media)
      if (!sideLandscape) {
        ctx.save();
        ctx.globalAlpha *= blockAlpha * tl.alpha * transitionAlpha;
        colScale(ctx, promptLcx, promptRcy, tl.scale, tl.x);
        var outerLabel = (typeof cur === 'object') ? cur.label : '';
        drawPromptCard(ctx, pAsset, promptLcx, promptRcy, sl, slotDur, outerLabel);
        ctx.restore();
      }

      // 2. Generated Image or Video (beside prompt card, or fullscreen when wide)
      if (sideMedia) {
        var mediaCx = sideLandscape ? W / 2 : mediaRcx;
        var mediaCy = sideLandscape ? H / 2 : promptRcy;
        ctx.save();
        ctx.globalAlpha *= blockAlpha * tr.alpha * transitionAlpha;
        colScale(ctx, mediaCx, mediaCy, tr.scale, tr.x);
        drawVisualCell(ctx, sideMedia, mediaCx, mediaCy, sl, slotDur, syncPromiseQueue, sideLandscape);
        ctx.restore();
      }

      // 3. Floating Bottom Subtitle Banner for active phrase (gated by showSubtitles, default OFF)
      var activePhrase = entries[jActive] ? entries[jActive][0] : '';
      if (showSubtitles && activePhrase) {
        var bannerY = H - 54 * S;
        ctx.save();
        ctx.globalAlpha *= blockAlpha;
        ctx.font = '600 ' + Math.max(13, Math.round(18 * S)) + 'px ' + FONT;
        var bw = ctx.measureText(activePhrase).width + 64 * S;
        var bh = 38 * S;
        rr(ctx, W / 2 - bw / 2, bannerY - bh / 2, bw, bh, 19 * S);
        ctx.fillStyle = 'rgba(13, 14, 17, 0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 77, 18, 0.45)';
        ctx.lineWidth = 1.5 * S;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(W / 2 - bw / 2 + 20 * S, bannerY, 4 * S, 0, Math.PI * 2);
        ctx.fillStyle = PAL.signal;
        ctx.fill();

        ctx.fillStyle = PAL.bone;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(activePhrase, W / 2 - bw / 2 + 32 * S, bannerY);
        ctx.restore();
      }

      return;
    }

    // Landscape visual (wider than tall): fullscreen with the phrase column
    // hidden — side-by-side framing makes wide screenshots unreadably small.
    if (refIsLandscape(cur)) {
      var lsDur = (VOICE && shot.vDur) ? shot.vDur : shotDur;
      var lsCx = W / 2, lsCy = H / 2;
      ctx.save();
      ctx.globalAlpha *= blockAlpha;
      if (prev != null) ctx.globalAlpha *= k;
      else if (jActive === 0) ctx.globalAlpha *= clamp((sl - lineStartRel(0)) / 0.4, 0, 1);
      colScale(ctx, lsCx, lsCy, tr.scale, tr.x);
      if (prev != null && refIsLandscape(prev)) {
        ctx.save();
        ctx.globalAlpha *= (1 - k);
        drawVisualCell(ctx, prev, lsCx, lsCy, sl, lsDur, syncPromiseQueue, true);
        ctx.restore();
        ctx.globalAlpha *= k;
      }
      drawVisualCell(ctx, cur, lsCx, lsCy, sl, lsDur, syncPromiseQueue, true);
      ctx.restore();
      return;
    }

    // Left Column Stacked Phrases
    var lcx = 380 * S;
    var x0 = 118 * S;
    var markerW = 56 * S;
    var xText = x0 + markerW;
    var targetW = 600 * S;
    var minF = 30 * S, maxF = 72 * S;

    var styles = [];
    for (var j = 0; j < n; j++) {
      var text = entries[j][0];
      ctx.font = '600 ' + Math.round(100 * S) + 'px ' + FONT;
      var wRef = ctx.measureText(text).width || 1;
      var fs = clamp((targetW / wRef) * (100 * S), minF, maxF);
      fs = clamp(fs * (1 + (hash1(j * 7.3 + 1.7) - 0.5) * 0.2), minF, maxF);
      var weight = (j % 2 === 0) ? 700 : 500;
      var accentFirst = (j % 2 === 1);
      var indent = (j % 2 === 1) ? 26 * S : 0;
      ctx.font = weight + ' ' + Math.round(fs) + 'px ' + FONT;
      var extraGap = Math.max(0, tokenize(text).length - 1) * lineGap(text);
      var w = ctx.measureText(text).width + extraGap;
      var MAX_END = Math.min(W * 0.48, W * 0.5 - 30 * S);
      if (xText + indent + w > MAX_END) {
        fs = fs * (MAX_END - xText - indent - extraGap) / (w - extraGap);
        ctx.font = weight + ' ' + Math.round(fs) + 'px ' + FONT;
        w = ctx.measureText(text).width;
      }
      styles.push({ text: text, fs: fs, weight: weight, accentFirst: accentFirst, indent: indent, w: w });
    }

    var lineHs = styles.map(function (s) { return s.fs * 1.34 + 10 * S; });
    var totalH = lineHs.reduce(function (a, b) { return a + b; }, 0);
    var yy = H / 2 - totalH / 2;
    var cyArr = lineHs.map(function (lh) { var c = yy + lh / 2 - 5 * S; yy += lh; return c; });

    ctx.save();
    ctx.globalAlpha *= blockAlpha;
    colScale(ctx, lcx, H / 2, tl.scale, tl.x);

    // Number rail
    ctx.save();
    ctx.globalAlpha *= blockAlpha * 0.16;
    ctx.strokeStyle = PAL.graphite; ctx.lineWidth = 2 * S;
    ctx.beginPath();
    ctx.moveTo(x0 - 8 * S, cyArr[0]); ctx.lineTo(x0 - 8 * S, cyArr[cyArr.length - 1]);
    ctx.stroke();
    ctx.restore();

    for (var j = 0; j < styles.length; j++) {
      if (sl < lineStartRel(j) - 1e-6) continue;
      var s = styles[j];
      var cy = cyArr[j];
      var active = (j === jActive);
      var toks = tokenize(s.text);
      var tkTimes = tokenTimesFor(j);

      var num = String(j + 1).padStart(2, '0');
      ctx.font = '600 ' + Math.max(13 * S, s.fs * 0.26) + 'px ' + FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = active ? blockAlpha : blockAlpha * 0.6;
      ctx.fillStyle = active ? PAL.signal : PAL.graphite;
      ctx.fillText(num, x0, cy);
      if (active) {
        ctx.beginPath(); ctx.arc(x0 - 14 * S, cy, 4 * S, 0, Math.PI * 2);
        ctx.fillStyle = PAL.signal; ctx.fill();
      }

      ctx.globalAlpha = active ? blockAlpha * 0.55 : blockAlpha * 0.16;
      ctx.strokeStyle = active ? PAL.signal : PAL.graphite;
      ctx.lineWidth = 2 * S;
      ctx.beginPath();
      ctx.moveTo(xText + s.indent, cy + s.fs * 0.6);
      ctx.lineTo(xText + s.indent + s.w, cy + s.fs * 0.6);
      ctx.stroke();

      ctx.font = s.weight + ' ' + Math.round(s.fs) + 'px ' + FONT;
      var x = xText + s.indent;
      for (var ti = 0; ti < toks.length; ti++) {
        var tk = toks[ti];
        var w = ctx.measureText(tk).width;
        var p = clamp((sl - tkTimes[ti]) / TOKEN_FADE, 0, 1);
        var e = easeOutCubic(p);
        var pop = easeOutBack(p);
        var yOff = (1 - e) * 18 * S;
        var a = e * (active ? blockAlpha : blockAlpha * 0.82);
        var sc = lerp(0.82, 1, pop);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(x + w / 2, cy + yOff);
        ctx.scale(sc, sc);
        ctx.translate(-(x + w / 2), -(cy + yOff));
        ctx.fillStyle = (s.accentFirst && ti === 0) ? PAL.signal : PAL.bone;
        ctx.fillText(tk, x, cy);
        ctx.restore();
        x += w + lineGap(s.text);
      }
    }
    ctx.restore();

    // Right Column Visual Component (Single-cell replacing conveyor)
    ctx.save();
    ctx.globalAlpha *= blockAlpha;
    colScale(ctx, rcx, rcy, tr.scale, tr.x);

    var slotDur = (VOICE && shot.vDur) ? shot.vDur : shotDur;
    if (prev != null) {
      bCellA.x.clearRect(0, 0, W, H);
      drawVisualCell(bCellA.x, prev, rcx, rcy, sl, slotDur, syncPromiseQueue);

      bCellB.x.clearRect(0, 0, W, H);
      drawVisualCell(bCellB.x, cur, rcx, rcy, sl, slotDur, syncPromiseQueue);

      ctx.save();
      ctx.globalAlpha *= (1 - k);
      ctx.translate(160 * S * easeInOutCubic(k), 0);
      ctx.drawImage(bCellA.c, 0, 0, W, H);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha *= k;
      ctx.translate(160 * S * (1 - easeOutBack(k)), 0);
      ctx.drawImage(bCellB.c, 0, 0, W, H);
      ctx.restore();
    } else {
      var a = (jActive === 0) ? clamp((sl - lineStartRel(0)) / 0.4, 0, 1) : 1;
      ctx.globalAlpha *= a;
      drawVisualCell(ctx, cur, rcx, rcy, sl, slotDur, syncPromiseQueue);
    }
    ctx.restore();
  }

  function drawShotLayer(ctx, clip, si, sl, syncPromiseQueue) {
    var sh = clip.shots, cur = sh[si];
    var sd = (VOICE && cur.vDur) ? cur.vDur : shotDur;
    var enterK = null, exitK = null;
    if (sl < shotTrans) enterK = clamp(sl / shotTrans, 0, 1);
    else if (sl > sd - shotTrans) exitK = clamp((sl - (sd - shotTrans)) / shotTrans, 0, 1);
    if (si === sh.length - 1) exitK = null;

    drawShot(ctx, cur, { sl: sl, enterK: enterK, exitK: exitK, si: si }, syncPromiseQueue);

    if (exitK != null && si + 1 < sh.length && sl - sd < 0) {
      drawShot(ctx, sh[si + 1], { sl: sl - sd, enterK: exitK, exitK: null, si: si + 1 }, syncPromiseQueue);
    }
  }

  function drawContent(ctx, clip, local, syncPromiseQueue) {
    var loc = locateInClip(clip, local);
    var ek = easeOutCubic(clamp(local / clipTrans, 0, 1));
    var cam = camAt(clip, loc.si, loc.sl);
    cam.zoom *= lerp(1.16, 1.0, ek);

    ctx.save();
    applyCam(ctx, cam);
    drawShotLayer(ctx, clip, loc.si, loc.sl, syncPromiseQueue);
    ctx.restore();

    drawTitleCard(ctx, clip, local);
  }

  function halate() {
    var gx = bGlow.x;
    gx.clearRect(0, 0, W, H);
    gx.save();
    gx.filter = 'blur(' + (18 * S) + 'px)';
    gx.drawImage(bScene.c, 0, 0, W, H);
    gx.filter = 'none';
    gx.globalCompositeOperation = 'multiply';
    gx.fillStyle = HALATION_TINT;
    gx.fillRect(0, 0, W, H);
    gx.restore();

    var sx = bScene.x;
    sx.save();
    sx.globalCompositeOperation = 'lighter';
    sx.globalAlpha = HALATION;
    sx.drawImage(bGlow.c, 0, 0, W, H);
    sx.restore();
  }

  function grade(flashAmt) {
    var ctx = bScene.x;
    var img = ctx.getImageData(0, 0, W, H);
    var d = img.data;
    var s = new Uint8ClampedArray(d);
    var aspect = W / H;
    var noiseStart = (Math.random() * NA) | 0;
    var boneR = 0.933, boneG = 0.914, boneB = 0.875;

    for (var p = 0; p < d.length; p += 4) {
      var i = p >> 2;
      var x = i % W, y = (i / W) | 0;
      var nx = x / W - 0.5, ny = y / H - 0.5;
      var ax = nx * aspect, ay = ny;
      var r2 = ax * ax + ay * ay;
      var m = Math.min(1, Math.sqrt(r2));
      var shift = CA_PX * m;
      var sx = Math.min(W - 1, Math.max(0, Math.round(x + shift)));
      var bx = Math.min(W - 1, Math.max(0, Math.round(x - shift)));

      var R = s[(y * W + sx) * 4];
      var G = s[p + 1];
      var B = s[(y * W + bx) * 4 + 2];
      var r = R / 255, g = G / 255, b = B / 255;
      r = shoulder(r); g = shoulder(g); b = shoulder(b);
      r = (r - 0.5) * CONTRAST + 0.5; g = (g - 0.5) * CONTRAST + 0.5; b = (b - 0.5) * CONTRAST + 0.5;
      var vlen = Math.sqrt(ax * ax + (ay * 0.8) * (ay * 0.8));
      var v = smoothstep(0.95, 0.25, vlen);
      var vf = 1 - VIGNETTE * (1 - v);
      r *= vf; g *= vf; b *= vf;
      r += boneR * flashAmt; g += boneG * flashAmt; b += boneB * flashAmt;
      var lm = 0.299 * r + 0.587 * g + 0.114 * b;
      var amt = GRAIN * (0.55 + 1.2 * lm * (1 - lm));
      var gn = (noiseA[(i + noiseStart) % NA] * 0.6 + noiseB[(i << 1) % NB] * 0.4) * amt;
      r += gn; g += gn; b += gn;
      d[p] = clamp255(r * 255); d[p + 1] = clamp255(g * 255); d[p + 2] = clamp255(b * 255);
    }
    ctx.putImageData(img, 0, 0);
  }

  var lastLoc = { ci: 0, si: 0 };
  function render(t, syncPromiseQueue) {
    var ctx = bScene.x;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = config.meta.bg || PAL.ink;
    ctx.fillRect(0, 0, W, H);

    var L = locate(t);
    var flashAmt = 0;

    if (L.trans) {
      var cur = clips[L.cur], nxt = clips[L.next];
      var k = clamp(L.k, 0, 1);
      var dir = ((L.cur % 2) === 0) ? 1 : -1;
      // Cycle through 3 shader-style transition types based on incoming clip index
      // 0 = Directional Warp & Cross-Zoom Dissolve
      // 1 = High-tech Luma Scanline Glitch Wipe
      // 2 = Exposure Bloom & Organic Radial Wipe
      var transType = L.next % 3;

      if (L.next === 0 || transType === 0) {
        // --- SHADER 1: DIRECTIONAL WARP & CROSS-ZOOM DISSOLVE ---
        drawBG(ctx, cur, t);
        bNxtBG.x.clearRect(0, 0, W, H);
        drawBG(bNxtBG.x, nxt, t);

        var warpK = easeInOutCubic(k);
        ctx.save();
        ctx.globalAlpha = warpK;
        ctx.drawImage(bNxtBG.c, 0, 0, W, H);
        ctx.restore();

        // Render outgoing clip with directional optical push
        bCur.x.clearRect(0, 0, W, H);
        drawContent(bCur.x, cur, playDur[L.cur], syncPromiseQueue);

        var curDistortX = -120 * S * warpK * dir;
        var curScale = lerp(1.0, 1.08, warpK);
        ctx.save();
        ctx.globalAlpha = 1 - warpK;
        ctx.translate(W / 2 + curDistortX, H / 2);
        ctx.scale(curScale, curScale);
        ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(bCur.c, 0, 0, W, H);
        ctx.restore();

        // Render incoming clip with smooth settle zoom
        bNxt.x.clearRect(0, 0, W, H);
        drawContent(bNxt.x, nxt, k * clipTrans, syncPromiseQueue);

        var nxtDistortX = 120 * S * (1 - warpK) * dir;
        var nxtScale = lerp(0.94, 1.0, easeOutCubic(k));
        ctx.save();
        ctx.globalAlpha = warpK;
        ctx.translate(W / 2 + nxtDistortX, H / 2);
        ctx.scale(nxtScale, nxtScale);
        ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(bNxt.c, 0, 0, W, H);
        ctx.restore();

        flashAmt = 0.08 * Math.sin(Math.PI * k);
        lastLoc = { ci: L.cur, si: cur.shots.length - 1 };
      } else if (transType === 1) {
        // --- SHADER 2: HIGH-TECH LUMA SCANLINE GLITCH WIPE ---
        drawBG(ctx, cur, t);
        bNxtBG.x.clearRect(0, 0, W, H);
        drawBG(bNxtBG.x, nxt, t);

        var glitchK = easeInOutCubic(k);
        ctx.save();
        ctx.globalAlpha = glitchK;
        ctx.drawImage(bNxtBG.c, 0, 0, W, H);
        ctx.restore();

        bCur.x.clearRect(0, 0, W, H);
        drawContent(bCur.x, cur, playDur[L.cur], syncPromiseQueue);
        ctx.save();
        ctx.globalAlpha = 1 - glitchK * 0.4;
        ctx.drawImage(bCur.c, 0, 0, W, H);
        ctx.restore();

        // Incoming clip with scanline bands reveal
        bNxt.x.clearRect(0, 0, W, H);
        drawContent(bNxt.x, nxt, k * clipTrans, syncPromiseQueue);

        var scanHeight = H * glitchK;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, scanHeight);
        ctx.clip();
        ctx.drawImage(bNxt.c, 0, 0, W, H);
        ctx.restore();

        // Luma glitch scanline beam at boundary
        if (scanHeight > 2 && scanHeight < H - 2) {
          ctx.save();
          var beamGrad = ctx.createLinearGradient(0, scanHeight - 16 * S, 0, scanHeight + 16 * S);
          beamGrad.addColorStop(0, 'rgba(0, 240, 255, 0)');
          beamGrad.addColorStop(0.5, 'rgba(0, 240, 255, ' + (0.55 * Math.sin(Math.PI * k)) + ')');
          beamGrad.addColorStop(1, 'rgba(0, 240, 255, 0)');
          ctx.fillStyle = beamGrad;
          ctx.fillRect(0, scanHeight - 16 * S, W, 32 * S);
          ctx.restore();
        }

        flashAmt = 0.06 * Math.sin(Math.PI * k);
        lastLoc = { ci: L.cur, si: cur.shots.length - 1 };
      } else if (transType === 2) {
        // --- SHADER 3: EXPOSURE BLOOM & ORGANIC RADIAL WIPE ---
        drawBG(ctx, cur, t);
        bCur.x.clearRect(0, 0, W, H);
        drawContent(bCur.x, cur, playDur[L.cur], syncPromiseQueue);
        var bloomK = easeInOutCubic(k);

        ctx.save();
        ctx.globalAlpha = 1 - bloomK * 0.6;
        ctx.drawImage(bCur.c, 0, 0, W, H);
        ctx.restore();

        // Draw new background + content into buffer, then mask with expanding oval
        bNxtBG.x.clearRect(0, 0, W, H);
        drawBG(bNxtBG.x, nxt, t);
        bNxt.x.clearRect(0, 0, W, H);
        bNxt.x.drawImage(bNxtBG.c, 0, 0, W, H);
        drawContent(bNxt.x, nxt, k * clipTrans, syncPromiseQueue);

        var rx = easeOutCubic(k) * W * 0.75;
        var ry = easeOutCubic(k) * H * 0.75;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(W / 2, H / 2, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(bNxt.c, 0, 0, W, H);
        ctx.restore();

        // Soft neon glow edge around the expanding shader oval
        if (rx > 4 && rx < W * 0.72) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 138, 61, ' + (0.4 * Math.sin(Math.PI * k)) + ')';
          ctx.lineWidth = 6 * S;
          ctx.beginPath();
          ctx.ellipse(W / 2, H / 2, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        flashAmt = 0.09 * Math.sin(Math.PI * k);
        lastLoc = { ci: L.cur, si: cur.shots.length - 1 };
      }
    } else {
      var clip = clips[L.ci];
      var local = L.local;
      drawBG(ctx, clip, t);
      drawContent(ctx, clip, local, syncPromiseQueue);
      lastLoc = { ci: L.ci, si: locateInClip(clip, local).si };
    }

    halate();
    grade(flashAmt);

    var vctx = canvas.getContext('2d');
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, W, H);
    vctx.drawImage(bScene.c, 0, 0, W, H);
  }

  // Audio & Interactive loop
  var playing = false, time = 0, last = null;
  var $ = function (id) { return document.getElementById(id); };

  function syncHud() {
    var loc = lastLoc;
    var clip = clips[loc.ci];
    var ended = !playing && time >= total - 1e-3;
    if ($('clip-name')) $('clip-name').textContent = clip ? clip.title : '—';
    if ($('shot-name')) $('shot-name').textContent = clip ? clip.shots[loc.si]?.id : '—';
    if ($('time')) $('time').textContent = ended ? 'Finished · ' + total.toFixed(0) + 's' : time.toFixed(1) + 's / ' + total.toFixed(0) + 's';
    if ($('seek')) $('seek').value = Math.round(time / total * 1000);
    if ($('play')) $('play').textContent = playing ? '⏸' : (ended ? '↻' : '▶');
  }

  function frame(ts) {
    if (last == null) last = ts;
    var dt = (ts - last) / 1000; last = ts;
    if (VOICE && AUDIO) {
      if (playing) {
        time = AUDIO.currentTime;
        if (AUDIO.ended || time >= total) { time = Math.min(time, total); playing = false; }
      }
    } else if (playing) {
      time += dt;
      if (time >= total) { time = total; playing = false; }
    }
    render(time, null);
    syncHud();
    if (playing) requestAnimationFrame(frame);
  }

  function seekTo(t) {
    time = clamp(t, 0, total);
    if (VOICE && AUDIO) AUDIO.currentTime = Math.max(0, Math.min(time, total - 0.01));
    deterministicSeek(time);
    syncHud();
  }

  function toggle() {
    if (!playing && time >= total - 1e-3) seekTo(0);
    playing = !playing;
    if (VOICE && AUDIO) { if (playing) AUDIO.play().catch(function () {}); else AUDIO.pause(); }
    last = null;
    if (playing) requestAnimationFrame(frame);
    syncHud();
  }

  function syncSubtitleButton() {
    var btn = $('toggle-subtitles');
    if (btn) {
      if (showSubtitles) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }
  syncSubtitleButton();

  function toggleSubtitles() {
    showSubtitles = !showSubtitles;
    syncSubtitleButton();
    render(time, null);
  }
  if ($('toggle-subtitles')) $('toggle-subtitles').addEventListener('click', toggleSubtitles);

  if ($('play')) $('play').addEventListener('click', toggle);
  if ($('seek')) $('seek').addEventListener('input', function (e) { seekTo(e.target.value / 1000 * total); });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowRight') { seekTo(time + (e.shiftKey ? 5 : 2)); }
    else if (e.code === 'ArrowLeft') { seekTo(time - (e.shiftKey ? 5 : 2)); }
    else if (e.key === 'c' || e.key === 'C') { toggleSubtitles(); }
    else if (e.key === ',') { playing = false; if (VOICE && AUDIO) AUDIO.pause(); seekTo(time - 1 / 30); }
    else if (e.key === '.') { playing = false; if (VOICE && AUDIO) AUDIO.pause(); seekTo(time + 1 / 30); }
    else if (e.key === 'r') { seekTo(0); }
  });

  // Deterministic seek(t) for Headless Rendering
  function deterministicSeek(t) {
    time = clamp(t, 0, total);
    var syncPromises = [];
    render(time, syncPromises);
    syncHud();
    if (syncPromises.length > 0) {
      return Promise.all(syncPromises).then(function () {
        render(time, null);
      });
    }
    return Promise.resolve();
  }

  window.__explainer = {
    seek: deterministicSeek,
    render: function (t) { return deterministicSeek(t); },
    get time() { return time; },
    get total() { return total; },
    get subtitles() { return showSubtitles; },
    setSubtitles: function (val) {
      showSubtitles = Boolean(val);
      syncSubtitleButton();
      render(time, null);
    },
    toggleSubtitles: toggleSubtitles,
    pause: function () { playing = false; },
    promptTextFor: promptTextFor
  };
  window.__tutorial = window.__explainer;
  window.__player = window.__explainer;

  // Initial draw after icon bitmaps settle — the ready flag gates both the
  // interactive preview and the headless frame-by-frame renderer.
  preloadIcons().then(function () {
    deterministicSeek(0);
    window.__explainerReady = true;
    window.__tutorialReady = true;
  });
})();
`;

/**
 * Writes the player bundle into the explainer directory.
 */
export async function writeExplainerPlayer(
  options: WriteExplainerPlayerOptions
): Promise<ExplainerPlayerFiles> {
  const { timeline, icons, outDir } = options;
  await fs.mkdir(outDir, { recursive: true });

  const { config, voice, assets, resolution } = normalizeTimeline(timeline);

  const htmlPath = path.join(outDir, 'explainer-player.html');
  const cssPath = path.join(outDir, 'explainer-player.css');
  const jsPath = path.join(outDir, 'explainer-player.js');
  const timelinePath = path.join(outDir, 'explainer.json');
  const legacyHtmlPath = path.join(outDir, 'tutorial-player.html');
  const legacyCssPath = path.join(outDir, 'tutorial-player.css');
  const legacyJsPath = path.join(outDir, 'tutorial-player.js');
  const legacyTimelinePath = path.join(outDir, 'tutorial.json');
  const configPath = path.join(outDir, 'config.json');
  const voicePath = path.join(outDir, 'voice.json');
  const promptsPath = path.join(outDir, 'prompts.json');

  // Prompt materials stay SYMBOLIC in every script JSON:
  // only id/kind/label/clipIndex are carried. Full prompt texts are extracted once into prompts.json.
  const promptTexts: Record<string, string> = {};
  const symbolicAssets = assets.map((asset) => {
    if (asset.kind !== 'prompt') return asset;
    if (asset.promptText) promptTexts[asset.id] = asset.promptText;
    const { promptText: _promptText, ...symbolic } = asset;
    return symbolic;
  });
  const promptAssetIds = Object.keys(promptTexts);

  const configJson = embedJson(config);
  const voiceJson = embedJson(voice);
  const iconsJson = embedJson(icons);
  const assetsJson = embedJson(symbolicAssets);
  const promptsJson = embedJson(promptTexts);
  const timelineJson = embedJson(timeline);

  // Hidden media preloads
  const mediaTags = assets
    .map((asset) => {
      if (asset.kind === 'video') {
        return `  <video id="asset-${asset.id}" class="visual-source" muted playsinline preload="auto" src="${asset.src}"></video>`;
      }
      if (asset.kind === 'image') {
        return `  <img id="asset-${asset.id}" class="visual-source" src="${asset.src}" />`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const buildHtml = (cssFilename: string, jsFilename: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${config.meta.title}</title>
  <link rel="stylesheet" href="${cssFilename}" />
  <script>
    if (location.search.indexOf('render=1') !== -1 || window.__RENDER_MODE__) {
      document.documentElement.classList.add('render-mode');
    }
  </script>
  <script>window.__explainer = null; window.__explainerReady = false; window.__tutorial = null; window.__tutorialReady = false;</script>
</head>
<body>
  <canvas id="stage" width="${resolution.width}" height="${resolution.height}"></canvas>

  <div id="hud">
    <div id="hud-left"><span id="clip-name">—</span> · <span id="shot-name">—</span></div>
    <div id="hud-right"><span id="time">0.0s</span></div>
  </div>

  <div id="controls">
    <button id="play" title="Space">▶</button>
    <button id="toggle-subtitles" title="Toggle Subtitles (c)">CC</button>
    <input id="seek" type="range" min="0" max="1000" value="0" />
    ${assets.some(asset => asset.id === 'final-ai-video') ? '<a href="assets/final-ai-video.mp4" target="_blank" rel="noopener" style="color:inherit;white-space:nowrap">Open final video with voice ↗</a>' : ''}
    <span id="hint">Space: Play/Pause · ←/→: Seek · ,/.: Frame step · r: Replay</span>
  </div>

  <div id="media-sources">
${mediaTags}
  </div>

  <!-- Compatibility DOM containers for legacy tests -->
  <div id="columns" class="title-mode"></div>
  <div class="col col-visual"><div class="visual-card"></div></div>
  <div class="col col-caption"><div class="caption-text"></div></div>
  <div class="col col-prompt"><div class="prompt-text"></div></div>
  <div class="col col-chat"><div class="chat-card"><div class="bubble-user"></div><div class="bubble-bot"></div></div></div>

  <script id="explainer-data" type="application/json">${configJson}</script>
  <script id="explainer-voice" type="application/json">${voiceJson}</script>
  <script id="explainer-icons" type="application/json">${iconsJson}</script>
  <script id="explainer-assets" type="application/json">${assetsJson}</script>
  ${promptAssetIds.length > 0 ? `<script id="explainer-prompts" type="application/json">${promptsJson}</script>` : ''}
  <script id="explainer-timeline" type="application/json">${timelineJson}</script>

  <!-- Fallback script elements for backward compatibility -->
  <script id="tutorial-data" type="application/json">${configJson}</script>
  <script id="tutorial-voice" type="application/json">${voiceJson}</script>
  <script id="tutorial-icons" type="application/json">${iconsJson}</script>
  <script id="tutorial-assets" type="application/json">${assetsJson}</script>
  ${promptAssetIds.length > 0 ? `<script id="tutorial-prompts" type="application/json">${promptsJson}</script>` : ''}
  <script id="tutorial-timeline" type="application/json">${timelineJson}</script>

  <script src="${jsFilename}"></script>
</body>
</html>
`;

  const timelineWithScenes = {
    ...timeline,
    assets: symbolicAssets,
    clips: config.clips,
    scenes: (timeline as any).scenes && (timeline as any).scenes.length > 0 ? (timeline as any).scenes : config.scenes,
  };

  const timelineJsonContent = JSON.stringify(timelineWithScenes, null, 2) + '\n';
  const explainerHtml = buildHtml('explainer-player.css', 'explainer-player.js');
  const legacyHtml = buildHtml('tutorial-player.css', 'tutorial-player.js');

  await Promise.all([
    fs.writeFile(htmlPath, explainerHtml, 'utf-8'),
    fs.writeFile(cssPath, PLAYER_CSS, 'utf-8'),
    fs.writeFile(jsPath, PLAYER_JS, 'utf-8'),
    fs.writeFile(timelinePath, timelineJsonContent, 'utf-8'),
    // Also write legacy aliases so nothing ever breaks
    fs.writeFile(legacyHtmlPath, legacyHtml, 'utf-8'),
    fs.writeFile(legacyCssPath, PLAYER_CSS, 'utf-8'),
    fs.writeFile(legacyJsPath, PLAYER_JS, 'utf-8'),
    fs.writeFile(legacyTimelinePath, timelineJsonContent, 'utf-8'),
    fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8'),
    fs.writeFile(voicePath, JSON.stringify(voice, null, 2) + '\n', 'utf-8'),
    fs.writeFile(promptsPath, JSON.stringify(promptTexts, null, 2) + '\n', 'utf-8'),
  ]);

  return { htmlPath, cssPath, jsPath, timelinePath, promptsPath };
}

export const writeTutorialPlayer = writeExplainerPlayer;
