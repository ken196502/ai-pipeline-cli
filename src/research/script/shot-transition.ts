/**
 * Shot transition annotation (切分镜 / 连续) shared by the script generator and the
 * Flow generation planner (src/flow/clip-plan.ts).
 *
 * Deliberately free of LLM / network imports so every consumer can reuse the exact
 * same label normalization, inference rule and 备注 wording.
 */
import type { ShotTransition } from './contracts.js';

/**
 * Normalizes an LLM-provided shot transition label (切分镜 / 连续) to the schema enum.
 * Returns null when the value is absent or unrecognized — the caller must then infer
 * the transition explicitly (never silently invent one).
 */
export function normalizeTransition(raw: unknown): ShotTransition | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (/^(cut|shot[- ]?cut|new[- ]?shot|hard[- ]?cut|切分镜|切镜|分镜|切换镜头|新镜头|新分镜)$/.test(v)) return 'cut';
  if (/^(continuous|continue|continued|same[- ]?shot|one[- ]?shot|连贯|连续|延续|同一镜|同一镜头|长镜头)$/.test(v)) return 'continuous';
  return null;
}

/** Narration / text prefixes that keep the same shot rolling instead of cutting away. */
const CONTINUATION_STARTERS =
  /^(then|and|as|while|when|meanwhile|meantime|next|after|before|until|suddenly|接着|随后|然后|紧接着|与此同时|此时|之后|于是|就在此时)/i;

/**
 * Deterministic shot-transition inference (used by the non-LLM path and when the LLM
 * omits the annotation):
 *   - clip 0            → 'cut' (establishing shot, no previous shot exists)
 *   - previous narration has NO sentence-ending punctuation → 'continuous'
 *   - current text starts with a continuation word          → 'continuous'
 *   - otherwise                                             → 'cut'
 */
export function inferTransition(params: {
  index: number;
  previousNarration?: string;
  narration?: string;
  title?: string;
}): ShotTransition {
  if (!params.index || params.index <= 0) return 'cut';
  const prev = (params.previousNarration || '').trim();
  const curr = `${params.narration || ''} ${params.title || ''}`.trim();
  if (prev && !/[.!?。！？…]["')\]]?$/.test(prev)) return 'continuous';
  if (curr && CONTINUATION_STARTERS.test(curr)) return 'continuous';
  return 'cut';
}

/**
 * Coarse art-medium families used by the continuous-chain lint. A continuous clip
 * starts from the previous clip's PIXELS (its video's real last frame), so asking
 * for a different medium mid-chain forces the model to morph style mid-shot.
 */
const ART_MEDIUM_GROUPS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'illustration/2D',
    pattern:
      /\b(storybook|illustration|illustrated|watercolor|watercolour|gouache|line[- ]?art|sketch|cel[- ]?shaded|anime|manga|cartoon|2d animation|flat vector|paper[- ]?cut|woodcut|ink drawing)\b/i,
  },
  {
    label: 'photorealistic/live-action',
    pattern:
      /\b(photo[- ]?realistic|photorealistic|hyper[- ]?realistic|photograph|photographic|live[- ]?action|35mm|50mm|85mm|macro photograph|cinematic footage|film still)\b/i,
  },
  {
    label: '3D render',
    pattern: /\b(3d render|3d animation|3d cartoon|blender|pixar|unreal engine|octane render|cgi|low[- ]?poly)\b/i,
  },
  {
    label: 'claymation/stop-motion',
    pattern: /\b(claymation|plasticine|clay animation|stop[- ]?motion)\b/i,
  },
];

function artMediumsOf(text: string): Set<string> {
  const mediums = new Set<string>();
  for (const group of ART_MEDIUM_GROUPS) {
    if (group.pattern.test(text)) mediums.add(group.label);
  }
  return mediums;
}

export interface ContinuousChainLintClip {
  clipIndex: number;
  title?: string;
  transition?: string | null;
  transitionNote?: string;
  imagePrompt?: string;
  visualPrompt?: string;
  styleAesthetic?: string;
}

/**
 * Deprecated post-check for continuous chains.
 * Transitions are planned programmatically by the pipeline, and LLM does not manage transitions.
 * Kept as no-op returning empty array for backward compatibility.
 */
export function lintContinuousChainPrompts(_clips: ContinuousChainLintClip[]): string[] {
  return [];
}

/**
 * Strips any transition meta-instructions that LLM might mistakenly prefix to visualPrompt.
 * Video generation engines (Veo / Flow) require pure camera dynamics and subject motion.
 * Cut / continuous transitions are handled physically by generating new images or reusing
 * the last video frame, NEVER by meta-instructions in the prompt.
 */
export function sanitizeVisualPromptForVideoEngine(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return '';
  let cleaned = prompt.trim();

  // Strip leading Chinese transition prefix, e.g. "切分镜：...", "连续：上一镜结尾帧..."
  cleaned = cleaned.replace(/^(?:切分镜|切镜|分镜|连续|延续|同一镜头|转场)[：:—\-\s]+(?:上一镜结尾帧[＝=]本镜起始帧[：:—\-\s]*)?/i, '');

  // Strip leading English transition prefix, e.g. "Continuous: starting from...", "Cut: ..."
  cleaned = cleaned.replace(/^(?:cut|continuous|transition)[：:—\-\s]+/i, '');

  // Strip leading "starting from that exact end frame..." or "starting from previous clip..."
  cleaned = cleaned.replace(/^(?:starting|resuming|continuing)\s+from\s+(?:that\s+)?(?:exact\s+)?(?:the\s+)?(?:last|end|previous)\s+frame\s*(?:[—\-:,\.]|\s+where|\s+as)\s*/i, '');
  cleaned = cleaned.replace(/^上一镜结尾帧[＝=]本镜起始帧[：:—\-\s]*/i, '');

  return cleaned.trim();
}

/**
 * Builds the mandatory 备注 for a shot transition: which transition it is, why, what
 * must stay consistent with the previous clip and what changes.
 */
export function buildTransitionNote(
  transition: ShotTransition,
  opts: { inferred?: boolean; title?: string; previousTitle?: string; isFirst?: boolean } = {}
): string {
  const suffix = opts.inferred ? ' (自动推断 / auto-inferred)' : '';
  if (transition === 'continuous') {
    return (
      `Continuous (连续): Seamless continuation from previous shot${opts.previousTitle ? ` (${opts.previousTitle})` : ''}; ` +
      `previous end frame equals current start frame; camera, subject pose, lighting, and style remain consistent (保持一致); ` +
      `action and camera motion continue without re-generating an image.${suffix}`
    );
  }
  return (
    `Cut (切分镜): ${opts.isFirst ? 'Opening establishing shot (开场建立镜头)' : `Transitions from previous shot${opts.previousTitle ? ` (${opts.previousTitle})` : ''} to a new scene`}` +
    `${opts.title ? ` (${opts.title})` : ''}; framing, angle, and composition change while characters, palette, and style remain consistent.${suffix}`
  );
}
