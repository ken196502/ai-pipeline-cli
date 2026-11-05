/**
 * Explainer player bundle generator.
 *
 * Writes a self-contained HTML/CSS/JS player that renders the explainer
 * timeline either interactively for human preview or deterministically
 * frame-by-frame for headless rendering.
 *
 * The bundle carries four INDEPENDENT data blocks (see
 * Docs/plan-explainer-video-style-and-webgl.md):
 *
 *   #explainer-data    storyboard content (chapters / shots / phrases / narration)
 *   #explainer-style   style.json — theme, timing, components, camera, transitions, post
 *   #explainer-voice   voice.json — TTS timing (aStart/aDur/words)
 *   #explainer-assets  symbolic asset list (+ #explainer-prompts, #explainer-icons)
 *
 * Engine source lives in ./runtime/*.js and is bundled by ./runtime/build.ts.
 * The WebGL renderer (shader transitions + GPU post) falls back to Canvas2D when
 * WebGL is unavailable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DDIN_EXP_FONTS_CSS } from './fonts-data.js';
import { buildPlayerRuntime } from './runtime/build.js';
import { styleForRuntime, type ExplainerStyle } from './style.js';
import { ensureCyberPlate } from './background.js';
import type { ExplainerTimeline, ExplainerAsset, ExplainerClip } from './contracts.js';

export interface WriteExplainerPlayerOptions {
  timeline: ExplainerTimeline;
  /** lucide icon name -> SVG markup, inlined into the page. */
  icons: Record<string, string>;
  /** Explainer bundle directory (player files + assets/ + audio/). */
  outDir: string;
  /** Resolved style document (theme / timing / components / transitions / post). */
  style: ExplainerStyle;
}

export interface ExplainerPlayerFiles {
  htmlPath: string;
  cssPath: string;
  jsPath: string;
  timelinePath: string;
  stylePath: string;
  voicePath: string;
  /** Canonical id -> full prompt text store (prompt materials only). */
  promptsPath: string;
}

/** Escapes JSON for safe inline embedding inside a <script> tag. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Normalizes timeline data into the player config block: content + resolution
 * only. Effect parameters come from the style block, timing from voice.json.
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
  const clips: ExplainerClip[] = timeline.clips || [];

  const config = {
    fps: timeline.fps || 30,
    meta: {
      title: timeline.title || timeline.meta?.title || 'AI Explainer Video',
      subtitle: timeline.topic || timeline.meta?.subtitle || '',
      design: { w: width, h: height },
      subtitles: Boolean(timeline.meta?.subtitles),
    },
    clips,
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
`;

/**
 * Writes the player bundle into the explainer directory.
 *
 * Emitted files (no legacy `tutorial-*` aliases, no duplicate embedded blocks):
 *   explainer-player.html / .css / .js
 *   explainer.json   assembled timeline (content + symbolic assets + voice)
 *   style.json       resolved style document (effect configuration)
 *   voice.json       TTS timing
 *   prompts.json     full prompt texts (prompt materials only)
 */
export async function writeExplainerPlayer(
  options: WriteExplainerPlayerOptions
): Promise<ExplainerPlayerFiles> {
  const { timeline, icons, outDir, style } = options;
  await fs.mkdir(outDir, { recursive: true });

  const { config, voice, assets, resolution } = normalizeTimeline(timeline);

  const htmlPath = path.join(outDir, 'explainer-player.html');
  const cssPath = path.join(outDir, 'explainer-player.css');
  const jsPath = path.join(outDir, 'explainer-player.js');
  const timelinePath = path.join(outDir, 'explainer.json');
  const stylePath = path.join(outDir, 'style.json');
  const voicePath = path.join(outDir, 'voice.json');
  const promptsPath = path.join(outDir, 'prompts.json');

  // Prompt materials stay SYMBOLIC in every script JSON: only id/kind/label/
  // clipIndex are carried. Full prompt texts are extracted once into prompts.json.
  const promptTexts: Record<string, string> = {};
  const symbolicAssets = assets.map((asset) => {
    if (asset.kind !== 'prompt') return asset;
    if (asset.promptText) promptTexts[asset.id] = asset.promptText;
    const { promptText: _promptText, ...symbolic } = asset;
    return symbolic;
  });
  const promptAssetIds = Object.keys(promptTexts);

  // Pre-rendered cyberspace plate (static layer of the background), cached by
  // content hash inside assets/.
  const backgroundPlate = await ensureCyberPlate({
    style,
    outDir,
    width: resolution.width,
    height: resolution.height,
  });

  const runtimeStyle = styleForRuntime(style, { backgroundPlate });
  const configJson = embedJson(config);
  const styleJson = embedJson(runtimeStyle);
  const voiceJson = embedJson(voice);
  const iconsJson = embedJson(icons);
  const assetsJson = embedJson(symbolicAssets);
  const promptsJson = embedJson(promptTexts);
  const timelineJson = embedJson(timeline);
  const runtimeJs = buildPlayerRuntime();

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

  const finalShowcaseAsset = style.components.finalShowcase.asset;
  const hasFinalShowcase = assets.some(
    (asset) => asset.id === finalShowcaseAsset && asset.kind === 'video'
  );

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${config.meta.title}</title>
  <link rel="stylesheet" href="explainer-player.css" />
  <script>
    if (location.search.indexOf('render=1') !== -1 || window.__RENDER_MODE__) {
      document.documentElement.classList.add('render-mode');
    }
  </script>
  <script>window.__explainer = null; window.__explainerReady = false;</script>
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
    ${hasFinalShowcase ? `<a href="assets/${finalShowcaseAsset}.mp4" target="_blank" rel="noopener" style="color:inherit;white-space:nowrap">Open final video with voice ↗</a>` : ''}
    <span id="hint">Space: Play/Pause · ←/→: Seek · ,/.: Frame step · r: Replay</span>
  </div>

  <div id="media-sources">
${backgroundPlate ? `  <img id="bg-plate" class="visual-source" src="${backgroundPlate}" />\n` : ''}${mediaTags}
  </div>

  <script id="explainer-data" type="application/json">${configJson}</script>
  <script id="explainer-style" type="application/json">${styleJson}</script>
  <script id="explainer-voice" type="application/json">${voiceJson}</script>
  <script id="explainer-icons" type="application/json">${iconsJson}</script>
  <script id="explainer-assets" type="application/json">${assetsJson}</script>
  ${promptAssetIds.length > 0 ? `<script id="explainer-prompts" type="application/json">${promptsJson}</script>` : ''}
  <script id="explainer-timeline" type="application/json">${timelineJson}</script>

  <script src="explainer-player.js"></script>
</body>
</html>
`;

  const timelineJsonContent = JSON.stringify({ ...timeline, assets: symbolicAssets }, null, 2) + '\n';

  await Promise.all([
    fs.writeFile(htmlPath, html, 'utf-8'),
    fs.writeFile(cssPath, PLAYER_CSS, 'utf-8'),
    fs.writeFile(jsPath, runtimeJs, 'utf-8'),
    fs.writeFile(timelinePath, timelineJsonContent, 'utf-8'),
    fs.writeFile(stylePath, JSON.stringify(style, null, 2) + '\n', 'utf-8'),
    fs.writeFile(voicePath, JSON.stringify(voice, null, 2) + '\n', 'utf-8'),
    fs.writeFile(promptsPath, JSON.stringify(promptTexts, null, 2) + '\n', 'utf-8'),
  ]);

  return { htmlPath, cssPath, jsPath, timelinePath, stylePath, voicePath, promptsPath };
}
