import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoryPlanSystemPrompt,
  buildStoryPlanUserPrompt,
  formatReferenceNarration,
  formatStoryPlanForPromptWriter,
  normalizeSpokenLines,
  validateStoryPlan,
  type StoryPlanParams,
} from '../src/research/script/story-plan.js';
import { buildReorchestrationSystemPrompt, buildReorchestrationUserPrompt } from '../src/research/script/prompts.js';
import { StoryPlanSchema, type StoryPlan } from '../src/research/script/contracts.js';

const baseShot = {
  sceneId: 'scene-001',
  beat: 'establish',
  shotSize: 'wide',
  cameraAngle: 'eye-level',
  cameraPosition: '8 m back on the path',
  cameraMove: 'slow dolly-in 1.5 m',
  focusSubject: 'character1',
  startFrame: 'wide: character1 frame-left beside the acacia trunk',
  endFrame: 'close-up on character1 holding the banana',
  screenDirection: 'character1 frame-left facing right',
  blocking: 'character1 beside background1 acacia trunk',
  actionStart: 'character1 crouched',
  actionEnd: 'character1 standing',
};

const baseScene = {
  sceneId: 'scene-001',
  location: 'background1 — clearing under the acacia',
  setting: 'acacia trunk at frame left, rock at center',
  timeOfDay: 'sunset',
  lighting: 'warm',
  cast: ['character1'],
  summary: 'sharing',
  blocking: 'character1 at the trunk, tortoise by the rock',
  performance: 'monkey finds the banana, offers it, tortoise grins',
  changes: 'banana moves from the monkey to the tortoise',
};

function makePlan(overrides: Partial<StoryPlan> = {}): StoryPlan {
  return StoryPlanSchema.parse({
    logline: 'A baby monkey tries to share a banana with a tortoise.',
    synopsis: 'Setup, complication, payoff.',
    hasNarration: true,
    characters: { character1: '0.45 m tall cartoon monkey' },
    backgrounds: { background1: '12 m wide savanna clearing' },
    scenes: [baseScene],
    shots: [
      { shotIndex: 1, ...baseShot, narrationLine: 'The monkey finds a banana.' },
      {
        shotIndex: 2,
        ...baseShot,
        shotSize: 'close-up',
        cameraAngle: 'low',
        focusSubject: 'the tortoise',
        dialogue: [{ speaker: 'narrator', line: 'The tortoise grins.' }],
      },
    ],
    ...overrides,
  });
}

test('validateStoryPlan accepts a structurally complete plan', () => {
  assert.deepEqual(validateStoryPlan(makePlan(), 2), []);
});

test('validateStoryPlan does not lint camera wording (no keyword checks)', () => {
  const plan = makePlan();
  plan.shots[0].cameraMove = 'start on a close-up, then pull back to a wide shot of the clearing';
  plan.shots[1] = { ...plan.shots[1], shotSize: 'wide', cameraAngle: 'eye-level', cameraPosition: baseShot.cameraPosition };
  assert.deepEqual(validateStoryPlan(plan, 2), []);
});

test('validateStoryPlan allows several scenes', () => {
  const plan = makePlan();
  plan.scenes = [...plan.scenes, { ...baseScene, sceneId: 'scene-002' }, { ...baseScene, sceneId: 'scene-003' }];
  plan.shots = [
    { ...plan.shots[0], shotIndex: 1, sceneId: 'scene-001' },
    { ...plan.shots[1], shotIndex: 2, sceneId: 'scene-002' },
    { ...plan.shots[1], shotIndex: 3, sceneId: 'scene-003' },
  ];
  assert.deepEqual(validateStoryPlan(plan, 3), []);
});

test('validateStoryPlan rejects a shot count that does not match', () => {
  const violations = validateStoryPlan(makePlan(), 3);
  assert.ok(violations.some((v) => /shot count is 2, expected exactly 3/.test(v)), violations.join('\n'));
});

test('validateStoryPlan rejects missing scene performance and shot frames', () => {
  const plan = makePlan();
  plan.scenes[0].performance = '';
  plan.shots[1].endFrame = '';
  const violations = validateStoryPlan(plan, 2);
  assert.ok(violations.some((v) => /scene scene-001: missing required field "performance"/.test(v)), violations.join('\n'));
  assert.ok(violations.some((v) => /shot 2: missing required field "endFrame"/.test(v)), violations.join('\n'));
});

test('validateStoryPlan rejects an undefined scene reference and an uncovered scene', () => {
  const plan = makePlan();
  plan.shots[1].sceneId = 'scene-999';
  const violations = validateStoryPlan(plan, 2);
  assert.ok(violations.some((v) => /sceneId "scene-999" is not defined/.test(v)), violations.join('\n'));

  const uncovered = makePlan();
  uncovered.scenes = [...uncovered.scenes, { ...baseScene, sceneId: 'scene-002' }];
  const uncoveredViolations = validateStoryPlan(uncovered, 2);
  assert.ok(
    uncoveredViolations.some((v) => /scene "scene-002" is defined but no shot covers it/.test(v)),
    uncoveredViolations.join('\n')
  );
});

test('validateStoryPlan rejects a CONTINUOUS shot that changes scene', () => {
  const plan = makePlan();
  plan.scenes = [...plan.scenes, { ...baseScene, sceneId: 'scene-002' }];
  plan.shots[1].sceneId = 'scene-002';
  assert.deepEqual(validateStoryPlan(plan, 2, ['cut', 'cut']), []);
  const violations = validateStoryPlan(plan, 2, ['cut', 'continuous']);
  assert.ok(violations.some((v) => /is CONTINUOUS .* changes scene/.test(v)), violations.join('\n'));
});

