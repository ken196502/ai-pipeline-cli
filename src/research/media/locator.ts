/**
 * Vision-Language Prompt Frame Locator & Detail Recognition.
 *
 * Uses Gemini VL (via src/llm/client.ts) to:
 * 1. Inspect contact-sheet grid collages and locate keyframes containing AI prompts or settings.
 * 2. Extract full-resolution single frames at positively located timestamps.
 * 3. Perform character-accurate visual OCR to extract the complete prompt, settings, and UI context.
 * 4. Recover gracefully from incomplete/truncated JSON responses with iterative multi-turn repair prompts.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getEnvConfig } from '../../env.js';
import { chat, imagePartFromBase64, type ChatMessage } from '../../llm/client.js';
import type {
  FrameEvidence,
  PromptFrameLocation,
  PromptFrameLocator,
  PromptFrameRecognition,
  PromptRecognition,
  SegmentFrameEvidence,
  ChannelRef,
  Transcript,
  UiDescription,
} from '../contracts.js';
import { sanitizeNarrationText } from '../script/narration.js';
import {
  EMPTY_CHANNEL_REF,
  PromptFrameLocationSchema,
  PromptFrameLocatorSchema,
  PromptFrameRecognitionSchema,
  PromptRecognitionSchema,
} from '../contracts.js';
import { extractFrameAt, formatTimestamp, prepareVisionPng } from './frames.js';

export interface LocatePromptFrameOptions {
  segment: SegmentFrameEvidence;
  gridPath?: string;
  model?: string;
  videoTitle?: string;
  targetLanguage?: string;
  retryLimit?: number;
}

export interface LocatePromptFramesOptions {
  videoId: string;
  evidence: FrameEvidence;
  model?: string;
  videoTitle?: string;
  outputDir?: string;
  videoPath?: string | null;
  targetLanguage?: string;
  retryLimit?: number;
}

export interface RecognizePromptDetailOptions {
  segmentId: string;
  framePath: string;
  frameIndex: number;
  timestampSec: number;
  relativeSec: number;
  model?: string;
  targetLanguage?: string;
  transcriptCues?: Array<[number, number, string]>;
  expectedPromptType?: 'image' | 'video';
  retryLimit?: number;
}

export interface LocateAndRecognizeOptions {
  videoId: string;
  evidence: FrameEvidence;
  model?: string;
  outputDir: string;
  videoPath?: string | null;
  transcript?: Transcript;
  targetLanguage?: string;
  retryLimit?: number;
}

export function clean(value: unknown): string {
  return String(value ?? '').trim();
}

export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = clean(value).toLowerCase();
  if (['true', 'yes', '1', '是', '有', '找到', '包含'].includes(text)) return true;
  if (['false', 'no', '0', '否', '无', '未找到', '不包含'].includes(text)) return false;
  return null;
}

/**
 * Parses timestamp string or number into seconds.
 * Supports "SS.ss", "MM:SS.ss", "HH:MM:SS.ss".
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = clean(value).replace(',', '.');
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

export interface DetailedPromptRecognition {
  found: boolean;
  prompt: string;
  fullPrompt: string;
  promptType: 'image' | 'video';
  orientation?: 'portrait' | 'landscape';
  language: string;
  confidence: number;
  isComplete: boolean;
  visibleText: string;
  uiContext: string;
  uiDescription: UiDescription;
  channel: ChannelRef;
  narration?: string;
  settings: string[];
  subtitleEvidence: string[];
  notes: string;
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  return text ? [text] : [];
}

export function textField(value: any, names: string[]): string {
  for (const name of names) {
    const text = clean(value?.[name]);
    if (text) return text;
  }
  return '';
}

/** Normalizes the VL channel recognition (频道识别: name / @handle / platform). */
export function normalizeChannelRef(raw: any): ChannelRef {
  const source = raw?.channel ?? raw?.channelInfo ?? raw?.creator ?? raw?.频道 ?? null;
  const name = textField(source, ['name', 'channelName', 'channel_name', 'title', '频道', '频道名']) ||
    textField(raw, ['channelName', 'channel_name', 'creatorName']);
  const handle = textField(source, ['handle', 'username', 'user', 'atHandle', '账号', '用户名']);
  const platformRaw = textField(source, ['platform', 'site', '平台']).toLowerCase();
  let platform = '';
  if (platformRaw.includes('youtu')) platform = 'youtube';
  else if (platformRaw.includes('tiktok') || platformRaw.includes('抖音') || platformRaw.includes('douyin')) platform = 'tiktok';
  return { name, handle, platform };
}

