/**
 * Subtitle track selection prioritizing manual captions over auto-generated captions
 * and matching language priorities with wildcard support.
 */

export interface SubtitleTrack {
  language: string;
  ext: string;
  kind: 'manual' | 'auto';
  url?: string;
  name?: string;
}

/**
 * Finds the optimal subtitle track matching the language preferences.
 * Manual captions strictly take precedence over auto-generated captions.
 */
export function selectBestSubtitleTrack(
  tracks: readonly SubtitleTrack[],
  preferredLanguages: readonly string[] = ['en', 'en-US', 'en-GB', 'en.*'],
): SubtitleTrack | null {
  if (!tracks || tracks.length === 0) return null;

  // Filter only tracks with supported extensions, preferably vtt
  const supported = tracks.filter(
    (t) => t.ext === 'vtt' || t.ext === 'ttml' || t.ext === 'srv3' || t.ext === 'json3',
  );
  const candidates = supported.length > 0 ? supported : tracks;

  const sorted = [...candidates].sort((a, b) => {
    // 1. Manual over auto
    const kindDiff = Number(a.kind === 'auto') - Number(b.kind === 'auto');
    if (kindDiff !== 0) return kindDiff;

    // 2. Language priority match rank
    const rankA = matchLanguageRank(a.language, preferredLanguages);
    const rankB = matchLanguageRank(b.language, preferredLanguages);
    if (rankA !== rankB) return rankA - rankB;

    // 3. Extension preference: vtt is preferred
    const extScoreA = a.ext === 'vtt' ? 0 : 1;
    const extScoreB = b.ext === 'vtt' ? 0 : 1;
    if (extScoreA !== extScoreB) return extScoreA - extScoreB;

    return a.language.localeCompare(b.language);
  });

  const best = sorted[0];
  if (!best) return null;

  // If the best doesn't even match any preferred language and rank is infinity,
  // we still return it if there are no language requirements or if candidates exist
  return best;
}

/**
 * Returns 0-based rank of the language in the preference list, or Infinity if no match.
 * Supports exact match ('en', 'en-US') and wildcard match ('en.*').
 */
function matchLanguageRank(lang: string, preferred: readonly string[]): number {
  const normalizedLang = lang.trim().toLowerCase();
  for (let i = 0; i < preferred.length; i += 1) {
    const pref = preferred[i]!.trim().toLowerCase();
    if (pref === normalizedLang) {
      return i;
    }
    if (pref.endsWith('.*')) {
      const prefix = pref.slice(0, -2);
      if (normalizedLang === prefix || normalizedLang.startsWith(`${prefix}-`)) {
        return i + 0.1; // Slightly lower priority than exact match
      }
    }
    if (pref === '*' || pref === 'any') {
      return i + 0.9;
    }
  }
  return Infinity;
}
