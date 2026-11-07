/**
 * Deterministic narrative linter for explainer storyboards.
 *
 * Prompt wording alone cannot guarantee Fireship-style pacing: density,
 * opening hook, banned filler phrases and phrase/narration integrity must be
 * measurable so a weak storyboard can be rejected and the rejection fed back
 * into the existing LLM repair loop (produce.ts). Every rule here is a pure
 * function of (storyboard, thresholds) — no fs, no logging, no network — so
 * the same input always yields the same verdict in tests and in production.
 *
 * The lint only runs when a caller passes `narrativeThresholds`; documentary
 * generation passes nothing and stays byte-identical.
 */
import type { ExplainerStoryboard } from '../../libs/player/contracts.js';
import { collectPhraseExcerptErrors } from '../../libs/player/phrase.js';

export interface NarrativeThresholds {
  minWordsPerLine: number;
  maxWordsPerLine: number;
  minLines: number;
  maxLines: number;
  minShots: number;
  maxShots: number;
  minChapters: number;
  maxChapters: number;
  /** Number of opening narration lines scanned for the hook. */
  hookScanLines: number;
  bannedPhrases: string[];
  minNumberHits: number;
}

/**
 * Fireship target profile: 4-5 chapters, 12-15 shots, 45-60 short narration
 * lines of 5-9 words, a hook inside the first two lines, no filler openings.
 */
export const FIRESHIP_THRESHOLDS: NarrativeThresholds = {
  minWordsPerLine: 5,
  maxWordsPerLine: 9,
  minLines: 45,
  maxLines: 60,
  minShots: 12,
  maxShots: 15,
  minChapters: 4,
  maxChapters: 5,
  hookScanLines: 2,
  bannedPhrases: [
    "today's discussions",
    "today's tech conversations",
    'one developer says',
    'another thread',
    'in conclusion',
    'it is worth noting',
    "let's dive in",
    'in this video',
    'as we can see',
    'reaches a fever pitch',
  ],
  minNumberHits: 3,
};

export interface NarrativeMetrics {
  chapters: number;
  shots: number;
  lines: number;
  totalWords: number;
  avgWordsPerLine: number;
  linesOverMax: number;
  linesUnderMin: number;
  hookFound: boolean;
  bannedHits: Array<{ phrase: string; line: string }>;
  numberHits: number;
  contrastHits: number;
  phraseExcerptErrors: number;
}

export interface NarrativeViolation {
  code: string;
  message: string;
}

/** Stakes/contrast vocabulary that makes an opening line feel like a hook. */
const CONTRAST_WORDS = [
  'but',
  'than',
  'beats',
  'vs',
  'overnight',
  'suddenly',
  'everyone',
  'nobody',
  'finally',
  'already',
  'broke',
  'killed',
  'dead',
] as const;

const CONTRAST_RE = new RegExp(`\\b(?:${CONTRAST_WORDS.join('|')})\\b`, 'i');
const NUMBER_RE = /\d|%/;
/** Leading/trailing non-letter, non-digit characters (punctuation). */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Structural view of a storyboard that tolerates absent arrays. */
interface LooseStoryboard {
  clips?: Array<{ shots?: Array<{ narration?: unknown[] }> }>;
}

/** Words in one narration line: whitespace split, surrounding punctuation stripped. */
function countWords(line: string): number {
  return String(line)
    .split(/\s+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => token.length > 0).length;
}

function containsBannedPhrase(line: string, bannedPhrases: readonly string[]): boolean {
  const lower = line.toLowerCase();
  return bannedPhrases.some((phrase) => phrase.length > 0 && lower.includes(phrase.toLowerCase()));
}

/**
 * Thresholds are a flat record, so a key-wise merge over FIRESHIP_THRESHOLDS
 * is the deep merge: absent keys keep the Fireship default, present keys win.
 */
function resolveThresholds(overrides?: Partial<NarrativeThresholds>): NarrativeThresholds {
  if (!overrides) return FIRESHIP_THRESHOLDS;
  const merged: NarrativeThresholds = { ...FIRESHIP_THRESHOLDS };
  for (const key of Object.keys(FIRESHIP_THRESHOLDS) as Array<keyof NarrativeThresholds>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(merged, { [key]: value });
    }
  }
  return merged;
}

/**
 * Measures a storyboard against the narrative thresholds and lists every
 * violation with the measured value and the required range, so the message
 * can be handed to the model verbatim as a repair instruction.
 */
