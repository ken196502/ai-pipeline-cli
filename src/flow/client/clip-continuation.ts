/**
 * 连续 (continuous, non-cut) step — continue the SAME shot WITHOUT generating an
 * image: extract the LAST frame of the previous clip's downloaded video, upload it
 * as the starting frame of the next generation, then synthesize → download.
 *
 * The previous video's last frame is the only accepted continuation source — there
 * is deliberately NO image-generation fallback (plan-continuous-last-frame-video.md).
 */
import path from 'node:path';
import pc from 'picocolors';
import { extractLastFrame } from '../../research/media/frames.js';
import { sanitizeVisualPromptForVideoEngine } from '../../research/script/shot-transition.js';
import { FLOW_HOME_URL } from '../config.js';
import type { QuotaSnapshot } from '../contracts.js';
import {
  approveGenerationModal,
  attachImageToPrompt,
  captureEvidence,
  configureDirectGenerationSettings,
  disableAgentModeIfNeeded,
  dismissVideoPlayer,
  downloadVideoInPage,
  fillPromptInput,
  hasNewFlowFailure,
  isRiskControlError,
  readActualFlowCredits,
  readEditorText,
  readFlowFailureState,
  submitPrompt,
  waitForEditor,
  waitForGenerationQueued,
} from '../dom.js';
import { ensureFileDownloaded } from '../download.js';
import { FlowVideoObserver } from '../observer.js';
import { assertSufficientCredits, buildCreditSnapshot } from '../quota.js';
import { withProjectPage } from './project.js';
import type { ClientContext } from './types.js';
import { formatCreditDelta, randomDelay } from './utils.js';

export async function generateContinuationVideo(
  ctx: ClientContext,
  opts: {
    label: string;
    startFrameSourceVideo: string;
    startFramePath: string;
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
  startFramePath: string;
  quota: QuotaSnapshot;
  projectId: string;
}> {
  // 1. The previous clip's final frame becomes this clip's starting frame.
  console.log(
    pc.cyan(`[flow-cli] ${opts.label}: 连续/continuous — extracting the LAST frame of ${opts.startFrameSourceVideo}`)
  );
  const frame = await extractLastFrame(opts.startFrameSourceVideo, opts.startFramePath);
  console.log(
    pc.green(
      `✓ ${opts.label}: starting frame extracted → ${opts.startFramePath} (@ ${frame.timestampSec.toFixed(2)}s, ${frame.width}x${frame.height})`
    )
  );

  const observer = new FlowVideoObserver();
  // Share upload acceptance across generation retries and page refreshes.
  const startFrameUploadState = { submitted: false };
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

        const failureBaseline = await readFlowFailureState(page);

        // Direct video mode — no image card exists to Animate.
        await disableAgentModeIfNeeded(page);
        const targetModel = opts.model || 'lite';
        const targetAspect = opts.aspect === 'portrait' ? '9:16' : '16:9';
        await configureDirectGenerationSettings(page, {
          mode: 'video',
          count: 1,
          durationSec: opts.duration,
          modelSuffix: targetModel,
          aspectRatio: targetAspect,
        }).catch((e) => {
          console.warn(pc.yellow(`[flow-cli] Notice on direct settings: ${e.message}`));
        });

        // 1. Upload the extracted last frame as the starting frame FIRST.
        // Flow UI file upload / ingredient overlays reset the prompt input box, so frame attachment
        // must precede filling the prompt text.
        const attached = await attachImageToPrompt(page, opts.startFramePath, {
          evidenceDir: ctx.config.debugDir,
          uploadState: startFrameUploadState,
        });
        if (attached.imageChips === 0) {
          throw new Error(
            `${opts.label}: the starting frame did not land as an IMAGE ingredient ` +
              `(image chips: ${attached.imageChips}, video chips: ${attached.videoChips}) — ` +
              `refusing to generate without a proper start frame`
          );
        }
        console.log(
          pc.green(
            `✓ ${opts.label}: starting frame attached via ${attached.method} (attachments ${attached.attachmentsBefore} → ${attached.attachmentsAfter}, image chips: ${attached.imageChips})`
          )
        );
        await captureEvidence(page, '12c-start-frame-attached', ctx.config.debugDir);
        await new Promise((r) => setTimeout(r, randomDelay(1, 2)));

        // 2. Fill prompt input AFTER frame attachment so the prompt text remains in place.
        const cleanVisualPrompt = sanitizeVisualPromptForVideoEngine(opts.visualPrompt);
        console.log(pc.gray(`Video Prompt: "${cleanVisualPrompt.slice(0, 80)}${cleanVisualPrompt.length > 80 ? '...' : ''}"`));
        await fillPromptInput(page, cleanVisualPrompt);
        await captureEvidence(page, '12d-video-prompt-filled', ctx.config.debugDir);
        await new Promise((r) => setTimeout(r, randomDelay(1, 2)));

        // 3. Double-check that prompt text is populated; re-fill if needed
        const textInEditor = await readEditorText(page);
        if (!textInEditor.trim()) {
          console.warn(pc.yellow(`[flow-cli] ${opts.label}: prompt editor was empty after attachment — re-filling prompt input`));
          await fillPromptInput(page, cleanVisualPrompt);
        }

        observer.reset();
        if (opts.knownVideoUrls?.length) {
          observer.recordExisting(opts.knownVideoUrls);
        }
        await observer.attach(page);
        await observer.markExistingMedia(page);
        if (opts.knownVideoUrls?.length) {
          observer.recordExisting(opts.knownVideoUrls);
        }

        console.log(pc.cyan(`[flow-cli] ${opts.label}: submitting video continuation to Google Flow backend...`));
        const submitVia = await submitPrompt(page);
        console.log(pc.gray(`[flow-cli] ${opts.label}: video prompt submitted via ${submitVia}`));
        await captureEvidence(page, '12e-video-generate-clicked', ctx.config.debugDir);

        await approveGenerationModal(page, 8_000).catch(() => {});
        await waitForGenerationQueued(page, 15_000, failureBaseline).catch((err: any) => {
          if (isRiskControlError(err?.message || '')) throw err;
        });
        const submittedState = await readFlowFailureState(page);
        if (hasNewFlowFailure(submittedState, failureBaseline)) {
          throw new Error(
            `Google Flow canvas generation failed: ${submittedState.errorTileTexts[0] ?? 'We noticed some unusual activity. Please visit the Help Center for more information.'}`
          );
        }
        console.log(pc.green(`✓ ${opts.label}: video generation accepted by Flow backend. Awaiting MP4 synthesis...`));
        await captureEvidence(page, '12f-video-queued', ctx.config.debugDir);

        const videoUrl = await observer.waitForVideo(page, opts.timeoutMs ?? ctx.config.timeoutMs, { failureBaseline });
        console.log(pc.green(`✓ ${opts.label}: discovered signed Flow video URL: ${videoUrl.slice(0, 90)}...`));

        // 每生成一个视频就下载一次 — immediately, exactly once, verified.
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
            downloadError = e.message;
            console.error(pc.red(`✗ ${opts.label}: video generated but download failed: ${e.message}`));
          }
        }

        // Reset canvas for the next clip.
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
          startFramePath: opts.startFramePath,
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
