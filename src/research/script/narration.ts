/**
 * Narration & Dialogue Sanitizer and Validator
 *
 * Prevents non-dialogue cues (e.g. "No dialogue", "Mood cue: ...", "Distant wind", "None")
 * from being treated as spoken voiceover lines or sent to TTS synthesis.
 */

const NON_DIALOGUE_PATTERNS: RegExp[] = [
  /^\s*no\s*dialog(ue)?\b/i,
  /^\s*without\s*dialog(ue)?\b/i,
  /^\s*no\s*speech\b/i,
  /^\s*no\s*voice(over)?\b/i,
  /^\s*no\s*spoken\b/i,
  /^\s*no\s*narration\b/i,
  /^\s*silent\b/i,
  /^\s*silence\b/i,
  /^\s*none\b/i,
  /^\s*n\/?a\b/i,
  /^\s*ambient\s*(sound|audio|noise)?\b/i,
  /^\s*instrumental\b/i,
  /^\s*sound\s*effects?\b/i,
  /^\s*sfx\b/i,
  /^\s*(无对白|无旁白|无对话|无台词|纯音乐|静音|环境音|无配音)/u,
];

/**
 * Common prefixes that describe mood or audio cues rather than spoken lines.
 */
const CUE_PREFIXES: RegExp[] = [
  /^(mood\s*cue\s*:\s*)/i,
  /^(audio\s*cue\s*:\s*)/i,
  /^(sound\s*cue\s*:\s*)/i,
  /^(sound\s*effects?\s*:\s*)/i,
  /^(sfx\s*:\s*)/i,
  /^(voiceover\s*cue\s*:\s*)/i,
  /^(narration\s*cue\s*:\s*)/i,
  /^(bgm\s*:\s*)/i,
  /^(ambience\s*:\s*)/i,
  /^(环境音\s*[：:]\s*)/i,
  /^(音效\s*[：:]\s*)/i,
  /^(情绪提示\s*[：:]\s*)/i,
];

/**
 * Cleans a narration/dialogue candidate string.
 * If the string expresses lack of dialogue, mood cues, or purely environmental audio descriptions,
 * returns an empty string `""`.
 */
export function sanitizeNarrationText(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';

  // If the raw text contains explicit "no dialogue" or "no dialog" or Chinese equivalent
  if (/\bno\s*dialog(ue)?\b/i.test(text) || /(无对白|无旁白|无台词|无对话)/u.test(text)) {
    return '';
  }

  // Strip cue prefixes e.g. "Mood cue: " or "Voiceover cue: "
  let strippedPrefix = true;
  while (strippedPrefix) {
    strippedPrefix = false;
    for (const prefix of CUE_PREFIXES) {
      if (prefix.test(text)) {
        text = text.replace(prefix, '').trim();
        strippedPrefix = true;
      }
    }
  }

  if (!text) return '';

  // Check against non-dialogue patterns
  for (const pattern of NON_DIALOGUE_PATTERNS) {
    if (pattern.test(text)) {
      return '';
    }
  }

  // Remove surrounding quotes if wrapped
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim();
  }

  // If after stripping quotes it matches non-dialogue
  for (const pattern of NON_DIALOGUE_PATTERNS) {
    if (pattern.test(text)) {
      return '';
    }
  }

  // Check if it's purely sound effects e.g. "Distant wind, soft footsteps, faint crowd rumble."
  const soundOnlyIndicators = /\b(footsteps|wind|rain|breathing|heartbeat|whispers|rumble|thunder|birds|traffic|explosion|crowd murmur|door creaks?|sirens?)\b/i;
  const sentenceStructure = /\b(he|she|they|i|we|you|it|this|that|there|is|are|was|were|will|said|says)\b/i;
  // If it only lists sound effects separated by commas/periods without narrative subject or verb
  if (soundOnlyIndicators.test(text) && !sentenceStructure.test(text) && text.split(/[,;.!?]/).length >= 2) {
    return '';
  }

  return text;
}

/**
 * Returns true if the text represents actual spoken dialogue or narrative script
 * suitable for voice synthesis (TTS) or narration subtitles.
 */
export function isActionableSpokenNarration(raw: string | null | undefined): boolean {
  const cleaned = sanitizeNarrationText(raw);
  return cleaned.length > 0;
}