export function normalizeConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed > 10 ? parsed / 100 : parsed > 1 ? parsed / 10 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

/** Normalizes the VL UI description (sidebar menu + main content area). */
export function normalizeUiDescription(raw: any): UiDescription {
  const source =
    raw?.uiDescription ?? raw?.ui_description ?? raw?.ui ?? raw?.界面描述 ?? raw?.界面 ?? null;
  const sidebar = stringList(
    (source && typeof source === 'object'
      ? source.sidebar ?? source.sidebarMenu ?? source.sidebar_menu ?? source.menu ?? source.menus ?? source.菜单 ?? source.侧边栏
      : undefined) ?? raw?.sidebarMenu ?? raw?.sidebar_menu ?? raw?.菜单 ?? raw?.侧边栏
  );
  return {
    summary:
      textField(source, ['summary', 'overview', 'description', 'desc', '概述', '描述']) ||
      textField(raw, ['uiSummary', 'ui_summary']),
    sidebar,
    mainContent: textField(source, [
      'mainContent',
      'main_content',
      'main',
      'content',
      'center',
      'contentArea',
      '内容区',
      '中间内容',
      '主内容',
    ]),
  };
}

export function normalizeDetailedRecognition(
  raw: any,
  fallbackPromptType: 'image' | 'video' = 'image',
): DetailedPromptRecognition {
  const prompt = textField(raw, ['prompt', 'fullPrompt', 'full_prompt', 'promptText', '提示词', '完整提示词']);
  const found = bool(raw?.found ?? raw?.promptFound ?? raw?.hasPrompt) ?? Boolean(prompt);

  const rawType = textField(raw, ['promptType', 'prompt_type', 'type', '类型']).toLowerCase().trim();
  let promptType: 'image' | 'video' = fallbackPromptType;
  if (rawType === 'video' || rawType.startsWith('vid') || rawType === 'animation' || rawType === 'i2v' || rawType === 't2v') {
    promptType = 'video';
  } else if (rawType === 'image' || rawType.startsWith('img') || rawType === 't2i' || rawType === 'still') {
    promptType = 'image';
  } else if (rawType.includes('vid')) {
    promptType = 'video';
  } else if (rawType.includes('img') || rawType.includes('pic') || rawType.includes('photo')) {
    promptType = 'image';
  } else {
    promptType = fallbackPromptType;
  }

  const rawOri = textField(raw, ['orientation', 'aspectRatio', 'aspect_ratio', 'screenOrientation', '画面方向', '方向']).toLowerCase().trim();
  let orientation: 'portrait' | 'landscape' | undefined;
  if (rawOri === 'portrait' || rawOri.includes('port') || rawOri === 'vertical' || rawOri === '9:16' || rawOri === '3:4' || rawOri.includes('竖')) {
    orientation = 'portrait';
  } else if (rawOri === 'landscape' || rawOri.includes('land') || rawOri === 'horizontal' || rawOri === '16:9' || rawOri === '4:3' || rawOri.includes('横') || rawOri.includes('宽')) {
    orientation = 'landscape';
  }

  return {
    found,
    prompt: found ? prompt : '',
    fullPrompt: found ? prompt : '',
    promptType,
    orientation,
    language: textField(raw, ['language', 'lang', '语言']) || 'unknown',
    confidence: normalizeConfidence(raw?.confidence ?? raw?.score, found ? 0.5 : 0),
    isComplete: bool(raw?.isComplete ?? raw?.complete ?? raw?.完整) ?? Boolean(prompt),
    visibleText: textField(raw, ['visibleText', 'visible_text', 'rawText', 'evidence', '原文']) || prompt,
    uiContext: textField(raw, ['uiContext', 'ui_context', 'interface', 'application', '界面']),
    uiDescription: normalizeUiDescription(raw),
    channel: normalizeChannelRef(raw),
    narration: sanitizeNarrationText(textField(raw, ['narration', 'voiceover', 'voice_over', 'narrationScript', 'script', '旁白', '旁白稿', '解说词', '文案'])),
    settings: stringList(raw?.settings ?? raw?.parameters ?? raw?.参数),
    subtitleEvidence: stringList(raw?.subtitleEvidence ?? raw?.subtitle_evidence ?? raw?.字幕依据),
    notes: textField(raw, ['notes', 'note', 'reason', '说明']),
  };
}

