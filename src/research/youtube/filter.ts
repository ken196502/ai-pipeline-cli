/**
 * Deterministic candidate metric pre-filtering.
 *
 * Runs before LLM evaluation to eliminate candidates that do not meet
 * minimum baseline metrics (views, velocity, engagement, duration).
 */
import {
  DEFAULT_THRESHOLDS,
  type MetricFilterResult,
  type MetricThresholds,
  type VideoCandidate,
} from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';

export { DEFAULT_THRESHOLDS, type MetricThresholds };

/**
 * Evaluates a candidate against metric thresholds.
 * Returns a human-readable rejection reason string, or null if kept.
 */
export function rejectionReason(
  candidate: VideoCandidate,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS,
  nowOrOptions?: (() => Date) | { now?: () => Date },
): string | null {
  const m = candidate.metrics;
  if (m.durationSec < thresholds.minDurationSec) {
    return `duration ${m.durationSec}s below ${thresholds.minDurationSec}s`;
  }
  const publishedAtStr = m?.publishedAt || (candidate as any)?.publishedAt;
  if (publishedAtStr) {
    const publishedMs = new Date(publishedAtStr).getTime();
    if (!isNaN(publishedMs)) {
      const nowFn =
        typeof nowOrOptions === 'function'
          ? nowOrOptions
          : (nowOrOptions?.now ?? (() => new Date()));
      const nowMs = nowFn().getTime();
      const ageDays = (nowMs - publishedMs) / 86_400_000;
      if (ageDays > thresholds.maxAgeDays) {
        return `published ${Math.floor(ageDays)} days ago exceeds ${thresholds.maxAgeDays} days (older than half a year)`;
      }
    }
  }
  return null;
}

/**
 * Filters a list of candidates against metric thresholds.
 * Throws AppError(NO_ELIGIBLE_VIDEO) if all candidates are rejected.
 */
export function filterCandidates(
  candidates: readonly VideoCandidate[],
  query: string,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS,
  nowOrOptions?: (() => Date) | { now?: () => Date },
): MetricFilterResult {
  const kept: VideoCandidate[] = [];
  const rejected: Array<{ videoId: string; reason: string }> = [];

  for (const candidate of candidates) {
    const reason = rejectionReason(candidate, thresholds, nowOrOptions);
    if (reason) {
      rejected.push({ videoId: candidate.videoId, reason });
    } else {
      kept.push(candidate);
    }
  }

  if (kept.length === 0) {
    throw new AppError({
      code: ErrorCodes.NO_ELIGIBLE_VIDEO,
      message: `All ${candidates.length} candidates were rejected by metric thresholds`,
      stage: 'research',
      task: 'filter-metrics',
      retryable: false,
      cause: { query, total: candidates.length, rejected },
    });
  }

  return {
    query,
    thresholds,
    kept,
    rejected,
  };
}
