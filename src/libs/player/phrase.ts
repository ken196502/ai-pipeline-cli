/**
 * Phrase ↔ narration alignment.
 *
 * Every on-screen element phrase is a verbatim excerpt of its narration
 * sentence. That contract lets the player reveal an element exactly when the
 * TTS voice speaks the phrase (minus a small lead, `style.timing.phraseLead`)
 * instead of at the start of the sentence.
 *
 * Matching ignores case, whitespace and punctuation so "GPT-6.3 Sol" matches
 * "gpt 6.3 sol" and curly/straight apostrophes are equivalent.
 */
import type { ExplainerWord } from './contracts.js';

const KEEP_CHAR = /[\p{L}\p{N}]/u;

export interface NormalizedText {
  /** Lower-cased letters/digits only. */
  norm: string;
  /** norm[i] came from original text index map[i]. */
  map: number[];
}

/** Lower-cases and strips everything except letters and digits. */
export function normalizeForMatch(text: string): NormalizedText {
  const chars = Array.from(String(text || ''));
  let norm = '';
  const map: number[] = [];
  let offset = 0;
  for (const ch of chars) {
    if (KEEP_CHAR.test(ch)) {
      const lower = ch.toLowerCase();
      norm += lower;
      for (let k = 0; k < lower.length; k++) map.push(offset);
    }
    offset += ch.length;
  }
  return { norm, map };
}

/** True when `phrase` appears verbatim (modulo case/punctuation) inside `sentence`. */
export function isPhraseExcerpt(phrase: string, sentence: string): boolean {
  const p = normalizeForMatch(phrase).norm;
  if (!p) return false;
  return normalizeForMatch(sentence).norm.includes(p);
}

/** Component refs never display their phrase as copy, so they are exempt. */
function isComponentVisual(ref: unknown): boolean {
  const id = typeof ref === 'string' ? ref : (ref as any)?.assetId || (ref as any)?.name || '';
  return (
    typeof id === 'string' &&
    (id.startsWith('component:') ||
      id === 'final-ai-video' ||
      id === 'flash' ||
      id.startsWith('flash:') ||
      id === 'xhot-candidate-grid')
  );
}

interface PhraseCheckStoryboard {
  clips?: Array<{
    id?: string;
    shots?: Array<{ id?: string; elements?: Array<[string, unknown] | readonly unknown[]>; narration?: string[] }>;
  }>;
}

/**
 * Lists every element whose phrase is not an excerpt of its 1:1 narration
 * sentence. The messages are written for the LLM repair turn.
 */
export function collectPhraseExcerptErrors(storyboard: PhraseCheckStoryboard): string[] {
  const errors: string[] = [];
  for (const clip of storyboard.clips || []) {
    for (const shot of clip.shots || []) {
      const elements = shot.elements || [];
      const narration = shot.narration || [];
      if (narration.length !== elements.length) {
        errors.push(
          `shot "${shot.id}": elements (${elements.length}) and narration (${narration.length}) must be 1:1 — one narration sentence per element`
        );
      }
      elements.forEach((element, j) => {
        const phrase = String(element[0] ?? '');
        if (isComponentVisual(element[1])) return;
        const sentence = narration[j] ?? '';
        if (!isPhraseExcerpt(phrase, sentence)) {
          errors.push(
            `shot "${shot.id}" element ${j + 1}: phrase "${phrase}" is not copied verbatim from its narration sentence "${sentence}" — the phrase must be an exact contiguous excerpt (3-8 words) of narration[${j}]`
          );
        }
      });
    }
  }
  return errors;
}

export interface PhraseTiming {
  /** Absolute time the voice starts speaking the phrase. */
  pStart: number;
  /** Absolute time the voice finishes speaking the phrase. */
  pEnd: number;
  /** False when the phrase was not found in the line text (falls back to the line span). */
  matched: boolean;
}

/**
 * Locates when a phrase is spoken inside a TTS line.
 *
 * `words` carry ABSOLUTE t0/t1 (already offset by `aStart`). They may be real
 * word boundaries (local TTS) or per-character linear estimates (Qwen3-TTS);
 * both are mapped onto normalized character boundaries and interpolated.
 */
export function locatePhraseTiming(params: {
  text: string;
  phrase: string;
  aStart: number;
  aDur: number;
  words?: readonly ExplainerWord[];
}): PhraseTiming {
  const { text, phrase, aStart, aDur } = params;
  const lineEnd = aStart + Math.max(0, aDur);
  const fallback: PhraseTiming = { pStart: aStart, pEnd: lineEnd, matched: false };
  if (!(aDur > 0)) return { pStart: aStart, pEnd: aStart, matched: false };

  const nt = normalizeForMatch(text).norm;
  const np = normalizeForMatch(phrase).norm;
  if (!nt || !np) return fallback;
  const at = nt.indexOf(np);
  if (at < 0) return fallback;

  // Boundary times: boundary b sits before normalized char b (0..len).
  // Normalized text has no spaces, so the end of one word and the start of the
  // next share a boundary; keep word starts and word ends apart so a phrase
  // starts when its first word starts (not when the previous word ends).
  const len = nt.length;
  const starts: Array<number | null> = new Array(len + 1).fill(null);
  const ends: Array<number | null> = new Array(len + 1).fill(null);
  let cursor = 0;
  for (const w of params.words || []) {
    const nw = normalizeForMatch(w.word).norm;
    if (!nw) continue;
    const pos = nt.indexOf(nw, cursor);
    // Skip words the TTS text normalisation diverged on (e.g. spelled numbers);
    // they would otherwise drag the cursor far ahead.
    if (pos < 0 || pos - cursor > Math.max(12, nw.length * 3)) continue;
    if (starts[pos] == null) starts[pos] = w.t0;
    ends[pos + nw.length] = w.t1;
    cursor = pos + nw.length;
  }
  const known: Array<number | null> = starts.map((s, b) => s ?? ends[b]);
  if (known[0] == null) known[0] = aStart;
  if (known[len] == null) known[len] = lineEnd;

  const timeAt = (b: number, prefer: Array<number | null>): number => {
    if (prefer[b] != null) return prefer[b] as number;
    if (known[b] != null) return known[b] as number;
    let lo = b;
    while (lo > 0 && known[lo] == null) lo--;
    let hi = b;
    while (hi < len && known[hi] == null) hi++;
    const t0 = known[lo] as number;
    const t1 = known[hi] as number;
    return hi === lo ? t0 : t0 + ((t1 - t0) * (b - lo)) / (hi - lo);
  };

  const clampT = (t: number) => Math.min(lineEnd, Math.max(aStart, t));
  const pStart = clampT(timeAt(at, starts));
  const pEnd = Math.max(pStart, clampT(timeAt(at + np.length, ends)));
  return { pStart: round3(pStart), pEnd: round3(pEnd), matched: true };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