/**
 * Parses JSON object even when wrapped in Markdown code fences or extra text.
 */
export function parseJsonObject<T = any>(content: string): T {
  const cleaned = clean(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    if (start < 0) {
      throw new Error('VL response did not contain a JSON object');
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(cleaned.slice(start, i + 1));
        }
      }
    }
    throw new Error('VL response contained an incomplete JSON object');
  }
}

/**
 * Extracts a complete string field from a JSON substring using regex.
 */
export function completeJsonStringField(value: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = value.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's'));
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return '';
  }
}

/**
 * Recovers essential fields from truncated or incomplete JSON frame locator output.
 */
export function recoverIncompleteFrameLocatorObject(content: string): any | null {
  const value = clean(content);
  const start = value.indexOf('{');
  if (start < 0) return null;
  const candidate = value.slice(start);

  const foundMatch = candidate.match(/"found"\s*:\s*(true|false)/i);
  if (!foundMatch) return null;
  const found = foundMatch[1]!.toLowerCase() === 'true';

  const frameMatch = candidate.match(/"frameIndex"\s*:\s*(-?\d+|null)/i);
  if (found && (!frameMatch || frameMatch[1]!.toLowerCase() === 'null')) return null;

  const confidenceMatch = candidate.match(/"confidence"\s*:\s*(-?\d+(?:\.\d+)?)/i);

  return {
    found,
    frameIndex: found ? Number(frameMatch![1]) : null,
    confidence: confidenceMatch ? Number(confidenceMatch[1]) : found ? 0.7 : 0,
    visibleText: completeJsonStringField(candidate, 'visibleText'),
    reason: completeJsonStringField(candidate, 'reason'),
  };
}

/**
 * Builds prompt for locating prompt keyframes within a contact-sheet collage.
 */
export function buildSegmentFrameLocationPrompt(
  segment: SegmentFrameEvidence,
  videoTitle = 'Video',
  targetLanguage = 'en',
): string {
  const framesList = segment.grid.frames
    .map(
      (f) =>
        `#${f.frameIndex} | timestamp=${f.timestamp} (${f.timestampSec.toFixed(2)}s) | source=${f.sampleSource}`,
    )
    .join('\n');

  return [
    'Inspect the numbered contact-sheet collage made from one video segment.',
    'The yellow tile labels (#index MM:SS.ss) are authoritative. frameIndex is zero-based.',
    'Locate the exact single frame where an AI-generation prompt, script section, settings block, or prompt card is most clearly visible in the application UI.',
    'Reject ordinary narration captions, face shots, browser chrome with no prompt, or final video playback when no prompt field is visible.',
    'If no tile visibly presents an AI prompt, return found=false and frameIndex=null.',
    'Return exactly one JSON object with no Markdown formatting:',
    JSON.stringify(
      {
        found: true,
        frameIndex: 0,
        confidence: 0.85,
        visibleText: 'short verbatim snippet visible in the prompt field',
        reason: `explanation of why this frame was chosen (${targetLanguage})`,
      },
      null,
      2,
    ),
    '',
    `Video Title: "${videoTitle}"`,
    `Segment ID: ${segment.segmentId} (${segment.startSec.toFixed(1)}s - ${segment.endSec.toFixed(1)}s)`,
    'Available collage tiles:',
    framesList,
  ].join('\n');
}

/**
 * Normalizes raw VL response into a valid PromptFrameLocation matching the schema.
 */
