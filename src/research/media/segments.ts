/**
 * Transcript-based video segmentation.
 *
 * Slices transcript cues into contiguous segments targeting ~120s each
 * (or configured target seconds), establishing the scene structure for downstream stages.
 */
import {
  type Segment,
  type SegmentsResult,
  type Transcript,
  type VideoCandidate,
} from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import { chat } from '../../llm/client.js';
import { extractJsonObject } from '../../llm/json.js';
import { getEnvConfig, type EnvConfig } from '../../env.js';

export const TARGET_SEGMENT_SECONDS = 120;
export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 8;
const TITLE_MAX_WORDS = 10;

/**
 * Derives a clean segment title from the opening cue text.
 */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/<[^>]+>/g, '').trim();
  const clause = (cleaned.split(/[,.;:!?]/)[0] ?? cleaned).trim();
  const words = clause.split(/\s+/).filter(Boolean);
  const kept = words.slice(0, TITLE_MAX_WORDS).join(' ');
  const title = words.length > TITLE_MAX_WORDS ? `${kept}…` : kept;

  // Title case conversion
  return title
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (char) => char.toUpperCase())
    .slice(0, 70);
}

/**
 * Truncates text to max length with ellipsis if needed.
 */
function truncateText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

/**
 * Rounds seconds to two decimal places.
 */
function roundSeconds(sec: number): number {
  return Math.round(sec * 100) / 100;
}

/**
 * Extracts chapters/timestamps from video description if present.
 */
export function extractChaptersFromDescription(
  description: string,
  totalDurationSec: number,
): Array<{ title: string; startSec: number; endSec: number }> {
  if (!description || typeof description !== 'string') return [];
  const lines = description.split('\n');
  const rawChapters: Array<{ title: string; startSec: number }> = [];
  const regex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—:]?\s*(.+)/;

  for (const line of lines) {
    const match = line.trim().match(regex);
    if (match) {
      const hours = match[1] ? parseInt(match[1], 10) : 0;
      const minutes = parseInt(match[2], 10);
      const seconds = parseInt(match[3], 10);
      const title = match[4].trim().replace(/^[-–—:]\s*/, '');
      const startSec = hours * 3600 + minutes * 60 + seconds;
      if (title.length > 0 && !isNaN(startSec)) {
        rawChapters.push({ title, startSec });
      }
    }
  }

  if (rawChapters.length < 2) return [];

  rawChapters.sort((a, b) => a.startSec - b.startSec);
  const result: Array<{ title: string; startSec: number; endSec: number }> = [];
  for (let i = 0; i < rawChapters.length; i++) {
    const curr = rawChapters[i];
    const next = rawChapters[i + 1];
    const endSec = next ? next.startSec : Math.max(curr.startSec + 15, totalDurationSec);
    result.push({
      title: deriveTitle(curr.title),
      startSec: curr.startSec,
      endSec: Math.min(totalDurationSec || endSec, endSec),
    });
  }
  return result;
}

/**
 * Builds structured narrative story scenes when transcript cues and chapters are unavailable
 * (e.g. music-driven animations, stickman battles, 3D document motion, skeleton clips).
 */
export function buildNarrativeFallbackSegments(
  video: VideoCandidate,
  targetSeconds: number = TARGET_SEGMENT_SECONDS,
): Segment[] {
  const durationSec = video.metrics?.durationSec || 120;
  const cleanTitle = video.title.replace(/[🔥⚡💥✨🎉🎬]/g, '').trim();
  const summarySnippet = (video.description || '').slice(0, 200).trim();

  const actCount = Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.round(durationSec / targetSeconds) || 3));
  const stepSec = Math.max(10, Math.round(durationSec / actCount));

  const narrativePhases = [
    { name: 'Opening Scene & Visual Hook', desc: 'Establishing the character, artistic style, and core tension.' },
    { name: 'Inciting Incident & Escalation', desc: 'The action accelerates with dynamic choreography and rising conflict.' },
    { name: 'Climactic Showdown & Peak Spectacle', desc: 'The high-intensity dramatic climax and decisive turning point.' },
    { name: 'Resolution & Cinematic Aftermath', desc: 'The aftermath of the encounter, memorable final payoff and closing frame.' },
  ];

  const segments: Segment[] = [];
  for (let i = 0; i < actCount; i++) {
    const phase = narrativePhases[i % narrativePhases.length];
    const startSec = i * stepSec;
    const endSec = Math.min(durationSec, (i + 1) * stepSec);
    const title = phase.name;
    const desc = `${cleanTitle} - Scene ${i + 1}: ${phase.desc} ${summarySnippet ? `Context: ${summarySnippet}` : ''}`.trim();

    segments.push({
      segmentId: `segment-${String(i + 1).padStart(3, '0')}`,
      index: i,
      title: deriveTitle(title),
      summary: truncateText(desc, 220),
      hasNarration: false,
      startSec,
      endSec,
      durationSec: roundSeconds(endSec - startSec),
      cueStart: 0,
      cueEnd: 0,
    });
  }
  return segments;
}

