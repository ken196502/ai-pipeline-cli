/**
 * Story Plan (剧本 + 分镜规划) — the FIRST LLM pass of the script stage.
 *
 * Problem it solves (run flowTutor-1793720826350-iv53k8): the extracted material was
 * only 3 character/background sheets + 1 negative prompt + 1 single-shot prompt. The
 * prompt-writing LLM was asked to invent 6 clips out of that, so it produced six
 * disconnected "scenes" whose cause/effect ran backwards.
 *
 * Fix: spend one extra LLM call writing an actual short-film screenplay from the VL
 * extracted prompts AND the reference video's subtitles/narration. The screenplay says
 * how many scenes there are, how each scene is performed (blocking, movement, action,
 * dialogue, what changes), and how each scene is covered by shots. The prompt pass then
 * only translates each planned shot into imagePrompt / endImagePrompt / visualPrompt.
 *
 * Camera language: inside one scene, cutting between wide / medium / close-ups on
 * different subjects is normal, and a clip's start and end frames may differ a lot.
 * What must stay fixed within a scene is the scene itself (set layout, wardrobe, props,
 * lighting, where the characters are).
 *
 * Shot quality (coverage, causality, framing) is judged by the LLM through the prompt —
 * there is deliberately NO keyword lint here. `validateStoryPlan` only checks structure
 * the downstream code depends on (shot count/order, scene references, required fields).
 */
