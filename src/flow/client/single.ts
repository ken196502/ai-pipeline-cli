/**
 * Standalone single generation functions (generateVideo, generateImage).
 */
import path from 'node:path';
import pc from 'picocolors';
import { launchBrowser, releaseBrowser } from '../../browser/index.js';
import { FLOW_HOME_URL } from '../config.js';
import {
  type GenerateImageOptions,
  GenerateImageOptionsSchema,
  type GenerateImageResult,
  type GenerateOptions,
  GenerateOptionsSchema,
  type GenerationResult,
} from '../contracts.js';
import {
  approveGenerationModal,
  captureEvidence,
  clearExistingIngredientChips,
  clickAddToPromptMenuItem,
  configureDirectGenerationSettings,
  countImageTiles,
  createNewProject,
  disableAgentModeIfNeeded,
  downloadImage,
  extractProjectId,
  fillPromptInput,
  hasSignInPrompt,
  isProjectNotFound,
  isRiskControlError,
  readFlowFailureState,
  rightClickImageTile,
  scrollToBottomToLoadAll,
  scrollToDisplayAllProjects,
  submitPrompt,
  waitForEditor,
  waitForGenerationQueued,
  waitForNewImageTile,
  withRiskControlRetry,
} from '../dom.js';
import { resolveMediaKey } from '../duplicate-guard.js';
import { animateClipImage } from './clip-animate.js';
import { generateFramesVideo } from './clip-frames.js';
import { generateClipImage } from './clip-image.js';
import type { ClientContext } from './types.js';
import { randomDelay } from './utils.js';

/**
 * Generates a video from a prompt on Google Flow (single-clip convenience wrapper
 * around the two-phase steps: keyframe image → Animate → video).
 */
