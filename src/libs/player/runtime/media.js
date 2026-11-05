// Media catalogs (videos / images / prompt materials), lucide icon rasterization
// and deterministic video seeking.

import { env, readJsonBlock } from './env.js';

const LEGACY_CANDIDATE_RE = /^(?:candidate|cand)-\d+/i;

export function buildMediaCatalog() {
  const mediaElements = env.mediaElements;
  const promptAssets = env.promptAssets;
  mediaElements.clear();
  promptAssets.clear();

  env.assetList.forEach((asset) => {
    if (asset.kind === 'prompt') {
      promptAssets.set(asset.id, asset);
      return;
    }
    if (asset.kind === 'video') {
      const el = document.getElementById('asset-' + asset.id) || document.createElement('video');
      el.className = 'visual-source';
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      if (!el.src && asset.src) el.src = asset.src;
      if (!el.parentNode) document.body.appendChild(el);
      mediaElements.set(asset.id, { kind: 'video', el: el, asset: asset });
      return;
    }
    if (asset.kind === 'image') {
      const img = document.getElementById('asset-' + asset.id) || new Image();
      if (!img.src && asset.src) img.src = asset.src;
      mediaElements.set(asset.id, { kind: 'image', el: img, asset: asset });
    }
  });

  env.flashPool = buildFlashPool();
}

/**
 * Resolves the `component:flash` asset pool from `style.components.flash.pool`.
 *   tag:<name>  → assets carrying that tag
 *   all-images  → every image asset
 * Legacy `candidate-*` / `cand-*` ids are still honoured (with one warning) so
 * bundles generated before tags existed keep rendering.
 */
export function buildFlashPool() {
  const selector = (env.components.flash && env.components.flash.pool) || 'tag:candidate';
  const pool = [];

  const pushAsset = (asset) => {
    const entry = env.mediaElements.get(asset.id);
    if (entry && entry.el) pool.push({ id: asset.id, el: entry.el, label: asset.label || '' });
  };

  if (selector === 'all-images') {
    env.assetList.forEach((asset) => {
      if (asset.kind === 'image') pushAsset(asset);
    });
    return pool;
  }

  const tag = selector.indexOf('tag:') === 0 ? selector.slice(4) : selector;
  env.assetList.forEach((asset) => {
    if (asset.kind !== 'image') return;
    if (Array.isArray(asset.tags) && asset.tags.indexOf(tag) >= 0) pushAsset(asset);
  });

  if (pool.length === 0) {
    env.assetList.forEach((asset) => {
      if (asset.kind === 'image' && LEGACY_CANDIDATE_RE.test(asset.id)) pushAsset(asset);
    });
    if (pool.length > 0) {
      env.warnings.push(
        `component:flash pool "${selector}" matched no tagged asset; falling back to legacy candidate-*/cand-* ids (add tags:["${tag}"] to the assets)`
      );
    }
  }

  return pool;
}

export function promptTextFor(id) {
  const text = env.promptTexts[id];
  if (text) return text;
  const asset = env.promptAssets.get(id);
  return (asset && asset.promptText) || null;
}

/** Deterministic video seek that settles before the frame is painted. */
export function seekVideo(video, target) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    function onSeeked() {
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve();
    }
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = target;
  });
}

// ---------------------------------------------------------------------------
// Lucide icons
// ---------------------------------------------------------------------------

function svgURL(name, color) {
  const raw = env.iconData[name];
  if (!raw) return null;
  // lucide-static files lead with an XML license comment and span multiple
  // lines with stroke="currentColor" on the root tag. Strip comments and trim
  // before inspecting the markup, then bake the color in — otherwise the whole
  // file gets wrapped as inner content and currentColor resolves to black
  // inside <img>, rendering the icon invisible.
  let svg = String(raw)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (svg.indexOf('<svg') !== 0) {
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="' +
      color +
      '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      svg +
      '</svg>';
  } else {
    svg = svg.replace(/currentColor/g, color);
    if (svg.indexOf('stroke=') === -1) svg = svg.replace(/<svg/i, '<svg stroke="' + color + '"');
  }
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function loadIcon(name, color) {
  const key = name + '|' + color;
  const cached = env.iconCache.get(key);
  if (cached) return cached;
  const rec = { img: null, loaded: false };
  env.iconCache.set(key, rec);
  const url = svgURL(name, color);
  if (url) {
    const img = new Image();
    img.onload = () => {
      rec.loaded = true;
    };
    img.src = url;
    rec.img = img;
  }
  return rec;
}

/**
 * Deterministic boot: rasterize every inlined lucide icon BEFORE the first
 * paint so seek(t) never depends on async image load timing.
 */
export function preloadIcons() {
  const jobs = Object.keys(env.iconData).map(
    (name) =>
      new Promise((resolve) => {
        const rec = loadIcon(name, env.PAL.bone);
        if (!rec.img) {
          resolve(null);
          return;
        }
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            rec.loaded = true;
            resolve(null);
          }
        };
        rec.img.addEventListener('load', done);
        rec.img.addEventListener('error', done);
        setTimeout(done, 3000);
      })
  );
  return Promise.all(jobs);
}

export function readPromptTexts() {
  return readJsonBlock('explainer-prompts', {}) || {};
}
