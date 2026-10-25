import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pipeline, Pipeline24hOptions, TopicScheduleState } from './contracts.js';
import { formatDurationMs } from '../../utils/time.js';

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_ERROR_COOLDOWN_MS = 60 * 1000; // 60 seconds

/**
 * Parses a semicolon-separated string (or string array) into a trimmed, non-empty list of unique topics.
 *
 * Example:
 *   parseTopics("AI; new model; deepseek r1 ; ") => ["AI", "new model", "deepseek r1"]
 *   parseTopics("") => []
 */
export function parseTopics(input?: string | string[] | null, defaultTopic?: string): string[] {
  if (!input) return defaultTopic ? [defaultTopic] : [];
  const rawList = Array.isArray(input) ? input : input.split(';');
  const cleaned = rawList.map((t) => t.trim()).filter((t) => t.length > 0);
  const unique = Array.from(new Set(cleaned));
  if (unique.length > 0) return unique;
  return defaultTopic ? [defaultTopic] : [];
}

/**
 * Sleeps for a given duration in milliseconds, immediately resolving if AbortSignal is triggered.
 * Returns true if aborted, false if sleep completed normally.
 */
export function interruptibleSleep(
  ms: number,
  signal?: AbortSignal,
  onTick?: (remainingMs: number) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);

    const checkIntervalMs = 60 * 1000; // check every minute if sleeping long
    const startTime = Date.now();
    const endTime = startTime + ms;

    let intervalTimer: NodeJS.Timeout | null = null;
    let mainTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (mainTimer) clearTimeout(mainTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve(true);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    if (ms > checkIntervalMs && onTick) {
      intervalTimer = setInterval(() => {
        const remaining = Math.max(0, endTime - Date.now());
        onTick(remaining);
      }, checkIntervalMs);
    }

    mainTimer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
  });
}

/**
 * Manages per-topic 24h run history and state persistence.
 */
export class ContinuousTopicScheduler {
  readonly topics: string[];
  readonly maxRunsPer24h: number;
  readonly windowMs: number;
  readonly stateFilePath?: string;

  private runs = new Map<string, number[]>();
  private lastIndex = 0;

  constructor(
    topics: string[],
    options?: {
      maxRunsPer24h?: number;
      windowMs?: number;
      stateFilePath?: string;
    }
  ) {
    if (!topics || topics.length === 0) {
      throw new Error('ContinuousTopicScheduler requires at least one topic');
    }
    this.topics = [...topics];
    this.maxRunsPer24h = Math.max(1, options?.maxRunsPer24h ?? 1);
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
    this.stateFilePath = options?.stateFilePath;
  }

