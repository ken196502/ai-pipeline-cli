/**
 * X/Twitter search query helpers shared by every pipeline that scrapes
 * `x.com/search` (xdev keyword sweep, xhot topic discovery, …).
 */

export interface NormalizeSearchQueryOptions {
  /**
   * Language operator to append when the query does not already carry one.
   * Defaults to `en`. Pass `null` (or an empty string) to leave the query
   * untouched — required for non-English topics.
   */
  lang?: string | null;
}

const LANG_MODIFIER_RE = /\blang:\w+/i;

/**
 * Ensures the search query has an explicit language restriction.
 *
 * - query already contains `lang:xx`  → returned unchanged (never duplicated)
 * - `options.lang` is `null` / `''`   → returned trimmed, no operator added
 * - otherwise                         → `<query> lang:<lang>` (default `en`)
 */
export function normalizeSearchQuery(
  keyword: string,
  options: NormalizeSearchQueryOptions = {}
): string {
  const trimmed = keyword.trim();
  if (!trimmed) return trimmed;
  if (LANG_MODIFIER_RE.test(trimmed)) return trimmed;

  const lang = options.lang === undefined ? 'en' : options.lang;
  const normalizedLang = (lang ?? '').trim();
  if (!normalizedLang) return trimmed;

  return `${trimmed} lang:${normalizedLang}`;
}

/**
 * Maps a CLI value (`--search-lang`) to the search language operator.
 * `none` / `off` / `false` disables the filter entirely.
 */
export function parseSearchLangOption(value?: string | null): string | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return 'en';
  if (raw === 'none' || raw === 'off' || raw === 'false') return null;
  return raw;
}

/**
 * Share of non-space characters that are CJK ideographs.
 *
 * X's `lang:en` operator is a heuristic, so mixed-script tweets (English
 * keyword + Chinese body) still slip into the feed. This is the text-level
 * backstop used by discovery/harvest to drop them.
 */
export function cjkRatio(text: string): number {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return 0;
  const nonSpace = trimmed.replace(/\s+/g, '').length;
  if (nonSpace === 0) return 0;
  const cjk = (trimmed.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk / nonSpace;
}

/**
 * True when a tweet body reads as non-English (CJK dominated).
 * Image/video-only tweets (empty text) are never considered CJK-dominated.
 */
export function isCjkDominated(text: string, threshold = 0.15): boolean {
  const ratio = cjkRatio(text);
  if (ratio === 0) return false;
  return ratio >= threshold;
}

/**
 * Builds the `x.com/search` URL for a feed tab, applying the language
 * restriction through {@link normalizeSearchQuery}.
 */
export function buildXSearchUrl(
  query: string,
  rank: 'top' | 'live',
  lang: string | null = 'en'
): string {
  const finalQuery = normalizeSearchQuery(query, { lang });
  return `https://x.com/search?q=${encodeURIComponent(finalQuery)}&f=${rank}`;
}