import { AppError, ErrorCodes } from '../errors.js';
import { getEnvConfig, type EnvConfig } from '../../env.js';
import { chatJsonObject } from '../llm/json-chat.js';
import { notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';
import type { Transcript, VlExtractedPrompt } from '../contracts.js';
import { StoryPlanSchema, type StoryPlan } from './contracts.js';
import { formatSourcePromptsForLlm } from './prompts.js';

export interface StoryPlanSegment {
  segmentId?: string;
  id?: string;
  title?: string;
  summary?: string;
  startSec: number;
  endSec: number;
  text?: string;
}

export interface StoryPlanParams {
  vlPrompts: VlExtractedPrompt[];
  topic: string;
  videoTitle: string;
  videoSummary?: string;
  targetClipCount: number;
  clipDuration: 4 | 6 | 8 | 10;
  aspectRatio: 'landscape' | 'portrait';
  visualStyle?: string;
  segments?: StoryPlanSegment[];
  transcript?: Transcript;
  llmConfig?: EnvConfig;
  /**
   * Per-shot transition already decided by `inferTransition` (index 0 is always 'cut').
   * A 'continuous' shot is rendered by extending the previous clip's video (no new start
   * frame), so it must stay in the previous shot's scene and pick up from its end frame.
   */
  clipTransitions?: Array<'cut' | 'continuous'>;
}

type ShotTransitionKind = 'cut' | 'continuous';

function transitionAt(transitions: ShotTransitionKind[] | undefined, idx: number): ShotTransitionKind {
  if (idx === 0) return 'cut';
  return transitions?.[idx] === 'continuous' ? 'continuous' : 'cut';
}

/** One line per shot telling the screenwriter which shots are cuts vs. continuations. */
export function formatShotTransitionPlan(targetClipCount: number, transitions?: ShotTransitionKind[]): string {
  const lines: string[] = [];
  for (let i = 0; i < targetClipCount; i++) {
    lines.push(
      transitionAt(transitions, i) === 'cut'
        ? `- Shot ${i + 1}: CUT${i === 0 ? ' (opening shot)' : ' (new framing; same scene or a planned scene change)'}`
        : `- Shot ${i + 1}: CONTINUOUS — the video of shot ${i} keeps running: SAME scene, it starts exactly on shot ${i}'s end frame and continues its action`
    );
  }
  return lines.join('\n');
}

/**
 * Reference subtitles / narration (示例视频字幕/解说词) that the screenplay adapts.
 * Prefers per-segment text, falls back to the raw transcript cues.
 */
export function formatReferenceNarration(params: {
  segments?: StoryPlanSegment[];
  transcript?: Transcript;
}): string {
  const segments = params.segments || [];
  const segLines = segments
    .map((seg, idx) => {
      const text = (seg.text || seg.summary || '').trim();
      if (!text) return '';
      return `[Segment ${idx + 1}] ${seg.title ? `${seg.title} — ` : ''}${text}`;
    })
    .filter(Boolean);

  if (segLines.length > 0) return segLines.join('\n');

  const cues = params.transcript?.cues || [];
  if (cues.length === 0) return 'No reference narration was transcribed for this video.';
  return cues
    .map(([start, end, text], idx) => `[Cue ${idx + 1} @${Math.round(start)}-${Math.round(end)}s] ${String(text).trim()}`)
    .join('\n');
}

export function buildStoryPlanSystemPrompt(options: {
  targetClipCount: number;
  clipDuration: 4 | 6 | 8 | 10;
  aspectRatio: 'landscape' | 'portrait';
  visualStyle?: string;
}): string {
  const styleLine = options.visualStyle
    ? `\nIdentified art style to respect (do not re-invent it): "${options.visualStyle}".\n`
    : '';

  return `You are a short-film screenwriter AND director. Write the screenplay and shot list for a ${options.targetClipCount}-shot film (${options.clipDuration}s per shot, ${options.aspectRatio} frame).
${styleLine}
You are NOT writing image/video prompts. A prompt writer will later translate your plan shot-by-shot, so everything that should appear on screen must be decided here.

INPUT
1. AI generation prompts extracted (by a vision model) from a reference video: character sheets, background/set sheets, negative prompts, maybe a single-shot prompt. They define WHAT THE WORLD LOOKS LIKE.
2. The reference video's subtitles / narration. They are the story spine. If they contain tutorial or meta talk ("the video opens by…", "this prompt", "eight AI models"), drop that layer and keep only the in-world events.

WHAT THE SCREENPLAY MUST SPELL OUT

A. STORY
   - A miniature film with setup → escalation → payoff. Every shot is caused by what happened before it and leads to what comes next.
   - Use ONLY the characters, props and environments from the extracted prompts. No new hero, no new genre, no tutorial framing (no desks, laptops, UI, "prompt", "generate", creators).

B. SCENES — decide how many and plan each one fully
   - Decide the number of scenes the story needs (for a film this short, usually 1–3). Each scene is one continuous place and time, and is normally covered by several shots; do not spend one shot per location like a slideshow.
   - For EVERY scene write:
     * location + setting: which background, and the spatial layout (fixed landmarks and where they are in the set);
     * time of day and lighting;
     * cast and props (with the props' starting state);
     * blocking: where every character stands and faces at the start, relative to the landmarks;
     * performance (演绎): how the scene plays out beat by beat — who moves where, what they do, how others react;
     * changes: what is different by the end of the scene (positions, prop states, emotions, light).

C. SHOTS — how each scene is filmed
   - Inside a scene, cutting between wide, medium and close-up shots on different subjects (one character, another character's reaction, a key prop, the whole group) is normal coverage. Choose framing for storytelling, not variety for its own sake.
   - The start frame and end frame of one shot may differ a lot (e.g. a close-up on character1 at the start and a medium shot of both characters at the end). That is allowed. Describe both frames explicitly.
   - What must NOT drift between shots of the same scene: set layout, wardrobe, props and their current state, lighting, and each character's position. Characters only move when the blocking says they move, and they keep their screen side unless the blocking moves them.
   - For EVERY shot write: the beat, the camera (shot size, angle, height, lens, position, move), the focus subject, the start frame and end frame composition, blocking at the start, how blocking changes during the shot, the action from start to end, the acting (expression, gesture, emotional shift), the spoken lines, and continuity notes.
   - CONTINUOUS shots (marked in the transition list) are not new shots of the camera: the previous shot's video keeps running, so they stay in the same scene and start exactly where the previous shot's end frame left off.

D. DIALOGUE / NARRATION
   - Adapt the reference subtitles into spoken lines. Per shot, list them in "dialogue" with the speaker (a character key, or "narrator" for off-screen voiceover) and delivery. Keep them short enough to speak within ${options.clipDuration}s.
   - "narrationLine" is the plain spoken text of that shot's lines in order (no speaker labels), or "" if nobody speaks.
   - If the reference is non-verbal, set "hasNarration": false and leave all dialogue empty.
   - Lines tell the story on screen; they never mention prompts, tools, models, or "this video".

E. MASTER DEFINITIONS
   - "characters" and "backgrounds" start with ABSOLUTE SIZE (e.g. "0.45 m tall at the shoulder, ...", "12 m wide by 20 m deep clearing, 6 m tall acacia tree at frame left"), then the exact, unvarying appearance from the extracted sheets. Refer to them by key (character1, background1) everywhere else.

F. LANGUAGE
   - Every value in the output JSON is in English.

OUTPUT — ONE valid JSON object, no markdown:
{
  "logline": "One sentence: who wants what, what stands in the way.",
  "synopsis": "3-5 sentences of the story these shots tell.",
  "hasNarration": true,
  "characters": { "character1": "ABSOLUTE SIZE first, then unvarying appearance/clothing" },
  "backgrounds": { "background1": "ABSOLUTE DIMENSIONS first, then fixed landmarks and their positions" },
  "scenes": [
    {
      "sceneId": "scene-001",
      "location": "background1 — which area of it",
      "setting": "spatial layout: landmarks and where they are",
      "timeOfDay": "...",
      "lighting": "...",
      "cast": ["character1"],
      "props": "props in the scene and their starting state",
      "summary": "what this scene must accomplish in the story",
      "blocking": "where each character stands/faces at the start, relative to landmarks",
      "performance": "beat-by-beat how the scene plays out: movement, action, reactions",
      "changes": "what is different at the end of the scene"
    }
  ],
  "shots": [
    {
      "shotIndex": 1,
      "sceneId": "scene-001",
      "beat": "story function of this shot and what the previous shot caused",
      "shotSize": "wide / medium / close-up / ... (at the start of the shot)",
      "cameraAngle": "eye-level / low / high / over-the-shoulder / ...",
      "cameraHeight": "e.g. 0.3 m above ground",
      "lens": "e.g. 24 mm / 50 mm / 85 mm",
      "cameraPosition": "where the camera is in the set",
      "cameraMove": "how the camera moves during the shot (or 'static')",
      "focusSubject": "who/what the shot is about",
      "startFrame": "composition at t=0: shot size, who is where on screen",
      "endFrame": "composition at t=${options.clipDuration}s: shot size, who is where on screen (may differ a lot from startFrame)",
      "screenDirection": "who is frame-left / frame-right, facing which way",
      "blocking": "where each character/prop is at the start of the shot",
      "blockingChange": "how positions change during the shot",
      "actionStart": "exact pose/state at t=0",
      "actionEnd": "exact pose/state at t=${options.clipDuration}s",
      "performance": "expression, gesture, emotional shift",
      "dialogue": [ { "speaker": "character1 | narrator", "line": "spoken line", "delivery": "e.g. whispered" } ],
      "narrationLine": "the shot's spoken text without speaker labels, or empty string",
      "continuity": "what carries over from the previous shot (wardrobe, props, positions, light) and what changed"
    }
  ]
}

Output exactly ${options.targetClipCount} shots, shotIndex 1..${options.targetClipCount}, in story order. Return ONLY the JSON object.`;
}

export function buildStoryPlanUserPrompt(params: StoryPlanParams): string {
  const narration = formatReferenceNarration(params);
  return `Topic: "${params.topic}"
Reference video: "${params.videoTitle}"
${params.videoSummary ? `Reference description: ${params.videoSummary}\n` : ''}${params.visualStyle ? `Identified visual style: "${params.visualStyle}"\n` : ''}Target shots: ${params.targetClipCount} × ${params.clipDuration}s (${params.aspectRatio})

=== EXTRACTED SOURCE PROMPTS (world/character/set sheets from the reference) ===
${formatSourcePromptsForLlm(params.vlPrompts)}

=== REFERENCE SUBTITLES / NARRATION (story spine to adapt) ===
${narration}

=== SHOT TRANSITIONS (already decided — follow them) ===
${formatShotTransitionPlan(params.targetClipCount, params.clipTransitions)}

=== ASSIGNMENT ===
Write the screenplay + shot list for exactly ${params.targetClipCount} shots:
- decide how many scenes there are, and for each scene its setting, blocking, beat-by-beat performance, and what changes by its end;
- for each shot: camera, focus subject, start and end frame, blocking and how it changes, action, acting, and spoken lines with speakers;
- keep set layout, wardrobe, props, lighting and character positions consistent between shots of the same scene.

Return ONLY the JSON object described in the system instructions.`;
}

const REQUIRED_SCENE_FIELDS: Array<keyof StoryPlan['scenes'][number]> = [
  'sceneId',
  'location',
  'blocking',
  'performance',
];

const REQUIRED_SHOT_FIELDS: Array<keyof StoryPlan['shots'][number]> = [
  'sceneId',
  'beat',
  'shotSize',
  'focusSubject',
  'startFrame',
  'endFrame',
  'blocking',
  'actionStart',
  'actionEnd',
];

/**
 * Structural validation only — the things downstream code relies on (clip N = shot N,
 * every shot points at a defined scene, the fields the prompt writer translates exist).
 * Shot QUALITY is left to the LLM; keyword-based camera linting misfired on normal
 * phrasing and was removed on purpose.
 */
export function validateStoryPlan(
  plan: StoryPlan,
  expectedClipCount: number,
  clipTransitions?: Array<'cut' | 'continuous'>
): string[] {
  const violations: string[] = [];
  const shots = plan.shots || [];
  const scenes = plan.scenes || [];

  if (shots.length !== expectedClipCount) {
    violations.push(`shot count is ${shots.length}, expected exactly ${expectedClipCount}`);
  }

  const sceneIds = new Set(scenes.map((s) => s.sceneId).filter(Boolean));
  if (sceneIds.size === 0) violations.push('no scenes defined (each shot must reference a sceneId)');

  scenes.forEach((scene, idx) => {
    const label = `scene ${scene.sceneId || idx + 1}`;
    for (const field of REQUIRED_SCENE_FIELDS) {
      if (!String(scene[field] ?? '').trim()) {
        violations.push(`${label}: missing required field "${String(field)}"`);
      }
    }
  });

  const hasMasters =
    Object.keys(plan.characters || {}).length > 0 || Object.keys(plan.backgrounds || {}).length > 0;
  if (!hasMasters) {
    violations.push('characters/backgrounds master definitions are empty — appearance and set scale cannot stay consistent');
  }

  const coveredScenes = new Set<string>();
  shots.forEach((shot, idx) => {
    const label = `shot ${shot.shotIndex || idx + 1}`;
    if (shot.shotIndex !== idx + 1) {
      violations.push(`${label}: shotIndex is ${shot.shotIndex}, expected ${idx + 1} (shots must be 1..N in story order)`);
    }
    for (const field of REQUIRED_SHOT_FIELDS) {
      if (!String(shot[field] ?? '').trim()) {
        violations.push(`${label}: missing required field "${String(field)}"`);
      }
    }
    if (shot.sceneId && sceneIds.size > 0 && !sceneIds.has(shot.sceneId)) {
      violations.push(`${label}: sceneId "${shot.sceneId}" is not defined in scenes[]`);
    }
    if (shot.sceneId) coveredScenes.add(shot.sceneId);

    // A continuation extends the previous clip's video: it physically cannot be in
    // another scene.
    const prev = shots[idx - 1];
    if (prev && transitionAt(clipTransitions, idx) === 'continuous' && prev.sceneId && shot.sceneId && prev.sceneId !== shot.sceneId) {
      violations.push(
        `${label} is CONTINUOUS (extends shot ${prev.shotIndex}'s video) but changes scene ${prev.sceneId} → ${shot.sceneId}`
      );
    }
  });

  for (const sceneId of sceneIds) {
    if (!coveredScenes.has(sceneId)) {
      violations.push(`scene "${sceneId}" is defined but no shot covers it`);
    }
  }

  return violations;
}

/**
 * `narrationLine` is what the TTS reads. Derive it from the shot's dialogue when the
 * model only filled the speaker-tagged list, and clear speech entirely for non-verbal
 * plans.
 */
export function normalizeSpokenLines(plan: StoryPlan): StoryPlan {
  for (const shot of plan.shots || []) {
    if (!plan.hasNarration) {
      shot.dialogue = [];
      shot.narrationLine = '';
      continue;
    }
    if (!shot.narrationLine.trim() && shot.dialogue.length > 0) {
      shot.narrationLine = shot.dialogue
        .map((d) => d.line.trim())
        .filter(Boolean)
        .join(' ');
    }
  }
  return plan;
}

/**
 * Runs the screenwriting pass. One repair round-trip when the plan is structurally
 * broken; a second failure is a hard error (no silent degradation).
 */
export async function buildStoryPlan(params: StoryPlanParams): Promise<StoryPlan> {
  const env = params.llmConfig || getEnvConfig();
  if (!env.baseUrl || !env.apiKey) {
    throw new AppError({
      code: ErrorCodes.LLM_REQUEST_FAILED,
      message:
        'LLM base URL or API key is not configured in environment (.env). The story-plan pass is mandatory (it is what keeps clips causally connected), and fallback is forbidden.',
      stage: 'research',
      task: 'story-plan',
      retryable: false,
    });
  }

  const systemPrompt = buildStoryPlanSystemPrompt({
    targetClipCount: params.targetClipCount,
    clipDuration: params.clipDuration,
    aspectRatio: params.aspectRatio,
    visualStyle: params.visualStyle,
  });
  const userPrompt = buildStoryPlanUserPrompt(params);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const requestPlan = async (label: string): Promise<StoryPlan> => {
    try {
      const { value } = await chatJsonObject(
        {
          messages,
          model: env.llmModel,
          context: { stage: 'script', task: 'story-plan' },
          temperature: 0.4,
          timeoutMs: 300_000,
          task: label,
          // Schema-shaped output: thinking off keeps the reply fast and stops the model
          // from re-planning the story inside its reasoning stream.
          thinking: false,
        },
        env
      );
      return normalizeSpokenLines(StoryPlanSchema.parse(value));
    } catch (chatErr: any) {
      const appErr =
        chatErr instanceof AppError
          ? chatErr
          : new AppError({
              code: ErrorCodes.LLM_REQUEST_FAILED,
              message: `LLM ${label} failed: ${chatErr?.message || String(chatErr)}. Fallback is forbidden — a missing screenplay is not something to paper over.`,
              stage: 'research',
              task: 'story-plan',
              retryable: false,
              cause: chatErr,
            });
      await notifyLlmUnavailableAndExit(appErr, {
        stage: 'research',
        task: 'story-plan',
        context: 'Story Plan (剧本/分镜规划)',
      });
      throw appErr;
    }
  };

  let plan = await requestPlan('story plan');
  let violations = validateStoryPlan(plan, params.targetClipCount, params.clipTransitions);

  if (violations.length > 0) {
    console.warn(`[script] Story plan is structurally incomplete (${violations.length} issue(s)) — requesting one repair round:\n- ${violations.join('\n- ')}`);
    messages.push({ role: 'assistant', content: JSON.stringify(plan) });
    messages.push({
      role: 'user',
      content: `Your plan is incomplete:
- ${violations.join('\n- ')}

Keep the SAME story and return the corrected complete JSON object only (same shape, exactly ${params.targetClipCount} shots, shotIndex 1..${params.targetClipCount}, every shot's sceneId defined in scenes[]).`,
    });
    plan = await requestPlan('story plan repair');
    violations = validateStoryPlan(plan, params.targetClipCount, params.clipTransitions);
    if (violations.length > 0) {
      throw new AppError({
        code: ErrorCodes.LLM_RESPONSE_INVALID,
        message: `Story plan is still incomplete after one repair round:\n- ${violations.join('\n- ')}`,
        stage: 'research',
        task: 'story-plan',
        retryable: false,
      });
    }
  }

  return plan;
}

/** Per-scene + per-shot block injected into the prompt-writing pass. */
export function formatStoryPlanForPromptWriter(
  plan: StoryPlan,
  clipTransitions?: Array<'cut' | 'continuous'>
): string {
  const masterLines = (record: Record<string, string> | undefined): string => {
    const entries = Object.entries(record || {});
    if (entries.length === 0) return '  (none)';
    return entries.map(([key, value]) => `  ${key}: ${value}`).join('\n');
  };

  const scenes = (plan.scenes || [])
    .map((s) =>
      [
        `Scene ${s.sceneId}: ${s.summary}`,
        `  location: ${s.location}`,
        `  setting: ${s.setting}`,
        `  time/light: ${s.timeOfDay} | ${s.lighting}`,
        `  cast: ${s.cast.join(', ')}`,
        `  props: ${s.props}`,
        `  blocking at start: ${s.blocking}`,
        `  performance: ${s.performance}`,
        `  changes by end: ${s.changes}`,
      ].join('\n')
    )
    .join('\n\n');

  const shots = (plan.shots || [])
    .map((s, idx) => {
      const dialogue = s.dialogue.length
        ? s.dialogue.map((d) => `${d.speaker}${d.delivery ? ` (${d.delivery})` : ''}: "${d.line}"`).join(' / ')
        : '(none)';
      return [
        `Shot ${s.shotIndex} (scene ${s.sceneId}) — ${transitionAt(clipTransitions, idx) === 'cut' ? 'CUT' : 'CONTINUOUS (previous clip keeps running)'}`,
        `  beat: ${s.beat}`,
        `  camera: ${s.shotSize}, ${s.cameraAngle}, height ${s.cameraHeight}, lens ${s.lens}, position ${s.cameraPosition}; move: ${s.cameraMove}`,
        `  focus: ${s.focusSubject}`,
        `  start frame: ${s.startFrame}`,
        `  end frame: ${s.endFrame}`,
        `  screen direction: ${s.screenDirection}`,
        `  blocking: ${s.blocking}`,
        `  blocking change: ${s.blockingChange}`,
        `  action: ${s.actionStart} -> ${s.actionEnd}`,
        `  performance: ${s.performance}`,
        `  dialogue: ${dialogue}`,
        `  narration (TTS): ${s.narrationLine || '(none)'}`,
        `  continuity: ${s.continuity}`,
      ].join('\n');
    })
    .join('\n\n');

  return `=== AUTHORITATIVE STORY PLAN (do not re-plan, do not reorder) ===
Logline: ${plan.logline}
Synopsis: ${plan.synopsis}
Has narration: ${plan.hasNarration ? 'yes' : 'no'}

Master characters (reuse these EXACT placeholder keys, do not redefine size or appearance):
${masterLines(plan.characters)}

Master backgrounds (reuse these EXACT placeholder keys, do not redefine dimensions):
${masterLines(plan.backgrounds)}

Scenes:
${scenes || '(none)'}

Shots:
${shots || '(none)'}`;
}
