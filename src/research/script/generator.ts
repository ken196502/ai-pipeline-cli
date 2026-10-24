/**
 * Flow Video Script Generator.
 *
 * Transforms research outputs (topic, winner video, segments, transcript cues)
 * into a multi-clip, Veo-optimized FlowVideoScript suitable for batch generation on Google Flow.
 *
 * Implements dual-engine prompt generation:
 * 1. LLM-guided distillation using Veo prompt engineering guidelines.
 * 2. Deterministic rule-based fallback when LLM is unconfigured, offline, or schema fails.
 */
import { AppError, ErrorCodes } from '../errors.js';
import { getEnvConfig, type EnvConfig } from '../../env.js';
import { chat, LLMError } from '../../llm/client.js';
import { extractJsonObject } from '../../llm/json.js';
import { notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';
import type { ResearchResult, Segment, Transcript, VlExtractedPrompt } from '../contracts.js';
import {
  type FlowClipPrompt,
  type FlowVideoScript,
  type ShotTransition,
  FlowClipPromptSchema,
  FlowVideoScriptSchema,
} from './contracts.js';
import { sanitizeNarrationText } from './narration.js';
import {
  buildDeterministicVeoPrompt,
  buildReorchestrationSystemPrompt,
  buildReorchestrationUserPrompt,
  deriveKeyframeFromVideoPrompt,
  enforceVisualStyleOnClips,
  expandMasterPlaceholders,
  extractDynamicVisualAesthetic,
  sanitizeClipsForSafetyPolicy,
  sanitizePromptForSafetyPolicy,
} from './prompts.js';
import {
  buildTransitionNote,
  inferTransition,
  lintContinuousChainPrompts,
  normalizeTransition,
  sanitizeVisualPromptForVideoEngine,
} from './shot-transition.js';

// Shot-transition annotation helpers live in ./shot-transition.js so the Flow
// generation planner (src/flow/clip-plan.ts) can reuse them without importing the
// LLM stack. Re-exported here for backward compatibility.
export {
  buildTransitionNote,
  inferTransition,
  lintContinuousChainPrompts,
  normalizeTransition,
  sanitizeVisualPromptForVideoEngine,
} from './shot-transition.js';

/**
 * Builds a style hint string from VL-extracted prompts for injection into context.
 * Uses the highest-confidence video prompt (most relevant for video generation),
 * falling back to image prompts if no video prompts found.
 */
function buildVlStyleHint(vlPrompts?: VlExtractedPrompt[]): string {
  if (!vlPrompts || vlPrompts.length === 0) return '';

  // Prefer video prompts (directly applicable), then image prompts (style reference)
  const videoPrompts = vlPrompts.filter((p) => p.promptType === 'video');
  const imagePrompts = vlPrompts.filter((p) => p.promptType === 'image');
  const candidates = videoPrompts.length > 0 ? videoPrompts : imagePrompts;

  if (candidates.length === 0) return '';

  // Pick the highest-confidence prompt
  const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
  return `Original source ${best.promptType} prompt from "${best.uiContext}": "${best.prompt}"`;
}

export interface GenerateScriptParams {
  runId: string;
  videoId: string;
  topic: string;
  videoTitle: string;
  videoSummary?: string;
  segments: Array<{
    segmentId?: string;
    id?: string;
    title?: string;
    summary?: string;
    startSec: number;
    endSec: number;
    cueStart?: number;
    cueEnd?: number;
    text?: string;
  }>;
  transcript?: Transcript;
  vlPrompts?: VlExtractedPrompt[];
  clipCount?: number;
  clipDuration?: 4 | 6 | 8 | 10;
  aspectRatio?: 'landscape' | 'portrait';
  model?: string;
  visualStyle?: string;
  useLlm?: boolean;
  llmConfig?: EnvConfig;
  /**
   * When true and no VL prompts were extracted from the reference video, synthesize
   * clips from segments/transcript instead of aborting. Strict callers (default false)
   * keep the NO_VIDEO_PROMPT_FOUND abort.
   */
  allowTranscriptSynthesis?: boolean;
}

/**
 * Extracts narration / voiceover text for a segment from transcript cues.
 */
export function extractSegmentNarration(
  segment: { startSec: number; endSec: number; cueStart?: number; cueEnd?: number },
  transcript?: Transcript
): string {
  if (!transcript || !Array.isArray(transcript.cues) || transcript.cues.length === 0) {
    return '';
  }

  // If cue indices are provided
  if (
    typeof segment.cueStart === 'number' &&
    typeof segment.cueEnd === 'number' &&
    segment.cueStart <= segment.cueEnd
  ) {
    return transcript.cues
      .slice(segment.cueStart, segment.cueEnd + 1)
      .map((c) => c[2])
      .join(' ')
      .trim();
  }

  // Fallback to timestamp matching
  const matchingCues = transcript.cues.filter(
    ([cStart, cEnd]) => cStart >= segment.startSec && cEnd <= segment.endSec
  );

  return matchingCues.map((c) => c[2]).join(' ').trim();
}

/**
 * Generates deterministic Flow clips from scenes and transcript cues.
 */
export function generateDeterministicClips(params: {
  topic: string;
  videoTitle: string;
  segments: GenerateScriptParams['segments'];
  transcript?: Transcript;
  vlPrompts?: VlExtractedPrompt[];
  clipDuration: 4 | 6 | 8 | 10;
  visualStyle?: string;
}): FlowClipPrompt[] {
  const duration = params.clipDuration;
  const context = `${params.topic} ${params.videoTitle}`;
  const vlHint = buildVlStyleHint(params.vlPrompts);
  const baseAesthetic = extractDynamicVisualAesthetic(
    params.topic,
    params.videoTitle,
    undefined,
    `${context} ${vlHint}`,
    params.visualStyle
  );

  const videoPrompts = (params.vlPrompts || []).filter((p) => p.promptType === 'video' && p.prompt && p.prompt.trim().length > 0);
  const imagePrompts = (params.vlPrompts || []).filter((p) => p.promptType === 'image' && p.prompt && p.prompt.trim().length > 0);
  const hasVideoWithoutImage = videoPrompts.length > 0 && imagePrompts.length === 0;

  const segments = params.segments || [];
  if (segments.length === 0) {
    const imgPrompt = hasVideoWithoutImage
      ? deriveKeyframeFromVideoPrompt(videoPrompts[0].prompt, baseAesthetic.styleAesthetic, baseAesthetic.environmentLighting)
      : baseAesthetic.imagePrompt;

    const singleClip = FlowClipPromptSchema.parse({
      clipIndex: 1,
      sceneId: 'scene-001',
      title: params.videoTitle || params.topic,
      startSec: 0,
      endSec: duration,
      durationSec: duration,
      imagePrompt: imgPrompt,
      endImagePrompt: baseAesthetic.endImagePrompt || `${imgPrompt} Concluding settled pose.`,
      visualPrompt: baseAesthetic.visualPrompt,
      cameraMovement: baseAesthetic.cameraMovement,
      subjectAction: `Visualizing ${params.videoTitle || params.topic}`,
      environmentLighting: baseAesthetic.environmentLighting,
      styleAesthetic: baseAesthetic.styleAesthetic,
      narrationCues: params.topic,
      transition: 'cut',
      transitionNote: buildTransitionNote('cut', { isFirst: true, title: params.videoTitle || params.topic }),
      estimatedCredits: 15,
      status: 'pending',
    });
    return enforceVisualStyleOnClips([singleClip], params.visualStyle);
  }

  const clips = params.segments.map((seg, idx) => {
    const clipIndex = idx + 1;
    const sceneId = seg.segmentId || seg.id || `scene-${String(clipIndex).padStart(3, '0')}`;
    const title = seg.title || `Scene ${clipIndex}`;
    const narration = seg.text || extractSegmentNarration(seg, params.transcript) || seg.summary || '';
    const prevSeg = idx > 0 ? params.segments[idx - 1] : undefined;
    const prevNarration = prevSeg
      ? prevSeg.text || extractSegmentNarration(prevSeg, params.transcript) || prevSeg.summary || ''
      : '';
    const transition = inferTransition({
      index: idx,
      previousNarration: prevNarration,
      narration,
      title,
    });
    const segContext = `${context} ${title} ${narration} ${vlHint}`;
    const dynamic = extractDynamicVisualAesthetic(params.topic, title, narration, segContext, params.visualStyle);

    // If candidate video has video prompts but no image prompts, derive and supplement imagePrompt
    const segImagePrompt = hasVideoWithoutImage
      ? deriveKeyframeFromVideoPrompt(videoPrompts[idx % videoPrompts.length].prompt, dynamic.styleAesthetic, dynamic.environmentLighting)
      : dynamic.imagePrompt;

    return FlowClipPromptSchema.parse({
      clipIndex,
      sceneId,
      title,
      startSec: Math.round(seg.startSec),
      endSec: Math.round(seg.startSec) + duration,
      durationSec: duration,
      imagePrompt: segImagePrompt,
      endImagePrompt: dynamic.endImagePrompt || `${segImagePrompt} Concluding settled posture.`,
      visualPrompt: dynamic.visualPrompt,
      cameraMovement: dynamic.cameraMovement,
      subjectAction: seg.summary || `Scene action for ${title}`,
      environmentLighting: dynamic.environmentLighting,
      styleAesthetic: dynamic.styleAesthetic,
      narrationCues: sanitizeNarrationText(narration).slice(0, 180),
      transition,
      transitionNote: buildTransitionNote(transition, {
        inferred: true,
        title,
        previousTitle: prevSeg?.title,
        isFirst: idx === 0,
      }),
      estimatedCredits: 15,
      status: 'pending',
    });
  });

  return enforceVisualStyleOnClips(clips, params.visualStyle);
}

export interface ReorchestrateParams {
  vlPrompts: VlExtractedPrompt[];
  topic: string;
  videoTitle: string;
  videoSummary?: string;
  targetClipCount?: number;
  clipDuration?: 4 | 6 | 8 | 10;
  aspectRatio?: 'landscape' | 'portrait';
  model?: string;
  visualStyle?: string;
  useLlm?: boolean;
  llmConfig?: EnvConfig;
  segments?: GenerateScriptParams['segments'];
}

/**
 * Deterministically re-orchestrates extracted prompts into N paired scene clips.
 */
export function deterministicReorchestratePrompts(params: {
  vlPrompts: VlExtractedPrompt[];
  topic: string;
  videoTitle: string;
  targetClipCount: number;
  clipDuration: 4 | 6 | 8 | 10;
  visualStyle?: string;
  segments?: GenerateScriptParams['segments'];
}): FlowClipPrompt[] {
  const { vlPrompts, topic, videoTitle, targetClipCount, clipDuration, visualStyle, segments = [] } = params;
  const imagePrompts = vlPrompts.filter((p) => p.promptType === 'image' && p.prompt && p.prompt.trim().length > 0);
  const videoPrompts = vlPrompts.filter((p) => p.promptType === 'video' && p.prompt && p.prompt.trim().length > 0);

  const clips: FlowClipPrompt[] = [];
  for (let i = 0; i < targetClipCount; i++) {
    const clipIndex = i + 1;
    const seg = segments[i];
    const prevSeg = i > 0 ? segments[i - 1] : undefined;
    const sceneId = seg?.segmentId || seg?.id || `scene-${String(clipIndex).padStart(3, '0')}`;
    const title = seg?.title || `Scene ${clipIndex}`;
    const transition = inferTransition({
      index: i,
      previousNarration: prevSeg?.text || prevSeg?.summary || '',
      narration: seg?.text || seg?.summary || '',
      title,
    });
    const baseAesthetic = extractDynamicVisualAesthetic(
      topic,
      title,
      seg?.summary || '',
      vlPrompts.map((p) => p.prompt).join(' '),
      visualStyle
    );

    // Select or derive imagePrompt (static keyframe)
    let imgPrompt = '';
    if (imagePrompts.length > 0) {
      imgPrompt = imagePrompts[i % imagePrompts.length].prompt;
    } else if (videoPrompts.length > 0) {
      imgPrompt = deriveKeyframeFromVideoPrompt(
        videoPrompts[i % videoPrompts.length].prompt,
        baseAesthetic.styleAesthetic,
        baseAesthetic.environmentLighting
      );
    } else {
      imgPrompt = baseAesthetic.imagePrompt;
    }

    // Select or derive visualPrompt (companion video prompt)
    let visPrompt = '';
    if (videoPrompts.length > 0) {
      visPrompt = videoPrompts[i % videoPrompts.length].prompt;
    } else if (imagePrompts.length > 0) {
      visPrompt = `${baseAesthetic.cameraMovement}. Dynamic motion bringing keyframe scene to life.`;
    } else {
      visPrompt = baseAesthetic.visualPrompt;
    }

    const finalImagePrompt = transition === 'cut' ? imgPrompt : '';
    const finalEndImagePrompt = transition === 'cut' ? (baseAesthetic.endImagePrompt || `${imgPrompt} Concluding frame showing completed motion.`) : '';

    clips.push(
      FlowClipPromptSchema.parse({
        clipIndex,
        sceneId,
        title,
        startSec: i * clipDuration,
        endSec: (i + 1) * clipDuration,
        durationSec: clipDuration,
        imagePrompt: finalImagePrompt,
        endImagePrompt: finalEndImagePrompt,
        visualPrompt: visPrompt,
        cameraMovement: baseAesthetic.cameraMovement,
        subjectAction: seg?.summary || `Visualizing ${title}`,
        environmentLighting: baseAesthetic.environmentLighting,
        styleAesthetic: baseAesthetic.styleAesthetic,
        narrationCues: seg?.text || '',
        transition,
        transitionNote: buildTransitionNote(transition, {
          inferred: true,
          title,
          previousTitle: prevSeg?.title,
          isFirst: i === 0,
        }),
        estimatedCredits: 15,
        status: 'pending',
      })
    );
  }

  return enforceVisualStyleOnClips(sanitizeClipsForSafetyPolicy(clips), visualStyle);
}

/**
 * Re-orchestrates successfully extracted prompts from a candidate video
 * into N scene clips, each with a paired static imagePrompt (图片提示词)
 * and companion visualPrompt (配套视频提示词).
 */
export async function reorchestrateExtractedPrompts(
  params: ReorchestrateParams
): Promise<FlowClipPrompt[]> {
  const { vlPrompts } = params;
  if (!vlPrompts || vlPrompts.length === 0) {
    throw new AppError({
      code: ErrorCodes.NO_VIDEO_PROMPT_FOUND,
      message: `Cannot re-orchestrate prompts: no AI generation prompts were extracted from candidate video "${params.videoTitle}".`,
      stage: 'research',
      task: 'reorchestrate-prompts',
      retryable: false,
    });
  }

  const duration = params.clipDuration || 4;
  const aspect = params.aspectRatio || 'landscape';
  const targetClipCount = params.targetClipCount && params.targetClipCount > 0
    ? params.targetClipCount
    : (params.segments && params.segments.length > 0 ? params.segments.length : Math.max(2, Math.min(vlPrompts.length, 8)));

  if (params.useLlm !== false) {
    const env = params.llmConfig || getEnvConfig();
    if (!env.baseUrl || !env.apiKey) {
      const err = new AppError({
        code: ErrorCodes.LLM_REQUEST_FAILED,
        message: 'LLM base URL or API key is not configured in environment (.env). Script re-orchestration requires LLM and fallback is forbidden to prevent masking problems.',
        stage: 'research',
        task: 'reorchestrate-prompts',
        retryable: false,
      });
      await notifyLlmUnavailableAndExit(err, { stage: 'research', task: 'reorchestrate-prompts', context: 'Prompt Re-orchestration' });
      throw err;
    }

    const clipTransitions: Array<'cut' | 'continuous'> = [];
    for (let i = 0; i < targetClipCount; i++) {
      if (i === 0) {
        clipTransitions.push('cut');
      } else {
        const seg = params.segments?.[i];
        const prevSeg = params.segments?.[i - 1];
        const t = inferTransition({
          index: i,
          previousNarration: prevSeg?.text || prevSeg?.summary || '',
          narration: seg?.text || seg?.summary || '',
          title: seg?.title,
        });
        clipTransitions.push(t);
      }
    }

    const systemPrompt = buildReorchestrationSystemPrompt({
      modelTarget: params.model,
      clipDuration: duration,
      targetClipCount,
      visualStyle: params.visualStyle,
    });
    const userPrompt = buildReorchestrationUserPrompt({
      vlPrompts,
      topic: params.topic,
      videoTitle: params.videoTitle,
      videoSummary: params.videoSummary,
      targetClipCount,
      clipDuration: duration,
      aspectRatio: aspect,
      modelTarget: params.model,
      clipTransitions,
      visualStyle: params.visualStyle,
    });

    let response;
    try {
      response = await chat(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          model: env.llmModel,
          context: { stage: 'script', task: 'reorchestrate-prompts' },
          temperature: 0.2,
          timeoutMs: 300_000,
        },
        env
      );
    } catch (chatErr: any) {
      const appErr = new AppError({
        code: ErrorCodes.LLM_REQUEST_FAILED,
        message: `LLM prompt re-orchestration failed: ${chatErr.message}. Fallback is forbidden to prevent masking problems.`,
        stage: 'research',
        task: 'reorchestrate-prompts',
        retryable: false,
        cause: chatErr,
      });
      await notifyLlmUnavailableAndExit(appErr, { stage: 'research', task: 'reorchestrate-prompts', context: 'Prompt Re-orchestration' });
      throw appErr;
    }

    const extracted = extractJsonObject(response.content);
    if (!extracted.ok || !extracted.value || typeof extracted.value !== 'object') {
      const parseErr = new AppError({
        code: ErrorCodes.LLM_RESPONSE_INVALID,
        message: `Failed to parse structured JSON from LLM prompt re-orchestration: ${response.content.slice(0, 300)}`,
        stage: 'research',
        task: 'reorchestrate-prompts',
        retryable: false,
      });
      await notifyLlmUnavailableAndExit(parseErr, { stage: 'research', task: 'reorchestrate-prompts', context: 'Prompt Re-orchestration Response' });
      throw parseErr;
    }

    const val = extracted.value as {
      hasNarration?: string | boolean;
      clips?: unknown[];
      characters?: Record<string, string>;
      backgrounds?: Record<string, string>;
    };
    if (!Array.isArray(val.clips) || val.clips.length === 0) {
      const emptyErr = new AppError({
        code: ErrorCodes.LLM_RESPONSE_INVALID,
        message: 'LLM prompt re-orchestration returned empty clips array',
        stage: 'research',
        task: 'reorchestrate-prompts',
        retryable: false,
      });
      await notifyLlmUnavailableAndExit(emptyErr, { stage: 'research', task: 'reorchestrate-prompts', context: 'Prompt Re-orchestration Response' });
      throw emptyErr;
    }

    const characters =
      val.characters && typeof val.characters === 'object' && !Array.isArray(val.characters)
        ? (val.characters as Record<string, string>)
        : undefined;

    const backgrounds =
      val.backgrounds && typeof val.backgrounds === 'object' && !Array.isArray(val.backgrounds)
        ? (val.backgrounds as Record<string, string>)
        : undefined;

    const overallHasNarration = typeof val.hasNarration === 'boolean'
      ? val.hasNarration
      : String(val.hasNarration || '').trim().toLowerCase() === 'y';

    const clips: FlowClipPrompt[] = [];
    let prevNarration = '';
    let prevTitle = '';
    for (let i = 0; i < val.clips.length; i++) {
      const rawClip = val.clips[i] as Record<string, unknown>;
      const clipTitle = String(rawClip.title || `Clip ${i + 1}`);

      let rawVisualPrompt = typeof rawClip.visualPrompt === 'string' ? rawClip.visualPrompt.trim() : '';
      if (!rawVisualPrompt) {
        throw new Error(`Re-orchestrated clip ${i + 1} ("${clipTitle}") missing companion video prompt (visualPrompt)`);
      }

      const transition = clipTransitions[i] ?? 'cut';

      let rawImagePrompt = typeof rawClip.imagePrompt === 'string' ? rawClip.imagePrompt.trim() : '';
      let finalEndImagePrompt = '';

      // Expand {character1}, {character2}, {background1}, {background2} placeholders across all prompt
      // fields to guarantee identical token specification (including absolute sizes / scale ratio).
      if (characters || backgrounds) {
        const masters = { characters, backgrounds };
        rawVisualPrompt = expandMasterPlaceholders(rawVisualPrompt, masters);
        rawImagePrompt = expandMasterPlaceholders(rawImagePrompt, masters);
        if (typeof rawClip.endImagePrompt === 'string') {
          rawClip.endImagePrompt = expandMasterPlaceholders(rawClip.endImagePrompt, masters);
        }
      }

      if (transition === 'cut') {
        if (!rawImagePrompt) {
          const fallbackAesthetic = extractDynamicVisualAesthetic(
            params.topic,
            clipTitle,
            String(rawClip.narrationCues || ''),
            rawVisualPrompt
          );
          rawImagePrompt = fallbackAesthetic.imagePrompt;
        }
        const rawEndImagePrompt = typeof rawClip.endImagePrompt === 'string' ? rawClip.endImagePrompt.trim() : '';
        finalEndImagePrompt = rawEndImagePrompt || `${rawImagePrompt} Settled concluding composition with motion completed.`;
      } else {
        // Continuous shot: physical continuity uses last frame of previous video; no new image prompts needed
        rawImagePrompt = '';
        finalEndImagePrompt = '';
      }

      const transitionNote = buildTransitionNote(transition, {
        inferred: true,
        title: clipTitle,
        previousTitle: prevTitle,
        isFirst: i === 0,
      });

      const rawClipHasNarration = rawClip.hasNarration !== undefined
        ? (typeof rawClip.hasNarration === 'boolean' ? rawClip.hasNarration : String(rawClip.hasNarration).trim().toLowerCase() === 'y')
        : overallHasNarration;
      const cleanNarration = rawClipHasNarration ? sanitizeNarrationText(String(rawClip.narrationCues || '')) : '';
      const finalHasNarration = Boolean(rawClipHasNarration && cleanNarration.length > 0);

      const clip = FlowClipPromptSchema.parse({
        clipIndex: typeof rawClip.clipIndex === 'number' ? rawClip.clipIndex : i + 1,
        sceneId: rawClip.sceneId || `scene-${String(i + 1).padStart(3, '0')}`,
        title: clipTitle,
        startSec: typeof rawClip.startSec === 'number' ? rawClip.startSec : i * duration,
        endSec: typeof rawClip.endSec === 'number' ? rawClip.endSec : (i + 1) * duration,
        durationSec: duration,
        transition,
        transitionNote,
        imagePrompt: rawImagePrompt,
        endImagePrompt: finalEndImagePrompt,
        visualPrompt: sanitizeVisualPromptForVideoEngine(rawVisualPrompt),
        cameraMovement: String(rawClip.cameraMovement || 'slow smooth camera movement'),
        subjectAction: String(rawClip.subjectAction || `Action for ${clipTitle}`),
        environmentLighting: String(rawClip.environmentLighting || 'cinematic lighting'),
        styleAesthetic: String(rawClip.styleAesthetic || 'cinematic visual style'),
        hasNarration: finalHasNarration,
        narrationCues: finalHasNarration ? cleanNarration : '',
        estimatedCredits: 15,
        status: 'pending',
      });
      clips.push(clip);
      prevNarration = finalHasNarration ? cleanNarration : '';
      prevTitle = clipTitle;
    }

    const sanitized = sanitizeClipsForSafetyPolicy(clips);
    const result = enforceVisualStyleOnClips(sanitized, params.visualStyle);
    if (characters) {
      (result as any).characters = characters;
    }
    if (backgrounds) {
      (result as any).backgrounds = backgrounds;
    }
    return result;
  }

  // Deterministic re-orchestration only when explicitly opted out with useLlm: false
  const deterministicClips = deterministicReorchestratePrompts({
    vlPrompts,
    topic: params.topic,
    videoTitle: params.videoTitle,
    targetClipCount,
    clipDuration: duration,
    visualStyle: params.visualStyle,
    segments: params.segments,
  });
  return deterministicClips;
}

