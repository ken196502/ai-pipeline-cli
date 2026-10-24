/**
 * Phase 2 step — right-click ONE specific image card (matched by card identity and
 * aim-verified before the click, so a video card can never be hit) → "Animate" →
 * video prompt → MP4 synthesis → download → canvas reset for the next clip.
 */
import path from 'node:path';
import pc from 'picocolors';
import { sanitizeVisualPromptForVideoEngine } from '../../research/script/shot-transition.js';
import { FLOW_HOME_URL } from '../config.js';
import type { QuotaSnapshot } from '../contracts.js';
import {
  approveGenerationModal,
  captureEvidence,
  clickAnimateMenuItem,
  configureDirectGenerationSettings,
  dismissVideoPlayer,
  downloadVideoInPage,
  fillPromptInput,
  hasNewFlowFailure,
  isRiskControlError,
  readActualFlowCredits,
  readFlowFailureState,
  rightClickImageTile,
  scrollToBottomToLoadAll,
  submitPrompt,
  waitForAnimateEditor,
  waitForEditor,
  waitForGenerationQueued,
} from '../dom.js';
import { ensureFileDownloaded } from '../download.js';
import { FlowVideoObserver } from '../observer.js';
import { assertSufficientCredits, buildCreditSnapshot } from '../quota.js';
import { withProjectPage } from './project.js';
import type { ClientContext } from './types.js';
import { formatCreditDelta, randomDelay } from './utils.js';