export function normalizeFrameLocatorResult(
  raw: any,
  segment: SegmentFrameEvidence,
  gridPath: string,
  attempts = 1,
): PromptFrameLocation {
  const frames = segment.grid.frames;
  const found = bool(raw?.found) ?? false;
  const rawIdx = typeof raw?.frameIndex === 'number' ? Math.round(raw.frameIndex) : null;
  const matchedFrame = rawIdx !== null ? (frames.find((f) => f.frameIndex === rawIdx) ?? null) : null;

  const validFound = found && matchedFrame !== null;
  const frameIndex = validFound && matchedFrame ? matchedFrame.frameIndex : null;
  const timestampSec = validFound && matchedFrame ? matchedFrame.timestampSec : null;
  const relativeSec = validFound && matchedFrame ? matchedFrame.relativeSec : null;
  const timestamp = validFound && matchedFrame ? matchedFrame.timestamp : null;

  let rawConf = Number(raw?.confidence);
  if (!Number.isFinite(rawConf)) rawConf = validFound ? 0.7 : 0.0;
  if (rawConf > 10) rawConf /= 100;
  else if (rawConf > 1) rawConf /= 10;
  const confidence = Math.max(0, Math.min(1, rawConf));

  return PromptFrameLocationSchema.parse({
    segmentId: segment.segmentId,
    found: validFound,
    frameIndex,
    timestampSec,
    relativeSec,
    timestamp,
    confidence,
    visibleText: String(raw?.visibleText ?? '').trim(),
    reason: String(raw?.reason ?? '').trim() || (validFound ? 'Identified prompt field' : 'No prompt field found'),
    gridPath,
    frameCount: frames.length,
    attempts,
  });
}

/**
 * Validates normalized frame locator output against domain rules.
 */
export function validateFrameLocatorResult(
  result: PromptFrameLocation,
  frames: SegmentFrameEvidence['grid']['frames'],
): string[] {
  const errors: string[] = [];
  if (typeof result.found !== 'boolean') errors.push('found must be boolean');
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    errors.push('confidence must be between 0 and 1');
  }
  if (result.found) {
    if (result.frameIndex === null || !frames.some((f) => f.frameIndex === result.frameIndex)) {
      errors.push('found=true requires a valid frameIndex from the supplied collage tiles');
    }
    if (result.timestampSec === null || !Number.isFinite(result.timestampSec) || result.timestampSec < 0) {
      errors.push('found=true requires a valid non-negative timestampSec');
    }
  } else if (result.frameIndex !== null || result.timestampSec !== null) {
    errors.push('found=false must not select a frame');
  }
  return errors;
}

/**
 * Formats a repair prompt when locator JSON response fails validation.
 */
export function locatorRepairPrompt(errors: string[], attempt: number): string {
  return [
    'The previous frame-location JSON failed validation.',
    `Repair attempt ${attempt}: return the complete corrected JSON object only.`,
    ...errors.map((error) => `- ${error}`),
    'Use only frameIndex values from the supplied collage tiles.',
    'Keep the JSON compact and include only found, frameIndex, confidence, visibleText, and reason.',
  ].join('\n');
}

/**
 * Uses Gemini VL to locate the prompt frame in a single segment contact-sheet collage
 * with iterative validation and repair prompts.
 */