export function lintNarrative(
  storyboard: ExplainerStoryboard,
  thresholds?: Partial<NarrativeThresholds>
): { metrics: NarrativeMetrics; violations: NarrativeViolation[] } {
  const limits = resolveThresholds(thresholds);
  const loose = storyboard as unknown as LooseStoryboard;
  const clips = Array.isArray(loose?.clips) ? loose.clips : [];

  let shots = 0;
  const lines: string[] = [];
  for (const clip of clips) {
    const clipShots = Array.isArray(clip?.shots) ? clip.shots : [];
    shots += clipShots.length;
    for (const shot of clipShots) {
      const narration = Array.isArray(shot?.narration) ? shot.narration : [];
      for (const sentence of narration) {
        lines.push(typeof sentence === 'string' ? sentence : String(sentence ?? ''));
      }
    }
  }

  const chapters = clips.length;
  const wordCounts = lines.map(countWords);
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  const avgWordsPerLine =
    lines.length > 0 ? Math.round((totalWords / lines.length) * 10) / 10 : 0;
  const linesOverMax = wordCounts.filter((count) => count > limits.maxWordsPerLine).length;
  const linesUnderMin = wordCounts.filter((count) => count < limits.minWordsPerLine).length;

  const bannedHits: Array<{ phrase: string; line: string }> = [];
  const bannedHitLineNumbers: number[] = [];
  lines.forEach((line, index) => {
    for (const phrase of limits.bannedPhrases) {
      if (phrase.length > 0 && line.toLowerCase().includes(phrase.toLowerCase())) {
        bannedHits.push({ phrase, line });
        bannedHitLineNumbers.push(index + 1);
      }
    }
  });

  const scanLines = lines.slice(0, Math.max(0, limits.hookScanLines));
  const hookFound = scanLines.some((line) => {
    const hasSignal = NUMBER_RE.test(line) || CONTRAST_RE.test(line);
    return hasSignal && !containsBannedPhrase(line, limits.bannedPhrases);
  });

  const numberHits = lines.filter((line) => NUMBER_RE.test(line)).length;
  const contrastHits = lines.filter((line) => CONTRAST_RE.test(line)).length;
  const phraseErrors = collectPhraseExcerptErrors(storyboard);

  const metrics: NarrativeMetrics = {
    chapters,
    shots,
    lines: lines.length,
    totalWords,
    avgWordsPerLine,
    linesOverMax,
    linesUnderMin,
    hookFound,
    bannedHits,
    numberHits,
    contrastHits,
    phraseExcerptErrors: phraseErrors.length,
  };

  const violations: NarrativeViolation[] = [];

  if (chapters < limits.minChapters || chapters > limits.maxChapters) {
    violations.push({
      code: 'chapters_out_of_range',
      message: `chapters: ${chapters} (required ${limits.minChapters}-${limits.maxChapters}) — merge or split clips to land in range`,
    });
  }

  if (shots < limits.minShots || shots > limits.maxShots) {
    violations.push({
      code: 'shots_out_of_range',
      message: `shots: ${shots} (required ${limits.minShots}-${limits.maxShots}) — regroup the narration into ${limits.minShots}-${limits.maxShots} shots`,
    });
  }

  if (lines.length < limits.minLines || lines.length > limits.maxLines) {
    violations.push({
      code: 'lines_out_of_range',
      message: `narration lines: ${lines.length} (required ${limits.minLines}-${limits.maxLines}) — add or cut narration beats to reach the target density`,
    });
  }

  if (avgWordsPerLine > limits.maxWordsPerLine || linesOverMax > 0) {
    violations.push({
      code: 'words_per_line_too_high',
      message: `words per line: average ${avgWordsPerLine}, ${linesOverMax} line(s) above ${limits.maxWordsPerLine} words (required ${limits.minWordsPerLine}-${limits.maxWordsPerLine} words per line) — split long sentences into short beats`,
    });
  }

  if (avgWordsPerLine < limits.minWordsPerLine || linesUnderMin > 0) {
    violations.push({
      code: 'words_per_line_too_low',
      message: `words per line: average ${avgWordsPerLine}, ${linesUnderMin} line(s) below ${limits.minWordsPerLine} words (required ${limits.minWordsPerLine}-${limits.maxWordsPerLine} words per line) — merge or expand lines that carry no complete claim`,
    });
  }

  if (!hookFound) {
    violations.push({
      code: 'missing_opening_hook',
      message: `opening hook missing: none of the first ${limits.hookScanLines} narration line(s) carries a concrete number/percentage or a contrast claim — open with a bold, factual hook`,
    });
  }

  bannedHits.forEach((hit, index) => {
    violations.push({
      code: 'banned_phrase',
      message: `banned phrase "${hit.phrase}" on line ${bannedHitLineNumbers[index]}: "${hit.line}" — delete the filler and state the claim directly`,
    });
  });

  if (metrics.phraseExcerptErrors > 0) {
    violations.push({
      code: 'phrase_excerpt_broken',
      message: `phrase excerpts broken: ${metrics.phraseExcerptErrors} element phrase(s) are not verbatim narration slices — ${phraseErrors[0]}`,
    });
  }

  if (numberHits < limits.minNumberHits) {
    violations.push({
      code: 'number_density_low',
      message: `number density: ${numberHits} line(s) contain a number or % (required at least ${limits.minNumberHits}) — cite concrete figures from the source material`,
    });
  }

  return { metrics, violations };
}

/**
 * Renders the lint result as a compact, one-line-per-violation repair note.
 * The text is appended to the retry prompt verbatim, so it must read as an
 * instruction list rather than a log dump.
 */
export function formatNarrativeViolations(result: {
  metrics: NarrativeMetrics;
  violations: NarrativeViolation[];
}): string {
  return result.violations.map((violation) => `- [${violation.code}] ${violation.message}`).join('\n');
}
