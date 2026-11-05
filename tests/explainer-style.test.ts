/**
 * Regression tests for the content/effect split and the player timeline
 * (Docs/plan-explainer-video-style-and-webgl.md, P0 + P1 + P2).
 *
 * Covered:
 *   - style preset / merge / overrides (P1)
 *   - legacy storyboard migration, no effect fields in the content object (P1)
 *   - voice timings applied in memory, storyboard never mutated (P1)
 *   - locateClip first-frame contract (P0/B1)
 *   - deterministic clip transition selection (P1)
 *   - legacy magic-id -> component mapping (P1)
 *   - render chunk hash invalidation (P0/B2)
 *   - runtime bundle sanity (P2)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyOverrides,
  defaultStyle,
  deepMergeStyle,
  pickClipTransition,
  resolveComponentRef,
  resolveTitleSafe,
  styleFromPreset,
  loadStyle,
  ExplainerStyleSchema,
} from '../src/libs/player/style.js';
import {
  attachVoiceTimings,
  collectStoryboardEffectFields,
  migrateLegacyStoryboard,
  storyboardForDisk,
} from '../src/libs/player/contracts.js';
import { locateClip, pickTransitionName } from '../src/libs/player/runtime/timeline.js';
import { computeRenderHash, ensureChunkManifest } from '../src/libs/player/render.js';
import { buildPlayerRuntime } from '../src/libs/player/runtime/build.js';
import { resolveRebuildStyle } from '../src/tutorial/index.js';

// ---------------------------------------------------------------------------
// Style document
// ---------------------------------------------------------------------------

test('default style: title timing has a single source and resolves to 2.30s', () => {
  const timing = defaultStyle().timing;
  assert.equal(timing.titleIn, 0.55);
  assert.equal(timing.titleHold, 1.1);
  assert.equal(timing.titleOut, 0.55);
  assert.equal(resolveTitleSafe(timing), 2.3);
});

test('presets differ and unknown presets fail loudly', () => {
  const ember = styleFromPreset('ember-dark');
  const cyan = styleFromPreset('cyan-tech');
  assert.notEqual(ember.theme.accent, cyan.theme.accent);
  assert.throws(() => styleFromPreset('preset:does-not-exist'), /unknown style preset/);
});

test('loadStyle: presets, patches and extends are merged in order', async () => {
  const style = await loadStyle({
    input: 'preset:cyan-tech',
    patches: [{ theme: { accent: '#123456' }, timing: { lineGap: 0.42 } }],
  });
  assert.equal(style.theme.accent, '#123456');
  assert.equal(style.timing.lineGap, 0.42);
  // Untouched fields still come from the preset, not from the default.
  assert.equal(style.theme.accent === defaultStyle().theme.accent, false);
  assert.doesNotThrow(() => ExplainerStyleSchema.parse(style));

  const extended = await loadStyle({ input: { extends: 'preset:ember-dark' } as any });
  assert.equal(extended.theme.accent, styleFromPreset('ember-dark').theme.accent);
});

test('deepMergeStyle does not mutate its inputs', () => {
  const base = defaultStyle();
  const snapshot = JSON.stringify(base);
  deepMergeStyle(base, { theme: { accent: '#FFFFFF' } });
  assert.equal(JSON.stringify(base), snapshot);
});

test('applyOverrides applies clip and shot patches only when ids match', () => {
  const style = ExplainerStyleSchema.parse(
    deepMergeStyle(defaultStyle(), {
      overrides: {
        'clip:c3': { theme: { bg: '#101010' } },
        'shot:s1': { camera: { mode: 'static' } },
      },
    })
  );

  const clipScoped = applyOverrides(style, { clipId: 'c3' });
  assert.equal(clipScoped.theme.bg, '#101010');

  const shotScoped = applyOverrides(style, { clipId: 'c3', shotId: 's1' });
  assert.equal(shotScoped.camera.mode, 'static');

  const untouched = applyOverrides(style, { clipId: 'nope' });
  assert.equal(untouched.theme.bg, style.theme.bg);
  assert.equal(untouched, style);
});

// ---------------------------------------------------------------------------
// Legacy storyboard migration
// ---------------------------------------------------------------------------

const LEGACY_STORYBOARD = {
  version: '2.0.0',
  meta: {
    title: 'Legacy',
    bg: '#0B0F19',
    accent: '#FF8A3D',
    font: '"D-DIN Exp", Inter',
    shotDur: 4.6,
    shotTrans: 0.7,
    clipTrans: 1.2,
    design: { w: 1920, h: 1080 },
  },
  clips: [
    {
      id: 'c1',
      title: 'Chapter one',
      bg: '#111111',
      shots: [
        {
          id: 's1',
          elements: [['hello', 'icon:sparkles']],
          narration: ['hello world'],
          camera: { zoom: 1.02, x: 0.1, y: -0.1, roll: 0.01 },
        },
      ],
    },
  ],
};

test('legacy effect fields are detected before migration', () => {
  const fields = collectStoryboardEffectFields(LEGACY_STORYBOARD);
  assert.deepEqual(fields.sort(), [
    'clips[0].bg',
    'clips[0].shots[0].camera',
    'meta.accent',
    'meta.bg',
    'meta.clipTrans',
    'meta.font',
    'meta.shotDur',
    'meta.shotTrans',
  ]);
});

test('migrateLegacyStoryboard moves effects into a style patch and strips them from content', () => {
  const { storyboard, stylePatch, migratedFields } = migrateLegacyStoryboard(LEGACY_STORYBOARD);

  assert.equal(stylePatch.theme.bg, '#0B0F19');
  assert.equal(stylePatch.theme.accent, '#FF8A3D');
  assert.equal(stylePatch.timing.shotDur, 4.6);
  assert.equal(stylePatch.timing.clipTrans, 1.2);
  assert.deepEqual(stylePatch.overrides['clip:c1'], { theme: { bg: '#111111' } });
  assert.equal(stylePatch.overrides['shot:s1'].camera.mode, 'script');
  assert.equal(stylePatch.overrides['shot:s1'].camera.zoom, 1.02);
  assert.equal(stylePatch.camera.mode, 'script');
  assert.equal(migratedFields.length, 8);

  // Content object: no clip.bg, no shot.camera (they were effect fields).
  assert.equal('bg' in storyboard.clips[0], false);
  assert.equal('camera' in storyboard.clips[0].shots[0], false);
  assert.deepEqual(
    collectStoryboardEffectFields(JSON.parse(JSON.stringify(storyboard))).filter(
      (f) => f.startsWith('clips[')
    ),
    []
  );
});

test('migrated storyboard still validates as content', () => {
  const { storyboard } = migrateLegacyStoryboard(LEGACY_STORYBOARD);
  assert.equal(storyboard.clips.length, 1);
  assert.equal(storyboard.clips[0].shots[0].narration[0], 'hello world');
});

test('storyboardForDisk keeps the on-disk storyboard free of effect fields', () => {
  const { storyboard } = migrateLegacyStoryboard(LEGACY_STORYBOARD);
  const onDisk = storyboardForDisk(storyboard);
  assert.deepEqual(collectStoryboardEffectFields(onDisk), []);
  assert.equal('bg' in onDisk.meta, false);
  assert.equal('accent' in onDisk.meta, false);
  assert.equal('shotDur' in onDisk.meta, false);
  assert.equal('bg' in onDisk.clips[0], false);
  assert.equal('camera' in onDisk.clips[0].shots[0], false);
  // Content survives untouched.
  assert.equal(onDisk.clips[0].title, 'Chapter one');
  assert.deepEqual(onDisk.clips[0].shots[0].narration, ['hello world']);
  // The source object is not mutated.
  assert.equal('bg' in storyboard.clips[0], false);
});

// ---------------------------------------------------------------------------
// Voice timings are attached in memory, never written back
// ---------------------------------------------------------------------------

test('attachVoiceTimings decorates clips without mutating the input', () => {
  const timeline: any = {
    version: '2.0.0',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    totalDurationSec: 12,
    clips: [
      {
        id: 'c1',
        title: 'one',
        bg: '#0B0F19',
        shots: [{ id: 's1', elements: [['a', 'icon:x']], narration: ['a'] }],
      },
    ],
    voice: {
      voice: 'test',
      total: 12,
      titleSafe: 2.3,
      clipTail: 0.5,
      lineGap: 0.12,
      shotGap: 0.18,
      clips: [
        {
          start: 0,
          dur: 12,
          shots: [{ start: 0, dur: 12, lines: [{ text: 'a', aStart: 2.3, aDur: 1 }] }],
        },
      ],
    },
  };

  const attached = attachVoiceTimings(timeline);
  assert.equal(attached.clips[0].vDur, 12);
  assert.equal(attached.clips[0].shots[0].vStart, 0);
  assert.equal(attached.clips[0].shots[0].vLines[0].aStart, 2.3);

  // The source timeline must stay pristine (voice.json is the only timing source).
  assert.equal(timeline.clips[0].vDur, undefined);
  assert.equal(timeline.clips[0].shots[0].vLines, undefined);
});

// ---------------------------------------------------------------------------
// Timeline / transitions
// ---------------------------------------------------------------------------

test('locateClip: first frame belongs to the first chapter, never a wrap-around transition', () => {
  const playDur = [10, 8, 6];
  const clipTrans = 1;
  const params = { playDur, clipTrans, clipCount: 3 };

  const first = locateClip({ ...params, t: 0 });
  assert.equal(first.trans, false);
  assert.equal((first as any).ci, 0);
  assert.equal((first as any).local, 0);

  const early = locateClip({ ...params, t: 0.3 });
  assert.equal(early.trans, false);
  assert.equal((early as any).ci, 0);
  assert.ok(Math.abs((early as any).local - 0.3) < 1e-9);

  // Mid-clip: plain playback.
  const mid = locateClip({ ...params, t: 5 });
  assert.deepEqual(mid, { trans: false, ci: 0, local: 5 });

  // Entering clip 1: transition from clip 0, progress 0.5.
  const entering = locateClip({ ...params, t: 10.5 });
  assert.equal(entering.trans, true);
  assert.equal((entering as any).cur, 0);
  assert.equal((entering as any).next, 1);
  assert.ok(Math.abs((entering as any).k - 0.5) < 1e-9);

  // Clamped past the end.
  const end = locateClip({ ...params, t: 999 });
  assert.equal(end.trans, false);
  assert.equal((end as any).ci, 2);
});

test('pickTransitionName: sequence, fixed and seed are deterministic', () => {
  const pool = ['a', 'b', 'c'];
  assert.equal(pickTransitionName({ channel: { mode: 'sequence', pool }, clipIndex: 4, totalClips: 5 }), 'b');
  assert.equal(pickTransitionName({ channel: { mode: 'fixed', pool }, clipIndex: 2, totalClips: 5 }), 'a');
  assert.equal(pickTransitionName({ channel: { mode: 'sequence', pool: [] }, clipIndex: 0, totalClips: 1 }), 'directionalWarp');

  const seeded = [0, 1, 2, 3, 4].map((i) =>
    pickTransitionName({ channel: { mode: 'seed', pool, seed: 7 }, clipIndex: i, totalClips: 5 })
  );
  const seededAgain = [0, 1, 2, 3, 4].map((i) =>
    pickTransitionName({ channel: { mode: 'seed', pool, seed: 7 }, clipIndex: i, totalClips: 5 })
  );
  assert.deepEqual(seeded, seededAgain);
  assert.ok(seeded.every((name) => pool.includes(name)));

  // style.ts must agree with the runtime helper.
  const style = deepMergeStyle(defaultStyle(), {
    transitions: { clip: { mode: 'sequence', pool, seed: 7 } },
  });
  for (let i = 0; i < 5; i++) {
    assert.equal(
      pickClipTransition(style, i, 5),
      pickTransitionName({ channel: style.transitions.clip, clipIndex: i, totalClips: 5 })
    );
  }
});

// ---------------------------------------------------------------------------
// Component refs replace magic ids
// ---------------------------------------------------------------------------

test('resolveComponentRef maps new component refs and legacy magic ids', () => {
  const style = defaultStyle();

  const flash = resolveComponentRef('component:flash', style);
  assert.equal(flash?.component, 'flash');
  assert.equal(flash?.legacy, false);

  for (const legacy of ['flash', 'flash:candidates', 'xhot-candidate-grid']) {
    const ref = resolveComponentRef(legacy, style);
    assert.equal(ref?.component, 'flash', `${legacy} should map to flash`);
    assert.equal(ref?.legacy, true);
  }

  const showcase = resolveComponentRef('component:final-showcase', style);
  assert.equal(showcase?.component, 'final-showcase');
  assert.equal(showcase?.legacy, false);

  const legacyShowcase = resolveComponentRef('final-ai-video', style);
  assert.equal(legacyShowcase?.component, 'final-showcase');
  assert.equal(legacyShowcase?.legacy, true);
  assert.equal(legacyShowcase?.assetId, 'final-ai-video');

  assert.equal(resolveComponentRef('icon:sparkles', style), null);
});

// ---------------------------------------------------------------------------
// Render chunk cache invalidation
// ---------------------------------------------------------------------------

test('render hash invalidates stale chunks and keeps fresh ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explainer-hash-'));
  const chunkDir = path.join(dir, '.render-chunks');
  try {
    await fs.writeFile(path.join(dir, 'explainer.json'), '{"clips":[]}');
    await fs.writeFile(path.join(dir, 'style.json'), '{"theme":{}}');
    await fs.writeFile(path.join(dir, 'voice.json'), '{}');
    await fs.writeFile(path.join(dir, 'explainer-player.js'), '// v1');
    await fs.writeFile(path.join(dir, 'explainer-player.html'), '<html></html>');

    const timeline = { clips: [{ id: 'c1' }] };
    const hashA = await computeRenderHash(dir, timeline, path.join(dir, 'out.mp4'));

    await fs.mkdir(chunkDir, { recursive: true });
    await fs.writeFile(path.join(chunkDir, 'chunk-000000.mp4'), 'x');
    await fs.writeFile(path.join(chunkDir, 'chunk-000900.mp4'), 'x');
    await fs.writeFile(path.join(chunkDir, 'concat-list.txt'), 'x');

    // First run: no manifest means unknown provenance -> the orphaned chunks are
    // discarded instead of being stitched into the new video (P0/B2).
    assert.equal(await ensureChunkManifest(chunkDir, hashA), 2);
    assert.deepEqual(await fs.readdir(chunkDir), ['manifest.json']);

    // Simulate a completed render, then re-run with the same hash: chunks are reused.
    await fs.writeFile(path.join(chunkDir, 'chunk-000000.mp4'), 'x');
    await fs.writeFile(path.join(chunkDir, 'chunk-000900.mp4'), 'x');
    await fs.writeFile(path.join(chunkDir, 'concat-list.txt'), 'x');
    assert.equal(await ensureChunkManifest(chunkDir, hashA), 0);
    assert.equal((await fs.readdir(chunkDir)).includes('chunk-000000.mp4'), true);

    // Player JS changed -> hash changes -> stale chunks are wiped.
    await fs.writeFile(path.join(dir, 'explainer-player.js'), '// v2');
    const hashB = await computeRenderHash(dir, timeline, path.join(dir, 'out.mp4'));
    assert.notEqual(hashA, hashB);
    assert.equal(await ensureChunkManifest(chunkDir, hashB), 2);
    const remaining = await fs.readdir(chunkDir);
    assert.deepEqual(remaining, ['manifest.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rebuild style resolution (old bundles without style.json)
// ---------------------------------------------------------------------------

test('resolveRebuildStyle migrates legacy effect fields when style.json is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explainer-rebuild-'));
  try {
    const messages: string[] = [];
    const style = await resolveRebuildStyle({
      tutorialDir: dir,
      rawTimeline: LEGACY_STORYBOARD,
      onProgress: (_stage, message) => messages.push(message),
    });
    assert.equal(style.theme.bg, '#0B0F19');
    assert.equal(style.theme.accent, '#FF8A3D');
    assert.equal(style.timing.shotDur, 4.6);
    assert.equal(style.overrides['shot:s1'].camera.mode, 'script');
    assert.ok(messages.some((m) => m.includes('Migrated')));

    // The resolved style is persisted so the next rebuild is a pure re-render.
    const written = JSON.parse(await fs.readFile(path.join(dir, 'style.json'), 'utf-8'));
    assert.equal(written.theme.bg, '#0B0F19');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveRebuildStyle fails loudly when there is neither style.json nor legacy effects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explainer-rebuild-empty-'));
  try {
    await assert.rejects(
      () =>
        resolveRebuildStyle({
          tutorialDir: dir,
          rawTimeline: {
            meta: { title: 'content only', design: { w: 1920, h: 1080 } },
            clips: [
              {
                id: 'c1',
                title: 'chapter',
                shots: [{ id: 's1', elements: [['a', 'icon:x']], narration: ['a'] }],
              },
            ],
          },
        }),
      /neither .*style\.json.* nor legacy effect fields/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runtime bundle
// ---------------------------------------------------------------------------

test('player runtime bundles as a single IIFE without legacy tutorial globals', () => {
  const js = buildPlayerRuntime();
  assert.ok(js.length > 20_000, 'bundle looks empty');
  assert.equal(/^\s*import\s/m.test(js), false, 'bundle still contains ESM imports');
  assert.equal(js.includes('window.__tutorial'), false, 'legacy tutorial global leaked into the bundle');
  // Shader sources are inlined by the esbuild .glsl text loader.
  assert.ok(js.includes('vec4 transition'), 'transition shaders were not inlined');
});
