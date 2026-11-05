/**
 * Phrase ↔ narration alignment: excerpt validation, spoken-phrase timing and
 * the style knobs the player uses to place and animate phrases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPhraseExcerptErrors,
  isPhraseExcerpt,
  locatePhraseTiming,
  normalizeForMatch,
} from '../src/libs/player/phrase.js';
import { defaultStyle, LANDSCAPE_VARIANTS, TITLE_CARD_LAYOUTS } from '../src/libs/player/style.js';

test('normalizeForMatch strips case and punctuation and keeps an index map', () => {
  const { norm, map } = normalizeForMatch('GPT-6.3 Sol!');
  assert.equal(norm, 'gpt63sol');
  assert.equal(map.length, norm.length);
  assert.equal(map[3], 4); // "6" sits at original index 4
});

test('isPhraseExcerpt accepts verbatim excerpts and rejects paraphrases', () => {
  const sentence = 'The model repeats a golden prompt across every shot.';
  assert.equal(isPhraseExcerpt('repeats a golden prompt', sentence), true);
  assert.equal(isPhraseExcerpt('Repeats a GOLDEN prompt,', sentence), true);
  assert.equal(isPhraseExcerpt('reuses a golden prompt', sentence), false);
  assert.equal(isPhraseExcerpt('', sentence), false);
});

test('collectPhraseExcerptErrors flags paraphrases and count mismatches, exempts components', () => {
  const errors = collectPhraseExcerptErrors({
    clips: [
      {
        id: 'c1',
        shots: [
          {
            id: 's1',
            elements: [
              ['golden prompt', 'icon:sun'],
              ['totally different words', 'icon:code'],
              ['anything goes', 'component:flash'],
            ],
            narration: ['Keep one golden prompt.', 'Do not reuse the grid.', 'Watch the montage.'],
          },
          { id: 's2', elements: [['a', 'icon:x']], narration: [] },
        ],
      },
    ],
  });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /s1" element 2/);
  assert.match(errors[1], /s2": elements \(1\) and narration \(0\)/);
  assert.match(errors[2], /s2" element 1/);
});

test('locatePhraseTiming uses word boundaries when available', () => {
  const r = locatePhraseTiming({
    text: 'Keep one golden prompt.',
    phrase: 'golden prompt',
    aStart: 10,
    aDur: 2,
    words: [
      { word: 'Keep', t0: 10, t1: 10.4 },
      { word: 'one', t0: 10.5, t1: 10.8 },
      { word: 'golden', t0: 11, t1: 11.4 },
      { word: 'prompt.', t0: 11.5, t1: 11.9 },
    ],
  });
  assert.deepEqual(r, { pStart: 11, pEnd: 11.9, matched: true });
});

test('locatePhraseTiming interpolates without words and falls back when unmatched', () => {
  const r = locatePhraseTiming({ text: 'aaaa bbbb', phrase: 'bbbb', aStart: 0, aDur: 8 });
  assert.equal(r.matched, true);
  assert.equal(r.pStart, 4);
  assert.equal(r.pEnd, 8);

  const miss = locatePhraseTiming({ text: 'aaaa bbbb', phrase: 'cccc', aStart: 3, aDur: 2 });
  assert.deepEqual(miss, { pStart: 3, pEnd: 5, matched: false });
});

test('default style exposes phrase lead, title/landscape variants, typewriter and cyber background', () => {
  const style = defaultStyle();
  assert.equal(style.timing.phraseLead, 0.1);
  assert.deepEqual([...style.components.titleCard.layouts].sort(), [...TITLE_CARD_LAYOUTS].sort());
  assert.deepEqual([...style.components.landscape.variants].sort(), [...LANDSCAPE_VARIANTS].sort());
  assert.ok(style.components.typewriter.cps > 0);
  assert.equal(style.background.mode, 'cyber');
});
