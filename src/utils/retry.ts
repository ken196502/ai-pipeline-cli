/**
 * Promise-based sleep and exponential backoff retry utility.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Number of additional attempts after the first one. */
  retries?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying immediately (e.g. 400/401/403 errors). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  retryDelayMs?: (error: unknown, attempt: number, defaultDelayMs: number) => number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const factor = options.factor ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === retries + 1;
      if (isLastAttempt || !shouldRetry(error, attempt)) break;
      const defaultDelayMs = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
      const requestedDelayMs = options.retryDelayMs?.(error, attempt, defaultDelayMs);
      const delayMs = Number.isFinite(requestedDelayMs)
        ? Math.max(0, Math.min(maxDelayMs, requestedDelayMs as number))
        : defaultDelayMs;
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
