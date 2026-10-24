/**
 * LLM storyboard generation for commentary / tutorial videos
 * based on the OpusVideo procedural canvas engine.
 *
 * The model receives the reference video transcript cues, segmentation,
 * generated videos, still keyframe images, real browser operation step screenshots,
 * prompts, and available lucide icon names, and produces an ordered OpusVideo
 * storyboard:
 *   - clips: chapters (Overview, Step 1 Master Prompt, Step 2 Keyframe Image Generation, Step 3 Video Animation, Step 4 Assembly)
 *   - shots: visual shots with punchy left-column phrases paired with right-column visuals
 *   - narration: spoken natural language matching each element line 1:1
 */
import type { FlowClipPrompt } from '../research/script/contracts.js';
import { getEnvConfig, type EnvConfig } from '../env.js';
import { chat, LLMError, type ChatMessage } from '../llm/client.js';
import { decodeJson, repairJsonMessage } from '../llm/json.js';
import type { Segment, Transcript, VlExtractedPrompt } from '../research/contracts.js';
import {
  buildTutorialStoryboardSchema,
  collectStoryboardCoverageErrors,
  collectStoryboardDisplayErrors,
  collectStoryboardRefErrors,
  type TutorialAsset,
  type TutorialStoryboard,
} from './contracts.js';

export interface StoryboardGenerationParams {
  runId: string;
  videoId: string;
  topic: string;
  title: string;
  narrationLanguage: string;
  maxScenes: number;
  transcript: Pick<Transcript, 'language' | 'cues'>;
  segments?: Segment[];
  assets: TutorialAsset[];
  clips?: FlowClipPrompt[];
  iconNames: readonly string[];
  channelSpotlight?: import('../research/social/lookup.js').ChannelSpotlightResult;
  vlPrompts?: VlExtractedPrompt[];
  model?: string;
  llmConfig?: EnvConfig;
  maxAttempts?: number;
}

export interface StoryboardGenerationResult {
  storyboard: TutorialStoryboard;
  model: string;
  attempts: number;
}