/**
 * Asks the LLM to analyze the full transcript and split it into semantically
 * coherent scene segments based on topic shifts, narrative beats, and content flow.
 */
export async function buildLlmSegments(options: {
  video: VideoCandidate;
  transcript: Transcript;
  targetSeconds?: number;
  model?: string;
  llmConfig?: EnvConfig;
}): Promise<SegmentsResult | null> {
  const { video, transcript, targetSeconds = TARGET_SEGMENT_SECONDS, model, llmConfig } = options;

  if (!transcript.cues || transcript.cues.length < 4) return null;

  const config = llmConfig || getEnvConfig();
  if (!config.baseUrl || !config.apiKey) return null;

  const durationSec = video.metrics.durationSec;
  const cueCount = transcript.cues.length;

  // Build condensed transcript text for the LLM
  // Cap at ~4000 chars to stay within context limits
  const maxChars = 4000;
  const fullText = transcript.cues
    .map((c, i) => `[${i}] ${formatTime(c[0])}-${formatTime(c[1])}: ${c[2]}`)
    .join('\n');

  const transcriptBlock = fullText.length > maxChars
    ? fullText.slice(0, maxChars) + '\n...[truncated]'
    : fullText;

  const targetCount = Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.round(durationSec / targetSeconds)));

  const systemPrompt = `You are a video editor and narrative analyst. Your task is to split a video transcript into natural scene segments.

RULES:
- Identify where the TOPIC or NARRATIVE shifts to a new subject, scene, or story beat.
- Each segment should be a coherent, self-contained scene — NOT a blind time-based chop.
- Target ${targetCount} segments (${MIN_SEGMENTS}-${MAX_SEGMENTS} allowed), but let the content dictate boundaries.
- Segments must cover the entire video with no gaps or overlaps.
- Each segment needs a short descriptive title (max 10 words) and a 1-sentence summary.
- NARRATION / VOICEOVER ASSESSMENT: Determine whether the video actually contains spoken voiceover commentary, narration, or character dialogue meant to be spoken aloud. Set top-level "hasNarration" to "y" if yes, or "n" if the video is non-verbal (pure instrumental music, ambient background sounds, silent, or text-only onscreen). In each scene, set "hasNarration" to "y" or "n".
`;

  const userPrompt = `Video: "${video.title}"
Channel: ${video.channelTitle}
Duration: ${durationSec}s | Total cues: ${cueCount}
Target segments: ~${targetCount}

TRANSCRIPT (with cue indices and timestamps):
${transcriptBlock}

Split this transcript into natural scene segments and assess spoken voiceover/narration. Return JSON:
{
  "hasNarration": "y | n",
  "scenes": [
    {
      "title": "Short descriptive scene title",
      "summary": "One sentence describing what happens in this scene.",
      "hasNarration": "y | n",
      "startCue": 0,
      "endCue": 15
    }
  ]
}

startCue and endCue are INCLUSIVE indices into the transcript cues array (0-based).
The last scene's endCue must be ${cueCount - 1}.
Return ONLY valid JSON.`;

  try {
    const response = await chat(
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model,
        context: { stage: 'media', task: 'scene-segmentation' },
        temperature: 0.2,
        timeoutMs: 180_000,
      },
      config,
    );

    const extracted = extractJsonObject(response.content);
    if (!extracted.ok || !extracted.value || typeof extracted.value !== 'object') {
      return null;
    }

    const val = extracted.value as {
      hasNarration?: string | boolean;
      scenes?: Array<{ title: string; summary: string; hasNarration?: string | boolean; startCue: number; endCue: number }>;
    };
    if (!Array.isArray(val.scenes) || val.scenes.length < 2) return null;

    const overallHasNarration = typeof val.hasNarration === 'boolean'
      ? val.hasNarration
      : String(val.hasNarration || '').trim().toLowerCase() === 'y';

    // Validate and convert to Segments
    const segments: Segment[] = [];
    for (let i = 0; i < val.scenes.length; i++) {
      const scene = val.scenes[i];
      const startCue = Math.max(0, Math.min(scene.startCue, cueCount - 1));
      const endCue = Math.max(startCue, Math.min(scene.endCue, cueCount - 1));
      const cues = transcript.cues.slice(startCue, endCue + 1);

      if (cues.length === 0) continue;

      const startSec = roundSeconds(cues[0][0]);
      const endSec = roundSeconds(Math.max(cues[cues.length - 1][1], cues[0][0] + 1));

      const sceneHasNarration = scene.hasNarration !== undefined
        ? (typeof scene.hasNarration === 'boolean' ? scene.hasNarration : String(scene.hasNarration).trim().toLowerCase() === 'y')
        : overallHasNarration;

      segments.push({
        segmentId: `segment-${String(i + 1).padStart(3, '0')}`,
        index: i,
        title: deriveTitle(scene.title || `Scene ${i + 1}`),
        summary: truncateText(scene.summary || '', 220),
        hasNarration: sceneHasNarration,
        startSec,
        endSec,
        durationSec: roundSeconds(endSec - startSec),
        cueStart: startCue,
        cueEnd: endCue,
      });
    }

    if (segments.length < 2) return null;

    return {
      videoId: video.videoId,
      targetSegmentSeconds: targetSeconds,
      hasNarration: segments.some((s) => s.hasNarration),
      segments,
    };
  } catch {
    return null;
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface BuildSegmentsOptions {
  video: VideoCandidate;
  transcript: Transcript;
  targetSeconds?: number;
  useLlm?: boolean;
  model?: string;
  llmConfig?: EnvConfig;
}

/**
 * Slices a video's transcript cues into contiguous scenes/segments.
 * When useLlm is true, tries LLM-based semantic segmentation first,
 * falling back to deterministic slicing if LLM fails or is unavailable.
 */
export async function buildSegments(options: BuildSegmentsOptions): Promise<SegmentsResult> {
  const {
    video,
    transcript,
    targetSeconds = TARGET_SEGMENT_SECONDS,
    useLlm,
    model,
    llmConfig,
  } = options;

  // 0. Try LLM-based semantic segmentation first
  if (useLlm && transcript && transcript.cues && transcript.cues.length >= 4) {
    const llmResult = await buildLlmSegments({ video, transcript, targetSeconds, model, llmConfig });
    if (llmResult && llmResult.segments.length >= MIN_SEGMENTS) {
      return llmResult;
    }
  }

  // 1. If transcript cues exist (>= 2 cues), slice cues
  if (transcript && transcript.cues && transcript.cues.length >= 2) {
    const durationSec = video.metrics.durationSec;
    const desiredCount = Math.round(durationSec / targetSeconds);
    const count = Math.min(
      transcript.cues.length,
      Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, desiredCount || MIN_SEGMENTS)),
    );

    const segments: Segment[] = [];

    for (let index = 0; index < count; index++) {
      const from = Math.floor((index * transcript.cues.length) / count);
      const to = Math.floor(((index + 1) * transcript.cues.length) / count);
      const cues = transcript.cues.slice(from, Math.max(to, from + 1));
      const first = cues[0];
      const last = cues[cues.length - 1];

      if (!first || !last) continue;

      const startSec = roundSeconds(first[0]);
      const endSec = roundSeconds(Math.max(last[1], first[0] + 1));
      const cueEnd = Math.max(to, from + 1) - 1;

      const fullText = cues.map((c) => c[2]).join(' ');

      segments.push({
        segmentId: `segment-${String(index + 1).padStart(3, '0')}`,
        index,
        title: deriveTitle(first[2]),
        summary: truncateText(fullText, 220),
        hasNarration: Boolean(fullText.trim().length > 0),
        startSec,
        endSec,
        durationSec: roundSeconds(endSec - startSec),
        cueStart: from,
        cueEnd,
      });
    }

    if (segments.length > 0) {
      return {
        videoId: video.videoId,
        targetSegmentSeconds: targetSeconds,
        hasNarration: segments.some((s) => s.hasNarration),
        segments,
      };
    }
  }

  // 2. Check if description has timestamps/chapters
  const durationSec = video.metrics?.durationSec || 120;
  const chapters = extractChaptersFromDescription(video.description || '', durationSec);
  if (chapters.length >= 2) {
    const segments: Segment[] = chapters.map((ch, index) => ({
      segmentId: `segment-${String(index + 1).padStart(3, '0')}`,
      index,
      title: ch.title,
      summary: truncateText(`${video.title} - ${ch.title}`, 220),
      hasNarration: false,
      startSec: ch.startSec,
      endSec: ch.endSec,
      durationSec: roundSeconds(ch.endSec - ch.startSec),
      cueStart: 0,
      cueEnd: 0,
    }));
    return {
      videoId: video.videoId,
      targetSegmentSeconds: targetSeconds,
      hasNarration: false,
      segments,
    };
  }

  // 3. Narrative structure segmentation for non-verbal animation videos without transcripts or chapters
  const fallbackSegments = buildNarrativeFallbackSegments(video, targetSeconds);
  if (fallbackSegments.length > 0) {
    return {
      videoId: video.videoId,
      targetSegmentSeconds: targetSeconds,
      hasNarration: false,
      segments: fallbackSegments,
    };
  }

  throw new AppError({
    code: ErrorCodes.SUBTITLE_NOT_AVAILABLE,
    message: `Cannot segment video "${video.title}" (${video.videoId}): no transcript cues or chapter metadata available to extract scenes`,
    stage: 'research',
    task: 'build-segments',
    retryable: false,
  });
}
