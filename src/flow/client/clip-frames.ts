/**
 * 切分镜/cut step: generate video using Frames mode (Start Frame + End Frame).
 * NO right-click animate.
 * 1. Configures direct settings for video with Frames mode.
 * 2. Clicks Start frame trigger, selects the project start image.
 * 3. Clicks End frame trigger, selects the project end image.
 * 4. Fills visualPrompt, submits video generation, and downloads MP4.
 */
import path from 'node:path';
import pc from 'picocolors';
import { sanitizeVisualPromptForVideoEngine } from '../../research/script/shot-transition.js';
import type { QuotaSnapshot } from '../contracts.js';
import {
  approveGenerationModal,
  configureDirectGenerationSettings,
  disableAgentModeIfNeeded,
  dismissVideoPlayer,
  downloadVideoInPage,
  fillPromptInput,
  readActualFlowCredits,
  readFlowFailureState,
  selectProjectFrameAssetForSlot,
  submitPrompt,
  waitForEditor,
  waitForFramesControls,
  waitForGenerationQueued,
} from '../dom.js';
import { ensureFileDownloaded } from '../download.js';
import { FlowVideoObserver } from '../observer.js';
import { assertSufficientCredits, buildCreditSnapshot } from '../quota.js';
import { withProjectPage } from './project.js';
import type { ClientContext } from './types.js';
import { formatCreditDelta } from './utils.js';

export async function generateFramesVideo(
  ctx: ClientContext,
  opts: {
    label: string;
    startImage: { prompt: string; mediaKey: string | null };
    endImage: { prompt: string; mediaKey: string | null };
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
    return await withProjectPage(ctx, { ...opts, riskRetryLabel: `${opts.label} frames-video` }, async ({ page, projectId }) => {
      try {
        const creditsBefore = await readActualFlowCredits(page);
        console.log(pc.cyan(`[flow-cli] ${opts.label}: Flow credits before task: ${creditsBefore}`));
        assertSufficientCredits(creditsBefore, opts.label);

        await waitForEditor(page, 15_000);
        const failureBaseline = await readFlowFailureState(page);

        await disableAgentModeIfNeeded(page);
        const targetAspect = opts.aspect === 'portrait' ? '9:16' : '16:9';
        console.log(pc.cyan(`[flow-cli] ${opts.label}: Configuring video settings (Frames mode)...`));
        await configureDirectGenerationSettings(page, {
          mode: 'video',
          count: 1,
          durationSec: opts.duration,
          modelSuffix: 'frames',
          subMode: 'frames',
          aspectRatio: targetAspect,
        }).catch((e) => {
          console.warn(pc.yellow(`[flow-cli] Notice on direct settings: ${e.message}`));
        });
        // Fail fast (retryably) when the Frames controls never mounted — the
        // selector would otherwise fail with a cryptic DOM error.
        await waitForFramesControls(page, opts.label);

        // 1. Select Start frame image
        await selectProjectFrameAssetForSlot(page, 'start', {
          prompt: opts.startImage.prompt,
          mediaKey: opts.startImage.mediaKey,
          indexFromTop: 1,
        }, ctx.config.debugDir);
        await new Promise((r) => setTimeout(r, 1000));

        // 2. Select End frame image
        await selectProjectFrameAssetForSlot(page, 'end', {
          prompt: opts.endImage.prompt,
          mediaKey: opts.endImage.mediaKey,
          indexFromTop: 0,
        }, ctx.config.debugDir);
        await new Promise((r) => setTimeout(r, 1000));

        // 3. Fill visual prompt
        const cleanVisualPrompt = sanitizeVisualPromptForVideoEngine(opts.visualPrompt);
        console.log(pc.gray(`Video Prompt: "${cleanVisualPrompt.slice(0, 80)}..."`));
        await fillPromptInput(page, cleanVisualPrompt);
        await new Promise((r) => setTimeout(r, 1500));

        observer.reset();
        if (opts.knownVideoUrls?.length) {
          observer.recordExisting(opts.knownVideoUrls);
        }
        await observer.attach(page);
        await observer.markExistingMedia(page);
        if (opts.knownVideoUrls?.length) {
          observer.recordExisting(opts.knownVideoUrls);
        }

        console.log(pc.cyan(`[flow-cli] ${opts.label}: Submitting Frames video generation...`));
        await submitPrompt(page);
        await approveGenerationModal(page, 8_000).catch(() => {});
        await waitForGenerationQueued(page, 15_000, failureBaseline);
        console.log(pc.green(`✓ ${opts.label}: Frames video generation accepted. Awaiting synthesis...`));

        const videoUrl = await observer.waitForVideo(page, opts.timeoutMs ?? ctx.config.timeoutMs, { failureBaseline });
        console.log(pc.green(`✓ ${opts.label}: video URL: ${videoUrl}`));

        let finalOutputPath: string | null = null;
        let downloadError: string | null = null;
        if (opts.outputPath) {
          const target = path.resolve(opts.outputPath);
          try {
            const downloaded = await ensureFileDownloaded({
              url: videoUrl,
              outputPath: target,
              download: (u, p) => downloadVideoInPage(page, u, p),
            });
            finalOutputPath = downloaded.outputPath;
          } catch (e: any) {
            downloadError = e.message;
            console.error(pc.red(`✗ ${opts.label}: video generated but download failed: ${e.message}`));
          }
        }

        try {
          await dismissVideoPlayer(page).catch(() => {});
        } catch {}

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
        try {
          const creditsAfterFailure = await readActualFlowCredits(page);
          console.log(pc.yellow(`[flow-cli] ${opts.label}: Flow credits after failed task: ${creditsAfterFailure}`));
        } catch {}
        throw err;
      }
    });
  } finally {
    await observer.detach().catch(() => {});
  }
}