function buildSystemPrompt(): string {
  return [
    'You are an expert video director and tutorial scriptwriter.',
    'You design AI tutorial videos (解说视频) that teach viewers step-by-step how a viral AI video was made.',
    'The tutorial is rendered using a modern procedural canvas video engine (OpusVideo) featuring:',
    '  - Chapters (clips) with big whip zoom transitions, background flood wipes, and title cards',
    '  - Shots with 2D affine camera interpolation',
    '  - Dual-column content:',
    '    * Left column: stacked punchy takeaway phrases with adaptive typography, number rail, and karaoke pop reveals',
    '    * Right column: dynamic visual card (AI-generated video clips, keyframe images, browser step screenshots, lucide icons, or data charts)',
    '',
    'Produce ONE valid JSON object (no markdown, no extra explanation) with this structure:',
    '{',
    '  "title": "Tutorial Main Title",',
    '  "subtitle": "Short descriptive subtitle",',
    '  "meta": {',
    '    "title": "Tutorial Main Title",',
    '    "subtitle": "Short descriptive subtitle",',
    '    "bg": "#0A0A0B",',
    '    "accent": "#FF4D12"',
    '  },',
    '  "clips": [',
    '    {',
    '      "id": "intro",',
    '      "kicker": "00 · OVERVIEW",',
    '      "title": "Short chapter title",',
    '      "subtitle": "Short chapter subtitle",',
    '      "bg": "#0A0A0B",',
    '      "shots": [',
    '        {',
    '          "id": "c0_s1",',
    '          "elements": [',
    '            ["Punchy phrase 1 (3-12 words)", "clip-001-video"],',
    '            ["Punchy phrase 2 (3-12 words)", "clip-001-image"],',
    '            ["Punchy phrase 3 (3-12 words)", "code"]',
    '          ],',
    '          "narration": [',
    '            "Full natural spoken narration sentence for line 1...",',
    '            "Full natural spoken narration sentence for line 2...",',
    '            "Full natural spoken narration sentence for line 3..."',
    '          ],',
    '          "camera": { "zoom": 1.0, "x": 0, "y": 0, "roll": 0 }',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    'Strict Rules:',
    '0. Grounding in THIS generated run (highest priority):',
    '   - generatedClips and their matching materials are the primary source of truth. Teach how these specific clips were made, naming their subjects and explaining concrete image-prompt and motion-prompt choices while showing the corresponding clipIndex asset.',
    '   - Reference subtitles, segments, extracted prompts and channel data are background inspiration only. Do not retell their script, sales pitch, tool workflow, clip count, earnings, popularity or account-switching advice.',
    '   - Give every generated clip a dedicated explanation with its own matching visual. Use the exact generated clip count. The transition field describes the incoming transition FROM the previous clip INTO this clip, never its outgoing transition. Explain cut versus continuous transitions faithfully: a cut physically generates a new keyframe image to make video, while a continuous transition physically reuses the previous clip video\'s ending last frame to make video, rather than writing transition directives into the video prompt.',
    '   - Only images explicitly marked derivedFrom=video-first-frame are extracted previews; other saved generated images are input keyframes. A video-first-frame image is a frame extracted from an output video, NOT evidence of an independently generated input keyframe.',
    '   - Prompts describe intended effects, not proof that every effect succeeded. Do not claim perfect consistency, seamless motion or unseen results or invent tool actions, master prompts, buttons, or verified geography facts. Present fictional map/portal imagery as creative visuals.',
    '   - Open with this run and its concrete visual concept; conclude with its actual generated result. Keep narration and on-screen phrases specific to the paired visual.',
    '1. Layout and Presentation:',
    '   - Dual-column content cards: the screen features a dual-column layout (left column phrases + right column visual container). Design between 1 and 3 columns of visual concepts per chapter.',
    '   - Chapter title card (the "title" scene): each chapter opens with a bold chapter title card featuring kicker and title.',
    '   - NEVER invent or paint HTML UI mocks — the tutorial never draws fake tool UIs. Tool operations are demonstrated with REAL page screenshots or lucide icons.',
    '',
    '2. Data Structure:',
    '   - "clips": ordered chapters covering the tutorial (e.g. Overview/Hook -> Step 1 Master Prompt -> Step 2 Keyframe Image Generation -> Step 3 Video Animation -> Step 4 Final Assembly).',
    '   - "kicker": chapter index tag (e.g. "00 · OVERVIEW", "01 · STEP 1", "02 · STEP 2").',
    '   - "shots": 1 to 4 shots per clip.',
    '   - "elements": an array of 2 to 4 entries [phraseText, visualRef].',
    '     * phraseText: a punchy, concise takeaway phrase (3-12 words in English) that will be displayed on the left column.',
    '     * visualRef: what to show on the right column. Must be:',
    '       - A material id from "materials" (kind "video" or "image", e.g. "clip-001-video", "clip-001-image", "browser-step-001", "channel-avatar")',
    '       - A prompt material id (kind "prompt", e.g. "clip-001-image-prompt", "clip-001-video-prompt") — rendered as an auto-scrolling terminal-style prompt card. Use it whenever you explain that clip\'s image prompt or motion prompt so viewers see the ACTUAL prompt text.',
    '       - An icon name from "icons" (e.g. "film", "sparkles", "code", "shapes", "camera", "monitor")',
    '       - A chart type ("bars", "line", "donut")',
    '   - "narration": an array of spoken sentences matching the "elements" array 1:1. Each narration sentence is spoken aloud via TTS when the corresponding phrase pops on screen!',
    '   - "camera": optional 2D camera settings { "zoom": number (0.9 - 1.2), "x": number (-40 to 40), "y": number (-30 to 30), "roll": number (-0.05 to 0.05) }.',
    '',
    '2. Visual Material Usage & Coverage:',
    '   - EVERY generated video material (kind "video", e.g. "clip-001-video") in "materials" MUST be referenced in at least one shot elements visualRef! The tutorial showcases the actual generated video clips.',
    '   - Output preview images (derivedFrom "video-first-frame", e.g. "clip-001-image") are extracted output frames — label them as output previews, not input keyframes.',
    '   - Real browser step screenshots (derivedFrom "browser-step", e.g. "browser-step-001") show the real tool operation — EVERY SINGLE UI screenshot in materials MUST appear in at least one shot elements visualRef! Never omit any UI screenshot.',
    '   - Prompt card and generated media pairing: When a shot displays a prompt material (kind "prompt", e.g. "clip-001-image-prompt" / "clip-001-video-prompt"), the OpusVideo engine automatically renders the prompt card side-by-side with its corresponding generated image or video (prompt card on one side, generated visual on the other, and the active phrase displayed as a bottom caption banner — NO stacked bullet list). Structure your phrases and narration to explain the prompt parameters and how they shaped the resulting visual.',
    '   - "channelSpotlight" holds channel facts verified via yt-dlp (follower counts / avatar). When "found" is true: make the OPENING hook scene feature the channel — put the "channel-avatar" image material in its visual column when present — and you MAY cite the verified follower number.',
    '   - When "found" is false or "missingNumbers" is true: NEVER list specific numbers (no follower counts, no exact view/like counts) — omit popularity and financial claims entirely.',
    '   - Distribute materials evenly; never repeat one material everywhere while others remain unused.',
    '   - Prompt coverage: every clip that carries prompt materials (e.g. "clip-001-image-prompt" / "clip-001-video-prompt") MUST reference at least one of its prompt materials in a shot element when you explain how that clip was prompted — the tutorial must actually display the generation prompts (auto-scrolling prompt cards).',
    '   - MANDATORY FINAL CHAPTER (Final AI Video Showcase): The tutorial MUST conclude with a final showcase chapter (e.g. title: "Final AI Video Showcase", kicker: "FINAL · AI SHOWCASE"). In the final clip\'s shot, you MUST reference the final video asset ("final-ai-video", or the generated AI video) in its elements visualRef so that the complete voiced AI video is played and showcased at the end of the tutorial!',
    '     * CRITICAL AUDIO & VISUAL RULE FOR FINAL SHOWCASE: The final AI video ("final-ai-video") ALREADY CONTAINS COMPLETE VOICE AND AUDIO! Therefore, NEVER generate voiceover narration that talks over the final video. In the final showcase shot, keep narration empty or minimal, and do NOT add decorative lucide icons that would displace or overwrite the final video display!',
    '',
    '3. Display Copy Rules:',
    '   - Arrow chains (->, =>, →) are strictly BANNED from all display copy. Each phrase must be a stand-alone punchy statement.',
    '   - Prompt materials are referenced ONLY by their material id. NEVER paste the full prompt text into phraseText, narration, kicker, title or subtitle — the prompt card component displays the actual text; your script must stay symbolic (e.g. "clip-001-image-prompt").',
    '   - STRICT ENGLISH ONLY: Write all phrases and narration strictly in English, matching what is visually demonstrated.',
    '   - NEVER invent timing or duration fields (no durationSec, no minDurationSec, no startSec, no endSec) — all timings are derived automatically from TTS word boundaries.',
    '',
    '4. STRICT ENGLISH LANGUAGE REQUIREMENT (NO MIXED CHINESE):',
    '   - ALL titles, subtitles, kickers, display copy phrases (phraseText), bullets, and voiceover narrations MUST be strictly written in clean, natural ENGLISH.',
    '   - ABSOLUTELY FORBIDDEN: Any Chinese characters (汉字) in titles, phrases, prompt cards, or voiceover narration.',
    '   - The entire video tutorial and text-to-speech audio must maintain a consistent, native English voice flow without language mixing.',
  ].join('\n');
}

