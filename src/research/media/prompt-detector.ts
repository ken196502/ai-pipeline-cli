/**
 * 3-Stage Targeted Prompt Detection Pipeline.
 *
 * Instead of blindly sampling frames and hoping to find AI prompt UIs,
 * this pipeline:
 *
 * Stage 1: LLM analyzes transcript → identifies time ranges where the video creator
 *          is showing/using AI generation tools (ChatGPT, Midjourney, Kling, etc.)
 *          Returns typed ranges: script/image/video.
 *
 * Stage 2: For each candidate range → extract low-res frame grid → send to VL model
 *          → VL identifies which specific frames actually contain visible prompt UIs.
 *
 * Stage 3: Extract high-res frames from original video at confirmed timestamps →
 *          send individually to VL → detailed OCR with type classification.
 *
 * This wastes zero VL tokens on irrelevant frames.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AppError, ErrorCodes } from '../errors.js';
import { getEnvConfig } from '../../env.js';
import { chat, imagePartFromBase64, type ChatMessage, LLMError, HttpStatusError, NonRetryableError } from '../../llm/client.js';
import { extractJsonObject } from '../../llm/json.js';
import type {
  PromptFrameLocator,
  PromptFrameRecognition,
  PromptRecognition,
  Transcript,
  VlExtractedPrompt,
} from '../contracts.js';
import {
  PromptRecognitionSchema,
} from '../contracts.js';
import { EMPTY_CHANNEL_REF, EMPTY_UI_DESCRIPTION } from '../contracts.js';
import {
  extractFrameAt,
  formatTimestamp,
  prepareVisionPng,
  buildFrameGrid,
  type ExtractedFrame,
  removeNearDuplicateFrames,
} from './frames.js';
import {
  buildDetailedRecognitionPrompt,
  normalizeDetailedRecognition,
  parseJsonObject,
  validateDetailedRecognition,
  detailedRepairPrompt,
  recognizePromptDetail,
} from './locator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptTimeRange {
  startSec: number;
  endSec: number;
  promptType: 'image' | 'video';
  reason: string;
}

export interface ScreenedFrame {
  timestampSec: number;
  promptType: 'image' | 'video';
  orientation?: 'portrait' | 'landscape';
  confidence: number;
  prompt?: string; // Prompt text if Stage 2 was able to read it
}

export interface DetectPromptRangesOptions {
  transcript: Transcript;
  videoDurationSec: number;
  videoTitle: string;
  topic?: string;
  model?: string;
}

export interface ScreenPromptFramesOptions {
  videoPath: string;
  ranges: PromptTimeRange[];
  videoTitle: string;
  outputDir: string;
  model?: string;
  targetLanguage?: string;
  framesPerRange?: number;
}

export interface PromptDetectorResult {
  ranges: PromptTimeRange[];
  screened: ScreenedFrame[];
  recognition: PromptFrameRecognition;
  locator: PromptFrameLocator;
  detectedOrientation?: 'portrait' | 'landscape';
  orientationVotes?: {
    portrait: number;
    landscape: number;
  };
}

export function determineOrientationFromVotes(
  votes: Array<'portrait' | 'landscape' | string | undefined | null>,
  fallbackDefault?: 'portrait' | 'landscape'
): { orientation: 'portrait' | 'landscape'; portraitVotes: number; landscapeVotes: number } {
  let portraitVotes = 0;
  let landscapeVotes = 0;

  for (const v of votes) {
    if (!v) continue;
    const lower = String(v).toLowerCase().trim();
    if (lower === 'portrait' || lower.includes('port') || lower === 'vertical' || lower === '9:16' || lower === '3:4' || lower.includes('竖')) {
      portraitVotes++;
    } else if (lower === 'landscape' || lower.includes('land') || lower === 'horizontal' || lower === '16:9' || lower === '4:3' || lower.includes('横') || lower.includes('宽')) {
      landscapeVotes++;
    }
  }

  let orientation: 'portrait' | 'landscape';
  if (portraitVotes > landscapeVotes) {
    orientation = 'portrait';
  } else if (landscapeVotes > portraitVotes) {
    orientation = 'landscape';
  } else {
    orientation = fallbackDefault || 'landscape';
  }

  return { orientation, portraitVotes, landscapeVotes };
}

// ---------------------------------------------------------------------------
// Stage 1: LLM transcript analysis → prompt time ranges
// ---------------------------------------------------------------------------

/**
 * Asks the LLM to read the full transcript and identify time ranges where the
 * video creator is likely showing AI prompt UIs (ChatGPT, Midjourney, Kling, etc).
 *
 * Returns typed ranges with promptType already classified as script/image/video.
 */
