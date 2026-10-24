/**
 * Internal utilities and helpers for FlowClient.
 */
import pc from 'picocolors';
import { isRiskControlError } from '../dom.js';

/** Returns a random integer between min and max (inclusive). */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Returns a random delay in ms between minSec and maxSec (seconds). */
export function randomDelay(minSec: number, maxSec: number): number {
  return randomInt(Math.round(minSec * 1000), Math.round(maxSec * 1000));
}

/** Sleeps for the specified milliseconds with an optional countdown log. */
export async function sleepWithLog(ms: number, label: string): Promise<void> {
  const totalSec = Math.round(ms / 1000);
  console.log(pc.gray(`[flow-cli] ${label}: waiting ${totalSec}s...`));
  const interval = 10_000; // log every 10s
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, interval);
    await new Promise((r) => setTimeout(r, chunk));
    remaining -= chunk;
    if (remaining > 0 && remaining % interval === 0) {
      console.log(pc.gray(`[flow-cli]   ...${Math.round(remaining / 1000)}s remaining`));
    }
  }
}

/** Checks if an error message indicates Google anti-abuse detection. */
export function isAntiAbuseError(errorMessage: string): boolean {
  return isRiskControlError(errorMessage);
}

/** Formats a signed credit delta, e.g. "-15" / "+0". */
export function formatCreditDelta(delta: number): string {
  return `${delta > 0 ? '+' : ''}${delta}`;
}
