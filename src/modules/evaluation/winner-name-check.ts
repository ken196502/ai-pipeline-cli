/**
 * Winner-name verification for VL evaluation results.
 *
 * The VL model is asked to identify a *cluster* ("核心模型/技术/项目名称") spanning
 * several tweets, so the returned `winner.name` is often a synthetic aggregate label
 * (e.g. "Anthropic New Model (Claude/Fable)") anchored to one representative tweet.
 * That label is semantically correct but is not a contiguous substring of any single
 * tweet, so a naive substring check rejects valid answers.
 *
 * These helpers implement token-tolerant matching while keeping the anti-hallucination
 * guarantee for concrete named entities (e.g. "DeepSeek-V3").
 */

/** Generic words that carry no identifying signal in a model/project name. */
const GENERIC_TOKENS = new Set([
  'new',
  'model',
  'models',
  'ai',
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'rumor',
  'rumors',
  'rumour',
  'rumours',
  'project',
  'update',
  'updates',
  'unreleased',
  'next',
  'upcoming',
  'version',
  'release',
  'released',
  'latest',
  'latestnews',
  'news',
  'report',
  'reports',
  'leak',
  'leaks',
  'allegedly',
  'top',
  'best',
]);

/** Normalize to lowercase alphanumeric + CJK only. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/**
 * Split a display name into meaningful, order-independent content tokens.
 *
 * Splits on structural separators (`/ | 、 , ， & +`), bracket groups
 * (`( ) （ ） 【 】 [ ]`), whitespace, and hyphens. Then drops generic tokens.
 * Fully-CJK names are kept whole (they have no whitespace to split on).
 */
export function extractNameTokens(name: string): string[] {
  const chunks = name
    .split(/[/|、,，&+\-–—()（）【】\[\]]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const chunk of chunks) {
    // Split on whitespace first so mixed CJK/latin names ("月之暗面 Kimi K3") do not
    // get glued into one unmatchable token.
    for (const word of chunk.split(/\s+/)) {
      const trimmed = word.trim();
      if (!trimmed) continue;
      const norm = normalizeName(trimmed);
      if (!norm) continue;
      // CJK words have no reliable word boundaries; keep them whole.
      if (/[\u4e00-\u9fff]/.test(trimmed)) {
        tokens.push(norm);
        continue;
      }
      if (GENERIC_TOKENS.has(norm)) continue;
      tokens.push(norm);
    }
  }
  // De-duplicate while preserving order.
  return [...new Set(tokens.filter((t) => t.length > 0))];
}

export interface WinnerNameCheckInput {
  /** The name the VL model returned for the winner. */
  name: string;
  /** The winner's tweet text (may be empty for image-only cards). */
  tweetText: string;
  /** Optional extra haystacks: author name/handle, cluster reasoning, etc. */
  extraHaystacks?: string[];
}

export interface WinnerNameCheckResult {
  /** True when the name is sufficiently supported by the haystacks. */
  matches: boolean;
  /** Content tokens extracted from the name. */
  tokens: string[];
  /** How the match was established: 'all-tokens', 'single-token', 'exact', or 'no-content-tokens'. */
  strategy: 'exact' | 'all-tokens' | 'single-token' | 'no-content-tokens';
  /** Tokens that could not be found (diagnostics only). */
  missingTokens: string[];
  /**
   * False when the name contains no identifying tokens at all (fully generic label),
   * in which case a text check is meaningless and should not fail the run.
   */
  applicable: boolean;
}

/**
 * Verify that `name` is grounded in the winner's tweet text (plus optional extra
 * haystacks such as author handle or cluster reasoning).
 *
 * Match rules, in order:
 *  1. `no-content-tokens` — name is entirely generic; not applicable.
 *  2. `exact` — the whole normalized name appears contiguously.
 *  3. `all-tokens` — every content token appears (order-independent). This covers
 *     names like "Anthropic New Model (Claude/Fable)" when all parts are present
 *     across the cluster.
 *  4. `single-token` — at least one token of length >= 3 appears. Strictness depends on
 *     how much context is available:
 *       - tweet-only (no extra haystacks): no token of length >= 4 may be missing, so a
 *         partially-invented label is still rejected.
 *       - cluster context (extra haystacks present): a single strong token is enough,
 *         because the name is a synthetic cluster label and the remaining parts may
 *         legitimately live in sibling tweets rather than the anchor tweet.
 */
export function verifyWinnerName(input: WinnerNameCheckInput): WinnerNameCheckResult {
  const tokens = extractNameTokens(input.name);

  if (tokens.length === 0) {
    return {
      matches: true,
      tokens,
      strategy: 'no-content-tokens',
      missingTokens: [],
      applicable: false,
    };
  }

  const haystacks = [input.tweetText, ...(input.extraHaystacks ?? [])]
    .map(normalizeName);

  const exactNorm = normalizeName(input.name);
  if (exactNorm.length >= 2 && haystacks.some((h) => h.includes(exactNorm))) {
    return { matches: true, tokens, strategy: 'exact', missingTokens: [], applicable: true };
  }

  const missingTokens = tokens.filter(
    (tok) => !haystacks.some((h) => h.includes(tok))
  );

  if (missingTokens.length === 0) {
    return { matches: true, tokens, strategy: 'all-tokens', missingTokens: [], applicable: true };
  }

  const hasClusterContext = (input.extraHaystacks ?? []).length > 0;
  const strongHit = tokens.some(
    (tok) => tok.length >= 3 && haystacks.some((h) => h.includes(tok))
  );

  if (!strongHit) {
    return { matches: false, tokens, strategy: 'single-token', missingTokens, applicable: true };
  }

  if (hasClusterContext) {
    return {
      matches: true,
      tokens,
      strategy: 'single-token',
      missingTokens,
      applicable: true,
    };
  }

  // Tweet-only: reject unless every long (>=4 chars) token is present, which keeps a
  // half-invented name like "Fable 5.5 Supremum" from passing on one weak match.
  const longMissing = tokens.filter(
    (tok) => tok.length >= 4 && !haystacks.some((h) => h.includes(tok))
  );
  if (longMissing.length === 0) {
    return {
      matches: true,
      tokens,
      strategy: 'single-token',
      missingTokens,
      applicable: true,
    };
  }

  return { matches: false, tokens, strategy: 'single-token', missingTokens, applicable: true };
}