function buildUserPrompt(params: StoryboardGenerationParams): string {
  const payload = {
    topic: params.topic,
    videoTitle: params.title,
    videoId: params.videoId,
    narrationLanguage: params.narrationLanguage || 'en',
    languageDirective: 'STRICT ENGLISH ONLY: all titles, kickers, phrases, and narrations must be in English. No Chinese characters.',
    maxScenes: params.maxScenes,
    maxClips: Math.max(3, Math.min(6, Math.ceil(params.maxScenes / 2))),
    generatedClips: (params.clips || []).map((clip) => ({
      clipIndex: clip.clipIndex,
      title: clip.title,
      transition: clip.transition,
      transitionNote: clip.transitionNote,
      planMode: (clip as FlowClipPrompt & { planMode?: string }).planMode,
      imagePrompt: clip.imagePrompt,
      visualPrompt: clip.visualPrompt,
      cameraMovement: clip.cameraMovement,
      subjectAction: clip.subjectAction,
      narrationCues: clip.narrationCues,
      videoAssetId: params.assets.find(a => a.kind === 'video' && a.clipIndex === clip.clipIndex)?.id,
      imageAssetId: params.assets.find(a => a.kind === 'image' && a.clipIndex === clip.clipIndex)?.id,
    })),
    referenceContextOnly: 'Subtitles, segments and extracted prompts describe the source video, not this generated run.',
    subtitles: params.transcript.cues.map(([start, end, text]) => ({ start, end, text })),
    segments: (params.segments || []).map((seg) => ({
      segmentId: seg.segmentId,
      title: seg.title,
      startSec: seg.startSec,
      endSec: seg.endSec,
      summary: seg.summary,
    })),
    materials: params.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      label: asset.label,
      clipIndex: asset.clipIndex,
      durationSec: asset.durationSec,
      promptText: asset.promptText,
      derivedFrom: asset.derivedFrom,
    })),
    extractedPromptsFromReferenceVideo: (params.vlPrompts || []).map((p) => ({
      type: p.promptType,
      uiContext: p.uiContext,
      prompt: p.prompt,
      uiDescription: p.uiDescription,
    })),
    icons: [...params.iconNames],
    channelSpotlight: params.channelSpotlight ?? {
      found: false,
      displayName: '',
      channels: [],
      missingNumbers: true,
    },
    task:
      'Generate the tutorial storyboard JSON with clips, shots, elements, and narration matching the OpusVideo procedural canvas engine.',
  };

  return JSON.stringify(payload, null, 2);
}

