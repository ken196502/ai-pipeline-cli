/**
 * Narrative lint: density, structure, opening hook, banned filler and
 * phrase/narration integrity, measured deterministically so the produce.ts
 * repair loop can reject a weak storyboard with an actionable note.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExplainerStoryboard } from '../src/libs/player/contracts.js';
import {
  FIRESHIP_THRESHOLDS,
  formatNarrativeViolations,
  lintNarrative,
} from '../src/modules/explainer-video/narrative-lint.js';

interface FixtureShot {
  id: string;
  narration: string[];
  /** Overrides the phrase for element i (defaults to the narration line). */
  phrases?: string[];
}

interface FixtureClip {
  id: string;
  shots: FixtureShot[];
}

/** Builds a storyboard whose element phrases are verbatim slices by default. */
function storyboardOf(clips: FixtureClip[]): ExplainerStoryboard {
  const built = clips.map((clip) => ({
    id: clip.id,
    title: clip.id,
    shots: clip.shots.map((shot) => ({
      id: shot.id,
      narration: shot.narration,
      elements: shot.narration.map((line, index) => [shot.phrases?.[index] ?? line, 'sparkles']),
    })),
  }));
  return { clips: built } as unknown as ExplainerStoryboard;
}

function narrationLinesOf(storyboard: ExplainerStoryboard): string[] {
  return storyboard.clips.flatMap((clip) => clip.shots.flatMap((shot) => shot.narration));
}

// ---------------------------------------------------------------- fixtures

const FILLER_WORDS = [
  'model', 'ships', 'faster', 'than', 'ever', 'devs', 'notice', 'every', 'single',
  'release', 'breaks', 'records', 'quietly', 'already', 'shipping', 'hard', 'numbers',
  'prove', 'it', 'matters', 'to', 'you', 'today',
];
const NUMBER_TOKENS = ['3x', '18%', '40%', '2x', '9x'];

/** 5-9 word lines, with a numeric hit every fourth line. */
function fireshipLine(index: number): string {
  if (index === 0) return 'GPT-6.3 beats Claude by 18 percent';
  const wordCount = 5 + (index % 5);
  const words: string[] = [];
  for (let k = 0; k < wordCount; k++) {
    words.push(FILLER_WORDS[(index * 7 + k) % FILLER_WORDS.length]);
  }
  if (index % 4 === 0) {
    words[wordCount - 1] = NUMBER_TOKENS[index % NUMBER_TOKENS.length];
  }
  return `${words.join(' ')}.`;
}

/** 4 chapters x 3 shots x 4 lines = 48 lines / 12 shots / 4 chapters. */
function fireshipStoryboard(): ExplainerStoryboard {
  const clips: FixtureClip[] = [];
  let lineIndex = 0;
  for (let chapter = 0; chapter < 4; chapter++) {
    const shots: FixtureShot[] = [];
    for (let shot = 0; shot < 3; shot++) {
      const narration: string[] = [];
      for (let line = 0; line < 4; line++) {
        narration.push(fireshipLine(lineIndex));
        lineIndex += 1;
      }
      shots.push({ id: `c${chapter}-s${shot}`, narration });
    }
    clips.push({ id: `chapter-${chapter}`, shots });
  }
  return storyboardOf(clips);
}

const SPARSE_OPENER = "Today's discussions are focused on rumors of a new OpenAI frontier model.";
const SPARSE_BODY = 'Another thread connects the launch to older benchmarks and quiet reports today.';
/** 28 lines spread over 10 shots / 5 chapters, every line exactly 12 words. */
const SPARSE_SHOT_LINES = [3, 3, 3, 3, 3, 3, 3, 3, 2, 2];

function sparseStoryboard(): ExplainerStoryboard {
  const narration = [SPARSE_OPENER, ...Array.from({ length: 27 }, () => SPARSE_BODY)];
  const clips: FixtureClip[] = [];
  let cursor = 0;
  let shotIndex = 0;
  for (let chapter = 0; chapter < 5; chapter++) {
    const shots: FixtureShot[] = [];
    for (let shot = 0; shot < 2; shot++) {
      const count = SPARSE_SHOT_LINES[shotIndex];
      shotIndex += 1;
      shots.push({ id: `sparse-s${shotIndex}`, narration: narration.slice(cursor, cursor + count) });
      cursor += count;
    }
    clips.push({ id: `sparse-chapter-${chapter}`, shots });
  }
  return storyboardOf(clips);
}

// ------------------------------------------------------------------- tests