export async function locatePromptFrame(
  options: LocatePromptFrameOptions,
): Promise<PromptFrameLocation> {
  const {
    segment,
    gridPath = segment.grid.path,
    model,
    videoTitle = 'Video',
    targetLanguage = 'en',
    retryLimit = 2,
  } = options;

  const resolvedModel = model || getEnvConfig().vlModel;

  if (!existsSync(gridPath)) {
    return normalizeFrameLocatorResult({ found: false }, segment, gridPath, 1);
  }

  const promptText = buildSegmentFrameLocationPrompt(segment, videoTitle, targetLanguage);
  const attemptsLimit = retryLimit + 1;

  try {
    const gridBuffer = await fs.readFile(gridPath);
    const optimizedGrid = await prepareVisionPng(gridBuffer, { maxDimension: 4800, maxBytes: 8 * 1024 * 1024 });
    const base64 = optimizedGrid.toString('base64');

    const baseMessages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          imagePartFromBase64(base64),
        ],
      },
    ];

    let messages = baseMessages;
    let lastErrors = ['No frame-location response produced'];

    for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
      const response = await chat({
        model: resolvedModel,
        messages,
        context: { stage: 'media', task: 'frame-locator' },
        temperature: 0.1,
        timeoutMs: 120_000,
      });

      let parsed: any = null;
      try {
        parsed = parseJsonObject(response.content);
      } catch (err: any) {
        if (/incomplete JSON object/i.test(err?.message || '')) {
          parsed = recoverIncompleteFrameLocatorObject(response.content);
        }
        if (!parsed) {
          lastErrors = [`Invalid JSON: ${err?.message || 'parse error'}`];
          if (attempt < attemptsLimit) {
            messages = [
              ...baseMessages,
              { role: 'assistant', content: response.content },
              { role: 'user', content: locatorRepairPrompt(lastErrors, attempt + 1) },
            ];
            continue;
          }
          throw err;
        }
      }

      const normalized = normalizeFrameLocatorResult(parsed, segment, gridPath, attempt);
      const errors = validateFrameLocatorResult(normalized, segment.grid.frames);

      if (errors.length === 0) {
        return normalized;
      }

      lastErrors = errors;
      if (attempt < attemptsLimit) {
        messages = [
          ...baseMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: locatorRepairPrompt(lastErrors, attempt + 1) },
        ];
      }
    }

    // Fallback if all repair attempts exhausted
    return normalizeFrameLocatorResult({ found: false }, segment, gridPath, attemptsLimit);
  } catch {
    // Graceful fallback for synthetic or offline scenarios
    return normalizeFrameLocatorResult(
      {
        found: false,
        frameIndex: null,
        confidence: 0,
        visibleText: '',
        reason: 'VL prompt localization skipped or unavailable',
      },
      segment,
      gridPath,
      1,
    );
  }
}

/**
 * Locates prompt frames across all segment grids in FrameEvidence,
 * and extracts individual high-res frames for confirmed matches.
 */
export async function locatePromptFrames(
  options: LocatePromptFramesOptions,
): Promise<PromptFrameLocator> {
  const {
    videoId,
    evidence,
    model,
    videoTitle = 'Video',
    outputDir = path.dirname(evidence.segments[0]?.grid.path || '.'),
    videoPath,
    targetLanguage = 'en',
    retryLimit,
  } = options;

  const resolvedModel = model || getEnvConfig().vlModel;
  const framesDir = path.join(outputDir, 'prompt-frames');
  await fs.mkdir(framesDir, { recursive: true });

  const locations: PromptFrameLocation[] = [];
  const selectedFrames: PromptFrameLocator['selectedFrames'] = [];

  for (const segment of evidence.segments) {
    const location = await locatePromptFrame({
      segment,
      gridPath: segment.grid.path,
      model: resolvedModel,
      videoTitle,
      targetLanguage,
      retryLimit,
    });
    locations.push(location);

    if (location.found && location.frameIndex !== null && location.timestampSec !== null) {
      let framePath = path.join(framesDir, `${segment.segmentId}-frame-${location.frameIndex}.jpg`);

      if (videoPath && existsSync(videoPath)) {
        try {
          await extractFrameAt(videoPath, location.timestampSec, framePath, { quality: 2 });
        } catch {
          framePath = location.gridPath;
        }
      } else {
        framePath = location.gridPath;
      }

      selectedFrames.push({
        segmentId: segment.segmentId,
        frameIndex: location.frameIndex,
        timestampSec: location.timestampSec,
        relativeSec: location.relativeSec ?? 0,
        timestamp: location.timestamp ?? formatTimestamp(location.timestampSec),
        confidence: location.confidence,
        framePath,
        gridPath: location.gridPath,
      });
    }
  }

  const result: PromptFrameLocator = {
    videoId,
    model: resolvedModel,
    locatedAt: new Date().toISOString(),
    segments: locations,
    selectedFrames,
    hasPromptFrame: selectedFrames.length > 0,
  };

  return PromptFrameLocatorSchema.parse(result);
}

/**
 * Builds OCR and prompt detail recognition prompt for a single high-res keyframe.
 */
