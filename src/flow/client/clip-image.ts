/**
 * Phase 1 step — generate one keyframe image card on the Flow canvas.
 */
import path from 'node:path';
import pc from 'picocolors';
import {
  approveGenerationModal,
  captureEvidence,
  clearExistingIngredientChips,
  clickAddToPromptMenuItem,
  configureDirectGenerationSettings,
  disableAgentModeIfNeeded,
  downloadImage,
  fillPromptInput,
  getImageTiles,
  isRiskControlError,
  readFlowFailureState,
  rightClickImageTile,
  scrollToBottomToLoadAll,
  submitPrompt,
  waitForEditor,
  waitForGenerationQueued,
  waitForNewImageTile,
} from '../dom.js';
import { ensureFileDownloaded } from '../download.js';
import { withProjectPage } from './project.js';
import type { ClientContext, ClipImageResult } from './types.js';
import { randomDelay } from './utils.js';

/**
 * Chooses the right-click target for a previous-image reference.
 *
 * `referenceKey` is only a valid target when it is a token actually mounted on the
 * canvas. A `file:<sha1>` content identity has no canvas token, so fall back to the
 * recorded URL (`referenceSrc`), which matches the card's `<img src>` even for proxied
 * `/asb/…` URLs. Exported for unit testing.
 */
export function resolveReferenceTarget(params: {
  canvasKeys: ReadonlySet<string>;
  referenceKey?: string | null;
  referenceSrc?: string | null;
}): { matchKey: string | null; matchSrc: string | null } {
  const matchKey =
    params.referenceKey && params.canvasKeys.has(params.referenceKey) ? params.referenceKey : null;
  const matchSrc = !matchKey && params.referenceSrc ? params.referenceSrc : null;
  return { matchKey, matchSrc };
}

