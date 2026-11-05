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