export function buildDetailedRecognitionPrompt(options: {
  segmentId: string;
  frameIndex: number;
  timestampSec: number;
  targetLanguage?: string;
  transcriptCues?: Array<[number, number, string]>;
  expectedPromptType?: 'image' | 'video';
}): string {
  const { segmentId, frameIndex, timestampSec, targetLanguage = 'en', transcriptCues = [], expectedPromptType } = options;

  const relevantCues = transcriptCues
    .filter(([start, end]) => timestampSec >= start - 5 && timestampSec <= end + 5)
    .map(([s, e, text]) => `[${formatTimestamp(s)} - ${formatTimestamp(e)}] ${text}`)
    .join('\n');

  return [
    'Perform high-fidelity OCR and visual recognition on the attached keyframe extracted from a video interface.',
    'Extract the exact AI generation prompt, image/video instructions, or parameter block visible in the application UI.',
    'Preserve original wording, punctuation, line breaks, model names, and parameter tokens verbatim.',
    'Do not translate, summarize, or fix typos in the prompt text. Exclude video player subtitles unless they are part of the prompt field.',
    'If no prompt is legible or visible, return found=false and prompt="".',
    '',
    `Segment: ${segmentId} | Frame #${frameIndex} | Timestamp: ${formatTimestamp(timestampSec)}`,
    expectedPromptType ? `Screened Candidate Type: ${expectedPromptType}\n` : '',
    relevantCues
      ? [
          'SUBTITLE / TRANSCRIPT CONTEXT (the video creator\'s narration around this timestamp):',
          relevantCues,
          '',
          'These subtitles describe what the creator is doing on screen. They provide helpful context for understanding the prompt purpose.',
          'For example, if the subtitle says "let\'s generate this image in Midjourney", the prompt type is "image".',
          'If it says "I\'ll use Kling to animate the video", the type is "video".',
          '',
        ].join('\n')
      : 'No subtitle/transcript context available for this timestamp. Rely on visual UI cues only.\n',
    'GUIDANCE ON PROMPT CLASSIFICATION ("image" vs "video"):',
    'Classify each recognized prompt into one of two categories based on its generative purpose:',
    '',
    '  - "image": Text-to-Image / static keyframe generation prompt.',
    '    Purpose: Generates a single visual keyframe. Describes subject appearance, poses, postures (e.g. warrior running forward, dragon diving, character leaping, sitting, smiling), composition, environment, lighting, and art style.',
    '    Common platforms: Midjourney, DALL-E, Stable Diffusion, Flux, Leonardo AI, Ideogram, Firefly, etc., or an LLM writing an image prompt.',
    '',
    '  - "video": Image-to-Video or Text-to-Video generation prompt.',
    '    Purpose: Generates or animates video frames across time. Directs camera movement (pan, tilt, zoom, dolly-in, orbital tracking), speed, temporal evolution, and animation physics.',
    '    Common platforms: Runway, Kling, Sora, Veo, Luma Dream Machine, Pika, Hailuo/MiniMax, PixVerse, etc., or an LLM writing video motion directives.',
    '',
    'Return exactly one JSON object with no Markdown formatting:',
    JSON.stringify(
      {
        found: true,
        prompt: 'verbatim prompt text from UI',
        promptType: 'image',
        orientation: 'portrait',
        language: 'en',
        confidence: 0.9,
        isComplete: true,
        visibleText: 'exact raw text snippet seen in frame',
        uiContext: 'software application and field name (e.g. Midjourney Discord, Runway Gen-2)',
        uiDescription: {
          summary: 'short description of the tool interface shown in the frame',
          sidebar: ['sidebar / navigation menu item 1', 'sidebar / navigation menu item 2'],
          mainContent:
            'what the main (center) content area shows: prompt input field, canvas, timeline, result grid, buttons...',
        },
        channel: {
          name: 'channel / creator name visible in the frame (channel bar, watermark, intro overlay)',
          handle: '@handle if visible',
          platform: 'youtube | tiktok | unknown',
        },
        narration: 'verbatim voiceover or story narration script (旁白稿) if visible in the UI/document, or empty string',
        settings: ['ratio 16:9', 'motion 5'],
        notes: `explanation in ${targetLanguage}`,
      },
      null,
      2,
    ),
    '',
    'Identify "orientation" as either "portrait" (竖屏, e.g. 9:16 or 3:4 vertical content) or "landscape" (宽屏, e.g. 16:9 or 4:3 widescreen content).',
    'ALWAYS fill "uiDescription" (even when found=false): describe the tool UI visible in the frame —',
    '- "sidebar": every item of the left sidebar / navigation menu, one string per item (top to bottom)',
    '- "mainContent": what the main (center) content area contains (prompt field, canvas, timeline, result grid, settings panel, buttons...)',
    '- "summary": one short sentence naming the application and the overall layout',
    'ALWAYS fill "channel" too (频道识别): when a channel/creator identity is visible anywhere in the frame (channel name, @handle, subscribe/follow bar, watermark, intro overlay), report its name, handle and platform. Use empty strings when truly nothing is visible.',
    'CHECK FOR NARRATION / VOICEOVER SCRIPT (旁白稿识别): if there is any story script, voiceover dialogue, narration lines, or voiceover column visible in the UI (e.g. ChatGPT/Claude story script, Notion table, prompt with voiceover), extract it verbatim into "narration". Otherwise, set "narration" to "".',
  ].join('\n');
}