export async function generateVideo(
  ctx: ClientContext,
  rawOptions: GenerateOptions
): Promise<GenerationResult> {
  const options = GenerateOptionsSchema.parse(rawOptions);
  const effectiveImagePrompt = (options.imagePrompt && options.imagePrompt.trim().length > 0)
    ? options.imagePrompt.trim()
    : options.prompt.trim();

  if (options.endImagePrompt?.trim()) {
    console.log(pc.cyan(`\n[flow-cli] Step 1/3: Generating Start keyframe image...`));
    const startImage = await generateClipImage(ctx, {
      label: 'clip-start',
      imagePrompt: effectiveImagePrompt,
      imageOutputPath: options.imageOutputPath,
      projectId: options.projectId,
      aspect: options.aspect,
      headed: options.headed,
      viewport: options.viewport,
      profileDir: options.profileDir,
      dataDir: options.dataDir,
      referencePreviousImage: false,
    });

    console.log(pc.cyan(`\n[flow-cli] Step 2/3: Generating End keyframe image...`));
    const endImage = await generateClipImage(ctx, {
      label: 'clip-end',
      imagePrompt: options.endImagePrompt.trim(),
      imageOutputPath: options.endImageOutputPath,
      projectId: options.projectId,
      aspect: options.aspect,
      headed: options.headed,
      viewport: options.viewport,
      profileDir: options.profileDir,
      dataDir: options.dataDir,
      referencePreviousImage: true,
      referenceKey: startImage.mediaKey,
      referenceSrc: startImage.imageUrl ?? null,
      excludeKeys: [startImage.mediaKey, startImage.imageUrl, startImage.mediaId],
    });

    console.log(pc.cyan(`\n[flow-cli] Step 3/3: Generating Frames video (NO right-click animate)...`));
    const video = await generateFramesVideo(ctx, {
      label: 'clip',
      // Truthful identities: src UUID, else downloaded-file content hash.
      startImage: { prompt: effectiveImagePrompt, mediaKey: await resolveMediaKey(startImage.imageUrl, startImage.imageOutputPath, startImage.mediaKey) },
      endImage: { prompt: options.endImagePrompt.trim(), mediaKey: await resolveMediaKey(endImage.imageUrl, endImage.imageOutputPath, endImage.mediaKey) },
      visualPrompt: options.prompt,
      duration: options.duration,
      outputPath: options.outputPath,
      projectId: options.projectId,
      aspect: options.aspect,
      headed: options.headed,
      viewport: options.viewport,
      profileDir: options.profileDir,
      dataDir: options.dataDir,
      timeoutMs: options.timeoutMs,
    });

    if (video.downloadError) {
      throw new Error(
        `Video was generated (${video.videoUrl}) but could not be downloaded: ${video.downloadError}`
      );
    }

    return {
      project: {
        projectId: video.projectId,
        url: video.projectId ? `${FLOW_HOME_URL}/project/${video.projectId}` : '',
      },
      quota: video.quota,
      videoUrl: video.videoUrl,
      outputPath: video.outputPath,
      imageUrl: startImage.imageUrl,
      imageOutputPath: startImage.imageOutputPath,
      durationSec: options.duration,
      prompt: options.prompt,
      model: 'frames',
      createdAt: new Date().toISOString(),
    };
  }

  console.log(pc.cyan(`\n[flow-cli] Step 1/2: Generating starting keyframe image on Flow canvas...`));

  const image = await generateClipImage(ctx, {
    label: 'clip',
    imagePrompt: effectiveImagePrompt,
    imageOutputPath: options.imageOutputPath,
    projectId: options.projectId,
    aspect: options.aspect,
    headed: options.headed,
    viewport: options.viewport,
    profileDir: options.profileDir,
    dataDir: options.dataDir,
    referencePreviousImage: true,
  });

  console.log(pc.cyan(`[flow-cli] Step 2/2: Right-clicking image tile to animate video...`));

  const video = await animateClipImage(ctx, {
    label: 'clip',
    mediaKey: image.mediaKey,
    mediaSrc: image.imageUrl,
    visualPrompt: options.prompt,
    duration: options.duration,
    outputPath: options.outputPath,
    projectId: options.projectId,
    aspect: options.aspect,
    headed: options.headed,
    viewport: options.viewport,
    profileDir: options.profileDir,
    dataDir: options.dataDir,
    timeoutMs: options.timeoutMs,
  });

  if (video.downloadError) {
    throw new Error(
      `Video was generated (${video.videoUrl}) but could not be downloaded: ${video.downloadError}`
    );
  }

  return {
    project: {
      projectId: video.projectId,
      url: video.projectId ? `${FLOW_HOME_URL}/project/${video.projectId}` : '',
    },
    quota: video.quota,
    videoUrl: video.videoUrl,
    outputPath: video.outputPath,
    imageUrl: image.imageUrl,
    imageOutputPath: image.imageOutputPath,
    durationSec: options.duration,
    prompt: options.prompt,
    model: options.model,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generates an image from a text prompt on Google Flow.
 * Returns the generated image URL and optional local download path.
 */
export async function generateImage(
  ctx: ClientContext,
  rawOptions: GenerateImageOptions
): Promise<GenerateImageResult> {
  const options = GenerateImageOptionsSchema.parse(rawOptions);
  const profileDir = options.profileDir ? path.resolve(options.profileDir) : ctx.config.profileDir;

  console.log(pc.cyan(`\n[flow-cli] Generating image from text prompt...`));
  console.log(pc.gray(`Prompt: "${options.prompt.slice(0, 80)}${options.prompt.length > 80 ? '...' : ''}"`));

  const targetUrl = options.projectId
    ? `${FLOW_HOME_URL}/project/${options.projectId}`
    : FLOW_HOME_URL;

  const { browser, page } = await launchBrowser({
    profileDir,
    headless: options.headed !== undefined ? !options.headed : false,
    url: targetUrl,
    stealth: false,
    keepAlive: true,
    reuseSession: true,
    viewport: options.viewport,
  });

  try {
    if (!page.url().includes('flow.google.com')) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }

    if (await hasSignInPrompt(page)) {
      throw new Error('Not signed in to Google Flow. Run "flow-cli login" first to authenticate.');
    }

    let projectId = extractProjectId(page.url());

    if (options.projectId && (await isProjectNotFound(page))) {
      throw new Error(
        `Google Flow project not found: ${options.projectId}. ` +
          `The project may have been deleted — pass a valid project id or omit it to create a new project.`
      );
    }

    if (!projectId) {
      await scrollToDisplayAllProjects(page).catch(() => []);
      console.log(pc.gray(`Creating new Flow project...`));
      await createNewProject(page, 30_000, { homeUrl: FLOW_HOME_URL });
      projectId = extractProjectId(page.url());
    }

    // Risk-control retry loop: every attempt refreshes the page first (clears the
    // risk tile), then re-runs the click input box → Ctrl+V → Enter gesture below.
    return await withRiskControlRetry(page, { label: 'image generation' }, async () => {
      // Failure-state baseline: only failures that appear AFTER this attempt may abort it.
      const failureBaseline = await readFlowFailureState(page);

      // Wait for the prompt editor to become ready
      await waitForEditor(page, 30_000);

      // Scroll to bottom to load all lazy tiles, then take baseline count
      await scrollToBottomToLoadAll(page, { maxScrolls: 10, timeoutMs: 8_000 }).catch(() => {});
      const baselineTileCount = await countImageTiles(page);
      console.log(pc.gray(`[flow-cli] Current image tiles in project: ${baselineTileCount}`));

      // Character consistency: if previous image tile exists, right-click and Add to Prompt
      if (baselineTileCount > 0) {
        console.log(pc.cyan(`[flow-cli] Referencing previous image tile (1 of ${baselineTileCount}) via "Add to prompt" for character consistency...`));
        await clearExistingIngredientChips(page).catch(() => {});
        await rightClickImageTile(page);
        await captureEvidence(page, 'img-01b-previous-tile-right-clicked', ctx.config.debugDir);
        await clickAddToPromptMenuItem(page, 10_000);
        await captureEvidence(page, 'img-01c-added-to-prompt', ctx.config.debugDir);
        await new Promise((r) => setTimeout(r, randomDelay(1, 2)));
      }

      // Configure direct canvas settings (mode: image, count: x1, modelSuffix: 'lite', aspect)
      const targetAspect = options.aspect === 'portrait' ? '9:16' : (options.aspect === 'square' ? '1:1' : '16:9');
      console.log(pc.cyan(`[flow-cli] Configuring direct canvas settings (mode: image, count: x1, model: *lite, aspect: ${targetAspect})...`));
      await disableAgentModeIfNeeded(page);
      const configured = await configureDirectGenerationSettings(page, {
        mode: 'image',
        count: 1,
        modelSuffix: 'lite',
        aspectRatio: targetAspect,
      }).catch((e) => {
        console.warn(pc.yellow(`[flow-cli] Notice on direct settings: ${e.message}`));
        return { mode: 'image', count: 1, summary: '' };
      });
      if (configured.summary) {
        console.log(pc.green(`✓ Flow direct canvas configured: ${configured.summary}`));
      }

      // Fill prompt input via trusted clipboard paste
      await fillPromptInput(page, options.prompt);
      await captureEvidence(page, 'img-01-prompt-filled', ctx.config.debugDir);

      // Human-like review pause between pasting the prompt and submitting it
      await new Promise((r) => setTimeout(r, randomDelay(1.5, 3.5)));

      // Submit generation request (Enter first, click fallback)
      console.log(pc.cyan(`[flow-cli] Submitting image generation request via Enter...`));
      const imgSubmitVia = await submitPrompt(page);
      console.log(pc.gray(`[flow-cli] Image prompt submitted via ${imgSubmitVia}`));
      await captureEvidence(page, 'img-02-generate-clicked', ctx.config.debugDir);

      // Approve confirmation modal if prompted
      await approveGenerationModal(page, 8_000).catch(() => {});

      // Wait for generation queued acknowledgement
      await waitForGenerationQueued(page, 15_000, failureBaseline).catch((err: any) => {
        // Risk-control rejections must reach the retry loop immediately.
        if (isRiskControlError(err?.message || '')) throw err;
      });
      console.log(pc.green(`✓ Image generation accepted by Flow backend. Awaiting synthesis...`));
      await captureEvidence(page, 'img-03-generation-queued', ctx.config.debugDir);

      // Wait for new image tile to appear in the project grid
      const newTile = await waitForNewImageTile(page, baselineTileCount, options.timeoutMs, failureBaseline);
      console.log(pc.green(`✓ New image tile detected in project grid.`));
      await captureEvidence(page, 'img-04-image-ready', ctx.config.debugDir);

      // Extract image URL from the new tile
      let imageUrl: string | null = newTile.src || null;

      // If no direct src, try to get it by clicking the tile to view full size
      if (!imageUrl && newTile.rect) {
        try {
          await page.mouse.click(newTile.rect.x + newTile.rect.width / 2, newTile.rect.y + newTile.rect.height / 2);
          await new Promise((r) => setTimeout(r, 2000));

          // Look for full-size image in the viewer
          imageUrl = await page.evaluate(() => {
            const img = document.querySelector(
              '[class*="viewer"] img, [class*="preview"] img, [class*="full-size"] img, dialog img'
            ) as HTMLImageElement | null;
            return img?.src || null;
          });
        } catch {
          // Fallback: continue without image URL
        }
      }

      // Download image if output path is requested
      let finalOutputPath: string | null = null;
      if (options.outputPath && imageUrl) {
        finalOutputPath = path.resolve(options.outputPath);
        console.log(pc.cyan(`[flow-cli] Downloading image to: ${finalOutputPath}`));
        await downloadImage(page, imageUrl, finalOutputPath);
        console.log(pc.green(`✓ Image download complete: ${finalOutputPath}`));
      }

      return {
        project: {
          projectId,
          url: page.url(),
        },
        imageUrl,
        outputPath: finalOutputPath,
        mediaId: newTile.mediaId,
        prompt: options.prompt,
        createdAt: new Date().toISOString(),
      };
    });
  } catch (err: any) {
    await captureEvidence(page, 'image-generation-failure', ctx.config.debugDir);
    throw err;
  } finally {
    await releaseBrowser(browser, { keepAlive: true, profileDir });
  }
}