export function buildStoryboardMessages(params: StoryboardGenerationParams): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(params) },
  ];
}

/**
 * Generates and validates the tutorial storyboard with bounded repair turns.
 */
export async function generateTutorialStoryboard(
  params: StoryboardGenerationParams
): Promise<StoryboardGenerationResult> {
  const config = params.llmConfig || getEnvConfig();
  const schema = buildTutorialStoryboardSchema({
    assetIds: new Set(params.assets.map((a) => a.id)),
    iconNames: new Set(params.iconNames),
  });

  const messages: ChatMessage[] = [...buildStoryboardMessages(params)];
  const maxAttempts = params.maxAttempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await chat(
      {
        model: params.model,
        messages,
        temperature: 0.4,
        responseFormat: 'json_object',
        timeoutMs: 300_000,
        context: { stage: 'tutorial-gen', task: 'storyboard' },
      },
      config
    );

    try {
      const storyboard = decodeJson(response.content, schema, {
        stage: 'tutorial-gen',
        task: 'storyboard',
        preprocess: (value) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const obj = value as Record<string, unknown>;
            return {
              version: '2.0.0',
              runId: params.runId,
              videoId: params.videoId,
              topic: params.topic,
              title: params.title,
              narrationLanguage: params.narrationLanguage,
              ...obj,
            };
          }
          return value;
        },
      });

      const coverageErrors = collectStoryboardCoverageErrors(storyboard, params.assets);
      const displayErrors = collectStoryboardDisplayErrors(storyboard);
      const refErrors = collectStoryboardRefErrors(storyboard, params.assets);
      const allValidationErrors = [...coverageErrors, ...displayErrors, ...refErrors];

      if (allValidationErrors.length > 0) {
        throw new LLMError({
          code: 'TUTORIAL_STORYBOARD_INVALID',
          message: 'Storyboard references failed validation',
          stage: 'tutorial-gen',
          task: 'storyboard',
          retryable: false,
          cause: {
            issues: allValidationErrors.map((message) => ({ path: 'clips', message })),
            snippet: '',
          },
        });
      }

      return { storyboard, model: response.model, attempts: attempt };
    } catch (error) {
      lastError = error;
      const issues =
        error instanceof LLMError && Array.isArray((error.cause as any)?.issues)
          ? ((error.cause as any).issues as Array<{ path: string; message: string }>).map(
              (issue) => `${issue.path}: ${issue.message}`
            )
          : [error instanceof Error ? error.message : String(error)];

      console.warn(`[storyboard] Attempt ${attempt} validation failed:`, issues);

      messages.push({ role: 'assistant', content: response.content });
      messages.push(repairJsonMessage(issues, attempt));
    }
  }

  throw new LLMError({
    code: 'TUTORIAL_STORYBOARD_INVALID',
    message: `LLM failed to produce a valid tutorial storyboard after ${maxAttempts} attempts`,
    stage: 'tutorial-gen',
    task: 'storyboard',
    retryable: false,
    cause: lastError,
  });
}