export async function generateClipImage(
  ctx: ClientContext,
  opts: {
    label: string;
    imagePrompt: string;
    imageOutputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    model?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    timeoutMs?: number;
    referencePreviousImage?: boolean;
    /**
     * Optional pre-existing media keys / tokens to explicitly exclude from matching.
     * Prevents end-image from mistakenly resolving to the start-image tile if the canvas
     * virtualization hadn't indexed it during baseline.
     */
    excludeKeys?: Array<string | null | undefined> | Set<string>;
    /** Identity of the previous clip's image card to reference (falls back to the latest image card). */
    referenceKey?: string | null;
    /**
     * URL of the previous clip's image card. Used as a right-click target when
     * `referenceKey` is a content-hash identity (`file:<sha1>`) that has no canvas
     * token — the card's `<img src>` is the only reliable handle in that case.
     */
    referenceSrc?: string | null;
    /**
     * 'required' — 连续 (continuous) clips: losing the reference breaks the seamless
     *             continuation with the previous shot → loud warning.
     * 'optional' — 切分镜 (cut) clips: the reference only serves character/style
     *             consistency → informational note when unavailable.
     */
    referenceMode?: 'required' | 'optional';
  }
): Promise<ClipImageResult> {
  console.log(pc.cyan(`[flow-cli] ${opts.label}: generating keyframe image...`));
  console.log(pc.gray(`Image Prompt: "${opts.imagePrompt.slice(0, 80)}${opts.imagePrompt.length > 80 ? '...' : ''}"`));

  return await withProjectPage(ctx, { ...opts, riskRetryLabel: `${opts.label} image` }, async ({ page }) => {
    try {
      await waitForEditor(page, 30_000);
      await captureEvidence(page, '01-image-editor-ready', ctx.config.debugDir);

      // Failure-state baseline: only failures that appear AFTER this attempt may
      // abort it — stale risk tiles are cleared by the per-attempt page refresh.
      const failureBaseline = await readFlowFailureState(page);

      // Baseline by identity: every image card currently on the canvas.
      await scrollToBottomToLoadAll(page, { maxScrolls: 10, timeoutMs: 8_000 }).catch(() => {});
      const imageTiles = await getImageTiles(page);
      // Keys that are ACTUALLY mounted on the canvas right now — the only valid
      // right-click targets. A clip's stable identity (`file:<sha1>` content hash,
      // used when the src is a proxied /asb/ URL with no UUID) is deliberately NOT a
      // canvas key; treating it as one made the reference step target a card that can
      // never exist (recurring "could not aim at image card file:<sha1>").
      const canvasKeys = new Set(
        imageTiles.flatMap((t) => [t.key, t.src, t.mediaId]).filter((k): k is string => !!k)
      );
      // Identity baseline for NEW-card detection: canvas keys plus caller excludes
      // plus the recorded reference (so the reference is never mistaken for fresh).
      const knownImageKeys = new Set(canvasKeys);

      // Add caller-provided excluded keys into baseline so they are never returned as fresh
      if (opts.excludeKeys) {
        for (const k of opts.excludeKeys) {
          if (k) knownImageKeys.add(k);
        }
      }
      if (opts.referenceKey) {
        knownImageKeys.add(opts.referenceKey);
      }

      console.log(pc.gray(`[flow-cli] ${opts.label}: baseline image cards on canvas: ${imageTiles.length} (${knownImageKeys.size} known keys)`));

      // Human-like pre-interaction delay (simulate reading/thinking)
      await new Promise((r) => setTimeout(r, randomDelay(1.5, 3)));

      // Reference the previous IMAGE card: right-click → "Add to prompt".
      // The reference card is chosen by identity when the caller recorded the previous
      // clip's image card (referenceKey), otherwise the latest image card is used.
      const referenceMode = opts.referenceMode ?? 'optional';
      if (opts.referencePreviousImage !== false) {
        if (knownImageKeys.size === 0) {
          const msg =
            referenceMode === 'required'
              ? `${opts.label}: [连续/continuous] no image card is available to reference — the seamless continuation with the previous shot CANNOT be guaranteed`
              : `${opts.label}: [切分镜/cut] no previous image card to reference — generating the new shot without a visual reference`;
          if (referenceMode === 'required') {
            console.warn(pc.yellow(`⚠ ${msg}`));
          } else {
            console.log(pc.gray(msg));
          }
        } else {
          // Validate against the CANVAS keys, not the (reference-polluted) baseline.
          const { matchKey, matchSrc } = resolveReferenceTarget({
            canvasKeys,
            referenceKey: opts.referenceKey,
            referenceSrc: opts.referenceSrc,
          });
          if (opts.referenceKey && !matchKey && !matchSrc) {
            console.warn(
              pc.yellow(
                `${opts.label}: recorded image card "${opts.referenceKey}" is no longer an image card on the canvas (likely animated to video) — falling back to the latest image card`
              )
            );
          }
          console.log(
            pc.cyan(
              `[flow-cli] ${opts.label}: referencing ${
                matchKey ? `image card "${matchKey}"` : matchSrc ? 'image card by src' : 'the latest image card'
              } via "Add to prompt" for consistency...`
            )
          );
          await clearExistingIngredientChips(page).catch(() => {});
          await rightClickImageTile(page, undefined, { expect: 'image', matchKey, matchSrc });
          await captureEvidence(page, '01b-previous-image-right-clicked', ctx.config.debugDir);
          await clickAddToPromptMenuItem(page, 10_000);
          await captureEvidence(page, '01c-added-to-prompt', ctx.config.debugDir);
          await new Promise((r) => setTimeout(r, randomDelay(1, 2)));
        }
      }

      // Configure direct canvas settings (mode: image, x1, model, aspect).
      const targetModel = opts.model || 'lite';
      const targetAspect = opts.aspect === 'portrait' ? '9:16' : '16:9';
      console.log(pc.cyan(`[flow-cli] ${opts.label}: configuring direct canvas settings (mode: image, x1, model: *${targetModel}, aspect: ${targetAspect})...`));
      await disableAgentModeIfNeeded(page);
      const configured = await configureDirectGenerationSettings(page, {
        mode: 'image',
        count: 1,
        modelSuffix: targetModel,
        aspectRatio: targetAspect,
      }).catch((e) => {
        console.warn(pc.yellow(`[flow-cli] Notice on direct settings: ${e.message}`));
        return { mode: 'image', count: 1, summary: '' };
      });
      if (configured.summary) {
        console.log(pc.green(`✓ Flow direct canvas configured: ${configured.summary}`));
      }

      // Human-like delay before typing prompt
      await new Promise((r) => setTimeout(r, randomDelay(2, 4)));

      await fillPromptInput(page, opts.imagePrompt);
      await captureEvidence(page, '02-image-prompt-filled', ctx.config.debugDir);

      // Human-like delay before submitting
      await new Promise((r) => setTimeout(r, randomDelay(1, 2.5)));

      console.log(pc.cyan(`[flow-cli] ${opts.label}: submitting image generation request via Enter...`));
      const submitVia = await submitPrompt(page);
      console.log(pc.gray(`[flow-cli] ${opts.label}: image prompt submitted via ${submitVia}`));
      await captureEvidence(page, '03-image-generate-clicked', ctx.config.debugDir);

      await approveGenerationModal(page, 8_000).catch(() => {});
      await waitForGenerationQueued(page, 15_000, failureBaseline).catch((err: any) => {
        // Risk-control rejections must reach the retry loop immediately.
        if (isRiskControlError(err?.message || '')) throw err;
      });
      console.log(pc.green(`✓ ${opts.label}: image generation queued. Awaiting synthesis...`));

      // Wait for the NEW image card by identity (video cards are never returned).
      const newTile = await waitForNewImageTile(page, knownImageKeys, opts.timeoutMs ?? 120_000, failureBaseline);
      console.log(pc.green(`✓ ${opts.label}: new image card created on canvas`));
      await captureEvidence(page, '04-image-tile-ready', ctx.config.debugDir);

      let finalImageOutputPath: string | null = null;
      if (opts.imageOutputPath && newTile.src) {
        const target = path.resolve(opts.imageOutputPath);
        console.log(pc.cyan(`[flow-cli] ${opts.label}: downloading keyframe image to: ${target}`));
        try {
          const downloaded = await ensureFileDownloaded({
            url: newTile.src,
            outputPath: target,
            download: (u, p) => downloadImage(page, u, p),
          });
          finalImageOutputPath = downloaded.outputPath;
          console.log(
            pc.green(
              `✓ ${opts.label}: keyframe image ${downloaded.alreadyPresent ? 'already downloaded once — skipping re-download' : 'downloaded once'} → ${downloaded.outputPath} (${downloaded.bytes} bytes)`
            )
          );
        } catch (e: any) {
          // Never record a local path for a file that is not really on disk.
          console.warn(pc.yellow(`[flow-cli] Warning: Could not download keyframe image: ${e.message}`));
        }
      }

      return {
        mediaKey: newTile.key ?? null,
        mediaId: newTile.mediaId ?? null,
        imageUrl: newTile.src ?? null,
        imageOutputPath: finalImageOutputPath,
      };
    } catch (err: any) {
      await captureEvidence(page, 'image-generation-failure', ctx.config.debugDir);
      throw err;
    }
  });
}