export async function detectPromptRanges(
  options: DetectPromptRangesOptions,
): Promise<PromptTimeRange[]> {
  const {
    transcript,
    videoDurationSec,
    videoTitle,
    topic,
    model,
  } = options;

  if (!transcript.cues || transcript.cues.length < 4) {
    console.warn(`[prompt-detector] Stage 1 skipped: transcript has only ${transcript.cues?.length ?? 0} cues for "${videoTitle}"`);
    return [];
  }

  const env = getEnvConfig();
  if (!env.baseUrl || !env.apiKey) {
    console.warn('[prompt-detector] Stage 1 skipped: LLM gateway not configured (baseUrl/apiKey missing) — no prompt ranges can be detected');
    return [];
  }

  const transcriptDuration = transcript.cues.length > 0
    ? transcript.cues[transcript.cues.length - 1][1]
    : 0;
  const effectiveDuration = Math.max(videoDurationSec || 0, Math.ceil(transcriptDuration));

  let formattedCues: string[] = [];
  if (transcript.cues.length <= 80) {
    formattedCues = transcript.cues.map((c, i) => `[${i}] ${formatTime(c[0])}-${formatTime(c[1])}: ${c[2]}`);
  } else {
    // Focus on prompt-related keyword cues plus immediate context (-1, 0, +1 cues)
    const keywords = /prompt|image|video|generate|midjourney|kling|runway|chatgpt|flow|leonardo|gemini|flux|luma|pika|suno|elevenlabs|style|paste|copy|type|workflow|step|input|master prompt/i;
    const includedIndices = new Set<number>();
    transcript.cues.forEach((c, i) => {
      if (keywords.test(c[2])) {
        for (let offset = -1; offset <= 1; offset++) {
          const target = i + offset;
          if (target >= 0 && target < transcript.cues.length) {
            includedIndices.add(target);
          }
        }
      }
    });

    // If few keyword cues matched, sample evenly across transcript
    if (includedIndices.size < 30) {
      const step = transcript.cues.length / 60;
      for (let i = 0; i < 60; i++) {
        includedIndices.add(Math.floor(i * step));
      }
    }

    const sorted = Array.from(includedIndices).sort((a, b) => a - b);
    formattedCues = sorted.map((idx) => {
      const c = transcript.cues[idx];
      return `[${idx}] ${formatTime(c[0])}-${formatTime(c[1])}: ${c[2]}`;
    });
  }

  const fullText = formattedCues.join('\n');
  const maxChars = 30_000;
  const transcriptBlock = fullText.length > maxChars
    ? fullText.slice(0, maxChars) + '\n...[truncated]'
    : fullText;

  const systemPrompt = `You are an expert video content analyst specializing in generative AI workflows.
Your task is to identify parts of a video where the creator is INTERACTING WITH AI TOOLS — specifically where they are viewing, typing, copying, or displaying AI generation prompts in a UI.

CONTEXT:
- The video is about: "${topic || videoTitle}"
- Duration: ${effectiveDuration}s
- The transcript comes from the video's subtitles/narration.

CRITICAL REQUIREMENT:
AI video creation workflows almost always consist of TWO essential categories:
1. "image": Image generation prompts / keyframe prompts / character reference prompts / storyboard prompts (e.g. Text-to-Image in Midjourney, DALL-E, Google Flow Image mode, Flux, or ChatGPT generating image/storyboard prompts).
2. "video": Video animation prompts / camera movement directives / clip prompts (e.g. Image-to-Video in Kling, Runway, Google Flow Video/Agent mode, or ChatGPT generating clip prompts).

You MUST actively search for and return BOTH "image" prompts AND "video" prompts if both exist in the transcript!
Do NOT bias toward only video or only image. Identify distinct ranges for EACH prompt type shown.

GUIDANCE ON CLASSIFICATION ("image" vs "video"):
- "image": Showing or crafting an AI image generation prompt (Text-to-Image / keyframe visuals, character design, storyboard sheet, visual style, subject poses, image mode).
- "video": Showing or crafting an AI video generation prompt (Image-to-Video / Text-to-Video / camera motion, clip animation, scene timing, video mode, agent prompt).
If the creator is using an LLM (ChatGPT, Claude, etc.) to write prompts, classify based on what is being produced: image prompts -> "image", video motion prompts -> "video".

IGNORE parts where the creator is:
- Just talking/explaining without showing a tool
- Showing the final OUTPUT (the generated image/video) rather than the prompt input
- Giving general commentary or introductions

For each identified range, return the START and END timestamps where the prompt UI is likely visible, the prompt type ("image" or "video"), and a brief reason.

Return JSON:
{
  "ranges": [
    {
      "startSec": 45,
      "endSec": 78,
      "promptType": "image",
      "reason": "Creator mentions pasting prompt into Midjourney around 0:45"
    }
  ]
}

Be PRECISE with timestamps — use cue timestamps as anchors. Each range should be tight (10-35s), not the entire segment.
Return ONLY valid JSON. If no AI tool interaction is found, return {"ranges": []}.`;

  const userPrompt = `Video: "${videoTitle}"
${topic ? `Topic: ${topic}\n` : ''}
TRANSCRIPT (with cue indices and timestamps):
${transcriptBlock}`;

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await chat(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          model,
          context: { stage: 'media', task: 'prompt-detector-cues' },
          temperature: 0.15,
          responseFormat: 'json_object',
          timeoutMs: 300_000,
        },
        env,
      );

      const extracted = extractJsonObject(response.content);
      if (!extracted.ok || !extracted.value || typeof extracted.value !== 'object') {
        // A malformed LLM payload must NOT silently disable prompt detection —
        // that was the root cause of transcript-synthesized garbage scripts.
        // Log and retry; if all attempts fail, the loud warning below plus the
        // requireVideoPrompt policy decides (strict default: abort the run).
        console.warn(`[prompt-detector] Stage 1 LLM returned unparseable JSON (attempt ${attempt}/${maxRetries}) for "${videoTitle}": ${response.content.slice(0, 200)}`);
        if (attempt < maxRetries) continue;
        console.warn(`[prompt-detector] Stage 1 gave up after ${maxRetries} attempts — zero prompt ranges detected for "${videoTitle}"`);
        return [];
      }

      const val = extracted.value as { ranges?: Array<{ startSec: number; endSec: number; promptType: string; reason: string }> };
      if (!Array.isArray(val.ranges)) {
        console.warn(`[prompt-detector] Stage 1 LLM JSON has no "ranges" array for "${videoTitle}" (keys: ${Object.keys(val).join(',') || 'none'})`);
        return [];
      }

      const parsedRanges = val.ranges
        .map((r) => {
          let pType = String(r.promptType || '').toLowerCase().trim();
          const promptType: 'image' | 'video' = pType === 'video' || pType.startsWith('vid') || pType === 'animation' ? 'video' : 'image';
          return {
            startSec: Math.max(0, Math.round(r.startSec * 100) / 100),
            endSec: Math.min(effectiveDuration, Math.round(r.endSec * 100) / 100),
            promptType,
            reason: r.reason || '',
          };
        })
        .filter((r) =>
          typeof r.startSec === 'number' &&
          typeof r.endSec === 'number' &&
          r.endSec > r.startSec,
        )
        .sort((a, b) => a.startSec - b.startSec);

      // Merge adjacent or overlapping ranges of the SAME promptType (within 8s)
      const merged: PromptTimeRange[] = [];
      for (const r of parsedRanges) {
        const prev = merged[merged.length - 1];
        if (prev && r.startSec <= prev.endSec + 8 && prev.promptType === r.promptType) {
          prev.endSec = Math.max(prev.endSec, r.endSec);
          prev.reason += `; ${r.reason}`;
        } else {
          merged.push({ ...r });
        }
      }

      // Balance representation between image and video ranges (up to 6 total)
      const imageRanges = merged.filter((r) => r.promptType === 'image');
      const videoRanges = merged.filter((r) => r.promptType === 'video');

      const maxTotalRanges = 6;
      let selected: PromptTimeRange[] = [];

      if (imageRanges.length > 0 && videoRanges.length > 0) {
        const targetPerType = Math.ceil(maxTotalRanges / 2);
        const pickedImage = imageRanges.slice(0, targetPerType);
        const pickedVideo = videoRanges.slice(0, maxTotalRanges - pickedImage.length);
        selected = [...pickedImage, ...pickedVideo];
        if (selected.length < maxTotalRanges && imageRanges.length > pickedImage.length) {
          selected.push(...imageRanges.slice(pickedImage.length, maxTotalRanges - selected.length));
        }
      } else {
        selected = merged.slice(0, maxTotalRanges);
      }

      return selected.sort((a, b) => a.startSec - b.startSec);
    } catch (err: any) {
      lastError = err;
      if (err instanceof AppError && !err.retryable) throw err;
      if (attempt < maxRetries) {
        const delayMs = 2000 * attempt;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }

  if (lastError instanceof AppError) throw lastError;
  throw new AppError({
    code: ErrorCodes.LLM_REQUEST_FAILED,
    message: `Failed to detect prompt ranges via LLM after ${maxRetries} attempts: ${(lastError as any)?.message || String(lastError)}`,
    stage: 'research',
    task: 'detect-prompt-ranges',
    retryable: false,
    cause: lastError,
  });
}