test('a compliant fireship storyboard passes with no violations', () => {
  const storyboard = fireshipStoryboard();
  const { metrics, violations } = lintNarrative(storyboard);

  assert.deepEqual(violations, []);

  const lines = narrationLinesOf(storyboard);
  const expectedTotal = lines.reduce((sum, line) => sum + line.trim().split(/\s+/).length, 0);

  assert.equal(metrics.chapters, 4);
  assert.equal(metrics.shots, 12);
  assert.equal(metrics.lines, 48);
  assert.equal(metrics.totalWords, expectedTotal);
  assert.equal(metrics.avgWordsPerLine, Math.round((expectedTotal / lines.length) * 10) / 10);
  assert.ok(metrics.avgWordsPerLine >= FIRESHIP_THRESHOLDS.minWordsPerLine);
  assert.ok(metrics.avgWordsPerLine <= FIRESHIP_THRESHOLDS.maxWordsPerLine);
  assert.equal(metrics.linesOverMax, 0);
  assert.equal(metrics.linesUnderMin, 0);
  assert.equal(metrics.hookFound, true);
  assert.deepEqual(metrics.bannedHits, []);
  assert.equal(metrics.numberHits, lines.filter((line) => /\d|%/.test(line)).length);
  assert.ok(metrics.numberHits >= FIRESHIP_THRESHOLDS.minNumberHits);
  assert.ok(metrics.contrastHits >= 1);
  assert.equal(metrics.phraseExcerptErrors, 0);
});

test('a baseline-style sparse storyboard is rejected with actionable codes', () => {
  const { metrics, violations } = lintNarrative(sparseStoryboard());
  const codes = violations.map((violation) => violation.code);

  assert.equal(metrics.lines, 28);
  assert.equal(metrics.shots, 10);
  assert.equal(metrics.chapters, 5);
  assert.equal(metrics.avgWordsPerLine, 12);
  assert.equal(metrics.hookFound, false);

  assert.ok(codes.includes('missing_opening_hook'));
  assert.ok(codes.includes('words_per_line_too_high'));
  assert.ok(codes.includes('lines_out_of_range'));
  assert.ok(codes.includes('shots_out_of_range'));
  assert.ok(!codes.includes('chapters_out_of_range'));

  const message = formatNarrativeViolations({ metrics, violations });
  assert.match(message, /required 45-60/);
  assert.match(message, /required 12-15/);
});

test('banned filler phrases are detected case-insensitively', () => {
  const storyboard = storyboardOf([
    {
      id: 'c1',
      shots: [{ id: 's1', narration: ['One developer says the launch broke everything.'] }],
    },
  ]);
  const { metrics, violations } = lintNarrative(storyboard);

  assert.equal(metrics.bannedHits.length, 1);
  assert.equal(metrics.bannedHits[0].phrase, 'one developer says');
  assert.equal(metrics.bannedHits[0].line, 'One developer says the launch broke everything.');
  assert.ok(violations.some((violation) => violation.code === 'banned_phrase'));
});

test('a phrase that is not a verbatim slice is reported as broken', () => {
  const storyboard = storyboardOf([
    {
      id: 'c1',
      shots: [
        {
          id: 's1',
          narration: ['Keep one golden prompt.'],
          phrases: ['totally different words'],
        },
      ],
    },
  ]);
  const { metrics, violations } = lintNarrative(storyboard);

  assert.equal(metrics.phraseExcerptErrors, 1);
  const broken = violations.find((violation) => violation.code === 'phrase_excerpt_broken');
  assert.ok(broken);
  assert.match(broken.message, /1 element phrase/);
});

test('an empty storyboard fails instead of passing silently', () => {
  const { metrics, violations } = lintNarrative({} as ExplainerStoryboard);

  assert.equal(metrics.chapters, 0);
  assert.equal(metrics.shots, 0);
  assert.equal(metrics.lines, 0);
  assert.ok(violations.length > 0);
  assert.ok(violations.some((violation) => violation.code === 'chapters_out_of_range'));
  assert.ok(violations.some((violation) => violation.code === 'missing_opening_hook'));
});

test('partial thresholds are merged over the fireship defaults', () => {
  const { violations } = lintNarrative(sparseStoryboard(), {
    minLines: 20,
    maxLines: 30,
    minShots: 5,
    maxShots: 20,
    maxWordsPerLine: 20,
  });
  const codes = violations.map((violation) => violation.code);

  assert.ok(!codes.includes('lines_out_of_range'));
  assert.ok(!codes.includes('shots_out_of_range'));
  assert.ok(!codes.includes('words_per_line_too_high'));
  // Untouched keys keep their fireship default.
  assert.ok(codes.includes('missing_opening_hook'));
  assert.ok(codes.includes('number_density_low'));
});

test('identical input yields identical output', () => {
  const storyboard = fireshipStoryboard();
  assert.deepEqual(lintNarrative(storyboard), lintNarrative(storyboard));
});