test('formatReferenceNarration prefers segment text and falls back to transcript cues', () => {
  const fromSegments = formatReferenceNarration({
    segments: [
      { title: 'Setup', text: 'A monkey finds a banana.', startSec: 0, endSec: 4 },
      { title: 'Payoff', text: 'They share it.', startSec: 4, endSec: 8 },
    ],
    transcript: { videoId: 'v', language: 'en', source: 'manual', cues: [[0, 4, 'ignored']] },
  });
  assert.match(fromSegments, /\[Segment 1\] Setup — A monkey finds a banana\./);

  const fromCues = formatReferenceNarration({
    transcript: { videoId: 'v', language: 'en', source: 'manual', cues: [[0, 4, 'A monkey finds a banana.']] },
  });
  assert.match(fromCues, /\[Cue 1 @0-4s\] A monkey finds a banana\./);
});

test('story plan prompt asks for scenes, performance, blocking, changes, actions and dialogue', () => {
  const params: StoryPlanParams = {
    vlPrompts: [
      {
        prompt: 'CHARACTER: baby monkey turnaround sheet',
        promptType: 'image',
        orientation: 'portrait',
        uiContext: 'Gemini',
        uiDescription: { summary: '', sidebar: [], mainContent: '' },
        channel: { name: '', handle: '', platform: '' },
        narration: '',
        confidence: 0.95,
        settings: [],
      },
    ],
    topic: 'baby monkey and tortoise',
    videoTitle: 'Banana story',
    targetClipCount: 6,
    clipDuration: 4,
    aspectRatio: 'landscape',
    visualStyle: 'stylized 3D animation',
    segments: [{ title: 'Setup', text: 'A baby monkey finds a banana.', startSec: 0, endSec: 4 }],
    clipTransitions: ['cut', 'cut', 'continuous', 'cut', 'cut', 'cut'],
  };

  const system = buildStoryPlanSystemPrompt({ targetClipCount: 6, clipDuration: 4, aspectRatio: 'landscape' });
  assert.match(system, /Decide the number of scenes/);
  for (const field of ['"setting"', '"blocking"', '"performance"', '"changes"', '"blockingChange"', '"dialogue"', '"startFrame"', '"endFrame"']) {
    assert.ok(system.includes(field), `system prompt is missing ${field}`);
  }
  // Framing may change freely within a scene; start/end frames may differ a lot.
  assert.match(system, /start frame and end frame of one shot may differ a lot/);
  assert.match(system, /Every value in the output JSON is in English/);
  assert.doesNotMatch(system, /SAME LANGUAGE as the reference/);
  assert.doesNotMatch(system, /ONE CAMERA SETUP PER SHOT/);

  const user = buildStoryPlanUserPrompt(params);
  assert.match(user, /REFERENCE SUBTITLES \/ NARRATION/);
  assert.match(user, /A baby monkey finds a banana\./);
  assert.match(user, /exactly 6 shots/);
  assert.match(user, /Shot 3: CONTINUOUS/);
});

test('prompt-writing pass translates the plan and allows free framing within a scene', () => {
  const plan = makePlan();
  const system = buildReorchestrationSystemPrompt({ targetClipCount: 2, clipDuration: 4 });
  assert.match(system, /SCENE CONTINUITY & SHOT COVERAGE/);
  assert.match(system, /may differ a lot in shot size, angle and focus subject/);
  assert.doesNotMatch(system, /ONE CAMERA SETUP PER CLIP/);

  const block = formatStoryPlanForPromptWriter(plan, ['cut', 'cut']);
  assert.match(block, /performance: monkey finds the banana/);
  assert.match(block, /end frame: close-up on character1 holding the banana/);
  assert.match(block, /dialogue: narrator: "The tortoise grins\."/);

  const user = buildReorchestrationUserPrompt({
    vlPrompts: [
      {
        prompt: 'CHARACTER: baby monkey turnaround sheet',
        promptType: 'image',
        orientation: 'portrait',
        uiContext: 'Gemini',
        uiDescription: { summary: '', sidebar: [], mainContent: '' },
        channel: { name: '', handle: '', platform: '' },
        narration: '',
        confidence: 0.95,
        settings: [],
      },
    ],
    topic: 'baby monkey and tortoise',
    videoTitle: 'Banana story',
    targetClipCount: 2,
    clipDuration: 4,
    aspectRatio: 'landscape',
    clipTransitions: ['cut', 'cut'],
    storyPlanBlock: block,
  });

  assert.match(user, /AUTHORITATIVE STORY PLAN/);
  assert.match(user, /AUTHORITATIVE SHOT PLAN IS PROVIDED ABOVE/);
  assert.match(user, /SAME SCENE, DIFFERENT SHOTS/);
  assert.match(user, /character1: 0\.45 m tall cartoon monkey/);
  assert.match(user, /ECHO THE PLAN/);
  assert.doesNotMatch(user, /NOT a jump to another camera position/);
});

test('normalizeSpokenLines fills narrationLine from dialogue and clears speech for non-verbal plans', () => {
  const plan = normalizeSpokenLines(makePlan());
  assert.equal(plan.shots[0].narrationLine, 'The monkey finds a banana.');
  assert.equal(plan.shots[1].narrationLine, 'The tortoise grins.');

  const silent = normalizeSpokenLines(makePlan({ hasNarration: false } as Partial<StoryPlan>));
  assert.ok(silent.shots.every((s) => s.narrationLine === '' && s.dialogue.length === 0));
});