// ---------------------------------------------------------------------------
// Stage 2: Low-res grid screening → identify which frames have prompt UIs
// ---------------------------------------------------------------------------

/**
 * For each candidate time range, extracts evenly-spaced frames at low resolution,
 * builds a contact-sheet grid, and sends it to the VL model to identify which
 * specific frames actually contain visible AI prompt UIs.
 *
 * Returns only the confirmed timestamps with their prompt types.
 */
export async function screenPromptFrames(
  options: ScreenPromptFramesOptions,
): Promise<ScreenedFrame[]> {
  const {
    videoPath,
    ranges,
    videoTitle,
    outputDir,
    model,
    targetLanguage = 'en',
    framesPerRange = 8,
  } = options;

  if (!ranges.length || !existsSync(videoPath)) return [];

  const resolvedModel = model || getEnvConfig().vlModel;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-screen-'));
  const screened: ScreenedFrame[] = [];
  const allOrientationVotes: Array<'portrait' | 'landscape'> = [];

  try {
    for (const range of ranges) {
      const duration = range.endSec - range.startSec;
      if (duration < 2) continue;

      // Extract evenly-spaced frames across the range
      const frameCount = Math.min(framesPerRange, Math.max(4, Math.round(duration / 3)));
      const step = duration / frameCount;
      const timestamps: number[] = [];
      for (let i = 0; i < frameCount; i++) {
        timestamps.push(Math.round((range.startSec + step * (i + 0.5)) * 100) / 100);
      }

      // Extract frames and build low-res grid
      const frames: ExtractedFrame[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const tSec = timestamps[i];
        const framePath = path.join(tempDir, `range-${range.startSec}-${i}.jpg`);
        try {
          const extracted = await extractFrameAt(videoPath, tSec, framePath, { quality: 2 });
          // Sharpen frame for better text readability in grid
          const sharpenedJpeg = await sharp(extracted.jpeg)
            .sharpen({ sigma: 1.5, m1: 1.5, m2: 0.7 })
            .toBuffer();
          frames.push({
            frameIndex: i,
            timestampSec: tSec,
            relativeSec: tSec - range.startSec,
            timestamp: formatTimestamp(tSec),
            sampleSource: 'uniform',
            jpeg: sharpenedJpeg,
            width: extracted.width,
            height: extracted.height,
          });
        } catch {
          continue;
        }
      }

      if (frames.length < 2) continue;

      // Deduplicate (pure dedup — identical frames dropped regardless of gap)
      const deduped = await removeNearDuplicateFrames(frames);
      if (deduped.length === 0) continue;

      // Build contact-sheet grid (tripled size for better VL model visibility)
      const videoWidth = deduped[0]?.width || 1280;
      const videoHeight = deduped[0]?.height || 720;
      const { buffer: gridBuffer } = await buildFrameGrid(deduped, videoWidth, videoHeight, 4800);

      // Send grid to VL model for screening
      const gridJpeg = await prepareVisionPng(gridBuffer, { maxDimension: 4800, maxBytes: 8 * 1024 * 1024 });
      const base64 = gridJpeg.toString('base64');

      const screenPrompt = buildScreeningPrompt(range, deduped, videoTitle, targetLanguage);

      try {
        const response = await chat({
          model: resolvedModel,
          context: { stage: 'media', task: 'prompt-detector-screening' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: screenPrompt },
              imagePartFromBase64(base64),
            ],
          }],
          temperature: 0.1,
          timeoutMs: 300_000,
        });

        const parsed = parseJsonObject(response.content);
        if (parsed && Array.isArray(parsed.frames)) {
          for (const item of parsed.frames) {
            const rawOri = String(item?.orientation || item?.aspectRatio || item?.aspect || '').toLowerCase().trim();
            if (rawOri === 'portrait' || rawOri.includes('port') || rawOri === 'vertical' || rawOri === '9:16' || rawOri === '3:4' || rawOri.includes('竖')) {
              allOrientationVotes.push('portrait');
            } else if (rawOri === 'landscape' || rawOri.includes('land') || rawOri === 'horizontal' || rawOri === '16:9' || rawOri === '4:3' || rawOri.includes('横') || rawOri.includes('宽')) {
              allOrientationVotes.push('landscape');
            }
          }

          // Sort candidate frames by confidence descending and take the single best frame per range
          const promptFrames = parsed.frames.filter((f: any) => typeof f.frameIndex === 'number' && f.hasPrompt === true);
          promptFrames.sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0));
          const best = promptFrames[0];
          if (best) {
            const idx = Math.max(0, Math.min(best.frameIndex, deduped.length - 1));
            const frame = deduped[idx];
            if (frame) {
              const bestType = String(best.promptType || '').toLowerCase().trim();
              const screenedType: 'image' | 'video' = bestType === 'video'
                ? 'video'
                : (bestType === 'image' ? 'image' : range.promptType);

              const bestRawOri = String(best.orientation || best.aspectRatio || best.aspect || '').toLowerCase().trim();
              let bestOri: 'portrait' | 'landscape' | undefined;
              if (bestRawOri === 'portrait' || bestRawOri.includes('port') || bestRawOri === 'vertical' || bestRawOri === '9:16' || bestRawOri === '3:4' || bestRawOri.includes('竖')) {
                bestOri = 'portrait';
              } else if (bestRawOri === 'landscape' || bestRawOri.includes('land') || bestRawOri === 'horizontal' || bestRawOri === '16:9' || bestRawOri === '4:3' || bestRawOri.includes('横') || bestRawOri.includes('宽')) {
                bestOri = 'landscape';
              }

              // Capture prompt text if VL was able to read it
              const promptText = best.prompt || best.promptText || best.text || '';

              if (promptText) {
                console.log(`[DEBUG] Stage 2 extracted prompt text (${promptText.length} chars): ${promptText.substring(0, 80)}...`);
              }

              screened.push({
                timestampSec: frame.timestampSec,
                promptType: screenedType,
                orientation: bestOri,
                confidence: typeof best.confidence === 'number' ? Math.min(1, Math.max(0, best.confidence)) : 0.7,
                prompt: promptText ? String(promptText) : undefined,
              });
            }
          }
        }
      } catch (err: any) {
        // If VL screening fails, try fallback model
        if (err instanceof LLMError || err instanceof HttpStatusError || err instanceof NonRetryableError) {
          const env = getEnvConfig();
          const fallbackModel = env.vlFallbackModel;
          
          if (fallbackModel && fallbackModel !== resolvedModel) {
            console.warn(`[WARN] Primary VL model failed for range ${range.startSec}-${range.endSec}, trying fallback: ${fallbackModel}`);
            try {
              const fallbackResponse = await chat({
                model: fallbackModel,
                context: { stage: 'media', task: 'prompt-detector-screening-fallback' },
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'text', text: screenPrompt },
                    imagePartFromBase64(base64),
                  ],
                }],
                temperature: 0.1,
                timeoutMs: 300_000,
              });

              const parsed = parseJsonObject(fallbackResponse.content);
              if (parsed && Array.isArray(parsed.frames)) {
                for (const item of parsed.frames) {
                  const rawOri = String(item?.orientation || item?.aspectRatio || item?.aspect || '').toLowerCase().trim();
                  if (rawOri === 'portrait' || rawOri.includes('port') || rawOri === 'vertical' || rawOri === '9:16' || rawOri === '3:4' || rawOri.includes('竖')) {
                    allOrientationVotes.push('portrait');
                  } else if (rawOri === 'landscape' || rawOri.includes('land') || rawOri === 'horizontal' || rawOri === '16:9' || rawOri === '4:3' || rawOri.includes('横') || rawOri.includes('宽')) {
                    allOrientationVotes.push('landscape');
                  }
                }

                const promptFrames = parsed.frames.filter((f: any) => typeof f.frameIndex === 'number' && f.hasPrompt === true);
                promptFrames.sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0));
                const best = promptFrames[0];
                if (best) {
                  const idx = Math.max(0, Math.min(best.frameIndex, deduped.length - 1));
                  const frame = deduped[idx];
                  if (frame) {
                    const bestType = String(best.promptType || '').toLowerCase().trim();
                    const screenedType: 'image' | 'video' = bestType === 'video'
                      ? 'video'
                      : (bestType === 'image' ? 'image' : range.promptType);

                    const bestRawOri = String(best.orientation || best.aspectRatio || best.aspect || '').toLowerCase().trim();
                    let bestOri: 'portrait' | 'landscape' | undefined;
                    if (bestRawOri === 'portrait' || bestRawOri.includes('port') || bestRawOri === 'vertical' || bestRawOri === '9:16' || bestRawOri === '3:4' || bestRawOri.includes('竖')) {
                      bestOri = 'portrait';
                    } else if (bestRawOri === 'landscape' || bestRawOri.includes('land') || bestRawOri === 'horizontal' || bestRawOri === '16:9' || bestRawOri === '4:3' || bestRawOri.includes('横') || bestRawOri.includes('宽')) {
                      bestOri = 'landscape';
                    }

                    // Capture prompt text if VL was able to read it
                    const promptText = best.prompt || best.promptText || best.text || '';

                    if (promptText) {
                      console.log(`[DEBUG] Stage 2 fallback extracted prompt text (${promptText.length} chars): ${promptText.substring(0, 80)}...`);
                    }

                    screened.push({
                      timestampSec: frame.timestampSec,
                      promptType: screenedType,
                      orientation: bestOri,
                      confidence: typeof best.confidence === 'number' ? Math.min(1, Math.max(0, best.confidence)) : 0.7,
                      prompt: promptText ? String(promptText) : undefined,
                    });
                  }
                }
              }
              continue; // Fallback succeeded, move to next range
            } catch (fallbackErr: any) {
              console.warn(`[WARN] Fallback VL model also failed for range ${range.startSec}-${range.endSec}: ${fallbackErr.message}`);
            }
          }
          
          // Both primary and fallback failed
          throw new AppError({
            code: ErrorCodes.VL_MODEL_FAILED,
            message: `VL model screening failed for range ${range.startSec}-${range.endSec}: ${err.message}`,
            stage: 'research',
            task: 'screen-prompt-frames',
            retryable: false,
            cause: err,
          });
        }
        continue;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return Object.assign(screened, { orientationVotes: allOrientationVotes });
}

