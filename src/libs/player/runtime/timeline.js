// Pure timeline helpers (no DOM): unit-testable in Node.
//
// Imported by core.js for playback and by tests/explainer-style.test.ts to
// assert the first-frame contract (P0/B1).

/**
 * Locates (clip, shot window) for time t.
 *
 * Each clip occupies exactly `playDur[i]` seconds. For clip i > 0 the first
 * `clipTrans` seconds are the transition INTO it; the very first clip has no
 * predecessor, so its first `clipTrans` seconds show its own entrance (title
 * card + camera settle) instead of transitioning in from the last chapter.
 *
 * @param {{ playDur: number[], clipTrans: number, clipCount: number, t: number }} params
 * @returns {{trans: true, cur: number, next: number, k: number}
 *          | {trans: false, ci: number, local: number}}
 */
export function locateClip(params) {
  const { playDur, clipTrans, clipCount, t } = params;
  const total = playDur.reduce((a, b) => a + b, 0);
  const time = Math.max(0, Math.min(total - 1e-6, t));
  let acc = 0;

  for (let i = 0; i < clipCount; i++) {
    const pd = playDur[i];
    const enterEnd = acc + Math.min(clipTrans, pd);
    if (time < enterEnd) {
      if (i === 0) return { trans: false, ci: 0, local: time };
      return { trans: true, cur: i - 1, next: i, k: (time - acc) / clipTrans };
    }
    if (time < acc + pd) {
      return { trans: false, ci: i, local: time - acc };
    }
    acc += pd;
  }
  return { trans: false, ci: 0, local: 0 };
}

/**
 * Deterministic clip-transition selection.
 *   fixed    → pool[0]
 *   sequence → pool[clipIndex % pool.length]
 *   seed     → stable pseudo-random pick seeded by (seed, clipIndex, clipCount)
 */
export function pickTransitionName(params) {
  const { channel, clipIndex, totalClips } = params;
  const pool = Array.isArray(channel.pool) && channel.pool.length > 0 ? channel.pool : ['directionalWarp'];
  if (pool.length === 1) return pool[0];
  const mode = channel.mode || 'sequence';
  if (mode === 'fixed') return pool[0];
  if (mode === 'seed') {
    let x = (channel.seed || 7) + clipIndex * 2654435761 + totalClips * 40503;
    x = Math.imul(x ^ (x >>> 15), 0x27d4eb2d);
    return pool[Math.abs(x) % pool.length];
  }
  return pool[clipIndex % pool.length];
}