/**
 * Validates detailed prompt OCR recognition result.
 */
export function validateDetailedRecognition(
  result: {
    found: boolean;
    prompt: string;
    isComplete: boolean;
    settings?: any;
    confidence: number;
    uiDescription?: any;
  },
  maxPromptLength = 10000,
): string[] {
  const errors: string[] = [];
  if (typeof result.found !== 'boolean') errors.push('found must be boolean');
  if (result.found) {
    if (!result.prompt.trim()) errors.push('found=true requires a non-empty prompt');
    if (result.prompt.length > maxPromptLength) errors.push(`prompt exceeds maxPromptLength (${maxPromptLength})`);
    if (typeof result.isComplete !== 'boolean') errors.push('isComplete must be boolean');
  } else if (result.prompt.trim()) {
    errors.push('found=false must not include prompt text');
  }
  if (result.settings && !Array.isArray(result.settings)) {
    errors.push('settings must be an array of strings');
  }
  if (result.uiDescription && !Array.isArray(result.uiDescription.sidebar)) {
    errors.push('uiDescription.sidebar must be an array of strings');
  }
  return errors;
}

/**
 * Formats a repair prompt when detailed OCR JSON response fails validation.
 */
export function detailedRepairPrompt(errors: string[], attempt: number): string {
  return [
    'The previous detailed-recognition JSON failed validation.',
    `Repair attempt ${attempt}: return the complete corrected JSON object only.`,
    ...errors.map((error) => `- ${error}`),
    'Copy only text visible in the attached frame and return exactly one valid JSON object.',
  ].join('\n');
}

/**
 * Performs full OCR recognition on an extracted prompt frame with retry and repair loops.
 */
