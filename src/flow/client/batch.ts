/**
 * Batch video generation pipeline for FlowClient.
 * Orchestrates alternating clip generation (image -> video per clip, or last-frame continuation).
 */
import { readFile, stat as fsStat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import type { RunContext } from '../../run/index.js';
import { FlowVideoScriptSchema } from '../../research/script/contracts.js';
import {
  type BatchClipResult,
  type BatchOptions,
  BatchOptionsSchema,
  type BatchResult,
} from '../contracts.js';
import { planClipGeneration } from '../clip-plan.js';
import { ClipDuplicateGuard, hashMediaFile, resolveMediaKey } from '../duplicate-guard.js';
import { paceByGenerationProgress } from './project.js';
import { generateClipImage } from './clip-image.js';
import { generateContinuationVideo } from './clip-continuation.js';
import { generateFramesVideo } from './clip-frames.js';
import type { ClientContext } from './types.js';

export async function batchGenerate(
  ctx: ClientContext,
  rawOptions: BatchOptions,
  run?: RunContext
): Promise<BatchResult> {
  const options = BatchOptionsSchema.parse(rawOptions);
  const scriptPath = path.resolve(options.scriptPath);
  const outDir = path.resolve(options.outDir);

  const scriptContent = await readFile(scriptPath, 'utf8');
  const script = JSON.parse(scriptContent) as {
    aspectRatio?: 'landscape' | 'portrait';
    clips: Array<{
      clipIndex: number;
      sceneId?: string;
      title?: string;
      imagePrompt?: string;
      imageUrl?: string;
      localImagePath?: string;
      imageTileKey?: string | null;
      endImagePrompt?: string;
      endImageUrl?: string;
      localEndImagePath?: string;
      endImageTileKey?: string | null;
      visualPrompt: string;
      transition?: string;
      transitionNote?: string;
      planMode?: string;
      startFrameSourceVideo?: string;
      startFramePath?: string;
      durationSec?: number;
      status?: string;
      videoUrl?: string;
      localVideoPath?: string;
      error?: string;
    }>;
  };

  if (!Array.isArray(script.clips) || script.clips.length === 0) {
    throw new Error(`Invalid or empty flow script file: ${scriptPath}`);
  }

  const eligibleClips = script.clips.filter(
    (c) => c.status !== 'completed' && (!options.maxClips || c.clipIndex <= options.maxClips)
  );

  console.log(pc.cyan(`\n=== Flow Batch Video Generation (alternating rhythm: image → video per clip) ===`));
  console.log(pc.gray(`Script: ${scriptPath}`));
  console.log(pc.gray(`Total clips: ${script.clips.length}, Pending: ${eligibleClips.length}`));
  console.log(pc.gray(`Output directory: ${outDir}`));

  const clipAspect = (script.aspectRatio as 'landscape' | 'portrait') || options.aspect || 'landscape';
  const targetModel = options.model || (script as any).model || 'lite';

  const work = eligibleClips.map((clip) => {
    const label = `clip-${String(clip.clipIndex).padStart(3, '0')}`;
    return {
      clip,
      label,
      clipOutputFile: path.join(outDir, `${label}.mp4`),
      clipImageFile: path.join(outDir, `${label}-start.jpg`),
      clipEndImageFile: path.join(outDir, `${label}-end.jpg`),
      imagePrompt: (clip.imagePrompt && clip.imagePrompt.trim().length > 0)
        ? clip.imagePrompt.trim()
        : clip.visualPrompt.trim(),
      endImagePrompt: (clip.endImagePrompt && clip.endImagePrompt.trim().length > 0)
        ? clip.endImagePrompt.trim()
        : `${clip.imagePrompt || clip.visualPrompt} Concluding settled pose.`,
    };
  });

  // Dry-run: report the planned alternating work (image → video, or last-frame
  // continuation) per clip without touching the canvas.
  if (options.dryRun) {
    const dryOrderedClips = [...script.clips].sort((a, b) => a.clipIndex - b.clipIndex);
    const results: BatchClipResult[] = work.map((item) => {
      const transition = item.clip.transition === 'continuous' ? 'continuous' : 'cut';
      console.log(
        pc.yellow(
          `[DRY RUN] [${item.label}] (${transition === 'continuous' ? '连续/continuous' : '切分镜/cut'})${
            item.clip.transitionNote ? ` 备注: ${item.clip.transitionNote}` : ''
          }`
        )
      );

      const idx = dryOrderedClips.findIndex((c) => c.clipIndex === item.clip.clipIndex);
      const prevClip = idx > 0 ? dryOrderedClips[idx - 1] : undefined;
      // Dry-run previews the PLANNED work: the previous clip's video is the file this
      // run will download. The real run verifies that file really exists.
      const plannedPrevVideo = prevClip
        ? prevClip.localVideoPath ?? path.join(outDir, `clip-${String(prevClip.clipIndex).padStart(3, '0')}.mp4`)
        : null;
      try {
        const plan = planClipGeneration({
          clipIndex: item.clip.clipIndex,
          transition,
          previousVideoPath: plannedPrevVideo,
          previousClipIndex: prevClip?.clipIndex ?? null,
        });
        console.log(pc.yellow(`[DRY RUN]   生成方式: ${plan.reason}`));
        if (plan.mode === 'frame-continue') {
          console.log(pc.yellow(`[DRY RUN]   start-frame: last frame of ${plan.startFrameSourceVideo}`));
        } else {
          console.log(pc.yellow(`[DRY RUN]   image: "${item.imagePrompt.slice(0, 80)}..."`));
        }
      } catch (e: any) {
        console.warn(pc.yellow(`[DRY RUN]   ⚠ 生成方式无法确定: ${e.message}`));
      }
      console.log(pc.yellow(`[DRY RUN]   video: "${item.clip.visualPrompt.slice(0, 80)}..."`));
      return {
        clipIndex: item.clip.clipIndex,
        sceneId: item.clip.sceneId,
        title: item.clip.title,
        imagePrompt: item.imagePrompt,
        visualPrompt: item.clip.visualPrompt,
        transition,
        transitionNote: item.clip.transitionNote,
        outputPath: item.clipOutputFile,
        status: 'skipped',
      };
    });
    return {
      totalClips: eligibleClips.length,
      completedClips: 0,
      failedClips: 0,
      skippedClips: results.length,
      outDir,
      results,
    };
  }

  const results: BatchClipResult[] = [];
  let completed = 0;
  let failed = 0;
  let latestCredits: number | undefined;
  let stepCounter = 0;

  const persistScript = async () => {
    if (run) await run.write('script', FlowVideoScriptSchema.parse(script));
    else await writeFile(scriptPath, JSON.stringify(script, null, 2) + '\n', 'utf8');
  };

  // Inter-step pacing: driven by ACTUAL generation progress, not a fixed clock.
  const cooldown = async (label: string) => {
    if (stepCounter > 0) {
      await paceByGenerationProgress(ctx, label, {
        projectId: options.projectId,
        headed: options.headed,
        viewport: options.viewport,
        profileDir: options.profileDir,
        dataDir: options.dataDir,
      });
    }
    stepCounter++;
  };

  // ── Alternating rhythm: one video per clip, clip by clip ──
  console.log(pc.cyan(`\n=== Generating ${work.length} clip(s) in alternating rhythm: image → video → image → video … ===`));

  let previousImageKey: string | null = null;
  /** URL of the immediately preceding image card, for canvas targeting when the key is a content hash. */
  let previousImageSrc: string | null = null;
  /** Downloaded MP4 of the immediately preceding clip — the 连续/continuous continuation source. */
  let previousVideo: { clipIndex: number; path: string } | null = null;

  const orderedClips = [...script.clips].sort((a, b) => a.clipIndex - b.clipIndex);
  // Reject stale/duplicate Flow results loudly: seed with every clip already
  // completed (this session or a prior one), then check each new clip by
  // canonical video ID + file content hash before it can be marked completed.
  const duplicateGuard = await ClipDuplicateGuard.seed(
    orderedClips
      .filter((c) => c.status === 'completed')
      .map((c) => ({
        label: `clip-${String(c.clipIndex).padStart(3, '0')}`,
        videoUrl: c.videoUrl,
        localVideoPath: c.localVideoPath,
      }))
  );
  const rejectDuplicateClip = async (
    item: { label: string },
    video: { videoUrl: string; outputPath: string | null }
  ): Promise<string | null> => {
    const dupe = await duplicateGuard.register({
      label: item.label,
      videoUrl: video.videoUrl,
      localVideoPath: video.outputPath,
    });
    if (!dupe) return null;
    return `${item.label}: Flow returned a duplicate video (${dupe}) — refusing to stitch stale content into the final video`;
  };
  const resolvePreviousVideo = async (
    clipIndex: number
  ): Promise<{ path: string | null; clipIndex: number | null }> => {
    const idx = orderedClips.findIndex((c) => c.clipIndex === clipIndex);
    const prev = idx > 0 ? orderedClips[idx - 1] : undefined;
    if (!prev) return { path: null, clipIndex: null };
    const candidates = [
      previousVideo && previousVideo.clipIndex === prev.clipIndex ? previousVideo.path : null,
      prev.localVideoPath,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const info = await fsStat(candidate).catch(() => null);
      if (info && info.isFile() && info.size > 0) return { path: candidate, clipIndex: prev.clipIndex };
    }
    return { path: null, clipIndex: prev.clipIndex };
  };

  const getKnownVideoUrls = (): string[] => {
    const urls: string[] = [];
    for (const c of orderedClips) {
      if (c.videoUrl) urls.push(c.videoUrl);
    }
    for (const r of results) {
      if (r.videoUrl) urls.push(r.videoUrl);
    }
    return Array.from(new Set(urls));
  };

  for (const item of work) {
    const { clip } = item;
    const transition: 'cut' | 'continuous' = clip.transition === 'continuous' ? 'continuous' : 'cut';
    console.log(
      pc.cyan(
        `\n--- [Clip ${clip.clipIndex}/${script.clips.length}] ${clip.title || item.label} ` +
          `(${transition === 'continuous' ? '连续/continuous' : '切分镜/cut'}) ---`
      )
    );
    if (clip.transitionNote) {
      console.log(pc.gray(`  备注: ${clip.transitionNote}`));
    }

    // ── Generation mode from the shot-transition annotation ──
    //   切分镜/cut       → 文生图关键帧 → 图生视频 (Animate)
    //   连续/continuous  → 不生图，取上一片段视频末帧上传作为起始帧续生视频
    const previous = await resolvePreviousVideo(clip.clipIndex);
    const plan = planClipGeneration({
      clipIndex: clip.clipIndex,
      transition,
      previousVideoPath: previous.path,
      previousClipIndex: previous.clipIndex,
    });
    console.log(pc.gray(`  生成方式: ${plan.reason}`));

    if (plan.mode === 'frame-continue') {
      const startFrameFile = path.join(outDir, `${item.label}-start-frame.jpg`);
      clip.planMode = plan.mode;
      clip.startFrameSourceVideo = plan.startFrameSourceVideo!;
      clip.startFramePath = startFrameFile;
      await persistScript();

      await cooldown(`${item.label} continue-from-last-frame`);

      try {
        const video = await generateContinuationVideo(ctx, {
          label: item.label,
          startFrameSourceVideo: plan.startFrameSourceVideo!,
          startFramePath: startFrameFile,
          visualPrompt: clip.visualPrompt,
          duration: (clip.durationSec as 4 | 6 | 8 | 10) || 4,
          outputPath: item.clipOutputFile,
          projectId: options.projectId,
          aspect: clipAspect,
          model: targetModel,
          headed: options.headed,
          viewport: options.viewport,
          profileDir: options.profileDir,
          dataDir: options.dataDir,
          timeoutMs: ctx.config.timeoutMs,
          knownVideoUrls: getKnownVideoUrls(),
        });

        if (video.downloadError) {
          clip.status = 'failed';
          clip.videoUrl = video.videoUrl;
          clip.error = `video generated (${video.videoUrl}) but download failed: ${video.downloadError}`;
          delete clip.localVideoPath;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            sceneId: clip.sceneId,
            title: clip.title,
            imagePrompt: item.imagePrompt,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            videoUrl: video.videoUrl,
            status: 'failed',
            error: clip.error,
          });
          failed++;
          console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${clip.error}`));
          break;
        }

        const duplicateError = await rejectDuplicateClip(item, video);
        if (duplicateError) {
          clip.status = 'failed';
          clip.videoUrl = video.videoUrl;
          clip.error = duplicateError;
          delete clip.localVideoPath;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            sceneId: clip.sceneId,
            title: clip.title,
            imagePrompt: item.imagePrompt,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            videoUrl: video.videoUrl,
            status: 'failed',
            error: duplicateError,
          });
          failed++;
          console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${duplicateError}`));
          break;
        }

        clip.status = 'completed';
        clip.videoUrl = video.videoUrl;
        clip.localVideoPath = video.outputPath ?? undefined;
        delete clip.error;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          sceneId: clip.sceneId,
          title: clip.title,
          imagePrompt: item.imagePrompt,
          imageUrl: clip.imageUrl,
          localImagePath: clip.localImagePath,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          outputPath: video.outputPath ?? undefined,
          videoUrl: video.videoUrl,
          status: 'completed',
        });
        completed++;
        if (video.quota?.actualCredits !== undefined) latestCredits = video.quota.actualCredits;
        if (video.outputPath) previousVideo = { clipIndex: clip.clipIndex, path: video.outputPath };
      } catch (err: any) {
        console.error(pc.red(`✗ ${item.label} continuation from last frame failed: ${err.message}`));
        clip.status = 'failed';
        clip.error = err.message;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          sceneId: clip.sceneId,
          title: clip.title,
          imagePrompt: item.imagePrompt,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          status: 'failed',
          error: err.message,
        });
        failed++;
        console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${err.message}`));
        break;
      }

      continue;
    }

    // ── 切分镜/cut — Step 1/3 & 2/3: generate Start image & End image ──
    // (NO right-click animate; Frames mode interpolates between Start and End images)
    clip.planMode = 'frames-cut';
    const hasStartImage = Boolean((clip.imageUrl || clip.localImagePath) && (clip.imageTileKey || clip.imageUrl));
    const hasEndImage = Boolean((clip.endImageUrl || clip.localEndImagePath) && (clip.endImageTileKey || clip.endImageUrl));

    // 1. Generate Start image if not already present
    if (hasStartImage) {
      console.log(pc.yellow(`[flow-cli] ${item.label}: Start keyframe image already generated — reusing`));
    } else {
      await cooldown(`${item.label} start-image`);
      try {
        const startImg = await generateClipImage(ctx, {
          label: `${item.label} start-image`,
          imagePrompt: item.imagePrompt,
          imageOutputPath: item.clipImageFile,
          projectId: options.projectId,
          aspect: clipAspect,
          model: targetModel,
          headed: options.headed,
          viewport: options.viewport,
          profileDir: options.profileDir,
          dataDir: options.dataDir,
          referencePreviousImage: true,
          referenceKey: previousImageKey,
          referenceSrc: previousImageSrc,
          referenceMode: 'optional',
        });

        clip.imageUrl = startImg.imageUrl || undefined;
        clip.localImagePath = startImg.imageOutputPath || undefined;
        // Truthful identity: src UUID, else content hash of the downloaded file
        // (recycled tiles carry stale attribute keys; asb srcs carry no UUID).
        clip.imageTileKey = await resolveMediaKey(startImg.imageUrl, startImg.imageOutputPath, startImg.mediaKey);
        delete clip.error;
        await persistScript();
        console.log(pc.green(`✓ ${item.label}: Start keyframe image ready`));
      } catch (err: any) {
        console.error(pc.red(`✗ ${item.label} start image failed: ${err.message}`));
        clip.status = 'failed';
        clip.error = err.message;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          sceneId: clip.sceneId,
          title: clip.title,
          imagePrompt: item.imagePrompt,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          status: 'failed',
          error: err.message,
        });
        failed++;
        console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${err.message}`));
        break;
      }
    }

    // 2. Generate End image if not already present
    if (hasEndImage) {
      console.log(pc.yellow(`[flow-cli] ${item.label}: End keyframe image already generated — reusing`));
    } else {
      await cooldown(`${item.label} end-image`);
      try {
        const endImg = await generateClipImage(ctx, {
          label: `${item.label} end-image`,
          imagePrompt: item.endImagePrompt,
          imageOutputPath: item.clipEndImageFile,
          projectId: options.projectId,
          aspect: clipAspect,
          model: targetModel,
          headed: options.headed,
          viewport: options.viewport,
          profileDir: options.profileDir,
          dataDir: options.dataDir,
          referencePreviousImage: true,
          referenceKey: clip.imageTileKey ?? null,
          // The tile key may be a `file:<sha1>` content hash with no canvas token;
          // the recorded URL lets the reference step still target the real card.
          referenceSrc: clip.imageUrl ?? null,
          referenceMode: 'optional',
          // Explicitly exclude the start image so end-image generation never mistakes
          // the start image card for the newly generated end image card.
          excludeKeys: [clip.imageTileKey, clip.imageUrl, clip.localImagePath],
        });

        clip.endImageUrl = endImg.imageUrl || undefined;
        clip.localEndImagePath = endImg.imageOutputPath || undefined;
        // Truthful identity: src UUID, else content hash of the downloaded file
        // (recycled tiles carry stale attribute keys; asb srcs carry no UUID).
        clip.endImageTileKey = await resolveMediaKey(endImg.imageUrl, endImg.imageOutputPath, endImg.mediaKey);
        delete clip.error;
        await persistScript();
        console.log(pc.green(`✓ ${item.label}: End keyframe image ready`));
      } catch (err: any) {
        console.error(pc.red(`✗ ${item.label} end image failed: ${err.message}`));
        clip.status = 'failed';
        clip.error = err.message;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          sceneId: clip.sceneId,
          title: clip.title,
          imagePrompt: item.imagePrompt,
          endImagePrompt: item.endImagePrompt,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          status: 'failed',
          error: err.message,
        });
        failed++;
        console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${err.message}`));
        break;
      }
    }

    if (!clip.imageUrl && !clip.localImagePath) {
      console.warn(pc.yellow(`[flow-cli] ${item.label}: no start image recorded — cannot proceed to video`));
      continue;
    }

    // ── Step 3/3: Frames mode video (select Start and End frame buttons, NO right-click animate) ──
    await cooldown(`${item.label} frames-video`);

    // Degenerate Frames input guard: identical image CONTENT in both slots yields
    // a static or backend-deduped video (observed: run viral-1791900784598-797ux0).
    // Tile KEYS are unreliable on the recycled virtualized canvas — they may be
    // stale while the content differs — so the hard check is content-hash based.
    const startFrameHash = clip.localImagePath ? await hashMediaFile(clip.localImagePath) : null;
    const endFrameHash = clip.localEndImagePath ? await hashMediaFile(clip.localEndImagePath) : null;
    if (startFrameHash && endFrameHash && startFrameHash === endFrameHash) {
      const msg = `${item.label}: start and end keyframes are the same image content — refusing to submit a degenerate Frames video`;
      console.error(pc.red(`✗ ${msg}`));
      clip.status = 'failed';
      clip.error = msg;
      await persistScript();
      results.push({
        clipIndex: clip.clipIndex,
        sceneId: clip.sceneId,
        title: clip.title,
        imagePrompt: item.imagePrompt,
        imageUrl: clip.imageUrl,
        localImagePath: clip.localImagePath,
        endImagePrompt: item.endImagePrompt,
        endImageUrl: clip.endImageUrl,
        localEndImagePath: clip.localEndImagePath,
        visualPrompt: clip.visualPrompt,
        transition,
        transitionNote: clip.transitionNote,
        status: 'failed',
        error: msg,
      });
      failed++;
      console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${msg}`));
      break;
    }
    if (clip.imageTileKey && clip.imageTileKey === clip.endImageTileKey) {
      console.warn(
        pc.yellow(
          `[flow-cli] ⚠ ${item.label}: start/end tile keys are identical (${clip.imageTileKey}) but keyframe content differs — ` +
            `the canvas recycled a stale tile key; proceeding with content-verified frames.`
        )
      );
    }

    try {
      const video = await generateFramesVideo(ctx, {
        label: item.label,
        startImage: {
          prompt: item.imagePrompt,
          mediaKey: clip.imageTileKey ?? null,
        },
        endImage: {
          prompt: item.endImagePrompt,
          mediaKey: clip.endImageTileKey ?? null,
        },
        visualPrompt: clip.visualPrompt,
        duration: (clip.durationSec as 4 | 6 | 8 | 10) || 4,
        outputPath: item.clipOutputFile,
        projectId: options.projectId,
        aspect: clipAspect,
        model: targetModel,
        headed: options.headed,
        viewport: options.viewport,
        profileDir: options.profileDir,
        dataDir: options.dataDir,
        timeoutMs: ctx.config.timeoutMs,
        knownVideoUrls: getKnownVideoUrls(),
      });

      if (video.downloadError) {
        clip.status = 'failed';
        clip.videoUrl = video.videoUrl;
        clip.error = `video generated (${video.videoUrl}) but download failed: ${video.downloadError}`;
        delete clip.localVideoPath;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          sceneId: clip.sceneId,
          title: clip.title,
          imagePrompt: item.imagePrompt,
          imageUrl: clip.imageUrl,
          localImagePath: clip.localImagePath,
          endImagePrompt: item.endImagePrompt,
          endImageUrl: clip.endImageUrl,
          localEndImagePath: clip.localEndImagePath,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          videoUrl: video.videoUrl,
          status: 'failed',
          error: clip.error,
        });
        failed++;
        console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${clip.error}`));
        break;
      }

      const duplicateError = await rejectDuplicateClip(item, video);
      if (duplicateError) {
        clip.status = 'failed';
        clip.videoUrl = video.videoUrl;
        clip.error = duplicateError;
        delete clip.localVideoPath;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          sceneId: clip.sceneId,
          title: clip.title,
          imagePrompt: item.imagePrompt,
          imageUrl: clip.imageUrl,
          localImagePath: clip.localImagePath,
          endImagePrompt: item.endImagePrompt,
          endImageUrl: clip.endImageUrl,
          localEndImagePath: clip.localEndImagePath,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          videoUrl: video.videoUrl,
          status: 'failed',
          error: duplicateError,
        });
        failed++;
        console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${duplicateError}`));
        break;
      }

      clip.status = 'completed';
      clip.videoUrl = video.videoUrl;
      clip.localVideoPath = video.outputPath ?? undefined;
      delete clip.error;
      await persistScript();
      results.push({
        clipIndex: clip.clipIndex,
        sceneId: clip.sceneId,
        title: clip.title,
        imagePrompt: item.imagePrompt,
        imageUrl: clip.imageUrl,
        localImagePath: clip.localImagePath,
        endImagePrompt: item.endImagePrompt,
        endImageUrl: clip.endImageUrl,
        localEndImagePath: clip.localEndImagePath,
        visualPrompt: clip.visualPrompt,
        transition,
        transitionNote: clip.transitionNote,
        outputPath: video.outputPath ?? undefined,
        videoUrl: video.videoUrl,
        status: 'completed',
      });
      completed++;
      if (video.quota?.actualCredits !== undefined) latestCredits = video.quota.actualCredits;
    } catch (err: any) {
      console.error(pc.red(`✗ ${item.label} Frames video failed: ${err.message}`));
      clip.status = 'failed';
      clip.error = err.message;
      await persistScript();
      results.push({
        clipIndex: clip.clipIndex,
        sceneId: clip.sceneId,
        title: clip.title,
        imagePrompt: item.imagePrompt,
        imageUrl: clip.imageUrl,
        localImagePath: clip.localImagePath,
        endImagePrompt: item.endImagePrompt,
        endImageUrl: clip.endImageUrl,
        localEndImagePath: clip.localEndImagePath,
        visualPrompt: clip.visualPrompt,
        transition,
        transitionNote: clip.transitionNote,
        status: 'failed',
        error: err.message,
      });
      failed++;
      console.warn(pc.yellow(`[flow-cli] Stopping batch run due to clip failure: ${err.message}`));
      break;
    }

    // The image card of this clip is the reference candidate for the next clip.
    previousImageKey = clip.endImageTileKey ?? clip.imageTileKey ?? null;
    previousImageSrc = clip.endImageUrl ?? clip.imageUrl ?? null;
    if (clip.localVideoPath) previousVideo = { clipIndex: clip.clipIndex, path: clip.localVideoPath };
  }

  return {
    totalClips: eligibleClips.length,
    completedClips: completed,
    failedClips: failed,
    skippedClips: 0,
    outDir,
    finalCredits: latestCredits,
    results,
  };
}