  /**
   * Initializes scheduler, loading persistent state from disk if available.
   */
  async init(): Promise<void> {
    if (!this.stateFilePath) return;
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      const data: TopicScheduleState = JSON.parse(raw);
      if (data && typeof data === 'object' && data.topics) {
        const now = Date.now();
        for (const [topic, timestamps] of Object.entries(data.topics)) {
          if (Array.isArray(timestamps)) {
            // Keep only timestamps within the sliding 24-hour window
            const valid = timestamps.filter((t) => typeof t === 'number' && now - t < this.windowMs);
            this.runs.set(topic, valid);
          }
        }
        if (typeof data.lastRunIndex === 'number' && data.lastRunIndex >= 0) {
          this.lastIndex = data.lastRunIndex % this.topics.length;
        }
      }
    } catch {
      // File missing or invalid: start fresh
    }
  }

  /**
   * Returns valid run timestamps within the sliding window for a topic.
   */
  getRunsInWindow(topic: string, now = Date.now()): number[] {
    const list = this.runs.get(topic) || [];
    const valid = list.filter((t) => now - t < this.windowMs);
    this.runs.set(topic, valid);
    return valid;
  }

  /**
   * Checks whether the topic is allowed to run immediately based on 24h limit.
   */
  canRun(topic: string, now = Date.now()): boolean {
    return this.getRunsInWindow(topic, now).length < this.maxRunsPer24h;
  }

  /**
   * Returns milliseconds to wait before the topic can run again.
   * If topic can run now, returns 0.
   */
  getWaitTimeMs(topic: string, now = Date.now()): number {
    const windowRuns = this.getRunsInWindow(topic, now);
    if (windowRuns.length < this.maxRunsPer24h) {
      return 0;
    }
    // The run that must expire to free up a slot
    const blockingIndex = windowRuns.length - this.maxRunsPer24h;
    const oldestBlockingRun = windowRuns[blockingIndex];
    const readyAt = oldestBlockingRun + this.windowMs;
    return Math.max(1000, readyAt - now);
  }

  /**
   * Records a completed execution for a topic.
   */
  async recordRun(topic: string, timestamp = Date.now()): Promise<void> {
    const list = this.getRunsInWindow(topic, timestamp);
    list.push(timestamp);
    this.runs.set(topic, list);
    await this.persist();
  }

  getLastIndex(): number {
    return this.lastIndex;
  }

  async setLastIndex(index: number): Promise<void> {
    this.lastIndex = index % this.topics.length;
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.stateFilePath) return;
    try {
      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
      const record: Record<string, number[]> = {};
      for (const [t, ts] of this.runs.entries()) {
        record[t] = ts;
      }
      const state: TopicScheduleState = {
        version: 1,
        maxRunsPer24h: this.maxRunsPer24h,
        lastRunIndex: this.lastIndex,
        topics: record,
      };
      await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * Core 24-hour continuous runner implementation.
 *
 * Runs pipelines in a resilient, non-stop sequential loop:
 *   1. Iterates over topics sequentially (永不停止).
 *   2. Enforces per-topic 24-hour rate limit (maxRunsPer24h, default 1).
 *   3. If topic has reached limit, sleeps until its oldest run rolls out of the 24h window.
 *   4. Catches errors gracefully without stopping; notifies and continues to next topic.
 */
export async function runPipeline24h<TOptions = any, TResult = any>(
  options: Pipeline24hOptions<TOptions, TResult>
): Promise<void> {
  const topics = parseTopics(options.topics);
  if (topics.length === 0) {
    throw new Error('runPipeline24h requires at least one non-empty topic in options.topics');
  }
  const maxRuns = Math.max(1, options.maxRunsPer24h ?? 1);
  const errorCooldownMs = options.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS;
  const signal = options.signal;

  const scheduler = new ContinuousTopicScheduler(topics, {
    maxRunsPer24h: maxRuns,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    stateFilePath: options.stateFilePath,
  });
  await scheduler.init();

  let topicIndex = scheduler.getLastIndex();
  let roundIndex = 1;

  while (!signal?.aborted) {
    const topic = topics[topicIndex];
    const waitMs = scheduler.getWaitTimeMs(topic);

    if (waitMs > 0) {
      const runCount = scheduler.getRunsInWindow(topic).length;
      const reason = `Topic "${topic}" reached limit (${runCount}/${maxRuns} in 24h). Waiting ${formatDurationMs(waitMs)}...`;
      if (options.onSleep) {
        await options.onSleep(topic, waitMs, reason);
      }
      const aborted = await interruptibleSleep(waitMs, signal);
      if (aborted || signal?.aborted) break;
    }

    if (signal?.aborted) break;

    const currentRunsInWindow = scheduler.getRunsInWindow(topic).length;
    if (options.onRoundStart) {
      await options.onRoundStart(topic, roundIndex, currentRunsInWindow);
    }

    try {
      let result: TResult;
      if (options.executeFn) {
        result = await options.executeFn(topic, roundIndex);
      } else if (options.pipeline) {
        const opts = options.createOptions ? options.createOptions(topic) : ({ query: topic } as any);
        result = (await options.pipeline.execute(opts)) as TResult;
      } else {
        throw new Error('Pipeline24hRunner requires either executeFn or pipeline in options');
      }

      await scheduler.recordRun(topic);

      if (options.onRoundSuccess) {
        await options.onRoundSuccess(topic, result, roundIndex);
      }
    } catch (err: unknown) {
      if (options.onRoundError) {
        await options.onRoundError(topic, err, roundIndex);
      }

      // Cool down on error before proceeding to next topic to prevent CPU spin
      if (errorCooldownMs > 0 && !signal?.aborted) {
        await interruptibleSleep(errorCooldownMs, signal);
      }
    }

    if (signal?.aborted) break;

    // Advance to next topic in sequence
    topicIndex = (topicIndex + 1) % topics.length;
    await scheduler.setLastIndex(topicIndex);
    roundIndex++;
  }
}