export async function recognizePromptDetail(
  options: RecognizePromptDetailOptions,
): Promise<PromptRecognition> {
  const {
    segmentId,
    framePath,
    frameIndex,
    timestampSec,
    relativeSec,
    model,
    targetLanguage = 'en',
    transcriptCues = [],
    expectedPromptType,
    retryLimit = 2,
  } = options;

  const resolvedModel = model || getEnvConfig().vlModel;

  if (!existsSync(framePath)) {
    return PromptRecognitionSchema.parse({
      segmentId,
      frameIndex,
      timestampSec,
      relativeSec,
      framePath,
      found: false,
      prompt: '',
      language: 'unknown',
      confidence: 0,
      isComplete: false,
      visibleText: '',
      uiContext: '',
      settings: [],
      notes: 'Frame file not found on disk',
      attempts: 1,
    });
  }

  const promptText = buildDetailedRecognitionPrompt({
    segmentId,
    frameIndex,
    timestampSec,
    targetLanguage,
    transcriptCues,
    expectedPromptType,
  });

  const attemptsLimit = retryLimit + 1;

  try {
    const rawBuffer = await fs.readFile(framePath);
    const optimizedJpeg = await prepareVisionPng(rawBuffer, { maxDimension: 1920, maxBytes: 4 * 1024 * 1024 });
    const base64 = optimizedJpeg.toString('base64');

    const baseMessages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          imagePartFromBase64(base64),
        ],
      },
    ];

    let messages = baseMessages;
    let lastErrors = ['No detailed recognition response produced'];

    for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
      const response = await chat({
        model: resolvedModel,
        messages,
        context: { stage: 'media', task: 'detailed-recognition' },
        temperature: 0.1,
        timeoutMs: 120_000,
      });

      let parsed: any = null;
      try {
        parsed = parseJsonObject(response.content);
      } catch (err: any) {
        lastErrors = [`Invalid JSON: ${err?.message || 'parse error'}`];
        if (attempt < attemptsLimit) {
          messages = [
            ...baseMessages,
            { role: 'assistant', content: response.content },
            { role: 'user', content: detailedRepairPrompt(lastErrors, attempt + 1) },
          ];
          continue;
        }
        throw err;
      }

      const normalized = normalizeDetailedRecognition(parsed, expectedPromptType || 'image');

      const errors = validateDetailedRecognition({
        found: normalized.found,
        prompt: normalized.prompt,
        isComplete: normalized.isComplete,
        settings: normalized.settings,
        confidence: normalized.confidence,
      });

      if (errors.length === 0) {
        return PromptRecognitionSchema.parse({
          segmentId,
          frameIndex,
          timestampSec,
          relativeSec,
          framePath,
          found: normalized.found && normalized.prompt.length > 0,
          prompt: normalized.found ? normalized.prompt : '',
          promptType: normalized.promptType,
          orientation: normalized.orientation,
          language: normalized.language,
          confidence: normalized.confidence,
          isComplete: normalized.isComplete,
          visibleText: normalized.visibleText,
          uiContext: normalized.uiContext,
          uiDescription: normalized.uiDescription,
          channel: normalized.channel,
          narration: normalized.narration || '',
          settings: normalized.settings,
          notes: normalized.notes,
          attempts: attempt,
        });
      }

      lastErrors = errors;
      if (attempt < attemptsLimit) {
        messages = [
          ...baseMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: detailedRepairPrompt(lastErrors, attempt + 1) },
        ];
      }
    }

    // Return empty on failure
    return PromptRecognitionSchema.parse({
      segmentId,
      frameIndex,
      timestampSec,
      relativeSec,
      framePath,
      found: false,
      prompt: '',
      language: 'unknown',
      confidence: 0,
      isComplete: false,
      visibleText: '',
      uiContext: '',
      settings: [],
      notes: `Detailed recognition failed after ${attemptsLimit} attempt(s)`,
      attempts: attemptsLimit,
    });
  } catch {
    return PromptRecognitionSchema.parse({
      segmentId,
      frameIndex,
      timestampSec,
      relativeSec,
      framePath,
      found: false,
      prompt: '',
      language: 'unknown',
      confidence: 0,
      isComplete: false,
      visibleText: '',
      uiContext: '',
      settings: [],
      notes: 'Detailed OCR recognition skipped or unavailable',
      attempts: 1,
    });
  }
}

/**
 * End-to-end coordinator: locates keyframes from segment grids,
 * extracts frames, performs OCR recognition, and returns structured contracts.
 */
export async function locateAndRecognizePrompts(
  options: LocateAndRecognizeOptions,
): Promise<{ locator: PromptFrameLocator; recognition: PromptFrameRecognition }> {
  const {
    videoId,
    evidence,
    model,
    outputDir,
    videoPath,
    transcript,
    targetLanguage = 'en',
    retryLimit,
  } = options;

  const resolvedModel = model || getEnvConfig().vlModel;

  // 1. Locate frames across grids
  const locator = await locatePromptFrames({
    videoId,
    evidence,
    model: resolvedModel,
    outputDir,
    videoPath,
    targetLanguage,
    retryLimit,
  });

  // 2. Perform OCR on located frames
  const recognitionResults: PromptRecognition[] = [];

  for (const selected of locator.selectedFrames) {
    const recognized = await recognizePromptDetail({
      segmentId: selected.segmentId,
      framePath: selected.framePath,
      frameIndex: selected.frameIndex,
      timestampSec: selected.timestampSec,
      relativeSec: selected.relativeSec,
      model: resolvedModel,
      targetLanguage,
      transcriptCues: transcript?.cues,
      retryLimit,
    });
    recognitionResults.push(recognized);
  }

  const recognition: PromptFrameRecognition = {
    videoId,
    model: resolvedModel,
    recognizedAt: new Date().toISOString(),
    frames: recognitionResults,
  };

  return {
    locator,
    recognition: PromptFrameRecognitionSchema.parse(recognition),
  };
}
