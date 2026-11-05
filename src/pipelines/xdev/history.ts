/**
 * Run history and deduplication for the xdev pipeline.
 *
 * Source of truth: REAL published articles on X (fetched directly from
 * https://x.com/compose/articles -> Published tab via `account-history.ts`).
 * We explicitly do not deduplicate against local artifacts/drafts to prevent
 * unpublished runs or failed tests from wrongly disqualifying fresh tweets.
 */

export interface XDevHistoryEntry {
  /** Article id or title identifier. */
  runId: string;
  /** Headline of the article published on X. */
  articleTitle?: string;
  /** Source tweet permalinks referenced in the published article. */
  tweetUrls: string[];
  /** Published article topic titles. */
  topicTitles: string[];
}

/** Extracts the numeric status id from an x.com/twitter.com permalink. */
export function tweetIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = /\/status(?:es)?\/(\d+)/.exec(url);
  return match ? match[1] : null;
}

export interface RepeatedTweet<T> {
  tweet: T;
  /** Run id in which this tweet was already used. */
  previousRunId: string;
  previousTopic?: string;
}

export interface HistorySplit<T> {
  fresh: T[];
  repeated: RepeatedTweet<T>[];
}

/**
 * Hard-filters out tweets that a previous run already wrote about.
 *
 * This is a programmatic guard, deliberately independent of the LLM: prompt
 * instructions alone had no effect (same tweet id selected 7 runs in a row).
 */
export function splitByHistory<T extends { url: string }>(
  tweets: T[],
  history: XDevHistoryEntry[]
): HistorySplit<T> {
  const used = new Map<string, { runId: string; topic?: string }>();
  for (const entry of history) {
    entry.tweetUrls.forEach((url, i) => {
      const id = tweetIdFromUrl(url);
      if (id && !used.has(id)) {
        used.set(id, { runId: entry.runId, topic: entry.topicTitles[i] });
      }
    });
  }

  const fresh: T[] = [];
  const repeated: RepeatedTweet<T>[] = [];

  for (const tweet of tweets) {
    const id = tweetIdFromUrl(tweet.url);
    const hit = id ? used.get(id) : undefined;
    if (hit) {
      repeated.push({ tweet, previousRunId: hit.runId, previousTopic: hit.topic });
    } else {
      fresh.push(tweet);
    }
  }

  return { fresh, repeated };
}

/** Compact, prompt-ready summary of what was already published. */
export function formatHistoryForPrompt(history: XDevHistoryEntry[], limit = 8): string {
  const lines: string[] = [];
  for (const entry of history.slice(0, limit)) {
    const title = entry.articleTitle ? `《${entry.articleTitle}》` : '(无标题记录)';
    const topics = entry.topicTitles.length ? entry.topicTitles.join(' / ') : '(无议题记录)';
    lines.push(`- [${entry.runId}] ${title} — 议题: ${topics}`);
  }
  return lines.length ? lines.join('\n') : '(无历史记录)';
}