function buildScreeningPrompt(
  range: PromptTimeRange,
  frames: ExtractedFrame[],
  videoTitle: string,
  targetLanguage: string,
): string {
  const frameList = frames
    .map((f, i) => `  Frame #${i}: ${f.timestamp} (${f.timestampSec}s)`)
    .join('\n');

  return `Analyze each frame in this grid. For EACH frame, try to READ the AI generation prompt text visible on screen, and identify whether the visual content orientation is portrait or landscape.

Video: "${videoTitle}"
Time range: ${formatTimestamp(range.startSec)} - ${formatTimestamp(range.endSec)}
Expected type: ${range.promptType}

Frames in grid:
${frameList}

For each frame:
1. Try to read the prompt text if visible
2. If no text readable, set hasPrompt=false
3. Identify visual orientation of the video/content shown or intended in the tool: "portrait" (竖屏, e.g. 9:16, 3:4, Shorts/TikTok/vertical format) or "landscape" (宽屏, e.g. 16:9, 4:3, horizontal/widescreen format).

Return JSON:
{ "frames": [
  { "frameIndex": 0, "hasPrompt": true, "promptType": "${range.promptType}", "orientation": "portrait", "prompt": "extracted text", "confidence": 0.7 },
  { "frameIndex": 1, "hasPrompt": false, "orientation": "portrait" }
] }

Return ONLY valid JSON.`;
}