/**
 * Normalizes input from either a full ResearchResult or explicit GenerateScriptParams.
 */
function normalizeInput(
  input: ResearchResult | GenerateScriptParams,
  options?: Partial<GenerateScriptParams>
): GenerateScriptParams {
  if ('selected' in input) {
    // It is a ResearchResult
    const rr = input as ResearchResult;
    const visualStyle = options?.visualStyle || rr.visualStyle || rr.selected?.visualStyle;
    return {
      runId: rr.runId,
      videoId: rr.selected.videoId,
      topic: rr.topic,
      videoTitle: rr.selected.title,
      videoSummary: rr.selected.description?.slice(0, 300),
      segments: rr.segments,
      transcript: rr.transcript,
      vlPrompts: rr.vlPrompts,
      clipDuration: options?.clipDuration ?? 4,
      aspectRatio: options?.aspectRatio ?? 'landscape',
      model: options?.model ?? 'lite',
      visualStyle,
      useLlm: options?.useLlm ?? true,
      llmConfig: options?.llmConfig,
      allowTranscriptSynthesis: options?.allowTranscriptSynthesis ?? false,
    };
  }

  // It is GenerateScriptParams
  return {
    ...input,
    ...options,
    clipDuration: options?.clipDuration ?? input.clipDuration ?? 4,
    aspectRatio: options?.aspectRatio ?? input.aspectRatio ?? 'landscape',
    model: options?.model ?? input.model ?? 'lite',
    visualStyle: options?.visualStyle ?? input.visualStyle,
    useLlm: options?.useLlm ?? input.useLlm ?? true,
    allowTranscriptSynthesis: options?.allowTranscriptSynthesis ?? input.allowTranscriptSynthesis ?? false,
  };
}