export async function animateClipImage(
  ctx: ClientContext,
  opts: {
    label: string;
    mediaKey: string | null;
    mediaSrc?: string | null;
    visualPrompt: string;
    duration: 4 | 6 | 8 | 10;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    model?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    timeoutMs?: number;
    knownVideoUrls?: string[];
  }
): Promise<{
  videoUrl: string;
  outputPath: string | null;
  downloadError?: string | null;
  quota: QuotaSnapshot;
  projectId: string;
}> {
  const observer = new FlowVideoObserver();
  try {
    return await withProjectPage(ctx, { ...opts, riskRetryLabel: `${opts.label} video` }, async ({ page, projectId }) => {
      try {
        // Real-credit pre-flight: live balance from the top-right avatar panel
        // (Account details → credits-count). Below VIDEO_CREDIT_COST → abort
        // before anything is submitted. See plan-flow-real-credits-limit.md.
        const creditsBefore = await readActualFlowCredits(page);
        console.log(pc.cyan(`[flow-cli] ${opts.label}: Flow credits before task: ${creditsBefore}`));
        assertSufficientCredits(creditsBefore, opts.label);

        await waitForEditor(page, 15_000);

        // Failure-state baseline: only failures that appear AFTER this attempt may
        // abort it — stale risk tiles are cleared by the per-attempt page refresh.
        const failureBaseline = await readFlowFailureState(page);

        // Load every canvas card first — after the per-attempt refresh the tiles
        // are still rendering and the target image card must be on the canvas
        // before the identity-matched right-click.
        await scrollToBottomToLoadAll(page, { maxScrolls: 10, timeoutMs: 8_000 }).catch(() => {});

        if (!opts.mediaKey && !opts.mediaSrc) {
          throw new Error(
            `Cannot animate ${opts.label}: no image card identity (key/src) was recorded. ` +
            `Re-run the image phase first.`
          );
        }

        // Right-click the exact image card of this clip (identity-matched + aim-verified).
        console.log(pc.cyan(`[flow-cli] ${opts.label}: right-clicking image card "${opts.mediaKey || opts.mediaSrc}" to animate video...`));
        await rightClickImageTile(page, undefined, {
          expect: 'image',
          matchKey: opts.mediaKey ?? null,
          matchSrc: opts.mediaSrc ?? null,
        });
        await captureEvidence(page, '05-tile-right-clicked', ctx.config.debugDir);

        await clickAnimateMenuItem(page, 10_000);
        await captureEvidence(page, '06-animate-menu-clicked', ctx.config.debugDir);

        await waitForAnimateEditor(page, 15_000);
        console.log(pc.green(`✓ ${opts.label}: switched to video animation mode.`));
        await captureEvidence(page, '07-video-editor-ready', ctx.config.debugDir);

        const targetModel = opts.model || 'lite';
        const targetAspect = opts.aspect === 'portrait' ? '9:16' : '16:9';
        await configureDirectGenerationSettings(page, {
          mode: 'video',
          count: 1,
          durationSec: opts.duration,
          modelSuffix: targetModel,
          aspectRatio: targetAspect,
        }).catch(() => {});

        const cleanVisualPrompt = sanitizeVisualPromptForVideoEngine(opts.visualPrompt);
        console.log(pc.gray(`Video Prompt: "${cleanVisualPrompt.slice(0, 80)}${cleanVisualPrompt.length > 80 ? '...' : ''}"`));

        // Human-like delay before typing video prompt
        await new Promise((r) => setTimeout(r, randomDelay(2, 4)));

        await fillPromptInput(page, cleanVisualPrompt);
        await captureEvidence(page, '08-video-prompt-filled', ctx.config.debugDir);

        // Attach observer before clicking generate (fresh state per retry attempt)
        observer.reset();
        if (opts.knownVideoUrls?.length) {
          observer.recordExisting(opts.knownVideoUrls);
        }
        await observer.attach(page);
        await observer.markExistingMedia(page);
        if (opts.knownVideoUrls?.length) {
          observer.recordExisting(opts.knownVideoUrls);
        }

        // Human-like delay before submitting the video prompt
        await new Promise((r) => setTimeout(r, randomDelay(1, 3)));

        console.log(pc.cyan(`[flow-cli] ${opts.label}: submitting video animation to Google Flow backend...`));
        const submitVia = await submitPrompt(page);
        console.log(pc.gray(`[flow-cli] ${opts.label}: video prompt submitted via ${submitVia}`));
        await captureEvidence(page, '09-video-generate-clicked', ctx.config.debugDir);

        await approveGenerationModal(page, 8_000).catch(() => {});
        await waitForGenerationQueued(page, 15_000, failureBaseline).catch((err: any) => {
          // Risk-control rejections must reach the retry loop immediately.
          if (isRiskControlError(err?.message || '')) throw err;
        });
        const submittedState = await readFlowFailureState(page);
        if (hasNewFlowFailure(submittedState, failureBaseline)) {
          // Rejected on submission — nothing was charged, retry the gesture.
          throw new Error(
            `Google Flow canvas generation failed: ${submittedState.errorTileTexts[0] ?? 'We noticed some unusual activity. Please visit the Help Center for more information.'}`
          );
        }
        console.log(pc.green(`✓ ${opts.label}: video generation accepted by Flow backend. Awaiting MP4 synthesis...`));
        await captureEvidence(page, '10-video-queued', ctx.config.debugDir);

        const videoUrl = await observer.waitForVideo(page, opts.timeoutMs ?? ctx.config.timeoutMs, { failureBaseline });
        console.log(pc.green(`✓ ${opts.label}: discovered signed Flow video URL: ${videoUrl.slice(0, 90)}...`));
        await captureEvidence(page, '11-video-ready', ctx.config.debugDir);

        // 每生成一个视频就下载一次：download the freshly synthesized MP4 immediately,
        // exactly once (a verified file on disk is never fetched again) and verified
        // (half-written / error payloads are deleted and retried).
        let finalOutputPath: string | null = null;
        let downloadError: string | null = null;
        if (opts.outputPath) {
          const target = path.resolve(opts.outputPath);
          console.log(pc.cyan(`[flow-cli] ${opts.label}: downloading authenticated MP4 to: ${target}`));
          try {
            const downloaded = await ensureFileDownloaded({
              url: videoUrl,
              outputPath: target,
              download: (u, p) => downloadVideoInPage(page, u, p),
            });
            finalOutputPath = downloaded.outputPath;
            if (downloaded.alreadyPresent) {
              console.log(pc.green(`✓ ${opts.label}: video already downloaded once — skipping re-download (${downloaded.bytes} bytes)`));
            } else {
              console.log(pc.green(`✓ ${opts.label}: video downloaded once → ${downloaded.outputPath} (${downloaded.bytes} bytes)`));
            }
          } catch (e: any) {
            // The video WAS generated — keep its URL so it can be fetched manually,
            // but never pretend the local file exists.
            downloadError = e.message;
            console.error(pc.red(`✗ ${opts.label}: video generated but download failed: ${e.message}`));
          }
        }

        // Reset canvas: dismiss the video player and re-open the project URL so the
        // next clip's image card is reachable on the canvas again.
        try {
          await dismissVideoPlayer(page).catch(() => {});
          const resetUrl = projectId ? `${FLOW_HOME_URL}/project/${projectId}` : FLOW_HOME_URL;
          await page.goto(resetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await new Promise((r) => setTimeout(r, randomDelay(3, 5)));
          await waitForEditor(page, 15_000).catch(() => {
            console.warn(pc.yellow('[flow-cli] Editor not detected after canvas reset — will retry on next clip'));
          });
          console.log(pc.green('[flow-cli] ✓ Canvas reset for next clip'));
        } catch (e: any) {
          console.warn(pc.yellow(`[flow-cli] Could not reset canvas: ${e.message}`));
        }

        // Real-credit post-check: log the live balance after the task.
        const creditsAfter = await readActualFlowCredits(page);
        console.log(
          pc.green(`✓ ${opts.label}: Flow credits after task: ${creditsAfter} (Δ ${formatCreditDelta(creditsAfter - creditsBefore)})`)
        );

        return {
          videoUrl,
          outputPath: finalOutputPath,
          downloadError,
          quota: buildCreditSnapshot({ actualCredits: creditsAfter, creditsBefore, creditsAfter }),
          projectId,
        };
      } catch (err: any) {
        await captureEvidence(page, 'generation-failure', ctx.config.debugDir);
        // Best-effort after-failure credit log — must never mask the original error.
        try {
          const creditsAfterFailure = await readActualFlowCredits(page);
          console.log(pc.yellow(`[flow-cli] ${opts.label}: Flow credits after failed task: ${creditsAfterFailure}`));
        } catch (readErr: any) {
          console.warn(pc.yellow(`[flow-cli] ${opts.label}: could not read credits after failure: ${readErr.message}`));
        }
        throw err;
      }
    });
  } finally {
    await observer.detach().catch(() => {});
  }
}