// ---------------------------------------------------------------------------
// Stage 3: Removed - Stage 2 now reads prompt text directly from grid
// ---------------------------------------------------------------------------

/**
 * Converts Stage 2 screened frames to PromptRecognition format.
 * No VL calls needed - Stage 2 already extracted prompt text.
 */
export async function extractAndRecognizePrompts(
  videoPath: string,
  screened: ScreenedFrame[],
  outputDir: string,
  options?: {
    model?: string;
    targetLanguage?: string;
    transcript?: Transcript;
    retryLimit?: number;
  },
): Promise<PromptRecognition[]> {
  if (!screened.length) return [];

  const results: PromptRecognition[] = [];

  for (let i = 0; i < screened.length; i++) {
    const frame = screened[i];

    // Only include frames where Stage 2 was able to read prompt text
    if (frame.prompt && frame.prompt.length > 0) {
      let savedFramePath = '';
      if (videoPath && existsSync(videoPath)) {
        const frameFilename = `prompt-frame-${i}.jpg`;
        savedFramePath = path.join(outputDir, frameFilename);
        try {
          await extractFrameAt(videoPath, frame.timestampSec, savedFramePath, { quality: 2 });
        } catch {
          savedFramePath = '';
        }
      }
      results.push({
        segmentId: `prompt-${i}`,
        frameIndex: i,
        timestampSec: frame.timestampSec,
        relativeSec: frame.timestampSec,
        framePath: savedFramePath,
        found: true,
        prompt: frame.prompt,
        promptType: frame.promptType,
        orientation: frame.orientation,
        language: 'unknown',
        confidence: frame.confidence,
        isComplete: false,
        visibleText: frame.prompt,
        uiContext: '',
        uiDescription: EMPTY_UI_DESCRIPTION,
        channel: EMPTY_CHANNEL_REF,
        narration: '',
        settings: [],
        notes: 'Extracted by Stage 2 screening',
        attempts: 0,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Orchestrator: runs all 3 stages
// ---------------------------------------------------------------------------

export interface RunPromptDetectorOptions {
  videoPath: string;
  videoId: string;
  videoTitle: string;
  topic?: string;
  videoDurationSec: number;
  transcript: Transcript;
  outputDir: string;
  model?: string;
  vlModel?: string;
  targetLanguage?: string;
}

/**
 * Runs the full 3-stage targeted prompt detection pipeline:
 * 1. LLM identifies prompt time ranges from transcript
 * 2. Low-res grid screening narrows to actual prompt frames
 * 3. High-res OCR extracts verbatim prompts with type classification
 */
export async function runPromptDetector(
  options: RunPromptDetectorOptions,
): Promise<PromptDetectorResult> {
  const {
    videoPath,
    videoId,
    videoTitle,
    topic,
    videoDurationSec,
    transcript,
    outputDir,
    model,
    vlModel,
    targetLanguage = 'en',
  } = options;

  const resolvedVlModel = vlModel || model || getEnvConfig().vlModel || 'unknown';

  const emptyResult: PromptDetectorResult = {
    ranges: [],
    screened: [],
    recognition: { videoId, model: resolvedVlModel, recognizedAt: new Date().toISOString(), frames: [] },
    locator: {
      videoId,
      hasPromptFrame: false,
      selectedFrames: [],
      analyzedAt: new Date().toISOString(),
      totalGridsAnalyzed: 0,
    } as unknown as PromptFrameLocator,
  };

  // Stage 1: LLM identifies time ranges where prompts are likely visible
  const ranges = await detectPromptRanges({
    transcript,
    videoDurationSec,
    videoTitle,
    topic,
    model,
  });

  if (ranges.length === 0) return emptyResult;

  // Stage 2: Screen low-res grids from those ranges
  const screened = await screenPromptFrames({
    videoPath,
    ranges,
    videoTitle,
    outputDir,
    model: vlModel,
    targetLanguage,
  });

  if (screened.length === 0) {
    const rawVotes = (screened as any).orientationVotes || [];
    const voteDec = determineOrientationFromVotes(rawVotes);
    return {
      ...emptyResult,
      ranges,
      detectedOrientation: rawVotes.length > 0 ? voteDec.orientation : undefined,
      orientationVotes: rawVotes.length > 0 ? { portrait: voteDec.portraitVotes, landscape: voteDec.landscapeVotes } : undefined,
    };
  }

  // Calculate majority orientation decision across all candidate image recognitions
  const rawVotes: Array<'portrait' | 'landscape'> = [
    ...((screened as any).orientationVotes || []),
    ...screened.map((s) => s.orientation).filter((o): o is 'portrait' | 'landscape' => Boolean(o)),
  ];
  const voteDecision = determineOrientationFromVotes(rawVotes);
  const detectedOrientation = rawVotes.length > 0 ? voteDecision.orientation : undefined;
  const orientationVotes = rawVotes.length > 0
    ? { portrait: voteDecision.portraitVotes, landscape: voteDecision.landscapeVotes }
    : undefined;

  // Stage 3: High-res OCR on confirmed frames
  const recognitionFrames = await extractAndRecognizePrompts(
    videoPath,
    screened,
    outputDir,
    { model: vlModel, targetLanguage, transcript },
  );

  // Filter to only found prompts
  const foundFrames = recognitionFrames.filter((f) => f.found && f.prompt);

  return {
    ranges,
    screened,
    recognition: {
      videoId,
      model: resolvedVlModel,
      recognizedAt: new Date().toISOString(),
      frames: foundFrames,
    },
    locator: {
      videoId,
      hasPromptFrame: foundFrames.length > 0,
      selectedFrames: foundFrames.map((f, i) => ({
        segmentId: f.segmentId,
        frameIndex: i,
        timestampSec: f.timestampSec,
        relativeSec: f.relativeSec,
        framePath: `prompt-frame-${i}.jpg`,
        gridPath: '',
        confidence: f.confidence,
        reason: `Stage 3 high-res OCR (type: ${f.promptType})`,
      })),
      analyzedAt: new Date().toISOString(),
      totalGridsAnalyzed: ranges.length,
    } as unknown as PromptFrameLocator,
    detectedOrientation,
    orientationVotes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Validation & Diagnostics
// ---------------------------------------------------------------------------

export interface VideoPromptValidationResult {
  hasVideoPrompts: boolean;
  hasImagePrompts: boolean;
  videoPrompts: VlExtractedPrompt[];
  imagePrompts: VlExtractedPrompt[];
  diagnosticMessage: string;
  source: 'vl_ocr' | 'none';
}

/**
 * Validates extracted prompts from a candidate video.
 * Checks for the presence of video generation prompts (promptType === 'video')
 * and image generation prompts (promptType === 'image').
 */
export function validateExtractedPrompts(
  vlPrompts?: VlExtractedPrompt[],
  videoInfo?: { videoId?: string; title?: string }
): VideoPromptValidationResult {
  const prompts = vlPrompts || [];
  const videoPrompts = prompts.filter((p) => p.promptType === 'video' && p.prompt && p.prompt.trim().length > 0);
  const imagePrompts = prompts.filter((p) => p.promptType === 'image' && p.prompt && p.prompt.trim().length > 0);

  const hasVideoPrompts = videoPrompts.length > 0;
  const hasImagePrompts = imagePrompts.length > 0;

  const vidTitle = videoInfo?.title ? `"${videoInfo.title}"` : 'Candidate video';
  const vidId = videoInfo?.videoId ? `[${videoInfo.videoId}]` : '';

  let diagnosticMessage = '';
  if (!hasVideoPrompts) {
    diagnosticMessage = `${vidTitle} ${vidId} contains NO AI video generation prompts (视频制作提示词). Found 0 video prompts, ${imagePrompts.length} image prompt(s).`;
  } else if (!hasImagePrompts) {
    diagnosticMessage = `${vidTitle} ${vidId} contains ${videoPrompts.length} video generation prompt(s), but NO static image prompts. Static keyframe image prompts will be automatically supplemented via LLM keyframe derivation.`;
  } else {
    diagnosticMessage = `${vidTitle} ${vidId} contains ${videoPrompts.length} video prompt(s) and ${imagePrompts.length} image prompt(s) ready for Flow prompt rewriting.`;
  }

  return {
    hasVideoPrompts,
    hasImagePrompts,
    videoPrompts,
    imagePrompts,
    diagnosticMessage,
    source: hasVideoPrompts || hasImagePrompts ? 'vl_ocr' : 'none',
  };
}