/**
 * Main Entrypoint: Generates a validated FlowVideoScript.
 */
export async function generateFlowVideoScript(
  input: ResearchResult | GenerateScriptParams,
  options?: Partial<GenerateScriptParams>
): Promise<FlowVideoScript> {
  const params = normalizeInput(input, options);
  const clipDuration = params.clipDuration || 4;
  const aspectRatio = params.aspectRatio || 'landscape';
  const model = params.model || 'lite';
  const hasVlPrompts = params.vlPrompts && params.vlPrompts.length > 0;

  // When no VL prompts extracted from reference video, only abort when the caller
  // has not explicitly enabled transcript-synthesis mode.
  if (!hasVlPrompts && !params.allowTranscriptSynthesis) {
    throw new AppError({
      code: ErrorCodes.NO_VIDEO_PROMPT_FOUND,
      message: `Cannot generate video script: no AI generation prompts were extracted from reference video "${params.videoTitle}" (${params.videoId}).`,
      stage: 'research',
      task: 'generate-script',
      retryable: false,
    });
  }

  // Transcript-synthesis mode: no prompts were extracted from the reference video,
  // so build clips deterministically from topic + segments + transcript instead.
  if (!hasVlPrompts) {
    const synthesizedClips = generateDeterministicClips({
      topic: params.topic,
      videoTitle: params.videoTitle,
      segments: params.segments,
      transcript: params.transcript,
      vlPrompts: [],
      clipDuration,
      visualStyle: params.visualStyle,
    }).map((clip, idx) => ({
      ...clip,
      startSec: idx * clipDuration,
      endSec: (idx + 1) * clipDuration,
    }));

    const synthesizedScript: FlowVideoScript = {
      version: '1.0.0',
      runId: params.runId,
      videoId: params.videoId,
      topic: params.topic,
      aspectRatio,
      model,
      visualStyle: params.visualStyle,
      hasNarration: synthesizedClips.some((c) => c.hasNarration),
      totalClips: synthesizedClips.length,
      totalDurationSec: synthesizedClips.reduce((acc, c) => acc + c.durationSec, 0),
      totalCreditsEstimate: synthesizedClips.length * 15,
      clips: synthesizedClips,
      createdAt: new Date().toISOString(),
    };

    return FlowVideoScriptSchema.parse(synthesizedScript);
  }

  // Hand over extracted prompts to LLM to re-orchestrate into N segments of image prompts and companion video prompts
  const targetClipCount = params.clipCount && params.clipCount > 0
    ? params.clipCount
    : (params.segments && params.segments.length > 0 ? params.segments.length : Math.max(2, Math.min((params.vlPrompts || []).length, 5)));

  const clips = await reorchestrateExtractedPrompts({
    vlPrompts: params.vlPrompts || [],
    topic: params.topic,
    videoTitle: params.videoTitle,
    videoSummary: params.videoSummary,
    targetClipCount,
    clipDuration,
    aspectRatio,
    model,
    visualStyle: params.visualStyle,
    useLlm: params.useLlm !== false,
    llmConfig: params.llmConfig,
    segments: params.segments,
  });

  const totalClips = clips.length;
  const totalDurationSec = clips.reduce((acc, c) => acc + c.durationSec, 0);
  const totalCreditsEstimate = totalClips * 15;
  const scriptHasNarration = clips.some((c) => c.hasNarration);

  const script: FlowVideoScript = {
    version: '1.0.0',
    runId: params.runId,
    videoId: params.videoId,
    topic: params.topic,
    aspectRatio,
    model,
    visualStyle: params.visualStyle,
    characters: (clips as any)?.characters || undefined,
    backgrounds: (clips as any)?.backgrounds || undefined,
    hasNarration: scriptHasNarration,
    totalClips,
    totalDurationSec,
    totalCreditsEstimate,
    clips,
    createdAt: new Date().toISOString(),
  };

  return FlowVideoScriptSchema.parse(script);
}
