/**
 * Run history for the xdev pipeline.
 *
 * Why: the LLM reviewer only ever saw the CURRENT candidate list, so the same
 * two tweets got re-selected run after run (verified: the same /status/<id>
 * appeared in 7 consecutive `xdev-summary-*.json` files). Topic selection needs
 * to know what has already been written, and repeated tweets must be dropped
 * programmatically — not merely discouraged in a prompt.
 *
 * Source of truth: the pipeline's own `xdev-summary-<ts>.json` artifacts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface XDevHistoryEntry {
  /** Artifact timestamp, e.g. `2026-11-01T04-31-25-888Z`. */
  runId: string;
  /** Headline of the article produced by that run (absent in older runs). */
  articleTitle?: string;
  /** Selected tweet permalinks. */
  tweetUrls: string[];
  /** Selected topic titles (the angle that was written). */
  topicTitles: string[];
}

/** Extracts the numeric status id from an x.com/twitter.com permalink. */
export function tweetIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const match = /\/status(?:es)?\/(\d+)/.exec(url);
  return match ? match[1] : null;
}

/**
 * Loads the most recent runs, newest first. Corrupt or partial summaries are
 * skipped (they must never break a run), but every skipped file is reported.
 *
 * Summaries live in per-run subdirectories (`<baseDir>/<runTimestamp>/`).
 * Top-level summaries from the old flat layout are still read so nothing
 * disappears from the history.
 */
export async function loadXDevHistory(baseDir: string, limit = 8): Promise<XDevHistoryEntry[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /^xdev-summary-.*\.json$/.test(entry.name)) {
      candidates.push(path.join(baseDir, entry.name));
    } else if (entry.isDirectory()) {
      const inner = await fs.readdir(path.join(baseDir, entry.name)).catch(() => [] as string[]);
      for (const name of inner) {
        if (/^xdev-summary-.*\.json$/.test(name)) candidates.push(path.join(baseDir, entry.name, name));
      }
    }
  }

  const summaries = candidates.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  const history: XDevHistoryEntry[] = [];
  for (const file of summaries) {
    if (history.length >= limit) break;
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const selected = Array.isArray(parsed.selectedTopics) ? parsed.selectedTopics : [];
      history.push({
        runId: path.basename(file).replace(/^xdev-summary-/, '').replace(/\.json$/, ''),
        articleTitle: typeof parsed.articleTitle === 'string' ? parsed.articleTitle : undefined,
        tweetUrls: selected.map((s: any) => s?.tweetUrl).filter((u: any) => typeof u === 'string'),
        topicTitles: selected.map((s: any) => s?.topic).filter((t: any) => typeof t === 'string'),
      });
    } catch (err: any) {
      console.warn(`[history] skipping unreadable summary ${file}: ${err?.message || err}`);
    }
  }
  return history;
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
