/**
 * Google Flow Module Script.
 * Automates Google Flow session management, workspace project resolution,
 * live credit-balance enforcement (flow.google.com avatar panel), video URL
 * sniffing, and batch video synthesis.
 */
import { FlowClient } from '../../flow/client.js';
import {
  assertSufficientCredits,
  buildCreditSnapshot,
} from '../../flow/quota.js';
import { VIDEO_CREDIT_COST } from '../../flow/config.js';
import { isFlowVideoUrl, isDemoVideo } from '../../flow/observer.js';

export { FlowClient };
export * from '../../flow/index.js';

/**
 * Self-test routine for the Flow Module.
 * Tests the live-credit quota helpers (snapshot building + sufficiency gate)
 * and the URL observer regex in isolation — no browser, no network.
 */
export async function testFlowModule(): Promise<{
  success: boolean;
  quotaTestPassed: boolean;
  observerTestPassed: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  let quotaTestPassed = false;
  try {
    // Snapshot building: live balance + per-task before/after delta.
    const snapshot = buildCreditSnapshot({ actualCredits: 500, creditsBefore: 520, creditsAfter: 500 });
    const snapshotOk =
      snapshot.actualCredits === 500 &&
      snapshot.creditsBefore === 520 &&
      snapshot.creditsAfter === 500 &&
      snapshot.costPerVideo === VIDEO_CREDIT_COST &&
      typeof snapshot.date === 'string' && snapshot.date.length === 10;

    // Sufficiency gate: passes at exactly the cost, refuses anything below.
    assertSufficientCredits(VIDEO_CREDIT_COST, 'self-test');
    let refused = false;
    try {
      assertSufficientCredits(VIDEO_CREDIT_COST - 1, 'self-test');
    } catch {
      refused = true;
    }

    quotaTestPassed = snapshotOk && refused;
    if (!quotaTestPassed) {
      errors.push('Live-credit quota helper test failed (snapshot building or sufficiency gate)');
    }
  } catch (err: any) {
    errors.push(`Live-credit quota helper test failed: ${err.message}`);
  }

  const sampleUrl = 'https://storage.googleapis.com/ai-sandbox-videofx/clip_123.mp4';
  const isVideo = isFlowVideoUrl(sampleUrl);
  const isDemo = isDemoVideo(sampleUrl);
  const observerTestPassed = isVideo && !isDemo;

  if (!observerTestPassed) {
    errors.push('Flow video URL validation or demo filtering test failed');
  }

  return {
    success: errors.length === 0,
    quotaTestPassed,
    observerTestPassed,
    errors,
  };
}
